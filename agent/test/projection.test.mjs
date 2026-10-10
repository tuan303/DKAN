// Test cho việc gán mã NV -> tài khoản và tách lượt chấm cá nhân. Gán sai ở đây
// là lộ giờ ăn của người này cho người kia, nên các ca trùng mã được xét kỹ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePeople, buildOwnerIndex, projectMonth, diffTapDoc } from '../lib/projection.mjs';

const M = '2026-10';
const D1 = '2026-10-08';
const D2 = '2026-10-09';
const AT = '2026-10-09T06:45:00.000Z';
const DEL = Symbol('del');

test('normalizePeople: gộp khoá thô cùng mã chuẩn hoá, bỏ giờ hỏng', () => {
  const map = normalizePeople({
    '101190': { name: 'A', times: ['11:30', '07:00'] },
    '101190 ': { name: 'A', times: ['07:00', '12:00', 'rác'] },
    'ab12': { times: ['10:00'] },
    '   ': { times: ['10:00'] },
  });
  assert.deepEqual([...map.keys()].sort(), ['101190', 'AB12']);
  assert.deepEqual(map.get('101190'), ['07:00', '11:30', '12:00']);
});

test('gán mã: chỉ theo đơn đăng ký; mã trong hồ sơ staff (tự sửa được) không bao giờ được dùng', () => {
  const idx = buildOwnerIndex({
    registrations: [{ uid: 'U', employeeId: '101001' }],
    // Tham số staff của bản trước: bị bỏ qua hoàn toàn.
    staff: [{ uid: 'U', employeeId: '109999' }, { uid: 'S', employeeId: '101555' }],
  });
  assert.equal(idx.ownerOf.get('101001'), 'U');
  assert.equal(idx.ownerOf.get('109999'), undefined);
  assert.equal(idx.ownerOf.get('101555'), undefined, 'người chưa đăng ký đổi mã trong hồ sơ cũng không nhận được lượt chấm của ai');
  assert.deepEqual([...idx.idsOf.keys()], ['U']);
  assert.equal(idx.conflictsOf.size, 0);
});

test('gán mã: đơn mang mã không dùng được, hoặc mã bộ phận loại trừ, thì không gán cho ai', () => {
  const idx = buildOwnerIndex({
    registrations: [{ uid: 'W', employeeId: 'N/A' }, { uid: 'K', employeeId: ' 100777 ' }, { uid: 'V', employeeId: '101002' }],
    excludedIds: ['100777'],
  });
  assert.equal(idx.idsOf.has('W'), false);
  assert.equal(idx.idsOf.has('K'), false, 'đăng ký mang mã nhân viên bếp không xem được giờ chấm công của bếp');
  assert.equal(idx.ownerOf.get('101002'), 'V');
});

test('gán mã: hai đơn cùng mã => trùng TỪ NGÀY đơn thứ hai có hiệu lực; trước đó lượt chấm vẫn của người đăng ký trước', () => {
  const idx = buildOwnerIndex({
    registrations: [
      { uid: 'A', employeeId: '101001', month: M, firstMealDate: `${M}-01` },
      // B nộp đơn sáng D2 (09:00 giờ VN): có hiệu lực từ D2.
      { uid: 'B', employeeId: '101001 ', month: M, firstMealDate: D2, timestamp: '2026-10-09T02:00:00.000Z' },
    ],
  });
  assert.equal(idx.ownerOf.has('101001'), false);
  assert.deepEqual(idx.conflictsOf.get('A'), ['101001']);
  assert.deepEqual(idx.conflictsOf.get('B'), ['101001']);
  assert.equal(idx.conflictSinceOf.get('A'), D2);
  assert.equal(idx.conflictSinceOf.get('B'), D2);
  assert.deepEqual(idx.earlyOwnerOf.get('101001'), { uid: 'A', until: D2 });

  const people = new Map([['101001', ['07:00', '11:30']]]);
  const { plans, unclaimed } = projectMonth({ dates: [D1, D2], peopleByDate: { [D1]: people, [D2]: people }, index: idx });
  assert.deepEqual(plans.get('A').days, { [D1]: ['07:00', '11:30'] }, 'D1 trước ngày trùng vẫn thuộc A');
  assert.deepEqual(plans.get('B').days, {});
  for (const uid of ['A', 'B']) {
    assert.equal(plans.get(uid).conflict, true);
    assert.equal(plans.get(uid).conflictSince, D2);
  }
  assert.equal(unclaimed.size, 0, 'mã trùng không tính là mã chưa gắn tài khoản');

  // Ghi document: A ghi ngày D1, không đụng D2; mốc trùng lấy từ đơn chứ không từ ngày chạy.
  const docA = diffTapDoc({ uid: 'A', month: M, existing: null, plan: plans.get('A'), dates: [D1, D2], updatedAt: '2026-10-20T15:00:00.000Z', del: DEL });
  assert.deepEqual(docA.days, { [D1]: ['07:00', '11:30'] });
  assert.equal(docA.conflictSince, D2);
});

test('gán mã: hai đơn cùng mã không rõ ngày hiệu lực => trùng cả tháng, không ai nhận lượt chấm', () => {
  const idx = buildOwnerIndex({ registrations: [{ uid: 'A', employeeId: '101001' }, { uid: 'B', employeeId: '101001' }] });
  assert.equal(idx.conflictSinceOf.get('A'), null);
  assert.equal(idx.earlyOwnerOf.has('101001'), false);
  const { plans } = projectMonth({ dates: [D1], peopleByDate: { [D1]: new Map([['101001', ['07:00']]]) }, index: idx });
  assert.deepEqual(plans.get('A').days, {});
  assert.equal(plans.get('A').conflictSince, null);
});

test('một tài khoản nhận lượt chấm từ hai mã => hợp giờ', () => {
  const idx = buildOwnerIndex({
    registrations: [{ uid: 'U', employeeId: '101001' }, { uid: 'U', employeeId: '101002' }],
  });
  assert.deepEqual(idx.idsOf.get('U'), ['101001', '101002']);
  const { plans } = projectMonth({
    dates: [D1, D2],
    peopleByDate: {
      [D1]: new Map([['101001', ['07:00']], ['101002', ['07:00', '11:40']]]),
      [D2]: new Map([['101002', ['11:00']], ['109999', ['11:00']]]),
    },
    index: idx,
  });
  const plan = plans.get('U');
  assert.deepEqual(plan.days, { [D1]: ['07:00', '11:40'], [D2]: ['11:00'] });
  assert.deepEqual(plan.employeeIds, ['101001', '101002']);
});

test('projectMonth: mã có lượt chấm mà không gắn được tài khoản nào', () => {
  const idx = buildOwnerIndex({ registrations: [{ uid: 'U', employeeId: '101001' }] });
  const { unclaimed } = projectMonth({ dates: [D2], peopleByDate: { [D2]: new Map([['109999', ['11:00']], ['101001', ['11:00']]]) }, index: idx });
  assert.deepEqual([...unclaimed], ['109999']);
});

test('diffTapDoc: tạo mới / không đổi / xoá ngày mất lượt / chỉ đụng ngày trong lần chạy', () => {
  const plan = { employeeIds: ['101001'], conflict: false, conflictIds: [], days: { [D2]: ['07:00', '11:30'] } };

  // Chưa có document: tạo, chỉ chứa ngày có lượt chấm.
  const created = diffTapDoc({ uid: 'U', month: M, existing: null, plan, dates: [D1, D2], updatedAt: AT, del: DEL });
  assert.deepEqual(created, { uid: 'U', month: M, employeeIds: ['101001'], conflict: false, conflictIds: [], conflictSince: null, days: { [D2]: ['07:00', '11:30'] }, updatedAt: AT });

  // Không lượt chấm, không trùng, chưa có document: không tạo.
  const empty = { ...plan, days: {} };
  assert.equal(diffTapDoc({ uid: 'U', month: M, existing: null, plan: empty, dates: [D2], updatedAt: AT, del: DEL }), null);

  // Đã đúng: không ghi lại.
  const existing = { uid: 'U', month: M, employeeIds: ['101001'], conflict: false, conflictIds: [], days: { '2026-10-01': ['07:00'], [D2]: ['07:00', '11:30'] } };
  assert.equal(diffTapDoc({ uid: 'U', month: M, existing, plan, dates: [D1, D2], updatedAt: AT, del: DEL }), null);

  // Ngày trong lần chạy nay không còn lượt => xoá ngày đó; ngày ngoài lần chạy giữ nguyên.
  const out = diffTapDoc({ uid: 'U', month: M, existing, plan: { ...plan, days: { [D1]: ['11:00'] } }, dates: [D1, D2], updatedAt: AT, del: DEL });
  assert.deepEqual(out.days, { [D1]: ['11:00'], [D2]: DEL });
  assert.equal('2026-10-01' in out.days, false);

  // Đổi mã => cập nhật phần mô tả dù lượt chấm không đổi.
  const meta = diffTapDoc({ uid: 'U', month: M, existing, plan: { ...plan, employeeIds: ['101009'] }, dates: [D2], updatedAt: AT, del: DEL });
  assert.deepEqual(meta.employeeIds, ['101009']);
  assert.equal('days' in meta, false);
});

test('diffTapDoc: tài khoản trùng mã => bật cờ, không ghi days từ ngày trùng; hết trùng => tắt cờ', () => {
  const conflictPlan = { employeeIds: ['101001'], conflict: true, conflictIds: ['101001'], conflictSince: null, days: {} };
  const created = diffTapDoc({ uid: 'A', month: M, existing: null, plan: conflictPlan, dates: [D2], updatedAt: AT, del: DEL });
  assert.equal(created.conflict, true);
  assert.deepEqual(created.conflictIds, ['101001']);
  assert.deepEqual(created.days, {});
  assert.equal(created.conflictSince, null, 'không rõ ngày => trùng cả tháng');

  // Có document cũ với ngày có lượt chấm: không xoá, không ghi days.
  const existing = { uid: 'A', month: M, employeeIds: ['101001'], conflict: false, conflictIds: [], days: { [D2]: ['07:00'] } };
  const flagged = diffTapDoc({ uid: 'A', month: M, existing, plan: { ...conflictPlan, conflictSince: D2 }, dates: [D1, D2], updatedAt: AT, del: DEL });
  assert.equal(flagged.conflict, true);
  assert.equal(flagged.conflictSince, D2);
  assert.equal('days' in flagged, false, 'D1 không có lượt mới, D2 từ ngày trùng không đụng tới');

  // Vẫn trùng, không đổi gì: không ghi.
  const stillConflicted = { ...existing, conflict: true, conflictIds: ['101001'], conflictSince: D2 };
  assert.equal(diffTapDoc({ uid: 'A', month: M, existing: stillConflicted, plan: { ...conflictPlan, conflictSince: D2 }, dates: [D2], updatedAt: AT, del: DEL }), null);

  // Hết trùng.
  const cleared = diffTapDoc({
    uid: 'A', month: M, existing: stillConflicted,
    plan: { employeeIds: ['101001'], conflict: false, conflictIds: [], conflictSince: null, days: { [D2]: ['07:00'] } },
    dates: [D2], updatedAt: AT, del: DEL,
  });
  assert.equal(cleared.conflict, false);
  assert.deepEqual(cleared.conflictIds, []);
  assert.equal(cleared.conflictSince, null);
});
