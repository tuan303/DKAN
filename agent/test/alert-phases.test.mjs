// Hai loại thư của pha cảnh báo (bản 2026-11-06.1): ngày xét của từng loại, cửa
// chặn riêng của thư chấm chưa đăng ký, trạng thái 'sent' của thư thiếu chấm
// không bị mở lại, danh sách miễn chấm hỏng, chốt an toàn, suất ăn sự kiện, gửi
// và ghi nhật ký, API email bản cũ, mẫu số không tính người được miễn chấm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  alertGate, alertDates, previousMealDay, extraGate, extraEntry, isTerminalExtraStatus, TERMINAL_EXTRA_STATUSES,
  planAlerts, exemptionHold, exemptionAudit, extraGuard, relevantEventIds, eventSkipUids, lookbackMonths,
  deliverAlerts, deliveryNotes, sentAlertsByKind, alertEntry, buildAdminNotice, buildExtraAdminNotice, mealCounts, OLD_API_EXTRA_REASON,
} from '../lib/alert-plan.mjs';
import { parseCheckinExemptionDocs, exemptionQuarantine } from '../lib/checkin-exemptions.mjs';
import { EndpointError, isOldApiKindRejection } from '../lib/endpoint.mjs';
import { buildSyncSettings } from '../lib/sync-merge.mjs';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vn = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(h * 60 + m - 7 * 60);
  return d;
};
const MON = '2026-11-09';
const FRI = '2026-11-06';
const NOW = vn(MON, '13:50');
const nowVn = { date: MON, time: '13:50' };

// ----------------------------------------------------------- ngày xét

test('ngày có suất ăn trước đó: qua cuối tuần, ngày nghỉ, sang tháng trước; nghỉ dài thì không có', () => {
  assert.equal(previousMealDay(MON), FRI, 'thứ 2 -> thứ 6 tuần trước');
  assert.equal(previousMealDay('2026-11-10', [MON]), FRI, 'thứ 2 là ngày nghỉ -> lùi tiếp');
  assert.equal(previousMealDay('2026-12-01'), '2026-11-30', 'sang tháng trước');
  assert.equal(previousMealDay('2026-11-02'), '2026-10-30', 'đầu tháng lùi về thứ 6 tháng trước');
  const tet = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  assert.equal(previousMealDay(MON, tet), null, 'cả 7 ngày trước đều nghỉ');
  assert.equal(previousMealDay('2026-11-10', tet), MON);
});

test('thư chấm chưa đăng ký xét ngày có suất ăn TRƯỚC hôm nay; --alerts-date xét đúng ngày đó', () => {
  assert.deepEqual(alertDates({ today: MON }), { missing: MON, extra: FRI });
  assert.deepEqual(alertDates({ today: '2026-11-10', offDays: [MON] }), { missing: '2026-11-10', extra: FRI });
  assert.deepEqual(alertDates({ today: MON, alertsDate: '2026-11-05' }), { missing: '2026-11-05', extra: '2026-11-05' });
});

test('đơn 3 tháng trước: qua năm cũ', () => {
  assert.deepEqual(lookbackMonths('2026-11'), ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(lookbackMonths('2026-01'), ['2025-12', '2025-11', '2025-10']);
});

// ------------------------------------------- 'sent' của thư thiếu chấm là xong hẳn

test("thư thiếu chấm: 'sent' là xong — mọi lần chạy sau dừng ở cửa chặn, không ghi đè", () => {
  const base = { date: MON, now: NOW, nowVn, notBefore: '13:40', offDays: [], coverageAt: vn(MON, '13:45').toISOString() };
  const sent = { status: 'sent', sent: 12, held: false };
  for (const [name, input] of Object.entries({
    'bình thường': {},
    'máy lỗi, chưa chốt': { coverageAt: null, failedDevices: ['CA_TIH'] },
    'máy không có lượt nào': { coverageAt: null, idleDevices: ['CA_TIH'] },
    'cấu hình sai': { configProblems: ['alerts.secret đang trống.'] },
  })) {
    const g = alertGate({ ...base, ...input, existing: sent });
    assert.equal(g.proceed, false, name);
    assert.equal(g.write, null, `${name}: không ghi đè 'sent'`);
    assert.notEqual(g.code, 'device_idle', `${name}: không đi đường chốt an toàn / báo quản trị`);
  }
  // Các trạng thái khác vẫn được xét lại như trước.
  for (const status of ['partial', 'error', 'nothing', 'guarded']) assert.equal(alertGate({ ...base, existing: { status } }).proceed, true, status);
});

test("agent không còn biến 'sent' thành 'partial' để xét lại thư thiếu chấm", () => {
  const src = readFileSync(join(AGENT, 'sync-checkins.mjs'), 'utf8');
  assert.doesNotMatch(src, /status:\s*'partial'\s*\}\s*:\s*existing/);
  assert.match(src, /const gate = alertGate\(\{[\s\S]*?\r?\n\s+existing,\r?\n/);
  // Không còn tra hồ sơ staff để gắn mã cho thư chấm chưa đăng ký.
  assert.doesNotMatch(src, /collection\('staff'\)/);
  // Thư chấm chưa đăng ký chỉ ghi alerts[ngày].extra; agent ghi agentFeatures cạnh agentVersion.
  assert.match(src, /settingsRef\.set\(\{ alerts: \{ \[date\]: \{ extra: entry \} \} \}, \{ merge: true \}\)/);
  assert.match(src, /const AGENT_FEATURES = \['checkinExemptions', 'extraAlerts'\];/);
  assert.match(src, /agentFeatures: AGENT_FEATURES/);
});

// ------------------------------------------- cửa chặn thư chấm chưa đăng ký

test('cửa chặn thư chấm chưa đăng ký: độc lập với thư thiếu chấm hôm nay', () => {
  const base = { date: FRI, now: NOW, nowVn, notBefore: '13:40', offDays: [], coverageAt: vn(FRI, '13:45').toISOString() };
  // Thư thiếu chấm hôm nay đã 'sent' hay chưa đủ máy cũng không liên quan.
  assert.equal(alertGate({ date: MON, now: NOW, nowVn, notBefore: '13:40', coverageAt: null, failedDevices: ['CA_TIH'], existing: { status: 'sent' } }).proceed, false);
  let g = extraGate(base);
  assert.deepEqual([g.proceed, g.code, g.meals], [true, 'ok', ['breakfast', 'lunch']]);
  // Trạng thái xong hẳn: không xét lại, không ghi gì, kể cả khi cấu hình sai hay chưa chốt.
  for (const status of TERMINAL_EXTRA_STATUSES) {
    g = extraGate({ ...base, coverageAt: null, configProblems: ['x'], existing: { status } });
    assert.deepEqual([g.proceed, g.code, g.write], [false, 'done', null], status);
    assert.equal(isTerminalExtraStatus(status), true);
  }
  for (const status of ['partial', 'error', undefined]) {
    assert.equal(isTerminalExtraStatus(status), false);
    assert.equal(extraGate({ ...base, existing: status ? { status } : null }).proceed, true, String(status));
  }
});

test('cửa chặn thư chấm chưa đăng ký: cấu hình, giờ, dữ liệu chốt của chính ngày đó', () => {
  const base = { date: FRI, now: NOW, nowVn, notBefore: '13:40', offDays: [], coverageAt: vn(FRI, '13:45').toISOString() };
  const existing = { status: 'partial', candidates: 7, sent: 5, failed: 2, unmapped: 1, eventSkipped: 0 };
  let g = extraGate({ ...base, existing, configProblems: ['alerts.secret đang trống.'] });
  assert.equal(g.code, 'bad_config');
  assert.equal(g.write.status, 'error');
  assert.deepEqual([g.write.sent, g.write.candidates, g.write.unmapped], [5, 7, 1], 'giữ số của lần trước');
  assert.match(g.write.reason, /secret đang trống/);
  assert.equal(extraGate({ ...base, notBefore: '1:40' }).code, 'bad_config', 'notBefore sai dạng không thành "chưa tới giờ" mãi');

  g = extraGate({ ...base, nowVn: { date: MON, time: '13:39' } });
  assert.deepEqual([g.code, g.write], ['too_early', null]);
  assert.equal(extraGate({ ...base, nowVn: { date: MON, time: '09:00' }, ignoreTime: true }).proceed, true);

  g = extraGate({ ...base, coverageAt: null });
  assert.equal(g.code, 'no_coverage');
  assert.equal(g.write.status, 'error');
  assert.match(g.write.reason, /06\/11\/2026/);
  // Ngày đã qua mà mới chốt bữa sáng (mốc đủ máy cuối là lần 08:15): chưa xử lý,
  // để lần sau (22:00 lấy lại 7 ngày) chốt đủ rồi xét cả bữa trưa — không đóng
  // trạng thái sớm làm mất thư của bữa trưa.
  g = extraGate({ ...base, coverageAt: vn(FRI, '08:15').toISOString() });
  assert.deepEqual([g.proceed, g.code, g.meals, g.write.status], [false, 'no_coverage', ['breakfast'], 'error']);
  assert.match(g.write.reason, /chưa chốt dữ liệu bữa trưa/);
  // Xem trước cho chính hôm nay (--alerts-date hôm nay) thì xét các bữa đã chốt.
  g = extraGate({ ...base, coverageAt: vn(FRI, '08:15').toISOString(), nowVn: { date: FRI, time: '09:00' }, ignoreTime: true });
  assert.deepEqual([g.proceed, g.meals], [true, ['breakfast']]);
  // --alerts-date vào ngày nghỉ (chỉ xem thử).
  g = extraGate({ ...base, date: '2026-11-07', ignoreTime: true });
  assert.deepEqual([g.code, g.write.status], ['off_day', 'off_day']);
});

test('ngày bị chốt an toàn của thư thiếu chấm treo lại (held): không gửi thư chấm chưa đăng ký, xong hẳn', () => {
  const base = { date: FRI, now: NOW, nowVn, notBefore: '13:40', offDays: [], coverageAt: vn(FRI, '13:45').toISOString() };
  const g = extraGate({ ...base, held: true, existing: { status: 'error', sent: 0 } });
  assert.deepEqual([g.proceed, g.code, g.write.status], [false, 'held', 'guarded']);
  assert.match(g.write.reason, /chưa kết luận ngày này/);
  assert.equal(isTerminalExtraStatus(g.write.status), true, 'lần sau không xét lại, không báo quản trị lại');
  // Chưa tới giờ thì chưa làm gì; đã xong thì không ghi đè.
  assert.equal(extraGate({ ...base, held: true, nowVn: { date: MON, time: '09:00' } }).write, null);
  assert.equal(extraGate({ ...base, held: true, existing: { status: 'sent' } }).code, 'done');
  // Agent đọc cờ held của chính ngày xét.
  const src = readFileSync(join(AGENT, 'sync-checkins.mjs'), 'utf8');
  assert.match(src, /held: syncDoc\.alerts\?\.\[date\]\?\.held === true,/);
});

test('alerts[ngày].extra: chỉ số đếm, đủ mọi trường, che email trong lý do', () => {
  const e = extraEntry('partial', '2026-11-09T06:50:00.000Z', { candidates: 3, sent: 2, failed: 1, unmapped: 4, eventSkipped: 1,
    reason: "1 email chưa gửi được (Graph 400: Recipient 'an.nv@hoangmaistarschool.edu.vn' invalid)" });
  assert.deepEqual(Object.keys(e), ['status', 'at', 'candidates', 'sent', 'failed', 'unmapped', 'eventSkipped', 'reason']);
  assert.equal(e.reason, "1 email chưa gửi được (Graph 400: Recipient '[email]' invalid)");
  assert.deepEqual(extraEntry('nothing', 'x'), { status: 'nothing', at: 'x', candidates: 0, sent: 0, failed: 0, unmapped: 0, eventSkipped: 0, reason: null });
});

// ------------------------------------------- danh sách miễn chấm hỏng

const goodPolicy = code => ({ id: code, data: { employeeId: code, email: `u${code}@hoangmaistarschool.edu.vn`, fullName: 'X', periods: [{ from: '2026-11-01', to: null, meals: ['lunch'] }] } });
const reg = (uid, employeeId, more = {}) => ({
  uid, userId: uid, employeeId, fullName: `Người ${uid}`, email: `u${employeeId}@hoangmaistarschool.edu.vn`,
  breakfastCount: 20, lunchCount: 20, firstMealDate: '2026-11-02', timestamp: '2026-10-28T03:00:00Z', ...more,
});

test('tài liệu miễn chấm hỏng có nêu mã: chỉ giữ lại người đó, người khác vẫn được xét', () => {
  const { policies, invalid } = parseCheckinExemptionDocs([
    goodPolicy('100001'),
    { id: '100002', data: { employeeId: '100002', email: 'KHONG-HOP-LE', fullName: 'Y', periods: [] } },
  ]);
  const quarantine = exemptionQuarantine(invalid);
  assert.deepEqual([...quarantine.ids], ['100002']);
  assert.equal(quarantine.unidentified, 0);
  assert.equal(exemptionHold(quarantine), null, 'không giữ cả loại thư');
  const plan = planAlerts({
    date: MON, registrations: [reg('a', '100001'), reg('b', '100002'), reg('c', '100003')], people: { 999999: { times: ['07:00'] } },
    checkinExemptions: policies, quarantinedIds: quarantine.ids, coverageAt: vn(MON, '13:45').toISOString(), now: NOW,
  });
  assert.deepEqual(plan.candidates.map(c => [c.uid, c.meals]), [['a', ['breakfast']], ['c', ['breakfast', 'lunch']]]);
  assert.deepEqual(plan.skipped.quarantined, ['100002']);
  assert.deepEqual(plan.stats.exempt, { breakfast: 0, lunch: 1 });
  assert.deepEqual(plan.stats.expected, { breakfast: 2, lunch: 2 }, 'mã bị giữ không vào số liệu');
});

test('tài liệu miễn chấm hỏng không nêu được mã: giữ CẢ loại thư thiếu chấm của ngày', () => {
  const { invalid } = parseCheckinExemptionDocs([goodPolicy('100001'), { id: 'abc', data: { email: 'x' } }]);
  const quarantine = exemptionQuarantine(invalid);
  assert.equal(quarantine.unidentified, 1);
  const reason = exemptionHold(quarantine);
  assert.match(reason, /1 tài liệu hỏng không xác định được mã nhân viên/);
  assert.match(reason, /Miễn chấm ăn theo bữa/);
  assert.equal(alertEntry('error', 'x', { reason, invalidExemptions: invalid.length }).invalidExemptions, 1);
  assert.equal('invalidExemptions' in alertEntry('sent', 'x'), false);
});

test('rà danh sách miễn chấm: mã không có đơn tháng, email khác email tài khoản (chỉ để in log)', () => {
  const { policies } = parseCheckinExemptionDocs([goodPolicy('100001'), goodPolicy('100002'), goodPolicy('100003'),
    { id: '100004', data: { employeeId: '100004', email: 'u100004@hoangmaistarschool.edu.vn', fullName: 'Z', periods: [{ from: '2026-12-01', to: null }] } }]);
  const audit = exemptionAudit({ date: MON, policies, registrations: [reg('a', '100001'), reg('b', '100002', { email: 'khac@hoangmaistarschool.edu.vn' })] });
  assert.deepEqual(audit, { active: 3, unmatched: ['100003'], emailMismatch: ['100002'] });
});

// ------------------------------------------- chốt an toàn, suất ăn sự kiện

test('chốt an toàn thư chấm chưa đăng ký: quá max(30, 25% người có lượt chấm) thì dừng cả ngày', () => {
  assert.deepEqual([extraGuard({ date: FRI, candidates: 30, tappers: 100 }).stop, extraGuard({ date: FRI, candidates: 31, tappers: 100 }).stop], [false, true]);
  assert.equal(extraGuard({ date: FRI, candidates: 50, tappers: 200 }).stop, false);
  const v = extraGuard({ date: FRI, candidates: 51, tappers: 200 });
  assert.deepEqual([v.stop, v.limit], [true, 50]);
  assert.match(v.reason, /51 người, vượt ngưỡng 50 người/);
  assert.match(v.reason, /200 người có lượt chấm/);
  assert.equal(extraGuard({ date: FRI, candidates: 0, tappers: 0 }).stop, false);
});

test('suất ăn sự kiện: sự kiện đang mở hoặc hạn đăng ký trong 7 ngày quanh ngày xét', () => {
  const events = [
    { id: 'open', isOpen: true },
    { id: 'near-before', isOpen: false, expiresAt: '2026-10-30' },
    { id: 'near-after', isOpen: false, expiresAt: '2026-11-13' },
    { id: 'far-before', isOpen: false, expiresAt: '2026-10-29' },
    { id: 'far-after', isOpen: false, expiresAt: '2026-11-14' },
    { id: 'stale-open', isOpen: true, expiresAt: '2026-09-01' },   // quên tắt cờ, đã quá hạn từ lâu
    { id: 'open-later', isOpen: true, expiresAt: '2026-12-20' },
    // Còn mở, hạn đăng ký đã qua 17 ngày: bữa sự kiện có thể diễn ra sau hạn vài tuần.
    { id: 'open-early-deadline', isOpen: true, expiresAt: '2026-10-20' },
    { id: '', isOpen: true },
  ];
  assert.deepEqual(relevantEventIds({ date: FRI, events }), ['near-after', 'near-before', 'open', 'open-early-deadline', 'open-later']);
  const skip = eventSkipUids({
    eventIds: ['open', 'near-before'],
    uids: ['a', 'b', 'c', 'd'],
    registrations: [
      { userId: 'a', eventId: 'open', choice: 'yes' },
      { userId: 'b', eventId: 'open', choice: 'no' },
      { userId: 'c', eventId: 'far-before', choice: 'yes' },
      { userId: 'x', eventId: 'near-before', choice: 'yes' },
      { userId: 'd', eventId: 'near-before', choice: 'yes' },
    ],
  });
  assert.deepEqual([...skip].sort(), ['a', 'd']);
});

test('email báo quản trị khi dừng thư chấm chưa đăng ký: một thư admin-notice, chỉ số đếm', () => {
  const n = buildExtraAdminNotice({ date: FRI, adminEmails: ['dinhduong@hoangmaistarschool.edu.vn', 'x@gmail.com'], reason: 'lý do',
    candidates: 51, tappers: 200, limit: 50, unmapped: 3, eventSkipped: 2, agentVersion: '2026-11-06.1' });
  assert.equal(n.kind, 'admin-notice');
  assert.equal(n.date, FRI);
  assert.deepEqual(n.to, ['dinhduong@hoangmaistarschool.edu.vn']);
  assert.match(n.lines[0], /chấm ăn chưa đăng ký/);
  assert.ok(n.lines.some(l => /51 \(ngưỡng 50\)/.test(l)));
  assert.ok(n.lines.every(l => l.length <= 300 && !/[\u0000-\u001f]/.test(l)));
});

// ------------------------------------------- gửi và ghi nhật ký

const rcpt = (uid, more = {}) => ({ uid, to: `${uid}@hoangmaistarschool.edu.vn`, employeeId: '100001', fullName: uid, meals: ['lunch'], outOfWindow: [],
  tapTimes: { lunch: '11:45' }, reasons: { lunch: 'no_registration' }, ...more });
const okAll = body => ({ results: body.alerts.map(a => ({ to: a.to, ok: true })) });

test('gửi: chỉ người gửi được mới ghi nhật ký, đúng khoá của từng loại thư', async () => {
  for (const kind of ['missing', 'extra']) {
    const rows = [];
    const r = await deliverAlerts({ date: FRI, kind, recipients: [rcpt('a'), rcpt('b')], post: async body => {
      assert.equal(body.kind, kind === 'extra' ? 'staff-extra' : 'staff-missing');
      return { results: [{ to: body.alerts[0].to, ok: true }, { to: body.alerts[1].to, ok: false, error: 'Graph 503' }] };
    }, writeJournal: async batch => { rows.push(...batch); }, now: () => 'T' });
    assert.deepEqual([r.sent, r.failed, r.errorsSeen, r.unsupported], [1, 1, ['Graph 503'], false], kind);
    assert.deepEqual(rows, [{
      id: kind === 'extra' ? `${FRI}:extra:a` : `${FRI}_a`,
      data: { uid: 'a', date: FRI, kind, to: 'a@hoangmaistarschool.edu.vn', employeeId: '100001', meals: ['lunch'], sentAt: 'T' },
    }], kind);
  }
});

test('extra: hết giờ chờ có thể đã gửi — ghi biên nhận chưa rõ, không tự gửi lại', async () => {
  const rows = [];
  const r = await deliverAlerts({ date: FRI, kind: 'extra', recipients: [rcpt('a')], post: async () => {
    throw new EndpointError('Không gọi được dkan.nshm.vn — không trả lời trong 90 giây', { delivery: 'unknown' });
  }, writeJournal: async batch => { rows.push(...batch); }, cleanError: err => `sạch: ${err.message}`, now: () => 'T' });
  assert.deepEqual([r.sent, r.failed, r.uncertain, r.unsupported], [0, 0, 1, false]);
  assert.deepEqual(r.errorsSeen, ['sạch: Không gọi được dkan.nshm.vn — không trả lời trong 90 giây']);
  assert.deepEqual(rows, [{ id: `${FRI}:extra:a`, data: {
    uid: 'a', date: FRI, kind: 'extra', to: 'a@hoangmaistarschool.edu.vn', employeeId: '100001',
    meals: ['lunch'], delivery: 'uncertain', attemptedAt: 'T',
  } }]);
  assert.equal(sentAlertsByKind(rows.map(r => r.data)).extra.has('a'), true, 'lần sau coi là đã xử lý, không chọn gửi lại');
  const notes = deliveryNotes({ ...r, kind: 'extra' }).join(' ');
  assert.match(notes, /Không tự gửi lại.*kiểm tra hộp thư/);
  assert.doesNotMatch(notes, /Lần chạy sau sẽ gửi nốt/);
});

test('extra: phản hồi HTTP 200 sai/thiếu kết quả hoặc maybeSent không được biến thành tự thử lại', async t => {
  for (const [label, response] of [
    ['không có thân', null], ['thiếu results', {}], ['thiếu kết quả', { results: [] }],
    ['thừa kết quả', { results: [{ to: rcpt('a').to, ok: true }, { to: rcpt('b').to, ok: true }] }],
    ['sai người', { results: [{ to: rcpt('b').to, ok: true }] }],
    ['thiếu ok', { results: [{ to: rcpt('a').to }] }],
    ['ok sai kiểu', { results: [{ to: rcpt('a').to, ok: 'true' }] }],
    ['Graph có thể đã gửi', { results: [{ to: rcpt('a').to, ok: false, maybeSent: true, error: 'timeout' }] }],
    ['maybeSent sai kiểu', { results: [{ to: rcpt('a').to, ok: false, maybeSent: 'true' }] }],
  ]) await t.test(label, async () => {
    const rows = [];
    const r = await deliverAlerts({ date: FRI, kind: 'extra', recipients: [rcpt('a')], post: async () => response,
      writeJournal: async batch => { rows.push(...batch); } });
    assert.deepEqual([r.sent, r.failed, r.uncertain], [0, 0, 1]);
    assert.equal(rows[0].data.delivery, 'uncertain');
    assert.equal(Object.hasOwn(rows[0].data, 'sentAt'), false, 'không khẳng định đã gửi');
  });
});

test('extra: kết quả từng thư phân biệt đã gửi, chắc chưa gửi và chưa rõ; chỉ chắc chưa gửi mới thử lại', async () => {
  const rows = [];
  const r = await deliverAlerts({ date: FRI, kind: 'extra', recipients: [rcpt('a'), rcpt('b'), rcpt('c')], post: async () => ({ results: [
    { to: rcpt('a').to, ok: true }, { to: rcpt('b').to, ok: false, maybeSent: false, error: 'Graph 400' },
    { to: rcpt('c').to, ok: false, maybeSent: true, error: 'timeout' },
  ] }), writeJournal: async batch => { rows.push(...batch); } });
  assert.deepEqual([r.sent, r.failed, r.uncertain], [1, 1, 1]);
  const handled = sentAlertsByKind(rows.map(r => r.data)).extra;
  assert.deepEqual([...handled], ['a', 'c']);
  assert.equal(handled.has('b'), false);
});

test('chỉ lỗi extra chắc chắn chưa gửi được phép thử lại; thư thiếu chấm giữ cách xử lý cũ', async () => {
  for (const kind of ['missing', 'extra']) {
    const rows = [];
    const r = await deliverAlerts({ date: FRI, kind, recipients: [rcpt('a')], post: async () => {
      throw new EndpointError('HTTP 401', { delivery: 'not_sent', status: 401 });
    }, writeJournal: async batch => { rows.push(...batch); } });
    assert.deepEqual([r.sent, r.failed, r.uncertain, rows.length], [0, 1, 0, 0], kind);
  }
  for (const response of [null, { results: [{ to: rcpt('a').to, ok: false, maybeSent: true, error: 'timeout' }] }]) {
    const rows = [];
    const r = await deliverAlerts({ date: FRI, recipients: [rcpt('a')], post: async () => response,
      writeJournal: async batch => { rows.push(...batch); } });
    assert.deepEqual([r.sent, r.failed, r.uncertain, rows.length], [0, 1, 0, 0]);
  }
  const r = await deliverAlerts({ date: FRI, recipients: [rcpt('a')], post: async () => {
    throw new EndpointError('timeout', { delivery: 'unknown' });
  }, writeJournal: async () => assert.fail('thư thiếu chấm không đổi cách ghi nhật ký') });
  assert.deepEqual([r.sent, r.failed, r.uncertain], [0, 1, 0]);
});

test('extra: không ghi được biên nhận chưa rõ thì dừng lô kế tiếp', async () => {
  let posts = 0;
  const r = await deliverAlerts({ date: FRI, kind: 'extra', recipients: Array.from({ length: 15 }, (_, i) => rcpt(`u${i}`)),
    post: async () => { posts++; return null; }, writeJournal: async () => { throw new Error('RESOURCE_EXHAUSTED'); } });
  assert.deepEqual([posts, r.sent, r.failed, r.uncertain, r.journalError], [1, 0, 5, 10, 'RESOURCE_EXHAUSTED']);
});

test('gửi: tối đa 3 lỗi khác nhau vào lý do; không ghi được nhật ký thì dừng các lô còn lại', async () => {
  let posts = 0;
  const many = Array.from({ length: 25 }, (_, i) => rcpt(`u${i}`));
  let r = await deliverAlerts({ date: FRI, recipients: many, post: async body => { posts++; return { results: body.alerts.map((a, i) => ({ to: a.to, ok: false, error: `lỗi ${i % 5}` })) }; },
    writeJournal: async () => {} });
  assert.deepEqual([r.failed, r.errorsSeen], [25, ['lỗi 0', 'lỗi 1', 'lỗi 2']]);
  assert.equal(posts, 3);

  posts = 0;
  const logs = [];
  r = await deliverAlerts({ date: FRI, recipients: many, post: async body => { posts++; return okAll(body); },
    writeJournal: async () => { throw new Error('RESOURCE_EXHAUSTED'); }, log: line => logs.push(line) });
  assert.equal(posts, 1, 'dừng ngay sau lô đầu');
  assert.deepEqual([r.sent, r.failed, r.journalError], [10, 15, 'RESOURCE_EXHAUSTED']);
  assert.equal(r.errorsSeen[0], 'không ghi được nhật ký meal_alerts, đã dừng gửi');
  assert.match(logs[0], /không ghi được nhật ký — DỪNG gửi tiếp/);

  // Lý do lưu lại kèm các lỗi đầu tiên (như các bản trước); email trong lỗi được che lúc ghi.
  const notes = deliveryNotes({ failed: 2, errorsSeen: ["Graph 400: Recipient 'a@hoangmaistarschool.edu.vn' invalid", 'Graph 503'], journalError: null, unreachable: 1, kind: 'extra' });
  assert.match(notes[0], /^2 email chưa gửi được \(Graph 400: .*; Graph 503\)\. Lần chạy sau sẽ gửi nốt\.$/);
  assert.match(notes[1], /không có tài khoản đang hoạt động/);
  const stored = extraEntry('partial', 'x', { reason: notes.join(' ') }).reason;
  assert.match(stored, /Graph 503/);
  assert.doesNotMatch(stored, /a@hoangmaistarschool/);
  assert.match(alertEntry('partial', 'x', { reason: notes.join(' ') }).reason, /\[email\]/);
});

test('API email bản cũ (400 về kind): dừng thư chấm chưa đăng ký trong lần chạy, không coi là lỗi từng người', async () => {
  const old = new EndpointError("Endpoint trả HTTP 400: kind phải là 'staff-missing', 'admin-notice' hoặc 'survey-invite'.", { delivery: 'not_sent', status: 400 });
  assert.equal(isOldApiKindRejection(old), true);
  for (const other of [
    new EndpointError('Endpoint trả HTTP 400: alerts[0].meals[0].reason không hợp lệ.', { delivery: 'not_sent', status: 400 }),
    new EndpointError("Endpoint trả HTTP 400: kind phải là 'staff-missing', 'staff-extra', 'admin-notice' hoặc 'survey-invite'.", { delivery: 'not_sent', status: 400 }),
    new EndpointError('Endpoint trả HTTP 401: Sai khoá', { delivery: 'not_sent', status: 401 }),
    new Error('kind'),
    null,
  ]) assert.equal(isOldApiKindRejection(other), false, String(other?.message));

  // Lần sau, khi trạng thái còn là lỗi API cũ: agent chỉ hỏi lại bằng một yêu cầu
  // rỗng (API kiểm tra dữ liệu trước khi gọi Graph nên không thành thư) trước khi đọc dữ liệu.
  const src = readFileSync(join(AGENT, 'sync-checkins.mjs'), 'utf8');
  assert.match(src, /existing\?\.reason === OLD_API_EXTRA_REASON\) \{\s*try \{\s*await postAlerts\(cfg, \{ kind: 'staff-extra', date, dateLabel: dateLabelOf\(date\), alerts: \[\] \}\);/);

  let posts = 0;
  const many = Array.from({ length: 15 }, (_, i) => rcpt(`u${i}`));
  const r = await deliverAlerts({ date: FRI, kind: 'extra', recipients: many, post: async () => { posts++; throw old; }, writeJournal: async () => { throw new Error('không được ghi'); } });
  assert.deepEqual([r.unsupported, r.sent, r.failed, posts], [true, 0, 15, 1]);
  assert.match(OLD_API_EXTRA_REASON, /cần triển khai bản web mới trước/);
  // Thư thiếu chấm không có khái niệm này: chỉ là lỗi thường, gửi lại lần sau.
  const m = await deliverAlerts({ date: FRI, kind: 'missing', recipients: [rcpt('a')], post: async () => { throw old; }, writeJournal: async () => {} });
  assert.deepEqual([m.unsupported, m.failed], [false, 1]);
});

// ------------------------------------------- mẫu số không tính người được miễn chấm

test('email báo quản trị và log: mẫu số là người còn phải chấm, ghi rõ số người được miễn', () => {
  const stats = { expected: { breakfast: 50, lunch: 100 }, missing: { breakfast: 40, lunch: 15 }, exempt: { breakfast: 0, lunch: 75 } };
  assert.deepEqual(mealCounts(stats, 'lunch'), { expected: 25, missing: 15, exempt: 75, note: ' (không tính 75 người được miễn chấm)' });
  assert.deepEqual(mealCounts(stats, 'breakfast'), { expected: 50, missing: 40, exempt: 0, note: '' });
  const n = buildAdminNotice({ date: MON, adminEmails: ['dinhduong@hoangmaistarschool.edu.vn'], reason: 'r', stats, tappers: 3, devices: [], agentVersion: 'v' });
  assert.equal(n.lines[0], 'Bữa sáng: 40/50 người đăng ký chưa có lượt chấm.');
  assert.equal(n.lines[1], 'Bữa trưa: 15/25 người đăng ký chưa có lượt chấm (không tính 75 người được miễn chấm).');
  // Bản ghi cũ không có exempt: như trước.
  assert.equal(mealCounts({ expected: { breakfast: 9, lunch: 9 }, missing: { breakfast: 1, lunch: 2 } }, 'lunch').expected, 9);
});

test('settings/checkinSync: agentFeatures ghi cạnh agentVersion', () => {
  const out = buildSyncSettings({ agentVersion: '2026-11-06.1', agentFeatures: ['checkinExemptions', 'extraAlerts'], runEndAt: 'T', complete: false,
    existing: {}, deviceResults: [], configDevices: [], coveredDates: [], today: MON, del: null });
  assert.equal(out.agentVersion, '2026-11-06.1');
  assert.deepEqual(out.agentFeatures, ['checkinExemptions', 'extraAlerts']);
  assert.equal('agentFeatures' in buildSyncSettings({ agentVersion: 'v', runEndAt: 'T', complete: false, existing: {}, deviceResults: [], configDevices: [], coveredDates: [], today: MON, del: null }), false);
});
