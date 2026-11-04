window.__ModuleLoader__.load({
  id: 'dsh-attendance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'dsh-attendance';
    const NS = 'localAttendance';
    // BEGIN ATTENDANCE MODEL
    const PERIOD_IDS = ['morning', 'afternoon', 'evening'];
    const DAY_PREFIX = 'dsh-attendance.v2.day.';
    const TARGET_PREFIX = 'dsh-attendance.v2.target.';
    const PRESET_KEY = 'dsh-attendance.presets.v1';
    const blankDay = () => Object.fromEntries(PERIOD_IDS.map(id => [id, { start: '', end: '' }]));
    const isTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    function periodStatus(period) {
      if (period.start === '' && period.end === '') return { duration: null, error: null };
      if (!period.start || !period.end) return { duration: null, error: 'incomplete' };
      if (!isTime(period.start) || !isTime(period.end)) return { duration: null, error: 'invalidTime' };
      const duration = minutes(period.end) - minutes(period.start);
      return duration > 0 ? { duration, error: null } : { duration: null, error: 'endBeforeStart' };
    }
    function daySummary(day) {
      const statuses = Object.fromEntries(PERIOD_IDS.map(id => [id, periodStatus(day[id])]));
      const overlaps = new Set();
      for (let i = 0; i < PERIOD_IDS.length; i++) {
        for (let j = i + 1; j < PERIOD_IDS.length; j++) {
          const left = PERIOD_IDS[i], right = PERIOD_IDS[j];
          if (statuses[left].duration !== null && statuses[right].duration !== null &&
              Math.max(minutes(day[left].start), minutes(day[right].start)) < Math.min(minutes(day[left].end), minutes(day[right].end))) {
            overlaps.add(left); overlaps.add(right);
          }
        }
      }
      for (const id of overlaps) statuses[id] = { duration: null, error: 'overlap' };
      return {
        statuses,
        total: PERIOD_IDS.reduce((sum, id) => sum + (statuses[id].duration || 0), 0),
        hasEntries: PERIOD_IDS.some(id => day[id].start !== '' || day[id].end !== ''),
        incomplete: PERIOD_IDS.some(id => Boolean(statuses[id].error))
      };
    }
    function dateString(date) { return date.toISOString().slice(0, 10); }
    function isDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T12:00:00Z`);
      return Number.isFinite(date.getTime()) && dateString(date) === value;
    }
    function addDays(value, count) {
      if (!isDate(value) || !Number.isInteger(count)) throw new Error('Invalid date');
      const date = new Date(`${value}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + count);
      const result = dateString(date);
      if (!isDate(result)) throw new Error('Date out of range');
      return result;
    }
    function weekStart(value) {
      if (!isDate(value)) throw new Error('Invalid date');
      const weekday = new Date(`${value}T12:00:00Z`).getUTCDay();
      return addDays(value, -((weekday + 6) % 7));
    }
    const weekDates = monday => Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    function validateDay(day) {
      if (!day || typeof day !== 'object') throw new Error('Invalid day');
      const result = blankDay();
      for (const id of PERIOD_IDS) {
        const period = day[id];
        if (!period || ![period.start, period.end].every(value => value === '' || isTime(value))) throw new Error('Invalid time record');
        result[id] = { start: period.start, end: period.end };
      }
      return result;
    }
    function validatePresets(presets) {
      const result = validateDay(presets);
      const summary = daySummary(result);
      if (PERIOD_IDS.some(id => ['endBeforeStart', 'overlap'].includes(summary.statuses[id].error))) throw new Error('Invalid preset intervals');
      return result;
    }
    function readPresets(storage) {
      const raw = storage.getItem(PRESET_KEY) ?? storage.getItem('dsh-attendance.periods.v1');
      if (raw === null) return blankDay();
      const data = JSON.parse(raw);
      if (!data || data.version !== 1) throw new Error('Invalid preset version');
      return validatePresets(data.periods);
    }
    function writePresets(storage, presets, date) {
      const periods = validatePresets(presets);
      if (date !== undefined && !isDate(date)) throw new Error('Invalid date');
      const existing = date === undefined ? null : loadRecord(storage, date);
      let next = null;
      if (existing) {
        next = { periods: validateDay(existing.periods), presets: validateDay(periods) };
        for (const id of PERIOD_IDS) {
          for (const field of ['start', 'end']) {
            if (periods[id][field] !== '') next.periods[id][field] = periods[id][field];
          }
        }
      }
      const previousPresets = next ? storage.getItem(PRESET_KEY) : null;
      storage.setItem(PRESET_KEY, JSON.stringify({ version: 1, periods }));
      if (next) {
        try { storage.setItem(DAY_PREFIX + date, JSON.stringify({ version: 3, ...next })); }
        catch (error) {
          try {
            if (previousPresets === null) storage.removeItem(PRESET_KEY);
            else storage.setItem(PRESET_KEY, previousPresets);
          } catch { throw new Error('Preset partial save'); }
          throw error;
        }
      }
    }
    function loadRecord(storage, date) {
      if (!isDate(date)) throw new Error('Invalid date');
      const raw = storage.getItem(DAY_PREFIX + date);
      if (raw === null) return null;
      const data = JSON.parse(raw);
      if (!data || ![2, 3].includes(data.version)) throw new Error('Invalid record version');
      const periods = validateDay(data.periods);
      const presets = data.version === 2 ? blankDay() : validatePresets(data.presets);
      for (const id of PERIOD_IDS) {
        for (const field of ['start', 'end']) {
          if (presets[id][field] !== '' && presets[id][field] !== periods[id][field]) throw new Error('Preset snapshot mismatch');
        }
      }
      return { periods, presets };
    }
    function loadDay(storage, date) {
      return loadRecord(storage, date)?.periods ?? blankDay();
    }
    function newRecord(storage, expectedPresets) {
      const presets = readPresets(storage);
      if (expectedPresets !== undefined && JSON.stringify(validatePresets(expectedPresets)) !== JSON.stringify(presets)) throw new Error('Presets changed');
      return { periods: validateDay(presets), presets };
    }
    function createDay(storage, date, expectedPresets) {
      const existing = loadRecord(storage, date);
      if (existing !== null) {
        if (expectedPresets !== undefined) throw new Error('Record changed');
        return existing;
      }
      const record = newRecord(storage, expectedPresets);
      storage.setItem(DAY_PREFIX + date, JSON.stringify({ version: 3, ...record }));
      return record;
    }
    function updateDay(storage, date, period, field, value, expectedPresets) {
      if (!PERIOD_IDS.includes(period) || !['start', 'end'].includes(field) || !(value === '' || isTime(value))) throw new Error('Invalid field');
      const existing = loadRecord(storage, date);
      if (existing !== null && expectedPresets !== undefined) throw new Error('Record changed');
      const record = existing ?? newRecord(storage, expectedPresets);
      if (record.presets[period][field] !== '') throw new Error('Preset field is locked');
      record.periods[period][field] = value;
      storage.setItem(DAY_PREFIX + date, JSON.stringify({ version: 3, ...record }));
      return record.periods;
    }
    function loadWeek(storage, monday) {
      const days = {}, records = {}, errors = [];
      for (const date of weekDates(monday)) {
        try { records[date] = loadRecord(storage, date); days[date] = records[date]?.periods ?? blankDay(); }
        catch { records[date] = null; days[date] = blankDay(); errors.push(date); }
      }
      return { days, records, errors };
    }
    function listWeeks(storage) {
      const weeks = new Set();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key || !key.startsWith(DAY_PREFIX)) continue;
        const date = key.slice(DAY_PREFIX.length);
        if (!isDate(date)) continue;
        try { if (loadRecord(storage, date) !== null) weeks.add(weekStart(date)); }
        catch { weeks.add(weekStart(date)); /* Keep damaged history discoverable without overwriting it. */ }
      }
      return [...weeks].sort().reverse();
    }
    function readTarget(storage, monday) {
      if (!isDate(monday)) throw new Error('Invalid date');
      const raw = storage.getItem(TARGET_PREFIX + monday);
      if (raw === null) return 40;
      const hours = JSON.parse(raw);
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('Invalid target');
      return hours;
    }
    function writeTarget(storage, monday, hours) {
      if (!isDate(monday) || typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('Invalid target');
      storage.setItem(TARGET_PREFIX + monday, JSON.stringify(hours));
    }
    function todayInShanghai() {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const get = type => parts.find(part => part.type === type).value;
      return `${get('year')}-${get('month')}-${get('day')}`;
    }
    // END ATTENDANCE MODEL
    const dictionaries = {
      zh: {
        title: '考勤', subtitle: '让每一天的投入，都清晰可见。',
        presets: '固定时间预设', presetIntro: '为六个时间点分别设置预设。留空的时间点开放手动填写。',
        presetPolicy: '保存后同步今天已有的记录：新预设会覆盖对应时间点，留空的时间点保留原值并开放填写。历史记录保持不变。',
        savePresets: '保存并同步今天', presetsSaved: '预设已保存并同步今天，历史记录保持不变。', presetInvalid: '预设无效或保存失败，请检查时间顺序、重叠及浏览器存储。',
        presetPartialError: '预设已保存，但今天的记录未更新，请重新保存预设完成同步。',
        dayChanged: '日期已变化，请重新保存预设以同步新的一天。',
        presetReadError: '预设读取失败，暂不能创建新记录；已有记录仍可查询与编辑。',
        presetsChanged: '预设或当天记录已在其他页面更新，已刷新显示，请核对后重新操作。',
        fixed: '预设固定', manual: '手动填写', addTime: '点击添加', editTime: '点击修改',
        clearTime: '清空时间',
        saveTime: '保存时间', cancel: '取消', createDay: '记录当天考勤', preview: '预设预览 · 尚未记录',
        previewHint: '固定时间已带入。点击记录当天考勤，或保存一个手动时间点后，才会计入合计。',
        dayRecorded: '当天考勤已记录。', dayFocus: '当天概览', recorded: '已记录', notStarted: '尚未记录',
        progressTitle: '每一小时，都在向目标靠近', dayNavigation: '选择日期', settingsClose: '收起预设',
        invalidEntry: '请输入有效的小时和分钟。', segments: '三个时段，一天的节奏',
        morning: '早上', afternoon: '下午', evening: '晚上', start: '上班', end: '下班',
        day0: '周一', day1: '周二', day2: '周三', day3: '周四', day4: '周五', day5: '周六', day6: '周日',
        currentProgress: '本周累计时长', target: '本周目标（小时）', saveTarget: '保存目标',
        targetHint: '默认 40 小时，可自行调整。目标按周保存。', targetError: '目标须大于 0 且不超过 168 小时。',
        targetSaved: '本周目标已保存。', targetLoadError: '本周目标读取失败，请检查浏览器存储。', weekChanged: '已进入新的一周，请重新填写本周目标。',
        previous: '上一周', next: '下一周', current: '返回本周', query: '按日期查询',
        history: '有记录的周', chooseHistory: '选择历史周', date: '日期', dailyTotal: '当天总时长',
        duration: '时长', weekTotal: '所选周合计', currentWeek: '本周', today: '今天',
        hours: '小时', minuteUnit: '分钟', noRecord: '未记录', saved: '已自动保存',
        incomplete: '待补下班或上班时间', invalidTime: '时间格式无效', endBeforeStart: '下班须晚于上班（同一天）', overlap: '时段重叠，请修正后计入合计', saving: '正在保存…',
        partial: '含待补或无效时间', countedHint: '合计仅计入完整且有效的时段；时段留空视为未出勤。当前按同一天计算。',
        saveError: '保存失败，本次输入尚未保存。请重试后再切换周次。', retry: '重试保存',
        loadError: '以下日期读取失败，已禁止编辑以保护原记录：',
        historyError: '历史记录目录读取失败。', currentError: '本周记录有读取失败的日期，累计可能不完整。',
        storageHint: '记录自动保存在当前浏览器，可按周或日期查询。清理浏览器数据会删除记录，不同浏览器不会同步。',
        progressHint: '进度始终显示本周；历史查询不影响本周统计。',
        empty: '这一周还没有考勤记录，可直接填写。', retryLoad: '重新读取',
        pending: '有输入尚未保存，请先重试保存。'
      },
      en: {
        title: 'Attendance', subtitle: 'Make every day’s effort visible.',
        presets: 'Fixed time presets', presetIntro: 'Set any of the six times. Only fields without a preset can be entered manually.',
        presetPolicy: 'Saving updates today’s existing record: fixed presets replace those times; empty presets retain the existing value and allow manual editing. Historical records stay unchanged.',
        savePresets: 'Save and update today', presetsSaved: 'Presets saved and today updated. Historical records are unchanged.', presetInvalid: 'Could not save presets. Check time order, overlaps and browser storage.',
        presetPartialError: 'Presets were saved but today’s record was not updated. Save presets again to finish syncing.',
        dayChanged: 'The date changed. Save presets again to update the new day.',
        presetReadError: 'Could not read presets. New records are unavailable; existing records remain accessible.',
        presetsChanged: 'Presets or this day changed in another page. The view has refreshed; review it and try again.',
        fixed: 'Fixed preset', manual: 'Manual entry', addTime: 'Click to add', editTime: 'Click to edit',
        clearTime: 'Clear time',
        saveTime: 'Save time', cancel: 'Cancel', createDay: 'Record this day', preview: 'Preset preview · Not recorded',
        previewHint: 'Presets are ready. Record the day or save a manual time to include it in totals.',
        dayRecorded: 'Day recorded.', dayFocus: 'Daily overview', recorded: 'Recorded', notStarted: 'Not recorded',
        progressTitle: 'Every hour brings you closer', dayNavigation: 'Choose a day', settingsClose: 'Close presets',
        invalidEntry: 'Enter a valid hour and minute.', segments: 'Three periods. One day.',
        morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', start: 'Clock in', end: 'Clock out',
        day0: 'Mon', day1: 'Tue', day2: 'Wed', day3: 'Thu', day4: 'Fri', day5: 'Sat', day6: 'Sun',
        currentProgress: 'This week’s hours', target: 'Weekly target (hours)', saveTarget: 'Save target',
        targetHint: 'Defaults to 40 hours. Targets are saved per week.', targetError: 'Target must be greater than 0 and no more than 168 hours.',
        targetSaved: 'Weekly target saved.', targetLoadError: 'Could not read the weekly target. Check browser storage.', weekChanged: 'A new week has started. Please enter the new weekly target.',
        previous: 'Previous week', next: 'Next week', current: 'Current week', query: 'Find by date',
        history: 'Recorded weeks', chooseHistory: 'Choose a week', date: 'Date', dailyTotal: 'Daily total',
        duration: 'Duration', weekTotal: 'Selected week total', currentWeek: 'This week', today: 'Today',
        hours: 'h', minuteUnit: 'min', noRecord: 'No record', saved: 'Saved automatically',
        incomplete: 'Clock-in or clock-out missing', invalidTime: 'Invalid time', endBeforeStart: 'Clock-out must follow clock-in on the same day', overlap: 'Overlapping periods are excluded until corrected', saving: 'Saving…',
        partial: 'Includes incomplete or invalid entries', countedHint: 'Totals count only complete, valid periods. Empty periods are not counted. All periods use the same day.',
        saveError: 'Could not save this input. Retry before switching weeks.', retry: 'Retry saving',
        loadError: 'Could not read these dates. Editing is disabled to protect existing records:',
        historyError: 'Could not read the history index.', currentError: 'Some current-week records could not be read. The total may be incomplete.',
        storageHint: 'Records are saved in this browser and searchable by week or date. Clearing browser data removes them; browsers do not sync.',
        progressHint: 'Progress always shows the current week, even when viewing history.',
        empty: 'No attendance recorded this week. Start entering times.', retryLoad: 'Reload records',
        pending: 'An input has not been saved. Retry saving first.'
      }
    };
    const css = `
      .at-page{box-sizing:border-box;height:100%;overflow:auto;color:var(--dsw-alias-label-primary);padding:32px clamp(16px,3vw,44px) 48px;font-family:inherit}
      .at-page *{box-sizing:border-box}.at-inner{max-width:1160px;margin:auto;display:flex;flex-direction:column;gap:24px}
      .at-page h1{margin:0;font-size:25px;line-height:34px;font-weight:600;letter-spacing:-.6px}.at-page h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
      .at-page p{margin:7px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
      .at-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px}.at-tools{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
      .at-page input,.at-page select,.at-page button{font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:9px 12px;max-width:100%}
      .at-page button{cursor:pointer;background:var(--dsw-alias-bg-layer-2)}.at-page button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .at-page button:disabled,.at-page input:disabled{opacity:.5;cursor:not-allowed}.at-page button:focus-visible,.at-page input:focus-visible,.at-page select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
      .at-page .at-primary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-state-business-primary)}
      .at-page .at-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,var(--dsw-alias-label-primary))}
      .at-hero{padding:26px 28px;border:1px solid var(--dsw-alias-border-l3);border-radius:22px;background:linear-gradient(120deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-layer-2)),var(--dsw-alias-bg-layer-2));overflow:hidden}
      .at-kicker{font-size:11px;letter-spacing:1.6px;color:var(--dsw-alias-label-secondary);font-weight:500}.at-number{font-size:38px;line-height:50px;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin:10px 0 5px}.at-number small{font-size:13px;letter-spacing:0;color:var(--dsw-alias-label-secondary);margin-left:12px}
      .at-track{height:9px;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);margin:16px 0}.at-fill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:inherit;transition:width .25s ease}
      .at-summary-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(220px,1fr);gap:18px}.at-day-summary{border:1px solid var(--dsw-alias-border-l3);border-radius:22px;padding:26px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;justify-content:space-between}
      .at-label{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px}.at-target{width:82px}.at-page .at-sub,.at-page .at-foot{font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .at-week-head{margin:4px 0 16px}.at-tabs{display:grid;grid-template-columns:repeat(7,minmax(100px,1fr));gap:10px;overflow-x:auto;padding:4px 3px 10px}
      .at-page .at-tab{text-align:left;border-radius:16px;padding:15px 13px;display:flex;flex-direction:column;gap:9px;min-width:100px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
      .at-page .at-tab[aria-selected=true]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-layer-2));box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
      .at-date-number{font-size:25px;font-weight:500;line-height:30px;font-variant-numeric:tabular-nums}.at-tab-total{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.at-dot{width:5px;height:5px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-business-primary);margin-left:5px;vertical-align:middle}
      .at-panel{display:flex;flex-direction:column;gap:18px;padding-top:12px}.at-segments{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
      .at-segment{border:1px solid var(--dsw-alias-border-l3);border-radius:20px;padding:22px 18px;background:var(--dsw-alias-bg-layer-2);min-width:0}.at-icon{width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,var(--dsw-alias-bg-layer-2))}
      .at-segment-head{display:flex;align-items:center;gap:12px;margin-bottom:22px}.at-period-order{font-size:10px;color:var(--dsw-alias-label-tertiary);letter-spacing:2px;margin-bottom:3px}
      .at-points{display:grid;grid-template-columns:1fr 1fr;gap:10px}.at-page .at-point{width:100%;min-width:0;min-height:112px;border:1px dashed var(--dsw-alias-border-l3);border-radius:14px;padding:12px 10px;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;gap:10px;text-align:left;background:var(--dsw-alias-bg-layer-3)}
      .at-page .at-point.at-fixed{border-style:solid;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,var(--dsw-alias-bg-layer-3))}.at-point-time{font-size:23px;line-height:30px;font-variant-numeric:tabular-nums;letter-spacing:-.4px}.at-point-label{font-size:12px;color:var(--dsw-alias-label-secondary)}.at-point-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);display:flex;gap:4px;align-items:center}
      .at-editable-point{position:relative;min-width:0}.at-editable-point .at-point-time{padding-right:24px}
      .at-page .at-trash{width:30px;height:30px;flex:none;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:none;color:var(--dsw-alias-label-tertiary)}
      .at-page .at-trash:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
      .at-page .at-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%)}
      .at-input-row{display:flex;align-items:center;gap:5px}.at-input-row input{flex:1;min-width:0}.at-editor .at-input-row{margin:8px 0 12px}.at-editor .at-input-row input{margin:0}.at-editor .at-trash{padding:6px}
      .at-segment-total{margin-top:18px;padding-top:15px;border-top:1px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-variant-numeric:tabular-nums}
      .at-editor{margin-top:14px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-3)}.at-editor input{width:100%;margin:8px 0 12px}.at-editor .at-tools{gap:6px}.at-editor button{padding:7px 10px}
      .at-preset-panel{border:1px solid var(--dsw-alias-border-l3);border-radius:20px;padding:24px;background:var(--dsw-alias-bg-layer-2)}.at-preset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:20px 0}.at-preset-group{border:1px solid var(--dsw-alias-border-l3);border-radius:14px;padding:16px;min-width:0}.at-preset-group legend{font-size:13px;padding:0 6px}.at-preset-group label{display:flex;flex-direction:column;gap:6px;font-size:12px;margin-bottom:12px;color:var(--dsw-alias-label-secondary)}.at-preset-group input{width:100%;min-width:0}
      .at-preview{border:1px dashed var(--dsw-alias-border-l3);border-radius:14px;padding:16px 18px;background:var(--dsw-alias-bg-layer-2)}.at-badge{border-radius:20px;padding:5px 10px;background:var(--dsw-alias-bg-layer-3);font-size:11px;color:var(--dsw-alias-label-secondary)}
      .at-page .at-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}.at-message{min-height:20px}.at-page input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
      @media(max-width:900px){.at-segments,.at-preset-grid{grid-template-columns:1fr}.at-points{grid-template-columns:1fr 1fr}.at-page .at-point{min-height:100px}.at-summary-grid{grid-template-columns:1fr}.at-day-summary{gap:10px}.at-tabs{grid-template-columns:repeat(7,110px)}.at-number{font-size:30px}}
      @media(prefers-reduced-motion:reduce){.at-fill{transition:none}}
    `;
    function ClockIcon({ size = 20 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v5l3 2' }));
    }
    function PeriodIcon({ kind }) {
      const props = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
      if (kind === 'evening') return h('svg', props, h('path', { d: 'M20 14a8.5 8.5 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z' }));
      if (kind === 'afternoon') return h('svg', props, h('path', { d: 'M3 18h18M6 15a6 6 0 0 1 12 0M12 3v3M4 7l2 2M20 7l-2 2M2 13h2M20 13h2' }));
      return h('svg', props, h('circle', { cx: 12, cy: 12, r: 4 }), h('path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5' }));
    }
    function TrashIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6' }));
    }
    function LockIcon() {
      return h('svg', { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true }, h('rect', { x: 3, y: 7, width: 10, height: 7, rx: 2 }), h('path', { d: 'M5 7V5a3 3 0 0 1 6 0v2' }));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries));
        const t = ctx.locale.bind(NS);
        const formatDuration = value => `${Math.floor(value / 60)} ${t('hours')} ${value % 60} ${t('minuteUnit')}`;
        const sumWeek = week => Object.values(week.days).reduce((sum, day) => sum + daySummary(day).total, 0);
        function AttendancePage() {
          React.useSyncExternalStore(React.useCallback(listener => ctx.locale.subscribe(listener), []), () => ctx.locale.getSnapshot().revision);
          const [today, setToday] = React.useState(todayInShanghai);
          const currentMonday = weekStart(today);
          const [active, setActive] = React.useState(today);
          const selected = weekStart(active);
          const [revision, refresh] = React.useReducer(value => value + 1, 0);
          const [editor, setEditor] = React.useState(null);
          const [pending, setPending] = React.useState(null);
          const [saving, setSaving] = React.useState(false);
          const [notice, setNotice] = React.useState(null);
          const [presetsOpen, setPresetsOpen] = React.useState(false);
          const [presetDraft, setPresetDraft] = React.useState(null);
          const [presetDirty, setPresetDirty] = React.useState(false);
          const [targetInput, setTargetInput] = React.useState('');
          const [targetDirty, setTargetDirty] = React.useState(false);
          const targetDraftWeek = React.useRef(currentMonday);
          const tabRefs = React.useRef({});
          const pointRefs = React.useRef({});
          const restorePoint = React.useRef(null);
          const actionBusy = React.useRef(false);
          React.useEffect(() => {
            if (!editor && !saving && restorePoint.current) {
              pointRefs.current[restorePoint.current]?.focus(); restorePoint.current = null;
            }
          }, [editor, saving]);
          React.useEffect(() => {
            const check = () => setToday(todayInShanghai());
            const timer = window.setInterval(check, 30000);
            window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
            return () => { window.clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
          }, []);
          React.useEffect(() => {
            const onStorage = event => { if (event.key === null || event.key === PRESET_KEY || event.key === 'dsh-attendance.periods.v1' || event.key.startsWith(DAY_PREFIX) || event.key.startsWith(TARGET_PREFIX)) refresh(); };
            window.addEventListener('storage', onStorage);
            return () => window.removeEventListener('storage', onStorage);
          }, []);
          React.useEffect(() => {
            if (!editor && !pending && !presetDirty && !targetDirty) return;
            const guard = event => { event.preventDefault(); event.returnValue = ''; };
            window.addEventListener('beforeunload', guard);
            return () => window.removeEventListener('beforeunload', guard);
          }, [editor, pending, presetDirty, targetDirty]);
          React.useEffect(() => {
            if (targetDraftWeek.current === currentMonday) return;
            targetDraftWeek.current = currentMonday; setTargetDirty(false); setTargetInput('');
            if (targetDirty) setNotice('weekChanged');
          }, [currentMonday, targetDirty]);
          const snapshot = React.useMemo(() => {
            try {
              const storage = window.localStorage;
              const viewed = loadWeek(storage, selected), current = selected === currentMonday ? viewed : loadWeek(storage, currentMonday);
              let target = null, targetError = false, history = [], historyError = false, presets = blankDay(), presetsError = false;
              try { target = readTarget(storage, currentMonday); } catch { targetError = true; }
              try { history = listWeeks(storage); } catch { historyError = true; }
              try { presets = readPresets(storage); } catch { presetsError = true; }
              return { viewed, current, target, targetError, history, historyError, presets, presetsError };
            } catch {
              const failed = monday => ({ days: Object.fromEntries(weekDates(monday).map(date => [date, blankDay()])), records: Object.fromEntries(weekDates(monday).map(date => [date, null])), errors: weekDates(monday) });
              return { viewed: failed(selected), current: failed(currentMonday), target: null, targetError: true, history: [], historyError: true, presets: blankDay(), presetsError: true };
            }
          }, [selected, currentMonday, revision]);
          const dates = weekDates(selected), record = snapshot.viewed.records[active];
          const blocked = snapshot.viewed.errors.includes(active);
          const displayed = blocked ? blankDay() : record?.periods ?? snapshot.presets;
          const fixed = blocked ? blankDay() : record?.presets ?? snapshot.presets;
          const summary = daySummary(displayed);
          const total = sumWeek(snapshot.viewed), currentTotal = sumWeek(snapshot.current);
          const percent = snapshot.target === null ? null : currentTotal / (snapshot.target * 60) * 100;
          const navigationLocked = saving || Boolean(pending) || Boolean(editor);
          const range = monday => `${monday} — ${addDays(monday, 6)}`;
          function navigate(date) {
            if (navigationLocked) return;
            setActive(date); setNotice(null);
          }
          function cancelEditor() {
            if (saving) return;
            if (editor) restorePoint.current = `${editor.period}-${editor.field}`;
            setEditor(null); setPending(null); setNotice(null);
          }
          async function perform(action) {
            if (actionBusy.current) return;
            actionBusy.current = true; setSaving(true); setPending(action); setNotice('saving');
            try {
              if (!window.navigator.locks) throw new Error('Web Locks unavailable');
              if (action.kind === 'presets') {
                await window.navigator.locks.request('dsh-attendance.presets', async () => {
                  const date = todayInShanghai();
                  await window.navigator.locks.request(`dsh-attendance.date.${date}`, () => {
                    if (todayInShanghai() !== date) throw new Error('Day changed');
                    writePresets(window.localStorage, action.value, date);
                  });
                });
                setToday(todayInShanghai());
                setPresetDraft(null); setPresetDirty(false); setPresetsOpen(false); setNotice('presetsSaved');
              } else {
                await window.navigator.locks.request(`dsh-attendance.date.${action.date}`, () => action.kind === 'create'
                  ? createDay(window.localStorage, action.date, action.expectedPresets)
                  : updateDay(window.localStorage, action.date, action.period, action.field, action.value, action.expectedPresets));
                if (action.kind === 'field') { restorePoint.current = `${action.period}-${action.field}`; setEditor(null); }
                setNotice(action.kind === 'create' ? 'dayRecorded' : 'saved');
              }
              setPending(null); refresh();
            } catch (error) {
              if (['Presets changed', 'Record changed'].includes(error.message)) {
                setPending(null); setNotice('presetsChanged'); refresh();
              } else if (error.message === 'Day changed') {
                setPending(null); setToday(todayInShanghai()); setNotice('dayChanged'); refresh();
              } else if (error.message === 'Preset partial save') {
                setNotice('presetPartialError'); refresh();
              } else { setNotice(action.kind === 'presets' ? 'presetInvalid' : 'saveError'); }
            }
            finally { actionBusy.current = false; setSaving(false); }
          }
          function saveTarget(event) {
            event.preventDefault();
            if (weekStart(todayInShanghai()) !== currentMonday || targetDraftWeek.current !== currentMonday) {
              setToday(todayInShanghai()); setTargetDirty(false); setTargetInput(''); setNotice('weekChanged'); return;
            }
            const value = Number(targetInput);
            if (!targetInput.trim() || !Number.isFinite(value) || value <= 0 || value > 168) { setNotice('targetError'); return; }
            try { writeTarget(window.localStorage, currentMonday, value); setTargetDirty(false); setTargetInput(''); setNotice('targetSaved'); refresh(); }
            catch { setNotice('saveError'); }
          }
          function tabKey(event, index) {
            const next = event.key === 'ArrowRight' ? (index + 1) % 7 : event.key === 'ArrowLeft' ? (index + 6) % 7 : event.key === 'Home' ? 0 : event.key === 'End' ? 6 : null;
            if (next === null || navigationLocked) return;
            event.preventDefault(); navigate(dates[next]); tabRefs.current[dates[next]]?.focus();
          }
          function changePreset(period, field, value) {
            setPresetDraft(previous => { const base = previous ?? snapshot.presets; return { ...base, [period]: { ...base[period], [field]: value } }; });
            setPresetDirty(true); if (pending?.kind === 'presets') setPending(null); setNotice(null);
          }
          const draft = presetDraft ?? snapshot.presets;
          const errorNotice = notice && !['saved', 'targetSaved', 'saving', 'presetsSaved', 'dayRecorded'].includes(notice);
          return h('section', { className: 'at-page', 'aria-label': t('title') }, h('style', null, css),
            h('div', { className: 'at-inner' },
              h('header', { className: 'at-row' }, h('div', null, h('h1', null, t('title')), h('p', null, t('subtitle'))),
                h('button', { type: 'button', 'aria-expanded': presetsOpen, 'aria-controls': 'at-presets', disabled: saving || Boolean(pending), onClick: () => setPresetsOpen(value => !value) }, presetsOpen ? t('settingsClose') : t('presets'))),
              presetsOpen ? h('section', { className: 'at-preset-panel', id: 'at-presets', 'aria-label': t('presets') },
                h('h2', null, t('presets')), h('p', null, t('presetIntro')), h('p', { className: 'at-foot' }, t('presetPolicy')),
                h('form', { onSubmit: event => { event.preventDefault(); perform({ kind: 'presets', value: draft }); } },
                  h('div', { className: 'at-preset-grid' }, ...PERIOD_IDS.map(period => h('fieldset', { className: 'at-preset-group', key: period }, h('legend', null, t(period)),
                    ...['start', 'end'].map(field => h('label', { key: field }, t(field), h('span', { className: 'at-input-row' },
                      h('input', { type: 'time', step: 60, value: draft[period][field], disabled: saving, onChange: event => changePreset(period, field, event.target.value) }),
                      h('button', { type: 'button', className: 'at-trash', title: t('clearTime'), 'aria-label': `${t('clearTime')} ${t('presets')} ${t(period)} ${t(field)}`, disabled: saving || !draft[period][field], onClick: () => changePreset(period, field, '') }, h(TrashIcon)))))))),
                  h('div', { className: 'at-tools' }, h('button', { type: 'submit', className: 'at-primary', disabled: saving || Boolean(editor) || Boolean(pending && pending.kind !== 'presets') }, t('savePresets')),
                    h('button', { type: 'button', disabled: saving, onClick: () => { setPresetsOpen(false); setPresetDraft(null); setPresetDirty(false); if (pending?.kind === 'presets') setPending(null); setNotice(null); } }, t('cancel'))))) : null,
              h('div', { className: 'at-summary-grid' },
                h('section', { className: 'at-hero', 'aria-label': t('currentProgress') },
                  h('div', { className: 'at-row' }, h('span', { className: 'at-kicker' }, t('currentProgress')), h('span', { className: 'at-sub' }, range(currentMonday))),
                  h('div', { className: 'at-number' }, formatDuration(currentTotal), snapshot.target !== null ? h('small', null, `${percent.toFixed(1)}%`) : null),
                  h('p', null, t('progressTitle')),
                  percent !== null ? h('div', { className: 'at-track', role: 'progressbar', 'aria-label': t('currentProgress'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, percent), 'aria-valuetext': `${formatDuration(currentTotal)} / ${snapshot.target} ${t('hours')}` }, h('div', { className: 'at-fill', style: { width: `${Math.min(100, percent)}%` } })) : null,
                  h('form', { className: 'at-tools', onSubmit: saveTarget }, h('label', { className: 'at-label' }, t('target'), h('input', { className: 'at-target', type: 'number', min: 0.01, max: 168, step: 'any', required: true, value: targetDirty ? targetInput : (snapshot.target ?? ''), disabled: saving, onChange: event => { setTargetInput(event.target.value); setTargetDirty(true); } })), h('button', { type: 'submit', disabled: !targetDirty || saving }, t('saveTarget'))),
                  snapshot.targetError ? h('p', { className: 'at-error', role: 'alert' }, t('targetLoadError')) : null,
                  snapshot.current.errors.length ? h('p', { className: 'at-error', role: 'alert' }, t('currentError')) : null,
                  Object.values(snapshot.current.days).some(day => daySummary(day).incomplete) ? h('p', { className: 'at-error' }, t('partial')) : null),
                h('section', { className: 'at-day-summary', 'aria-label': t('dayFocus') }, h('div', { className: 'at-row' }, h('span', { className: 'at-kicker' }, t('dayFocus')), h('span', { className: 'at-badge' }, record ? t('recorded') : t('notStarted'))),
                  h('div', null, h('p', null, active), h('div', { className: 'at-number' }, blocked || !record ? '—' : formatDuration(summary.total)), h('p', null, t('dailyTotal'))),
                  h('p', { className: 'at-foot' }, `${t('weekTotal')} · ${formatDuration(total)}`))),
              h('section', null,
                h('div', { className: 'at-row at-week-head' }, h('h2', null, range(selected)), h('div', { className: 'at-tools' },
                  h('button', { type: 'button', disabled: navigationLocked, onClick: () => navigate(addDays(active, -7)) }, '← ', t('previous')),
                  h('button', { type: 'button', disabled: navigationLocked, onClick: () => navigate(today) }, t('current')),
                  h('button', { type: 'button', disabled: navigationLocked, onClick: () => navigate(addDays(active, 7)) }, t('next'), ' →'))),
                h('div', { className: 'at-tabs', role: 'tablist', 'aria-label': t('dayNavigation') }, ...dates.map((date, index) => {
                  const dayRecord = snapshot.viewed.records[date], day = daySummary(snapshot.viewed.days[date]);
                  return h('button', { key: date, type: 'button', className: 'at-tab', role: 'tab', id: `at-tab-${date}`, 'aria-selected': active === date, 'aria-controls': 'at-day-panel', 'aria-label': `${date} ${t(`day${index}`)}`, tabIndex: active === date ? 0 : -1, disabled: navigationLocked && active !== date, ref: element => { tabRefs.current[date] = element; }, onClick: () => navigate(date), onKeyDown: event => tabKey(event, index) },
                    h('span', { className: 'at-sub' }, t(`day${index}`), date === today ? h('span', { className: 'at-dot', title: t('today') }) : null), h('span', { className: 'at-date-number' }, date.slice(8)),
                    h('span', { className: 'at-tab-total' }, snapshot.viewed.errors.includes(date) ? '!' : dayRecord ? formatDuration(day.total) : '—'));
                })),
                h('section', { className: 'at-panel', role: 'tabpanel', id: 'at-day-panel', 'aria-labelledby': `at-tab-${active}` },
                  h('div', { className: 'at-row' }, h('h2', null, t('segments')), h('span', { className: 'at-sub' }, active)),
                  !record && !blocked ? h('div', { className: 'at-preview at-row' }, h('div', null, h('span', { className: 'at-badge' }, t('preview')), h('p', null, t('previewHint'))),
                    h('button', { type: 'button', className: 'at-primary', disabled: saving || Boolean(pending) || Boolean(editor) || snapshot.presetsError, onClick: () => perform({ kind: 'create', date: active, expectedPresets: snapshot.presets }) }, '+ ', t('createDay'))) : null,
                  h('div', { className: 'at-segments' }, ...PERIOD_IDS.map((period, index) => {
                    const status = summary.statuses[period], errorId = `at-error-${active}-${period}`;
                    return h('article', { className: 'at-segment', key: period, 'aria-label': t(period) },
                      h('div', { className: 'at-segment-head' }, h('div', { className: 'at-icon' }, h(PeriodIcon, { kind: period })), h('div', null, h('div', { className: 'at-period-order' }, `0${index + 1}`), h('h2', null, t(period)))),
                      h('div', { className: 'at-points' }, ...['start', 'end'].map(field => {
                        const locked = fixed[period][field] !== '', value = displayed[period][field];
                        const content = [h('span', { className: 'at-point-label', key: 'label' }, t(field)), h('span', { className: 'at-point-time', key: 'value' }, value || '+'), h('span', { className: 'at-point-hint', key: 'hint' }, locked ? h(LockIcon) : null, locked ? t('fixed') : value ? t('editTime') : t('addTime'))];
                        return locked ? h('div', { className: 'at-point at-fixed', key: field, 'aria-label': `${t(period)} ${t(field)} ${value} ${t('fixed')}` }, ...content)
                          : h('div', { className: 'at-editable-point', key: field },
                            h('button', { type: 'button', className: 'at-point', ref: element => { pointRefs.current[`${period}-${field}`] = element; }, disabled: blocked || saving || Boolean(pending) || Boolean(editor) || (!record && snapshot.presetsError), 'aria-label': `${t(period)} ${t(field)} ${value || t('addTime')}`, 'aria-describedby': status.error ? errorId : undefined, onClick: () => { setEditor({ date: active, period, field, value }); setNotice(null); } }, ...content),
                            h('button', { type: 'button', className: 'at-trash at-clear', title: t('clearTime'), 'aria-label': `${t('clearTime')} ${t(period)} ${t(field)}`, disabled: !value || blocked || saving || Boolean(pending) || Boolean(editor), onClick: event => { event.stopPropagation(); perform({ kind: 'field', date: active, period, field, value: '' }); } }, h(TrashIcon)));
                      })),
                      editor?.date === active && editor.period === period ? h('form', { className: 'at-editor', onSubmit: event => { event.preventDefault(); if (editor.value !== '' && !isTime(editor.value)) { setNotice('invalidEntry'); return; } perform({ kind: 'field', ...editor, expectedPresets: record ? undefined : snapshot.presets }); }, onKeyDown: event => { if (event.key === 'Escape' && !saving) { event.preventDefault(); cancelEditor(); } } },
                        h('label', null, `${t(period)} · ${t(editor.field)}`, h('span', { className: 'at-input-row' },
                          h('input', { type: 'time', step: 60, autoFocus: true, disabled: saving, value: editor.value, onChange: event => { const value = event.target.value; setEditor(previous => ({ ...previous, value })); if (pending?.kind === 'field') setPending(null); setNotice(null); } }),
                          h('button', { type: 'button', className: 'at-trash', title: t('clearTime'), 'aria-label': `${t('clearTime')} ${t(period)} ${t(editor.field)}`, disabled: saving || !editor.value || fixed[period][editor.field] !== '', onClick: () => { setEditor(previous => ({ ...previous, value: '' })); if (pending?.kind === 'field') setPending(null); setNotice(null); } }, h(TrashIcon)))),
                        h('div', { className: 'at-tools' }, h('button', { type: 'submit', className: 'at-primary', disabled: saving || fixed[period][editor.field] !== '' }, t('saveTime')), h('button', { type: 'button', disabled: saving, onClick: cancelEditor }, t('cancel')))) : null,
                      h('div', { className: 'at-segment-total' }, h('span', { className: 'at-sub' }, t('duration')), h('strong', null, blocked || status.duration === null ? '—' : formatDuration(status.duration))),
                      status.error && !blocked ? h('p', { id: errorId, className: 'at-error' }, t(status.error)) : null);
                  })),
                  h('p', { className: 'at-foot' }, t('countedHint'))),
                h('div', { className: 'at-tools', style: { marginTop: 22 } },
                  h('label', { className: 'at-label' }, t('query'), h('input', { type: 'date', min: '1900-01-01', max: '9998-12-31', value: active, disabled: navigationLocked, onChange: event => { if (isDate(event.target.value)) navigate(event.target.value); } })),
                  h('label', { className: 'at-label' }, t('history'), h('select', { value: '', disabled: navigationLocked, onChange: event => { if (event.target.value) navigate(event.target.value); } }, h('option', { value: '' }, t('chooseHistory')), ...snapshot.history.map(monday => h('option', { value: monday, key: monday }, range(monday)))))),
                snapshot.viewed.errors.length ? h('p', { className: 'at-error', role: 'alert' }, t('loadError'), ' ', snapshot.viewed.errors.join(', ')) : null,
                snapshot.historyError ? h('p', { className: 'at-error', role: 'alert' }, t('historyError')) : null),
              snapshot.presetsError ? h('p', { className: 'at-error', role: 'alert' }, t('presetReadError')) : null,
              h('div', { className: 'at-tools at-message' }, notice ? h('p', { className: errorNotice ? 'at-error' : undefined, role: errorNotice ? 'alert' : 'status' }, t(notice)) : null,
                pending && !saving ? h('button', { type: 'button', onClick: () => perform(pending) }, t('retry')) : null,
                pending && !saving ? h('button', { type: 'button', onClick: () => { setPending(null); setNotice(null); } }, t('cancel')) : null,
                h('button', { type: 'button', disabled: saving || Boolean(pending), onClick: refresh }, t('retryLoad'))),
              h('p', { className: 'at-foot' }, t('storageHint'))));
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, AttendancePage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('title'), locale: NS }, ClockIcon));
      }
    };
  }
});
