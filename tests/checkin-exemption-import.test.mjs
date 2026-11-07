// Offline import/date-policy checks. No Firebase, employee lists or mail access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const xlsx = require('xlsx');
let lib;
let parseExemptionRows, exemptionDraft, mergeExemptionRecord, stopExemptionToday, exemptionState;
test.before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/checkinExemptionImport.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  lib = module.exports;
  ({ parseExemptionRows, exemptionDraft, mergeExemptionRecord, stopExemptionToday, exemptionState } = lib);
});

const from = '2026-11-06';
const row = ['100001', 'TEST@HOANGMAISTARSCHOOL.EDU.VN', 'Nhân viên mẫu'];
const period = (from, to = null, meals = ['lunch']) => ({ from, to, meals });
const mail = name => `${name}@hoangmaistarschool.edu.vn`;
const book = sheets => {
  const workbook = xlsx.utils.book_new();
  for (const [name, sheet] of sheets) xlsx.utils.book_append_sheet(workbook, sheet, name);
  return workbook;
};

test('imports reordered Vietnamese headers and normalizes exactly the reviewed employee identity', () => {
  const parsed = parseExemptionRows([['Danh sách'], ['Họ và tên', 'Email trường', 'Mã NV'],
    ['Nhân viên mẫu', ' TEST@HOANGMAISTARSCHOOL.EDU.VN ', '100001 ']], from, null);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.records, [{ employeeId: '100001', email: 'test@hoangmaistarschool.edu.vn',
    fullName: 'Nhân viên mẫu', periods: [period(from)] }]);
  assert.deepEqual(parsed.headers, { employeeId: 'Mã NV', email: 'Email trường', fullName: 'Họ và tên' });
  assert.deepEqual(parsed.rowNumbers, { 100001: 3 });
});

test('duplicate IDs, duplicate email and invalid identities make preview non-saveable instead of silently dropping rows', () => {
  const parsed = parseExemptionRows([['Mã nhân viên', 'Email', 'Họ tên'], row,
    ['100001', 'other@hoangmaistarschool.edu.vn', 'Người khác'],
    ['100002', 'test@hoangmaistarschool.edu.vn', 'Người khác'],
    ['100003', 'someone@example.org', 'Người ngoài']], from, null);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0], /Dòng 3.*bị lặp trong tệp \(đã có ở dòng 2\)/);
  assert.match(parsed.errors[1], /Email bị lặp/);
  assert.match(parsed.errors[2], /^Dòng 5: Email phải là địa chỉ @hoangmaistarschool\.edu\.vn/, 'thông báo theo đúng trường bị sai');
  assert.throws(() => parseExemptionRows([['Mã NV', 'Họ tên']], from, null), /ba cột.*\(thiếu cột Email\)/);
  assert.throws(() => parseExemptionRows([['Danh sách'], ['A', 'B']], from, null), /ba cột [^(]*\. Tải tệp mẫu/);
});

test('dates, file size-by-row and multiline names fail validation before a save can be created', () => {
  assert.throws(() => exemptionDraft(...row, '2026-02-30', null), /ngày/);
  assert.throws(() => exemptionDraft(...row, from, '2026-11-05'), /ngày/);
  assert.throws(() => exemptionDraft('100001', row[1], 'Họ\nTên', from, null), /một dòng/);
  assert.throws(() => exemptionDraft('100001', row[1], '   ', from, null), /Họ tên không được để trống/);
  assert.throws(() => exemptionDraft(...row, '0026-11-06', null), /năm của ngày bắt đầu \(đang là 0026\)/, 'gõ dở năm trong ô chọn ngày');
  assert.throws(() => exemptionDraft(...row, from, '20266-01-01'), /ngày kết thúc/);
  assert.throws(() => parseExemptionRows([['ID', 'Email', 'Full name'], ...Array.from({ length: 501 }, () => row)], from, null), /500/);
});

test('merging preserves closed history, combines overlap idempotently and rejects assigning same ID to another email', () => {
  const existing = { ...exemptionDraft(...row, '2026-09-01', '2026-09-30'),
    periods: [period('2026-09-01', '2026-09-30'), period('2026-11-01', '2026-11-10')] };
  const draft = exemptionDraft(...row, from, null);
  const merged = mergeExemptionRecord(existing, draft);
  assert.deepEqual(merged.periods, [period('2026-09-01', '2026-09-30'), period('2026-11-01')]);
  assert.deepEqual(mergeExemptionRecord(merged, draft), merged);
  assert.throws(() => mergeExemptionRecord(existing, { ...draft, email: 'other@hoangmaistarschool.edu.vn' }), /email khác/);
});

// Trước đây "ngừng từ hôm nay" luôn kết thúc khoảng miễn ở hôm qua — kể cả khi
// bữa trưa đã mở và nhân viên đã không chấm vì đang được miễn. Nay hiệu lực
// phụ thuộc giờ Việt Nam so với giờ mở khung bữa (MEAL_WINDOWS).
test('stopping before the meal window ends the exemption yesterday; once the window opened today stays exempt', () => {
  const existing = { ...exemptionDraft(...row, '2026-09-01', '2026-09-30'),
    periods: [period('2026-09-01', '2026-09-30'), period('2026-11-01', '2026-11-10'), period('2026-12-01')] };
  const early = stopExemptionToday(existing, from, 'lunch', '09:59');
  assert.deepEqual(early.periods, [period('2026-09-01', '2026-09-30'), period('2026-11-01', '2026-11-05')]);
  assert.equal(lib.stopEffectiveDate(from, 'lunch', '09:59'), from);
  assert.equal(exemptionState(early, from), 'ended');
  const late = stopExemptionToday(existing, from, 'lunch', '10:00');
  assert.deepEqual(late.periods, [period('2026-09-01', '2026-09-30'), period('2026-11-01', from)]);
  assert.equal(lib.stopEffectiveDate(from, 'lunch', '10:00'), '2026-11-07');
  assert.equal(exemptionState(late, from), 'active');
  assert.equal(exemptionState(existing, from), 'active');

  const startsToday = exemptionDraft(...row, from, null);
  assert.equal(stopExemptionToday(startsToday, from, 'lunch', '09:00'), null, 'chưa tới giờ ăn: xóa được');
  assert.deepEqual(stopExemptionToday(startsToday, from, 'lunch', '12:30').periods, [period(from, from)],
    'bữa đã mở hôm nay: không bao giờ xóa bản ghi đang miễn bữa đó');
  assert.equal(stopExemptionToday(exemptionDraft(...row, '2026-12-01', null), from, 'lunch', '12:30'), null);

  assert.equal(lib.stopEffectiveDate(from, 'breakfast', '04:59'), from);
  assert.equal(lib.stopEffectiveDate(from, 'breakfast', '05:00'), '2026-11-07');
  assert.throws(() => stopExemptionToday(existing, from, 'lunch', '25:00'), /Giờ hiện tại/);

  const endsToday = exemptionDraft(...row, '2026-11-01', from);
  assert.deepEqual(lib.stoppableMeals(endsToday, from, '09:00'), ['lunch']);
  assert.deepEqual(lib.stoppableMeals(endsToday, from, '10:30'), [], 'hết hạn hôm nay sau giờ mở khung: không còn gì để ngừng');
});

test('import can select breakfast or both meals while omitted selection defaults to lunch', () => {
  const rows = [['Mã nhân viên', 'Email', 'Họ tên'], row];
  assert.deepEqual(parseExemptionRows(rows, from, null).records[0].periods[0].meals, ['lunch']);
  assert.deepEqual(parseExemptionRows(rows, from, null, ['breakfast']).records[0].periods[0].meals, ['breakfast']);
  assert.deepEqual(parseExemptionRows(rows, from, null, ['breakfast', 'lunch']).records[0].periods[0].meals, ['breakfast', 'lunch']);
});

test('overlapping different meals retain their own periods and stopping one meal preserves the other', () => {
  const lunch = exemptionDraft(...row, '2026-11-01', null);
  const breakfast = exemptionDraft(...row, '2026-11-03', '2026-11-30', ['breakfast']);
  const merged = mergeExemptionRecord(lunch, breakfast);
  assert.deepEqual(merged.periods, [period('2026-11-01'), period('2026-11-03', '2026-11-30', ['breakfast'])]);
  assert.deepEqual(mergeExemptionRecord(merged, breakfast), merged);
  const stopped = stopExemptionToday(merged, from, 'lunch', '09:00');
  assert.deepEqual(stopped.periods, [period('2026-11-01', '2026-11-05'), period('2026-11-03', '2026-11-30', ['breakfast'])]);
  assert.equal(exemptionState(stopped, from), 'active');
  const both = exemptionDraft(...row, '2026-11-01', null, ['breakfast', 'lunch']);
  const lunchOnly = stopExemptionToday(both, from, 'breakfast', '04:30');
  assert.ok(lunchOnly.periods.some(value => value.meals.includes('lunch') && value.to === null));
  assert.ok(lunchOnly.periods.some(value => value.meals.includes('breakfast') && value.to === '2026-11-05'));
  const afterBreakfast = stopExemptionToday(both, from, 'breakfast', '07:00');
  assert.ok(afterBreakfast.periods.some(value => value.meals.includes('breakfast') && value.to === from));
});

test('“Thay thời hạn” keeps days before the start date, drops the rest and touches only the selected meals', () => {
  const both = exemptionDraft(...row, '2026-10-01', null, ['breakfast', 'lunch']);
  const draft = exemptionDraft(...row, from, '2026-11-20');
  const replaced = lib.replaceExemptionPeriods(both, draft);
  assert.deepEqual(replaced.periods, [period('2026-10-01', null, ['breakfast']), period('2026-10-01', '2026-11-05'),
    period(from, '2026-11-20')]);
  assert.deepEqual(lib.replaceExemptionPeriods(replaced, draft), replaced, 'lưu lại lần nữa không đổi gì');

  const month = { ...both, periods: [period('2026-10-01', '2026-10-31'), period('2026-11-01', '2026-11-30')] };
  const short = exemptionDraft(...row, from, '2026-11-10');
  assert.deepEqual(lib.applyExemptionDraft(month, short, 'merge').periods, month.periods, 'gộp: khoảng dài hơn giữ nguyên');
  assert.deepEqual(lib.applyExemptionDraft(month, short, 'replace').periods,
    [period('2026-10-01', '2026-10-31'), period('2026-11-01', '2026-11-05'), period(from, '2026-11-10')]);
  const later = { ...both, periods: [period('2026-10-01', '2026-10-31'), period('2026-11-10', '2026-11-30')] };
  assert.deepEqual(lib.replaceExemptionPeriods(later, exemptionDraft(...row, from, null)).periods,
    [period('2026-10-01', '2026-10-31'), period(from)], 'phần bắt đầu sau ngày bắt đầu bị bỏ');
  assert.throws(() => lib.replaceExemptionPeriods(both, { ...draft, email: mail('other') }), /email khác/);
});

test('the preview plan shows resulting periods, unchanged rows, absorbed end dates and blocked codes', () => {
  const open = exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null);
  const closed = exemptionDraft('100002', mail('b'), 'B', '2026-11-01', '2026-11-05');
  const existing = new Map([[open.employeeId, open], [closed.employeeId, closed]]);
  const drafts = [
    exemptionDraft('100001', mail('a'), 'A', from, '2026-11-20'),
    exemptionDraft('100002', mail('b'), 'B', from, '2026-11-20'),
    exemptionDraft('100003', mail('c'), 'C', from, null),
    exemptionDraft('100004', mail('d'), 'D', from, null),
  ];
  const clock = { today: from, now: '11:00' };
  const plan = lib.planExemptionSave(drafts, existing, 'merge',
    { clock, blocked: new Map([['100004', 'Mã này đang có bản ghi cần kiểm tra.']]), rowNumbers: { 100001: 2 } });
  assert.deepEqual(plan.rows.map(item => item.status), ['unchanged', 'changed', 'new', 'error']);
  assert.equal(plan.rows[0].absorbedEnd, true, 'ngày kết thúc 20/11 bị khoảng không thời hạn nuốt');
  assert.equal(plan.rows[0].row, 2);
  assert.deepEqual(plan.rows[1].after.periods, [period('2026-11-01', '2026-11-05'), period(from, '2026-11-20')]);
  assert.equal(plan.rows[1].absorbedEnd, false);
  assert.match(plan.rows[3].error, /bản ghi cần kiểm tra/);
  assert.deepEqual(plan.counts, { new: 1, changed: 1, unchanged: 1, error: 1 });
  assert.equal(plan.writes, 2);

  const replace = lib.planExemptionSave(drafts.slice(0, 1), existing, 'replace', { clock });
  assert.equal(replace.rows[0].status, 'changed');
  assert.equal(replace.rows[0].absorbedEnd, false);
  assert.deepEqual(replace.rows[0].after.periods, [period('2026-11-01', '2026-11-05'), period(from, '2026-11-20')]);

  const split = { ...open, periods: [period('2026-11-01', '2026-11-05'), period(from)] };
  assert.equal(lib.planExemptionRow(split, exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null), 'merge').status,
    'unchanged', 'cùng các ngày được miễn thì không ghi lại');

  const pastOnly = exemptionDraft('100001', mail('a'), 'A', '2026-11-01', '2026-11-03');
  assert.deepEqual(lib.planExemptionRow(open, pastOnly, 'replace', clock).dropsStartedToday, ['lunch']);
  assert.deepEqual(lib.planExemptionRow(open, pastOnly, 'replace', { today: from, now: '09:00' }).dropsStartedToday, []);

  const renamed = lib.planExemptionRow(open, exemptionDraft('100001', mail('a'), 'Tên mới', '2026-11-01', null), 'merge');
  assert.deepEqual([renamed.status, renamed.periodsChanged, renamed.nameChanged], ['changed', false, true]);
  assert.match(lib.planExemptionRow(open, exemptionDraft('100001', mail('x'), 'A', from, null), 'merge').error, /email khác/);
});

test('thousands separators and spaces are stripped from numeric IDs but lost leading zeros are never padded', () => {
  for (const value of ['101,190', '101.190', '101 190', '101190.00', '101.190,00', ' 101190 ', 101190]) {
    assert.equal(lib.cleanEmployeeIdCell(value), '101190', String(value));
  }
  assert.equal(lib.cleanEmployeeIdCell('12345'), '12345');
  assert.equal(lib.cleanEmployeeIdCell('12.5'), '12.5');
  assert.equal(exemptionDraft('101.190', mail('a'), 'A', from, null).employeeId, '101190', 'ô nhập tay cũng được làm sạch');
  const parsed = parseExemptionRows([['Mã nhân viên', 'Email', 'Họ tên'], ['101,190', mail('a'), 'A'], ['12345', mail('b'), 'B']], from, null);
  assert.deepEqual(parsed.records.map(item => item.employeeId), ['101190']);
  assert.match(parsed.errors[0], /^Dòng 3: Mã nhân viên phải gồm đúng 6 chữ số \(đang là "12345"\)/);
  assert.match(parsed.errors[0], /Văn bản \(Text\)/);
});

test('footer and signature rows without ID and email are ignored and reported, not counted as errors', () => {
  const parsed = parseExemptionRows([['Mã NV', 'Email', 'Họ tên'], row, ['', '', 'Người lập biểu'], ['', '', ''],
    ['', ' ', 'Hà Nội, ngày 06/11/2026'], ['000000', 'vi.du@hoangmaistarschool.edu.vn', 'Dòng ví dụ']], from, null);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.ignored, [{ row: 3, reason: 'blank' }, { row: 5, reason: 'blank' }, { row: 6, reason: 'example' }]);
  assert.equal(lib.describeIgnoredRows(parsed.ignored),
    ' Đã bỏ qua 2 dòng không có mã nhân viên và email (dòng 3, 5) và dòng ví dụ của tệp mẫu (dòng 6).');
  assert.throws(() => parseExemptionRows([['Mã NV', 'Email', 'Họ tên'], ['', '', 'Người lập biểu']], from, null),
    /Chưa có nhân viên nào.*1 dòng không có mã nhân viên và email/);
});

test('specific ID headers win over the generic “ID” column and every staff-code alias is recognised', () => {
  const parsed = parseExemptionRows([['STT', 'ID', 'MSNV', 'Địa chỉ email', 'Họ và tên'], [1, '7', '100001', mail('a'), 'A']], from, null);
  assert.equal(parsed.records[0].employeeId, '100001');
  assert.deepEqual(parsed.headers, { employeeId: 'MSNV', email: 'Địa chỉ email', fullName: 'Họ và tên' });
  assert.equal(parseExemptionRows([['ID', 'Mã số', 'Email', 'Họ tên'], ['7', '100001', mail('a'), 'A']], from, null)
    .headers.employeeId, 'Mã số');
  for (const header of ['Mã nhân viên', 'Mã số nhân viên', 'Mã NV', 'MSNV', 'Mã CBGV-NV', 'Mã CBNV', 'Mã nhân sự', 'Mã cán bộ', 'Mã số', 'ID']) {
    assert.equal(parseExemptionRows([[header, 'Email', 'Họ tên'], row], from, null).records.length, 1, header);
  }
});

test('CSV bytes decode as UTF-8 (with BOM), falling back to Windows-1258; UTF-16 Unicode text also works', () => {
  const text = 'Mã nhân viên,Email,Họ tên\n101190,a@hoangmaistarschool.edu.vn,Nguyễn Thị Hà\n';
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, 'utf8')]);
  assert.equal(lib.decodeCsvBytes(utf8), text);
  assert.equal(lib.decodeCsvBytes(new Uint8Array([...Buffer.from('Ho ten,'), 0x48, 0xe0, 0x20, 0xd0, 0xf5])), 'Ho ten,Hà Đơ');
  assert.equal(lib.decodeCsvBytes(new Uint8Array([0xff, 0xfe, ...Buffer.from(text, 'utf16le')])), text);
  const parsed = lib.parseExemptionWorkbook(xlsx, lib.readExemptionWorkbook(xlsx, utf8, 'danh-sach.csv'), from, null);
  assert.equal(parsed.records[0].fullName, 'Nguyễn Thị Hà');
  assert.equal(parsed.records[0].employeeId, '101190');
  assert.throws(() => lib.readExemptionWorkbook(xlsx, utf8, 'danh-sach.txt'), /định dạng/);
  assert.throws(() => lib.readExemptionWorkbook(xlsx, new Uint8Array(), 'trong.csv'), /trống/);
});

test('whole sheets are read; sheets without headers or over the row limit are skipped without aborting the next one', () => {
  const notes = xlsx.utils.aoa_to_sheet([['Hướng dẫn'], ['Điền danh sách ở sheet DS']]);
  const tooMany = xlsx.utils.aoa_to_sheet([['Mã nhân viên', 'Email', 'Họ tên'],
    ...Array.from({ length: 501 }, (_, index) => [String(200000 + index), mail(`p${index}`), `Người ${index}`])]);
  const list = xlsx.utils.aoa_to_sheet([['Danh sách miễn chấm'], [], ['Mã nhân viên', 'Email', 'Họ tên'], row, [],
    ['ABC', mail('x'), 'X'], ['', '', 'Người lập biểu']]);
  list['!ref'] = 'A1:C20000'; // định dạng ô kéo tới tận dòng 20000 — bản cũ từ chối cả tệp
  const bytes = new Uint8Array(xlsx.write(book([['Hướng dẫn', notes], ['Quá nhiều', tooMany], ['DS', list]]), { bookType: 'xlsx', type: 'array' }));
  const parsed = lib.parseExemptionWorkbook(xlsx, lib.readExemptionWorkbook(xlsx, bytes, 'danh-sach.xlsx'), from, null);
  assert.equal(parsed.sheetName, 'DS');
  assert.deepEqual(parsed.skippedSheets.map(sheet => sheet.name), ['Hướng dẫn', 'Quá nhiều']);
  assert.match(parsed.skippedSheets[1].reason, /tối đa 500 nhân viên, sheet này có 501/);
  assert.deepEqual(parsed.rowNumbers, { 100001: 4 }, 'số dòng đúng như trong Excel dù đã bỏ dòng trống');
  assert.match(parsed.errors[0], /^Dòng 6:/);
  assert.deepEqual(parsed.ignored, [{ row: 7, reason: 'blank' }]);
  assert.throws(() => lib.parseExemptionWorkbook(xlsx, book([['Hướng dẫn', notes], ['Quá nhiều', tooMany]]), from, null),
    /Sheet “Hướng dẫn”: .*ba cột.*Sheet “Quá nhiều”: .*500/);
  assert.throws(() => lib.parseExemptionWorkbook(xlsx, book([['Quá nhiều', tooMany]]), from, null), /tối đa 500/);
});

test('the template has the three standard headers and one fake example row that is ignored when re-imported', () => {
  const workbook = lib.readExemptionWorkbook(xlsx, lib.createExemptionTemplate(xlsx), 'Mau-danh-sach-mien-cham-an.xlsx');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false });
  assert.deepEqual(rows[0], ['Mã nhân viên', 'Email', 'Họ tên']);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], '000000');
  assert.throws(() => lib.parseExemptionWorkbook(xlsx, workbook, from, null), /dòng ví dụ của tệp mẫu/);
  xlsx.utils.sheet_add_aoa(sheet, [row], { origin: -1 });
  const parsed = lib.parseExemptionWorkbook(xlsx, workbook, from, null);
  assert.deepEqual(parsed.records.map(item => item.employeeId), ['100001']);
  assert.deepEqual(parsed.ignored, [{ row: 2, reason: 'example' }]);
});

test('account hints compare the selected month registrations by code and email', () => {
  const a = exemptionDraft('100001', mail('a'), 'A', from, null);
  const b = exemptionDraft('100002', mail('b'), 'B', from, null);
  const hintsFor = lib.createExemptionHints([
    { employeeId: '100001', email: ' A@HoangMaiStarSchool.edu.vn' },
    { employeeId: ' 100002', email: mail('other') },
    { employeeId: '100009', email: mail('c') },
    { employeeId: '100004' },
  ], [a, b], '2026-11');
  assert.deepEqual(hintsFor(a).map(hint => [hint.kind, hint.level]), [['matched', 'ok']]);
  const mismatch = hintsFor(b);
  assert.deepEqual(mismatch.map(hint => [hint.kind, hint.level]), [['registrationEmail', 'warning']]);
  assert.match(mismatch[0].message, /^Đơn đăng ký của mã này dùng email khác: other@hoangmaistarschool\.edu\.vn\. Miễn chấm sẽ không được áp dụng/);
  assert.deepEqual(mismatch[0].emails, [mail('other')]);
  const missing = hintsFor({ employeeId: '100003', email: mail('c') });
  assert.deepEqual(missing.map(hint => [hint.kind, hint.level]), [['noRegistration', 'info']]);
  assert.equal(missing[0].message, 'Chưa có đơn đăng ký tháng 11/2026 với mã này — email này đăng ký với mã 100009.');
  assert.match(hintsFor({ employeeId: '100004', email: mail('d') })[0].message, /\(đơn không có email\)/);
  const twice = lib.createExemptionHints([{ employeeId: '100001', email: mail('a') }, { employeeId: '100001', email: mail('canhan') }],
    [a], '2026-11')(a);
  assert.deepEqual(twice.map(hint => hint.kind), ['matched', 'registrationEmail'], 'mã đăng ký bằng hai tài khoản');
  assert.match(twice[1].message, /^Mã này còn đơn đăng ký khác dùng email khác: canhan@/);
  const taken = lib.createExemptionHints([], [a, { ...b, email: a.email }], '2026-11')(a);
  assert.deepEqual(taken.map(hint => hint.kind), ['noRegistration', 'emailTaken']);
  assert.equal(taken[1].message, 'Email này đã gắn với mã khác trong danh sách: 100002.');
});

test('setting an end date respects meals that already started today; changing email keeps every period', () => {
  const both = exemptionDraft(...row, '2026-11-01', null, ['breakfast', 'lunch']);
  assert.deepEqual(lib.openEndedMeals(both), ['breakfast', 'lunch']);
  assert.equal(lib.endDateMinimum(both, 'lunch', from, '09:00'), '2026-11-05');
  assert.equal(lib.endDateMinimum(both, 'lunch', from, '10:00'), from);
  assert.throws(() => lib.setExemptionEndDate(both, 'lunch', '2026-11-05', from, '10:00'),
    /sớm nhất là 06\/11\/2026 vì bữa trưa hôm nay đã bắt đầu/);
  const ended = lib.setExemptionEndDate(both, 'lunch', '2026-11-20', from, '10:00');
  assert.deepEqual(ended.periods, [period('2026-11-01', null, ['breakfast']), period('2026-11-01', '2026-11-20')]);
  assert.deepEqual(lib.openEndedMeals(ended), ['breakfast']);
  assert.throws(() => lib.setExemptionEndDate(ended, 'lunch', '2026-11-25', from, '10:00'), /chưa có ngày kết thúc/);
  assert.equal(lib.endDateMinimum(exemptionDraft(...row, '2026-12-01', null), 'lunch', from, '11:00'), '2026-12-01');
  const moved = lib.changeExemptionEmail(ended, ' New.Mail@HoangMaiStarSchool.edu.vn ');
  assert.equal(moved.email, 'new.mail@hoangmaistarschool.edu.vn');
  assert.deepEqual(moved.periods, ended.periods);
  assert.throws(() => lib.changeExemptionEmail(ended, 'a@gmail.com'), /@hoangmaistarschool\.edu\.vn/);
});

test('stored documents are split one by one: broken ones get a reason and a safe automatic fix when possible', () => {
  const good = exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null);
  const stored = lib.readStoredExemptions([
    { id: '100001', data: { ...good, updatedAt: '2026-11-01T00:00:00.000Z', updatedBy: 'admin' } },
    { id: '100003', data: { ...exemptionDraft('100003', mail('c'), 'C', '2026-11-01', null), email: ' C@HoangMaiStarSchool.edu.vn' } },
    { id: 'AutoId123', data: exemptionDraft('100004', mail('d'), 'D', '2026-11-01', null) },
    { id: 'Copy', data: { ...good } },
    { id: '100005', data: exemptionDraft('100006', mail('f'), 'F', '2026-11-01', null) },
    { id: '100007', data: { ...exemptionDraft('100007', mail('g'), 'G', '2026-11-01', null), employeeId: 100007 } },
    { id: 'Broken', data: { email: 'x' } },
    { id: '100008', data: exemptionDraft('100009', mail('h'), 'H', '2026-11-01', null) },
    { id: 'Twin', data: exemptionDraft('100008', mail('h'), 'H', '2026-11-01', null) },
  ]);
  assert.deepEqual(stored.records.map(item => item.employeeId), ['100001'], 'bản ghi hợp lệ vẫn dùng được');
  assert.deepEqual([...stored.held], ['100001'], 'bản ghi lỗi "Copy" cũng mang mã 100001');
  assert.equal(stored.unidentified, 1, 'chỉ "Broken" không nêu được mã nào');
  const issues = Object.fromEntries(stored.issues.map(issue => [issue.docId, issue]));
  assert.deepEqual(Object.keys(issues).sort(), ['100003', '100005', '100007', '100008', 'AutoId123', 'Broken', 'Copy', 'Twin']);
  assert.equal(issues.Twin.fix, null, 'tài liệu đích 100008 đã tồn tại (đang lỗi): không ghi đè');
  assert.match(issues.Twin.fixNote, /Tài liệu “100008” cũng đang lỗi/);
  assert.deepEqual(issues['100008'].codes, ['100008', '100009'], 'mọi mã bản ghi lỗi nhắc tới');
  assert.equal(issues['100003'].fix.email, mail('c'));
  assert.equal(issues.AutoId123.fix.employeeId, '100004');
  assert.equal(issues['100007'].fix.employeeId, '100007');
  assert.equal(issues.Copy.fix, null);
  assert.match(issues.Copy.fixNote, /Đã có bản ghi hợp lệ của mã 100001/);
  assert.equal(issues['100005'].fix, null);
  assert.match(issues['100005'].fixNote, /Mã tài liệu 100005 khác mã nhân viên 100006/);
  assert.equal(issues.Broken.fix, null);
  assert.equal(issues.Broken.employeeId, null);
  assert.deepEqual(issues.Broken.codes, []);
  assert.ok(issues.Broken.reason.length > 0);
  assert.throws(() => lib.prepareExemptionAutoFix('100005', exemptionDraft('100006', mail('f'), 'F', from, null)), /không sửa tự động/);
});

test('automatic fix is withheld when several broken documents resolve to the same staff code', () => {
  const draft = email => exemptionDraft('100004', email, 'D', '2026-11-01', null);
  const differ = lib.readStoredExemptions([{ id: 'Auto1', data: draft(mail('d')) }, { id: 'Auto2', data: draft(mail('khac')) }]);
  for (const issue of differ.issues) {
    assert.equal(issue.fix, null, issue.docId);
    assert.equal(issue.fixNote, 'Có 2 bản ghi lỗi cùng mã 100004 với nội dung khác nhau — xóa bản sai rồi sửa tự động bản đúng.');
  }
  // Tài liệu đúng mã nhưng sai định dạng cũng là một bản: không biết bản nào đúng thì không đoán.
  const ownId = lib.readStoredExemptions([{ id: '100004', data: { ...draft(mail('d')), email: 'D@HoangMaiStarSchool.edu.vn' } },
    { id: 'Auto2', data: draft(mail('khac')) }]);
  assert.deepEqual(ownId.issues.map(issue => [issue.docId, issue.fix]), [['100004', null], ['Auto2', null]]);
  assert.match(ownId.issues[0].fixNote, /^Có 2 bản ghi lỗi cùng mã 100004 với nội dung khác nhau/);
  const same = lib.readStoredExemptions([{ id: 'Auto1', data: draft(mail('d')) }, { id: 'Auto2', data: draft(mail('d')) },
    { id: 'Auto3', data: draft(mail('d')) }]);
  assert.ok(same.issues.every(issue => issue.fix === null
    && issue.fixNote === 'Có 3 bản ghi lỗi cùng mã 100004 với nội dung giống nhau — xóa bớt bản thừa rồi sửa tự động bản còn lại.'));
  const single = lib.readStoredExemptions([{ id: 'Auto1', data: draft(mail('d')) }]);
  assert.equal(single.issues[0].fix.employeeId, '100004', 'một bản duy nhất vẫn sửa tự động được');
});

test('deleting a broken document explains who loses the exemption and when auto-fix keeps it', () => {
  const good = exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null);
  const stored = lib.readStoredExemptions([
    { id: '100001', data: good },
    { id: 'Copy', data: { ...good } },
    { id: 'AutoId123', data: exemptionDraft('100004', mail('d'), 'D', '2026-11-01', null) },
    { id: '100005', data: exemptionDraft('100006', mail('f'), 'F', '2026-11-01', null) },
    { id: 'Broken', data: { email: 'x' } },
  ]);
  const issue = id => stored.issues.find(item => item.docId === id);
  assert.deepEqual(lib.describeIssueRemoval(issue('AutoId123'), stored), [
    'Mã 100004 sẽ không còn được miễn chấm (sẽ nhận email cảnh báo nếu thiếu chấm).',
    'Muốn giữ miễn chấm, dùng “Sửa tự động”.',
  ]);
  assert.deepEqual(lib.describeIssueRemoval(issue('Copy'), stored),
    ['Mã 100001 sẽ dùng lại bản ghi hợp lệ đang có trong danh sách.']);
  assert.deepEqual(lib.describeIssueRemoval(issue('100005'), stored), [
    'Mã 100005 sẽ không còn được miễn chấm (sẽ nhận email cảnh báo nếu thiếu chấm).',
    'Mã 100006 sẽ không còn được miễn chấm (sẽ nhận email cảnh báo nếu thiếu chấm).',
  ], 'không có “Sửa tự động” thì không nhắc tới');
  assert.deepEqual(lib.describeIssueRemoval(issue('Broken'), stored),
    ['Sau khi xóa, agent gửi lại email cảnh báo thiếu chấm như bình thường và tab Đối soát kết luận lại được.']);
  const two = lib.readStoredExemptions([{ id: 'Broken', data: { email: 'x' } }, { id: 'Other', data: [] },
    { id: 'Auto1', data: exemptionDraft('100004', mail('d'), 'D', from, null) }, { id: 'Auto2', data: exemptionDraft('100004', mail('e'), 'D', from, null) }]);
  assert.equal(two.unidentified, 2);
  assert.match(lib.describeIssueRemoval(two.issues.find(item => item.docId === 'Broken'), two)[0],
    /^Vẫn còn 1 bản ghi lỗi không rõ mã khác nên agent tiếp tục tạm dừng/);
  assert.deepEqual(lib.describeIssueRemoval(two.issues.find(item => item.docId === 'Auto1'), two),
    ['Mã 100004 vẫn còn bản ghi lỗi khác cần xử lý.']);
});

// Tệp xuất từ phần mềm nhân sự hay khai <dimension ref="A1:Z1048576"> dù chỉ có vài
// dòng: bản cũ đi hết hơn một triệu dòng trống (14–25 giây, treo tab).
test('an inflated sheet dimension is never walked: only cells holding values are read', () => {
  const cells = {
    A1: { t: 's', v: 'Mã nhân viên' }, B1: { t: 's', v: 'Email' }, C1: { t: 's', v: 'Họ tên' },
    A2: { t: 's', v: '100001' }, B2: { t: 's', v: mail('a') }, C2: { t: 's', v: 'Người A' },
  };
  const huge = { '!ref': 'A1:Z1048576', ...cells };
  const started = performance.now();
  const parsed = lib.parseExemptionWorkbook(xlsx, { SheetNames: ['DS'], Sheets: { DS: huge } }, from, null);
  assert.ok(performance.now() - started < 1000, `đọc mất ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(parsed.records.map(item => item.employeeId), ['100001']);
  assert.deepEqual(parsed.rowNumbers, { 100001: 2 });

  // Ô lạc ở tận cuối sheet và ở cột XFD: không đi qua vùng trống ở giữa, không đọc quá 50 cột.
  const stray = { ...huge, '!ref': 'A1:XFD1048576', C1048576: { t: 's', v: 'Người lập biểu' }, XFD2: { t: 's', v: 'ghi chú' } };
  const read = lib.readSheetRows(xlsx, stray);
  assert.deepEqual(read.rowNumbers, [1, 2, 1048576]);
  assert.deepEqual(read.rows, [['Mã nhân viên', 'Email', 'Họ tên'], ['100001', mail('a'), 'Người A'], ['', '', 'Người lập biểu']]);
  const wide = { ...cells, '!ref': 'A1:CZ2', AX1: { t: 's', v: 'cột 50' }, AY1: { t: 's', v: 'cột 51' } };
  assert.equal(lib.readSheetRows(xlsx, wide).rows[0].length, lib.MAX_IMPORT_COLUMNS);
  const late = lib.parseExemptionWorkbook(xlsx, { SheetNames: ['DS'], Sheets: { DS: stray } }, from, null);
  assert.deepEqual(late.ignored, [{ row: 1048576, reason: 'blank' }]);

  // Vùng khai báo nhỏ hơn dữ liệu thật ("A1") cũng không làm mất dòng; ô trống/lỗi không tính là có dữ liệu.
  const small = { ...cells, '!ref': 'A1', A3: { t: 'z' }, B3: { t: 'e', v: 7 } };
  assert.deepEqual(lib.readSheetRows(xlsx, small).rowNumbers, [1, 2]);
  assert.deepEqual(lib.readSheetRows(xlsx, { '!ref': 'A1:C3' }), { rows: [], rowNumbers: [] });
});

test('hidden sheets are tried only after every visible sheet and are labelled as hidden', () => {
  const staff = xlsx.utils.aoa_to_sheet([['Mã nhân viên', 'Email', 'Họ tên'],
    ...Array.from({ length: 3 }, (_, index) => [String(200000 + index), mail(`p${index}`), `Người ${index}`])]);
  const list = xlsx.utils.aoa_to_sheet([['Mã nhân viên', 'Email', 'Họ tên'], row]);
  const notes = xlsx.utils.aoa_to_sheet([['Hướng dẫn']]);
  const roundTrip = workbook => lib.readExemptionWorkbook(xlsx,
    new Uint8Array(xlsx.write(workbook, { bookType: 'xlsx', type: 'array' })), 'danh-sach.xlsx');
  const first = book([['Nhân sự', staff], ['DS', list]]);
  xlsx.utils.book_set_sheet_visibility(first, 'Nhân sự', 1);
  const parsed = lib.parseExemptionWorkbook(xlsx, roundTrip(first), from, null);
  assert.equal(parsed.sheetName, 'DS', 'sheet ẩn đứng trước vẫn không được chọn');
  assert.equal(parsed.sheetHidden, false);
  assert.deepEqual(parsed.skippedSheets, []);

  const onlyHidden = book([['Nhân sự', staff], ['Hướng dẫn', notes]]);
  xlsx.utils.book_set_sheet_visibility(onlyHidden, 'Nhân sự', 2);
  const fallback = lib.parseExemptionWorkbook(xlsx, roundTrip(onlyHidden), from, null);
  assert.equal(fallback.sheetName, 'Nhân sự');
  assert.equal(fallback.sheetHidden, true);
  assert.deepEqual(fallback.skippedSheets.map(sheet => [sheet.name, sheet.hidden]), [['Hướng dẫn', false]]);

  const none = book([['Hướng dẫn', notes], ['Ẩn', xlsx.utils.aoa_to_sheet([['Ghi chú']])]]);
  xlsx.utils.book_set_sheet_visibility(none, 'Ẩn', 1);
  assert.throws(() => lib.parseExemptionWorkbook(xlsx, roundTrip(none), from, null),
    /Sheet “Hướng dẫn”: .*Sheet “Ẩn” \(sheet ẩn\): /);
});

test('names are stored in composed (NFC) form so decomposed Windows-1258 text matches and is not a rename', () => {
  // "Nguyễn" trong CSV Windows-1258: "Nguy" + ê (0xEA) + dấu ngã tách rời (0xDE) + "n".
  const bytes = new Uint8Array([...Buffer.from('Ma nhan vien,Email,Ho ten\n100001,a@hoangmaistarschool.edu.vn,Nguy'), 0xea, 0xde,
    ...Buffer.from('n\n')]);
  const text = lib.decodeCsvBytes(bytes);
  assert.ok(text.endsWith('Nguyễn\n'), 'ễ dựng sẵn (U+1EC5)');
  assert.equal(text, text.normalize('NFC'));
  const parsed = lib.parseExemptionWorkbook(xlsx, lib.readExemptionWorkbook(xlsx, bytes, 'danh-sach.csv'), from, null);
  assert.equal(parsed.records[0].fullName, 'Nguyễn');
  const composed = 'Nguyễn Thị Hà'.normalize('NFC');
  const decomposed = composed.normalize('NFD');
  assert.notEqual(decomposed, composed);
  assert.equal(exemptionDraft('100001', mail('a'), decomposed, from, null).fullName, composed);
  const stored = { ...exemptionDraft('100001', mail('a'), 'A', '2026-11-01', null), fullName: decomposed };
  const plan = lib.planExemptionRow(stored, exemptionDraft('100001', mail('a'), composed, '2026-11-01', null), 'merge');
  assert.deepEqual([plan.status, plan.nameChanged], ['unchanged', false], 'không hiện “Đổi họ tên” chỉ vì khác dạng dấu');
});

test('a stop is worded by its real effect: ending today, keeping today, or cancelling an upcoming period', () => {
  const open = exemptionDraft(...row, '2026-11-01', null);
  assert.deepEqual(lib.planExemptionStop(open, from, 'lunch', '11:00'),
    { effective: '2026-11-07', upcoming: null, keepsToday: true, keepsPast: true });
  assert.deepEqual(lib.planExemptionStop(open, from, 'lunch', '09:00'),
    { effective: from, upcoming: null, keepsToday: false, keepsPast: true });
  const future = exemptionDraft(...row, '2026-12-01', null);
  assert.deepEqual(lib.planExemptionStop(future, from, 'lunch', '11:00'),
    { effective: '2026-11-07', upcoming: [period('2026-12-01')], keepsToday: false, keepsPast: false });
  const startsToday = exemptionDraft(...row, from, null);
  assert.deepEqual(lib.planExemptionStop(startsToday, from, 'lunch', '09:00'),
    { effective: from, upcoming: [period(from)], keepsToday: false, keepsPast: false }, 'chưa tới giờ ăn: hủy cả hôm nay');
  const history = { ...open, periods: [period('2026-09-01', '2026-09-30'), period('2026-12-01', '2026-12-10'), period('2026-12-20')] };
  assert.deepEqual(lib.planExemptionStop(history, from, 'lunch', '09:00'),
    { effective: from, upcoming: [period('2026-12-01', '2026-12-10'), period('2026-12-20')], keepsToday: false, keepsPast: true });
  const endsToday = { ...open, periods: [period('2026-11-01', from), period('2026-12-01')] };
  assert.deepEqual(lib.planExemptionStop(endsToday, from, 'lunch', '11:00'),
    { effective: '2026-11-07', upcoming: [period('2026-12-01')], keepsToday: true, keepsPast: true });
  const both = exemptionDraft(...row, '2026-12-01', null, ['breakfast', 'lunch']);
  assert.deepEqual(lib.planExemptionStop(both, from, 'breakfast', '11:00').upcoming, [period('2026-12-01', null, ['breakfast'])]);
});
