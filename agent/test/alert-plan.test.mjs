// Test cho việc chọn người nhận email cảnh báo và chốt an toàn. Email này nói
// với một người rằng họ vi phạm quy định — các test ưu tiên chứng minh KHÔNG
// gửi oan: chưa chốt dữ liệu, đã hủy, mã trùng, đăng ký muộn, số liệu bất thường.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePersonDay, normId } from '../lib/meal-rules.mjs';
import {
  alertGate, planAlerts, guardVerdict, uidsToLookup, selectRecipients, buildStaffBodies, buildAdminNotice,
  finalAlertStatus, matchResults, alertEntry, dateLabelOf, windowLabel, SCHOOL_EMAIL_RE, ALERT_BATCH_SIZE,
} from '../lib/alert-plan.mjs';

const D = '2026-10-08'; // thứ 5
const vn = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(h * 60 + m - 7 * 60);
  return d;
};
const NOW = vn(D, '14:00');
const COVER = vn(D, '13:50').toISOString();

const reg = (uid, employeeId, extra = {}) => ({
  uid, userId: uid, employeeId, fullName: `Người ${uid}`, breakfastCount: 20, lunchCount: 20, ...extra,
});

/** Bộ dữ liệu một ngày bình thường. */
function sample() {
  const registrations = [
    reg('u_ok', '101001'),                                   // chấm đủ
    reg('u_miss', '101002'),                                 // không chấm gì
    reg('u_lunch', '101003', { breakfastCount: 0 }),         // chỉ ăn trưa, không chấm
    reg('u_cancel_uid', '101004'),                           // hủy cả ngày (khớp theo tài khoản)
    reg('u_cancel_id', '101005'),                            // hủy bữa trưa (lần hủy cũ không có tài khoản, khớp theo mã)
    reg('u_late', '101006', { timestamp: vn(D, '13:55').toISOString() }), // đăng ký sau giờ ăn
    reg('u_mid', '101007', { timestamp: vn(D, '09:00').toISOString() }),  // đăng ký giữa buổi sáng
    reg('u_excl', '101008'),                                 // Bếp Vina
    reg('u_na', 'N/A'),
    reg('u_empty', '  '),
    reg('u_dup1', '101009'),                                 // hai đơn cùng mã
    reg('u_dup2', '101009 '),
    reg('u_out', '101010'),                                  // chỉ chấm ngoài khung
    reg('u_future', '101011', { firstMealDate: '2026-10-12' }),
  ];
  const cancelations = [
    { userId: 'u_cancel_uid', employeeId: '999999', cancelDate: D, cancelMeal: 'both' },
    { employeeId: ' 101005 ', cancelDate: D, cancelMeal: 'lunch' },
  ];
  const people = {
    '101001': { name: 'A', times: ['07:00', '11:30'] },
    '101010 ': { name: 'Out', times: ['09:10', '14:05'] },
    '101009': { name: 'Dup', times: [] },
    '200000': { name: 'Khách', times: ['11:00'] },
  };
  return { registrations, cancelations, people, excludedIds: ['101008'] };
}

test('planAlerts: chọn đúng người và bữa, khớp evaluatePersonDay từng người', () => {
  const s = sample();
  const plan = planAlerts({ date: D, ...s, offDays: [], coverageAt: COVER, now: NOW });
  const byUid = Object.fromEntries(plan.candidates.map(c => [c.uid, c.meals]));

  assert.deepEqual(byUid, {
    u_miss: ['breakfast', 'lunch'],
    u_lunch: ['lunch'],
    u_cancel_id: ['breakfast'],
    u_mid: ['lunch'],
    u_out: ['breakfast', 'lunch'],
  });

  // Đối chiếu với evaluatePersonDay gọi trực tiếp: email và trang cá nhân phải
  // cùng một kết luận.
  const taps = new Map();
  for (const [raw, p] of Object.entries(s.people)) taps.set(normId(raw), [...(taps.get(normId(raw)) || []), ...p.times]);
  for (const r of s.registrations) {
    const id = normId(r.employeeId);
    if (['u_na', 'u_empty', 'u_excl', 'u_dup1', 'u_dup2'].includes(r.uid)) continue;
    const mine = s.cancelations.filter(c => (c.userId ? c.userId === r.uid : normId(c.employeeId) === id));
    const ev = evaluatePersonDay({ date: D, registration: r, cancelations: mine, times: taps.get(id) || [], excludedIds: s.excludedIds, coverageAt: COVER, now: NOW });
    const missing = ['breakfast', 'lunch'].filter(m => ev.meals[m].code === 'missing');
    assert.deepEqual(byUid[r.uid] || [], missing, `lệch với evaluatePersonDay: ${r.uid}`);
  }

  const out = plan.candidates.find(c => c.uid === 'u_out');
  assert.deepEqual(out.outOfWindow, ['09:10', '14:05']);
  assert.equal(out.employeeId, '101010');

  assert.deepEqual(plan.skipped.unusable.sort(), ['u_empty', 'u_na']);
  assert.deepEqual(plan.skipped.excluded, ['101008']);
  assert.deepEqual(plan.skipped.duplicate, ['101009']);
  assert.equal(plan.tappers, 2, 'người có lượt trong khung: 101001 và khách 200000');

  // expected = ok | missing | pending
  assert.deepEqual(plan.stats.expected, { breakfast: 4, lunch: 5 });
  assert.deepEqual(plan.stats.missing, { breakfast: 3, lunch: 4 });
});

test('planAlerts: hủy bữa khớp theo tài khoản; lần hủy cũ không có tài khoản thì khớp theo mã', () => {
  const registrations = [reg('u1', '101001'), reg('u2', '101002'), reg('u3', '101003')];
  const cancelations = [
    // Chính chủ hủy, mã trên lần hủy đã khác mã trên đơn (từng sửa hồ sơ): vẫn là hủy.
    { userId: 'u1', employeeId: 'MA_CU_DA_SUA', cancelDate: D, cancelMeal: 'both' },
    // Tài khoản khác hủy mang mã của u2: KHÔNG hủy hộ được bữa của u2.
    { userId: 'tai_khoan_khac', employeeId: ' 101002 ', cancelDate: D, cancelMeal: 'breakfast' },
    // Dữ liệu rất cũ, lần hủy không có tài khoản: khớp theo mã đã chuẩn hoá.
    { employeeId: ' 101003 ', cancelDate: D, cancelMeal: 'lunch' },
  ];
  const plan = planAlerts({ date: D, registrations, cancelations, people: { 999: { times: ['07:00'] } }, coverageAt: COVER, now: NOW });
  assert.deepEqual(plan.candidates.map(c => [c.uid, c.meals]), [['u2', ['breakfast', 'lunch']], ['u3', ['breakfast']]]);
});

test('planAlerts: đăng ký trong ngày sau giờ ăn thì không bị cảnh báo', () => {
  const plan = planAlerts({
    date: D,
    registrations: [reg('u1', '101001', { timestamp: vn(D, '14:00').toISOString() })],
    people: { 999: { times: ['07:00'] } },
    coverageAt: COVER, now: vn(D, '14:30'),
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.stats.expected, { breakfast: 0, lunch: 0 });
});

test('planAlerts: chưa có đồng bộ đủ máy sau bữa trưa => pending, không ai bị cảnh báo bữa trưa', () => {
  const plan = planAlerts({
    date: D, registrations: [reg('u1', '101001')], people: { 999: { times: ['07:00'] } },
    coverageAt: vn(D, '08:15').toISOString(), now: NOW,
  });
  assert.deepEqual(plan.candidates.map(c => c.meals), [['breakfast']]);
  assert.deepEqual(plan.stats.expected, { breakfast: 1, lunch: 1 }, 'pending vẫn tính là đáng lẽ ăn');
  assert.deepEqual(plan.stats.missing, { breakfast: 1, lunch: 0 });

  const none = planAlerts({ date: D, registrations: [reg('u1', '101001')], people: {}, coverageAt: null, now: NOW });
  assert.deepEqual(none.candidates, []);
});

test('alertGate: ngày nghỉ, chưa tới giờ, không đủ máy, đã gửi, được đi tiếp', () => {
  const base = { now: NOW, nowVn: { date: D, time: '14:00' }, notBefore: '13:40', coverageAt: COVER, offDays: [] };

  // Thứ 7
  let g = alertGate({ ...base, date: '2026-10-10' });
  assert.equal(g.proceed, false);
  assert.equal(g.code, 'off_day');
  assert.equal(g.write.status, 'off_day');
  // Ngày nghỉ quản trị khai; đã có trạng thái thì không ghi lại.
  g = alertGate({ ...base, date: D, offDays: [D], existing: { status: 'off_day' } });
  assert.equal(g.code, 'off_day');
  assert.equal(g.write, null);

  g = alertGate({ ...base, date: D, nowVn: { date: D, time: '13:39' } });
  assert.deepEqual([g.proceed, g.code, g.write], [false, 'too_early', null]);
  // --alerts-date bỏ qua kiểm tra giờ
  g = alertGate({ ...base, date: D, nowVn: { date: D, time: '09:00' }, ignoreTime: true });
  assert.equal(g.proceed, true);

  g = alertGate({ ...base, date: D, coverageAt: null, failedDevices: ['CA_TIH'] });
  assert.equal(g.code, 'incomplete');
  assert.equal(g.write.status, 'error');
  assert.match(g.write.reason, /CA_TIH/);
  // Không ghi đè 'sent' và 'guarded'
  assert.equal(alertGate({ ...base, date: D, coverageAt: null, existing: { status: 'sent' } }).write, null);
  assert.equal(alertGate({ ...base, date: D, coverageAt: null, existing: { status: 'guarded' } }).write, null);
  // Ghi đè 'partial' nhưng giữ số đã gửi
  g = alertGate({ ...base, date: D, coverageAt: null, existing: { status: 'partial', sent: 7, failed: 2, expected: { breakfast: 9, lunch: 9 }, missing: { breakfast: 3, lunch: 4 } } });
  assert.equal(g.write.status, 'error');
  assert.equal(g.write.sent, 7);
  assert.deepEqual(g.write.missing, { breakfast: 3, lunch: 4 });

  g = alertGate({ ...base, date: D, existing: { status: 'sent' } });
  assert.deepEqual([g.proceed, g.code], [false, 'already_sent']);

  for (const status of ['partial', 'guarded', 'nothing', 'error']) {
    assert.equal(alertGate({ ...base, date: D, existing: { status } }).proceed, true, status);
  }
});

test('guardVerdict: không ai chấm trong khung => dừng', () => {
  const stats = { expected: { breakfast: 100, lunch: 100 }, missing: { breakfast: 0, lunch: 0 } };
  assert.equal(guardVerdict({ stats, tappers: 0, minExpected: 20, maxMissingRatio: 0.4 }).stop, true);

  // Chỉ có lượt ngoài khung thì planAlerts đếm tappers = 0
  const plan = planAlerts({ date: D, registrations: [reg('u1', '101001')], people: { 101001: { times: ['09:00', '15:00'] } }, coverageAt: COVER, now: NOW });
  assert.equal(plan.tappers, 0);
  assert.equal(guardVerdict({ stats: plan.stats, tappers: plan.tappers, minExpected: 20, maxMissingRatio: 0.4 }).stop, true);
});

test('guardVerdict: tỉ lệ chưa chấm, chỉ xét khi đủ minExpected', () => {
  const v = (expected, missing, meal = 'lunch') => guardVerdict({
    stats: {
      expected: { breakfast: meal === 'breakfast' ? expected : 50, lunch: meal === 'lunch' ? expected : 50 },
      missing: { breakfast: meal === 'breakfast' ? missing : 0, lunch: meal === 'lunch' ? missing : 0 },
    },
    tappers: 30, minExpected: 20, maxMissingRatio: 0.4,
  });
  assert.equal(v(10, 10).stop, false, 'dưới minExpected: không xét tỉ lệ');
  assert.equal(v(19, 19).stop, false);
  assert.equal(v(20, 8).stop, false, '40% chưa VƯỢT ngưỡng 40%');
  const s = v(20, 9);
  assert.equal(s.stop, true);
  assert.match(s.reason, /Bữa trưa: 9\/20/);
  assert.equal(v(100, 41, 'breakfast').stop, true);
  assert.equal(guardVerdict({ stats: { expected: { breakfast: 0, lunch: 0 }, missing: { breakfast: 0, lunch: 0 } }, tappers: 5, minExpected: 0, maxMissingRatio: 0.4 }).stop, false, 'không chia cho 0');
});

test('người nhận: bỏ người đã gửi, thiếu email, email ngoài trường', () => {
  const candidates = [
    { uid: 'a', employeeId: '1', fullName: 'A', meals: ['lunch'], outOfWindow: [] },
    { uid: 'b', employeeId: '2', fullName: 'B', meals: ['lunch'], outOfWindow: [] },
    { uid: 'c', employeeId: '3', fullName: 'C', meals: ['lunch'], outOfWindow: [] },
    { uid: 'd', employeeId: '4', fullName: 'D', meals: ['lunch'], outOfWindow: [] },
    { uid: 'e', employeeId: '5', fullName: 'E', meals: ['lunch'], outOfWindow: [] },
  ];
  const alreadySent = new Set(['a']);
  assert.deepEqual(uidsToLookup(candidates, alreadySent), ['b', 'c', 'd', 'e']);
  const emails = new Map([
    ['a', 'a@hoangmaistarschool.edu.vn'],
    ['b', 'B.Thay@HoangMaiStarSchool.edu.vn'],
    ['c', 'c@gmail.com'],
    ['e', 'e@hoangmaistarschool.edu.vn.evil.com'],
  ]);
  const { recipients, skipped } = selectRecipients({ candidates, alreadySent, emails });
  assert.deepEqual(recipients.map(r => [r.uid, r.to]), [['b', 'B.Thay@HoangMaiStarSchool.edu.vn']]);
  assert.deepEqual(skipped, { alreadySent: ['a'], noEmail: ['d'], outsideDomain: ['c', 'e'], duplicateEmail: [] });
  assert.equal(SCHOOL_EMAIL_RE.test('x y@hoangmaistarschool.edu.vn'), false);
});

test('người nhận: địa chỉ endpoint sẽ từ chối cả lô thì loại trước', () => {
  const c = uid => ({ uid, employeeId: '1', fullName: 'X', meals: ['lunch'], outOfWindow: [] });
  const { recipients, skipped } = selectRecipients({
    candidates: [c('a'), c('b'), c('c'), c('d')],
    alreadySent: new Set(),
    emails: new Map([
      ['a', 'a@hoangmaistarschool.edu.vn'],
      ['b', 'A@HOANGMAISTARSCHOOL.EDU.VN'],      // trùng địa chỉ, khác hoa thường
      ['c', 'thầy@hoangmaistarschool.edu.vn'],   // không phải ASCII
      ['d', `${'x'.repeat(250)}@hoangmaistarschool.edu.vn`],
    ]),
  });
  assert.deepEqual(recipients.map(r => r.uid), ['a']);
  assert.deepEqual(skipped.duplicateEmail, ['b']);
  assert.deepEqual(skipped.outsideDomain, ['c', 'd']);
});

test('họ tên / mã có ký tự điều khiển được làm sạch (endpoint từ chối cả lô nếu còn)', () => {
  const plan = planAlerts({
    date: D,
    registrations: [reg('u1', '101001', { fullName: 'Nguyễn\tVăn\nAn ' })],
    people: { 999: { times: ['07:00'] } },
    coverageAt: COVER, now: NOW,
  });
  assert.equal(plan.candidates[0].fullName, 'Nguyễn Văn An');
  const [{ body }] = buildStaffBodies({ date: D, recipients: [{ ...plan.candidates[0], to: 'u1@hoangmaistarschool.edu.vn', employeeId: '1'.repeat(60) }] });
  assert.equal(body.alerts[0].employeeId.length, 40);
  assert.doesNotMatch(JSON.stringify(body), /\\[tn]/);
});

test('buildStaffBodies: đúng dạng Body A, chia lô', () => {
  const recipients = Array.from({ length: ALERT_BATCH_SIZE + 3 }, (_, i) => ({
    uid: `u${i}`, to: `u${i}@hoangmaistarschool.edu.vn`, employeeId: `10${i}`, fullName: `Người ${i}`,
    meals: ['breakfast', 'lunch'], outOfWindow: Array.from({ length: 12 }, (_, k) => `14:${String(k).padStart(2, '0')}`),
  }));
  const bodies = buildStaffBodies({ date: '2026-10-09', recipients });
  assert.equal(bodies.length, 2);
  assert.ok(ALERT_BATCH_SIZE <= 20);
  const b = bodies[0].body;
  assert.equal(b.kind, 'staff-missing');
  assert.equal(b.dateLabel, 'Thứ 6, 09/10/2026');
  assert.equal(b.alerts.length, ALERT_BATCH_SIZE);
  assert.deepEqual(b.alerts[0].meals, [
    { meal: 'breakfast', label: 'Bữa sáng', window: '05:00–08:00' },
    { meal: 'lunch', label: 'Bữa trưa', window: '10:00–13:30' },
  ]);
  assert.match(b.alerts[0].meals[0].window, /^\d{2}:\d{2}–\d{2}:\d{2}$/);
  assert.equal(b.alerts[0].outOfWindow.length, 10);
  assert.equal(bodies[1].group.length, 3);
  assert.equal(windowLabel('lunch'), '10:00–13:30');
  assert.equal(dateLabelOf('2026-10-08'), 'Thứ 5, 08/10/2026');
});

test('matchResults: chỉ coi là đã gửi khi endpoint báo ok cho đúng người', () => {
  const group = [{ to: 'a@hoangmaistarschool.edu.vn' }, { to: 'b@hoangmaistarschool.edu.vn' }, { to: 'c@hoangmaistarschool.edu.vn' }];
  const res = matchResults(group, { results: [
    { to: 'A@hoangmaistarschool.edu.vn', ok: true },
    { to: 'c@hoangmaistarschool.edu.vn', ok: true },  // lệch thứ tự
  ] });
  assert.deepEqual(res.map(r => r.ok), [true, false, false]);
  assert.deepEqual(matchResults(group, null).map(r => r.ok), [false, false, false]);
  assert.equal(matchResults([group[0]], { results: [{ to: group[0].to, ok: false, error: 'Graph 500' }] })[0].error, 'Graph 500');
});

test('buildAdminNotice: chỉ email trường, tối đa 5, giới hạn độ dài, không có tên người', () => {
  const n = buildAdminNotice({
    date: D,
    adminEmails: ['dinhduong@hoangmaistarschool.edu.vn', 'x@gmail.com', ...Array.from({ length: 6 }, (_, i) => `a${i}@hoangmaistarschool.edu.vn`)],
    reason: 'x'.repeat(2000),
    stats: { expected: { breakfast: 50, lunch: 60 }, missing: { breakfast: 40, lunch: 50 } },
    tappers: 3,
    devices: [{ name: 'CA_TrH', ok: true, events: 5, error: null }, { name: 'CA_TIH', ok: false, events: 0, error: 'y'.repeat(500) }],
    agentVersion: '2026-10-09.1',
  });
  assert.equal(n.kind, 'admin-notice');
  assert.equal(n.to.length, 5);
  assert.ok(n.to.every(e => SCHOOL_EMAIL_RE.test(e)));
  assert.equal(n.reason.length, 1000);
  assert.ok(n.lines.length <= 30);
  assert.ok(n.lines.every(l => l.length <= 300));
  assert.match(n.lines[0], /Bữa sáng: 40\/50/);

  // Lỗi thiết bị nhiều dòng, email quản trị trùng: vẫn ra yêu cầu hợp lệ.
  const m = buildAdminNotice({
    date: D,
    adminEmails: ['dinhduong@hoangmaistarschool.edu.vn', 'DinhDuong@hoangmaistarschool.edu.vn'],
    reason: 'dòng 1\ndòng 2',
    stats: { expected: { breakfast: 1, lunch: 1 }, missing: { breakfast: 1, lunch: 1 } },
    tappers: 0,
    devices: [{ name: 'CA_TIH', ok: false, events: 0, error: 'Thiết bị từ chối mọi kiểu yêu cầu đã thử:\n      - kiểu 1: HTTP 400\n      - kiểu 2: HTTP 400' }],
    agentVersion: 'v',
  });
  assert.deepEqual(m.to, ['dinhduong@hoangmaistarschool.edu.vn']);
  assert.equal(m.reason, 'dòng 1 dòng 2');
  assert.ok(m.lines.every(l => !/[\u0000-\u001f]/.test(l)), 'mỗi dòng phải là một dòng');
});

test('finalAlertStatus và alertEntry', () => {
  assert.equal(finalAlertStatus({ missingCount: 5, failed: 1 }), 'partial');
  assert.equal(finalAlertStatus({ missingCount: 0, failed: 0 }), 'nothing');
  assert.equal(finalAlertStatus({ missingCount: 5, failed: 0 }), 'sent');
  const e = alertEntry('sent', '2026-10-08T07:00:00.000Z', { sent: 3 });
  assert.deepEqual(e, {
    status: 'sent', at: '2026-10-08T07:00:00.000Z', held: false, sent: 3, failed: 0,
    expected: { breakfast: 0, lunch: 0 }, missing: { breakfast: 0, lunch: 0 }, reason: null,
  });
  assert.equal(alertEntry('guarded', 'x', { held: true }).held, true);
  // Lý do ghi vào settings (mọi người đọc được) không được lộ địa chỉ email.
  const p = alertEntry('partial', 'x', { reason: "1 email chưa gửi được (Graph 400: Recipient 'an.nv@hoangmaistarschool.edu.vn' invalid)" });
  assert.equal(p.reason, "1 email chưa gửi được (Graph 400: Recipient '[email]' invalid)");
});

test('planAlerts: đơn trùng mã nộp sau giờ ăn hôm nay không làm mất cảnh báo của người đăng ký trước', () => {
  const registrations = [
    reg('uX', '101190', { month: D.slice(0, 7), firstMealDate: `${D.slice(0, 7)}-01` }),
    reg('uZ', '101190', { month: D.slice(0, 7), firstMealDate: D, timestamp: vn(D, '14:00').toISOString() }),
  ];
  const plan = planAlerts({ date: D, registrations, people: { 999: { times: ['07:00'] } }, coverageAt: COVER, now: NOW });
  assert.deepEqual(plan.candidates.map(c => [c.uid, c.meals]), [['uX', ['breakfast', 'lunch']]]);
  assert.deepEqual(plan.skipped.duplicate, []);
  // Hôm sau cả hai đơn đều có hiệu lực: trùng mã, không cảnh báo ai.
  const next = '2026-10-12';
  const later = planAlerts({ date: next, registrations, people: { 999: { times: ['07:00'] } }, coverageAt: vn(next, '13:50').toISOString(), now: vn(next, '14:00') });
  assert.deepEqual(later.candidates, []);
  assert.deepEqual(later.skipped.duplicate, ['101190']);
});

test('alertGate: ngày đang bị treo (held) vẫn treo khi lần chạy sau lỗi máy', () => {
  const nowVn = { date: D, time: '14:00' };
  const existing = { status: 'error', held: true, reason: 'chốt an toàn', expected: { breakfast: 9, lunch: 9 }, missing: { breakfast: 9, lunch: 9 } };
  const g = alertGate({ date: D, now: NOW, nowVn, notBefore: '13:40', coverageAt: null, failedDevices: ['CA_TIH'], existing });
  assert.equal(g.code, 'incomplete');
  assert.equal(g.write.held, true);
});
