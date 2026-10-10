/**
 * Làm sạch đơn đăng ký `registrations/{uid}_{YYYY-MM}` trước khi agent dùng.
 *
 * Vì sao phải làm sạch: đơn do trình duyệt tự ghi, và rules hiện tại cho mọi
 * người đã đăng nhập TẠO đơn với id và userId bất kỳ. Agent lại dùng uid trên
 * đơn để dựng đường dẫn Firestore (`meal_taps/{uid}/...`, `meal_alerts/
 * {ngày}_{uid}`) và để hỏi Firebase Auth. Một đơn mang userId "x/y" (hoặc là
 * số) làm Firestore ném lỗi ngay khi dựng đường dẫn: cả lần chạy hỏng, lần nào
 * cũng hỏng, không ghi được trạng thái, không cảnh báo được ai — cho tới khi
 * có người tìm ra và xoá đơn đó. Ở đây một đơn hỏng chỉ bị bỏ qua (có log).
 *
 * Đơn của tài khoản không tồn tại (tài khoản "ma") cũng bị bỏ khi xét trùng
 * mã: nếu không, ai cũng tạo được một đơn ma mang mã NV của chính mình để hai
 * đơn "trùng mã" và cả hai bị bỏ qua — tức là tự miễn cảnh báo. Agent không
 * chặn được hết (đơn mang uid của một đồng nghiệp có thật), phần còn lại phải
 * chặn bằng rules: chỉ cho tạo đơn của chính mình.
 *
 * File thuần, không import Node hay Firebase.
 */

// uid của Firebase Auth do hệ thống sinh: 28 ký tự chữ và số. Cho rộng thêm
// "_" và "-" (uid tự đặt qua Admin SDK hay dùng) nhưng không bao giờ có "/",
// ".", khoảng trắng — những thứ làm hỏng đường dẫn Firestore.
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** uid dùng an toàn làm một đoạn đường dẫn Firestore và để hỏi Firebase Auth. @param {unknown} uid */
export const isSafeUid = uid =>
  typeof uid === 'string' && UID_RE.test(uid) && !/^__.*__$/.test(uid);

/**
 * @typedef {Record<string, any> & { uid: string }} CleanRegistration
 */

/**
 * @param {{ docs: { id: string, data: Record<string, any> }[], month: string }} input
 *   docs: các đơn của tháng (kết quả truy vấn month == M)
 * @returns {{ registrations: CleanRegistration[], rejected: { id: string, why: string }[] }}
 */
export function cleanRegistrations({ docs, month }) {
  /** @type {CleanRegistration[]} */
  const registrations = [];
  /** @type {{ id: string, why: string }[]} */
  const rejected = [];
  const suffix = `_${month}`;

  for (const { id, data } of docs) {
    const d = data && typeof data === 'object' ? data : {};
    // Đơn mang id `{uid}_{YYYY-MM}`; đơn rất cũ có thể thiếu trường userId.
    const fromId = typeof id === 'string' && id.endsWith(suffix) ? id.slice(0, -suffix.length) : '';
    const hasUserId = d.userId !== undefined && d.userId !== null && d.userId !== '';
    if (hasUserId && typeof d.userId !== 'string') { rejected.push({ id, why: 'userId không phải chuỗi' }); continue; }
    const uid = hasUserId ? d.userId : fromId;
    if (!isSafeUid(uid)) { rejected.push({ id, why: 'userId không hợp lệ' }); continue; }
    // Trang đăng ký luôn ghi đơn vào đúng id `{uid}_{tháng}`. Đơn nằm ở id khác
    // (hoặc userId khác chủ id) không phải do trang đăng ký tạo ra.
    if (uid !== fromId) { rejected.push({ id, why: 'id đơn không khớp userId và tháng' }); continue; }
    if (d.month !== undefined && d.month !== month) { rejected.push({ id, why: 'tháng trên đơn không khớp' }); continue; }
    registrations.push({ ...d, uid });
  }
  return { registrations, rejected };
}

/**
 * Bỏ đơn của tài khoản không còn / chưa từng tồn tại trong Firebase Auth.
 * @template {{ uid: string }} R
 * @param {R[]} registrations
 * @param {(uid: string) => boolean} exists
 * @returns {{ kept: R[], ghosts: string[] }}
 */
export function dropGhosts(registrations, exists) {
  /** @type {R[]} */ const kept = [];
  /** @type {string[]} */ const ghosts = [];
  for (const r of registrations) {
    if (exists(r.uid)) kept.push(r); else ghosts.push(r.uid);
  }
  return { kept, ghosts };
}
