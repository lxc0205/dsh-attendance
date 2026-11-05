import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { AttendanceFileStore } from './file-store.js';

export const inject = ['webServer', 'connection'];
const BODY_LIMIT = 8 * 1024 * 1024;
const BASE = '/dsh-attendance';

export function attendanceFilePath(env = process.env, home = homedir()) {
  const root = env.DSH_HOME?.trim() || join(home, '.dsh');
  const profile = env.DSH_PROFILE?.trim() || (env.DSH_PROFILE_DIR ? basename(env.DSH_PROFILE_DIR) : 'default');
  const safeProfile = profile.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'default';
  return resolve(root, 'data', 'dsh-attendance', `profile-${safeProfile}`, 'attendance.json');
}

function fail(status, message) {
  const error = new Error(message); error.httpStatus = status; return error;
}
function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  if (String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'JSON content type required');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) throw fail(413, 'Request body too large');
    chunks.push(buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail(400, 'Invalid JSON request'); }
}

export async function openLogDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise((resolveLaunch, reject) => {
    const child = spawn(command, [directoryPath], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(); });
  });
}

// All routes use the same connection guard as the shipped native-open routes.
// Paths are fixed by the Host; the browser cannot choose arbitrary files.
export function createAttendanceRoutes({ store, filePath, rejection, openDirectory = openLogDirectory }) {
  const directoryPath = dirname(filePath);
  const route = (path, method, operation) => ({
    kind: 'exact', path: BASE + path,
    handler: async (req, res) => {
      const rejected = rejection(req);
      if (rejected !== undefined) { res.statusCode = rejected; res.end(); return; }
      if (req.method !== method) { res.setHeader('allow', method); send(res, 405, { error: 'Method not allowed' }); return; }
      try {
        const body = method === 'POST' ? await readBody(req) : undefined;
        const result = await operation(body);
        send(res, 200, result);
      } catch (error) {
        send(res, error.httpStatus || (error instanceof TypeError ? 400 : 500), { error: error.message || 'Attendance file operation failed', filePath, directoryPath });
      }
    }
  });
  return [
    route('/state', 'GET', () => store.read()),
    route('/commit', 'POST', body => {
      if (!Array.isArray(body.changes) || !Array.isArray(body.expected) || body.changes.length > 20000 || body.expected.length > 20000 || Object.keys(body).some(key => !['changes', 'expected'].includes(key))) throw fail(400, 'Invalid change set');
      return store.commit(body);
    }),
    route('/migrate', 'POST', body => {
      if (!Array.isArray(body.entries) || body.entries.length > 20000 || Object.keys(body).some(key => key !== 'entries')) throw fail(400, 'Invalid migration entries');
      return store.migrate(body.entries);
    }),
    route('/open-folder', 'POST', async body => {
      if (Object.keys(body).length) throw fail(400, 'The log directory is fixed');
      await openDirectory(directoryPath);
      return { ok: true, filePath, directoryPath };
    })
  ];
}

export function apply(ctx) {
  const filePath = attendanceFilePath();
  const store = new AttendanceFileStore({ filePath });
  const routes = createAttendanceRoutes({ store, filePath, rejection: req => ctx.connection.requestRejection(req) });
  for (const route of routes) ctx.effect(() => ctx.webServer.register(route), `dsh-attendance: ${route.path}`);
}
