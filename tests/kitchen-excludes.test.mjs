// Danh sách mã Bếp Vina (settings/reconcileExcludes): đọc ô dán, thêm/gỡ tay,
// tải file HAC không làm mất mã thêm tay. Không dùng Firebase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let lib;
test.before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/kitchenExcludes.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  lib = module.exports;
});

test('đọc danh sách dán theo mẫu "mã: tên", dòng Excel, dấu phẩy; bỏ dòng không có mã', () => {
  const text = [
    '101163: Đỗ Thị Quy',
    '101740: Lưu Thị Lan',
    '101739 - Nguyễn Thị Tốn',
    '101633\tPhạm Thị Liễu',
    ' 101627 Phạm Thị Oanh ',
    '101692: Trần Hùng Sơn',
    '101163: Đỗ Thị Quy',
    '',
    'Trần Văn A',
    '101001, 101002;bv01',
  ].join('\r\n');
  const { ids, invalid } = lib.parseKitchenCodes(text);
  assert.deepEqual(ids, ['101163', '101740', '101739', '101633', '101627', '101692', '101001', '101002', 'BV01']);
  assert.deepEqual(invalid, ['Trần Văn A']);
  assert.deepEqual(lib.parseKitchenCodes('Lan: 101740').ids, [], 'tên đứng trước không đoán mã');
  assert.deepEqual(lib.parseKitchenCodes('abc').ids, [], 'cần ít nhất một chữ số');
});

test('doc bản cũ chỉ có employeeIds: coi như lấy từ file HAC', () => {
  const r = lib.readKitchenExcludes({ employeeIds: ['100777', 100778, ' 12345 ', '', null, 'N/A'] });
  assert.deepEqual(r.fileIds, ['100777', '100778', '12345']);
  assert.deepEqual(r.manualIds, []);
  assert.deepEqual(r.employeeIds, ['100777', '100778', '12345']);
  assert.deepEqual(lib.readKitchenExcludes(null), { employeeIds: [], fileIds: [], manualIds: [] });
});

test('thêm tay rồi tải file HAC: employeeIds luôn là hợp, mã thêm tay còn nguyên', () => {
  let cur = lib.readKitchenExcludes({ employeeIds: ['100777'] });
  const add = lib.addManualKitchenIds(cur, ['101163', '101740', '101163']);
  assert.deepEqual(add.added, ['101163', '101740']);
  cur = add.next;
  assert.deepEqual(cur.employeeIds, ['100777', '101163', '101740']);

  const again = lib.addManualKitchenIds(cur, ['101740']);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.already, ['101740']);

  cur = lib.withFileKitchenIds(cur, ['100888', '101740']);
  assert.deepEqual(cur.fileIds, ['100888', '101740']);
  assert.deepEqual(cur.manualIds, ['101163', '101740']);
  assert.deepEqual(cur.employeeIds, ['100888', '101163', '101740'], '100777 không còn trong file HAC mới');

  // Doc vừa ghi đọc lại ra đúng như vậy.
  assert.ok(lib.sameKitchenExcludes(lib.readKitchenExcludes(cur), cur));
});

test('gỡ mã thêm tay: còn trong file HAC thì vẫn bị loại', () => {
  const cur = lib.withFileKitchenIds(lib.addManualKitchenIds(lib.readKitchenExcludes(null), ['101163', '101740']).next, ['101740']);
  const a = lib.removeManualKitchenId(cur, '101163');
  assert.equal(a.removed, true);
  assert.equal(a.stillFromFile, false);
  assert.deepEqual(a.next.employeeIds, ['101740']);
  const b = lib.removeManualKitchenId(cur, '101740');
  assert.equal(b.stillFromFile, true);
  assert.deepEqual(b.next.employeeIds, ['101163', '101740']);
  assert.deepEqual(b.next.manualIds, ['101163']);
});

test('báo mã đang có đơn đăng ký ăn', () => {
  const conflicts = lib.kitchenRegistrationConflicts(['101163', '101740'], [
    { employeeId: ' 101163', fullName: 'Đỗ Thị Quy' },
    { employeeId: '101163', fullName: 'Trùng' },
    { employeeId: '100001', fullName: 'Khác' },
  ]);
  assert.deepEqual(conflicts, [{ employeeId: '101163', fullName: 'Đỗ Thị Quy' }]);
});

test('giới hạn số mã thêm tay', () => {
  const many = Array.from({ length: lib.MAX_MANUAL_KITCHEN_IDS + 1 }, (_, i) => String(200000 + i));
  assert.throws(() => lib.addManualKitchenIds(lib.readKitchenExcludes(null), many), /tối đa/);
});

test('tải file HAC giữ mã thêm tay; chế độ file áp dụng cả mã thêm tay', () => {
  const src = readFileSync(new URL('../src/components/MealReconciliation.tsx', import.meta.url), 'utf8');
  assert.match(src, /withFileKitchenIds\(before, result\.excludedIds\)/);
  assert.doesNotMatch(src, /setDoc\(doc\(db, 'settings', EXCLUDES_DOC\)/, 'không ghi đè cả doc khi tải file');
  assert.match(src, /savedExcludes\.manualIds/);
  const admin = readFileSync(new URL('../src/pages/Admin.tsx', import.meta.url), 'utf8');
  assert.match(admin, /<KitchenStaffList registrations=\{registrations\}/);
});
