/**
 * Vài hàm nhỏ dùng chung cho các module của agent.
 *
 * Tách riêng để các module nghiệp vụ (gộp dữ liệu, gán mã NV, chọn người nhận
 * cảnh báo) không phụ thuộc lẫn nhau chỉ vì cần cộng ngày hay chia lô. File
 * thuần, không import Node hay Firebase, nên chạy được trong test.
 */

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM_RE = /^\d{2}:\d{2}$/;

/** YYYY-MM-DD hợp lệ thật (không chỉ đúng dạng): loại 2026-02-30. @param {unknown} v */
export function isIsoDate(v) {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Cộng/trừ ngày trên chuỗi YYYY-MM-DD.
 *
 * Làm trên mốc UTC để kết quả không phụ thuộc múi giờ của máy chạy: ngày ở đây
 * là ngày lịch (đã là giờ Việt Nam từ trước), không phải một thời điểm.
 *
 * @param {string} iso
 * @param {number} n
 */
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Mọi ngày từ `from` tới `to`, gồm cả hai đầu. @param {string} from @param {string} to */
export function datesFromTo(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Mọi ngày của tháng `month` (YYYY-MM), tính tới hết `until` nếu có.
 * @param {string} month @param {string} [until] YYYY-MM-DD
 */
export function monthDates(month, until) {
  const [y, m] = month.split('-').map(Number);
  const last = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const end = until && until < last ? until : last;
  return end < `${month}-01` ? [] : datesFromTo(`${month}-01`, end);
}

/**
 * Chia mảng thành các lô. Firestore giới hạn 500 thao tác mỗi batch, getUsers
 * 100 uid mỗi lần, endpoint cảnh báo 20 người mỗi request.
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Duy nhất + sắp xếp. Giờ HH:MM và mã NV đều so được bằng thứ tự chuỗi. @param {Iterable<string>} v */
export const uniqSorted = v => [...new Set(v)].sort();

/** Hai danh sách chuỗi có giống hệt nhau không (cùng thứ tự). @param {unknown} a @param {unknown} b */
export function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** Cắt chuỗi về độ dài tối đa, bỏ khoảng trắng hai đầu. @param {unknown} v @param {number} max */
export const clip = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Một dòng chữ sạch: ký tự điều khiển (xuống dòng, tab...) thành khoảng trắng,
 * gộp khoảng trắng, rồi cắt độ dài.
 *
 * Endpoint gửi email từ chối CẢ LÔ nếu một trường có ký tự điều khiển — một họ
 * tên dán từ Excel có dấu tab là mười người trong lô không nhận được email, và
 * lần chạy nào cũng hỏng y như vậy.
 *
 * @param {unknown} v @param {number} max
 */
export const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Che một giá trị bí mật khỏi chuỗi trước khi in ra log hay ghi lên hệ thống.
 *
 * Thông báo lỗi do thư viện (fetch, undici) tự dựng có thể chép nguyên header
 * Authorization vào — vd. khoá có ký tự xuống dòng thì lỗi "invalid header
 * value" in cả "Bearer <khoá>". Lỗi đó đi vào dong-bo.log và vào
 * settings/checkinSync, nơi mọi người đã đăng nhập đều đọc được.
 *
 * @param {unknown} text @param {string | null | undefined} secret
 */
export function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(secret).join('***') : s;
}
