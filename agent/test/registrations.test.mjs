// Đơn đăng ký do trình duyệt ghi, rules hiện cho tạo đơn với id/userId bất kỳ.
// Một đơn hỏng không được làm hỏng cả lần chạy; một đơn "ma" không được giúp
// ai tự miễn cảnh báo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRegistrations, dropGhosts, isSafeUid } from '../lib/registrations.mjs';
import { planAlerts } from '../lib/alert-plan.mjs';
import { buildOwnerIndex } from '../lib/projection.mjs';

const M = '2026-10';
const UID = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9t'; // dạng uid Firebase Auth

test('isSafeUid', () => {
  assert.equal(isSafeUid(UID), true);
  assert.equal(isSafeUid('custom_uid-1'), true);
  for (const bad of ['x/y', '', ' ', 'a b', '..', '.', '__x__', 'thầy', 123, null, undefined, {}, 'a'.repeat(129)]) {
    assert.equal(isSafeUid(bad), false, JSON.stringify(bad));
  }
});

test('cleanRegistrations: nhận đơn đúng dạng, bỏ đơn hỏng mà không ném lỗi', () => {
  const docs = [
    { id: `${UID}_${M}`, data: { userId: UID, month: M, employeeId: '101001' } },
    { id: `old1_${M}`, data: { month: M, employeeId: '101002' } },                 // đơn cũ thiếu userId
    { id: `x_${M}`, data: { userId: 'x/y', month: M, employeeId: '101003' } },     // làm hỏng đường dẫn Firestore
    { id: `n_${M}`, data: { userId: 42, month: M, employeeId: '101004' } },         // không phải chuỗi
    { id: `${UID}_${M}x`, data: { userId: UID, month: M, employeeId: '101005' } },  // id lạ
    { id: `victim_${M}`, data: { userId: 'attacker', month: M, employeeId: '1' } }, // userId khác chủ id
    { id: `__x___${M}`, data: { month: M, employeeId: '101006' } },
    { id: `ok2_${M}`, data: { userId: 'ok2', month: '2026-11', employeeId: '1' } },  // tháng lệch
  ];
  const { registrations, rejected } = cleanRegistrations({ docs, month: M });
  assert.deepEqual(registrations.map(r => [r.uid, r.employeeId]), [[UID, '101001'], ['old1', '101002']]);
  assert.equal(rejected.length, 6);
  assert.ok(rejected.every(r => typeof r.why === 'string' && r.why));
});

test('dropGhosts + planAlerts: đơn "ma" mang mã của người khác không làm người đó thoát cảnh báo', () => {
  // Kịch bản người duyệt: CBNV tự tạo registrations/zzz_2026-10 mang mã của
  // chính mình để hai đơn "trùng mã" và cả hai bị bỏ qua.
  const D = '2026-10-08';
  const NOW = new Date('2026-10-08T07:00:00Z');   // 14:00 giờ VN
  const COVER = '2026-10-08T06:50:00Z';            // 13:50 giờ VN
  const docs = [
    { id: `real_${M}`, data: { userId: 'real', month: M, employeeId: '101001', breakfastCount: 20, lunchCount: 20, fullName: 'Thầy Thật' } },
    { id: `zzz_${M}`, data: { userId: 'zzz', month: M, employeeId: '101001', breakfastCount: 1, lunchCount: 0 } },
  ];
  const { registrations } = cleanRegistrations({ docs, month: M });
  const people = { 999: { times: ['07:00'] } };

  // Không lọc: cả hai bị bỏ vì trùng mã.
  const before = planAlerts({ date: D, registrations, people, coverageAt: COVER, now: NOW });
  assert.deepEqual(before.skipped.duplicate, ['101001']);
  assert.equal(before.candidates.length, 0);

  const { kept, ghosts } = dropGhosts(registrations, uid => uid === 'real');
  assert.deepEqual(ghosts, ['zzz']);
  const after = planAlerts({ date: D, registrations: kept, people, coverageAt: COVER, now: NOW });
  assert.deepEqual(after.candidates.map(c => [c.uid, c.meals]), [['real', ['breakfast', 'lunch']]]);

  // Trang cá nhân cũng không còn báo trùng mã oan.
  const idx = buildOwnerIndex({ registrations: kept });
  assert.equal(idx.ownerOf.get('101001'), 'real');
  assert.equal(idx.conflictsOf.size, 0);
});
