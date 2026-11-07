// Thư "chấm ăn nhưng chưa đăng ký": ai nhận, gắn mã NV với tài khoản thế nào.
// Mã trên máy CHỈ được gắn với tài khoản qua đơn đăng ký — hồ sơ staff/{uid} do
// chính chủ tự sửa nên không bao giờ là căn cứ (đổi mã trong hồ sơ là "nhận" được
// giờ ăn của người khác).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planAlerts, planExtraAlerts, buildStaffBodies, sentAlertsByKind, alertJournalKey, guardVerdict, matchResults,
} from '../lib/alert-plan.mjs';

const P = '2026-11-06';                              // thứ 6 — ngày xét
const now = new Date('2026-11-09T06:50:00Z');        // 13:50 thứ 2 tuần sau (lần chạy của ngày kế tiếp)
const coverageAt = '2026-11-06T06:45:00Z';           // 13:45 ngày xét: cả hai bữa đã chốt
const reg = (uid, employeeId, more = {}) => ({
  uid, userId: uid, employeeId, fullName: `Người ${uid}`, month: '2026-11', email: `${uid}@hoangmaistarschool.edu.vn`,
  breakfastCount: 20, lunchCount: 20, firstMealDate: '2026-11-02', timestamp: '2026-10-28T03:00:00Z', ...more,
});
const back = (uid, employeeId, month, more = {}) => reg(uid, employeeId, { month, firstMealDate: `${month}-01`, timestamp: `${month}-01T01:00:00Z`, ...more });
const base = { date: P, now, coverageAt, registrations: [], lookback: [], people: { 100001: { times: ['07:10', '11:45'] } } };

test('chấm chưa đăng ký: chỉ lượt chấm trong khung của bữa đã chốt, lý do lấy từ đơn tháng', () => {
  // Đơn chỉ có bữa trưa, chấm cả hai bữa: chỉ bữa sáng là chưa đăng ký.
  let plan = planExtraAlerts({ ...base, registrations: [reg('a', '100001', { breakfastCount: 0 })] });
  assert.deepEqual(plan.candidates.map(c => [c.uid, c.meals, c.tapTimes, c.reasons, c.anchor]), [
    ['a', ['breakfast'], { breakfast: '07:10' }, { breakfast: 'meal_not_registered' }, 'month'],
  ]);
  // Báo hủy bữa trưa (theo tài khoản) mà vẫn chấm.
  plan = planExtraAlerts({ ...base, registrations: [reg('a', '100001')], cancelations: [{ userId: 'a', cancelDate: P, cancelMeal: 'lunch' }] });
  assert.deepEqual(plan.candidates.map(c => [c.meals, c.reasons]), [[['lunch'], { lunch: 'canceled' }]]);
  // Đơn nộp từ hôm sau, bắt đầu ăn từ hôm sau: ngày xét chưa có suất.
  plan = planExtraAlerts({ ...base, registrations: [reg('a', '100001', { firstMealDate: '2026-11-09', timestamp: '2026-11-09T01:00:00Z' })] });
  assert.deepEqual(plan.candidates[0].reasons, { breakfast: 'before_start', lunch: 'before_start' });
  // Ăn trước rồi nộp đơn chiều cùng ngày (hay gặp đầu tháng): tính là đã đăng ký.
  plan = planExtraAlerts({ ...base, registrations: [reg('a', '100001', { firstMealDate: P, timestamp: '2026-11-06T07:30:00Z' })] });
  assert.deepEqual(plan.candidates, []);
  // Đã đăng ký đủ: không phải chấm chưa đăng ký.
  assert.deepEqual(planExtraAlerts({ ...base, registrations: [reg('a', '100001')] }).candidates, []);
});

test('chấm chưa đăng ký: chưa chốt / ngày nghỉ / lượt ngoài khung thì không xét', () => {
  const registrations = [reg('a', '100001', { breakfastCount: 0, lunchCount: 0 })];
  // Mốc chốt 08:15: mới chốt bữa sáng.
  let plan = planExtraAlerts({ ...base, registrations, coverageAt: '2026-11-06T01:15:00Z' });
  assert.deepEqual(plan.meals, ['breakfast']);
  assert.deepEqual(plan.candidates[0].meals, ['breakfast']);
  plan = planExtraAlerts({ ...base, registrations, coverageAt: null });
  assert.deepEqual([plan.meals, plan.candidates], [[], []]);
  assert.deepEqual(planExtraAlerts({ ...base, registrations, offDays: [P] }).candidates, []);
  plan = planExtraAlerts({ ...base, registrations, people: { 100001: { times: ['09:30', '14:00'] } } });
  assert.deepEqual([plan.candidates, plan.tappers], [[], 0]);
});

test('chấm chưa đăng ký: mã Bếp Vina, mã không đủ 6 chữ số, danh sách loại trừ không tính', () => {
  const people = { 100001: { times: ['11:00'] }, 123: { times: ['11:05'] }, 'BV01': { times: ['11:10'] }, 100002: { times: ['11:20'] } };
  const plan = planExtraAlerts({ ...base, people, excludedIds: ['100002'], registrations: [reg('a', '100001', { lunchCount: 0, breakfastCount: 0 })] });
  assert.deepEqual(plan.candidates.map(c => c.uid), ['a']);
  assert.deepEqual(plan.skipped.excluded.sort(), ['100002', '123', 'BV01']);
  assert.equal(plan.tappers, 1, 'chỉ đếm mã NV của trường, không tính bếp');
});

test('chấm chưa đăng ký: mã đứng trên đơn của hai tài khoản thì không gửi ai', () => {
  const plan = planExtraAlerts({ ...base, registrations: [reg('a', '100001', { breakfastCount: 0 }), reg('b', '100001 ', { breakfastCount: 0 })] });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped.duplicate, ['100001']);
});

test('chấm chưa đăng ký: hồ sơ staff không bao giờ là căn cứ gửi thư', () => {
  // Bản trước tra cả collection staff; bây giờ không có đơn nào mang mã thì không gửi.
  const plan = planExtraAlerts({ ...base, staff: [{ uid: 'a', employeeId: '100001', fullName: 'A' }] });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped.unmapped, ['100001']);
});

test('chưa có đơn tháng: chỉ đọc 3 tháng trước khi cần; gắn khi đúng một tài khoản từng mang mã đó', () => {
  // Chưa đọc đơn các tháng trước: báo cần đọc, chưa gửi ai.
  let plan = planExtraAlerts({ ...base, lookback: null });
  assert.equal(plan.needsLookback, true);
  assert.deepEqual([plan.candidates, plan.skipped.unmapped], [[], ['100001']]);
  // Mọi mã đều có đơn tháng: không cần đọc thêm.
  assert.equal(planExtraAlerts({ ...base, lookback: null, registrations: [reg('a', '100001')] }).needsLookback, false);

  // Đơn tháng 9 và 10 cùng mã, cùng tài khoản: gắn, lý do "chưa có đăng ký tháng này".
  plan = planExtraAlerts({ ...base, lookback: [back('a', '100001', '2026-09', { fullName: 'Tên cũ' }), back('a', '100001', '2026-10', { fullName: 'Tên mới' })] });
  assert.deepEqual(plan.candidates.map(c => [c.uid, c.meals, c.reasons, c.anchor, c.fullName]), [
    ['a', ['breakfast', 'lunch'], { breakfast: 'no_registration', lunch: 'no_registration' }, 'lookback', 'Tên mới'],
  ]);
});

test('chưa có đơn tháng: mâu thuẫn trong 3 tháng trước thì không gắn (unmapped)', () => {
  const cases = {
    'hai tài khoản từng mang mã': { lookback: [back('a', '100001', '2026-10'), back('b', '100001', '2026-08')] },
    'tài khoản từng mang mã khác': { lookback: [back('a', '100001', '2026-10'), back('a', '100009', '2026-09')] },
    'tài khoản đã có đơn tháng này mang mã khác': { lookback: [back('a', '100001', '2026-10')], registrations: [reg('a', '100009')] },
    'tài khoản đã có đơn tháng này chưa có mã': { lookback: [back('a', '100001', '2026-10')], registrations: [reg('a', 'N/A')] },
    'không ai từng mang mã': { lookback: [back('b', '100002', '2026-10')] },
  };
  for (const [name, more] of Object.entries(cases)) {
    const plan = planExtraAlerts({ ...base, ...more });
    assert.deepEqual(plan.candidates, [], name);
    assert.deepEqual(plan.skipped.unmapped, ['100001'], name);
  }
});

test('miễn chấm bữa trưa: bữa sáng vẫn phải chấm; không ảnh hưởng thư chấm chưa đăng ký', () => {
  const checkinExemptions = [{ employeeId: '100001', email: 'a@hoangmaistarschool.edu.vn', fullName: 'A', periods: [{ from: P, to: null }] }];
  const plan = planAlerts({ ...base, registrations: [reg('a', '100001')], people: {}, checkinExemptions });
  assert.deepEqual(plan.candidates[0].meals, ['breakfast']);
  assert.deepEqual(plan.stats.expected, { breakfast: 1, lunch: 1 });
  assert.deepEqual(plan.stats.exempt, { breakfast: 0, lunch: 1 });
  // Thư chấm chưa đăng ký không nhận danh sách miễn chấm: miễn chấm không tạo suất ăn.
  const extra = planExtraAlerts({ ...base, registrations: [reg('a', '100001', { breakfastCount: 0, lunchCount: 0 })] });
  assert.deepEqual(extra.candidates[0].meals, ['breakfast', 'lunch']);
});

test('người được miễn chấm không làm loãng ngưỡng chốt an toàn thiếu chấm', () => {
  const stats = { expected: { breakfast: 0, lunch: 100 }, missing: { breakfast: 0, lunch: 15 }, exempt: { breakfast: 0, lunch: 75 } };
  assert.equal(guardVerdict({ stats, tappers: 10, minExpected: 20, maxMissingRatio: 0.4 }).stop, true);
});

test('chỉ miễn bữa sáng thì bữa trưa vẫn phải chấm', () => {
  const checkinExemptions = [{ employeeId: '100001', email: 'a@hoangmaistarschool.edu.vn', fullName: 'A',
    periods: [{ from: P, to: null, meals: ['breakfast'] }] }];
  const plan = planAlerts({ ...base, registrations: [reg('a', '100001')], people: {}, checkinExemptions });
  assert.deepEqual(plan.candidates[0].meals, ['lunch']);
  assert.deepEqual(plan.stats.exempt, { breakfast: 1, lunch: 0 });
});

test('nhật ký: khoá cũ là thư thiếu chấm, extra có khoá riêng; biên nhận chưa rõ cũng không tự gửi lại', () => {
  const journals = sentAlertsByKind([{ uid: 'a' }, { uid: 'b', kind: 'missing' },
    { uid: 'a', kind: 'extra' }, { uid: 'c', kind: 'extra', delivery: 'uncertain' }, { uid: '../bad', kind: 'extra' }]);
  assert.deepEqual(Object.keys(journals).sort(), ['extra', 'missing']);
  assert.deepEqual([...journals.missing], ['a', 'b']);
  assert.deepEqual([...journals.extra], ['a', 'c']);
  assert.equal(alertJournalKey(P, 'a'), `${P}_a`);
  assert.equal(alertJournalKey(P, 'a', 'extra'), `${P}:extra:a`);
  assert.notEqual(alertJournalKey(P, 'extra_a'), alertJournalKey(P, 'a', 'extra'));
  // Mặc định của matchResults vẫn giữ xử lý cũ cho thư thiếu chấm.
  assert.deepEqual(matchResults([{ to: 'a@hoangmaistarschool.edu.vn' }], {
    results: [{ to: 'a@hoangmaistarschool.edu.vn', ok: false, maybeSent: true, error: 'timeout' }],
  }), [{ ok: false, error: 'timeout' }]);
});

test('lô staff-extra: đúng kind, giờ chấm và mã lý do từng bữa; không gửi uid', () => {
  const candidate = planExtraAlerts({ ...base, lookback: [back('a', '100001', '2026-10')] }).candidates[0];
  const [{ body }] = buildStaffBodies({ date: P, kind: 'extra', recipients: [{ ...candidate, to: 'a@hoangmaistarschool.edu.vn' }] });
  assert.equal(body.kind, 'staff-extra');
  assert.equal(body.date, P);
  assert.deepEqual(body.alerts[0].meals[1], { meal: 'lunch', label: 'Bữa trưa', window: '10:00–13:30', time: '11:45', reason: 'no_registration' });
  assert.equal(Object.hasOwn(body.alerts[0], 'uid'), false);
  assert.equal(Object.hasOwn(body.alerts[0], 'anchor'), false);
});
