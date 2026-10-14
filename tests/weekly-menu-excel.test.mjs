import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as xlsx from 'xlsx';

const WEEK = '2026-10-05';
const require = createRequire(import.meta.url);
let excel;

test.before(async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/weeklyMenuExcel.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  excel = module.exports;
});

const xmlEntry = (bytes, path) => {
  const cfb = xlsx.CFB ?? xlsx.default?.CFB;
  const archive = cfb.read(bytes, { type: 'array' });
  const entry = cfb.find(archive, '/' + path);
  assert.ok(entry, path);
  return new TextDecoder().decode(new Uint8Array(entry.content));
};

test('mẫu tải xuống là XLSX đọc được, đúng năm ngày và ô gộp/màu/khổ in của mẫu', () => {
  const bytes = excel.createWeeklyMenuTemplate(WEEK);
  const workbook = xlsx.read(bytes, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, ['Thực đơn']);
  const sheet = workbook.Sheets['Thực đơn'];
  assert.deepEqual(xlsx.utils.sheet_to_json(sheet, { header: 1 })[1].slice(3),
    ['05/10/2026', '06/10/2026', '07/10/2026', '08/10/2026', '09/10/2026']);
  assert.ok(sheet['!merges'].some(range => range.s.r === 3 && range.s.c === 0 && range.e.r === 8 && range.e.c === 0), 'ĂN TRƯA gộp đủ sáu hàng');
  const styles = xmlEntry(bytes, 'xl/styles.xml');
  assert.match(styles, /FFFCE5CD/);
  assert.match(styles, /FFCFE2F3/);
  assert.match(styles, /wrapText="1"/);
  const sheetXml = xmlEntry(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /orientation="landscape"/);
  assert.match(sheetXml, /r="D3"[^>]*s="2"/);
  assert.throws(() => excel.importWeeklyMenuSheet(workbook, 'Thực đơn', WEEK), /chưa có món/);
});

test('mẫu điền rồi import giữ món/ghi chú, ô nghỉ và từ chối tuần khác', async () => {
  const workbook = xlsx.read(excel.createWeeklyMenuTemplate(WEEK), { type: 'array' });
  const sheet = workbook.Sheets['Thực đơn'];
  sheet.D3 = { t: 's', v: 'Phở bò' };
  sheet.D4 = { t: 's', v: 'Vịt chiên riềng' };
  sheet.H9 = { t: 's', v: 'Sữa chua Vinamilk' };
  sheet.D11 = { t: 's', v: 'Có thể thay đổi theo nguồn thực phẩm.' };
  const file = new File([xlsx.write(workbook, { bookType: 'xlsx', type: 'array' })], 'Thuc-don.xlsx');
  const importedWorkbook = await excel.readWeeklyMenuWorkbook(file);
  const menu = excel.importWeeklyMenuSheet(importedWorkbook, 'Thực đơn', WEEK);
  assert.equal(menu.days[0].breakfast, 'Phở bò');
  assert.equal(menu.days[0].main, 'Vịt chiên riềng');
  assert.equal(menu.days[4].dessert, 'Sữa chua Vinamilk');
  assert.equal(menu.days[1].breakfast, '');
  assert.equal(menu.note, 'Có thể thay đổi theo nguồn thực phẩm.');
  assert.throws(() => excel.importWeeklyMenuSheet(importedWorkbook, 'Thực đơn', '2026-10-12'), /khác tuần/);
});

test('import XLS cũ và workbook nhiều trang tính vẫn lấy bảng được chọn', async () => {
  const workbook = excel.weeklyMenuWorkbook(WEEK);
  workbook.Sheets['Thực đơn'].D3 = { t: 's', v: 'Bún bung' };
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Hướng dẫn']]), 'Hướng dẫn');
  const file = new File([xlsx.write(workbook, { bookType: 'biff8', type: 'array' })], 'Thuc-don.xls');
  const loaded = await excel.readWeeklyMenuWorkbook(file);
  assert.equal(excel.importWeeklyMenuSheet(loaded, 'Thực đơn', WEEK).days[0].breakfast, 'Bún bung');
  assert.throws(() => excel.importWeeklyMenuSheet(loaded, 'Hướng dẫn', WEEK), /Không tìm thấy/);
});

test('ngày serial Excel 1904 chỉ đổi ngày, không đổi tên món dạng số', async () => {
  const workbook = excel.weeklyMenuWorkbook(WEEK);
  workbook.Workbook = { WBProps: { date1904: true } };
  const firstSerial = (Date.parse(`${WEEK}T00:00:00Z`) - Date.parse('1904-01-01T00:00:00Z')) / 86_400_000;
  for (let column = 3; column < 8; column++) {
    workbook.Sheets['Thực đơn'][xlsx.utils.encode_cell({ r: 1, c: column })] = { t: 'n', v: firstSerial + column - 3, z: 'dd/mm/yyyy' };
  }
  workbook.Sheets['Thực đơn'].D3 = { t: 'n', v: 1234 };
  const loaded = await excel.readWeeklyMenuWorkbook(new File([xlsx.write(workbook, { bookType: 'xlsx', type: 'array' })], '1904.xlsx'));
  const menu = excel.importWeeklyMenuSheet(loaded, 'Thực đơn', WEEK);
  assert.equal(menu.weekId, WEEK);
  assert.equal(menu.days[0].breakfast, '1234');
});

test('tệp sai định dạng/trống/quá lớn hoặc không có thực đơn bị từ chối', async () => {
  await assert.rejects(excel.readWeeklyMenuWorkbook(new File(['x'], 'menu.txt')), /\.xlsx/);
  await assert.rejects(excel.readWeeklyMenuWorkbook(new File([], 'menu.xlsx')), /trống/);
  await assert.rejects(excel.readWeeklyMenuWorkbook(new File([new Uint8Array(excel.MAX_MENU_FILE_SIZE + 1)], 'menu.xlsx')), /5 MB/);
  const broken = await excel.readWeeklyMenuWorkbook(new File(['not an Excel file'], 'broken.xlsx'));
  assert.throws(() => excel.importWeeklyMenuSheet(broken, broken.SheetNames[0], WEEK), /Không tìm thấy/);
});

test('tệp lớn hơn giới hạn hàng không được cắt rồi import một phần âm thầm', async () => {
  const workbook = excel.weeklyMenuWorkbook(WEEK);
  workbook.Sheets['Thực đơn'].D3 = { t: 's', v: 'Phở bò' };
  workbook.Sheets['Thực đơn'].H502 = { t: 's', v: 'Bảng tiếp theo' };
  workbook.Sheets['Thực đơn']['!ref'] = 'A1:H502';
  const file = new File([xlsx.write(workbook, { bookType: 'xlsx', type: 'array' })], 'long.xlsx');
  const loaded = await excel.readWeeklyMenuWorkbook(file);
  assert.throws(() => excel.importWeeklyMenuSheet(loaded, 'Thực đơn', WEEK), /500/);
});
