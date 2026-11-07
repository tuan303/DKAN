// Render checks for the admin "Miễn chấm ăn theo bữa" manager. Firestore is
// replaced by functions that throw: rendering must never read or write data.
// The write paths are driven in checkin-exemption-manager-actions.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const load = async (entry, plugins = []) => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    logLevel: 'silent', plugins,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
};
let ui, lib;
test.before(async () => {
  ui = await load('../src/components/MealCheckinExemptions.tsx', [{
    name: 'no-live-firestore',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/lib\/firebase$/ }, () => ({ path: 'firebase', namespace: 'stub' }));
      builder.onResolve({ filter: /^firebase\/firestore$/ }, () => ({ path: 'firestore', namespace: 'stub' }));
      // Chỉ cần hàm bỏ bộ nhớ danh sách miễn chấm của tab Đối soát, không kéo cả tab vào bản dựng.
      builder.onResolve({ filter: /^\.\/MealReconciliation$/ }, () => ({ path: 'reconciliation', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'firebase'
        ? 'export const auth = { currentUser: null }, db = {};'
        : args.path === 'reconciliation'
          ? 'export const invalidateCheckinExemptionCache = () => {};'
          : `const fail = () => { throw new Error('Firestore không được gọi khi render'); };
           export const collection = fail, doc = fail, getDoc = fail, onSnapshot = fail, runTransaction = fail;` }));
    },
  }]);
  lib = await load('../src/lib/checkinExemptionImport.ts');
});

const today = '2026-11-06';
const clock = { today, now: '11:00' };
const mail = name => `${name}@hoangmaistarschool.edu.vn`;
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const count = (html, text) => html.split(text).length - 1;

test('the manager renders its tools before data arrives without touching Firestore', () => {
  const html = render(ui.default, { registrations: [], selectedMonth: '2026-11', registrationsReady: true, showToast() {} });
  for (const text of ['Miễn chấm ăn theo bữa', 'Đang tải danh sách…', 'Tải tệp mẫu', 'Chọn tệp Excel / CSV', 'CSV UTF-8',
    'Gộp thêm thời hạn', 'Thay thời hạn từ ngày bắt đầu', 'Đối chiếu đơn đăng ký tháng 11/2026', 'min-h-11']) {
    assert.ok(html.includes(text), text);
  }
  const radios = html.match(/<input type="radio"[^>]*>/g);
  assert.equal(radios.length, 2);
  assert.match(radios.find(input => input.includes('value="merge"')), /checked=""/, 'mặc định gộp thêm thời hạn');
  assert.doesNotMatch(radios.find(input => input.includes('value="replace"')), /checked=""/);
  assert.match(html, /<option value="lunch" selected="">Bữa trưa<\/option>/, 'mặc định miễn bữa trưa');
  assert.doesNotMatch(html, /Bản ghi cần kiểm tra/);
  assert.doesNotMatch(html, /đang được miễn|Danh sách đã lưu \(|Chưa có nhân viên/, 'chưa tải xong thì không hiện số 0');
  const waiting = render(ui.default, { selectedMonth: '2026-11', registrations: [], registrationsReady: false });
  assert.match(waiting, /Đang tải đơn đăng ký tháng 11\/2026/);
  const failed = render(ui.default, { selectedMonth: '2026-11', registrations: [], registrationsReady: false,
    registrationsError: 'Chưa tải được đăng ký hoặc danh sách hủy ăn của tháng đã chọn.' });
  assert.ok(failed.includes('Chưa tải được đơn đăng ký tháng 11/2026 nên chưa đối chiếu được mã và email.'));
  assert.doesNotMatch(failed, /Đang tải đơn đăng ký/, 'listener lỗi thì không chờ mãi');
  const loaded = render(ui.default, { selectedMonth: '2026-11', registrations: [], registrationsReady: true,
    registrationsError: 'Chưa tải được danh sách hủy ăn.' });
  assert.match(loaded, /Đối chiếu đơn đăng ký tháng 11\/2026/, 'đơn đăng ký đã tải thì vẫn đối chiếu được');
});

test('an outdated HAC agent gets the prominent warning; an unknown version warns too; a current one shows nothing', () => {
  const html = render(ui.ExemptionAgentNotice, { status: { state: 'outdated', version: '2026-10-20.3' } });
  assert.match(html, /role="alert"/);
  assert.ok(html.includes('Agent trên máy HAC chưa được cập nhật (bản đang chạy: 2026-10-20.3).'));
  assert.ok(html.includes('Email cảnh báo thiếu chấm vẫn gửi cho người trong danh sách cho tới khi cập nhật agent.'));
  const unknown = render(ui.ExemptionAgentNotice, { status: { state: 'unknown' } });
  assert.ok(unknown.includes('Chưa kiểm tra được phiên bản agent trên máy HAC — nếu agent chưa cập nhật lên 2026-11-06.1, '
    + 'email cảnh báo thiếu chấm vẫn gửi cho người trong danh sách.'));
  assert.match(unknown, /bg-warning-container/, 'cảnh báo, không phải chữ mờ');
  assert.doesNotMatch(unknown, /text-on-surface-variant/);
  assert.equal(render(ui.ExemptionAgentNotice, { status: { state: 'ok' } }), '');
  assert.equal(render(ui.ExemptionAgentNotice, { status: { state: 'checking' } }), '');
});

test('broken stored documents are listed with doc id, reason, delete and (only when safe) automatic fix', () => {
  const good = lib.exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null);
  const stored = lib.readStoredExemptions([
    { id: '100001', data: good },
    { id: 'AutoId123', data: lib.exemptionDraft('100004', mail('d'), 'D', '2026-11-01', null) },
    { id: 'Copy', data: { ...good } },
    { id: 'Broken', data: { email: 'x' } },
  ]);
  const html = render(ui.ExemptionIssuesPanel, { issues: stored.issues, disabled: false, onDelete() {}, onFix() {} });
  assert.match(html, /Bản ghi cần kiểm tra \(3\)/);
  assert.ok(html.includes('Tài liệu “AutoId123” · mã 100004'));
  assert.ok(html.includes('Sửa tự động sẽ lưu: mã 100004'));
  assert.ok(html.includes('Đã có bản ghi hợp lệ của mã 100001'));
  assert.ok(html.includes('chưa biết bản ghi này thuộc về ai'));
  assert.equal(count(html, '>Xóa bản ghi lỗi<'), 3);
  assert.equal(count(html, '>Sửa tự động<'), 1);
  assert.equal(render(ui.ExemptionIssuesPanel, { issues: [], disabled: false, onDelete() {}, onFix() {} }), '');
});

test('a broken document without any staff code raises the “all missing-tap emails paused” alert', () => {
  const good = lib.exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null);
  const panel = docs => render(ui.ExemptionIssuesPanel,
    { issues: lib.readStoredExemptions(docs).issues, disabled: false, onDelete() {}, onFix() {} });
  const unknown = panel([{ id: '100001', data: good }, { id: 'Broken', data: { email: 'x' } }]);
  assert.match(unknown, /<div role="alert"[^>]*>.*Có 1 bản ghi lỗi không rõ mã nhân viên: agent đang tạm dừng toàn bộ email cảnh báo thiếu chấm/);
  assert.ok(unknown.includes('tab Đối soát chưa kết luận được ai thiếu chấm cho tới khi xóa hoặc sửa bản ghi này.'));
  assert.doesNotMatch(unknown, /vẫn dùng bình thường/, 'không nói các bản ghi khác vẫn dùng bình thường');
  const two = panel([{ id: 'Broken', data: { email: 'x' } }, { id: 'Other', data: [] }]);
  assert.ok(two.includes('Có 2 bản ghi lỗi không rõ mã nhân viên') && two.includes('xóa hoặc sửa các bản ghi này.'));
  const named = panel([{ id: '100001', data: good }, { id: 'Copy', data: { ...good } }]);
  assert.doesNotMatch(named, /role="alert"|không rõ mã nhân viên/);
  assert.ok(named.includes('Các bản ghi hợp lệ khác vẫn dùng bình thường.'));
});

test('the preview shows detected headers, resulting periods, flags and a secondary save for valid rows', () => {
  const rows = [['Mã NV', 'Email trường', 'Họ và tên'],
    ['100001', mail('a'), 'Người A'], ['100002', mail('b'), 'Người B'], ['100003', mail('c'), 'Người C'], ['12345', mail('e'), 'Sai mã'],
    ['', '', 'Người lập biểu']];
  const parsed = lib.parseExemptionRows(rows, today, '2026-11-20');
  const preview = { ...parsed, source: 'danh-sach.xlsx', kind: 'file', meals: ['lunch'], from: today, to: '2026-11-20', sheetName: 'DS' };
  const existing = new Map([
    ['100001', lib.exemptionDraft('100001', mail('a'), 'Người A', '2026-11-01', null)],
    ['100002', lib.exemptionDraft('100002', mail('b'), 'Người B', '2026-11-01', '2026-11-05')],
  ]);
  const plan = lib.planExemptionSave(preview.records, existing, 'merge', { clock, rowNumbers: preview.rowNumbers });
  const hintsFor = lib.createExemptionHints([{ employeeId: '100001', email: mail('a') }, { employeeId: '100003', email: mail('khac') }],
    [...existing.values()], '2026-11');
  const html = render(ui.ExemptionPreviewPanel, { preview, plan, mode: 'merge', hintsFor, monthLabel: '11/2026',
    disabled: false, saving: false, onSave() {}, onDiscard() {} });
  assert.ok(html.includes('Xem trước · danh-sach.xlsx · sheet “DS”'));
  assert.ok(html.includes('Cột đã nhận: “Mã NV” → Mã nhân viên · “Email trường” → Email · “Họ và tên” → Họ tên'));
  assert.ok(html.includes('1 mới · 1 thay đổi · 1 không thay đổi · 1 lỗi · 1 dòng bỏ qua'));
  for (const text of ['Không thay đổi', 'Đổi thời hạn', 'Mới', 'Giữ nguyên:', 'Sau khi lưu:', 'Hiện tại:', 'Dòng 2 · ',
    'Đang miễn không thời hạn — ngày kết thúc trong tệp không được áp dụng; chọn “Thay thời hạn” để đặt lại.',
    'Đơn đăng ký của mã này dùng email khác: khac@hoangmaistarschool.edu.vn', 'Khớp đơn 11/2026', 'Chưa có đơn 11/2026',
    'Đã bỏ qua 1 dòng không có mã nhân viên và email (dòng 6).', 'Dòng 5: Mã nhân viên phải gồm đúng 6 chữ số']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<button type="button" disabled="" class="[^"]*">Xác nhận lưu 3 nhân viên<\/button>/, 'có lỗi thì nút lưu chính bị khóa');
  assert.match(html, /<button type="button" class="[^"]*">Lưu 3 dòng hợp lệ, bỏ qua 1 dòng lỗi<\/button>/);

  const clean = { ...preview, errors: [] };
  const replace = lib.planExemptionSave(clean.records, existing, 'replace', { clock, rowNumbers: clean.rowNumbers });
  const replaced = render(ui.ExemptionPreviewPanel, { preview: clean, plan: replace, mode: 'replace', hintsFor: null,
    monthLabel: '11/2026', disabled: false, saving: false, onSave() {}, onDiscard() {} });
  assert.ok(replaced.includes('Cách lưu: Thay thời hạn từ ngày bắt đầu'));
  assert.ok(!replaced.includes('Đang miễn không thời hạn'), 'thay thời hạn thì ngày kết thúc được áp dụng');
  assert.ok(!replaced.includes('dòng hợp lệ, bỏ qua'), 'không lỗi thì không có nút lưu phần hợp lệ');
  assert.match(replaced, /<button type="button" class="[^"]*">Xác nhận lưu 3 nhân viên<\/button>/);
  assert.doesNotMatch(replaced, /sheet ẩn/);

  const hidden = render(ui.ExemptionPreviewPanel, { preview: { ...clean, sheetName: 'Nhân sự', sheetHidden: true,
    skippedSheets: [{ name: 'Hướng dẫn', reason: 'Không thấy hàng tiêu đề.', hidden: false }] }, plan: replace, mode: 'replace',
  hintsFor: null, monthLabel: '11/2026', disabled: false, saving: false, onSave() {}, onDiscard() {} });
  assert.ok(hidden.includes('Xem trước · danh-sach.xlsx · sheet “Nhân sự” (sheet ẩn)'));
  assert.ok(hidden.includes('Sheet bỏ qua: “Hướng dẫn” (Không thấy hàng tiêu đề.) Sheet ẩn chỉ được thử sau các sheet đang hiện.'));
  const skippedHidden = render(ui.ExemptionPreviewPanel, { preview: { ...clean, skippedSheets: [
    { name: 'A', reason: 'Thiếu cột.', hidden: false }, { name: 'B', reason: 'Thiếu cột.', hidden: true }] }, plan: replace,
  mode: 'replace', hintsFor: null, monthLabel: '11/2026', disabled: false, saving: false, onSave() {}, onDiscard() {} });
  assert.ok(skippedHidden.includes('Sheet bỏ qua: “A” (Thiếu cột.); “B” (sheet ẩn — Thiếu cột.) Sheet ẩn chỉ được thử sau'));
});

test('a saved record shows its state, account hints and per-meal actions timed to the meal windows', () => {
  const record = lib.exemptionDraft('100001', mail('a'), 'Người A', '2026-11-01', null, ['breakfast', 'lunch']);
  const hints = lib.createExemptionHints([{ employeeId: '100001', email: mail('khac') }], [record], '2026-11')(record);
  const props = { record, clock, held: false, hints, monthLabel: '11/2026', disabled: false,
    onStop() {}, onSetEnd: async () => true, onChangeEmail: async () => true, onRemove() {} };
  const html = render(ui.ExemptionRecordItem, props);
  for (const text of ['Đang miễn chấm', 'Email khác đơn', 'Ngừng miễn sáng', 'Ngừng miễn trưa', 'Đặt ngày kết thúc', 'Sửa email',
    'Xóa khỏi danh sách', 'Bữa sáng và bữa trưa · Từ 01/11/2026 · Chưa có ngày kết thúc',
    'Đơn đăng ký của mã này dùng email khác: khac@hoangmaistarschool.edu.vn']) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /Chưa xác định|tạm ngưng/);
  const held = render(ui.ExemptionRecordItem, { ...props, held: true, hints: null });
  assert.ok(held.includes('Chưa xác định · cần kiểm tra'));
  assert.doesNotMatch(held, /Đang miễn chấm/, 'mã đang bị giữ thì không hiện trạng thái miễn bình thường');
  assert.ok(held.includes('Miễn chấm của mã này đang tạm ngưng cho tới khi xóa hoặc sửa bản ghi lỗi cùng mã'));
  assert.doesNotMatch(held, /Email khác đơn/);

  const endsToday = lib.exemptionDraft('100001', mail('a'), 'Người A', '2026-11-01', today);
  const finished = render(ui.ExemptionRecordItem, { ...props, record: endsToday, hints: null });
  assert.doesNotMatch(finished, /Ngừng miễn trưa/, 'bữa trưa đã mở và khoảng miễn hết hôm nay: không còn gì để ngừng');
  assert.doesNotMatch(finished, /Đặt ngày kết thúc/);
  const morning = render(ui.ExemptionRecordItem, { ...props, record: endsToday, hints: null, clock: { today, now: '09:00' } });
  assert.match(morning, /Ngừng miễn trưa/);
});
