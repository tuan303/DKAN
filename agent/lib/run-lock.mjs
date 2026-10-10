/**
 * Chỉ cho MỘT lần chạy thật của agent tại một thời điểm, bằng một file khoá
 * cạnh script.
 *
 * Vì sao: chống gửi trùng email cảnh báo dựa vào alerts[hôm nay] và nhật ký
 * meal_alerts, đọc lúc đầu lần chạy rồi mới gửi sau 1–3 phút hỏi thiết bị. Hai
 * lần chạy chồng nhau (chạy tay để thử đúng lúc task 13:45 đang chạy, hay hai
 * task khác nhau trùng giờ — "Do not start a new instance" chỉ chặn trong
 * CÙNG một task) cùng thấy "chưa ai được gửi" và cùng gửi: mỗi người nhận hai
 * email "vi phạm". Hai lần ghi checkins chồng nhau cũng có thể đè phần của nhau.
 *
 * Khoá kẹt (máy tắt ngang, tiến trình bị giết) tự hết hiệu lực khi tiến trình
 * giữ khoá không còn chạy, hoặc khoá đã quá cũ.
 *
 * File thuần: việc đọc/ghi file do nơi gọi truyền vào (để test được mà không
 * đụng ổ đĩa).
 */

// Task Scheduler dừng mọi lần chạy quá 1 giờ; khoá cũ hơn mức đó chắc chắn là
// khoá kẹt.
export const LOCK_STALE_MS = 70 * 60 * 1000;
// File khoá rỗng hoặc hỏng (tiến trình kia vừa tạo, chưa kịp ghi xong) chỉ
// được coi là kẹt khi đã cũ hơn mức này.
const UNREADABLE_GRACE_MS = 60 * 1000;

/**
 * @typedef {object} LockInfo
 * @property {number} pid
 * @property {string} token      chuỗi ngẫu nhiên, để chỉ xoá đúng khoá của mình
 * @property {string} startedAt  ISO
 * @property {string} [args]
 */

/**
 * @typedef {object} LockDeps
 * @property {(path: string, text: string) => boolean} tryCreate  tạo file nếu CHƯA có (nguyên tử); false nếu đã có
 * @property {(path: string) => { text: string, mtimeMs: number } | null} read  null nếu không có file
 * @property {(path: string) => void} remove
 * @property {() => number} now                ms
 * @property {(pid: number) => boolean} isAlive
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * Khoá đang có còn hiệu lực không.
 * @param {{ text: string, mtimeMs: number }} file
 * @param {{ now: number, isAlive: (pid: number) => boolean, staleMs?: number }} ctx
 * @returns {{ stale: boolean, holder: LockInfo | null }}
 */
export function inspectLock(file, { now, isAlive, staleMs = LOCK_STALE_MS }) {
  /** @type {LockInfo | null} */
  let holder = null;
  try {
    const v = JSON.parse(file.text);
    if (v && typeof v === 'object' && Number.isInteger(v.pid) && v.pid > 0) holder = v;
  } catch { /* file rỗng hoặc hỏng */ }
  if (!holder) return { stale: now - file.mtimeMs > UNREADABLE_GRACE_MS, holder: null };
  const started = Date.parse(holder.startedAt);
  const age = Number.isFinite(started) ? now - started : now - file.mtimeMs;
  return { stale: age > staleMs || !isAlive(holder.pid), holder };
}

/**
 * Lấy khoá; nếu đang có lần chạy khác thì chờ tối đa `waitMs`.
 *
 * @param {{ path: string, info: LockInfo, deps: LockDeps, waitMs?: number, pollMs?: number, onWait?: (holder: LockInfo | null) => void }} input
 * @returns {Promise<{ ok: true, release: () => void } | { ok: false, holder: LockInfo | null }>}
 */
export async function acquireLock({ path, info, deps, waitMs = 10 * 60 * 1000, pollMs = 5000, onWait }) {
  const text = JSON.stringify(info);
  const deadline = deps.now() + waitMs;
  let announced = false;
  /** @type {LockInfo | null} */
  let lastHolder = null;

  // Giới hạn số vòng cho chắc không bao giờ quay mãi (vd. file khoá cứ bị
  // xoá rồi tạo lại liên tục).
  for (let round = 0; round < 100000; round++) {
    if (deps.tryCreate(path, text)) {
      return {
        ok: true,
        release: () => {
          // Chỉ xoá khi file vẫn là khoá của mình: khoá của mình đã bị coi là
          // kẹt và bị lần chạy khác thay thì không được xoá khoá của họ.
          try {
            const cur = deps.read(path);
            if (cur && cur.text === text) deps.remove(path);
          } catch { /* đang thoát; không để lỗi phụ che lỗi chính */ }
        },
      };
    }
    const cur = deps.read(path);
    if (!cur) continue; // vừa được giải phóng — thử tạo lại ngay
    const { stale, holder } = inspectLock(cur, { now: deps.now(), isAlive: deps.isAlive });
    lastHolder = holder;
    if (stale) {
      // Đọc lại ngay trước khi xoá: thu hẹp khả năng xoá nhầm khoá MỚI của
      // một lần chạy khác vừa thay khoá kẹt.
      const again = deps.read(path);
      if (again && again.text === cur.text) deps.remove(path);
      continue;
    }
    if (deps.now() >= deadline) return { ok: false, holder };
    if (!announced) { announced = true; onWait?.(holder); }
    await deps.sleep(pollMs);
  }
  return { ok: false, holder: lastHolder };
}
