import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftDate } from '../lib/survey.mjs';
import {
  MENU_ROWS, createEmptyMenu, normalizeWeeklyMenu, hasMenuContent,
  parseWeeklyMenuRows, renderWeeklyMenuEmail,
} from '../lib/weekly-menu.mjs';

const WEEK = '2026-10-05';
const DATE_LABELS = ['05/10/2026', '06/10/2026', '07/10/2026', '08/10/2026', '09/10/2026'];
const DISHES = [
  ['Phở bò', 'Bún bung ✅', 'Bánh khúc', 'Mì chũ nấu thịt, rau cải', 'Miến măng sườn mọc viên'],
  ['Vịt chiên riềng', 'Thịt nướng xá xíu', 'Cá sốt cà chua thì là', 'Bánh Hamburger kẹp thịt bò\n+ khoai tây chiên', 'Gà chao mắm tỏi'],
  ['Đậu thịt sốt cà chua', 'Cá chỉ chi rim mặn ngọt', 'Nem rán', 'Trứng ốp la', 'Thịt om chuối đậu'],
  ['Cải thảo chần sốt dầu hào', 'Su su + cà rốt xào tỏi', 'Bắp cải luộc', 'Salad Rau xanh với sốt dầu dấm kiểu Pháp', 'Củ quả luộc + muối vừng'],
  ['Canh rau dền nấu thịt băm', 'Canh bầu nấu cua', 'Canh củ quả hầm xương', 'Canh chua', 'Canh rau ngót'],
  ['Cơm trắng', 'Cơm trắng', 'Cơm trắng', 'Cơm trắng', 'Cơm trắng'],
  ['Quýt', 'Dưa hấu', 'Caramen', 'Thanh long', 'Sữa chua Vinamilk'],
];

function sheet(weekId = WEEK) {
  const dates = weekId === WEEK ? DATE_LABELS : Array.from({ length: 5 }, (_, index) => shiftDate(weekId, index));
  return [
    ['THỰC ĐƠN TUẦN'], [],
    ['', '', 'No', 'THỨ 2', 'THỨ 3', 'THỨ 4', 'THỨ 5', 'THỨ 6'],
    ['', '', '', ...dates],
    ...MENU_ROWS.map((row, index) => [index === 0 ? 'ĂN SÁNG' : index === 1 ? 'ĂN TRƯA' : '', index ? row.label : '', index === 0 ? 1 : index, ...DISHES[index]]),
  ];
}

test('Excel đúng hình mẫu: 5 ngày, 7 hàng món, nhóm ăn trưa gộp ô và dấu Unicode', () => {
  const menu = parseWeeklyMenuRows(sheet(), WEEK);
  assert.equal(menu.weekId, WEEK);
  assert.equal(menu.version, 1);
  assert.equal(menu.note, '');
  for (let dayIndex = 0; dayIndex < 5; dayIndex++) {
    assert.equal(menu.days[dayIndex].date, shiftDate(WEEK, dayIndex));
    for (let rowIndex = 0; rowIndex < MENU_ROWS.length; rowIndex++) {
      assert.equal(menu.days[dayIndex][MENU_ROWS[rowIndex].key], DISHES[rowIndex][dayIndex]);
    }
  }
  assert.equal(hasMenuContent(menu), true);
});

test('bản nháp độc lập; normalize bỏ metadata, làm sạch khoảng trắng và kiểm kiểu dữ liệu', () => {
  const draft = createEmptyMenu(WEEK);
  assert.equal(hasMenuContent(draft), false);
  draft.days[0].breakfast = '  Phở\u0000  bò\r\n\r\n\r\nBún  ';
  const clean = normalizeWeeklyMenu({ ...draft, note: '  Đổi món\r\n theo thực tế ', updatedBy: 'admin' }, WEEK);
  assert.equal(clean.days[0].breakfast, 'Phở bò\n\nBún');
  assert.equal(clean.note, 'Đổi món\n theo thực tế');
  assert.equal('updatedBy' in clean, false);
  clean.days[0].breakfast = 'Đổi';
  assert.equal(draft.days[0].breakfast.startsWith('  Phở'), true);
  assert.equal(draft.days[1].breakfast, '');
  assert.equal(hasMenuContent(null), false);
  assert.throws(() => normalizeWeeklyMenu({ ...draft, note: 1 }), /Ghi chú phải là văn bản/);
  const numeric = createEmptyMenu(WEEK);
  numeric.days[0].rice = 0;
  assert.throws(() => normalizeWeeklyMenu(numeric), /CƠM.*văn bản/);
});

test('normalize bắt sai tuần, phiên bản, ngày, thiếu trường và giới hạn độ dài', () => {
  for (const weekId of ['2026-10-06', '2026-02-30', '2026-2-2', 'invalid']) {
    assert.throws(() => createEmptyMenu(weekId), /thứ 2 hợp lệ/);
  }
  assert.throws(() => normalizeWeeklyMenu(null), /Dữ liệu thực đơn/);
  assert.throws(() => normalizeWeeklyMenu(createEmptyMenu(WEEK), '2026-10-12'), /khác tuần đã chọn/);
  assert.throws(() => normalizeWeeklyMenu({ ...createEmptyMenu(WEEK), version: 2 }), /Phiên bản/);
  assert.throws(() => normalizeWeeklyMenu({ ...createEmptyMenu(WEEK), days: [] }), /đúng 5 ngày/);
  const shuffled = createEmptyMenu(WEEK);
  [shuffled.days[0], shuffled.days[1]] = [shuffled.days[1], shuffled.days[0]];
  assert.throws(() => normalizeWeeklyMenu(shuffled), /Ngày thứ 2/);
  const missing = createEmptyMenu(WEEK);
  delete missing.days[0].side;
  assert.throws(() => normalizeWeeklyMenu(missing), /MÓN PHỤ.*văn bản/);
  const oversized = createEmptyMenu(WEEK);
  oversized.days[0].main = 'x'.repeat(301);
  assert.throws(() => normalizeWeeklyMenu(oversized), /300 ký tự/);
  oversized.days[0].main = 'x'.repeat(300);
  oversized.note = 'x'.repeat(1000);
  assert.equal(normalizeWeeklyMenu(oversized).note.length, 1000);
  oversized.note += 'x';
  assert.throws(() => normalizeWeeklyMenu(oversized), /1000 ký tự/);
});

test('ngày Excel serial, Date, ISO và ngày trong tiêu đề; không phụ thuộc tháng/năm', () => {
  const serials = sheet();
  serials[3] = ['', '', '', ...Array.from({ length: 5 }, (_, index) => (Date.parse(`${shiftDate(WEEK, index)}T00:00:00Z`) - Date.parse('1899-12-30T00:00:00Z')) / 86400000)];
  assert.equal(parseWeeklyMenuRows(serials).weekId, WEEK);
  const dates = sheet();
  dates[3] = ['', '', '', ...DATE_LABELS.map((_, index) => new Date(`${shiftDate(WEEK, index)}T00:00:00Z`))];
  assert.equal(parseWeeklyMenuRows(dates).days[4].date, '2026-10-09');
  const inline = sheet();
  inline[2] = ['', '', 'No', ...DATE_LABELS.map((date, index) => `THỨ${index + 2}\n${date}`)];
  inline.splice(3, 1);
  assert.equal(parseWeeklyMenuRows(inline).weekId, WEEK);
  for (const weekId of ['2024-02-26', '2026-09-28', '2026-12-28']) {
    const menu = parseWeeklyMenuRows(sheet(weekId), weekId);
    assert.equal(menu.days[4].date, shiftDate(weekId, 4));
  }
  const leap = sheet('2024-02-26');
  assert.equal(parseWeeklyMenuRows(leap).days[3].date, '2024-02-29');
  const missingHeading = sheet();
  missingHeading.splice(2, 1);
  assert.equal(parseWeeklyMenuRows(missingHeading).weekId, WEEK);
});

test('Excel1904 chỉ đổi serial ở ô ngày, giữ món dạng số và chặn serial ngoài giới hạn', () => {
  const serials = sheet();
  const epoch = Date.parse('1904-01-01T00:00:00Z');
  serials[3] = ['', '', '', ...Array.from({ length: 5 }, (_, index) => (Date.parse(`${shiftDate(WEEK, index)}T00:00:00Z`) - epoch) / 86400000)];
  serials[4][3] = 1234;
  serials[9][3] = 0;
  const menu = parseWeeklyMenuRows(serials, WEEK, { date1904: true });
  assert.equal(menu.weekId, WEEK);
  assert.equal(menu.days[4].date, '2026-10-09');
  assert.equal(menu.days[0].breakfast, '1234');
  assert.equal(menu.days[0].rice, '0');
  assert.throws(() => parseWeeklyMenuRows(serials, WEEK), /khác tuần|thứ 2/);

  const firstWeek = sheet('1904-01-04');
  firstWeek[3] = ['', '', '', 3, 4, 5, 6, 7];
  assert.equal(parseWeeklyMenuRows(firstWeek, '1904-01-04', { date1904: true }).weekId, '1904-01-04');
  const zero = sheet();
  zero[3] = ['', '', '', 0, 1, 2, 3, 4];
  assert.throws(() => parseWeeklyMenuRows(zero, undefined, { date1904: true }), /đầu tiên.*thứ 2/, 'serial0 đọc được ngày1904-01-01 (thứ6)');
  for (const value of [-1, NaN, Infinity, 2957004]) {
    const invalid = sheet();
    invalid[3][3] = value;
    assert.throws(() => parseWeeklyMenuRows(invalid, undefined, { date1904: true }), /Không đọc được/);
  }
  const end = sheet('9999-12-27');
  end[3] = ['', '', '', 2956999, 2957000, 2957001, 2957002, 2957003];
  assert.equal(parseWeeklyMenuRows(end, '9999-12-27', { date1904: true }).days[4].date, '9999-12-31');
});

test('hàng món không dấu/lowercase, No, số 0, ô trống ngày nghỉ và ghi chú', () => {
  const rows = sheet();
  rows[4][0] = ' bua sang ';
  rows[5][1] = ' món chính ';
  rows[6][1] = 'MON PHU';
  rows[9][3] = 0;
  rows[4][5] = null;
  rows[5][5] = undefined;
  rows.push(['GHI CHÚ', '', '', 'Thứ 4 nghỉ lễ\nThực đơn có thể thay đổi.']);
  const menu = parseWeeklyMenuRows(rows);
  assert.equal(menu.days[0].rice, '0');
  assert.equal(menu.days[2].breakfast, '');
  assert.equal(menu.days[2].main, '');
  assert.equal(menu.note, 'Thứ 4 nghỉ lễ\nThực đơn có thể thay đổi.');
});

test('import sai tuần và ngày không hợp lệ/thiếu/trùng/thứ tự đều bị chặn', () => {
  assert.throws(() => parseWeeklyMenuRows(sheet(), '2026-10-12'), /khác tuần đã chọn/);
  for (const replacement of ['32/10/2026', '', '04/10/2026', '06/10/2026', 60, new Date('invalid')]) {
    const rows = sheet();
    rows[3][3] = replacement;
    assert.throws(() => parseWeeklyMenuRows(rows), /ngày|thứ 2/i, String(replacement));
  }
  const duplicate = sheet();
  duplicate[3][4] = duplicate[3][3];
  assert.throws(() => parseWeeklyMenuRows(duplicate), /liên tiếp/);
  const invalidLeap = sheet('2026-02-23');
  invalidLeap[3][6] = '29/02/2026';
  assert.throws(() => parseWeeklyMenuRows(invalidLeap), /Không đọc được/);
  const missingDate = sheet();
  missingDate.splice(3, 1);
  assert.throws(() => parseWeeklyMenuRows(missingDate), /Không tìm thấy hàng ngày/);
  const mixed = sheet();
  mixed[2][3] = 'THỨ 2 05/10/2026';
  assert.throws(() => parseWeeklyMenuRows(mixed), /Không đọc được/);
});

test('import bắt nhãn thiếu/trùng/không xác định và hàng/cột thừa', () => {
  const missing = sheet();
  missing.splice(5, 1);
  assert.throws(() => parseWeeklyMenuRows(missing), /thiếu hàng: MÓN CHÍNH/);
  const duplicate = sheet();
  duplicate.push(duplicate[5]);
  assert.throws(() => parseWeeklyMenuRows(duplicate), /MÓN CHÍNH bị trùng/);
  const unknown = sheet();
  unknown[5][1] = 'Món khác';
  assert.throws(() => parseWeeklyMenuRows(unknown), /không xác định được loại món/);
  const invalidWeekday = sheet();
  invalidWeekday[2][5] = 'THỨ 5';
  assert.throws(() => parseWeeklyMenuRows(invalidWeekday), /Tiêu đề phải/);
  const extraDay = sheet();
  extraDay[2].push('THỨ 7');
  assert.throws(() => parseWeeklyMenuRows(extraDay), /Tiêu đề phải/);
  const extraFood = sheet();
  extraFood[6].push('Món thứ 7');
  assert.throws(() => parseWeeklyMenuRows(extraFood), /ngoài 5 cột ngày/);
  const duplicateTable = sheet();
  duplicateTable.push(...sheet());
  assert.throws(() => parseWeeklyMenuRows(duplicateTable), /nhiều bảng/);
});

test('giới hạn file và ô; import chỉ nhận món có nội dung và loại ô phù hợp', () => {
  for (const empty of [null, [], [[]]]) assert.throws(() => parseWeeklyMenuRows(empty), /không có dữ liệu|Không tìm thấy/);
  assert.throws(() => parseWeeklyMenuRows(Array.from({ length: 501 }, () => [])), /500 hàng/);
  assert.throws(() => parseWeeklyMenuRows([Array(51).fill('')]), /cấu trúc/);
  const empty = sheet();
  for (let index = 4; index < empty.length; index++) empty[index].splice(3, 5, '', '', '', '', '');
  empty.push(['GHI CHÚ', '', '', 'Chỉ có ghi chú']);
  assert.throws(() => parseWeeklyMenuRows(empty), /chưa có món ăn/);
  const huge = sheet();
  huge[4][3] = 'x'.repeat(301);
  assert.throws(() => parseWeeklyMenuRows(huge), /300 ký tự/);
  huge[4][3] = 'x'.repeat(10001);
  assert.throws(() => parseWeeklyMenuRows(huge), /ô quá dài/);
  for (const value of [true, { f: 'SUM(1,2)' }, Infinity, new Date()]) {
    const rows = sheet();
    rows[4][3] = value;
    assert.throws(() => parseWeeklyMenuRows(rows), /không phải văn bản hoặc số/);
  }
});

test('HTML email giữ đủ năm thẻ ngày, bảy nhóm món và ngắt dòng theo mẫu', () => {
  const html = renderWeeklyMenuEmail(parseWeeklyMenuRows(sheet()));
  const cards = html.split('<div class="weekly-menu-day"').slice(1);
  assert.equal(cards.length, 5);
  for (const [index, card] of cards.entries()) {
    assert.match(card, new RegExp(`<h3\\b[^>]*>Thứ ${index + 2}</h3>`));
    assert.ok(card.includes(DATE_LABELS[index]), `đủ ngày ${DATE_LABELS[index]}`);
    assert.match(card, /Bữa sáng/);
    assert.match(card, /Bữa trưa/);
    for (const label of ['Món chính:', 'Món phụ:', 'Món rau:', 'Món canh:', 'Cơm:', 'Tráng miệng:']) {
      assert.ok(card.includes(label), `đủ nhãn ${label} ngày ${DATE_LABELS[index]}`);
    }
    let previousPosition = -1;
    for (const row of DISHES) {
      const dish = row[index].replace(/\n/g, '<br />');
      const position = card.indexOf(dish);
      assert.ok(position > previousPosition, `giữ món và thứ tự ${row[index]} ngày ${DATE_LABELS[index]}`);
      previousPosition = position;
    }
  }
  assert.match(html, /Tuần từ 05\/10\/2026 – 09\/10\/2026/);
  assert.match(html, /display:inline-block;width:100%;max-width:286px/);
  assert.match(html, /<!--\[if mso\]><table role="presentation"/);
  assert.equal((html.match(/<td width="50%" valign="top">/g) || []).length, 6, 'Outlook có ba hàng, mỗi hàng hai ô');
  assert.doesNotMatch(html, /<script\b|<link\b|display:(?:grid|flex)|rowspan=/);
});

test('HTML email escape XSS, giữ ngắt dòng và bẻ link tự động', () => {
  const menu = parseWeeklyMenuRows(sheet());
  menu.days[0].breakfast = '<img src=x onerror="alert(1)"> & \'bò\'\nhttps://example.com';
  menu.note = '<script>alert(1)</script> WWW.example.com';
  const html = renderWeeklyMenuEmail(menu);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;bò&#39;<br \/>https\[:\]\/\/example\.com/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; WWW\[\.\]example\.com/);
  assert.doesNotMatch(html, /<img|<script|<a\b|https:\/\//);
  assert.throws(() => renderWeeklyMenuEmail({ ...menu, version: 2 }), /Phiên bản/);
});

test('HTML email giữ ô trống ở đúng ngày và nhóm món, không lẫn undefined/null', () => {
  const menu = createEmptyMenu(WEEK);
  menu.days[0].breakfast = 'Phở bò';
  const cards = renderWeeklyMenuEmail(menu).split('<div class="weekly-menu-day"').slice(1);
  assert.equal(cards.length, 5);
  for (const [index, card] of cards.entries()) {
    assert.equal((card.match(/>—<\/p>|<\/strong> —<\/p>/g) || []).length, index === 0 ? 6 : 7);
    assert.equal(card.includes('Phở bò'), index === 0);
    assert.doesNotMatch(card, /undefined|null/);
  }
});

test('HTML thực đơn ở giới hạn ký tự vẫn nằm trong ngân sách 90 KiB sau escape', t => {
  const menu = createEmptyMenu(WEEK);
  // Dấu ngoặc kép tăng thành sáu byte &quot;: lớn hơn chữ Việt ba byte.
  for (const day of menu.days) for (const row of MENU_ROWS) day[row.key] = '"'.repeat(300);
  menu.note = '"'.repeat(1000);
  const html = renderWeeklyMenuEmail(menu);
  const bytes = Buffer.byteLength(html, 'utf8');
  assert.ok(bytes < 90 * 1024, `HTML thực đơn ${bytes} byte phải dưới 90 KiB`);
  assert.equal((html.match(/&quot;/g) || []).length, 35 * 300 + 1000);
  t.diagnostic(`HTML thực đơn có dữ liệu tối đa: ${bytes} byte UTF-8.`);
});
