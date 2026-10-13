/**
 * Gọi endpoint gửi email trên web (`POST /api/meal-alerts`) từ agent.
 *
 * Khác các file còn lại trong lib/: hàm này CÓ gọi mạng (fetch). Tách ra đây vì
 * hai script dùng chung — sync-checkins.mjs (email cảnh báo) và
 * survey-invite.mjs (email mời khảo sát) — mà phần khó nhất là KHÔNG BAO GIỜ để
 * lộ khoá bí mật trong thông báo lỗi. Hai bản chép tay sẽ sớm lệch nhau, và chỉ
 * cần một bản quên che khoá là khoá vào log, vào Firestore.
 *
 * Chỉ dùng fetch/URL/AbortSignal có sẵn của Node, không import Node hay
 * Firebase, nên vẫn nạp được trong test.
 */

import { redact } from './common.mjs';

/** Endpoint có thể phải chờ Microsoft Graph (429) — cho rộng. */
export const ENDPOINT_TIMEOUT_MS = 90_000;

/**
 * Lỗi kết nối xảy ra TRƯỚC khi yêu cầu rời máy (không tìm/không tới được máy
 * chủ, bắt tay TLS hỏng): chắc chắn chưa thư nào đi, gửi lại không thể trùng.
 * Mọi lỗi khác giữa chừng (hết giờ chờ, ECONNRESET, "other side closed",
 * ETIMEDOUT của TCP...) thì KHÔNG biết máy chủ đã gửi thư hay chưa.
 */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/**
 * Lỗi của postAlerts, kèm cho bên gọi biết thư CÓ THỂ đã đi hay chưa:
 *   - `delivery: 'not_sent'` — chắc chắn chưa gửi (không kết nối được, máy chủ
 *     từ chối 4xx, hoặc chính hàm /api/meal-alerts trả lỗi dạng JSON);
 *   - `delivery: 'unknown'` — không biết (hết giờ chờ, đứt kết nối giữa chừng,
 *     Vercel trả trang lỗi 5xx không phải của hàm). Thư mời khảo sát là MỘT thư
 *     Bcc cho cả trường: gửi lại "cho chắc" là cả trường nhận hai thư.
 * `status` là mã HTTP nếu máy chủ đã trả lời. `message` giữ nguyên như trước
 * (sync-checkins.mjs chỉ đọc message, không đổi cách chạy).
 *
 * Hàm /api/meal-alerts chỉ trả lỗi JSON (non-2xx) khi CHƯA gọi Graph gửi thư
 * (sai dữ liệu, sai khoá, thiếu cấu hình, không lấy được token). Graph lỗi sau
 * khi đã nhận yêu cầu gửi thì hàm vẫn trả 200, kèm kết quả từng thư — với thư
 * mời khảo sát là `ok: false, maybeSent: true` — nên phần đó do bên gọi đọc
 * trong thân phản hồi (lib/survey-plan.mjs inviteOutcome), không phải ở đây.
 */
export class EndpointError extends Error {
  /** @param {string} message @param {{ delivery: 'not_sent' | 'unknown', status?: number | null }} info */
  constructor(message, { delivery, status = null }) {
    super(message);
    this.delivery = delivery;
    this.status = status;
  }
}

/**
 * Gửi một request tới endpoint. Trả về thân phản hồi (JSON) hoặc ném lỗi nếu
 * không phải 2xx. Không bao giờ in khoá bí mật — kể cả trong thông báo lỗi.
 *
 * @param {{ endpoint: string, secret: string }} cfg
 * @param {unknown} body
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function postAlerts(cfg, body, { timeoutMs = ENDPOINT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = /** @type {any} */ (e);
    const name = err?.name || err?.cause?.name || '';
    // TypeError ném ra TRƯỚC khi gửi (header hoặc địa chỉ không hợp lệ): thông
    // báo gốc có thể chép nguyên "Bearer <khoá>" — không bao giờ dùng nó.
    const why = name === 'TimeoutError'
      ? `không trả lời trong ${timeoutMs / 1000} giây`
      : err instanceof TypeError && !err.cause
        ? 'không tạo được yêu cầu gửi (kiểm tra alerts.endpoint và alerts.secret trong config.json)'
        : (err?.cause?.code || err?.cause?.message || err?.message || 'lỗi kết nối');
    let host = 'endpoint';
    try { host = new URL(cfg.endpoint).host; } catch { /* đã báo ở bước kiểm tra cấu hình */ }
    const code = String(err?.cause?.code || err?.code || '');
    const notSent = name !== 'TimeoutError' && ((err instanceof TypeError && !err.cause) || NOT_SENT_CODES.has(code));
    throw new EndpointError(redact(`Không gọi được ${host} — ${why}`, cfg.secret), { delivery: notSent ? 'not_sent' : 'unknown' });
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* thân không phải JSON */ }
  if (!res.ok) {
    const msg = String(data?.error || data?.message || text).replace(/\s+/g, ' ').slice(0, 200);
    const hint = res.status === 401 ? ' — alerts.secret không khớp biến MEAL_ALERT_SECRET trên Vercel'
      : res.status === 500 && /MEAL_ALERT_SECRET/.test(msg) ? ' — đặt biến này trên Vercel (ít nhất 32 ký tự) rồi Redeploy'
      : res.status === 404 ? ' — sai alerts.endpoint, hoặc bản web chưa có /api/meal-alerts'
      : '';
    // 4xx: máy chủ từ chối, chưa gửi gì. Thân JSON có `error` dạng chuỗi là do
    // chính hàm /api/meal-alerts trả — nó chỉ trả lỗi như vậy khi chưa gửi thư.
    // Còn lại (trang lỗi 502/504 của Vercel...) thì không biết thư đã đi chưa.
    const fromHandler = typeof data?.error === 'string';
    const delivery = (res.status >= 400 && res.status < 500) || fromHandler ? 'not_sent' : 'unknown';
    throw new EndpointError(redact(`Endpoint trả HTTP ${res.status}${msg ? `: ${msg}` : ''}${hint}`, cfg.secret), { delivery, status: res.status });
  }
  return data;
}
