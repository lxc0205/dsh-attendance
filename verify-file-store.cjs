'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

(async () => {
  const { AttendanceFileStore, DAY_PREFIX, TARGET_PREFIX, PRESET_KEY, LEGACY_PRESET_KEY } = await import(pathToFileURL(path.join(__dirname, 'file-store.js')).href);
  const tempParent = path.join(__dirname, '.tmp');
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, 'file-store-tests-'));
  let tests = 0;
  async function test(name, run) { await run(); tests++; console.log(`PASS ${name}`); }
  const filePath = path.join(root, 'attendance.json');
  const store = new AttendanceFileStore({ filePath });
  const day = DAY_PREFIX + '2026-11-05';
  const secondDay = DAY_PREFIX + '2026-11-06';
  const target = TARGET_PREFIX + '2026-11-02';
  const dailyPath = path.join(root, 'records', '2026-11-05.json');
  const settingsPath = path.join(root, 'settings.json');
  const values = snapshot => Object.fromEntries(snapshot.entries.map(({ key, value }) => [key, value]));
  const read = file => fs.readFile(file, 'utf8');
  const missing = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const journals = async directory => (await fs.readdir(directory)).filter(name => /^\.(txn|done)-/.test(name));
  const commit = changes => store.commit({ changes, expected: [] });
  const legacyDocument = () => ({ format: 'dsh-attendance', version: 1, updatedAt: '2026-11-05T07:00:00.000Z', records: {}, presets: null, weeklyTargets: {}, legacyPresets: null, unparsedEntries: {} });
  const fresh = async name => { const directory = path.join(root, name); await fs.mkdir(directory); return { directory, filePath: path.join(directory, 'attendance.json'), store: new AttendanceFileStore({ filePath: path.join(directory, 'attendance.json') }) }; };
  try {
    await test('absolute paths, strict whitelist, valid dates, duplicate and string validation', async () => {
      assert.throws(() => new AttendanceFileStore({ filePath: 'relative.json' }), /absolute/);
      for (const changes of [[{ key: 'other', value: '1' }], [{ key: DAY_PREFIX + '2026-02-30', value: '1' }], [{ key: DAY_PREFIX + '2026-13-01', value: '1' }], [{ key: day, value: {} }], [{ key: day, value: '1' }, { key: day, value: '2' }]]) await assert.rejects(store.commit({ changes, expected: [] }));
      await assert.rejects(store.migrate([{ key: day, value: null }]));
      await assert.rejects(store.commit({ changes: [], expected: [{ key: day, value: 1 }] }));
    });
    await test('initialization creates daily layout and settings, never a combined log', async () => {
      const snapshot = await store.read();
      assert.equal(snapshot.filePath, filePath);
      assert.equal(snapshot.directoryPath, root);
      assert.equal(snapshot.storageLayout, 'daily-json');
      assert.deepEqual(snapshot.entries, []);
      assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
      assert.deepEqual(JSON.parse(await read(settingsPath)), { format: 'dsh-attendance-settings', version: 1, presets: null, legacyPresets: null, unparsedEntries: {} });
      assert.match(await read(settingsPath), /\n  "format"/);
      assert.ok((await fs.stat(path.join(root, 'records'))).isDirectory());
      assert.ok((await fs.stat(path.join(root, 'weekly-targets'))).isDirectory());
      await missing(filePath);
      await missing(settingsPath + '.bak');
    });
    await test('preset + native day + numeric weekly target commit together', async () => {
      const native = { version: 3, date: '2026-11-05', periods: { morning: { start: '08:30', end: '12:00' } } };
      const snapshot = await store.commit({ changes: [{ key: PRESET_KEY, value: '{ "slots": [1, 2] }' }, { key: day, value: JSON.stringify(native, null, 2) }, { key: target, value: ' 40 ' }], expected: [{ key: day, value: null }, { key: PRESET_KEY, value: null }] });
      assert.equal(snapshot.conflict, false);
      assert.equal(values(snapshot)[PRESET_KEY], '{"slots":[1,2]}');
      assert.equal(values(snapshot)[day], JSON.stringify(native));
      assert.deepEqual(JSON.parse(await read(dailyPath)), native);
      assert.deepEqual(JSON.parse(await read(settingsPath)).presets, { slots: [1, 2] });
      assert.equal(JSON.parse(await read(path.join(root, 'weekly-targets', '2026-11-02.json'))), 40);
      assert.deepEqual(await journals(root), []);
    });
    await test('expected conflict returns latest canonical snapshot with no writes', async () => {
      const before = await read(dailyPath);
      const settings = await read(settingsPath);
      const result = await store.commit({ changes: [{ key: PRESET_KEY, value: '{}' }, { key: secondDay, value: '{}' }], expected: [{ key: day, value: null }] });
      assert.equal(result.conflict, true);
      assert.equal(values(result)[secondDay], undefined);
      assert.equal(await read(dailyPath), before);
      assert.equal(await read(settingsPath), settings);
      const ok = await store.commit({ changes: [{ key: day, value: '{ "changed": true }' }], expected: [{ key: day, value: values(result)[day] }] });
      assert.equal(ok.conflict, false);
    });
    await test('updating one date preserves other date and settings bytes and mtimes', async () => {
      await commit([{ key: secondDay, value: '{"other":true}' }]);
      const otherPath = path.join(root, 'records', '2026-11-06.json');
      const before = await read(otherPath);
      const stat = await fs.stat(otherPath, { bigint: true });
      const settingsBefore = await read(settingsPath);
      const settingsStat = await fs.stat(settingsPath, { bigint: true });
      await commit([{ key: day, value: '{"onlyToday":true}' }]);
      assert.equal(await read(otherPath), before);
      assert.equal((await fs.stat(otherPath, { bigint: true })).mtimeNs, stat.mtimeNs);
      assert.equal(await read(settingsPath), settingsBefore);
      assert.equal((await fs.stat(settingsPath, { bigint: true })).mtimeNs, settingsStat.mtimeNs);
    });
    await test('cross-instance and same-root alias concurrency preserve separate dates', async () => {
      const other = new AttendanceFileStore({ filePath: path.join(root, 'another-legacy-name.json') });
      const dates = Array.from({ length: 10 }, (_, index) => `2026-12-${String(index + 1).padStart(2, '0')}`);
      const results = await Promise.all(dates.map((date, index) => (index % 2 ? store : other).commit({ changes: [{ key: DAY_PREFIX + date, value: JSON.stringify({ index }) }], expected: [{ key: DAY_PREFIX + date, value: null }] })));
      assert.ok(results.every(result => result.conflict === false));
      const current = values(await store.read());
      dates.forEach((date, index) => assert.equal(current[DAY_PREFIX + date], JSON.stringify({ index })));
      const contestDay = DAY_PREFIX + '2026-12-20';
      const contested = await Promise.all([store, other].map((instance, index) => instance.commit({ changes: [{ key: contestDay, value: String(index) }], expected: [{ key: contestDay, value: null }] })));
      assert.equal(contested.filter(result => result.conflict).length, 1);
    });
    await test('browser migration preserves file values and raw malformed values without touching input', async () => {
      const before = values(await store.read());
      const raw = ' { definitely not JSON\n';
      const entries = [{ key: day, value: '{"browser":true}' }, { key: PRESET_KEY, value: ' { "slots": [1,2] } ' }, { key: LEGACY_PRESET_KEY, value: raw }, { key: DAY_PREFIX + '2026-11-07', value: '{ "unexpected": 7 }' }, { key: DAY_PREFIX + '2026-11-08', value: raw }];
      const original = JSON.stringify(entries);
      const result = await store.migrate(entries);
      assert.equal(result.imported, 3);
      assert.equal(result.conflicts, 1);
      assert.equal(values(result)[day], before[day]);
      assert.equal(values(result)[LEGACY_PRESET_KEY], raw);
      assert.equal(values(result)[DAY_PREFIX + '2026-11-07'], '{"unexpected":7}');
      assert.equal(await read(path.join(root, 'records', '2026-11-08.json')), raw);
      assert.equal(JSON.parse(await read(settingsPath)).unparsedEntries[LEGACY_PRESET_KEY], raw);
      assert.equal(JSON.stringify(entries), original);
      assert.equal((await store.migrate(entries)).imported, 0);
    });
    await test('JSON null singletons are preserved and null changes delete individual files', async () => {
      await commit([{ key: PRESET_KEY, value: ' null ' }, { key: DAY_PREFIX + '2026-11-09', value: 'null' }]);
      assert.equal(values(await store.read())[PRESET_KEY], 'null');
      assert.equal(values(await store.read())[DAY_PREFIX + '2026-11-09'], 'null');
      await store.commit({ changes: [{ key: PRESET_KEY, value: null }, { key: DAY_PREFIX + '2026-11-09', value: null }], expected: [{ key: PRESET_KEY, value: 'null' }] });
      assert.equal(values(await store.read())[PRESET_KEY], undefined);
      await missing(path.join(root, 'records', '2026-11-09.json'));
      assert.equal(await read(path.join(root, 'records', '2026-11-09.json.bak')), 'null\n');
    });
    await test('manual daily edits and damaged daily JSON are freshly visible and preserved', async () => {
      const initial = await store.read();
      await fs.writeFile(dailyPath, '{ "manual": true }\n');
      const edited = await store.read();
      assert.equal(values(edited)[day], '{"manual":true}');
      assert.notEqual(edited.revision, initial.revision);
      const broken = '{ damaged manual daily JSON\n';
      await fs.writeFile(dailyPath, broken);
      assert.equal(values(await store.read())[day], broken);
      await commit([{ key: secondDay, value: '{"unrelated":true}' }]);
      assert.equal(await read(dailyPath), broken);
      await fs.writeFile(dailyPath, '{"restored":true}\n');
    });
    await test('strict date scanning ignores unrelated and invalid-date JSON filenames', async () => {
      for (const name of ['notes.json', '2026-02-30.json', '2026-13-01.json', '2026-11-05.json.tmp']) await fs.writeFile(path.join(root, 'records', name), 'ignore me');
      const result = await store.read();
      assert.ok(result.entries.every(entry => !entry.key.includes('2026-02-30') && !entry.key.includes('2026-13-01')));
      await commit([{ key: day, value: '{"scanned":true}' }]);
      assert.equal(await read(path.join(root, 'records', 'notes.json')), 'ignore me');
    });
    await test('damaged or unknown settings always reject without overwriting', async () => {
      const valid = await read(settingsPath);
      const base = JSON.parse(valid);
      for (const bytes of ['{broken', JSON.stringify({ ...base, format: 'unknown' }), JSON.stringify({ ...base, version: 2 }), JSON.stringify({ ...base, unparsedEntries: [] }), JSON.stringify({ ...base, extra: true })]) {
        await fs.writeFile(settingsPath, bytes);
        await assert.rejects(store.read());
        await assert.rejects(commit([{ key: day, value: '{}' }]));
        await assert.rejects(store.migrate([{ key: day, value: '{}' }]));
        assert.equal(await read(settingsPath), bytes);
      }
      await fs.writeFile(settingsPath, valid);
    });
    await test('each changed file gets its own exact previous-byte backup', async () => {
      const dayBefore = await read(dailyPath);
      const settingsBefore = await read(settingsPath);
      const targetPath = path.join(root, 'weekly-targets', '2026-11-02.json');
      const targetBefore = await read(targetPath);
      await commit([{ key: day, value: '{"backup":true}' }, { key: PRESET_KEY, value: '{"backup":true}' }, { key: target, value: '41' }]);
      assert.equal(await read(dailyPath + '.bak'), dayBefore);
      assert.equal(await read(settingsPath + '.bak'), settingsBefore);
      assert.equal(await read(targetPath + '.bak'), targetBefore);
    });
    await test('partial multi-file installation failure rolls all files and backups back', async () => {
      const paths = [dailyPath, dailyPath + '.bak', settingsPath, settingsPath + '.bak'];
      const before = await Promise.all(paths.map(read));
      const install = store._install;
      let installed = 0;
      store._install = async function (relative, bytes) { installed++; if (installed === 2) throw new Error('injected second-install failure'); return install.call(this, relative, bytes); };
      try { await assert.rejects(commit([{ key: PRESET_KEY, value: '{"new":1}' }, { key: day, value: '{"new":1}' }]), /original files preserved/); }
      finally { store._install = install; }
      assert.deepEqual(await Promise.all(paths.map(read)), before);
      assert.deepEqual(await journals(root), []);
      await missing(path.join(root, '.attendance.lock'));
    });
    await test('failed rollback keeps durable before/after journal and next read restores old state', async () => {
      const dayBefore = await read(dailyPath);
      const settingsBefore = await read(settingsPath);
      const install = store._install;
      const restore = store._restore;
      let installs = 0;
      store._install = async function (relative, bytes) { installs++; if (installs === 2) throw new Error('injected install failure'); return install.call(this, relative, bytes); };
      store._restore = async () => { throw new Error('injected rollback unavailable'); };
      try { await assert.rejects(commit([{ key: PRESET_KEY, value: '{"pending":1}' }, { key: day, value: '{"pending":1}' }]), /rollback is pending/); }
      finally { store._install = install; store._restore = restore; }
      const retained = await journals(root);
      assert.equal(retained.length, 1);
      const manifest = JSON.parse(await read(path.join(root, retained[0], 'manifest.json')));
      assert.equal(manifest.format, 'dsh-attendance-transaction');
      assert.ok((await fs.readdir(path.join(root, retained[0]))).some(name => name.endsWith('.before')));
      // A staged but unrenamed commit marker is still uncommitted.
      await fs.writeFile(path.join(root, retained[0], 'commit.pending'), '');
      const deadPid = 2147483647;
      assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' }, 'fixture PID must be provably dead');
      await fs.writeFile(path.join(root, '.attendance.lock'), `${deadPid}:${randomUUID()}`, { flag: 'wx' });
      await new AttendanceFileStore({ filePath }).read();
      await missing(path.join(root, '.attendance.lock'));
      assert.equal(await read(dailyPath), dayBefore);
      assert.equal(await read(settingsPath), settingsBefore);
      assert.deepEqual(await journals(root), []);
    });
    await test('committed journal cleanup on next read retains new state', async () => {
      const clean = store._cleanJournal;
      store._cleanJournal = async () => { throw new Error('injected cleanup failure'); };
      let result;
      try { result = await commit([{ key: day, value: '{"committed":true}' }]); }
      finally { store._cleanJournal = clean; }
      assert.equal(result.conflict, false);
      assert.equal((await journals(root)).length, 1);
      assert.equal(values(await store.read())[day], '{"committed":true}');
      assert.deepEqual(await journals(root), []);
    });
    await test('interrupted cleanup and incomplete pre-install staging are safe to discard', async () => {
      const before = await read(dailyPath);
      const done = path.join(root, '.done-' + randomUUID());
      await fs.mkdir(done);
      await fs.writeFile(path.join(done, '0.before'), 'partially deleted committed journal');
      const pending = path.join(root, '.txn-' + randomUUID());
      await fs.mkdir(pending);
      await fs.writeFile(path.join(pending, 'manifest.pending'), '{ partial manifest');
      await fs.writeFile(path.join(pending, '0.after'), 'not installed');
      await store.read();
      assert.equal(await read(dailyPath), before);
      assert.deepEqual(await journals(root), []);
    });
    await test('legacy combined log migrates once and preserves exact original archive', async () => {
      const isolated = await fresh('legacy-import');
      const legacy = legacyDocument();
      legacy.records['2026-11-05'] = { version: 2, legacy: true };
      legacy.presets = { slots: [1] };
      legacy.weeklyTargets['2026-11-02'] = 38;
      legacy.unparsedEntries[DAY_PREFIX + '2026-11-06'] = '{old malformed';
      const bytes = JSON.stringify(legacy, null, 4) + '\n';
      await fs.writeFile(isolated.filePath, bytes);
      const result = await isolated.store.read();
      assert.equal(values(result)[day], '{"version":2,"legacy":true}');
      assert.equal(values(result)[secondDay], '{old malformed');
      assert.equal(values(result)[target], '38');
      await missing(isolated.filePath);
      assert.equal(await read(path.join(isolated.directory, 'attendance.legacy.json')), bytes);
      assert.equal(await read(path.join(isolated.directory, 'records', '2026-11-06.json')), '{old malformed');
      await isolated.store.read();
      assert.equal(await read(path.join(isolated.directory, 'attendance.legacy.json')), bytes);
    });
    await test('existing shards win over legacy values, including malformed daily JSON', async () => {
      const isolated = await fresh('legacy-existing');
      await isolated.store.commit({ changes: [{ key: day, value: '{malformed file wins' }, { key: PRESET_KEY, value: '{"file":true}' }], expected: [] });
      const legacy = legacyDocument();
      legacy.records['2026-11-05'] = { legacy: true };
      legacy.records['2026-11-06'] = { imported: true };
      legacy.presets = { legacy: true };
      await fs.writeFile(isolated.filePath, JSON.stringify(legacy));
      const result = await isolated.store.read();
      assert.equal(values(result)[day], '{malformed file wins');
      assert.equal(values(result)[PRESET_KEY], '{"file":true}');
      assert.equal(values(result)[secondDay], '{"imported":true}');
    });
    await test('legacy migration installation failure preserves original and existing shards', async () => {
      const isolated = await fresh('legacy-failure');
      await isolated.store.read();
      const legacy = legacyDocument();
      legacy.records['2026-11-05'] = { imported: true };
      const bytes = JSON.stringify(legacy);
      await fs.writeFile(isolated.filePath, bytes);
      const install = isolated.store._install;
      let count = 0;
      isolated.store._install = async function (relative, after) { count++; if (count === 2) throw new Error('legacy failure'); return install.call(this, relative, after); };
      try { await assert.rejects(isolated.store.read(), /original files preserved/); }
      finally { isolated.store._install = install; }
      assert.equal(await read(isolated.filePath), bytes);
      await missing(path.join(isolated.directory, 'attendance.legacy.json'));
      await missing(path.join(isolated.directory, 'records', '2026-11-05.json'));
      assert.equal(values(await isolated.store.read())[day], '{"imported":true}');
    });
    await test('damaged or unsupported legacy files never migrate or overwrite shards', async () => {
      const isolated = await fresh('legacy-invalid');
      const legacy = legacyDocument();
      for (const bytes of ['{broken', JSON.stringify({ ...legacy, format: 'unknown' }), JSON.stringify({ ...legacy, version: 2 }), JSON.stringify({ ...legacy, records: [] }), JSON.stringify({ ...legacy, records: { '2026-02-30': {} } })]) {
        await fs.writeFile(isolated.filePath, bytes);
        await assert.rejects(isolated.store.read());
        await assert.rejects(isolated.store.migrate([{ key: day, value: '{}' }]));
        assert.equal(await read(isolated.filePath), bytes);
        await missing(path.join(isolated.directory, 'settings.json'));
        await missing(path.join(isolated.directory, 'attendance.legacy.json'));
      }
    });
    await test('conflicting legacy archive is never overwritten', async () => {
      const isolated = await fresh('legacy-archive-conflict');
      const legacy = JSON.stringify(legacyDocument());
      await fs.writeFile(isolated.filePath, legacy);
      await fs.writeFile(path.join(isolated.directory, 'attendance.legacy.json'), 'original archive');
      await assert.rejects(isolated.store.read(), /archive already exists/);
      assert.equal(await read(isolated.filePath), legacy);
      assert.equal(await read(path.join(isolated.directory, 'attendance.legacy.json')), 'original archive');
    });
    await test('live or malformed external lock is never stolen and no file gets truncated', async () => {
      const lock = path.join(root, '.attendance.lock');
      const before = await read(dailyPath);
      const owner = `${process.pid}:${randomUUID()}`;
      await fs.writeFile(lock, owner, { flag: 'wx' });
      await assert.rejects(commit([{ key: day, value: '{}' }]), /locked/);
      assert.equal(await read(lock), owner);
      assert.equal(await read(dailyPath), before);
      await fs.unlink(lock);
      await fs.writeFile(lock, 'unknown lock owner', { flag: 'wx' });
      const waiting = store.read();
      const release = new Promise((resolve, reject) => setTimeout(() => { fs.unlink(lock).then(resolve, reject); }, 60));
      await Promise.all([waiting, release]);
    });
    await test('invalid backup destination fails before installing any data', async () => {
      const before = await read(dailyPath);
      const backup = dailyPath + '.bak';
      const previousBackup = await read(backup);
      await fs.unlink(backup);
      await fs.mkdir(backup);
      await assert.rejects(commit([{ key: day, value: '{"shouldFail":true}' }]));
      assert.equal(await read(dailyPath), before);
      assert.deepEqual(await journals(root), []);
      await fs.rmdir(backup);
      await fs.writeFile(backup, previousBackup);
    });
    await test('expected conflict on absent storage creates no JSON files', async () => {
      const isolated = await fresh('absent-conflict');
      const result = await isolated.store.commit({ changes: [{ key: day, value: '{}' }], expected: [{ key: day, value: '{"old":true}' }] });
      assert.equal(result.conflict, true);
      assert.deepEqual(result.entries, []);
      await missing(path.join(isolated.directory, 'settings.json'));
      await missing(path.join(isolated.directory, 'records', '2026-11-05.json'));
      await missing(isolated.filePath);
    });
    await test('first commit has no prior backups and no-op commit does not rewrite files', async () => {
      const isolated = await fresh('fresh-commit');
      await isolated.store.commit({ changes: [{ key: day, value: '{}' }], expected: [] });
      const record = path.join(isolated.directory, 'records', '2026-11-05.json');
      await missing(record + '.bak');
      await missing(path.join(isolated.directory, 'settings.json.bak'));
      const stat = await fs.stat(record, { bigint: true });
      await isolated.store.commit({ changes: [{ key: day, value: ' { } ' }], expected: [] });
      assert.equal((await fs.stat(record, { bigint: true })).mtimeNs, stat.mtimeNs);
      await missing(record + '.bak');
    });
    await test('symlinked storage directories and files are rejected when platform permits links', async () => {
      const isolated = await fresh('symlink-check');
      const destination = path.join(root, 'records');
      const linkedDirectory = path.join(isolated.directory, 'records');
      try { await fs.symlink(destination, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { console.log('NOTE directory symlink creation unavailable'); return; } throw error; }
      await assert.rejects(isolated.store.read(), /symlink/);
      // Junctions are directories on Windows; leave removal to the outer fs.rm finally.
      const isolatedFile = await fresh('file-symlink-check');
      await isolatedFile.store.read();
      const linkedRecord = path.join(isolatedFile.directory, 'records', '2026-11-05.json');
      try { await fs.symlink(dailyPath, linkedRecord, 'file'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { console.log('NOTE file symlink creation unavailable'); return; } throw error; }
      await assert.rejects(isolatedFile.store.read(), /symlink/);
    });
    console.log(`Daily file store verification passed (${tests} tests).`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
