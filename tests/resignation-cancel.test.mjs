// Hủy ăn phần còn lại của tháng cho nhân viên nghỉ việc: ngày nào được ghi, ngày nào
// bỏ qua, nội dung tài liệu báo hủy và cách hoàn tác. Không dùng Firebase.
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
    entryPoints: [fileURLToPath(new URL('../src/lib/resignationCancel.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  lib = module.exports;
});

const reg = (more = {}) => ({
  userId: 'uQ', month: '2026-11', employeeId: '100652', fullName: 'Người Q', department: 'Tổ Toán', email: 'q@hoangmaistarschool.edu.vn',
  breakfastCount: 0, lunchCount: 21, firstMealDate: '2026-11-02', ...more,
});

test('hủy từ ngày chọn tới hết tháng, chỉ ngày có suất ăn, chỉ các bữa có trong đơn', () => {
  const plan = lib.planResignationCancel({ registration: reg(), fromDate: '2026-11-19', offDays: ['2026-11-20'], today: '2026-11-19' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.meals, ['lunch']);
  assert.equal(plan.cancelMeal, 'lunch');
  assert.deepEqual(plan.writes.map(w => w.date),
    ['2026-11-19', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30'],
    'bỏ thứ 7, chủ nhật và ngày nghỉ 20/11');
  assert.ok(plan.writes.every(w => w.cancelMeal === 'lunch' && w.previous === null && w.id === `uQ_${w.date}`));
  assert.deepEqual(plan.pastDates, []);
  assert.equal(lib.describeRange(plan.writes.map(w => w.date)), '19/11 – 30/11/2026 · 7 ngày');
});

test('đơn ghi bữa sáng mà bữa trưa = 0 (lỗi cũ) là cả hai bữa, như agent và trang Quản trị', () => {
  assert.deepEqual(lib.registeredMeals({ breakfastCount: 20, lunchCount: 0 }), ['breakfast', 'lunch']);
  assert.deepEqual(lib.registeredMeals({ breakfastCount: 0, lunchCount: 0 }), []);
  const plan = lib.planResignationCancel({ registration: reg({ breakfastCount: 21, lunchCount: 21 }), fromDate: '2026-11-30', today: '2026-11-09' });
  assert.deepEqual(plan.writes.map(w => [w.date, w.cancelMeal]), [['2026-11-30', 'both']]);
  const none = lib.planResignationCancel({ registration: reg({ lunchCount: 0 }), fromDate: '2026-11-30', today: '2026-11-09' });
  assert.deepEqual(none, { ok: false, error: 'Đơn tháng này không đăng ký bữa nào.' });
});

test('không hủy trước ngày bắt đầu ăn trên đơn; ngày đã qua được đánh dấu để cảnh báo', () => {
  const plan = lib.planResignationCancel({ registration: reg({ firstMealDate: '2026-11-25' }), fromDate: '2026-11-02', today: '2026-11-26' });
  assert.equal(plan.start, '2026-11-25');
  assert.deepEqual(plan.writes.map(w => w.date), ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30']);
  assert.deepEqual(plan.pastDates, ['2026-11-25']);
  assert.equal(lib.firstCancelableDate(reg({ firstMealDate: '2026-10-15' })), '2026-11-01', 'ngày bắt đầu ở tháng khác thì từ ngày 1');
  assert.equal(lib.defaultCancelFrom(reg(), '2026-11-09'), '2026-11-09');
  assert.equal(lib.defaultCancelFrom(reg(), '2026-10-20'), '2026-11-02', 'tháng chưa tới: từ ngày bắt đầu ăn');
  assert.equal(lib.defaultCancelFrom(reg(), '2026-12-03'), '2026-11-02', 'tháng đã qua: từ ngày bắt đầu ăn');
});

test('ngày đã báo hủy đủ thì bỏ qua; báo hủy một phần thì gộp, giữ bản cũ để hoàn tác', () => {
  const existing = [
    { id: 'uQ_2026-11-26', userId: 'uQ', cancelDate: '2026-11-26', cancelMeal: 'lunch', cancelReason: 'Đi công tác' },
    { id: 'uQ_2026-11-27', userId: 'uQ', cancelDate: '2026-11-27', cancelMeal: 'breakfast', cancelReason: 'Ốm' },
    { id: 'cu-ngau-nhien', userId: 'uQ', cancelDate: '2026-11-30', cancelMeal: 'both' },
  ];
  const plan = lib.planResignationCancel({ registration: reg({ breakfastCount: 0, lunchCount: 21 }), fromDate: '2026-11-26', existing, today: '2026-11-26' });
  assert.deepEqual(plan.skipped, ['2026-11-26', '2026-11-30'], 'đã hủy bữa trưa (kể cả tài liệu mã cũ)');
  assert.deepEqual(plan.writes, [{
    id: 'uQ_2026-11-27', date: '2026-11-27', cancelMeal: 'both',
    previous: { userId: 'uQ', cancelDate: '2026-11-27', cancelMeal: 'breakfast', cancelReason: 'Ốm' },
  }], 'giữ bữa sáng người đó tự báo hủy, thêm bữa trưa');
  assert.deepEqual(lib.undoOperations(plan.writes), [
    { op: 'set', id: 'uQ_2026-11-27', data: { userId: 'uQ', cancelDate: '2026-11-27', cancelMeal: 'breakfast', cancelReason: 'Ốm' } },
  ]);
  const fresh = lib.planResignationCancel({ registration: reg(), fromDate: '2026-11-30', today: '2026-11-26' });
  assert.deepEqual(lib.undoOperations(fresh.writes), [{ op: 'delete', id: 'uQ_2026-11-30' }]);
});

test('ngày bắt đầu phải thuộc tháng của đơn; tài khoản và tháng phải hợp lệ', () => {
  assert.match(lib.planResignationCancel({ registration: reg(), fromDate: '2026-12-01', today: '2026-11-09' }).error, /thuộc tháng 11\/2026/);
  assert.match(lib.planResignationCancel({ registration: reg(), fromDate: '', today: '2026-11-09' }).error, /thuộc tháng/);
  assert.equal(lib.planResignationCancel({ registration: reg({ userId: 'a/b' }), fromDate: '2026-11-10', today: '2026-11-09' }).ok, false);
  assert.equal(lib.planResignationCancel({ registration: reg({ month: '2026-13' }), fromDate: '2026-11-10', today: '2026-11-09' }).ok, false);
  assert.equal(lib.monthEnd('2026-02'), '2026-02-28');
  assert.equal(lib.monthEnd('2028-02'), '2028-02-29');
});

test('tài liệu báo hủy có đủ trường như khi nhân viên tự hủy, kèm dấu vết quản trị', () => {
  assert.equal(lib.validateResignationInput({ canteen: '', reason: 'Nghỉ việc' }), 'Chọn nhà ăn của nhân viên.');
  assert.equal(lib.validateResignationInput({ canteen: 'trunghoc', reason: '  ' }), 'Nhập lý do hủy ăn.');
  assert.match(lib.validateResignationInput({ canteen: 'trunghoc', reason: 'x'.repeat(201) }), /tối đa 200/);
  assert.equal(lib.validateResignationInput({ canteen: 'tieuhoc', reason: 'Nghỉ việc' }), null);
  const plan = lib.planResignationCancel({ registration: reg(), fromDate: '2026-11-30', today: '2026-11-26' });
  const data = lib.resignationCancelDoc(plan.writes[0], {
    registration: reg(), reason: ' Nghỉ việc ', canteen: 'trunghoc', adminEmail: 'admin@hoangmaistarschool.edu.vn', batchId: 'b1', at: 'T',
  });
  assert.deepEqual(data, {
    userId: 'uQ', fullName: 'Người Q', employeeId: '100652', department: 'Tổ Toán', email: 'q@hoangmaistarschool.edu.vn',
    cancelDate: '2026-11-30', formattedDate: '30/11/2026', cancelMeal: 'lunch', cancelReason: 'Nghỉ việc', cancelCanteen: 'trunghoc',
    timestamp: 'T', source: 'admin-resignation', createdBy: 'admin@hoangmaistarschool.edu.vn', adminBatch: 'b1',
  });
});

test('hộp thoại dựng được mà không đọc/ghi gì: đóng thì không hiện, mở thì có ô tìm nhân viên', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/ResignationCancelDialog.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent',
    plugins: [{
      name: 'no-live-firestore',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/lib\/firebase$/ }, () => ({ path: 'firebase', namespace: 'stub' }));
        builder.onResolve({ filter: /^firebase\/firestore$/ }, () => ({ path: 'firestore', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'firebase'
          ? 'export const auth = { currentUser: null }, db = {};'
          : `const fail = () => { throw new Error('Firestore không được gọi khi render'); };
             export const collection = fail, doc = fail, getDoc = fail, getDocs = fail, query = fail, where = fail, writeBatch = fail;` }));
      },
    }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  const { ResignationCancelDialog } = module.exports;
  const props = { onClose() {}, registrations: [reg()], selectedMonth: '2026-11', showToast() {} };
  assert.equal(renderToStaticMarkup(createElement(ResignationCancelDialog, { ...props, open: false })), '');
  const html = renderToStaticMarkup(createElement(ResignationCancelDialog, { ...props, open: true }));
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.ok(html.includes('Hủy ăn người nghỉ việc'));
  assert.ok(html.includes('Nhân viên có đơn tháng 11/2026'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*Hủy ăn<\/button>/s, 'chưa chọn người thì chưa bấm hủy được');
  // Dự án đặt tên khoảng cách xs/sm/md/lg/xl (--spacing-xl: 32px), nên max-w-xl, w-lg... của
  // Tailwind thành vài chục pixel: hộp thoại từng bị co thành một cột hẹp.
  for (const source of ['../src/components/ResignationCancelDialog.tsx', '../src/components/ActionMenu.tsx']) {
    assert.doesNotMatch(readFileSync(new URL(source, import.meta.url), 'utf8'),
      /\b(max-w|min-w|w|h|max-h|min-h)-(xs|sm|md|lg|xl|gutter|margin|unit)\b/, source);
  }
});

test('tab Hủy ăn có nút mở hộp thoại; hộp thoại ghi theo lô và cho hoàn tác', () => {
  const admin = readFileSync(new URL('../src/pages/Admin.tsx', import.meta.url), 'utf8');
  assert.match(admin, /<ResignationCancelDialog/);
  assert.match(admin, /Hủy ăn người nghỉ việc/);
  const dialog = readFileSync(new URL('../src/components/ResignationCancelDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /writeBatch\(db\)/);
  assert.match(dialog, /undoOperations\(/);
  assert.match(dialog, /where\('userId', '==', /, 'chỉ đọc báo hủy của đúng người đó');
});
