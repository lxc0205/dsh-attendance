'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname);
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const beginMarker = '    // BEGIN ATTENDANCE MODEL';
const endMarker = '    // END ATTENDANCE MODEL';
const begin = source.indexOf(beginMarker);
const end = source.indexOf(endMarker);
assert.ok(begin >= 0 && end > begin, 'client.js must delimit the pure attendance model');
const helpers = source.slice(begin + beginMarker.length, end);
// No window, document, React or real localStorage is provided to this model.
const context = vm.createContext({});
vm.runInContext(`${helpers}\nthis.api = {
  PERIOD_IDS, DAY_PREFIX, TARGET_PREFIX, TARGET_KEY, PRESET_KEY, blankDay, periodStatus, daySummary,
  weekStart, addDays, weekDates, isDate, readPresets, writePresets, loadRecord, createDay, loadDay, updateDay, loadWeek,
  listWeeks, readTarget, writeTarget, planTargetMigration, createRecordLog, parseRecordLog, describeRecordLog, createFileStorage
};`, context, { filename: 'attendance-model.js', timeout: 1000 });
const api = context.api;
const {
  PERIOD_IDS, DAY_PREFIX, TARGET_PREFIX, TARGET_KEY, PRESET_KEY, blankDay, periodStatus, daySummary,
  weekStart, addDays, weekDates, isDate, readPresets, writePresets, loadRecord, createDay, loadDay, updateDay, loadWeek,
  listWeeks, readTarget, writeTarget, planTargetMigration, createRecordLog, parseRecordLog, describeRecordLog, createFileStorage,
} = api;
// Objects created in a vm have different prototypes; compare their JSON values.
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), expected, message);
const empty = () => ({
  morning: { start: '', end: '' },
  afternoon: { start: '', end: '' },
  evening: { start: '', end: '' },
});
const fullDay = () => ({
  morning: { start: '08:30', end: '12:00' },
  afternoon: { start: '13:30', end: '18:00' },
  evening: { start: '19:00', end: '21:15' },
});

// Implements the standard Storage API, including string coercion and key order.
class FakeStorage {
  constructor(entries = []) {
    this.entries = new Map(entries.map(([key, value]) => [String(key), String(value)]));
    this.calls = [];
    this.denied = new Set();
  }
  check(operation) {
    if (this.denied.has(operation)) throw new Error(`Storage denied: ${operation}`);
  }
  get length() {
    this.check('length');
    return this.entries.size;
  }
  key(index) {
    this.check('key');
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key) {
    this.check('getItem');
    key = String(key);
    this.calls.push(['getItem', key]);
    return this.entries.has(key) ? this.entries.get(key) : null;
  }
  setItem(key, value) {
    this.check('setItem');
    key = String(key);
    value = String(value);
    this.calls.push(['setItem', key, value]);
    this.entries.set(key, value);
  }
  removeItem(key) {
    this.check('removeItem');
    this.entries.delete(String(key));
  }
  clear() {
    this.check('clear');
    this.entries.clear();
  }
}
const dayKey = date => DAY_PREFIX + date;
const targetKey = monday => TARGET_PREFIX + monday;
const encodeDay = day => JSON.stringify({ version: 2, periods: day });
const putDay = (storage, date, day) => storage.setItem(dayKey(date), encodeDay(day));
let passed = 0;
function test(name, check) {
  try {
    check();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function calendarTests() {
  test('strict Gregorian calendar dates and leap years', () => {
    for (const date of ['2024-02-29', '2000-02-29', '2025-12-31', '2026-01-01']) {
      assert.equal(isDate(date), true, date);
    }
    for (const date of ['', '2025-02-29', '1900-02-29', '2024-02-30', '2024-04-31',
      '2024-00-01', '2024-13-01', '2024-01-00', '2024-01-32', '2024-2-01',
      '2024-02-1', ' 2024-02-01', '2024-02-01 ', '2024-02-01T00:00:00Z']) {
      assert.equal(isDate(date), false, date);
    }
  });
  test('Monday and Sunday map to the same cross-year week', () => {
    assert.equal(weekStart('2024-12-30'), '2024-12-30');
    assert.equal(weekStart('2025-01-01'), '2024-12-30');
    assert.equal(weekStart('2025-01-05'), '2024-12-30');
    assert.equal(weekStart('2025-01-06'), '2025-01-06');
    assert.equal(weekStart('2023-01-01'), '2022-12-26');
    same(weekDates('2024-12-30'), [
      '2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02',
      '2025-01-03', '2025-01-04', '2025-01-05',
    ]);
  });
  test('day arithmetic crosses leap day, year end and DST boundaries', () => {
    for (const [date, offset, expected] of [
      ['2024-02-28', 1, '2024-02-29'], ['2024-02-28', 2, '2024-03-01'],
      ['2024-03-01', -1, '2024-02-29'], ['2025-02-28', 1, '2025-03-01'],
      ['2024-12-31', 1, '2025-01-01'], ['2025-01-01', -1, '2024-12-31'],
      ['2025-03-09', 1, '2025-03-10'], ['2025-11-02', 1, '2025-11-03'],
      ['2025-01-01', 0, '2025-01-01'],
    ]) assert.equal(addDays(date, offset), expected, `${date} + ${offset}`);
    same(weekDates('2024-02-26'), [
      '2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29',
      '2024-03-01', '2024-03-02', '2024-03-03',
    ]);
  });
}

calendarTests();
if (!process.argv.includes('--calendar-only')) {
  test('public constants and independent blank day objects', () => {
    same(PERIOD_IDS, ['morning', 'afternoon', 'evening']);
    assert.equal(DAY_PREFIX, 'dsh-attendance.v2.day.');
    assert.equal(TARGET_PREFIX, 'dsh-attendance.v2.target.');
    same(blankDay(), empty());
    const day = blankDay();
    day.morning.start = '09:00';
    assert.equal(day.afternoon.start, '');
    same(blankDay(), empty());
  });
  test('three periods and six time fields sum to 615 minutes', () => {
    same(periodStatus({ start: '08:30', end: '12:00' }), { duration: 210, error: null });
    same(periodStatus({ start: '13:30', end: '18:00' }), { duration: 270, error: null });
    same(periodStatus({ start: '19:00', end: '21:15' }), { duration: 135, error: null });
    same(periodStatus({ start: '00:00', end: '23:59' }), { duration: 1439, error: null });
    same(daySummary(fullDay()), {
      total: 615, hasEntries: true, incomplete: false,
      statuses: {
        morning: { duration: 210, error: null },
        afternoon: { duration: 270, error: null },
        evening: { duration: 135, error: null },
      },
    });
    const summary = daySummary(empty());
    assert.equal(summary.total, 0);
    assert.equal(summary.hasEntries, false);
    assert.equal(summary.incomplete, false);
    for (const id of PERIOD_IDS) same(summary.statuses[id], { duration: null, error: null });
  });
  test('empty, partial, malformed, equal and overnight periods', () => {
    same(periodStatus({ start: '', end: '' }), { duration: null, error: null });
    for (const period of [{ start: '08:30', end: '' }, { start: '', end: '12:00' }]) {
      same(periodStatus(period), { duration: null, error: 'incomplete' });
    }
    for (const invalid of ['25:00', '24:00', '12:60', '8:30', '08:3', '09:00 ', '09:00\n', '09:00\r\n', 'abc']) {
      same(periodStatus({ start: invalid, end: '18:00' }), { duration: null, error: 'invalidTime' });
      same(periodStatus({ start: '08:00', end: invalid }), { duration: null, error: 'invalidTime' });
    }
    for (const period of [{ start: '08:30', end: '08:30' }, { start: '23:00', end: '01:00' }]) {
      same(periodStatus(period), { duration: null, error: 'endBeforeStart' });
    }
  });
  test('partial, invalid and overnight periods never contribute to totals', () => {
    for (const [period, error] of [
      [{ start: '08:00', end: '' }, 'incomplete'],
      [{ start: '25:00', end: '26:00' }, 'invalidTime'],
      [{ start: '23:00', end: '01:00' }, 'endBeforeStart'],
    ]) {
      const day = empty();
      day.morning = period;
      day.afternoon = { start: '13:00', end: '14:15' };
      const summary = daySummary(day);
      assert.equal(summary.total, 75);
      assert.equal(summary.hasEntries, true);
      assert.equal(summary.incomplete, true);
      same(summary.statuses.morning, { duration: null, error });
    }
  });
  test('overlapping periods are excluded while an independent period still counts', () => {
    const day = {
      morning: { start: '09:00', end: '12:00' },
      afternoon: { start: '11:00', end: '14:00' },
      evening: { start: '19:00', end: '20:30' },
    };
    const summary = daySummary(day);
    assert.equal(summary.total, 90);
    assert.equal(summary.hasEntries, true);
    assert.equal(summary.incomplete, true);
    for (const id of ['morning', 'afternoon']) {
      same(summary.statuses[id], { duration: null, error: 'overlap' });
    }
    same(summary.statuses.evening, { duration: 90, error: null });
    assert.equal(periodStatus(day.morning).duration, 180);
    day.evening = { start: '13:00', end: '15:00' };
    const chain = daySummary(day);
    assert.equal(chain.total, 0);
    for (const id of PERIOD_IDS) same(chain.statuses[id], { duration: null, error: 'overlap' });
  });
  test('adjacent periods sharing an endpoint remain valid and sum normally', () => {
    const summary = daySummary({
      morning: { start: '09:00', end: '12:00' },
      afternoon: { start: '12:00', end: '14:00' },
      evening: { start: '14:00', end: '15:00' },
    });
    assert.equal(summary.total, 360);
    assert.equal(summary.incomplete, false);
    same(summary.statuses, {
      morning: { duration: 180, error: null },
      afternoon: { duration: 120, error: null },
      evening: { duration: 60, error: null },
    });
  });
  test('six preset fields independently support empty and fixed values', () => {
    assert.equal(PRESET_KEY, 'dsh-attendance.presets.v1');
    const storage = new FakeStorage();
    same(readPresets(storage), empty());
    assert.equal(storage.length, 0);
    for (const id of PERIOD_IDS) {
      for (const field of ['start', 'end']) {
        const presets = empty();
        presets[id][field] = fullDay()[id][field];
        writePresets(storage, presets);
        same(readPresets(storage), presets);
        same(JSON.parse(storage.getItem(PRESET_KEY)), { version: 1, periods: presets });
        const date = '2025-01-01';
        storage.removeItem(dayKey(date));
        const record = createDay(storage, date);
        same(record, { periods: presets, presets });
        const original = storage.getItem(dayKey(date));
        for (const value of ['', presets[id][field], '10:00']) {
          assert.throws(() => updateDay(storage, date, id, field, value), /locked/);
          assert.equal(storage.getItem(dayKey(date)), original);
        }
        for (const otherId of PERIOD_IDS) {
          for (const otherField of ['start', 'end']) {
            if (id === otherId && field === otherField) continue;
            updateDay(storage, date, otherId, otherField, fullDay()[otherId][otherField]);
          }
        }
        assert.equal(daySummary(loadDay(storage, date)).total, 615);
        record.periods[id][field] = '';
        assert.equal(record.presets[id][field], presets[id][field], 'snapshot and periods are independent copies');
        assert.equal(loadDay(storage, date)[id][field], presets[id][field]);
      }
    }
  });
  test('preset validation rejects invalid formats, reversed intervals and overlaps before writing', () => {
    const storage = new FakeStorage();
    writePresets(storage, fullDay());
    const original = storage.getItem(PRESET_KEY);
    const invalid = [null, {}, { ...empty(), morning: { start: '8:30', end: '' } },
      { ...empty(), morning: { start: '', end: '24:00' } },
      { ...empty(), morning: { start: '12:00', end: '12:00' } },
      { ...empty(), morning: { start: '23:00', end: '01:00' } },
      { ...fullDay(), afternoon: { start: '11:00', end: '14:00' } }];
    for (const presets of invalid) {
      storage.calls.length = 0;
      assert.throws(() => writePresets(storage, presets));
      assert.equal(storage.getItem(PRESET_KEY), original);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    }
    const partial = { ...empty(), morning: { start: '23:00', end: '' }, afternoon: { start: '', end: '01:00' } };
    writePresets(storage, partial);
    same(readPresets(storage), partial);
    const adjacent = { ...empty(), morning: { start: '09:00', end: '12:00' }, afternoon: { start: '12:00', end: '14:00' } };
    writePresets(storage, adjacent);
    same(readPresets(storage), adjacent);
  });
  test('complete presets can directly record the selected day without a confirmation step', () => {
    const storage = new FakeStorage(), date = '2025-01-02';
    putDay(storage, '2025-01-01', fullDay());
    const previous = storage.getItem(dayKey('2025-01-01'));
    writePresets(storage, fullDay(), date, true);
    same(loadRecord(storage, date), { periods: fullDay(), presets: fullDay() });
    assert.equal(daySummary(loadDay(storage, date)).total, 615);
    assert.equal(storage.getItem(dayKey('2025-01-01')), previous);
    assert.equal(storage.getItem(dayKey('2025-01-03')), null);
  });
  test('partial presets wait for a manual entry, which creates and counts the day directly', () => {
    const storage = new FakeStorage(), date = '2025-01-02';
    const presets = { ...empty(), morning: { start: '09:00', end: '' } };
    writePresets(storage, presets, date, true);
    assert.equal(loadRecord(storage, date), null);
    updateDay(storage, date, 'morning', 'end', '12:00', presets);
    assert.equal(daySummary(loadDay(storage, date)).total, 180);
    assert.equal(loadRecord(storage, date).presets.morning.start, '09:00');
  });
  test('failed automatic recording restores presets and does not leave a partial day', () => {
    const storage = new FakeStorage(), date = '2025-01-02';
    writePresets(storage, empty());
    const previous = storage.getItem(PRESET_KEY), set = storage.setItem;
    storage.setItem = function (key, value) {
      if (key === dayKey(date)) throw new Error('Day storage denied');
      return set.call(this, key, value);
    };
    assert.throws(() => writePresets(storage, fullDay(), date, true), /Day storage denied/);
    assert.equal(storage.getItem(PRESET_KEY), previous);
    assert.equal(storage.getItem(dayKey(date)), null);
  });
  test('saving presets without a date only changes global defaults', () => {
    const storage = new FakeStorage();
    writePresets(storage, fullDay());
    createDay(storage, '2025-01-01');
    putDay(storage, '2025-01-02', fullDay());
    const records = [...storage.entries].filter(([key]) => key.startsWith(DAY_PREFIX));
    storage.calls.length = 0;
    writePresets(storage, empty());
    same(readPresets(storage), empty());
    same([...storage.entries].filter(([key]) => key.startsWith(DAY_PREFIX)), records);
    same(storage.calls.filter(([operation]) => operation === 'setItem').map(call => call[1]), [PRESET_KEY]);
  });
  test('dated preset saves replace nonempty fields and upgrade an existing v2 day to v3', () => {
    const date = '2025-01-01';
    const storage = new FakeStorage();
    putDay(storage, date, fullDay());
    const presets = {
      morning: { start: '09:00', end: '' },
      afternoon: { start: '', end: '17:30' },
      evening: { start: '19:30', end: '' },
    };
    const periods = {
      morning: { start: '09:00', end: '12:00' },
      afternoon: { start: '13:30', end: '17:30' },
      evening: { start: '19:30', end: '21:15' },
    };
    storage.calls.length = 0;
    writePresets(storage, presets, date);
    same(JSON.parse(storage.getItem(dayKey(date))), { version: 3, periods, presets });
    same(readPresets(storage), presets);
    same(storage.calls.filter(([operation]) => operation === 'setItem').map(call => call[1]),
      [PRESET_KEY, dayKey(date)], 'global defaults must be saved before the day');
    for (const [id, field] of [['morning', 'start'], ['afternoon', 'end'], ['evening', 'start']]) {
      assert.throws(() => updateDay(storage, date, id, field, ''), /locked/);
    }
    updateDay(storage, date, 'morning', 'end', '12:15');
    assert.equal(loadDay(storage, date).morning.end, '12:15');
  });
  test('dated v3 preset saves refresh locks while preserving old preset and manually entered times', () => {
    const date = '2025-01-01';
    const storage = new FakeStorage();
    const previous = { ...empty(), morning: { start: '08:30', end: '' } };
    writePresets(storage, previous);
    createDay(storage, date);
    updateDay(storage, date, 'morning', 'end', '12:10');
    updateDay(storage, date, 'afternoon', 'start', '13:45');
    const presets = { ...empty(), afternoon: { start: '', end: '18:00' } };
    writePresets(storage, presets, date);
    const periods = {
      ...empty(), morning: { start: '08:30', end: '12:10' },
      afternoon: { start: '13:45', end: '18:00' },
    };
    same(JSON.parse(storage.getItem(dayKey(date))), { version: 3, periods, presets });
    assert.throws(() => updateDay(storage, date, 'afternoon', 'end', ''), /locked/);
    updateDay(storage, date, 'morning', 'start', '09:00');
    updateDay(storage, date, 'morning', 'end', '12:20');
    assert.equal(loadDay(storage, date).morning.start, '09:00', 'cleared preset releases its old lock');
    writePresets(storage, empty(), date);
    same(loadRecord(storage, date).presets, empty());
    assert.equal(loadDay(storage, date).afternoon.end, '18:00', 'clearing a preset retains its saved time');
    updateDay(storage, date, 'afternoon', 'end', '17:45');
    assert.equal(loadDay(storage, date).afternoon.end, '17:45');
  });
  test('dated preset saves only touch the selected existing day and never create a missing day', () => {
    const date = '2025-01-01';
    const storage = new FakeStorage();
    putDay(storage, '2024-12-31', fullDay());
    createDay(storage, '2025-01-02');
    storage.setItem('unrelated.setting', 'keep');
    const untouched = [...storage.entries];
    storage.calls.length = 0;
    writePresets(storage, fullDay(), date);
    assert.equal(storage.getItem(dayKey(date)), null);
    for (const [key, value] of untouched) assert.equal(storage.getItem(key), value);
    same(storage.calls.filter(([operation]) => operation === 'setItem').map(call => call[1]), [PRESET_KEY]);
    putDay(storage, date, empty());
    writePresets(storage, { ...empty(), morning: { start: '09:00', end: '' } }, date);
    for (const [key, value] of untouched) assert.equal(storage.getItem(key), value);
  });
  test('dated saves reject invalid presets and dates before changing either record', () => {
    const date = '2025-01-01';
    const storage = new FakeStorage();
    writePresets(storage, fullDay());
    putDay(storage, date, fullDay());
    const before = [...storage.entries];
    const invalidPresets = [null, {},
      { ...empty(), morning: { start: '8:30', end: '' } },
      { ...empty(), morning: { start: '', end: '24:00' } },
      { ...empty(), morning: { start: '12:00', end: '12:00' } },
      { ...empty(), morning: { start: '23:00', end: '01:00' } },
      { ...fullDay(), afternoon: { start: '11:00', end: '14:00' } }];
    const attempts = invalidPresets.map(presets => [presets, date]);
    for (const invalidDate of ['', null, 20250101, '2025-02-29', '2025-1-01', '2025-01-01\n']) {
      attempts.push([empty(), invalidDate]);
    }
    for (const args of attempts) {
      storage.calls.length = 0;
      assert.throws(() => writePresets(storage, ...args));
      same([...storage.entries], before);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    }
  });
  test('dated saves reject a corrupt current day before writing global defaults', () => {
    const date = '2025-01-01';
    const storage = new FakeStorage();
    writePresets(storage, fullDay());
    const malformed = ['{broken', 'null', '{}', encodeDay({ morning: {} }),
      encodeDay({ ...empty(), morning: { start: 'bad', end: '' } }),
      JSON.stringify({ version: 3, periods: fullDay() }),
      JSON.stringify({ version: 3, periods: empty(), presets: fullDay() }),
      JSON.stringify({ version: 3, periods: fullDay(), presets: {} })];
    for (const raw of malformed) {
      storage.setItem(dayKey(date), raw);
      const before = [...storage.entries];
      storage.calls.length = 0;
      assert.throws(() => writePresets(storage, empty(), date));
      same([...storage.entries], before);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    }
  });
  test('failed dated day writes roll back the exact previous global value and preserve the day', () => {
    const date = '2025-01-01';
    class DayWriteFailureStorage extends FakeStorage {
      setItem(key, value) {
        if (key === dayKey(date)) {
          this.calls.push(['setItem', String(key), String(value)]);
          throw new Error('Day write denied');
        }
        super.setItem(key, value);
      }
    }
    const original = ' { "version": 1, "periods": ' + JSON.stringify(fullDay()) + ' } ';
    for (const day of [encodeDay(fullDay()), JSON.stringify({ version: 3, periods: fullDay(), presets: fullDay() })]) {
      const storage = new DayWriteFailureStorage([[PRESET_KEY, original], [dayKey(date), day]]);
      const before = [...storage.entries];
      assert.throws(() => writePresets(storage, empty(), date), /Day write denied/);
      same([...storage.entries], before);
      same(storage.calls.filter(([operation]) => operation === 'setItem').map(call => call[1]),
        [PRESET_KEY, dayKey(date), PRESET_KEY]);
      assert.equal(storage.getItem(PRESET_KEY), original, 'rollback preserves the original serialization');
    }
  });
  test('failed dated day writes remove a previously absent global key to restore legacy fallback', () => {
    const date = '2025-01-01';
    const legacyKey = 'dsh-attendance.periods.v1';
    const legacy = JSON.stringify({ version: 1, periods: fullDay() });
    class DayWriteFailureStorage extends FakeStorage {
      setItem(key, value) {
        if (key === dayKey(date)) {
          this.calls.push(['setItem', String(key), String(value)]);
          throw new Error('Day write denied');
        }
        super.setItem(key, value);
      }
      removeItem(key) {
        this.calls.push(['removeItem', String(key)]);
        super.removeItem(key);
      }
    }
    for (const entries of [[], [[legacyKey, legacy]]]) {
      const storage = new DayWriteFailureStorage([...entries, [dayKey(date), encodeDay(fullDay())]]);
      const before = [...storage.entries];
      assert.throws(() => writePresets(storage, empty(), date), /Day write denied/);
      same([...storage.entries], before);
      assert.equal(storage.getItem(PRESET_KEY), null);
      same(readPresets(storage), entries.length ? fullDay() : empty());
      same(storage.calls.filter(([operation]) => operation === 'setItem' || operation === 'removeItem')
        .map(call => call.slice(0, 2)),
      [['setItem', PRESET_KEY], ['setItem', dayKey(date)], ['removeItem', PRESET_KEY]]);
    }
  });
  test('a rejected global write aborts a dated save without attempting the day write', () => {
    const date = '2025-01-01';
    class GlobalWriteFailureStorage extends FakeStorage {
      setItem(key, value) {
        if (key === PRESET_KEY) {
          this.calls.push(['setItem', String(key), String(value)]);
          throw new Error('Global write denied');
        }
        super.setItem(key, value);
      }
    }
    for (const entries of [[], [[PRESET_KEY, JSON.stringify({ version: 1, periods: fullDay() })]]]) {
      const storage = new GlobalWriteFailureStorage([...entries, [dayKey(date), encodeDay(fullDay())]]);
      const before = [...storage.entries];
      assert.throws(() => writePresets(storage, empty(), date), /Global write denied/);
      same([...storage.entries], before);
      same(storage.calls.filter(([operation]) => operation === 'setItem').map(call => call[1]), [PRESET_KEY]);
    }
  });
  test('failed day writes and failed global rollback report Preset partial save', () => {
    const date = '2025-01-01';
    class RollbackFailureStorage extends FakeStorage {
      setItem(key, value) {
        if (key === dayKey(date)) throw new Error('Day write denied');
        if (key === PRESET_KEY && this.savedGlobal) throw new Error('Global rollback denied');
        super.setItem(key, value);
        if (key === PRESET_KEY) this.savedGlobal = true;
      }
      removeItem(key) {
        if (key === PRESET_KEY) throw new Error('Global remove denied');
        super.removeItem(key);
      }
    }
    for (const entries of [[], [[PRESET_KEY, JSON.stringify({ version: 1, periods: fullDay() })]]]) {
      const originalDay = encodeDay(fullDay());
      const storage = new RollbackFailureStorage([...entries, [dayKey(date), originalDay]]);
      assert.throws(() => writePresets(storage, empty(), date), error => {
        assert.equal(error.name, 'Error');
        assert.equal(error.message, 'Preset partial save');
        return true;
      });
      assert.equal(storage.getItem(dayKey(date)), originalDay);
      same(readPresets(storage), empty(), 'failed rollback leaves the successfully written global value visible');
    }
  });
  test('explicit creation is idempotent and historical snapshots survive preset changes', () => {
    const storage = new FakeStorage();
    assert.equal(loadRecord(storage, '2025-01-01'), null);
    writePresets(storage, fullDay());
    createDay(storage, '2025-01-01');
    const original = storage.getItem(dayKey('2025-01-01'));
    const next = { ...empty(), morning: { start: '09:00', end: '' } };
    writePresets(storage, next);
    storage.calls.length = 0;
    same(createDay(storage, '2025-01-01'), { periods: fullDay(), presets: fullDay() });
    assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    assert.equal(storage.getItem(dayKey('2025-01-01')), original);
    same(createDay(storage, '2025-01-02'), { periods: next, presets: next });
    updateDay(storage, '2025-01-02', 'morning', 'end', '12:30');
    assert.equal(daySummary(loadDay(storage, '2025-01-02')).total, 210);
    writePresets(storage, empty());
    createDay(storage, '2025-02-03');
    same(listWeeks(storage), ['2025-02-03', '2024-12-30']);
    const week = loadWeek(storage, '2024-12-30');
    same(week.records['2025-01-01'], { periods: fullDay(), presets: fullDay() });
    assert.equal(week.records['2024-12-30'], null);
    assert.equal(week.records['2025-01-03'], null);
    same(loadDay(storage, '2025-01-01'), fullDay());
  });
  test('stale preset previews reject explicit and implicit creation without writes', () => {
    const storage = new FakeStorage();
    const preview = empty();
    const current = { ...empty(), morning: { start: '08:30', end: '' } };
    writePresets(storage, current);
    const before = [...storage.entries];
    storage.calls.length = 0;
    assert.throws(() => createDay(storage, '2025-01-01', preview), /Presets changed/);
    assert.throws(() => updateDay(storage, '2025-01-02', 'morning', 'end', '12:00', preview), /Presets changed/);
    same([...storage.entries], before);
    assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    assert.equal(loadRecord(storage, '2025-01-01'), null);
    assert.equal(loadRecord(storage, '2025-01-02'), null);
  });
  test('matching preset previews create correct independent snapshots with one write', () => {
    const storage = new FakeStorage();
    const preview = { ...empty(), morning: { start: '08:30', end: '' } };
    writePresets(storage, preview);
    storage.calls.length = 0;
    const record = createDay(storage, '2025-01-01', preview);
    same(record, { periods: preview, presets: preview });
    assert.equal(storage.calls.filter(([operation]) => operation === 'setItem').length, 1);
    storage.calls.length = 0;
    const periods = updateDay(storage, '2025-01-02', 'morning', 'end', '12:00', preview);
    same(periods, { ...empty(), morning: { start: '08:30', end: '12:00' } });
    same(loadRecord(storage, '2025-01-02'), { periods: plain(periods), presets: preview });
    assert.equal(storage.calls.filter(([operation]) => operation === 'setItem').length, 1);
    preview.morning.start = '10:00';
    assert.equal(record.periods.morning.start, '08:30');
    assert.equal(record.presets.morning.start, '08:30');
  });
  test('preview-based writes reject an existing v2 or v3 record without overwriting it', () => {
    const storage = new FakeStorage();
    const preview = empty();
    putDay(storage, '2025-01-01', fullDay());
    createDay(storage, '2025-01-02');
    for (const date of ['2025-01-01', '2025-01-02']) {
      const original = storage.getItem(dayKey(date));
      storage.calls.length = 0;
      assert.throws(() => createDay(storage, date, preview), /Record changed/);
      assert.throws(() => updateDay(storage, date, 'morning', 'start', '09:00', preview), /Record changed/);
      assert.equal(storage.getItem(dayKey(date)), original);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
      // Omitting the preview retains idempotent creation and normal existing-record updates.
      createDay(storage, date);
      assert.equal(storage.getItem(dayKey(date)), original);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
      updateDay(storage, date, 'morning', 'start', '09:00');
      assert.equal(loadDay(storage, date).morning.start, '09:00');
    }
    writePresets(storage, fullDay());
    same(createDay(storage, '2025-01-03'), { periods: fullDay(), presets: fullDay() });
    writePresets(storage, empty());
    same(updateDay(storage, '2025-01-04', 'morning', 'start', '09:00'), {
      ...empty(), morning: { start: '09:00', end: '' },
    });
  });
  test('v2 records have no locked fields and migrate only on update', () => {
    const storage = new FakeStorage();
    putDay(storage, '2025-01-01', fullDay());
    writePresets(storage, fullDay());
    const original = storage.getItem(dayKey('2025-01-01'));
    same(loadRecord(storage, '2025-01-01'), { periods: fullDay(), presets: empty() });
    createDay(storage, '2025-01-01');
    assert.equal(storage.getItem(dayKey('2025-01-01')), original);
    const changed = updateDay(storage, '2025-01-01', 'morning', 'start', '09:00');
    same(JSON.parse(storage.getItem(dayKey('2025-01-01'))), { version: 3, periods: plain(changed), presets: empty() });
  });
  test('automatic creation writes once and failures leave no extra snapshot record', () => {
    const storage = new FakeStorage();
    const presets = { ...empty(), morning: { start: '08:30', end: '' } };
    writePresets(storage, presets);
    storage.calls.length = 0;
    updateDay(storage, '2025-01-01', 'morning', 'end', '12:00');
    assert.equal(storage.calls.filter(([operation]) => operation === 'setItem').length, 1);
    same(loadRecord(storage, '2025-01-01'), {
      periods: { ...empty(), morning: { start: '08:30', end: '12:00' } }, presets,
    });
    storage.calls.length = 0;
    assert.throws(() => updateDay(storage, '2025-01-02', 'morning', 'start', '08:30'), /locked/);
    assert.equal(storage.getItem(dayKey('2025-01-02')), null);
    assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    storage.denied.add('setItem');
    assert.throws(() => updateDay(storage, '2025-01-03', 'morning', 'end', '12:00'));
    assert.throws(() => createDay(storage, '2025-01-04'));
    assert.equal(storage.getItem(dayKey('2025-01-03')), null);
    assert.equal(storage.getItem(dayKey('2025-01-04')), null);
  });
  test('corrupt presets block new records but allow updates of existing snapshots', () => {
    const storage = new FakeStorage();
    createDay(storage, '2025-01-01');
    putDay(storage, '2025-01-02', empty());
    for (const raw of ['{broken', 'null', '{}', JSON.stringify({ version: 2, periods: fullDay() }),
      JSON.stringify({ version: 1, periods: { ...empty(), morning: { start: 'bad', end: '' } } }),
      JSON.stringify({ version: 1, periods: { ...fullDay(), morning: { start: '12:00', end: '08:00' } } })]) {
      storage.setItem(PRESET_KEY, raw);
      storage.calls.length = 0;
      assert.throws(() => readPresets(storage));
      assert.throws(() => createDay(storage, '2025-01-03'));
      assert.throws(() => updateDay(storage, '2025-01-03', 'morning', 'end', '12:00'));
      assert.equal(storage.getItem(dayKey('2025-01-03')), null);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
      updateDay(storage, '2025-01-01', 'morning', 'start', '09:00');
      updateDay(storage, '2025-01-02', 'morning', 'start', '09:00');
      createDay(storage, '2025-01-01');
      assert.equal(storage.getItem(PRESET_KEY), raw);
    }
  });
  test('preset storage read failures only block creation, and write failures preserve defaults', () => {
    class PresetReadFailureStorage extends FakeStorage {
      getItem(key) {
        if (key === PRESET_KEY || key === 'dsh-attendance.periods.v1') throw new Error('Preset read denied');
        return super.getItem(key);
      }
    }
    const storage = new PresetReadFailureStorage();
    putDay(storage, '2025-01-01', empty());
    assert.throws(() => readPresets(storage), /Preset read denied/);
    assert.throws(() => createDay(storage, '2025-01-02'), /Preset read denied/);
    assert.throws(() => updateDay(storage, '2025-01-02', 'morning', 'start', '09:00'), /Preset read denied/);
    updateDay(storage, '2025-01-01', 'morning', 'start', '09:00');
    same(createDay(storage, '2025-01-01'), {
      periods: { ...empty(), morning: { start: '09:00', end: '' } }, presets: empty(),
    });
    assert.equal(storage.getItem(dayKey('2025-01-02')), null);
    const writable = new FakeStorage();
    writePresets(writable, fullDay());
    const original = writable.getItem(PRESET_KEY);
    writable.denied.add('setItem');
    assert.throws(() => writePresets(writable, empty()));
    assert.equal(writable.getItem(PRESET_KEY), original);
  });
  test('corrupt v3 snapshots and mismatches remain untouched and discoverable', () => {
    const storage = new FakeStorage();
    const malformed = [
      { version: 3, periods: fullDay() },
      { version: 3, periods: empty(), presets: fullDay() },
      { version: 3, periods: fullDay(), presets: {} },
      { version: 3, periods: { ...empty(), morning: { start: 'bad', end: '' } }, presets: empty() },
    ];
    for (const record of malformed) {
      const raw = JSON.stringify(record);
      storage.setItem(dayKey('2025-01-01'), raw);
      storage.calls.length = 0;
      assert.throws(() => loadRecord(storage, '2025-01-01'));
      assert.throws(() => createDay(storage, '2025-01-01'));
      assert.throws(() => updateDay(storage, '2025-01-01', 'morning', 'end', '12:00'));
      const week = loadWeek(storage, '2024-12-30');
      same(week.errors, ['2025-01-01']);
      assert.equal(week.records['2025-01-01'], null);
      same(listWeeks(storage), ['2024-12-30']);
      assert.equal(storage.getItem(dayKey('2025-01-01')), raw);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    }
  });
  test('legacy v1 defaults are read without migration writes or fabricated history', () => {
    const legacyKey = 'dsh-attendance.periods.v1';
    const raw = JSON.stringify({ version: 1, periods: fullDay() });
    const storage = new FakeStorage([[legacyKey, raw]]);
    same(readPresets(storage), fullDay());
    same(loadDay(storage, '2025-01-01'), empty());
    assert.equal(loadRecord(storage, '2025-01-01'), null);
    same(listWeeks(storage), []);
    assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    assert.equal(storage.length, 1);
    same(createDay(storage, '2025-01-01'), { periods: fullDay(), presets: fullDay() });
    assert.equal(storage.getItem(legacyKey), raw);
    assert.equal(storage.getItem(PRESET_KEY), null);
    writePresets(storage, empty());
    same(readPresets(storage), empty());
    storage.setItem(legacyKey, '{broken');
    same(readPresets(storage), empty(), 'explicit empty defaults take precedence over legacy values');
    storage.removeItem(PRESET_KEY);
    assert.throws(() => readPresets(storage));
  });
  test('missing days load independently without writing storage', () => {
    const storage = new FakeStorage();
    const first = loadDay(storage, '2025-01-01');
    same(first, empty());
    first.morning.start = '09:00';
    same(loadDay(storage, '2025-01-01'), empty());
    assert.equal(storage.length, 0);
    assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
  });
  test('loadDay accepts partial and reversed times but rejects malformed data', () => {
    const storage = new FakeStorage();
    for (const day of [empty(), fullDay(), {
      ...empty(), morning: { start: '09:00', end: '' },
      evening: { start: '23:00', end: '01:00' },
    }]) {
      putDay(storage, '2025-01-01', day);
      same(loadDay(storage, '2025-01-01'), day);
    }
    const malformed = ['{', 'null', '[]', '{}', '42',
      JSON.stringify({ version: 1, periods: fullDay() }),
      JSON.stringify({ version: 2 }), JSON.stringify(fullDay()),
      encodeDay({ morning: {} }),
      encodeDay({ ...empty(), afternoon: null }),
      encodeDay({ ...empty(), morning: { start: 900, end: '' } }),
      encodeDay({ ...empty(), morning: { start: '9:00', end: '' } }),
      encodeDay({ ...empty(), morning: { start: '', end: '24:00' } }),
      encodeDay({ ...empty(), morning: { start: '', end: '12:60' } }),
      encodeDay({ ...empty(), morning: { start: '09:00\n', end: '' } })];
    for (const raw of malformed) {
      storage.setItem(dayKey('2025-01-01'), raw);
      assert.throws(() => loadDay(storage, '2025-01-01'), undefined, raw);
      assert.equal(storage.getItem(dayKey('2025-01-01')), raw);
    }
  });
  test('saving one field preserves all other periods and historical dates', () => {
    const storage = new FakeStorage();
    putDay(storage, '2024-12-30', fullDay());
    putDay(storage, '2025-01-01', fullDay());
    storage.setItem('unrelated.setting', 'keep');
    const history = storage.getItem(dayKey('2024-12-30'));
    storage.calls.length = 0;
    const changed = updateDay(storage, '2025-01-01', 'morning', 'start', '09:00');
    const expected = fullDay();
    expected.morning.start = '09:00';
    same(changed, expected);
    same(loadDay(storage, '2025-01-01'), expected);
    assert.equal(storage.getItem(dayKey('2024-12-30')), history);
    assert.equal(storage.getItem('unrelated.setting'), 'keep');
    same(storage.calls.filter(([operation]) => operation === 'setItem').map(call => call[1]),
      [dayKey('2025-01-01')]);
    const partial = updateDay(storage, '2025-01-02', 'morning', 'start', '08:30');
    same(partial, { ...empty(), morning: { start: '08:30', end: '' } });
    same(loadDay(storage, '2025-01-02'), plain(partial));
    const reversed = updateDay(storage, '2025-01-02', 'morning', 'end', '07:00');
    assert.equal(reversed.morning.end, '07:00');
  });
  test('field merge rereads storage after another tab changes the day', () => {
    const storage = new FakeStorage();
    updateDay(storage, '2025-01-01', 'morning', 'start', '08:30');
    const staleTab = loadDay(storage, '2025-01-01');
    const otherTab = loadDay(storage, '2025-01-01');
    otherTab.afternoon = { start: '13:00', end: '17:00' };
    otherTab.morning.start = '09:00';
    putDay(storage, '2025-01-01', otherTab);
    const merged = updateDay(storage, '2025-01-01', 'morning', 'end', '12:00');
    assert.equal(staleTab.morning.start, '08:30');
    same(merged, {
      ...empty(), morning: { start: '09:00', end: '12:00' },
      afternoon: { start: '13:00', end: '17:00' },
    });
    updateDay(storage, '2025-01-01', 'morning', 'end', '');
    assert.equal(loadDay(storage, '2025-01-01').morning.end, '');
  });
  test('bad JSON and invalid field updates are never overwritten', () => {
    const storage = new FakeStorage();
    for (const raw of ['{broken', 'null', '{}']) {
      storage.setItem(dayKey('2025-01-01'), raw);
      storage.calls.length = 0;
      assert.throws(() => updateDay(storage, '2025-01-01', 'morning', 'start', '08:00'));
      assert.equal(storage.getItem(dayKey('2025-01-01')), raw);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    }
    putDay(storage, '2025-01-01', fullDay());
    const original = storage.getItem(dayKey('2025-01-01'));
    for (const args of [
      ['night', 'start', '08:00'], ['morning', 'unknown', '08:00'],
      ['morning', 'start', '24:00'], ['morning', 'start', '8:00'],
      ['morning', 'start', '09:00\n'],
      ['morning', 'start', null], ['morning', 'start', 800],
    ]) {
      assert.throws(() => updateDay(storage, '2025-01-01', ...args));
      assert.equal(storage.getItem(dayKey('2025-01-01')), original);
    }
  });
  test('loadWeek fills seven dates and isolates corrupted days', () => {
    const storage = new FakeStorage();
    putDay(storage, '2024-12-30', fullDay());
    storage.setItem(dayKey('2025-01-01'), '{broken');
    storage.setItem(dayKey('2025-01-02'), '{}');
    const week = loadWeek(storage, '2024-12-30');
    same(Object.keys(week.days).sort(), plain(weekDates('2024-12-30')).sort());
    same(week.errors, ['2025-01-01', '2025-01-02']);
    same(week.days['2024-12-30'], fullDay());
    for (const date of ['2024-12-31', '2025-01-01', '2025-01-02', '2025-01-05']) {
      same(week.days[date], empty());
    }
    week.days['2025-01-01'].morning.start = '10:00';
    assert.equal(week.days['2025-01-02'].morning.start, '');
    assert.equal(storage.getItem(dayKey('2025-01-01')), '{broken');
  });
  test('storage read and write refusal propagates without replacing data', () => {
    const storage = new FakeStorage();
    putDay(storage, '2025-01-01', fullDay());
    const original = storage.getItem(dayKey('2025-01-01'));
    storage.denied.add('getItem');
    assert.throws(() => loadDay(storage, '2025-01-01'));
    assert.throws(() => updateDay(storage, '2025-01-01', 'morning', 'start', '09:00'));
    const week = loadWeek(storage, '2024-12-30');
    same(week.errors, plain(weekDates('2024-12-30')));
    for (const day of Object.values(week.days)) same(day, empty());
    storage.denied.delete('getItem');
    storage.denied.add('setItem');
    assert.throws(() => updateDay(storage, '2025-01-01', 'morning', 'start', '09:00'));
    assert.throws(() => writeTarget(storage, 35));
    assert.equal(storage.getItem(dayKey('2025-01-01')), original);
    assert.equal(storage.getItem(TARGET_KEY), null);
  });
  test('weekly targets default to 40, persist fractional hours and are shared by all weeks', () => {
    const storage = new FakeStorage();
    assert.equal(readTarget(storage), 40);
    assert.equal(storage.length, 0);
    for (const hours of [0.25, 37.5, 40, 168]) {
      writeTarget(storage, hours);
      assert.equal(readTarget(storage), hours);
    }
    assert.equal(storage.length, 1, 'one shared target key, not one per week');
    assert.equal(storage.getItem(TARGET_KEY), '168');
    const original = storage.getItem(TARGET_KEY);
    for (const hours of [0, -1, 168.01, NaN, Infinity, -Infinity, '', '40', null, undefined]) {
      assert.throws(() => writeTarget(storage, hours));
      assert.equal(storage.getItem(TARGET_KEY), original);
    }
  });
  test('a per-week target is adopted once and consolidated into the shared target', () => {
    const storage = new FakeStorage();
    storage.setItem(TARGET_PREFIX + '2024-12-30', '32');
    storage.setItem(TARGET_PREFIX + '2025-01-06', '37.5');
    assert.equal(readTarget(storage), 37.5, 'the newest saved week wins');
    const entries = [...storage.entries].map(([key, value]) => ({ key, value }));
    const plan = planTargetMigration(entries);
    same(plan.changes, [
      { key: TARGET_KEY, value: '37.5' },
      { key: TARGET_PREFIX + '2025-01-06', value: null },
      { key: TARGET_PREFIX + '2024-12-30', value: null },
    ]);
    same(plan.expected, [
      { key: TARGET_KEY, value: null },
      { key: TARGET_PREFIX + '2025-01-06', value: '37.5' },
      { key: TARGET_PREFIX + '2024-12-30', value: '32' },
    ]);
    const stage = createFileStorage(entries, true);
    for (const change of plan.changes) { if (change.value === null) stage.removeItem(change.key); else stage.setItem(change.key, change.value); }
    assert.equal(readTarget(createFileStorage(plan.changes.reduce((all, change) => {
      const next = all.filter(entry => entry.key !== change.key);
      if (change.value !== null) next.push({ key: change.key, value: change.value });
      return next;
    }, entries))), 37.5);
    assert.equal(planTargetMigration([{ key: TARGET_KEY, value: '37.5' }]), null, 'a consolidated folder needs no migration');
    assert.equal(planTargetMigration([{ key: TARGET_PREFIX + '2024-12-30', value: '{broken' }]), null);
  });
  test('target migration guards a literal null shared value and preserves exact legacy raw values', () => {
    const entries = [{ key: TARGET_KEY, value: 'null' }, { key: targetKey('2025-01-06'), value: ' 37.5 ' }];
    const before = JSON.stringify(entries);
    const plan = planTargetMigration(entries);
    same(plan.expected, [{ key: TARGET_KEY, value: 'null' }, { key: targetKey('2025-01-06'), value: ' 37.5 ' }]);
    same(plan.changes, [{ key: TARGET_KEY, value: '37.5' }, { key: targetKey('2025-01-06'), value: null }]);
    assert.equal(JSON.stringify(entries), before);
  });
  test('existing shared target wins while migration removes only valid legacy targets', () => {
    const entries = [
      { key: TARGET_KEY, value: '36' },
      { key: targetKey('2025-01-06'), value: '37.5' },
      { key: targetKey('2024-12-30'), value: '{broken' },
      { key: targetKey('2025-01-13'), value: '169' },
      { key: TARGET_PREFIX + '2025-02-30', value: '40' },
    ];
    const plan = planTargetMigration(entries);
    same(plan.changes, [{ key: targetKey('2025-01-06'), value: null }]);
    same(plan.expected, [{ key: TARGET_KEY, value: '36' }, { key: targetKey('2025-01-06'), value: '37.5' }]);
    assert.equal(readTarget(createFileStorage(entries)), 36);
    assert.equal(planTargetMigration(entries.filter(entry => entry.key !== targetKey('2025-01-06'))), null);
    assert.equal(planTargetMigration([{ key: TARGET_KEY, value: '{broken' }, { key: targetKey('2025-01-06'), value: '40' }]), null);
  });
  test('history lists empty, nonempty and damaged records while ignoring invalid dates', () => {
    const storage = new FakeStorage();
    same(listWeeks(storage), []);
    putDay(storage, '2024-12-30', fullDay());
    putDay(storage, '2025-01-05', fullDay());
    putDay(storage, '2025-01-06', { ...empty(), evening: { start: '', end: '21:00' } });
    putDay(storage, '2024-02-29', fullDay());
    putDay(storage, '2025-02-03', empty());
    putDay(storage, '2025-01-14', { ...empty(), morning: { start: '23:00', end: '01:00' } });
    storage.setItem(dayKey('2025-03-03'), '{broken');
    storage.setItem(dayKey('2025-03-04'), '{}');
    storage.setItem(dayKey('2025-03-10'), JSON.stringify({ version: 1, periods: fullDay() }));
    storage.setItem(dayKey('2025-03-17'), encodeDay({ morning: {} }));
    storage.setItem(dayKey('2025-03-24'), encodeDay({
      ...empty(), morning: { start: '25:00', end: '' },
    }));
    storage.setItem(dayKey('2025-02-30'), encodeDay(fullDay()));
    storage.setItem(dayKey('2025-4-01'), encodeDay(fullDay()));
    storage.setItem('unrelated.setting', JSON.stringify(fullDay()));
    writeTarget(storage, 20);
    same(listWeeks(storage), [
      '2025-03-24', '2025-03-17', '2025-03-10', '2025-03-03',
      '2025-02-03', '2025-01-13', '2025-01-06', '2024-12-30', '2024-02-26',
    ]);
    // Empty records still identify an explicitly created day in history.
    putDay(storage, '2024-12-30', empty());
    putDay(storage, '2025-01-05', empty());
    same(listWeeks(storage), [
      '2025-03-24', '2025-03-17', '2025-03-10', '2025-03-03',
      '2025-02-03', '2025-01-13', '2025-01-06', '2024-12-30', '2024-02-26',
    ]);
    assert.equal(storage.getItem(dayKey('2025-03-03')), '{broken');
    const damagedWeek = loadWeek(storage, '2025-03-03');
    same(damagedWeek.errors, ['2025-03-03', '2025-03-04']);
  });
  test('corrupt targets and denied target reads are reported without writes', () => {
    const storage = new FakeStorage();
    for (const raw of ['{broken', '"40"', '0', '-1', '169', '1e999', '{}']) {
      storage.setItem(TARGET_KEY, raw);
      storage.calls.length = 0;
      assert.throws(() => readTarget(storage));
      assert.equal(storage.getItem(TARGET_KEY), raw);
      assert.equal(storage.calls.some(([operation]) => operation === 'setItem'), false);
    }
    storage.setItem(TARGET_KEY, 'null');
    assert.equal(readTarget(storage), 40, 'an emptied shared value falls back to the default');
    storage.removeItem(TARGET_KEY);
    storage.denied.add('getItem');
    assert.throws(() => readTarget(storage));
  });
  test('history enumeration refusal is visible to callers', () => {
    for (const operation of ['length', 'key']) {
      const storage = new FakeStorage();
      putDay(storage, '2025-01-01', fullDay());
      storage.denied.add(operation);
      assert.throws(() => listWeeks(storage));
    }
  });
  test('file snapshots expose Storage reads and refuse all writes by default', () => {
    const key = dayKey('2025-01-01'), raw = encodeDay(fullDay());
    const entries = [{ key, value: raw }];
    const snapshot = createFileStorage(entries);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot.key(0), key);
    assert.equal(snapshot.key(1), null);
    assert.equal(snapshot.getItem(key), raw);
    assert.equal(snapshot.getItem(PRESET_KEY), null);
    assert.throws(() => snapshot.setItem(key, 'changed'), /read.only/i);
    assert.throws(() => snapshot.setItem(PRESET_KEY, 'new'), /read.only/i);
    assert.throws(() => snapshot.removeItem(key), /read.only/i);
    assert.throws(() => snapshot.removeItem(PRESET_KEY), /read.only/i);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot.getItem(key), raw);
    same(snapshot.patch(), { changes: [], expected: [] });
    same(entries, [{ key, value: raw }]);
    same(createFileStorage().patch(), { changes: [], expected: [] });
  });
  test('writable file stages copy entries and keep independent snapshots unchanged', () => {
    const key = dayKey('2025-01-01'), raw = encodeDay(fullDay());
    const entries = Object.freeze([Object.freeze({ key, value: raw })]);
    const snapshot = createFileStorage(entries);
    const stage = createFileStorage(entries, true);
    stage.setItem(key, 'changed');
    stage.setItem(PRESET_KEY, 123);
    assert.equal(stage.getItem(key), 'changed');
    assert.equal(stage.getItem(PRESET_KEY), '123');
    assert.equal(stage.length, 2);
    assert.equal(stage.key(1), PRESET_KEY);
    assert.equal(snapshot.getItem(key), raw);
    assert.equal(snapshot.getItem(PRESET_KEY), null);
    same(entries, [{ key, value: raw }]);
    same(stage.patch(), {
      changes: [{ key, value: 'changed' }, { key: PRESET_KEY, value: '123' }],
      expected: [{ key, value: raw }, { key: PRESET_KEY, value: null }],
    });
  });
  test('file stage captures original values for read dependencies including missing keys', () => {
    const key = dayKey('2025-01-01'), raw = encodeDay(empty());
    const stage = createFileStorage([{ key, value: raw }], true);
    same(stage.patch(), { changes: [], expected: [] });
    assert.equal(stage.getItem(key), raw);
    assert.equal(stage.getItem(PRESET_KEY), null);
    assert.equal(stage.getItem(key), raw);
    assert.equal(stage.getItem(PRESET_KEY), null);
    same(stage.patch(), {
      changes: [], expected: [{ key, value: raw }, { key: PRESET_KEY, value: null }],
    });
  });
  test('repeated staged writes and removals retain the original compare-and-swap values', () => {
    const key = dayKey('2025-01-01');
    const stage = createFileStorage([{ key, value: 'original' }], true);
    stage.setItem(key, 'first');
    stage.setItem(key, 'second');
    stage.removeItem(key);
    assert.equal(stage.getItem(key), null);
    stage.setItem(key, 'last');
    stage.setItem(PRESET_KEY, 'new');
    stage.setItem(PRESET_KEY, 'newer');
    assert.equal(stage.getItem(PRESET_KEY), 'newer');
    const expected = [{ key, value: 'original' }, { key: PRESET_KEY, value: null }];
    same(stage.patch(), {
      changes: [{ key, value: 'last' }, { key: PRESET_KEY, value: 'newer' }], expected,
    });
    same(stage.patch(), {
      changes: [{ key, value: 'last' }, { key: PRESET_KEY, value: 'newer' }], expected,
    });
  });
  test('file stage emits no changes for identical writes or mutations restored to their base', () => {
    const key = dayKey('2025-01-01');
    const stage = createFileStorage([{ key, value: 'original' }], true);
    stage.setItem(key, 'original');
    same(stage.patch().changes, []);
    stage.setItem(key, 'temporary');
    stage.removeItem(key);
    stage.setItem(key, 'original');
    stage.setItem(PRESET_KEY, 'temporary');
    stage.removeItem(PRESET_KEY);
    stage.removeItem(targetKey('2024-12-30'));
    same(stage.patch(), {
      changes: [], expected: [{ key, value: 'original' }, { key: PRESET_KEY, value: null },
        { key: targetKey('2024-12-30'), value: null }],
    });
  });
  test('file stage represents deletion with null and preserves the literal string null', () => {
    const key = dayKey('2025-01-01');
    const entries = [{ key, value: 'null' }];
    const stage = createFileStorage(entries, true);
    assert.equal(stage.getItem(key), 'null');
    assert.equal(stage.getItem(PRESET_KEY), null);
    stage.removeItem(key);
    stage.setItem(PRESET_KEY, null);
    assert.equal(stage.getItem(key), null);
    assert.equal(stage.getItem(PRESET_KEY), 'null');
    same(stage.patch(), {
      changes: [{ key, value: null }, { key: PRESET_KEY, value: 'null' }],
      expected: [{ key, value: 'null' }, { key: PRESET_KEY, value: null }],
    });
    assert.equal(stage.length, 1);
    assert.equal(stage.key(0), PRESET_KEY);
    same(entries, [{ key, value: 'null' }]);
  });
  test('updateDay stages a v2 to v3 update without changing the input file entries', () => {
    const date = '2025-01-01', key = dayKey(date), raw = encodeDay(fullDay());
    const entries = [{ key, value: raw }];
    const stage = createFileStorage(entries, true);
    updateDay(stage, date, 'morning', 'start', '09:00');
    updateDay(stage, date, 'morning', 'end', '12:15');
    const periods = { ...fullDay(), morning: { start: '09:00', end: '12:15' } };
    same(stage.patch(), {
      changes: [{ key, value: JSON.stringify({ version: 3, periods, presets: empty() }) }],
      expected: [{ key, value: raw }],
    });
    same(loadRecord(stage, date), { periods, presets: empty() });
    same(entries, [{ key, value: raw }]);
    same(loadDay(createFileStorage(entries), date), fullDay());
  });
  test('writePresets stages related defaults and selected day as a single multi-key patch', () => {
    const date = '2025-01-01', key = dayKey(date);
    const dayRaw = encodeDay(fullDay());
    const presetRaw = JSON.stringify({ version: 1, periods: empty() });
    const historyKey = dayKey('2024-12-31'), historyRaw = encodeDay(empty());
    const entries = [{ key: PRESET_KEY, value: presetRaw }, { key, value: dayRaw },
      { key: historyKey, value: historyRaw }];
    const original = JSON.stringify(entries);
    const stage = createFileStorage(entries, true);
    const presets = { ...empty(), morning: { start: '09:00', end: '' } };
    writePresets(stage, presets, date);
    const periods = { ...fullDay(), morning: { start: '09:00', end: '12:00' } };
    const patch = stage.patch();
    same(patch.changes, [
      { key: PRESET_KEY, value: JSON.stringify({ version: 1, periods: presets }) },
      { key, value: JSON.stringify({ version: 3, periods, presets }) },
    ]);
    same(patch.expected.slice().sort((a, b) => a.key.localeCompare(b.key)),
      [{ key: PRESET_KEY, value: presetRaw }, { key, value: dayRaw }].sort((a, b) => a.key.localeCompare(b.key)));
    assert.equal(patch.changes.some(change => change.key === historyKey), false);
    assert.equal(JSON.stringify(entries), original);
    same(loadRecord(stage, date), { periods, presets });
    assert.throws(() => updateDay(stage, date, 'morning', 'start', ''), /locked/);
  });
  test('new-day file staging includes legacy fallback reads as concurrency dependencies', () => {
    const date = '2025-01-01', key = dayKey(date), legacyKey = 'dsh-attendance.periods.v1';
    const presets = { ...empty(), morning: { start: '08:30', end: '' } };
    const legacyRaw = JSON.stringify({ version: 1, periods: presets });
    const entries = [{ key: legacyKey, value: legacyRaw }];
    const stage = createFileStorage(entries, true);
    updateDay(stage, date, 'morning', 'end', '12:00', presets);
    const periods = { ...empty(), morning: { start: '08:30', end: '12:00' } };
    same(stage.patch(), {
      changes: [{ key, value: JSON.stringify({ version: 3, periods, presets }) }],
      expected: [{ key, value: null }, { key: PRESET_KEY, value: null }, { key: legacyKey, value: legacyRaw }],
    });
    same(entries, [{ key: legacyKey, value: legacyRaw }]);
    assert.equal(createFileStorage(entries).getItem(key), null);
  });
  // Record logs preserve serialized storage values; importing never repairs or migrates them.
  const logTimestamp = '2026-11-05T07:00:00.000Z';
  const legacyLogKey = 'dsh-attendance.periods.v1';
  const logEnvelope = (entries = []) => ({
    format: 'dsh-attendance-log', version: 1, timeZone: 'Asia/Shanghai',
    exportedAt: logTimestamp, entries,
  });
  const entry = (key, value) => ({ key, value });
  class ReadOnlyLogStorage extends FakeStorage {
    setItem(...args) {
      this.calls.push(['setItem', ...args]);
      throw new Error('Record logs must not write storage');
    }
    removeItem(...args) {
      this.calls.push(['removeItem', ...args]);
      throw new Error('Record logs must not remove storage');
    }
    clear(...args) {
      this.calls.push(['clear', ...args]);
      throw new Error('Record logs must not clear storage');
    }
  }
  const assertLogReadOnly = (storage, before) => {
    same([...storage.entries], before, 'record log operations preserve every stored byte');
    same(storage.calls.filter(([operation]) => ['setItem', 'removeItem', 'clear'].includes(operation)), []);
  };
  test('record log exports and parses v2, v3 snapshots, presets, targets and legacy defaults losslessly', () => {
    const snapshot = { ...empty(), morning: { start: '08:30', end: '' } };
    const fixed = { ...fullDay(), morning: { start: '08:30', end: '12:10' } };
    const entries = [
      [targetKey('2024-12-30'), ' 37.5 '],
      [PRESET_KEY, JSON.stringify({ version: 1, periods: fullDay() }, null, 2)],
      [dayKey('2025-01-02'), JSON.stringify({ version: 3, periods: fixed, presets: snapshot }, null, 2)],
      [legacyLogKey, JSON.stringify({ version: 1, periods: empty() })],
      [dayKey('2025-01-01'), ' ' + encodeDay(fullDay()) + '\n'],
    ];
    const storage = new ReadOnlyLogStorage(entries);
    const before = [...storage.entries];
    const expected = logEnvelope(entries.map(([key, value]) => entry(key, value))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const log = createRecordLog(storage, logTimestamp);
    same(log, expected);
    const parsed = parseRecordLog(JSON.stringify(log));
    same(parsed, expected);
    const restored = new ReadOnlyLogStorage(parsed.entries.map(({ key, value }) => [key, value]));
    same(createRecordLog(restored, logTimestamp), expected);
    same(loadRecord(restored, '2025-01-01'), { periods: fullDay(), presets: empty() });
    same(loadRecord(restored, '2025-01-02'), { periods: fixed, presets: snapshot });
    same(readPresets(restored), fullDay());
    assert.equal(readTarget(restored), 37.5);
    assertLogReadOnly(storage, before);
    assertLogReadOnly(restored, before.slice().sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  });
  test('record log export filters browser keys and invalid date suffixes before reading values', () => {
    const allowed = [
      [dayKey('2024-02-29'), encodeDay(empty())],
      [targetKey('2025-01-07'), '40'],
      [PRESET_KEY, '{broken preset'], [legacyLogKey, '{broken legacy'],
    ];
    const excluded = ['unrelated.setting', 'dsh-auth-token', 'dsh-attendance.unknown',
      DAY_PREFIX, TARGET_PREFIX, PRESET_KEY + '.extra', legacyLogKey + '.extra',
      dayKey('2025-02-29'), dayKey('2024-02-30'), dayKey('2025-1-01'),
      dayKey('2025-01-01.extra'), dayKey('2025-01-01\n'),
      targetKey('2025-02-29'), targetKey('2025-13-01'), targetKey('2025-01-01T00:00:00Z')];
    const storage = new ReadOnlyLogStorage([...excluded.map(key => [key, 'private']), ...allowed]);
    const before = [...storage.entries];
    const log = createRecordLog(storage, logTimestamp);
    same(log.entries, allowed.map(([key, value]) => entry(key, value))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    assert.equal(storage.calls.some(([operation, key]) => operation === 'getItem' && excluded.includes(key)), false);
    assertLogReadOnly(storage, before);
  });
  test('record log export creates a valid default timestamp and an empty envelope without writes', () => {
    const storage = new ReadOnlyLogStorage();
    const before = Date.now();
    const log = createRecordLog(storage);
    const after = Date.now();
    const timestamp = Date.parse(log.exportedAt);
    assert.equal(typeof log.exportedAt, 'string');
    assert.ok(Number.isFinite(timestamp) && timestamp >= before && timestamp <= after);
    same(log, { ...logEnvelope(), exportedAt: log.exportedAt });
    same(parseRecordLog(JSON.stringify(log)), plain(log));
    assertLogReadOnly(storage, []);
  });
  test('record log export preserves bad JSON and malformed stored values without parsing or writing', () => {
    const rawValues = ['{broken\n', 'null', '{}', '', 'not JSON', '\uFEFF{broken',
      JSON.stringify({ version: 99, periods: fullDay() })];
    const stored = rawValues.map((raw, index) => [dayKey(`2025-01-${String(index + 1).padStart(2, '0')}`), raw]);
    stored.push([PRESET_KEY, '{bad preset'], [legacyLogKey, '{bad legacy'], [targetKey('2024-12-30'), 'NaN']);
    const storage = new ReadOnlyLogStorage(stored);
    const before = [...storage.entries];
    const log = createRecordLog(storage, logTimestamp);
    same(parseRecordLog(JSON.stringify(log)), plain(log));
    for (const [key, raw] of stored) assert.equal(log.entries.find(item => item.key === key).value, raw);
    assertLogReadOnly(storage, before);
  });
  test('record log export propagates storage enumeration and allowed-key read failures', () => {
    for (const operation of ['length', 'key', 'getItem']) {
      const storage = new ReadOnlyLogStorage([[dayKey('2025-01-01'), encodeDay(fullDay())]]);
      const before = [...storage.entries];
      storage.denied.add(operation);
      assert.throws(() => createRecordLog(storage, logTimestamp), undefined, operation);
      assertLogReadOnly(storage, before);
    }
  });
  test('record log parser accepts a BOM and treats entry values as opaque strings', () => {
    const log = logEnvelope([
      entry(dayKey('2024-02-29'), '{broken'), entry(PRESET_KEY, ''),
      entry(legacyLogKey, 'null'), entry(targetKey('2025-01-07'), 'not JSON'),
    ]);
    const serialized = JSON.stringify(log);
    same(parseRecordLog('\uFEFF' + serialized), log);
    same(parseRecordLog(' \n' + serialized + '\n '), log);
    assert.equal(serialized, JSON.stringify(log), 'parsing leaves the supplied envelope unchanged');
  });
  test('record log parser rejects malformed wrappers, formats, versions and timezones', () => {
    for (const value of [null, [], true, 1, 'log', {},
      { ...logEnvelope(), format: 'unknown' }, { ...logEnvelope(), format: null },
      { ...logEnvelope(), version: 0 }, { ...logEnvelope(), version: 2 },
      { ...logEnvelope(), version: '1' },
      { ...logEnvelope(), timeZone: 'UTC' }, { ...logEnvelope(), timeZone: 'Asia/Shanghai ' }]) {
      assert.throws(() => parseRecordLog(JSON.stringify(value)), undefined, JSON.stringify(value));
    }
    for (const field of ['format', 'version', 'timeZone', 'exportedAt', 'entries']) {
      const log = logEnvelope();
      delete log[field];
      assert.throws(() => parseRecordLog(JSON.stringify(log)), undefined, `missing ${field}`);
    }
    for (const text of ['', '{broken', 'undefined', '{}{}', null, undefined, 123, logEnvelope()]) {
      assert.throws(() => parseRecordLog(text));
    }
  });
  test('record log parser and exporter reject invalid ISO export dates', () => {
    for (const exportedAt of ['', 'not-a-date', '2025-01-01', '2025-01-01T00:00:00',
      '2025-01-01T00:00:00.000Z\n', '2025-02-29T00:00:00.000Z',
      '2024-02-30T00:00:00.000Z', '2025-13-01T00:00:00.000Z',
      '2025-01-01T25:00:00.000Z', null, 0, {}, []]) {
      assert.throws(() => parseRecordLog(JSON.stringify({ ...logEnvelope(), exportedAt })),
        undefined, JSON.stringify(exportedAt));
      const storage = new ReadOnlyLogStorage();
      assert.throws(() => createRecordLog(storage, exportedAt), undefined, JSON.stringify(exportedAt));
      assertLogReadOnly(storage, []);
    }
    for (const exportedAt of ['2024-02-29T23:59:59.000Z', '2026-11-05T15:00:00+08:00']) {
      const log = { ...logEnvelope(), exportedAt };
      same(parseRecordLog(JSON.stringify(log)), log);
      same(createRecordLog(new ReadOnlyLogStorage(), exportedAt), log);
    }
  });
  test('record log parser rejects invalid entry arrays, missing fields and non-string values', () => {
    for (const entries of [null, {}, 'entries', 1, [null], [[]], ['entry'], [1],
      [{}], [{ key: PRESET_KEY }], [{ value: '{}' }],
      ...[null, 1, {}, []].map(key => [entry(key, '{}')]),
      ...[null, 1, true, {}, []].map(value => [entry(PRESET_KEY, value)])]) {
      assert.throws(() => parseRecordLog(JSON.stringify(logEnvelope(entries))), undefined, JSON.stringify(entries));
    }
  });
  test('record log parser rejects non-plugin keys and invalid calendar suffixes', () => {
    for (const key of ['', 'unrelated.setting', 'dsh-attendance.unknown',
      DAY_PREFIX, TARGET_PREFIX, PRESET_KEY + '.extra', legacyLogKey + '.extra',
      dayKey('2025-02-29'), dayKey('1900-02-29'), dayKey('2024-04-31'),
      dayKey('2025-1-01'), dayKey('2025-01-1'), dayKey('2025-01-01\n'),
      dayKey('2025-01-01.extra'), targetKey('2025-02-29'), targetKey('2025-00-01'),
      targetKey('2025-01-01 '), targetKey('2025-01-01T00:00:00Z')]) {
      assert.throws(() => parseRecordLog(JSON.stringify(logEnvelope([entry(key, '{}')]))), undefined, key);
    }
    for (const key of [dayKey('2000-02-29'), targetKey('2024-02-29'), PRESET_KEY, legacyLogKey]) {
      const log = logEnvelope([entry(key, '{broken')]);
      same(parseRecordLog(JSON.stringify(log)), log);
    }
  });
  test('record log parser rejects duplicate keys even when their values differ', () => {
    for (const key of [dayKey('2025-01-01'), targetKey('2024-12-30'), PRESET_KEY, legacyLogKey]) {
      for (const value of ['first', 'second']) {
        const log = logEnvelope([entry(key, 'first'), entry(key, value)]);
        assert.throws(() => parseRecordLog(JSON.stringify(log)), undefined, key);
      }
    }
  });
  test('record log parser enforces the 5 MiB character limit including envelope overhead', () => {
    const limit = 5 * 1024 * 1024;
    const base = JSON.stringify(logEnvelope([entry(PRESET_KEY, '')]));
    const atLimit = JSON.stringify(logEnvelope([entry(PRESET_KEY, '\u6c49'.repeat(limit - base.length))]));
    assert.equal(atLimit.length, limit);
    assert.equal(parseRecordLog(atLimit).entries[0].value.length, limit - base.length);
    assert.throws(() => parseRecordLog(atLimit + ' '));
    assert.throws(() => parseRecordLog(' '.repeat(limit + 1)));
  });
  test('record log description sorts days newest first and retains v2, fixed snapshots and empty days', () => {
    const fixed = { ...empty(), morning: { start: '08:30', end: '' } };
    const v3Raw = JSON.stringify({ version: 3, periods: fullDay(), presets: fixed });
    const v2Raw = encodeDay(fullDay());
    const emptyRaw = encodeDay(empty());
    const log = logEnvelope([
      entry(dayKey('2025-01-01'), v2Raw),
      entry(PRESET_KEY, '{broken defaults do not change history'),
      entry(dayKey('2025-01-03'), emptyRaw),
      entry(legacyLogKey, JSON.stringify({ version: 1, periods: fullDay() })),
      entry(targetKey('2025-02-03'), '40'),
      entry(dayKey('2025-01-02'), v3Raw),
    ]);
    const before = JSON.stringify(log);
    same(describeRecordLog(parseRecordLog(before)), {
      days: [
        { date: '2025-01-03', record: { periods: empty(), presets: empty() },
          totalMinutes: 0, incomplete: false, error: null, raw: emptyRaw },
        { date: '2025-01-02', record: { periods: fullDay(), presets: fixed },
          totalMinutes: 615, incomplete: false, error: null, raw: v3Raw },
        { date: '2025-01-01', record: { periods: fullDay(), presets: empty() },
          totalMinutes: 615, incomplete: false, error: null, raw: v2Raw },
      ], totalMinutes: 1230,
    });
    assert.equal(JSON.stringify(log), before);
    same(describeRecordLog(logEnvelope([entry(PRESET_KEY, '{bad'), entry(targetKey('2025-01-06'), '40')])),
      { days: [], totalMinutes: 0 });
    same(describeRecordLog(logEnvelope()), { days: [], totalMinutes: 0 });
  });
  test('record log description keeps bad day diagnostics and raw bytes while excluding their totals', () => {
    const malformed = ['{broken\n', 'null', '{}', '',
      JSON.stringify({ version: 99, periods: fullDay() }),
      JSON.stringify({ version: 2, periods: { morning: {} } }),
      JSON.stringify({ version: 3, periods: fullDay() }),
      JSON.stringify({ version: 3, periods: empty(), presets: fullDay() }),
      encodeDay({ ...empty(), morning: { start: '25:00', end: '26:00' } })];
    const entries = malformed.map((raw, index) => entry(dayKey(`2025-01-${String(index + 1).padStart(2, '0')}`), raw));
    entries.push(entry(dayKey('2025-01-10'), encodeDay(fullDay())));
    const log = parseRecordLog(JSON.stringify(logEnvelope(entries)));
    const before = JSON.stringify(log);
    const result = describeRecordLog(log);
    assert.equal(result.totalMinutes, 615);
    same(result.days.map(day => day.date), entries.map(item => item.key.slice(DAY_PREFIX.length)).reverse());
    assert.equal(result.days.length, malformed.length + 1);
    for (const [index, raw] of malformed.entries()) {
      const date = `2025-01-${String(index + 1).padStart(2, '0')}`;
      const row = result.days.find(day => day.date === date);
      assert.equal(row.error, 'invalidRecord');
      assert.equal(row.record, null);
      assert.equal(row.totalMinutes, 0);
      assert.equal(typeof row.incomplete, 'boolean');
      assert.equal(row.raw, raw);
    }
    assert.equal(JSON.stringify(log), before, 'description preserves all input entries');
  });
  test('record log description uses day validation for partial, reversed and overlapping periods', () => {
    const days = [
      { ...empty(), morning: { start: '09:00', end: '' }, afternoon: { start: '13:00', end: '14:15' } },
      { ...empty(), morning: { start: '23:00', end: '01:00' }, afternoon: { start: '13:00', end: '14:15' } },
      { morning: { start: '09:00', end: '12:00' }, afternoon: { start: '11:00', end: '14:00' },
        evening: { start: '19:00', end: '20:30' } },
    ];
    const log = logEnvelope(days.map((day, index) => entry(dayKey(`2025-01-0${index + 1}`), encodeDay(day))));
    const result = describeRecordLog(parseRecordLog(JSON.stringify(log)));
    assert.equal(result.totalMinutes, 240);
    same(result.days.map(row => row.totalMinutes), [90, 75, 75]);
    for (const row of result.days) {
      assert.equal(row.error, null);
      assert.equal(row.incomplete, true);
      const original = days[Number(row.date.slice(-2)) - 1];
      same(row.record, { periods: original, presets: empty() });
      assert.equal(row.raw, encodeDay(original));
    }
  });
  test('Shanghai today crosses midnight using its explicit display timezone', () => {
    for (const [instant, expected] of [
      ['2024-12-31T15:59:59Z', '2024-12-31'],
      ['2024-12-31T16:00:00Z', '2025-01-01'],
      ['2024-02-28T16:00:00Z', '2024-02-29'],
      ['2025-03-09T16:00:00Z', '2025-03-10'],
    ]) {
      class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [instant])); }
        static now() { return new Date(instant).getTime(); }
      }
      const clockContext = vm.createContext({ Date: FixedDate });
      vm.runInContext(`${helpers}\nthis.today = todayInShanghai();`, clockContext,
        { filename: 'attendance-model-clock.js', timeout: 1000 });
      assert.equal(clockContext.today, expected, instant);
    }
  });
  test('package exports and both locale resources remain available', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-attendance');
    assert.ok(manifest.files.includes('file-store.js'), 'packed plugin must include its Host file store');
    assert.ok(fs.existsSync(path.join(root, 'file-store.js')));
    for (const target of Object.values(manifest.exports)) {
      if (!target.includes('*')) assert.ok(fs.existsSync(path.join(root, target)), target);
    }
    for (const lang of ['zh', 'en']) {
      const data = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${lang}.json`), 'utf8'));
      assert.equal(data.meta.title, 'dsh-attendance');
    }
  });
  test('calendar helpers remain stable under Shanghai, UTC and DST host time zones', () => {
    const previousTimezone = process.env.TZ;
    try {
      for (const timezone of ['Asia/Shanghai', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = timezone;
        const local = new Date('2025-01-01T00:00:00Z');
        const expectedOffset = { 'Asia/Shanghai': -480, UTC: 0,
          'America/Los_Angeles': 480, 'Pacific/Kiritimati': -840 }[timezone];
        assert.equal(local.getTimezoneOffset(), expectedOffset, `Timezone switch: ${timezone}`);
        calendarTests();
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
}
console.log(`PASS: ${passed} attendance model checks (${process.env.TZ || 'host timezone'}).`);
