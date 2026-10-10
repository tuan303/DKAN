// Các cửa chặn thêm của pha cảnh báo: cấu hình sai không được làm cảnh báo tắt
// lặng lẽ, và một máy mất dữ liệu (trả lời bình thường nhưng 0 lượt) không được
// làm cả bếp của máy đó nhận email "vi phạm" oan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMealFinal, MEALS } from '../lib/meal-rules.mjs';
import { groupByDateDevice, deviceSpans, coversDate, mergeDayDoc } from '../lib/sync-merge.mjs';
import { alertGate, planAlerts, guardVerdict, deviceMealGaps, MIN_TYPICAL_TAPPERS } from '../lib/alert-plan.mjs';

const DEVICES = ['CA_TrH', 'CA_TIH'];
const D = '2026-10-09'; // thứ 6
const vn = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(h * 60 + m - 7 * 60);
  return d;
};
const NOW = vn(D, '13:46');
const base = { date: D, now: NOW, nowVn: { date: D, time: '13:46' }, notBefore: '13:40', coverageAt: vn(D, '13:45').toISOString(), offDays: [] };

// ------------------------------------------------------------ cấu hình sai

test('alertGate: notBefore sai dạng không còn biến thành "chưa tới giờ" mãi mãi', () => {
  // '14:00' < '1:40' là đúng khi so chuỗi ('4' đứng trước ':') — trước đây lần
  // nào cũng "chưa tới giờ", mã thoát 0, không ai được cảnh báo.
  for (const nb of ['1:40', '9:00', '', 'abc']) {
    const g = alertGate({ ...base, notBefore: nb });
    assert.equal(g.proceed, false, nb);
    assert.equal(g.code, 'bad_config', nb);
    assert.equal(g.write.status, 'error');
    assert.match(g.write.reason, /notBefore/);
  }
  // Xem thử ngày cũ (--alerts-date) bỏ qua giờ nên không cần notBefore.
  assert.equal(alertGate({ ...base, notBefore: '1:40', ignoreTime: true }).proceed, true);
});

test('alertGate: lỗi cấu hình chặn ngay sau bước ngày nghỉ, trước kiểm tra giờ', () => {
  const problems = ['alerts.secret đang trống.'];
  let g = alertGate({ ...base, nowVn: { date: D, time: '09:00' }, configProblems: problems });
  assert.equal(g.code, 'bad_config', 'không bị che bởi "chưa tới giờ"');
  assert.match(g.write.reason, /secret đang trống/);
  // Ngày nghỉ vẫn là ngày nghỉ.
  assert.equal(alertGate({ ...base, date: '2026-10-10', configProblems: problems }).code, 'off_day');
  // Không ghi đè 'sent' / 'guarded'.
  for (const status of ['sent', 'guarded']) {
    g = alertGate({ ...base, configProblems: problems, existing: { status } });
    assert.equal(g.code, 'bad_config');
    assert.equal(g.write, null, status);
  }
  // Không có lỗi thì đi tiếp như cũ.
  assert.equal(alertGate({ ...base, configProblems: [] }).proceed, true);
});

// --------------------------------------------- một máy mất dữ liệu trong ngày

/**
 * Kịch bản người duyệt (gap.mjs): 100 người đăng ký, 65 ăn ở CA_TrH, 35 ở
 * CA_TIH. `tihMeals` quyết định CA_TIH còn giữ lượt chấm bữa nào hôm nay.
 */
function scenario({ tihMeals }) {
  const registrations = [];
  const events = [];
  for (let i = 0; i < 100; i++) {
    const id = String(1000 + i);
    registrations.push({ uid: `u${i}`, userId: `u${i}`, employeeId: id, fullName: `N${i}`, breakfastCount: 20, lunchCount: 20, timestamp: '2026-09-25T03:00:00Z' });
    const dev = i < 65 ? 'CA_TrH' : 'CA_TIH';
    if (dev === 'CA_TrH' || tihMeals.includes('breakfast')) events.push({ employeeId: id, time: `${D}T07:10:00+07:00`, device: dev });
    if (dev === 'CA_TrH' || tihMeals.includes('lunch')) events.push({ employeeId: id, time: `${D}T11:40:00+07:00`, device: dev });
  }
  return { registrations, events };
}

/** Lịch sử: những ngày trước, mỗi máy có đủ người chấm cả hai bữa. */
function normalHistory(days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
  const part = (from, n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [String(from + k), { name: '', times: ['07:10', '11:40'] }]));
  return days.map(date => ({ date, byDevice: { CA_TrH: part(1000, 65), CA_TIH: part(1065, 35) } }));
}

test('máy CA_TIH trả lời được nhưng 0 lượt cả ngày (chạy --days 1): không gửi CBNV, đi đường chốt an toàn', () => {
  const { events } = scenario({ tihMeals: [] });
  const { byDate } = groupByDateDevice(events, { from: D, to: D });
  const spans = deviceSpans(byDate, DEVICES);
  const covered = DEVICES.every(d => coversDate(spans[d], D));
  assert.equal(covered, false, 'ngày không được chốt');
  const idleDevices = DEVICES.filter(d => !coversDate(spans[d], D));
  const g = alertGate({ ...base, coverageAt: null, idleDevices });
  assert.equal(g.proceed, false);
  assert.equal(g.code, 'device_idle', 'báo quản trị như "không ai chấm", không chỉ ghi error lặng lẽ');
  assert.equal(g.write, null);
  assert.match(g.message, /CA_TIH trả lời được nhưng không có lượt chấm nào trong ngày/);
  // Đã gửi xong trong ngày thì không đụng tới nữa.
  assert.equal(alertGate({ ...base, coverageAt: null, idleDevices, existing: { status: 'sent' } }).code, 'already_sent');
  // Có máy LỖI thật thì vẫn là "không đủ máy" (error, thử lại), như hợp đồng.
  const f = alertGate({ ...base, coverageAt: null, idleDevices, failedDevices: ['CA_TrH'] });
  assert.equal(f.code, 'incomplete');
  assert.equal(f.write.status, 'error');
});

test('máy CA_TIH mất riêng bữa trưa: chốt theo tỉ lệ KHÔNG bắt được, kiểm tra từng máy thì bắt được', () => {
  const { registrations, events } = scenario({ tihMeals: ['breakfast'] });
  const { byDate } = groupByDateDevice(events, { from: D, to: D });
  const spans = deviceSpans(byDate, DEVICES);
  assert.ok(DEVICES.every(d => coversDate(spans[d], D)), 'máy vẫn có lượt bữa sáng nên ngày vẫn được chốt');
  const day = mergeDayDoc({ date: D, existing: null, fresh: byDate[D], okDevices: DEVICES, coveringDevices: DEVICES, configDevices: DEVICES, syncedAt: base.coverageAt });

  const plan = planAlerts({ date: D, registrations, people: day.people, coverageAt: base.coverageAt, now: NOW });
  assert.deepEqual(plan.stats.missing, { breakfast: 0, lunch: 35 });
  assert.equal(plan.candidates.length, 35);
  // Đúng lỗi người duyệt tìm ra: 35% dưới ngưỡng 40% => trước đây vẫn gửi.
  assert.equal(guardVerdict({ stats: plan.stats, tappers: plan.tappers, minExpected: 20, maxMissingRatio: 0.4 }).stop, false);

  const meals = MEALS.filter(m => isMealFinal(D, m, base.coverageAt, NOW));
  assert.deepEqual(meals, ['breakfast', 'lunch']);
  const { gaps, unknown } = deviceMealGaps({ date: D, devices: DEVICES, dayParts: day.byDevice, history: normalHistory(), meals });
  assert.equal(unknown, false);
  assert.deepEqual(gaps, [{ device: 'CA_TIH', meal: 'lunch', typical: 35 }]);
  const v = guardVerdict({ stats: plan.stats, tappers: plan.tappers, minExpected: 20, maxMissingRatio: 0.4, deviceGaps: gaps });
  assert.equal(v.stop, true);
  assert.match(v.reason, /máy CA_TIH không có lượt chấm nào trong khung Bữa trưa \(10:00–13:30\)/);
  assert.match(v.reason, /thường có tới 35 người/);
});

test('deviceMealGaps: máy vốn không phục vụ bữa sáng thì 0 lượt bữa sáng là bình thường', () => {
  const history = normalHistory().map(h => ({
    date: h.date,
    byDevice: { ...h.byDevice, CA_TIH: Object.fromEntries(Object.entries(h.byDevice.CA_TIH).map(([k, p], i) => [k, { name: '', times: i === 0 ? ['07:30', '11:40'] : ['11:40'] }])) },
  }));
  const dayParts = { CA_TrH: { 1: { times: ['07:00', '11:30'] } }, CA_TIH: { 2: { times: ['11:30'] } } };
  const r = deviceMealGaps({ date: D, devices: DEVICES, dayParts, history, meals: ['breakfast', 'lunch'] });
  assert.ok(MIN_TYPICAL_TAPPERS > 1);
  assert.deepEqual(r.gaps, [], 'một người thỉnh thoảng chấm nhầm máy không đủ để coi là "thường có"');
});

test('deviceMealGaps: chưa có lịch sử để so => nghiêng về an toàn; dữ liệu dạng cũ => không kiểm tra được', () => {
  const dayParts = { CA_TrH: { 1: { times: ['07:00', '11:30'] } }, CA_TIH: {} };
  // Lịch sử chỉ có document dạng cũ (không byDevice), ngày nghỉ, và ngày sau ngày xét: đều không dùng được.
  const history = [
    { date: '2026-10-08', byDevice: null },
    { date: '2026-10-04', byDevice: { CA_TIH: { 9: { times: ['11:00'] }, 8: { times: ['11:00'] }, 7: { times: ['11:00'] } } } }, // chủ nhật
    { date: '2026-10-12', byDevice: { CA_TIH: { 9: { times: ['11:00'] } } } },
  ];
  const r = deviceMealGaps({ date: D, devices: DEVICES, dayParts, history, meals: ['lunch'] });
  assert.deepEqual(r.gaps, [{ device: 'CA_TIH', meal: 'lunch', typical: null }]);
  assert.match(guardVerdict({ stats: { expected: { breakfast: 0, lunch: 0 }, missing: { breakfast: 0, lunch: 0 } }, tappers: 1, minExpected: 20, maxMissingRatio: 0.4, deviceGaps: r.gaps }).reason, /chưa có dữ liệu những ngày trước/);

  assert.deepEqual(deviceMealGaps({ date: D, devices: DEVICES, dayParts: null, history: [], meals: ['lunch'] }), { gaps: [], unknown: true });
  // Ngày khai nghỉ trong lịch sử cũng bỏ qua.
  const off = deviceMealGaps({ date: D, devices: ['CA_TIH'], dayParts: { CA_TIH: {} }, history: [{ date: '2026-10-08', byDevice: { CA_TIH: { 1: { times: ['11:00'] } } } }], offDays: ['2026-10-08'], meals: ['lunch'] });
  assert.deepEqual(off.gaps, [{ device: 'CA_TIH', meal: 'lunch', typical: null }]);
});

test('deviceMealGaps: mọi máy có lượt chấm bình thường => không chặn', () => {
  const { events } = scenario({ tihMeals: ['breakfast', 'lunch'] });
  const { byDate } = groupByDateDevice(events, { from: D, to: D });
  const r = deviceMealGaps({ date: D, devices: DEVICES, dayParts: byDate[D], history: normalHistory(), meals: ['breakfast', 'lunch'] });
  assert.deepEqual(r.gaps, []);
});
