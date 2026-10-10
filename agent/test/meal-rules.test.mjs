// Test cho quy tắc dùng chung lib/meal-rules.mjs. File này không được sửa ở
// đây, nhưng agent, trang cá nhân và tab quản trị đều dựa vào nó — test chặn
// trước việc ai đó sửa quy tắc mà làm lệch giờ Việt Nam hay ý nghĩa các mã.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vnParts, isMealFinal, evaluatePersonDay, mealDaysOfMonth, classifyTime, normId, isUsableId,
  isMealDay, formatDayLabel, formatVnDateTime, duplicateIdsOn, registrationEffectiveFrom, reconcile, buildFromCheckins,
} from '../lib/meal-rules.mjs';

// Giờ Việt Nam = UTC+7. Viết mốc UTC cho rõ ràng: vn('2026-10-09', '13:46').
const vn = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(h * 60 + m - 7 * 60);
  return d;
};

test('vnParts: đổi đúng sang giờ Việt Nam ở các mốc giáp ngày UTC', () => {
  assert.deepEqual(vnParts('2026-10-08T23:30:00Z'), { date: '2026-10-09', time: '06:30' });
  assert.deepEqual(vnParts('2026-10-09T16:59:00Z'), { date: '2026-10-09', time: '23:59' });
  assert.deepEqual(vnParts('2026-10-09T17:00:00Z'), { date: '2026-10-10', time: '00:00' });
  assert.deepEqual(vnParts('2026-10-08T17:00:00Z'), { date: '2026-10-09', time: '00:00' });
  assert.deepEqual(vnParts(new Date('2026-12-31T17:00:00Z')), { date: '2027-01-01', time: '00:00' });
  assert.deepEqual(vnParts(Date.UTC(2026, 9, 9, 0, 59)), { date: '2026-10-09', time: '07:59' });
  assert.equal(vnParts('không phải ngày'), null);
  assert.equal(vn('2026-10-09', '13:46').toISOString(), '2026-10-09T06:46:00.000Z');
});

test('formatVnDateTime / formatDayLabel', () => {
  assert.equal(formatVnDateTime('2026-10-09T06:46:00Z'), '13:46 09/10/2026');
  assert.equal(formatVnDateTime(null), '');
  assert.equal(formatDayLabel('2026-10-09'), 'Thứ 6, 09/10');
  assert.equal(formatDayLabel('2026-10-11'), 'Chủ nhật, 11/10');
});

test('classifyTime: hai đầu khung đều tính', () => {
  assert.equal(classifyTime('04:59'), null);
  assert.equal(classifyTime('05:00'), 'breakfast');
  assert.equal(classifyTime('08:00'), 'breakfast');
  assert.equal(classifyTime('08:01'), null);
  assert.equal(classifyTime('09:59'), null);
  assert.equal(classifyTime('10:00'), 'lunch');
  assert.equal(classifyTime('13:30'), 'lunch');
  assert.equal(classifyTime('13:31'), null);
});

test('normId / isUsableId', () => {
  assert.equal(normId(' 101190 '), '101190');
  assert.equal(normId('ab　 12'), 'AB12');
  assert.equal(normId(null), '');
  assert.equal(isUsableId(''), false);
  assert.equal(isUsableId('N/A'), false);
  assert.equal(isUsableId('NA'), false);
  assert.equal(isUsableId('101190'), true);
});

test('isMealFinal: bảng chân trị (bữa đã hết + có đồng bộ đủ máy sau giờ hết bữa)', () => {
  const D = '2026-10-09';
  const cases = [
    // [meal, coverageAt, now, kỳ vọng, ghi chú]
    ['breakfast', vn(D, '08:15').toISOString(), vn(D, '07:59'), false, 'bữa chưa hết'],
    ['breakfast', vn(D, '08:15').toISOString(), vn(D, '08:00'), false, '08:00 vẫn trong khung'],
    ['breakfast', vn(D, '08:00').toISOString(), vn(D, '08:01'), false, 'đồng bộ đúng 08:00 chưa phủ hết bữa'],
    ['breakfast', vn(D, '08:01').toISOString(), vn(D, '08:02'), true, 'đồng bộ sau giờ hết bữa'],
    ['breakfast', vn(D, '08:15').toISOString(), vn(D, '08:16'), true, 'lần 08:15'],
    ['breakfast', null, vn(D, '20:00'), false, 'chưa có đồng bộ đủ máy'],
    ['breakfast', 'rác', vn(D, '20:00'), false, 'coverage hỏng'],
    ['lunch', vn(D, '08:15').toISOString(), vn(D, '13:46'), false, 'lần 08:15 không nói gì về bữa trưa'],
    ['lunch', vn(D, '13:45').toISOString(), vn(D, '13:46'), true, 'lần 13:45'],
    ['lunch', vn(D, '13:31').toISOString(), vn(D, '13:31'), true, 'sát giờ hết bữa'],
    ['lunch', vn(D, '13:45').toISOString(), vn(D, '13:30'), false, 'bây giờ còn trong khung'],
    ['lunch', vn('2026-10-10', '06:00').toISOString(), vn('2026-10-10', '07:00'), true, 'đồng bộ sáng hôm sau'],
    ['lunch', vn('2026-10-08', '22:00').toISOString(), vn('2026-10-10', '07:00'), false, 'đồng bộ của ngày hôm trước'],
  ];
  for (const [meal, coverageAt, now, want, note] of cases) {
    assert.equal(isMealFinal(D, meal, coverageAt, now), want, `${meal} — ${note}`);
  }
  // Ngày đã qua: bữa chắc chắn đã hết, chỉ còn phụ thuộc coverage.
  assert.equal(isMealFinal('2026-10-08', 'lunch', vn('2026-10-08', '22:00').toISOString(), vn(D, '06:00')), true);
  assert.equal(isMealFinal('2026-10-08', 'lunch', vn('2026-10-08', '13:00').toISOString(), vn(D, '06:00')), false);
});

test('evaluatePersonDay: mọi mã trạng thái', () => {
  const D = '2026-10-08'; // thứ 5
  const reg = { userId: 'u1', employeeId: '101001', breakfastCount: 20, lunchCount: 20 };
  const final = { coverageAt: vn(D, '13:45').toISOString(), now: vn(D, '14:00') };

  // off_day: cuối tuần và ngày nghỉ quản trị khai
  let r = evaluatePersonDay({ date: '2026-10-10', registration: reg, ...final });
  assert.equal(r.offDay, true);
  assert.equal(r.meals.breakfast.code, 'off_day');
  r = evaluatePersonDay({ date: D, registration: reg, offDays: [D], times: ['07:00'], ...final });
  assert.deepEqual([r.meals.breakfast.code, r.meals.breakfast.time], ['off_day', '07:00']);

  // excluded
  r = evaluatePersonDay({ date: D, registration: reg, excludedIds: [' 101001 '], ...final });
  assert.equal(r.meals.lunch.code, 'excluded');

  // invalid_id
  r = evaluatePersonDay({ date: D, registration: { ...reg, employeeId: 'N/A' }, ...final });
  assert.equal(r.meals.breakfast.code, 'invalid_id');

  // not_registered / extra
  r = evaluatePersonDay({ date: D, registration: null, times: ['07:00'], ...final });
  assert.equal(r.meals.breakfast.code, 'extra');
  assert.equal(r.meals.breakfast.reason, 'no_registration');
  assert.equal(r.meals.lunch.code, 'not_registered');

  // ok / missing
  r = evaluatePersonDay({ date: D, registration: reg, times: ['07:30', '07:10', '09:15'], ...final });
  assert.deepEqual(r.meals.breakfast, { code: 'ok', time: '07:10' });
  assert.equal(r.meals.lunch.code, 'missing');
  assert.deepEqual(r.unrecognized, ['09:15']);

  // pending: chưa có đồng bộ đủ máy sau bữa trưa (lần 08:15 chỉ chốt bữa sáng)
  r = evaluatePersonDay({ date: D, registration: reg, coverageAt: vn(D, '08:15').toISOString(), now: vn(D, '14:00') });
  assert.equal(r.meals.breakfast.code, 'missing');
  assert.equal(r.meals.lunch.code, 'pending');
  // pending: bữa chưa hết
  r = evaluatePersonDay({ date: D, registration: reg, coverageAt: vn(D, '13:45').toISOString(), now: vn(D, '12:00') });
  assert.equal(r.meals.lunch.code, 'pending');
  // pending: không có coverage
  r = evaluatePersonDay({ date: D, registration: reg, coverageAt: null, now: vn(D, '20:00') });
  assert.equal(r.meals.lunch.code, 'pending');

  // đã hủy: không phải ăn; hủy mà vẫn chấm là extra
  const cancel = [{ userId: 'u1', employeeId: '101001', cancelDate: D, cancelMeal: 'lunch' }];
  r = evaluatePersonDay({ date: D, registration: reg, cancelations: cancel, ...final });
  assert.deepEqual([r.meals.lunch.code, r.meals.lunch.reason], ['not_registered', 'canceled']);
  r = evaluatePersonDay({ date: D, registration: reg, cancelations: cancel, times: ['12:00'], ...final });
  assert.equal(r.meals.lunch.code, 'extra');

  // đăng ký sau giờ ăn trong ngày: không tính
  r = evaluatePersonDay({ date: D, registration: { ...reg, timestamp: vn(D, '09:00').toISOString() }, ...final });
  assert.equal(r.meals.breakfast.reason, 'registered_late');
  assert.equal(r.meals.lunch.code, 'missing');

  // chưa tới ngày bắt đầu
  r = evaluatePersonDay({ date: D, registration: { ...reg, firstMealDate: '2026-10-12' }, ...final });
  assert.equal(r.meals.breakfast.reason, 'before_start');

  // dữ liệu cũ lunchCount = 0 mà có ăn sáng => coi như có ăn trưa
  r = evaluatePersonDay({ date: D, registration: { ...reg, lunchCount: 0 }, ...final });
  assert.equal(r.meals.lunch.code, 'missing');
  // chỉ đăng ký bữa trưa
  r = evaluatePersonDay({ date: D, registration: { ...reg, breakfastCount: 0 }, ...final });
  assert.deepEqual([r.meals.breakfast.code, r.meals.breakfast.reason], ['not_registered', 'meal_not_registered']);
});

test('mealDaysOfMonth: thứ 2–6, trừ ngày nghỉ, cắt tới `until`', () => {
  // 01/10/2026 là thứ 5; tháng có 22 ngày thứ 2–6.
  assert.equal(mealDaysOfMonth('2026-10').length, 22);
  assert.equal(mealDaysOfMonth('2026-10', ['2026-10-09']).length, 21);
  assert.deepEqual(mealDaysOfMonth('2026-10', new Set(['2026-10-09']), '2026-10-14'), [
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
    '2026-10-12', '2026-10-13', '2026-10-14',
  ]);
  // Tháng 2 năm không nhuận
  assert.equal(mealDaysOfMonth('2026-02').at(-1), '2026-02-27');
  assert.equal(isMealDay('2026-10-10', []), false);
  assert.equal(isMealDay('2026-10-09', null), true);
});

test('duplicateIdsOn: chỉ mã dùng được, từ hai tài khoản, đã có hiệu lực tới ngày đó', () => {
  const D = '2026-10-09';
  const regs = [
    { userId: 'A', employeeId: '101009', breakfastCount: 1, lunchCount: 1 },
    { userId: 'B', employeeId: ' 101009 ', breakfastCount: 1, lunchCount: 1 },
    { userId: 'C', employeeId: '101010', breakfastCount: 1, lunchCount: 1 },
    { userId: 'D', employeeId: 'N/A', breakfastCount: 1, lunchCount: 1 },
    { userId: 'E', employeeId: 'N/A', breakfastCount: 1, lunchCount: 1 },
    // Z trùng mã với C nhưng nộp đơn chiều 09/10 (sau giờ ăn trưa): trùng từ 10/10.
    { userId: 'Z', employeeId: '101010', month: '2026-10', firstMealDate: D, timestamp: '2026-10-09T08:00:00.000Z', breakfastCount: 1, lunchCount: 1 },
  ];
  assert.deepEqual([...duplicateIdsOn(regs, D)], ['101009']);
  assert.deepEqual([...duplicateIdsOn(regs, '2026-10-10')].sort(), ['101009', '101010']);
});

test('registrationEffectiveFrom: muộn hơn giữa ngày bắt đầu và ngày nộp; nộp sau giờ trưa tính từ hôm sau', () => {
  assert.equal(registrationEffectiveFrom({ month: '2026-10', firstMealDate: '2026-10-05', timestamp: '2026-09-28T02:00:00.000Z' }), '2026-10-05');
  assert.equal(registrationEffectiveFrom({ month: '2026-10', firstMealDate: '2026-10-09', timestamp: '2026-10-09T02:00:00.000Z' }), '2026-10-09'); // 09:00
  assert.equal(registrationEffectiveFrom({ month: '2026-10', firstMealDate: '2026-10-09', timestamp: '2026-10-09T07:00:00.000Z' }), '2026-10-10'); // 14:00
  assert.equal(registrationEffectiveFrom({ month: '2026-10' }), '2026-10-01');
  assert.equal(registrationEffectiveFrom({}), null);
});

test('reconcile: người đăng ký trùng mã sau giờ ăn không làm "rút lại" kết luận của hôm đó', () => {
  const D = '2026-10-09';
  const regs = [
    { userId: 'X', employeeId: '101190', fullName: 'X', month: '2026-10', firstMealDate: '2026-10-01', breakfastCount: 1, lunchCount: 1 },
    { userId: 'Z', employeeId: '101190', fullName: 'Z', month: '2026-10', firstMealDate: D, timestamp: '2026-10-09T08:00:00.000Z', breakfastCount: 1, lunchCount: 1 },
  ];
  const day9 = reconcile({ byDate: {}, dates: [D], registrations: regs, cancelations: [] });
  assert.deepEqual(day9.missing.map(x => `${x.fullName}:${x.meal}`), ['X:breakfast', 'X:lunch']);
  assert.equal(day9.invalidRegs.length, 0);
  const day10 = reconcile({ byDate: {}, dates: ['2026-10-12'], registrations: regs, cancelations: [] });
  assert.equal(day10.missing.length, 0);
  assert.deepEqual(day10.invalidRegs.map(x => x.fullName).sort(), ['X', 'X', 'Z', 'Z']);
});

test('reconcile: mã trùng giữa hai đơn không vào danh sách "đăng ký nhưng không chấm"', () => {
  const D = '2026-10-09';
  const regs = [
    { userId: 'A', employeeId: '101009', fullName: 'A', breakfastCount: 1, lunchCount: 1 },
    { userId: 'B', employeeId: '101009', fullName: 'B', breakfastCount: 1, lunchCount: 1 },
    { userId: 'C', employeeId: '101010', fullName: 'C', breakfastCount: 1, lunchCount: 1 },
  ];
  const byDate = buildFromCheckins([{ date: D, people: { '101009': { name: 'X', times: ['11:30'] } } }]).byDate;
  const r = reconcile({ byDate, dates: [D], registrations: regs, cancelations: [] });
  // Chỉ C là thiếu thật; A, B nằm ở danh sách không đối soát được.
  assert.deepEqual(r.missing.map(x => `${x.fullName}:${x.meal}`), ['C:breakfast', 'C:lunch']);
  assert.deepEqual(r.invalidRegs.map(x => `${x.fullName}:${x.meal}`).sort(), ['A:breakfast', 'A:lunch', 'B:breakfast', 'B:lunch']);
  assert.ok(r.invalidRegs.every(x => /trùng/.test(x.note || '')));
  // Lượt chấm của mã trùng: ghi chú nói rõ không xác định được người ăn.
  assert.equal(r.extra.length, 1);
  assert.match(r.extra[0].note || '', /trùng/);
});

test('reconcile + evaluatePersonDay: lần hủy của tài khoản khác mang mã của mình KHÔNG hủy hộ', () => {
  const D = '2026-10-09';
  const reg = { userId: 'A', employeeId: '101001', fullName: 'A', breakfastCount: 1, lunchCount: 1 };
  const foreign = { userId: 'X', employeeId: '101001', cancelDate: D, cancelMeal: 'both' };
  const own = { userId: 'A', employeeId: 'MA_KHAC', cancelDate: D, cancelMeal: 'lunch' };
  const r = reconcile({ byDate: {}, dates: [D], registrations: [reg], cancelations: [foreign, own] });
  assert.deepEqual(r.missing.map(x => x.meal), ['breakfast']);
  const ev = evaluatePersonDay({
    date: D, registration: reg, cancelations: [foreign, own], times: [],
    coverageAt: '2026-10-09T07:00:00.000Z', now: new Date('2026-10-09T08:00:00.000Z'),
  });
  assert.equal(ev.meals.breakfast.code, 'missing');
  assert.equal(ev.meals.lunch.code, 'not_registered');
  assert.equal(ev.meals.lunch.reason, 'canceled');
});
