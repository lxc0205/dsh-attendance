'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

(async () => {
  const { createAttendanceRoutes, attendanceFilePath } = await import(pathToFileURL(path.join(__dirname, 'index.js')).href);
  const filePath = path.resolve(__dirname, '.tmp', 'host-test-fixed', 'attendance.json');
  const directoryPath = path.dirname(filePath);
  const snapshot = { filePath, directoryPath, entries: [], revision: 'test-revision' };
  const calls = [];
  const store = {
    async read() { calls.push(['read']); return snapshot; },
    async commit(body) { calls.push(['commit', body]); return { conflict: false, ...snapshot }; },
    async migrate(entries) { calls.push(['migrate', entries]); return { ...snapshot, imported: entries.length, conflicts: 0 }; },
  };
  const opened = [];
  let rejectStatus;
  const routes = createAttendanceRoutes({ store, filePath, rejection(req) { calls.push(['authorize', req.method]); return rejectStatus; }, async openDirectory(directory) { opened.push(directory); } });
  const routeFor = name => routes.find(route => route.path === '/dsh-attendance/' + name);
  async function request(name, { method = name === 'state' ? 'GET' : 'POST', body = '{}', contentType = 'application/json', requestStream } = {}) {
    const req = requestStream || Readable.from([body]);
    req.method = method;
    req.headers = contentType === null ? {} : { 'content-type': contentType };
    const headers = {};
    let ended = false;
    let responseBody;
    const res = {
      statusCode: 200,
      setHeader(key, value) { headers[key.toLowerCase()] = value; },
      end(value) { assert.equal(ended, false, 'response must finish exactly once'); ended = true; responseBody = value; },
    };
    await routeFor(name).handler(req, res);
    assert.equal(ended, true, 'response must finish');
    return { status: res.statusCode, headers, body: responseBody === undefined ? undefined : JSON.parse(responseBody) };
  }
  let tests = 0;
  const failures = [];
  async function test(name, run) {
    calls.length = 0;
    opened.length = 0;
    rejectStatus = undefined;
    try { await run(); tests++; console.log('PASS ' + name); }
    catch (error) { failures.push({ name, error }); console.error('FAIL ' + name + '\n' + error.stack); }
  }
  await test('route registration uses four exact fixed routes', async () => {
    assert.deepEqual(routes.map(route => [route.kind, route.path]), ['state', 'commit', 'migrate', 'open-folder'].map(name => ['exact', '/dsh-attendance/' + name]));
  });
  await test('authorization precedes method dispatch, stream parsing, reads and opens', async () => {
    rejectStatus = 403;
    for (const name of ['state', 'commit', 'migrate', 'open-folder']) {
      let consumed = false;
      const stream = Readable.from((async function* () { consumed = true; throw new Error('must not consume unauthorized body'); })());
      const result = await request(name, { method: 'WRONG', contentType: 'text/plain', requestStream: stream });
      assert.equal(result.status, 403);
      assert.equal(result.body, undefined);
      assert.equal(consumed, false);
      stream.destroy();
    }
    assert.deepEqual(calls.map(call => call[0]), ['authorize', 'authorize', 'authorize', 'authorize']);
    assert.deepEqual(opened, []);
  });
  await test('state GET returns store snapshot and disables caching', async () => {
    const result = await request('state', { body: '{ broken' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, snapshot);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.deepEqual(calls.map(call => call[0]), ['authorize', 'read']);
  });
  await test('wrong methods return 405 and precise Allow before body parsing', async () => {
    for (const name of ['state', 'commit', 'migrate', 'open-folder']) {
      const expected = name === 'state' ? 'GET' : 'POST';
      const result = await request(name, { method: expected === 'GET' ? 'POST' : 'GET', contentType: 'text/plain', body: 'bad' });
      assert.equal(result.status, 405);
      assert.equal(result.headers.allow, expected);
    }
    assert.ok(calls.every(call => call[0] === 'authorize'));
  });
  await test('POST requires JSON media type and accepts charset case-insensitively', async () => {
    for (const contentType of [null, 'text/plain', 'application/jsonish', 'application/problem+json']) {
      assert.equal((await request('commit', { contentType })).status, 415);
    }
    const result = await request('commit', { contentType: 'Application/JSON; charset=utf-8', body: '{"changes":[],"expected":[]}' });
    assert.equal(result.status, 200);
    assert.equal(calls.filter(call => call[0] === 'commit').length, 1);
  });
  await test('invalid JSON and non-object request bodies return 400', async () => {
    for (const body of ['{ broken', '', 'null', '[]', 'true', '"string"', '12']) {
      assert.equal((await request('commit', { body })).status, 400, body);
    }
    assert.ok(calls.every(call => call[0] === 'authorize'));
  });
  await test('body over 8 MiB returns 413 without invoking store', async () => {
    const result = await request('commit', { requestStream: Readable.from([Buffer.alloc(8 * 1024 * 1024, 32), Buffer.from('x')]) });
    assert.equal(result.status, 413);
    assert.ok(calls.every(call => call[0] === 'authorize'));
  });
  await test('commit rejects invalid top-level shapes and forwards exact valid changes', async () => {
    for (const body of [{}, { changes: [] }, { changes: {}, expected: [] }, { changes: [], expected: null }, { changes: [], expected: [], filePath: 'untrusted' }, { changes: Array(20001).fill(null), expected: [] }, { changes: [], expected: Array(20001).fill(null) }]) {
      assert.equal((await request('commit', { body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(calls.filter(call => call[0] === 'commit').length, 0);
    const body = { changes: [{ key: 'dsh-attendance.v2.day.2026-11-05', value: '{}' }], expected: [{ key: 'dsh-attendance.v2.day.2026-11-05', value: null }] };
    const result = await request('commit', { body: JSON.stringify(body) });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ['commit', body]);
    assert.equal(result.body.conflict, false);
  });
  await test('migrate rejects invalid top-level shapes and forwards entries only', async () => {
    for (const body of [{}, { entries: null }, { entries: {} }, { entries: [], path: 'untrusted' }, { entries: Array(20001).fill(null) }]) {
      assert.equal((await request('migrate', { body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(calls.filter(call => call[0] === 'migrate').length, 0);
    const entries = [{ key: 'dsh-attendance.presets.v1', value: '{broken browser original' }];
    const result = await request('migrate', { body: JSON.stringify({ entries }) });
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1), ['migrate', entries]);
    assert.equal(result.body.imported, 1);
  });
  await test('open-folder rejects browser paths and opens only fixed Host directory', async () => {
    for (const body of [{ path: 'C:/private' }, { directoryPath: '../escape' }, { filePath: 'arbitrary' }, { ignored: true }]) {
      assert.equal((await request('open-folder', { body: JSON.stringify(body) })).status, 400);
    }
    assert.deepEqual(opened, []);
    const result = await request('open-folder');
    assert.equal(result.status, 200);
    assert.deepEqual(opened, [directoryPath]);
    assert.deepEqual(result.body, { ok: true, filePath, directoryPath });
    assert.ok(calls.every(call => call[0] === 'authorize'));
  });
  await test('store and folder exceptions return 500 with fixed filePath and no success', async () => {
    const brokenRoutes = createAttendanceRoutes({ filePath, rejection: () => undefined, store: {
      async read() { throw new Error('read failed'); },
      async commit() { throw new Error('commit failed'); },
      async migrate() { throw new Error('migrate failed'); },
    }, async openDirectory(directory) { assert.equal(directory, directoryPath); throw new Error('open failed'); } });
    for (const name of ['state', 'commit', 'migrate', 'open-folder']) {
      const index = routes.findIndex(route => route.path.endsWith('/' + name));
      const saved = routes[index];
      routes[index] = brokenRoutes[index];
      try {
        const result = await request(name, { body: name === 'commit' ? '{"changes":[],"expected":[]}' : name === 'migrate' ? '{"entries":[]}' : '{}' });
        assert.equal(result.status, 500);
        assert.equal(result.body.filePath, filePath);
        assert.equal(result.body.directoryPath, directoryPath);
        assert.match(result.body.error, /failed/);
        assert.equal(result.body.ok, undefined);
        assert.equal(result.body.conflict, undefined);
      } finally { routes[index] = saved; }
    }
  });
  await test('invalid entry values rejected by store become client parameter errors (400)', async () => {
    const checkedRoutes = createAttendanceRoutes({ filePath, rejection: () => undefined, store: {
      async read() { return snapshot; },
      async commit() { throw new TypeError('Entry value must be a string or null'); },
      async migrate() { throw new TypeError('Entry must be an object'); },
    }, async openDirectory() { throw new Error('must not open'); } });
    for (const name of ['commit', 'migrate']) {
      const index = routes.findIndex(route => route.path.endsWith('/' + name));
      const saved = routes[index];
      routes[index] = checkedRoutes[index];
      try {
        const body = name === 'commit' ? { changes: [{ key: 'dsh-attendance.presets.v1', value: 2 }], expected: [] } : { entries: [null] };
        const result = await request(name, { body: JSON.stringify(body) });
        assert.equal(result.status, 400, `${name} invalid entry must be a 400 client error`);
      } finally { routes[index] = saved; }
    }
  });
  await test('default DSH_HOME and profiles produce isolated absolute paths', async () => {
    const home = path.resolve(__dirname, '.tmp', 'fake-home');
    const dshHome = path.resolve(__dirname, '.tmp', 'fake-dsh-home');
    assert.equal(attendanceFilePath({}, home), path.join(home, '.dsh', 'data', 'dsh-attendance', 'profile-default', 'attendance.json'));
    assert.equal(attendanceFilePath({ DSH_HOME: '  ' }, home), attendanceFilePath({}, home));
    const profileA = attendanceFilePath({ DSH_HOME: dshHome, DSH_PROFILE: 'alpha' }, home);
    const profileB = attendanceFilePath({ DSH_HOME: dshHome, DSH_PROFILE: 'beta' }, home);
    assert.notEqual(profileA, profileB);
    assert.equal(profileA, path.join(dshHome, 'data', 'dsh-attendance', 'profile-alpha', 'attendance.json'));
    assert.equal(attendanceFilePath({ DSH_HOME: dshHome, DSH_PROFILE_DIR: path.join(dshHome, 'profiles', 'named') }, home), path.join(dshHome, 'data', 'dsh-attendance', 'profile-named', 'attendance.json'));
    assert.ok(path.isAbsolute(profileA));
  });
  await test('profile strings cannot escape the configured storage root', async () => {
    const dshHome = path.resolve(__dirname, '.tmp', 'fake-dsh-home');
    const base = path.join(dshHome, 'data', 'dsh-attendance');
    for (const profile of ['../escape', '..', '.', '../../outside', 'C:\\outside\\escape', '/absolute/path', 'name/../../escape', 'a'.repeat(1000)]) {
      const result = attendanceFilePath({ DSH_HOME: dshHome, DSH_PROFILE: profile });
      const relative = path.relative(base, result);
      assert.equal(path.isAbsolute(relative), false);
      assert.equal(relative.split(path.sep).length, 2);
      assert.ok(relative.split(path.sep)[0].startsWith('profile-'));
      assert.equal(path.basename(result), 'attendance.json');
      assert.ok(relative.split(path.sep)[0].length <= 'profile-'.length + 100);
    }
  });
  await test('apply registers the four routes through ctx.effect and disposes them', async () => {
    const { apply } = await import(pathToFileURL(path.join(__dirname, 'index.js')).href);
    const registered = [];
    const cleanups = [];
    const fakeCtx = {
      connection: { requestRejection() { return undefined; } },
      webServer: { register(route) { registered.push(route); return () => { registered.splice(registered.indexOf(route), 1); }; } },
      effect(run, label) { assert.equal(typeof label, 'string'); cleanups.push(run()); },
    };
    const previousHome = process.env.DSH_HOME, previousProfile = process.env.DSH_PROFILE;
    process.env.DSH_HOME = path.resolve(__dirname, '.tmp', 'apply-home');
    process.env.DSH_PROFILE = 'apply-test';
    try {
      apply(fakeCtx);
      assert.deepEqual(registered.map(route => route.path), ['state', 'commit', 'migrate', 'open-folder'].map(name => '/dsh-attendance/' + name));
      assert.equal(cleanups.length, 4);
      for (const cleanup of cleanups.reverse()) cleanup();
      assert.equal(registered.length, 0);
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
      if (previousProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = previousProfile;
    }
  });
  console.log(`Host verification: ${tests} passed, ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
