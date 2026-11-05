import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const DAY_PREFIX = 'dsh-attendance.v2.day.';
export const TARGET_PREFIX = 'dsh-attendance.v2.target.';
export const PRESET_KEY = 'dsh-attendance.presets.v1';
export const LEGACY_PRESET_KEY = 'dsh-attendance.periods.v1';
const queues = globalThis[Symbol.for('dsh.attendance.file-store.queues')] ??= new Map();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pretty = value => JSON.stringify(value, null, 2) + '\n';
const normalize = raw => { try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; } };
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function classify(key) {
  if (typeof key !== 'string') throw new TypeError('Attendance key must be a string');
  if (key === PRESET_KEY) return ['presets'];
  if (key === LEGACY_PRESET_KEY) return ['legacyPresets'];
  for (const [prefix, directory] of [[DAY_PREFIX, 'records'], [TARGET_PREFIX, 'weekly-targets']]) {
    if (key.startsWith(prefix) && validDate(key.slice(prefix.length))) return [directory, key.slice(prefix.length)];
  }
  throw new TypeError(`Unsupported attendance key: ${key}`);
}
function validateEntries(entries, nullable = false) {
  if (!Array.isArray(entries)) throw new TypeError('Entries must be an array');
  const seen = new Set();
  return entries.map(entry => {
    if (!object(entry)) throw new TypeError('Entry must be an object');
    classify(entry.key);
    if (seen.has(entry.key)) throw new TypeError(`Duplicate attendance key: ${entry.key}`);
    seen.add(entry.key);
    if (typeof entry.value !== 'string' && !(nullable && entry.value === null)) throw new TypeError('Entry value must be a string' + (nullable ? ' or null' : ''));
    return { key: entry.key, value: entry.value };
  });
}
function parseDocument(bytes, name) {
  try { return JSON.parse(bytes); } catch (cause) { throw new Error(`Damaged ${name} JSON; refusing to overwrite`, { cause }); }
}
function decodeSingletons(document, entries, onlySingletons) {
  if (document.presets !== null) entries.set(PRESET_KEY, JSON.stringify(document.presets));
  if (document.legacyPresets !== null) entries.set(LEGACY_PRESET_KEY, JSON.stringify(document.legacyPresets));
  for (const [key, raw] of Object.entries(document.unparsedEntries)) {
    try { classify(key); } catch (cause) { throw new Error('Invalid attendance schema key', { cause }); }
    if ((onlySingletons && key !== PRESET_KEY && key !== LEGACY_PRESET_KEY) || typeof raw !== 'string' || entries.has(key)) throw new Error('Invalid or duplicate unparsed attendance entry');
    // Preserve raw original strings, even if a manually edited one has become valid JSON.
    entries.set(key, normalize(raw));
  }
}
function decodeSettings(bytes) {
  const document = parseDocument(bytes, 'settings');
  const fields = ['format', 'version', 'presets', 'legacyPresets', 'unparsedEntries'];
  if (!object(document) || fields.some(key => !own(document, key)) || Object.keys(document).some(key => !fields.includes(key)) || document.format !== 'dsh-attendance-settings' || document.version !== 1 || !object(document.unparsedEntries)) throw new Error('Invalid settings schema or unsupported format/version');
  const entries = new Map();
  decodeSingletons(document, entries, true);
  return entries;
}
function encodeSettings(entries) {
  const document = { format: 'dsh-attendance-settings', version: 1, presets: null, legacyPresets: null, unparsedEntries: {} };
  for (const key of [PRESET_KEY, LEGACY_PRESET_KEY]) {
    if (!entries.has(key)) continue;
    const raw = entries.get(key);
    let value;
    try { value = JSON.parse(raw); } catch { document.unparsedEntries[key] = raw; continue; }
    if (value === null) document.unparsedEntries[key] = 'null';
    else document[key === PRESET_KEY ? 'presets' : 'legacyPresets'] = value;
  }
  return pretty(document);
}
function decodeLegacy(bytes) {
  const document = parseDocument(bytes, 'legacy attendance');
  const fields = ['format', 'version', 'updatedAt', 'records', 'presets', 'weeklyTargets', 'legacyPresets', 'unparsedEntries'];
  if (!object(document) || fields.some(key => !own(document, key)) || Object.keys(document).some(key => !fields.includes(key)) || document.format !== 'dsh-attendance' || document.version !== 1 || typeof document.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(document.updatedAt) || !Number.isFinite(Date.parse(document.updatedAt)) || !object(document.records) || !object(document.weeklyTargets) || !object(document.unparsedEntries)) throw new Error('Invalid legacy attendance schema or unsupported format/version');
  const entries = new Map();
  for (const [field, prefix] of [['records', DAY_PREFIX], ['weeklyTargets', TARGET_PREFIX]]) {
    for (const [date, value] of Object.entries(document[field])) {
      if (!validDate(date)) throw new Error('Invalid legacy attendance date');
      entries.set(prefix + date, JSON.stringify(value));
    }
  }
  decodeSingletons(document, entries, false);
  return entries;
}
async function statPath(filePath, kind = 'file') {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Attendance path must be a regular ${kind}, not a symlink: ${filePath}`);
    // Some Windows adapters report junctions as plain directories in lstat.
    const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (comparable(await fs.realpath(filePath)) !== comparable(filePath)) throw new Error(`Attendance path redirects through a symlink or junction: ${filePath}`);
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ensureDirectory(directory) {
  if (!await statPath(directory, 'directory')) await fs.mkdir(directory, { recursive: true });
  await statPath(directory, 'directory');
}
async function readBytes(filePath) {
  const before = await statPath(filePath);
  if (!before) return null;
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    const after = await statPath(filePath);
    if (!after || before.ino !== opened.ino || before.dev !== opened.dev || after.ino !== opened.ino || after.dev !== opened.dev) throw new Error('Attendance file changed while opening');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function clearProvenDeadLock(lockPath) {
  const before = await statPath(lockPath);
  if (!before) return true;
  const token = await readBytes(lockPath);
  const match = /^(\d+):[0-9a-f-]{36}$/.exec(token || '');
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code !== 'ESRCH') return false; }
  const after = await statPath(lockPath);
  if (after && before.ino === after.ino && before.dev === after.dev && await readBytes(lockPath) === token) {
    await fs.unlink(lockPath);
    return true;
  }
  return false;
}
async function writeFlushed(filePath, bytes) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDirectory(directory) {
  // Windows does not expose directory fsync through Node. Every journal/data file is flushed.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicReplace(filePath, bytes) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFlushed(temporary, bytes);
    await statPath(filePath);
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Daily JSON storage with a root lock and recoverable, all-or-nothing multi-file transactions. */
export class AttendanceFileStore {
  constructor({ filePath } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('filePath must be an absolute path');
    this.filePath = path.resolve(filePath); // Compatibility identity and optional legacy import source.
    this.directoryPath = path.dirname(this.filePath);
    const parsed = path.parse(this.filePath);
    this.legacyName = `${parsed.name}.legacy${parsed.ext || '.json'}`;
    if (['settings.json', '.attendance.lock'].includes(parsed.base) || parsed.base === this.legacyName) throw new TypeError('filePath must identify the legacy attendance JSON, not a storage control file');
  }

  async _safePath(relative) {
    if (typeof relative !== 'string' || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe attendance transaction path');
    const parts = relative.split('/');
    const base = parts.at(-1).replace(/\.bak$/, '');
    const single = parts.length === 1 && [path.basename(this.filePath), this.legacyName, 'settings.json'].includes(base);
    const daily = parts.length === 2 && ['records', 'weekly-targets'].includes(parts[0]) && base.endsWith('.json') && validDate(base.slice(0, -5));
    if (!single && !daily) throw new Error('Unrecognized attendance transaction path');
    await statPath(this.directoryPath, 'directory');
    if (parts.length === 2) await ensureDirectory(path.join(this.directoryPath, parts[0]));
    const target = path.join(this.directoryPath, ...parts);
    await statPath(target);
    return target;
  }

  async _locked(action) {
    const queueKey = process.platform === 'win32' ? this.directoryPath.toLowerCase() : this.directoryPath;
    const previous = queues.get(queueKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      await ensureDirectory(this.directoryPath);
      const lockPath = path.join(this.directoryPath, '.attendance.lock');
      const token = `${process.pid}:${randomUUID()}`;
      let handle;
      const deadline = Date.now() + 3000;
      for (;;) {
        try { handle = await fs.open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (await clearProvenDeadLock(lockPath)) continue; // Age alone never authorizes stealing a lock.
          if (Date.now() >= deadline) throw new Error(`Attendance directory is locked: ${lockPath}`, { cause: error });
          await delay(20 + Math.floor(Math.random() * 20));
        }
      }
      let identity;
      try {
        identity = await handle.stat();
        await handle.writeFile(token, 'utf8');
        await this._recover();
        return await action();
      } finally {
        await handle.close();
        const stat = await fs.lstat(lockPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (identity && stat && !stat.isSymbolicLink() && stat.ino === identity.ino && stat.dev === identity.dev && await fs.readFile(lockPath, 'utf8') === token) await fs.unlink(lockPath);
      }
    });
    queues.set(queueKey, operation);
    try { return await operation; }
    finally { if (queues.get(queueKey) === operation) queues.delete(queueKey); }
  }

  async _cleanJournal(directory) {
    await statPath(directory, 'directory');
    for (const name of await fs.readdir(directory)) {
      if (!/^(?:manifest\.json|manifest\.pending|commit\.pending|COMMITTED|\d+\.(?:before|after))$/.test(name)) throw new Error('Unexpected file in attendance transaction journal');
      await statPath(path.join(directory, name));
    }
    // Rename out of the recovery namespace before deleting any before images/marker.
    // An interrupted cleanup must never look like an interrupted uncommitted transaction.
    const done = path.basename(directory).startsWith('.txn-') ? path.join(this.directoryPath, path.basename(directory).replace('.txn-', '.done-')) : directory;
    if (done !== directory) { await fs.rename(directory, done); await syncDirectory(this.directoryPath); }
    await fs.rm(done, { recursive: true });
    await syncDirectory(this.directoryPath);
  }

  async _journal(directory) {
    await statPath(directory, 'directory');
    const manifestBytes = await readBytes(path.join(directory, 'manifest.json'));
    if (manifestBytes === null) return null; // No install occurs before the durable manifest.
    const manifest = parseDocument(manifestBytes, 'attendance transaction');
    if (!object(manifest) || manifest.format !== 'dsh-attendance-transaction' || manifest.version !== 1 || !Array.isArray(manifest.operations)) throw new Error('Invalid attendance transaction journal; manual recovery required');
    const paths = new Set();
    const operations = [];
    for (const [index, operation] of manifest.operations.entries()) {
      if (!object(operation) || paths.has(operation.path) || ![null, `${index}.before`].includes(operation.before) || ![null, `${index}.after`].includes(operation.after)) throw new Error('Invalid attendance transaction operation');
      paths.add(operation.path);
      await this._safePath(operation.path);
      const before = operation.before === null ? null : await readBytes(path.join(directory, operation.before));
      const after = operation.after === null ? null : await readBytes(path.join(directory, operation.after));
      if ((operation.before !== null && before === null) || (operation.after !== null && after === null)) throw new Error('Incomplete attendance transaction journal; manual recovery required');
      operations.push({ path: operation.path, before, after });
    }
    return operations;
  }

  async _install(relative, bytes) {
    const target = await this._safePath(relative);
    if (bytes === null) {
      await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await syncDirectory(path.dirname(target));
    } else await atomicReplace(target, bytes);
  }

  async _restore(operations) {
    // Restore every before image, so an interrupted rollback is itself safe to retry.
    for (const operation of [...operations].reverse()) await this._install(operation.path, operation.before);
  }

  async _recover() {
    for (const name of (await fs.readdir(this.directoryPath)).sort()) {
      if (!/^\.(?:txn|done)-[0-9a-f-]{36}$/.test(name)) continue;
      const directory = path.join(this.directoryPath, name);
      if (name.startsWith('.done-')) { await this._cleanJournal(directory); continue; }
      const operations = await this._journal(directory);
      const committed = await readBytes(path.join(directory, 'COMMITTED'));
      if (committed !== null && committed !== '') throw new Error('Invalid attendance transaction commit marker');
      if (operations && committed === null) await this._restore(operations);
      await this._cleanJournal(directory);
    }
  }

  async _transaction(changes) {
    if (!changes.size) return;
    const directory = path.join(this.directoryPath, `.txn-${randomUUID()}`);
    const operations = [];
    // Validate/read every destination before creating a journal or touching data.
    for (const [relative, after] of changes) {
      const target = await this._safePath(relative);
      const before = await readBytes(target);
      if (before !== after) operations.push({ path: relative, before, after });
    }
    if (!operations.length) return;
    await fs.mkdir(directory);
    let prepared = false;
    let committed = false;
    try {
      const manifest = { format: 'dsh-attendance-transaction', version: 1, operations: [] };
      for (const [index, operation] of operations.entries()) {
        const before = operation.before === null ? null : `${index}.before`;
        const after = operation.after === null ? null : `${index}.after`;
        if (before) await writeFlushed(path.join(directory, before), operation.before);
        if (after) await writeFlushed(path.join(directory, after), operation.after);
        manifest.operations.push({ path: operation.path, before, after });
      }
      await writeFlushed(path.join(directory, 'manifest.pending'), pretty(manifest));
      await fs.rename(path.join(directory, 'manifest.pending'), path.join(directory, 'manifest.json'));
      await syncDirectory(directory);
      await syncDirectory(this.directoryPath);
      prepared = true;
      for (const operation of operations) await this._install(operation.path, operation.after);
      await writeFlushed(path.join(directory, 'commit.pending'), '');
      await fs.rename(path.join(directory, 'commit.pending'), path.join(directory, 'COMMITTED'));
      committed = true; // The marker is the commit point; recovery must now retain new data.
      await syncDirectory(directory);
    } catch (cause) {
      if (committed) throw new Error(`Attendance transaction committed but directory flush failed; journal retained at ${directory}`, { cause });
      if (prepared) {
        try { await this._restore(operations); }
        catch (rollbackError) { throw new Error(`Attendance transaction failed and rollback is pending; durable journal retained at ${directory}`, { cause: new AggregateError([cause, rollbackError]) }); }
      }
      await this._cleanJournal(directory);
      throw new Error('Attendance transaction failed; original files preserved', { cause });
    }
    if (committed) {
      // A committed transaction is successful even if cleanup must wait for the next read.
      await this._cleanJournal(directory).catch(() => {});
    }
  }

  async _scan() {
    const entries = new Map();
    const files = new Map();
    const settingsPath = await this._safePath('settings.json');
    const settings = await readBytes(settingsPath);
    if (settings !== null) {
      files.set('settings.json', settings);
      for (const [key, value] of decodeSettings(settings)) entries.set(key, value);
    }
    for (const [directory, prefix] of [['records', DAY_PREFIX], ['weekly-targets', TARGET_PREFIX]]) {
      await ensureDirectory(path.join(this.directoryPath, directory));
      for (const name of (await fs.readdir(path.join(this.directoryPath, directory))).sort()) {
        if (!name.endsWith('.json') || !validDate(name.slice(0, -5))) continue;
        const relative = `${directory}/${name}`;
        const raw = await readBytes(await this._safePath(relative));
        if (raw === null) continue;
        files.set(relative, raw);
        entries.set(prefix + name.slice(0, -5), normalize(raw));
      }
    }
    return { entries, files };
  }

  async _changes(current, next, { initialize = true } = {}) {
    const changes = new Map();
    const settingsChanged = [PRESET_KEY, LEGACY_PRESET_KEY].some(key => current.entries.get(key) !== next.get(key));
    if (settingsChanged || (initialize && !current.files.has('settings.json'))) changes.set('settings.json', encodeSettings(next));
    const keys = new Set([...current.entries.keys(), ...next.keys()]);
    for (const key of keys) {
      const [directory, date] = classify(key);
      if (!date || current.entries.get(key) === next.get(key)) continue;
      let bytes = null;
      if (next.has(key)) {
        const raw = next.get(key);
        try { bytes = pretty(JSON.parse(raw)); } catch { bytes = raw; }
      }
      changes.set(`${directory}/${date}.json`, bytes);
    }
    // Backups participate in the same rollback journal and retain exact previous bytes.
    for (const [relative] of [...changes]) if (current.files.has(relative)) changes.set(`${relative}.bak`, current.files.get(relative));
    return changes;
  }

  async _load(initialize = true) {
    const current = await this._scan();
    const legacyBytes = await readBytes(await this._safePath(path.basename(this.filePath)));
    if (legacyBytes !== null) {
      const legacyEntries = decodeLegacy(legacyBytes); // Validate before writing anything.
      const next = new Map(current.entries);
      for (const [key, value] of legacyEntries) if (!next.has(key)) next.set(key, value);
      const changes = await this._changes(current, next);
      const archived = await readBytes(await this._safePath(this.legacyName));
      if (archived !== null && archived !== legacyBytes) throw new Error('Legacy attendance archive already exists with different content; refusing to overwrite');
      changes.set(this.legacyName, legacyBytes);
      changes.set(path.basename(this.filePath), null);
      await this._transaction(changes);
      return this._scan();
    }
    if (initialize && !current.files.has('settings.json')) {
      await this._transaction(new Map([['settings.json', encodeSettings(current.entries)]]));
      return this._scan();
    }
    return current;
  }

  _snapshot({ entries, files }) {
    const wire = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
    const bytes = JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)));
    return { filePath: this.filePath, directoryPath: this.directoryPath, storageLayout: 'daily-json', entries: wire, revision: createHash('sha256').update(bytes).digest('hex') };
  }

  async _save(current, next) {
    await this._transaction(await this._changes(current, next));
    return this._snapshot(await this._scan());
  }

  async read() { return this._locked(async () => this._snapshot(await this._load())); }

  async commit({ changes, expected } = {}) {
    changes = validateEntries(changes, true);
    expected = validateEntries(expected, true);
    return this._locked(async () => {
      const current = await this._load(false);
      if (expected.some(({ key, value }) => (current.entries.get(key) ?? null) !== value)) return { conflict: true, ...this._snapshot(current) };
      const next = new Map(current.entries);
      for (const { key, value } of changes) { if (value === null) next.delete(key); else next.set(key, normalize(value)); }
      return { conflict: false, ...await this._save(current, next) };
    });
  }

  async migrate(entries) {
    entries = validateEntries(entries);
    return this._locked(async () => {
      const current = await this._load(false);
      const next = new Map(current.entries);
      let imported = 0;
      let conflicts = 0;
      for (const { key, value } of entries) {
        const normalized = normalize(value);
        if (!next.has(key)) { next.set(key, normalized); imported++; }
        else if (next.get(key) !== normalized) conflicts++;
      }
      return { ...await this._save(current, next), imported, conflicts };
    });
  }
}

export default AttendanceFileStore;
