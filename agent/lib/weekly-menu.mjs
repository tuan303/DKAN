/** Thực đơn dùng chung cho web, API và email; không phụ thuộc Node/trình duyệt. */
import { isWeekId, shiftDate, surveyWeekLabel } from './survey.mjs';

/** @typedef {'breakfast' | 'main' | 'side' | 'vegetable' | 'soup' | 'rice' | 'dessert'} MenuKey */
/** @typedef {{ date: string, breakfast: string, main: string, side: string, vegetable: string, soup: string, rice: string, dessert: string }} WeeklyMenuDay */
/** @typedef {{ weekId: string, version: 1, days: WeeklyMenuDay[], note: string }} WeeklyMenu */

/** @type {ReadonlyArray<{ key: MenuKey, label: string }>} */
export const MENU_ROWS = Object.freeze([
  { key: 'breakfast', label: 'ĂN SÁNG' },
  { key: 'main', label: 'MÓN CHÍNH' },
  { key: 'side', label: 'MÓN PHỤ' },
  { key: 'vegetable', label: 'MÓN RAU' },
  { key: 'soup', label: 'MÓN CANH' },
  { key: 'rice', label: 'CƠM' },
  { key: 'dessert', label: 'TRÁNG MIỆNG' },
].map(row => Object.freeze(row)));

const DISH_LIMIT = 300;
const NOTE_LIMIT = 1000;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;

function checkWeek(weekId) {
  if (!isWeekId(weekId)) throw new Error('Tuần thực đơn phải là ngày thứ 2 hợp lệ, định dạng YYYY-MM-DD.');
}

function cleanText(value, limit, label) {
  if (typeof value !== 'string') throw new Error(`${label} phải là văn bản.`);
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > limit) throw new Error(`${label} tối đa ${limit} ký tự.`);
  return text;
}

/** Tạo bản nháp đúng tuần, đủ năm ngày và bảy nhóm món để chỉnh sửa. @returns {WeeklyMenu} */
export function createEmptyMenu(/** @type {string} */ weekId) {
  checkWeek(weekId);
  return {
    weekId, version: 1, note: '',
    days: Array.from({ length: 5 }, (_, index) => /** @type {WeeklyMenuDay} */ ({
      date: shiftDate(weekId, index), ...Object.fromEntries(MENU_ROWS.map(row => [row.key, ''])),
    })),
  };
}

/**
 * Kiểm tra dữ liệu lưu/nhận từ API; trả cấu trúc mới, bỏ metadata ngoài thực đơn.
 * Bản nháp trống hợp lệ; nơi xuất bản/gửi thư dùng hasMenuContent để kiểm tra.
 * @param {unknown} value
 * @param {string} [expectedWeekId]
 * @returns {WeeklyMenu}
 */
export function normalizeWeeklyMenu(value, expectedWeekId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dữ liệu thực đơn không hợp lệ.');
  const raw = /** @type {any} */ (value);
  checkWeek(raw.weekId);
  if (expectedWeekId !== undefined) {
    checkWeek(expectedWeekId);
    if (raw.weekId !== expectedWeekId) throw new Error(`Thực đơn thuộc tuần ${raw.weekId}, khác tuần đã chọn ${expectedWeekId}.`);
  }
  if (raw.version !== 1) throw new Error('Phiên bản thực đơn không được hỗ trợ.');
  if (!Array.isArray(raw.days) || raw.days.length !== 5) throw new Error('Thực đơn phải có đúng 5 ngày từ thứ 2 đến thứ 6.');
  const menu = createEmptyMenu(raw.weekId);
  menu.days = raw.days.map((day, index) => {
    const date = shiftDate(raw.weekId, index);
    if (!day || typeof day !== 'object' || Array.isArray(day) || day.date !== date) {
      throw new Error(`Ngày thứ ${index + 2} phải là ${date}; các ngày phải liên tiếp từ thứ 2 đến thứ 6.`);
    }
    const result = /** @type {WeeklyMenuDay} */ ({ date });
    for (const row of MENU_ROWS) result[row.key] = cleanText(day[row.key], DISH_LIMIT, `${row.label} ngày ${date}`);
    return result;
  });
  menu.note = raw.note === undefined ? '' : cleanText(raw.note, NOTE_LIMIT, 'Ghi chú');
  return menu;
}

/** @param {unknown} menu */
export function hasMenuContent(menu) {
  const days = /** @type {any} */ (menu)?.days;
  return Array.isArray(days) && days.some(day => MENU_ROWS.some(row => typeof day?.[row.key] === 'string' && day[row.key].trim()));
}

function labelToken(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'D')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

const CATEGORY_KEYS = new Map(MENU_ROWS.map(row => [labelToken(row.label), row.key]));
CATEGORY_KEYS.set('BUA SANG', 'breakfast');

function categoryOf(value) {
  return CATEGORY_KEYS.get(labelToken(value).replace(/^\d+ /, ''));
}

function weekdayOf(value) {
  const match = /^(?:THU ?([2-7])|THU (HAI|BA|TU|NAM|SAU|BAY))(?: |$)/.exec(labelToken(value));
  if (!match) return null;
  return match[1] ? Number(match[1]) : ({ HAI: 2, BA: 3, TU: 4, NAM: 5, SAU: 6, BAY: 7 })[match[2]];
}

function validIso(year, month, day) {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Hai hệ ngày Excel; serial 60 của hệ 1900 là ngày giả nên bị từ chối. */
function excelDate(serial, date1904 = false) {
  if (date1904) {
    if (!Number.isFinite(serial) || serial < 0 || serial >= 2957004) return null;
    return shiftDate('1904-01-01', Math.floor(serial));
  }
  if (!Number.isFinite(serial) || serial < 1 || serial >= 2958466 || Math.floor(serial) === 60) return null;
  const base = serial < 60 ? '1899-12-31' : '1899-12-30';
  return shiftDate(base, Math.floor(serial));
}

function dateOf(value, date1904 = false) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === 'number') return excelDate(value, date1904);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const iso = /(?:^|\D)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(text);
  if (iso) return validIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /(?:^|\D)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?!\d)/.exec(text);
  if (dmy) return validIso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  if (/^\d{1,7}(?:\.\d+)?$/.test(text)) return excelDate(Number(text), date1904);
  return null;
}

const nonblank = value => value !== undefined && value !== null && String(value).trim() !== '';
const dateHint = value => value instanceof Date || typeof value === 'number'
  || (typeof value === 'string' && /\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}/.test(value));

function validateDates(dates, expectedWeekId) {
  if (dates.some(date => !date)) throw new Error('Không đọc được đủ 5 ngày thực đơn. Dùng ngày đầy đủ dd/MM/YYYY từ thứ 2 đến thứ 6.');
  if (!isWeekId(dates[0])) throw new Error('Cột ngày đầu tiên của thực đơn phải là thứ 2.');
  if (dates.some((date, index) => date !== shiftDate(dates[0], index))) {
    throw new Error('Các ngày thực đơn phải liên tiếp từ thứ 2 đến thứ 6, không được thiếu hoặc trùng ngày.');
  }
  if (expectedWeekId !== undefined) {
    checkWeek(expectedWeekId);
    if (dates[0] !== expectedWeekId) throw new Error(`File thuộc tuần ${dates[0]}, khác tuần đã chọn ${expectedWeekId}.`);
  }
}

function cellText(value, label) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new Error(`${label} chứa ô không phải văn bản hoặc số.`);
  return value;
}

/**
 * Nhận mảng hàng từ SheetJS sheet_to_json({header:1,raw:true,defval:''}).
 * Nhận mẫu 8 cột: nhóm bữa, loại món, No, rồi thứ 2–6; nhóm bữa có thể gộp ô.
 * Ngày có thể nằm trên hàng riêng hoặc trong ô tiêu đề thứ, dạng dd/MM/YYYY,
 * ISO, Date hay serial Excel. Chỉ ô ngày được áp dụng hệ ngày của workbook;
 * số trong ô món luôn giữ nguyên dưới dạng văn bản.
 * @param {unknown} rows
 * @param {string} [expectedWeekId]
 * @param {{date1904?: boolean}} [options]
 * @returns {WeeklyMenu}
 */
export function parseWeeklyMenuRows(rows, expectedWeekId, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('File Excel không có dữ liệu thực đơn.');
  if (rows.length > MAX_ROWS) throw new Error(`Bảng thực đơn tối đa ${MAX_ROWS} hàng; vui lòng dùng file mẫu.`);
  if (expectedWeekId !== undefined) checkWeek(expectedWeekId);
  const date1904 = options?.date1904 === true;
  const table = rows.map((row, index) => {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw new Error(`Hàng ${index + 1} không đúng cấu trúc bảng thực đơn.`);
    if (row.some(cell => typeof cell === 'string' && cell.length > 10000)) throw new Error(`Hàng ${index + 1} chứa ô quá dài.`);
    return row;
  });
  let headingIndex = -1;
  let startColumn = -1;
  for (let index = 0; index < table.length; index++) {
    const row = table[index];
    const weekdays = row.map(weekdayOf);
    const positions = weekdays.map((day, column) => day === null ? -1 : column).filter(column => column >= 0);
    if (positions.length < 2) continue;
    const start = positions[0];
    if (positions.length !== 5 || positions.some((column, offset) => column !== start + offset || weekdays[column] !== offset + 2)) {
      throw new Error('Tiêu đề phải có đủ 5 cột theo thứ tự THỨ 2, THỨ 3, THỨ 4, THỨ 5, THỨ 6.');
    }
    if (headingIndex !== -1) throw new Error('File chứa nhiều bảng thực đơn. Vui lòng chọn một bảng cho mỗi trang tính.');
    headingIndex = index;
    startColumn = start;
  }

  let dateIndex = -1;
  let dates;
  if (headingIndex !== -1) {
    const heading = table[headingIndex].slice(startColumn, startColumn + 5);
    if (heading.some(dateHint)) {
      dates = heading.map(value => dateOf(value, date1904));
      dateIndex = headingIndex;
    } else {
      for (let index = headingIndex + 1; index < table.length; index++) {
        const row = table[index];
        if (row.slice(0, startColumn).some(categoryOf)) break;
        const cells = Array.from({ length: 5 }, (_, offset) => row[startColumn + offset]);
        if (!cells.some(nonblank)) continue;
        dates = cells.map(value => dateOf(value, date1904));
        dateIndex = index;
        break;
      }
    }
  } else {
    // Cũng nhận bảng bỏ hàng tên thứ nhưng giữ hàng ngày đầy đủ.
    for (let index = 0; index < table.length && dateIndex === -1; index++) {
      const row = table[index];
      if (row.slice(0, 3).some(categoryOf)) break;
      for (let column = 1; column <= row.length - 5; column++) {
        const candidate = row.slice(column, column + 5).map(value => dateOf(value, date1904));
        if (candidate.every(Boolean)) {
          dates = candidate;
          dateIndex = index;
          startColumn = column;
          break;
        }
      }
    }
  }
  if (!dates || dateIndex === -1) throw new Error('Không tìm thấy hàng ngày của thực đơn. Vui lòng dùng file mẫu với đủ ngày dd/MM/YYYY.');
  validateDates(dates, expectedWeekId);
  if (table[dateIndex].slice(startColumn + 5).some(nonblank)
      || (headingIndex !== -1 && table[headingIndex].slice(startColumn + 5).some(nonblank))) {
    throw new Error('Thực đơn chỉ hỗ trợ 5 cột ngày từ thứ 2 đến thứ 6.');
  }
  const menu = createEmptyMenu(dates[0]);
  const seen = new Set();
  let noteSeen = false;
  for (let index = dateIndex + 1; index < table.length; index++) {
    const row = table[index];
    const labels = row.slice(0, startColumn);
    const keys = [...new Set(labels.map(categoryOf).filter(Boolean))];
    const noteColumn = labels.findIndex(cell => ['GHI CHU', 'LUU Y'].includes(labelToken(cell)));
    if (noteColumn >= 0) {
      if (noteSeen) throw new Error('File có nhiều hàng GHI CHÚ; vui lòng gộp thành một hàng.');
      noteSeen = true;
      menu.note = cleanText(row.slice(noteColumn + 1).filter(nonblank).map(cell => cellText(cell, 'Ghi chú')).join('\n'), NOTE_LIMIT, 'Ghi chú');
      continue;
    }
    if (!keys.length) {
      if (row.slice(startColumn).some(nonblank)) throw new Error(`Hàng ${index + 1} có món ăn nhưng không xác định được loại món. Vui lòng dùng đúng nhãn trong file mẫu.`);
      continue;
    }
    if (keys.length > 1) throw new Error(`Hàng ${index + 1} chứa nhiều loại món; mỗi loại món cần một hàng riêng.`);
    const key = keys[0];
    const label = MENU_ROWS.find(item => item.key === key).label;
    if (seen.has(key)) throw new Error(`Loại món ${label} bị trùng hàng.`);
    if (row.slice(startColumn + 5).some(nonblank)) throw new Error(`Hàng ${index + 1} có dữ liệu ngoài 5 cột ngày.`);
    seen.add(key);
    menu.days.forEach((day, offset) => {
      day[key] = cleanText(cellText(row[startColumn + offset], `${label} ngày ${day.date}`), DISH_LIMIT, `${label} ngày ${day.date}`);
    });
  }
  const missing = MENU_ROWS.filter(row => !seen.has(row.key));
  if (missing.length) throw new Error(`File thiếu hàng: ${missing.map(row => row.label).join(', ')}.`);
  if (!hasMenuContent(menu)) throw new Error('Thực đơn chưa có món ăn. Vui lòng nhập ít nhất một món trước khi import.');
  return normalizeWeeklyMenu(menu, expectedWeekId);
}

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Đồng bộ chính sách txt của API: ô món/ghi chú không tạo link tự động trong Outlook.
const displayText = text => escapeHtml(text).replace(/:\/\//g, '[:]//').replace(/\b(www)\./gi, '$1[.]').replace(/\n/g, '<br />');
const dateLabel = date => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** Thẻ ngày theo mẫu HTML của Nhóm Dinh dưỡng; chỉ nhận văn bản và luôn escape. @param {unknown} value */
export function renderWeeklyMenuEmail(value) {
  const menu = normalizeWeeklyMenu(value);
  const font = 'font-family:Arial,Helvetica,sans-serif;';
  const copy = `${font}font-size:14px;line-height:22px;color:#334155;word-wrap:break-word;overflow-wrap:anywhere;`;
  const cards = menu.days.map((day, index) => {
    const dishes = MENU_ROWS.slice(1).map(row => {
      const label = row.label.charAt(0) + row.label.slice(1).toLocaleLowerCase('vi');
      return `<p style="margin:0 0 10px;${copy}"><strong style="color:#0f172a;">${label}:</strong> ${displayText(day[row.key]) || '—'}</p>`;
    }).join('');
    // Modern clients wrap the fluid columns naturally. Outlook desktop uses
    // these conditional table cells instead, retaining a two-column layout.
    const before = index === 0 ? '<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr><td width="50%" valign="top"><![endif]-->'
      : index % 2 === 0 ? '<!--[if mso]></td></tr><tr><td width="50%" valign="top"><![endif]-->'
        : '<!--[if mso]></td><td width="50%" valign="top"><![endif]-->';
    return before + `<div class="weekly-menu-day" style="display:inline-block;width:100%;max-width:286px;vertical-align:top;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;"><tr><td style="padding:0 6px 14px;vertical-align:top;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #e2e8f0;border-radius:16px;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:#ffffff;">
<tr><td bgcolor="#6366f1" align="center" style="padding:16px 12px;background-color:#6366f1;border-radius:14px 14px 0 0;">
<h3 style="margin:0;${font}font-size:20px;line-height:26px;font-weight:bold;color:#ffffff;">Thứ ${index + 2}</h3>
<p style="margin:4px 0 0;${font}font-size:13px;line-height:20px;color:#e0e7ff;">${dateLabel(day.date)}</p></td></tr>
<tr><td style="padding:18px 16px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">
<tr><td style="padding:0 0 14px;border-bottom:1px solid #e2e8f0;">
<p style="margin:0 0 6px;${font}font-size:14px;line-height:22px;font-weight:bold;color:#b45309;">&#9728; &nbsp;Bữa sáng</p>
<p style="margin:0;${copy}">${displayText(day.breakfast) || '—'}</p></td></tr>
<tr><td style="padding:14px 0 0;">
<p style="margin:0 0 10px;${font}font-size:14px;line-height:22px;font-weight:bold;color:#047857;">&#127860; &nbsp;Bữa trưa</p>
${dishes}</td></tr></table></td></tr></table></td></tr></table></div>`;
  }).join('');
  const end = '<!--[if mso]></td><td width="50%" valign="top"></td></tr></table><![endif]-->';
  return `<h2 style="margin:20px 6px 6px;text-align:center;${font}font-size:23px;line-height:30px;color:#4f46e5;">Thực đơn hàng tuần</h2>`
    + `<p style="margin:0 6px 12px;text-align:center;${font}font-size:14px;line-height:22px;color:#64748b;">Tuần từ ${dateLabel(menu.days[0].date)} – ${dateLabel(menu.days[4].date)}</p>`
    + `<p style="margin:0 6px 16px;${font}font-size:13px;line-height:21px;color:#64748b;">Dưới đây là thực đơn tuần ${surveyWeekLabel(menu.weekId)} để CBGV-NV tham khảo và đóng góp ý kiến.</p>`
    + `<div style="font-size:0;line-height:0;text-align:left;">${cards}${end}</div>`
    + (menu.note ? `<p style="margin:2px 6px 10px;padding:12px;background-color:#f8fafc;border-left:3px solid #6366f1;${copy}"><strong>Ghi chú:</strong> ${displayText(menu.note)}</p>` : '');
}
