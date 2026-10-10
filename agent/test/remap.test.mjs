// Khi cách gán mã NV -> tài khoản đổi giữa tháng (hết trùng mã, sửa mã), lượt
// chấm cá nhân phải được tách lại CẢ THÁNG. Lần chạy hằng đêm chỉ lấy 7 ngày:
// nếu chỉ ghi lại 7 ngày thì đầu tháng giữ dữ liệu sai mãi — "Chưa chấm" oan,
// hoặc giờ ăn của người khác.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerIndex, projectMonth, diffTapDoc, mappingChanged } from '../lib/projection.mjs';
import { monthDates, datesFromTo } from '../lib/common.mjs';

const M = '2026-10';
const AT = '2026-10-13T15:00:00.000Z';
const DEL = Symbol('del');

/**
 * Đúng các bước thuần của sync-checkins.mjs (bước 4): tách theo các ngày của
 * lần chạy; tài khoản đổi cách gán mã thì tách lại cả tháng tới hôm nay.
 */
function runProjection({ rangeDates, today, peopleOf, registrations = [], staff = [], existingTaps = {} }) {
  const index = buildOwnerIndex({ registrations, staff });
  const peopleByDate = Object.fromEntries(rangeDates.map(d => [d, peopleOf(d)]));
  let { plans } = projectMonth({ dates: rangeDates, peopleByDate, index });
  const changed = new Set([...plans].filter(([uid, plan]) => mappingChanged(existingTaps[uid], plan)).map(([uid]) => uid));
  let fullDates = rangeDates;
  if (changed.size) {
    fullDates = monthDates(M, today);
    for (const d of fullDates) if (!(d in peopleByDate)) peopleByDate[d] = peopleOf(d);
    ({ plans } = projectMonth({ dates: fullDates, peopleByDate, index }));
  }
  const writes = {};
  for (const [uid, plan] of plans) {
    const data = diffTapDoc({ uid, month: M, existing: existingTaps[uid] ?? null, plan, dates: changed.has(uid) ? fullDates : rangeDates, updatedAt: AT, del: DEL });
    if (data) writes[uid] = data;
  }
  return { writes, changed };
}

/** Áp một lần ghi set-merge như Firestore (DEL = xoá trường). */
function applyMerge(existing, data) {
  const out = { ...(existing || {}), ...data, days: { ...(existing?.days || {}) } };
  for (const [d, v] of Object.entries(data.days || {})) {
    if (v === DEL) delete out.days[d]; else out.days[d] = v;
  }
  return out;
}

const weekdays = (from, to) => datesFromTo(from, to).filter(d => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));

test('mappingChanged: chưa có document, đổi mã, đổi cờ trùng, đổi mã trùng', () => {
  const plan = { employeeIds: ['101190'], conflict: false, conflictIds: [], days: {} };
  assert.equal(mappingChanged(null, plan), true);
  assert.equal(mappingChanged(undefined, plan), true);
  assert.equal(mappingChanged({ employeeIds: ['101190'], conflict: false, conflictIds: [] }, plan), false);
  assert.equal(mappingChanged({ employeeIds: ['101191'], conflict: false, conflictIds: [] }, plan), true);
  assert.equal(mappingChanged({ employeeIds: ['101190'], conflict: true, conflictIds: ['101190'] }, plan), true);
  assert.equal(mappingChanged({ employeeIds: ['101190'], conflict: false }, plan), true, 'thiếu trường cũng tính là đổi');
});

test('hết trùng mã giữa tháng: các ngày đầu tháng được ghi lại, không còn "Chưa chấm" oan', () => {
  // Kịch bản người duyệt: 01–12/10 A và B cùng đơn mã 101190 => cả hai trùng,
  // không có days. 13/10 quản trị sửa mã của B. Lần chạy 22:00 lấy 07–13/10.
  const allDays = weekdays('2026-10-01', '2026-10-13');
  const peopleOf = d => allDays.includes(d) ? new Map([['101190', ['07:00', '11:30']], ['101191', ['11:45']]]) : undefined;
  const existingTaps = {
    A: { uid: 'A', month: M, employeeIds: ['101190'], conflict: true, conflictIds: ['101190'], days: {} },
    B: { uid: 'B', month: M, employeeIds: ['101190'], conflict: true, conflictIds: ['101190'], days: {} },
  };
  const { writes, changed } = runProjection({
    rangeDates: datesFromTo('2026-10-07', '2026-10-13'), today: '2026-10-13', peopleOf,
    registrations: [{ uid: 'A', employeeId: '101190' }, { uid: 'B', employeeId: '101191' }],
    existingTaps,
  });
  assert.deepEqual([...changed].sort(), ['A', 'B']);
  const a = applyMerge(existingTaps.A, writes.A);
  assert.equal(a.conflict, false);
  assert.deepEqual(Object.keys(a.days).sort(), allDays, 'đủ mọi ngày từ đầu tháng, không chỉ 7 ngày');
  assert.deepEqual(a.days['2026-10-01'], ['07:00', '11:30']);
  const b = applyMerge(existingTaps.B, writes.B);
  assert.deepEqual(b.days['2026-10-02'], ['11:45']);
});

test('mã trên đơn được quản trị sửa X -> Y: không còn giờ ăn của mã X ở các ngày cũ', () => {
  const peopleOf = d => {
    if (d === '2026-10-01') return new Map([['X', ['07:00']], ['Y', ['11:00']]]);
    if (d === '2026-10-02') return new Map([['X', ['07:10']]]); // hôm đó Y không ăn
    if (d === '2026-10-13') return new Map([['Y', ['11:05']]]);
    return undefined;
  };
  const existingTaps = {
    S: { uid: 'S', month: M, employeeIds: ['X'], conflict: false, conflictIds: [], days: { '2026-10-01': ['07:00'], '2026-10-02': ['07:10'] } },
  };
  const { writes } = runProjection({
    rangeDates: datesFromTo('2026-10-07', '2026-10-13'), today: '2026-10-13', peopleOf,
    registrations: [{ uid: 'S', employeeId: 'Y' }], existingTaps,
  });
  const s = applyMerge(existingTaps.S, writes.S);
  assert.deepEqual(s.employeeIds, ['Y']);
  assert.deepEqual(s.days, { '2026-10-01': ['11:00'], '2026-10-13': ['11:05'] }, 'ngày 02 chỉ có giờ của mã X thì bị xoá');
});

test('tài khoản không đổi cách gán mã: chỉ đụng các ngày của lần chạy (đỡ lượt ghi)', () => {
  const peopleOf = d => (d === '2026-10-01' || d === '2026-10-13' ? new Map([['101001', ['07:00']], ['101002', ['07:05']]]) : undefined);
  const existingTaps = {
    U: { uid: 'U', month: M, employeeIds: ['101001'], conflict: false, conflictIds: [], days: { '2026-10-01': ['07:00'], '2026-10-13': ['07:00'] } },
    // V chưa có document => cả tháng được tách cho V.
  };
  const { writes, changed } = runProjection({
    rangeDates: datesFromTo('2026-10-07', '2026-10-13'), today: '2026-10-13', peopleOf,
    registrations: [{ uid: 'U', employeeId: '101001' }, { uid: 'V', employeeId: '101002' }], existingTaps,
  });
  assert.deepEqual([...changed], ['V']);
  assert.equal(writes.U, undefined, 'U không đổi gì thì không ghi');
  assert.deepEqual(writes.V.days, { '2026-10-01': ['07:05'], '2026-10-13': ['07:05'] });
});

test('monthDates: các ngày của tháng tới hôm nay', () => {
  assert.equal(monthDates('2026-10', '2026-10-13').length, 13);
  assert.equal(monthDates('2026-09', '2026-10-13').length, 30);
  assert.deepEqual(monthDates('2026-02').at(-1), '2026-02-28');
  assert.deepEqual(monthDates('2028-02').at(-1), '2028-02-29');
  assert.deepEqual(monthDates('2026-11', '2026-10-13'), []);
});
