'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const vm = require('node:vm');

(async () => {
  const root = __dirname;
  const source = await fs.readFile(path.join(root, 'client.js'), 'utf8');
  const begin = '    // BEGIN ATTENDANCE MODEL', end = '    // END ATTENDANCE MODEL';
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf(begin) + begin.length, source.indexOf(end)) + '\nthis.api={DAY_PREFIX,TARGET_PREFIX,TARGET_KEY,PRESET_KEY,blankDay,createFileStorage,createRecordLog,loadDay,loadWeek,loadRecord,readTarget,updateDay,writePresets,writeTarget,planTargetMigration};', context);
  const model = context.api;
  const { AttendanceFileStore } = await import(pathToFileURL(path.join(root, 'file-store.js')));
  const { createAttendanceRoutes } = await import(pathToFileURL(path.join(root, 'index.js')));
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, '.tmp', 'integration-'));
  try {
    const filePath = path.join(folder, 'attendance.json');
    const store = new AttendanceFileStore({ filePath });
    const opened = [];
    const routes = createAttendanceRoutes({ store, filePath, rejection: () => undefined, openDirectory: async value => { opened.push(value); } });
    async function request(suffix, body) {
      const route = routes.find(value => value.path === '/dsh-attendance/' + suffix);
      assert.ok(route);
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = body === undefined ? 'GET' : 'POST';
      req.headers = body === undefined ? {} : { 'content-type': 'application/json' };
      let payload = '';
      const res = { statusCode: 0, setHeader() {}, end(value) { payload = value || ''; } };
      await route.handler(req, res);
      return { status: res.statusCode, data: payload ? JSON.parse(payload) : null };
    }
    const initial = await request('state');
    assert.equal(initial.status, 200);
    assert.equal(initial.data.storageLayout, 'daily-json');
    const legacyDirectory = path.join(folder, 'weekly-targets');
    const missingLegacy = () => assert.rejects(fs.stat(legacyDirectory), { code: 'ENOENT' });
    await missingLegacy();
    assert.equal(model.readTarget(model.createFileStorage(initial.data.entries)), 40);
    await request('state');
    await missingLegacy();
    const day = '2026-11-05', previous = '2026-11-04';
    const periods = () => ({ morning: { start: '08:30', end: '12:00' }, afternoon: { start: '13:30', end: '18:00' }, evening: { start: '', end: '' } });
    const browserEntries = [
      { key: model.DAY_PREFIX + day, value: JSON.stringify({ version: 2, periods: periods() }) },
      { key: model.DAY_PREFIX + previous, value: JSON.stringify({ version: 2, periods: periods() }) }
    ];
    const browserMap = new Map(browserEntries.map(value => [value.key, value.value]));
    const browser = { get length() { return browserMap.size; }, key: index => [...browserMap.keys()][index] ?? null, getItem: key => browserMap.get(key) ?? null };
    const migration = model.createRecordLog(browser, '2026-11-05T08:00:00Z');
    const migrated = await request('migrate', { entries: migration.entries });
    assert.equal(migrated.status, 200);
    assert.equal(migrated.data.imported, 2);
    const recordPath = value => path.join(folder, 'records', value + '.json');
    assert.equal(JSON.parse(await fs.readFile(recordPath(day), 'utf8')).periods.morning.start, '08:30');
    const historyBytes = await fs.readFile(recordPath(previous), 'utf8');
    console.log('PASS: browser records migrate through authenticated route shape into independent daily files');

    const presets = model.blankDay(); presets.morning.start = '09:00';
    const stagedPresets = model.createFileStorage(migrated.data.entries, true);
    model.writePresets(stagedPresets, presets, day, true);
    const presetSave = await request('commit', stagedPresets.patch());
    assert.equal(presetSave.status, 200); assert.equal(presetSave.data.conflict, false);
    const native = JSON.parse(await fs.readFile(recordPath(day), 'utf8'));
    assert.equal(native.periods.morning.start, '09:00');
    assert.equal(native.presets.morning.start, '09:00');
    assert.equal((await fs.readFile(recordPath(previous), 'utf8')), historyBytes);
    assert.ok((await fs.readFile(path.join(folder, 'settings.json'), 'utf8')).includes('09:00'));
    const reloaded = model.createFileStorage(presetSave.data.entries);
    assert.throws(() => model.updateDay(model.createFileStorage(presetSave.data.entries, true), day, 'morning', 'start', ''), /locked/);
    assert.equal(model.loadRecord(reloaded, day).presets.morning.start, '09:00');
    console.log('PASS: preset and today save together while history and fixed-time locks survive JSON round trips');

    const stagedTarget = model.createFileStorage(presetSave.data.entries, true);
    model.writeTarget(stagedTarget, 37.5);
    const targetSave = await request('commit', stagedTarget.patch());
    assert.equal(targetSave.status, 200); assert.equal(targetSave.data.conflict, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'settings.json'), 'utf8')).weeklyTarget, 37.5);
    assert.equal(model.readTarget(model.createFileStorage(targetSave.data.entries)), 37.5);
    await missingLegacy();
    console.log('PASS: one shared weekly target lives in settings.json instead of a per-week file');

    const legacyKey = model.TARGET_PREFIX + '2026-11-02';
    const olderLegacyKey = model.TARGET_PREFIX + '2026-10-26';
    const settingsPath = path.join(folder, 'settings.json');
    const settingsBeforeMigration = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const recordsBeforeMigration = await Promise.all([day, previous].map(value => fs.readFile(recordPath(value), 'utf8')));
    await request('commit', { changes: [{ key: model.TARGET_KEY, value: null }, { key: legacyKey, value: '38.5' }, { key: olderLegacyKey, value: '32' }], expected: [] });
    const oldState = await request('state');
    const migrationPlan = model.planTargetMigration(oldState.data.entries);
    const targetMigration = await request('commit', migrationPlan);
    assert.equal(targetMigration.status, 200); assert.equal(targetMigration.data.conflict, false);
    assert.equal(model.readTarget(model.createFileStorage(targetMigration.data.entries)), 38.5);
    await missingLegacy();
    const settingsAfterMigration = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.deepEqual(settingsAfterMigration, { ...settingsBeforeMigration, weeklyTarget: 38.5 });
    assert.deepEqual(await Promise.all([day, previous].map(value => fs.readFile(recordPath(value), 'utf8'))), recordsBeforeMigration);
    console.log('PASS: actual legacy targets migrate to the latest shared value and remove the empty directory while preserving other settings');

    await request('commit', { changes: [{ key: legacyKey, value: '42' }], expected: [] });
    const sharedBytes = await fs.readFile(settingsPath, 'utf8');
    const leftoverState = await request('state');
    const cleanupPlan = model.planTargetMigration(leftoverState.data.entries);
    assert.ok(cleanupPlan);
    assert.equal(cleanupPlan.changes.some(change => change.key === model.TARGET_KEY), false);
    const cleaned = await request('commit', cleanupPlan);
    assert.equal(cleaned.status, 200); assert.equal(cleaned.data.conflict, false);
    assert.equal(model.readTarget(model.createFileStorage(cleaned.data.entries)), 38.5);
    assert.equal(await fs.readFile(settingsPath, 'utf8'), sharedBytes);
    await missingLegacy();
    console.log('PASS: an existing shared target survives cleanup of residual valid legacy targets without rewriting settings');

    for (const sharedRaw of [null, 'null', '38.5']) {
      await request('commit', { changes: [{ key: model.TARGET_KEY, value: sharedRaw }, { key: legacyKey, value: '42' }], expected: [] });
      const stale = await request('state');
      const stalePlan = model.planTargetMigration(stale.data.entries);
      assert.ok(stalePlan);
      assert.equal(stalePlan.expected.find(entry => entry.key === model.TARGET_KEY).value, sharedRaw);
      const otherClient = model.createFileStorage(stale.data.entries, true);
      otherClient.setItem(model.TARGET_KEY, '45');
      const saved = await request('commit', otherClient.patch());
      assert.equal(saved.status, 200); assert.equal(saved.data.conflict, false);
      const beforeConflict = await fs.readFile(settingsPath, 'utf8');
      const staleResult = await request('commit', stalePlan);
      assert.equal(staleResult.status, 200); assert.equal(staleResult.data.conflict, true);
      assert.equal(model.readTarget(model.createFileStorage(staleResult.data.entries)), 45);
      assert.equal(await fs.readFile(settingsPath, 'utf8'), beforeConflict);
      assert.equal(await fs.readFile(path.join(legacyDirectory, '2026-11-02.json'), 'utf8'), '42\n');
      const retryPlan = model.planTargetMigration(staleResult.data.entries);
      const retried = await request('commit', retryPlan);
      assert.equal(retried.data.conflict, false);
      assert.equal(model.readTarget(model.createFileStorage(retried.data.entries)), 45);
      await missingLegacy();
    }
    console.log('PASS: stale migration plans conflict after another client saves a shared target for absent, literal null and existing shared values');

    await request('commit', { changes: [{ key: legacyKey, value: '42' }, { key: olderLegacyKey, value: '{broken target' }], expected: [] });
    await fs.writeFile(path.join(legacyDirectory, 'notes.txt'), 'unknown file');
    const damagedTargets = await request('state');
    const safeCleanup = await request('commit', model.planTargetMigration(damagedTargets.data.entries));
    assert.equal(safeCleanup.data.conflict, false);
    assert.equal(model.readTarget(model.createFileStorage(safeCleanup.data.entries)), 45);
    await assert.rejects(fs.stat(path.join(legacyDirectory, '2026-11-02.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(legacyDirectory, '2026-10-26.json'), 'utf8'), '{broken target');
    assert.equal(await fs.readFile(path.join(legacyDirectory, 'notes.txt'), 'utf8'), 'unknown file');
    console.log('PASS: migration deletes only valid legacy targets and retains damaged targets and unknown files');

    const tabA = model.createFileStorage(presetSave.data.entries, true);
    const tabB = model.createFileStorage(presetSave.data.entries, true);
    model.updateDay(tabA, day, 'morning', 'end', '12:30');
    model.updateDay(tabB, day, 'afternoon', 'end', '17:30');
    const savedA = await request('commit', tabA.patch());
    assert.equal(savedA.status, 200); assert.equal(savedA.data.conflict, false);
    const conflict = await request('commit', tabB.patch());
    assert.equal(conflict.status, 200); assert.equal(conflict.data.conflict, true);
    const retry = model.createFileStorage(conflict.data.entries, true);
    model.updateDay(retry, day, 'afternoon', 'end', '17:30');
    const savedB = await request('commit', retry.patch());
    assert.equal(savedB.status, 200); assert.equal(savedB.data.conflict, false);
    const merged = model.loadDay(model.createFileStorage(savedB.data.entries), day);
    assert.equal(merged.morning.end, '12:30'); assert.equal(merged.afternoon.end, '17:30');
    assert.equal((await fs.readFile(recordPath(previous), 'utf8')), historyBytes);
    console.log('PASS: two stale client snapshots detect conflict and preserve both fields after retry');

    const external = JSON.parse(await fs.readFile(recordPath(day), 'utf8'));
    external.periods.evening = { start: '19:00', end: '21:00' };
    await fs.writeFile(recordPath(day), JSON.stringify(external, null, 2), 'utf8');
    const refreshed = await request('state');
    assert.equal(model.loadDay(model.createFileStorage(refreshed.data.entries), day).evening.end, '21:00');
    await fs.writeFile(recordPath(previous), '{broken-json', 'utf8');
    const damaged = await request('state');
    assert.equal(damaged.status, 200);
    const week = model.loadWeek(model.createFileStorage(damaged.data.entries), '2026-11-02');
    assert.ok(week.errors.includes(previous));
    assert.throws(() => model.updateDay(model.createFileStorage(damaged.data.entries, true), previous, 'morning', 'end', '12:30'));
    assert.equal(await fs.readFile(recordPath(previous), 'utf8'), '{broken-json');
    console.log('PASS: external edits reload and a damaged daily file stays protected without hiding good records');

    const directory = await request('open-folder', {});
    assert.equal(directory.status, 200); assert.equal(directory.data.ok, true);
    assert.deepEqual(opened, [folder]);
    const arbitrary = await request('open-folder', { path: path.dirname(folder) });
    assert.equal(arbitrary.status, 400); assert.equal(opened.length, 1);
    console.log('PASS: folder button route targets only the fixed storage directory (launcher mocked)');
    console.log('PASS: 10 model → HTTP → daily JSON integration checks');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
