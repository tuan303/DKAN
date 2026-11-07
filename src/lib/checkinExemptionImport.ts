// Phần quyết định của trang quản trị "Miễn chấm ăn theo bữa" — thuần, không gọi
// Firebase để test được ngoài trình duyệt. Component MealCheckinExemptions lo
// đọc/ghi Firestore; ở đây là: đọc tệp Excel/CSV, tính thời hạn sau khi lưu
// (gộp hay thay), ngừng miễn đúng giờ bữa ăn, tách bản ghi lỗi và gợi ý khớp đơn
// đăng ký. Quy tắc kiểm tra một bản ghi dùng chung với agent, đối soát và Mini
// App (agent/lib/checkin-exemptions.mjs) để mọi nơi cùng một kết luận.
import type { WorkBook, WorkSheet } from 'xlsx';
import { addDays, isIsoDate } from '../../agent/lib/common.mjs';
import { formatDate, MEAL_WINDOWS } from '../../agent/lib/meal-rules.mjs';
import {
  CheckinExemptionError, exemptionCovers, exemptionQuarantine, MAX_EXEMPTION_NAME, normalizeCheckinExemption,
  normalizeExemptionEmployeeId, parseCheckinExemptionDocs, validateStoredCheckinExemption,
} from '../../agent/lib/checkin-exemptions.mjs';

export type ExemptionMeal = 'breakfast' | 'lunch';
export interface ExemptionPeriod { from: string; to: string | null; meals: ExemptionMeal[]; }
export interface ExemptionRecord {
  employeeId: string;
  email: string;
  fullName: string;
  periods: ExemptionPeriod[];
}
/** Gộp thêm thời hạn (mặc định) hoặc thay thời hạn kể từ ngày bắt đầu. */
export type ExemptionSaveMode = 'merge' | 'replace';
export interface ExemptionHeaderLabels { employeeId: string; email: string; fullName: string; }
/** Dòng không đưa vào danh sách: dòng ký tên/ghi chú (không mã, không email) hoặc dòng ví dụ của tệp mẫu. */
export interface ExemptionIgnoredRow { row: number; reason: 'blank' | 'example'; }
export interface ExemptionPreview {
  records: ExemptionRecord[];
  /** "Dòng N: lý do" — dòng có mã hoặc email nhưng không hợp lệ. */
  errors: string[];
  ignored: ExemptionIgnoredRow[];
  /** Tiêu đề cột đúng như trong tệp, để người nhập kiểm tra cột đã nhận đúng chưa. */
  headers: ExemptionHeaderLabels | null;
  /** Số dòng trên sheet của từng mã nhân viên hợp lệ. */
  rowNumbers: Record<string, number>;
  sheetName?: string;
  /** Sheet được đọc đang bị ẩn trong Excel (chỉ dùng khi không sheet đang hiện nào dùng được). */
  sheetHidden?: boolean;
  skippedSheets?: { name: string; reason: string; hidden: boolean }[];
}
/** Ngày và giờ Việt Nam (YYYY-MM-DD, HH:MM) tại lúc thao tác. */
export interface ExemptionClock { today: string; now: string; }

export const EXEMPTION_MEALS: readonly ExemptionMeal[] = ['breakfast', 'lunch'];
export const MAX_EXEMPTION_IMPORT = 500;
export const MAX_EXEMPTION_FILE_SIZE = 5 * 1024 * 1024;
/** Firestore nhận tối đa 500 thao tác ghi trong một transaction. */
export const MAX_TRANSACTION_WRITES = 500;
export const EXEMPTION_MEAL_NAME: Record<ExemptionMeal, string> = { breakfast: 'bữa sáng', lunch: 'bữa trưa' };
const STAFF_CODE = /^\d{6}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

type XlsxModule = Pick<typeof import('xlsx'), 'read' | 'write' | 'utils'>;

/** Lỗi ở mức cả sheet/tệp (thiếu cột, quá số dòng, không đọc được) — thử sheet khác thay vì dừng. */
export class ExemptionImportError extends Error {
  kind: 'file' | 'headers' | 'size' | 'empty';
  constructor(kind: 'file' | 'headers' | 'size' | 'empty', message: string) {
    super(message);
    this.name = 'ExemptionImportError';
    this.kind = kind;
  }
}

export const exemptionErrorMessage = (error: unknown, fallback = 'Dữ liệu miễn chấm ăn không hợp lệ.') =>
  error instanceof Error && error.message ? error.message : fallback;
const fieldOf = (error: unknown) => error instanceof CheckinExemptionError ? error.field : null;

export const formatMonthLabel = (month: string) =>
  /^\d{4}-\d{2}$/.test(month) ? `${month.slice(5, 7)}/${month.slice(0, 4)}` : month;

export const mealsLabel = (meals: readonly ExemptionMeal[]) => meals.map(meal => EXEMPTION_MEAL_NAME[meal]).join(' và ');

/** "Bữa trưa · Từ 06/11/2026 · Chưa có ngày kết thúc" */
export function describeExemptionPeriod(period: ExemptionPeriod): string {
  const meals = mealsLabel(period.meals);
  return `${meals.charAt(0).toUpperCase()}${meals.slice(1)} · Từ ${formatDate(period.from)}`
    + (period.to ? ` đến hết ${formatDate(period.to)}` : ' · Chưa có ngày kết thúc');
}

export function normalizeExemptionRecord(value: unknown, expectedId?: string): ExemptionRecord {
  const record = normalizeCheckinExemption(value) as ExemptionRecord;
  if (expectedId && record.employeeId !== expectedId) {
    throw new CheckinExemptionError(`Mã nhân viên ${record.employeeId} không khớp bản ghi ${expectedId}.`, { field: 'employeeId' });
  }
  return record;
}

// Ô chọn ngày cho gõ tay năm: gõ dở "26" là thành năm 0026. Ngày ngoài khoảng
// này gần như chắc chắn là gõ nhầm.
const sensibleYear = (date: string) => date.slice(0, 4) >= '2020' && date.slice(0, 4) <= '2099';

export function validateExemptionPeriod(from: string, to: string | null) {
  if (!isIsoDate(from)) throw new CheckinExemptionError('Chọn ngày bắt đầu hợp lệ.', { field: 'periods' });
  if (!sensibleYear(from)) {
    throw new CheckinExemptionError(`Kiểm tra lại năm của ngày bắt đầu (đang là ${from.slice(0, 4)}).`, { field: 'periods' });
  }
  if (to !== null && (!isIsoDate(to) || to < from)) {
    throw new CheckinExemptionError('Chọn ngày kết thúc hợp lệ, từ ngày bắt đầu trở đi (hoặc để trống).', { field: 'periods' });
  }
  if (to !== null && !sensibleYear(to)) {
    throw new CheckinExemptionError(`Kiểm tra lại năm của ngày kết thúc (đang là ${to.slice(0, 4)}).`, { field: 'periods' });
  }
  return { from, to };
}

// Excel hay hiển thị mã dạng số có dấu phân cách hàng nghìn ("101,190" bản
// tiếng Anh, "101.190" bản tiếng Việt) hoặc phần thập phân 0 ("101190.00").
// Chỉ bỏ dấu phân cách, không bao giờ tự thêm số 0 đầu đã mất: đoán sai là gán
// miễn chấm cho người khác.
const GROUPED_NUMBER = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]0+)?$/;
export function cleanEmployeeIdCell(value: unknown): string {
  const text = String(value ?? '').replace(/\s/g, '');
  const match = text.match(GROUPED_NUMBER);
  return match ? match[1].replace(/[.,]/g, '') : text;
}

export function exemptionDraft(employeeId: unknown, email: unknown, fullName: unknown, from: string,
  to: string | null, meals: ExemptionMeal[] = ['lunch']): ExemptionRecord {
  const rawName = String(fullName ?? '');
  if (/[\u0000-\u001f\u007f]/.test(rawName)) {
    throw new CheckinExemptionError(`Họ tên phải là một dòng, tối đa ${MAX_EXEMPTION_NAME} ký tự.`, { field: 'fullName' });
  }
  // Dạng dựng sẵn (NFC): CSV Windows-1258 hay tên gõ trên máy Mac ghi dấu tách rời
  // ("e" + dấu ngã) — trông giống hệt nhưng không khớp tìm kiếm và bản ghi đã lưu.
  const name = rawName.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name) throw new CheckinExemptionError('Họ tên không được để trống.', { field: 'fullName' });
  return normalizeExemptionRecord({ employeeId: cleanEmployeeIdCell(employeeId), email: String(email ?? ''),
    fullName: name, periods: [{ ...validateExemptionPeriod(from, to), meals }] });
}

// ----------------------------------------------------------- đọc tệp nhập

const headerText = (value: unknown) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
// Thứ tự trong mỗi danh sách là độ ưu tiên: tên cột cụ thể ("Mã NV") thắng tên
// chung ("ID", "Mã số") khi tệp có cả hai cột.
const HEADER_ALIASES: Record<keyof ExemptionHeaderLabels, readonly string[]> = {
  employeeId: ['manhanvien', 'masonhanvien', 'manv', 'msnv', 'macbgvnv', 'macbnv', 'manhansu', 'macanbo',
    'employeeid', 'staffid', 'maso', 'id'],
  email: ['email', 'emailtruong', 'emailnhatruong', 'diachiemail', 'thudientu', 'mail'],
  fullName: ['hovaten', 'hoten', 'hotennhanvien', 'hovatennhanvien', 'tennhanvien', 'fullname'],
};
const HEADER_FIELDS = ['employeeId', 'email', 'fullName'] as const;
const HEADER_FIELD_LABEL: Record<keyof ExemptionHeaderLabels, string> = {
  employeeId: 'Mã nhân viên', email: 'Email', fullName: 'Họ tên',
};
const HEADER_SCAN_ROWS = 15;

/** Hàng tiêu đề trong 15 dòng đầu; không có thì báo các cột còn thiếu ở hàng gần đủ nhất. */
function findHeader(rows: readonly unknown[][]) {
  let missing: (keyof ExemptionHeaderLabels)[] | null = null;
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_ROWS); index++) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    const normalized = row.map(headerText);
    const columns = { employeeId: -1, email: -1, fullName: -1 };
    for (const field of HEADER_FIELDS) {
      for (const alias of HEADER_ALIASES[field]) {
        const column = normalized.findIndex((value, at) => value === alias && !Object.values(columns).includes(at));
        if (column >= 0) { columns[field] = column; break; }
      }
    }
    const absent = HEADER_FIELDS.filter(field => columns[field] < 0);
    if (!absent.length) {
      const label = (column: number) => String(row[column] ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      return { header: { index, columns,
        labels: { employeeId: label(columns.employeeId), email: label(columns.email), fullName: label(columns.fullName) } } };
    }
    if (absent.length < HEADER_FIELDS.length && (!missing || absent.length < missing.length)) missing = absent;
  }
  return { header: null, missing };
}

/** Dòng ví dụ trong tệp mẫu dùng mã 000000 — không phải mã thật nên luôn bỏ qua. */
export const EXEMPTION_TEMPLATE_EXAMPLE_ID = '000000';
export const EXEMPTION_TEMPLATE_HEADERS = ['Mã nhân viên', 'Email', 'Họ tên'] as const;
const TEMPLATE_EXAMPLE = [EXEMPTION_TEMPLATE_EXAMPLE_ID, 'vi.du@hoangmaistarschool.edu.vn',
  'Nguyễn Văn Mẫu (dòng ví dụ, xóa trước khi nhập)'];

const rowList = (rows: readonly number[]) =>
  rows.length > 8 ? `${rows.slice(0, 8).join(', ')}…` : rows.join(', ');

/** " Bỏ qua dòng 45, 46 (không có mã nhân viên và email) và dòng 2 (dòng ví dụ của tệp mẫu)." */
export function describeIgnoredRows(ignored: readonly ExemptionIgnoredRow[]): string {
  const blank = ignored.filter(item => item.reason === 'blank').map(item => item.row);
  const example = ignored.filter(item => item.reason === 'example').map(item => item.row);
  const parts = [
    blank.length ? `${blank.length} dòng không có mã nhân viên và email (dòng ${rowList(blank)})` : '',
    example.length ? `dòng ví dụ của tệp mẫu (dòng ${rowList(example)})` : '',
  ].filter(Boolean);
  return parts.length ? ` Đã bỏ qua ${parts.join(' và ')}.` : '';
}

/**
 * Đọc các dòng của một sheet. `rowNumbers[i]` là số dòng thật trên sheet của
 * rows[i] (khi đã bỏ dòng trống); thiếu thì lấy theo vị trí.
 * Lỗi cả sheet (thiếu cột, quá số dòng, không có ai) ném ExemptionImportError;
 * lỗi từng dòng nằm trong `errors`.
 */
export function parseExemptionRows(rows: unknown[][], from: string, to: string | null,
  meals: ExemptionMeal[] = ['lunch'], options: { rowNumbers?: readonly number[] } = {}): ExemptionPreview {
  validateExemptionPeriod(from, to);
  const { header, missing } = findHeader(rows);
  if (!header) {
    throw new ExemptionImportError('headers', `Không thấy hàng tiêu đề có đủ ba cột Mã nhân viên, Email và Họ tên trong ${HEADER_SCAN_ROWS} dòng đầu`
      + (missing ? ` (thiếu cột ${missing.map(field => HEADER_FIELD_LABEL[field]).join(', ')}).` : '.')
      + ' Tải tệp mẫu để xem đúng tên cột.');
  }
  const { columns } = header;
  const numberOf = (index: number) => options.rowNumbers?.[index] ?? index + 1;
  const ignored: ExemptionIgnoredRow[] = [];
  const candidates: { row: unknown[]; number: number; employeeId: string }[] = [];
  for (let index = header.index + 1; index < rows.length; index++) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    if (!row.some(value => String(value ?? '').trim() !== '')) continue;
    const employeeId = cleanEmployeeIdCell(row[columns.employeeId]);
    const email = String(row[columns.email] ?? '').trim();
    // Dòng ký tên, ghi chú, tổng cộng... cuối bảng: không mã, không email.
    if (!employeeId && !email) { ignored.push({ row: numberOf(index), reason: 'blank' }); continue; }
    if (employeeId === EXEMPTION_TEMPLATE_EXAMPLE_ID) { ignored.push({ row: numberOf(index), reason: 'example' }); continue; }
    candidates.push({ row, number: numberOf(index), employeeId });
  }
  if (candidates.length > MAX_EXEMPTION_IMPORT) {
    throw new ExemptionImportError('size', `Mỗi lần nhập tối đa ${MAX_EXEMPTION_IMPORT} nhân viên, sheet này có `
      + `${candidates.length} dòng có mã hoặc email. Tách thành nhiều tệp rồi nhập lần lượt.`);
  }
  if (!candidates.length) {
    throw new ExemptionImportError('empty', `Chưa có nhân viên nào dưới hàng tiêu đề.${describeIgnoredRows(ignored)}`);
  }

  const records: ExemptionRecord[] = [];
  const errors: string[] = [];
  const rowNumbers: Record<string, number> = {};
  const emailRows = new Map<string, number>();
  for (const { row, number, employeeId } of candidates) {
    try {
      const record = exemptionDraft(employeeId, row[columns.email], row[columns.fullName], from, to, meals);
      if (rowNumbers[record.employeeId] !== undefined) {
        throw new CheckinExemptionError(`Mã nhân viên ${record.employeeId} bị lặp trong tệp (đã có ở dòng ${rowNumbers[record.employeeId]}).`, { field: 'employeeId' });
      }
      const emailRow = emailRows.get(record.email);
      if (emailRow !== undefined) {
        throw new CheckinExemptionError(`Email bị lặp trong tệp (đã có ở dòng ${emailRow}).`, { field: 'email' });
      }
      rowNumbers[record.employeeId] = number;
      emailRows.set(record.email, number);
      records.push(record);
    } catch (error) {
      let message = exemptionErrorMessage(error);
      if (fieldOf(error) === 'employeeId' && /^\d{1,5}$/.test(employeeId)) {
        message += ' Nếu mã bắt đầu bằng số 0, định dạng cột Mã nhân viên là Văn bản (Text) rồi nhập lại.';
      }
      errors.push(`Dòng ${number}: ${message}`);
    }
  }
  return { records, errors, ignored, headers: header.labels, rowNumbers };
}

const CELL_ADDRESS = /^[A-Z]{1,3}\d+$/;
const VALUE_TYPES = new Set(['s', 'n', 'b', 'd']);
/** Số cột đọc tối đa của một sheet, tính từ cột đầu tiên có dữ liệu. */
export const MAX_IMPORT_COLUMNS = 50;

/** Ô có giá trị theo đúng quy tắc dòng trống của sheet_to_json: kiểu s/n/b/d mang giá trị. */
const holdsValue = (cell: unknown) => {
  if (!cell || typeof cell !== 'object') return false;
  const { t, v } = cell as { t?: unknown; v?: unknown };
  return v !== undefined && v !== null && VALUE_TYPES.has(String(t));
};

/**
 * Các dòng có dữ liệu của một sheet (giá trị dạng chữ như Excel hiển thị) kèm số
 * dòng thật trên sheet, để báo lỗi "Dòng N" khớp với Excel.
 *
 * Không đi theo vùng `!ref`: tệp xuất từ phần mềm khác hay khai
 * <dimension ref="A1:Z1048576"> dù chỉ có vài dòng — đi hết vùng đó là treo
 * trang. Vùng đọc tính từ các ô thật sự có giá trị (tối đa 50 cột tính từ cột đầu
 * tiên có dữ liệu), và chỉ đọc từng đoạn dòng có dữ liệu: không bao giờ đi qua
 * vùng trống, kể cả khi có một ô lạc ở tận cuối sheet.
 */
export function readSheetRows(xlsx: XlsxModule, sheet: WorkSheet): { rows: unknown[][]; rowNumbers: number[] } {
  // sheet_to_json không đọc sheet thiếu `!ref` (sheet trống khi SheetJS đọc tệp).
  if (typeof sheet['!ref'] !== 'string') return { rows: [], rowNumbers: [] };
  const cells: { r: number; c: number }[] = [];
  let firstColumn = Infinity;
  for (const key of Object.keys(sheet)) {
    if (!CELL_ADDRESS.test(key) || !holdsValue(sheet[key])) continue;
    const cell = xlsx.utils.decode_cell(key);
    cells.push(cell);
    if (cell.c < firstColumn) firstColumn = cell.c;
  }
  const lastAllowed = firstColumn + MAX_IMPORT_COLUMNS - 1;
  let lastColumn = firstColumn;
  const used = new Set<number>();
  for (const { r, c } of cells) {
    if (c > lastAllowed) continue;
    used.add(r);
    if (c > lastColumn) lastColumn = c;
  }
  const lines = [...used].sort((a, b) => a - b);
  const rows: unknown[][] = [];
  for (let start = 0; start < lines.length;) {
    let end = start;
    while (end + 1 < lines.length && lines[end + 1] === lines[end] + 1) end++;
    // Mỗi dòng trong đoạn đều có dữ liệu; blankrows: true để số dòng trả về luôn khớp `lines`.
    const block = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: true,
      range: { s: { r: lines[start], c: firstColumn }, e: { r: lines[end], c: lastColumn } } });
    for (const row of block) rows.push(row);
    start = end + 1;
  }
  return { rows, rowNumbers: lines.map(line => line + 1) };
}

/**
 * Lấy sheet đầu tiên có đủ ba cột. Sheet thiếu cột, quá số dòng hoặc không có
 * ai thì bỏ qua và thử sheet sau; lý do được giữ trong `skippedSheets`. Sheet
 * đang hiện được thử trước, sheet ẩn sau cùng: sheet ẩn thường là dữ liệu tra cứu
 * (vd. cả danh sách nhân sự) dù cũng có đủ ba cột.
 */
export function parseExemptionWorkbook(xlsx: XlsxModule, workbook: WorkBook, from: string, to: string | null,
  meals: ExemptionMeal[] = ['lunch']): ExemptionPreview {
  validateExemptionPeriod(from, to);
  const sheets = workbook.SheetNames.map((name, index) => ({ name, hidden: !!workbook.Workbook?.Sheets?.[index]?.Hidden }));
  const skipped: { name: string; hidden: boolean; error: ExemptionImportError }[] = [];
  const skippedSheets = () => skipped.map(({ name, hidden, error }) => ({ name, reason: error.message, hidden }));
  for (const { name, hidden } of [...sheets.filter(item => !item.hidden), ...sheets.filter(item => item.hidden)]) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    let read: { rows: unknown[][]; rowNumbers: number[] };
    try {
      read = readSheetRows(xlsx, sheet);
    } catch {
      skipped.push({ name, hidden, error: new ExemptionImportError('file', 'Không đọc được sheet này.') });
      continue;
    }
    try {
      const preview = parseExemptionRows(read.rows, from, to, meals, { rowNumbers: read.rowNumbers });
      return { ...preview, sheetName: name, sheetHidden: hidden, skippedSheets: skippedSheets() };
    } catch (error) {
      if (!(error instanceof ExemptionImportError)) throw error;
      skipped.push({ name, hidden, error });
    }
  }
  if (!skipped.length) throw new ExemptionImportError('file', 'Tệp không có sheet nào.');
  if (skipped.length === 1) throw skipped[0].error;
  throw new ExemptionImportError('headers', `Không sheet nào dùng được. ${skipped
    .map(({ name, hidden, error }) => `Sheet “${name}”${hidden ? ' (sheet ẩn)' : ''}: ${error.message}`).join(' ')}`);
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1258').decode(bytes);
  }
}

/**
 * CSV từ Excel: "CSV UTF-8" (có BOM) là chuẩn; bản "CSV" thường trên Windows
 * tiếng Việt lưu theo bảng mã Windows-1258; "Unicode Text" là UTF-16.
 * Windows-1258 ghi nhiều chữ có dấu thành chữ gốc + dấu tách rời ("Nguyễn" =
 * "Nguyê" + dấu ngã): chuẩn hoá về dạng dựng sẵn (NFC) như chữ gõ từ bàn phím.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  return decodeText(bytes).normalize('NFC');
}

export function readExemptionWorkbook(xlsx: XlsxModule, bytes: Uint8Array, fileName: string): WorkBook {
  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) throw new ExemptionImportError('file', 'Tệp cần có định dạng .xlsx, .xls hoặc .csv.');
  if (!bytes.byteLength) throw new ExemptionImportError('file', 'Tệp đang trống.');
  if (bytes.byteLength > MAX_EXEMPTION_FILE_SIZE) throw new ExemptionImportError('file', 'Chọn tệp Excel hoặc CSV dưới 5 MB.');
  try {
    return /\.csv$/i.test(fileName)
      ? xlsx.read(decodeCsvBytes(bytes), { type: 'string' })
      : xlsx.read(bytes, { type: 'array' });
  } catch {
    throw new ExemptionImportError('file', 'Không đọc được tệp. Kiểm tra tệp có bị lỗi hoặc đặt mật khẩu không.');
  }
}

/** Tệp mẫu: ba cột và một dòng ví dụ (mã 000000 — được bỏ qua nếu quên xóa). */
export function createExemptionTemplate(xlsx: XlsxModule): Uint8Array {
  const sheet = xlsx.utils.aoa_to_sheet([[...EXEMPTION_TEMPLATE_HEADERS], TEMPLATE_EXAMPLE]);
  sheet['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 46 }];
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, 'Danh sách miễn chấm');
  workbook.Props = { Title: 'Mẫu danh sách miễn chấm ăn theo bữa' };
  return new Uint8Array(xlsx.write(workbook, { bookType: 'xlsx', type: 'array' }));
}

// --------------------------------------------------------- tính thời hạn

interface Interval { from: string; to: string | null; }

function unionIntervals(periods: readonly Interval[], joinAdjacent: boolean): Interval[] {
  const sorted = periods.map(period => ({ from: period.from, to: period.to })).sort((a, b) => a.from.localeCompare(b.from));
  const out: Interval[] = [];
  for (const period of sorted) {
    const previous = out.at(-1);
    const reach = previous && previous.to !== null && joinAdjacent ? addDays(previous.to, 1) : previous?.to;
    if (previous && (previous.to === null || period.from <= (reach as string))) {
      if (period.to === null) previous.to = null;
      else if (previous.to !== null && period.to > previous.to) previous.to = period.to;
    } else out.push(period);
  }
  return out;
}

/** Hợp các khoảng chồng nhau của từng bữa; khoảng liền kề giữ riêng để còn lịch sử. */
function combinePeriods(periods: readonly ExemptionPeriod[]): ExemptionPeriod[] {
  const combined = new Map<string, ExemptionPeriod>();
  for (const meal of EXEMPTION_MEALS) {
    for (const interval of unionIntervals(periods.filter(period => period.meals.includes(meal)), false)) {
      const key = `${interval.from}|${interval.to}`;
      const sameDates = combined.get(key);
      if (sameDates) sameDates.meals.push(meal);
      else combined.set(key, { ...interval, meals: [meal] });
    }
  }
  return [...combined.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** Hai danh sách khoảng có miễn đúng cùng các ngày/bữa không (bỏ qua cách chia khoảng). */
const coverageKey = (periods: readonly ExemptionPeriod[]) => EXEMPTION_MEALS.map(meal =>
  unionIntervals(periods.filter(period => period.meals.includes(meal)), true)
    .map(period => `${period.from}..${period.to ?? ''}`).join(',')).join('|');

export const sameExemptionRecord = (a: ExemptionRecord, b: ExemptionRecord) =>
  JSON.stringify(normalizeExemptionRecord(a)) === JSON.stringify(normalizeExemptionRecord(b));

function assertSameEmail(current: ExemptionRecord, incoming: ExemptionRecord) {
  if (current.email !== incoming.email) {
    throw new CheckinExemptionError(`Mã ${incoming.employeeId} đang gắn với email khác (${current.email}). `
      + 'Kiểm tra nhân sự, dùng “Sửa email” ở danh sách đã lưu nếu cần đổi.', { field: 'email' });
  }
}

/** Gộp thêm thời hạn: chỉ hợp các khoảng chồng nhau, khoảng đã đóng liền kề giữ lịch sử. */
export function mergeExemptionRecord(existing: ExemptionRecord | null, draft: ExemptionRecord): ExemptionRecord {
  const incoming = normalizeExemptionRecord(draft);
  if (!existing) return incoming;
  const current = normalizeExemptionRecord(existing, incoming.employeeId);
  assertSameEmail(current, incoming);
  return normalizeExemptionRecord({ ...current, fullName: incoming.fullName,
    periods: combinePeriods([...current.periods, ...incoming.periods]) });
}

/**
 * Thay thời hạn từ ngày bắt đầu: với các bữa được chọn, khoảng đã có chỉ giữ
 * những ngày trước ngày bắt đầu (cắt tới hôm trước), phần từ ngày bắt đầu trở
 * đi bị bỏ, rồi thêm khoảng mới. Bữa không chọn giữ nguyên.
 */
export function replaceExemptionPeriods(existing: ExemptionRecord | null, draft: ExemptionRecord): ExemptionRecord {
  const incoming = normalizeExemptionRecord(draft);
  if (!existing) return incoming;
  const current = normalizeExemptionRecord(existing, incoming.employeeId);
  assertSameEmail(current, incoming);
  const cut = new Map<ExemptionMeal, string>();
  for (const period of incoming.periods) {
    for (const meal of period.meals) if (!cut.has(meal) || period.from < (cut.get(meal) as string)) cut.set(meal, period.from);
  }
  const kept: ExemptionPeriod[] = [];
  for (const period of current.periods) {
    for (const meal of period.meals) {
      const from = cut.get(meal);
      if (!from || (period.to !== null && period.to < from)) kept.push({ from: period.from, to: period.to, meals: [meal] });
      else if (period.from < from) kept.push({ from: period.from, to: addDays(from, -1), meals: [meal] });
    }
  }
  return normalizeExemptionRecord({ ...current, fullName: incoming.fullName,
    periods: combinePeriods([...kept, ...incoming.periods]) });
}

export const applyExemptionDraft = (existing: ExemptionRecord | null, draft: ExemptionRecord, mode: ExemptionSaveMode) =>
  mode === 'replace' ? replaceExemptionPeriods(existing, draft) : mergeExemptionRecord(existing, draft);

export function exemptionState(record: ExemptionRecord, today: string): 'active' | 'future' | 'ended' {
  if (record.periods.some(period => period.from <= today && (period.to === null || period.to >= today))) return 'active';
  return record.periods.some(period => period.from > today) ? 'future' : 'ended';
}

// ------------------------------------------------- ngừng miễn / đặt hạn

/** Khung giờ bữa hôm nay đã mở chưa (giờ Việt Nam, HH:MM). */
export function mealStarted(meal: ExemptionMeal, now: string): boolean {
  if (!HHMM.test(now)) throw new CheckinExemptionError('Giờ hiện tại không hợp lệ.');
  return now >= MEAL_WINDOWS[meal].from;
}

/**
 * Ngày cuối cùng còn được miễn nếu ngừng ngay bây giờ. Bữa hôm nay đã mở thì
 * hôm nay vẫn miễn (nhân viên có thể đã không chấm vì đang được miễn), ngừng
 * có hiệu lực từ ngày mai; chưa mở thì phải chấm ngay từ hôm nay.
 */
export function stopLastExemptDay(today: string, meal: ExemptionMeal, now: string): string {
  if (!isIsoDate(today)) throw new CheckinExemptionError('Ngày hiện tại không hợp lệ.');
  return mealStarted(meal, now) ? today : addDays(today, -1);
}

/** Ngày đầu tiên nhân viên phải chấm lại bữa này nếu ngừng ngay bây giờ. */
export const stopEffectiveDate = (today: string, meal: ExemptionMeal, now: string) =>
  addDays(stopLastExemptDay(today, meal, now), 1);

/**
 * Ngừng miễn một bữa, giữ mọi ngày đã miễn trước ngày hiệu lực. Trả null khi
 * không còn khoảng nào (xóa bản ghi) — không bao giờ xảy ra khi một khoảng
 * đang miễn bữa đã mở hôm nay.
 */
export function stopExemptionToday(record: ExemptionRecord, today: string, meal: ExemptionMeal,
  now: string): ExemptionRecord | null {
  const current = normalizeExemptionRecord(record);
  const last = stopLastExemptDay(today, meal, now);
  const periods: ExemptionPeriod[] = [];
  for (const period of current.periods) {
    if (!period.meals.includes(meal) || (period.to !== null && period.to <= last)) {
      periods.push(period);
      continue;
    }
    const otherMeals = period.meals.filter(value => value !== meal);
    if (otherMeals.length) periods.push({ ...period, meals: otherMeals });
    if (period.from <= last) periods.push({ from: period.from, to: last, meals: [meal] });
  }
  return periods.length ? normalizeExemptionRecord({ ...current, periods: combinePeriods(periods) }) : null;
}

export interface ExemptionStopPlan {
  /** Ngày đầu tiên nhân viên phải chấm lại bữa này. */
  effective: string;
  /**
   * Khi không khoảng nào bắt đầu trước hoặc đúng ngày cuối còn miễn: ngừng chỉ là
   * hủy (các) khoảng sắp tới này — nhân viên vốn đang phải chấm. null nếu là ngừng thật.
   */
  upcoming: ExemptionPeriod[] | null;
  /** Hôm nay đang được miễn và bữa đã mở: hôm nay vẫn được miễn sau khi ngừng. */
  keepsToday: boolean;
  /** Có khoảng miễn bữa này bắt đầu trước ngày hiệu lực: những ngày đó được giữ. */
  keepsPast: boolean;
}

/** Ngừng miễn một bữa ngay bây giờ sẽ có tác dụng gì — để hỏi lại và báo kết quả đúng. */
export function planExemptionStop(record: ExemptionRecord, today: string, meal: ExemptionMeal,
  now: string): ExemptionStopPlan {
  const last = stopLastExemptDay(today, meal, now);
  const effective = addDays(last, 1);
  const periods = record.periods.filter(period => period.meals.includes(meal));
  const affected = periods.filter(period => period.to === null || period.to > last);
  return {
    effective,
    upcoming: affected.length && !affected.some(period => period.from <= last)
      ? affected.map(period => ({ from: period.from, to: period.to, meals: [meal] })) : null,
    keepsToday: last === today && exemptionCovers(record, today, meal),
    keepsPast: periods.some(period => period.from < effective),
  };
}

/** Các bữa còn khoảng miễn kéo dài qua ngày cuối được phép giữ (ngừng được). */
export const stoppableMeals = (record: ExemptionRecord, today: string, now: string) =>
  EXEMPTION_MEALS.filter(meal => {
    const last = stopLastExemptDay(today, meal, now);
    return record.periods.some(period => period.meals.includes(meal) && (period.to === null || period.to > last));
  });

/** Các bữa có khoảng miễn chưa có ngày kết thúc. */
export const openEndedMeals = (record: ExemptionRecord) =>
  EXEMPTION_MEALS.filter(meal => record.periods.some(period => period.meals.includes(meal) && period.to === null));

/** Ngày kết thúc sớm nhất được đặt cho khoảng không thời hạn của bữa này. */
export function endDateMinimum(record: ExemptionRecord, meal: ExemptionMeal, today: string, now: string): string | null {
  const period = record.periods.find(value => value.meals.includes(meal) && value.to === null);
  if (!period) return null;
  const last = stopLastExemptDay(today, meal, now);
  return period.from > last ? period.from : last;
}

export function setExemptionEndDate(record: ExemptionRecord, meal: ExemptionMeal, endDate: string,
  today: string, now: string): ExemptionRecord {
  const current = normalizeExemptionRecord(record);
  const minimum = endDateMinimum(current, meal, today, now);
  if (!minimum) {
    throw new CheckinExemptionError(`Không có khoảng miễn ${EXEMPTION_MEAL_NAME[meal]} nào chưa có ngày kết thúc.`, { field: 'periods' });
  }
  if (!isIsoDate(endDate) || !sensibleYear(endDate)) throw new CheckinExemptionError('Chọn ngày kết thúc hợp lệ.', { field: 'periods' });
  if (endDate < minimum) {
    const started = minimum === today && mealStarted(meal, now);
    throw new CheckinExemptionError(`Ngày kết thúc sớm nhất là ${formatDate(minimum)}`
      + (started ? ` vì ${EXEMPTION_MEAL_NAME[meal]} hôm nay đã bắt đầu.` : '.'), { field: 'periods' });
  }
  const periods: ExemptionPeriod[] = [];
  for (const period of current.periods) {
    if (period.to !== null || !period.meals.includes(meal)) { periods.push(period); continue; }
    const otherMeals = period.meals.filter(value => value !== meal);
    if (otherMeals.length) periods.push({ ...period, meals: otherMeals });
    periods.push({ from: period.from, to: endDate, meals: [meal] });
  }
  return normalizeExemptionRecord({ ...current, periods: combinePeriods(periods) });
}

/** Đổi email, giữ nguyên mã và mọi khoảng thời gian. */
export function changeExemptionEmail(record: ExemptionRecord, email: string): ExemptionRecord {
  const current = normalizeExemptionRecord(record);
  return normalizeExemptionRecord({ ...current, email: String(email ?? '') });
}

// ------------------------------------------------------- xem trước khi lưu

export type ExemptionPlanStatus = 'new' | 'changed' | 'unchanged' | 'error';
export interface ExemptionPlanRow {
  draft: ExemptionRecord;
  row: number | null;
  before: ExemptionRecord | null;
  /** Bản ghi sẽ được lưu (null khi lỗi). */
  after: ExemptionRecord | null;
  status: ExemptionPlanStatus;
  periodsChanged: boolean;
  nameChanged: boolean;
  /** Ngày kết thúc vừa nhập bị khoảng "không thời hạn" đang có nuốt mất (chế độ gộp). */
  absorbedEnd: boolean;
  /** Bữa đã mở hôm nay đang được miễn nhưng sẽ hết miễn sau khi lưu. */
  dropsStartedToday: ExemptionMeal[];
  error: string | null;
}
export interface ExemptionPlan {
  rows: ExemptionPlanRow[];
  counts: Record<ExemptionPlanStatus, number>;
  writes: number;
}

export function planExemptionRow(before: ExemptionRecord | null, draft: ExemptionRecord, mode: ExemptionSaveMode,
  clock?: ExemptionClock | null, blockedReason?: string | null): ExemptionPlanRow {
  const base: ExemptionPlanRow = { draft, row: null, before, after: null, status: 'error', periodsChanged: false,
    nameChanged: false, absorbedEnd: false, dropsStartedToday: [], error: null };
  if (blockedReason) return { ...base, error: blockedReason };
  let after: ExemptionRecord;
  try { after = applyExemptionDraft(before, draft, mode); }
  catch (error) { return { ...base, error: exemptionErrorMessage(error) }; }
  const periodsChanged = !before || coverageKey(before.periods) !== coverageKey(after.periods);
  // So theo NFC: tên đã lưu ở dạng dấu tách rời (trước đây) không thành "Đổi họ tên" giả.
  const nameChanged = !!before && before.fullName.normalize('NFC') !== after.fullName.normalize('NFC');
  let absorbedEnd = false;
  if (mode === 'merge' && before) {
    for (const period of draft.periods) {
      if (period.to === null) continue;
      const end = period.to;
      for (const meal of period.meals) {
        const covering = after.periods.find(value => value.meals.includes(meal) && value.from <= end
          && (value.to === null || value.to >= end));
        if (covering && covering.to === null) absorbedEnd = true;
      }
    }
  }
  const dropsStartedToday = before && clock && isIsoDate(clock.today) && HHMM.test(clock.now)
    ? EXEMPTION_MEALS.filter(meal => mealStarted(meal, clock.now)
      && exemptionCovers(before, clock.today, meal) && !exemptionCovers(after, clock.today, meal))
    : [];
  return { ...base, after, status: !before ? 'new' : periodsChanged || nameChanged ? 'changed' : 'unchanged',
    periodsChanged, nameChanged, absorbedEnd, dropsStartedToday };
}

export function planExemptionSave(drafts: readonly ExemptionRecord[], existing: ReadonlyMap<string, ExemptionRecord>,
  mode: ExemptionSaveMode, options: {
    clock?: ExemptionClock | null;
    blocked?: ReadonlyMap<string, string>;
    rowNumbers?: Record<string, number>;
  } = {}): ExemptionPlan {
  const rows = drafts.map(draft => ({
    ...planExemptionRow(existing.get(draft.employeeId) ?? null, draft, mode, options.clock,
      options.blocked?.get(draft.employeeId) ?? null),
    row: options.rowNumbers?.[draft.employeeId] ?? null,
  }));
  const counts: Record<ExemptionPlanStatus, number> = { new: 0, changed: 0, unchanged: 0, error: 0 };
  for (const row of rows) counts[row.status]++;
  return { rows, counts, writes: counts.new + counts.changed };
}

// ------------------------------------------------------ bản ghi đã lưu

export interface StoredExemptionIssue {
  docId: string;
  /** Mã nhân viên bản ghi lỗi nhắc tới (nếu đọc được). */
  employeeId: string | null;
  /** Mọi mã bản ghi lỗi nhắc tới (mã tài liệu và mã trong dữ liệu) — agent đang giữ thư thiếu chấm của các mã này. */
  codes: string[];
  reason: string;
  /** Bản ghi chuẩn sẽ ghi khi bấm "Sửa tự động"; null nếu không sửa tự động được. */
  fix: ExemptionRecord | null;
  /** Vì sao không sửa tự động được (khi có thể nói rõ). */
  fixNote: string | null;
}
export interface StoredExemptions {
  /** Mọi tài liệu tự nó hợp lệ (kể cả mã đang bị tạm giữ). */
  records: ExemptionRecord[];
  /** Mã có bản ghi hợp lệ nhưng một bản ghi lỗi khác cũng nhắc tới — trạng thái miễn chưa xác định. */
  held: Set<string>;
  /**
   * Số bản ghi lỗi không đọc được mã nào (exemptionQuarantine().unidentified): khi > 0
   * agent giữ toàn bộ thư thiếu chấm và tab Đối soát chưa kết luận được ai thiếu chấm.
   */
  unidentified: number;
  issues: StoredExemptionIssue[];
}

/** Firestore Console cho gõ mã dạng số; mã đủ 6 chữ số thì đổi thành chuỗi. */
function coerceNumericId(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const value = data as Record<string, unknown>;
  return typeof value.employeeId === 'number' && Number.isSafeInteger(value.employeeId)
    ? { ...value, employeeId: String(value.employeeId) } : value;
}

/**
 * Bản ghi chuẩn để "Sửa tự động" một tài liệu lỗi. Ném lỗi khi dữ liệu không
 * tự chuẩn hoá được, hoặc mã tài liệu là một mã nhân viên khác với mã trong bản
 * ghi (không biết mã nào đúng thì không đoán).
 */
export function prepareExemptionAutoFix(docId: string, data: unknown): ExemptionRecord {
  const record = normalizeExemptionRecord(coerceNumericId(data));
  if (STAFF_CODE.test(docId) && docId !== record.employeeId) {
    throw new CheckinExemptionError(`Mã tài liệu ${docId} khác mã nhân viên ${record.employeeId} trong bản ghi nên không sửa tự động được. `
      + 'Kiểm tra mã đúng, xóa bản ghi lỗi rồi thêm lại.', { field: 'docId' });
  }
  return record;
}

const byName = (a: ExemptionRecord, b: ExemptionRecord) =>
  a.fullName.localeCompare(b.fullName, 'vi') || a.employeeId.localeCompare(b.employeeId);

/** Tách tài liệu đã lưu: bản ghi dùng được, mã bị tạm giữ, và bản ghi cần kiểm tra. Không ném lỗi vì dữ liệu. */
export function readStoredExemptions(docs: Iterable<{ id: string; data: unknown }>): StoredExemptions {
  const list = [...docs].map(item => ({ id: String(item.id ?? ''), data: item.data }));
  const { invalid } = parseCheckinExemptionDocs(list);
  const invalidIds = new Set(invalid.map(item => item.docId));
  const valid = new Map<string, ExemptionRecord>();
  for (const { id, data } of list) {
    if (invalidIds.has(id)) continue;
    try { valid.set(id, validateStoredCheckinExemption(id, data) as ExemptionRecord); } catch { /* đã nằm trong invalid */ }
  }
  const dataById = new Map(list.map(item => [item.id, item.data]));
  // Bản ghi chuẩn mà từng tài liệu lỗi tự chuẩn hoá được (nếu được).
  const repairs = invalid.map(item => {
    try {
      return { record: prepareExemptionAutoFix(item.docId, dataById.get(item.docId)), note: null };
    } catch (error) {
      return { record: null, note: fieldOf(error) === 'docId' ? exemptionErrorMessage(error) : null };
    }
  });
  const byTarget = new Map<string, ExemptionRecord[]>();
  for (const { record } of repairs) if (record) byTarget.set(record.employeeId, [...byTarget.get(record.employeeId) ?? [], record]);
  const issues = invalid.map((item, index): StoredExemptionIssue => {
    // Không tự chuẩn hoá được thì chỉ xóa được (`note` nói rõ lý do khi có thể).
    const { record, note } = repairs[index];
    let fix: ExemptionRecord | null = null;
    let fixNote: string | null = note;
    if (record) {
      const twins = byTarget.get(record.employeeId) ?? [];
      if (record.employeeId !== item.docId && valid.has(record.employeeId)) {
        fixNote = `Đã có bản ghi hợp lệ của mã ${record.employeeId}. Xóa bản ghi lỗi này, hoặc xóa bản ghi kia trước rồi sửa tự động.`;
      } else if (twins.length > 1) {
        // Không biết bản nào đúng thì không đoán: sửa một bản thì bản kia vẫn giữ mã này lại.
        fixNote = twins.every(other => sameExemptionRecord(other, record))
          ? `Có ${twins.length} bản ghi lỗi cùng mã ${record.employeeId} với nội dung giống nhau — xóa bớt bản thừa rồi sửa tự động bản còn lại.`
          : `Có ${twins.length} bản ghi lỗi cùng mã ${record.employeeId} với nội dung khác nhau — xóa bản sai rồi sửa tự động bản đúng.`;
      } else if (record.employeeId !== item.docId && dataById.has(record.employeeId)) {
        fixNote = `Tài liệu “${record.employeeId}” cũng đang lỗi. Xử lý tài liệu đó trước rồi sửa tự động bản ghi này.`;
      } else if (invalid.some(other => other.docId === item.docId && other !== item)) {
        fixNote = 'Tài liệu bị trùng, xóa bớt một bản.';
      } else fix = record;
    }
    return { docId: item.docId, employeeId: item.employeeId, codes: [...item.codes], reason: item.reason, fix, fixNote };
  });
  const quarantine = exemptionQuarantine(invalid);
  const records = [...valid.values()].sort(byName);
  return { records, held: new Set(records.map(record => record.employeeId).filter(id => quarantine.ids.has(id))),
    unidentified: quarantine.unidentified, issues };
}

/**
 * Hệ quả của việc xóa một bản ghi lỗi, để hỏi lại trước khi xóa: mã nào hết miễn
 * chấm (nhận email cảnh báo), mã nào dùng lại bản ghi hợp lệ đang có, hay agent
 * gửi lại thư thiếu chấm (bản ghi không rõ mã).
 */
export function describeIssueRemoval(issue: StoredExemptionIssue, stored: StoredExemptions): string[] {
  const others = stored.issues.filter(other => other.docId !== issue.docId);
  const valid = new Set(stored.records.map(record => record.employeeId));
  const lines: string[] = [];
  if (!issue.codes.length) {
    const remaining = others.filter(other => !other.codes.length).length;
    lines.push(remaining
      ? `Vẫn còn ${remaining} bản ghi lỗi không rõ mã khác nên agent tiếp tục tạm dừng toàn bộ email cảnh báo thiếu chấm.`
      : 'Sau khi xóa, agent gửi lại email cảnh báo thiếu chấm như bình thường và tab Đối soát kết luận lại được.');
  }
  let lost = false;
  for (const code of issue.codes) {
    if (others.some(other => other.codes.includes(code))) lines.push(`Mã ${code} vẫn còn bản ghi lỗi khác cần xử lý.`);
    else if (valid.has(code)) lines.push(`Mã ${code} sẽ dùng lại bản ghi hợp lệ đang có trong danh sách.`);
    else {
      lines.push(`Mã ${code} sẽ không còn được miễn chấm (sẽ nhận email cảnh báo nếu thiếu chấm).`);
      if (code === issue.fix?.employeeId) lost = true;
    }
  }
  if (lost) lines.push('Muốn giữ miễn chấm, dùng “Sửa tự động”.');
  return lines;
}

// ---------------------------------------------------- khớp đơn đăng ký

export interface RegistrationIdentity { employeeId?: unknown; email?: unknown; }
export type ExemptionHintKind = 'matched' | 'noRegistration' | 'registrationEmail' | 'emailTaken';
export interface ExemptionHint {
  kind: ExemptionHintKind;
  level: 'ok' | 'info' | 'warning';
  message: string;
  /** Email trên đơn đăng ký (khi khác email trong danh sách). */
  emails?: string[];
}

const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
};

/**
 * Gợi ý khớp tài khoản theo đơn đăng ký tháng đang chọn. Miễn chấm chỉ áp dụng
 * khi đơn đăng ký mang đúng mã VÀ email trong danh sách.
 */
export function createExemptionHints(registrations: readonly RegistrationIdentity[],
  records: readonly ExemptionRecord[], month: string) {
  const label = formatMonthLabel(month);
  const emailsByCode = new Map<string, Set<string>>();
  const codesByEmail = new Map<string, Set<string>>();
  for (const registration of registrations) {
    const code = normalizeExemptionEmployeeId(registration?.employeeId);
    if (!code) continue;
    const email = typeof registration?.email === 'string' ? registration.email.trim().toLowerCase() : '';
    addTo(emailsByCode, code, email);
    if (email) addTo(codesByEmail, email, code);
  }
  const listedCodesByEmail = new Map<string, Set<string>>();
  for (const record of records) addTo(listedCodesByEmail, record.email, record.employeeId);

  return (record: { employeeId: string; email: string }): ExemptionHint[] => {
    const hints: ExemptionHint[] = [];
    const emails = emailsByCode.get(record.employeeId);
    if (!emails) {
      const otherCodes = [...(codesByEmail.get(record.email) ?? [])].filter(code => code !== record.employeeId);
      hints.push({ kind: 'noRegistration', level: 'info', message: `Chưa có đơn đăng ký tháng ${label} với mã này`
        + (otherCodes.length ? ` — email này đăng ký với mã ${otherCodes.join(', ')}.` : '.') });
    } else {
      const others = [...emails].filter(email => email !== record.email).sort();
      const listed = others.map(email => email || '(đơn không có email)').join(', ');
      if (emails.has(record.email)) hints.push({ kind: 'matched', level: 'ok', message: `Khớp đơn đăng ký tháng ${label}.` });
      // Cùng mã còn đơn khác (vd. đăng ký bằng hai tài khoản): đơn đó không được miễn.
      if (others.length) {
        hints.push({ kind: 'registrationEmail', level: 'warning', emails: others.filter(Boolean),
          message: emails.has(record.email)
            ? `Mã này còn đơn đăng ký khác dùng email khác: ${listed}. Miễn chấm không áp dụng cho đơn đó.`
            : `Đơn đăng ký của mã này dùng email khác: ${listed}. Miễn chấm sẽ không được áp dụng cho đơn này.` });
      }
    }
    const otherListed = [...(listedCodesByEmail.get(record.email) ?? [])].filter(code => code !== record.employeeId);
    if (otherListed.length) {
      hints.push({ kind: 'emailTaken', level: 'warning', message: `Email này đã gắn với mã khác trong danh sách: ${otherListed.join(', ')}.` });
    }
    return hints;
  };
}
