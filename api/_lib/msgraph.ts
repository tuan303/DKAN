/**
 * Gửi email qua Microsoft Graph bằng quyền ứng dụng (client credentials), từ
 * hộp thư MS_GRAPH_SENDER — đúng luồng api/send-email.ts đang chạy thật.
 *
 * Tách ra đây để các endpoint mới dùng chung mà không phải chép lại luồng lấy
 * token / gửi thư, và để không đụng vào api/send-email.ts (file đó sẽ được sửa
 * ở một việc riêng). Thư mục bắt đầu bằng "_" nên Vercel không biến file này
 * thành một function công khai.
 */

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sender: string;
}

export interface MailMessage {
  to: string[];
  cc?: string[];
  replyTo?: string[];
  subject: string;
  html: string;
  /** Mặc định false: thư tự động gửi hàng loạt không nên làm đầy Sent Items của hộp thư dinhduong@. */
  saveToSentItems?: boolean;
}

export interface SendOptions {
  /**
   * Mốc (ms, theo Date.now()) mà mọi request gửi đi phải KẾT THÚC trước đó, tính
   * cả hạn chờ tối đa REQUEST_TIMEOUT_MS của chính request ấy. Function trên
   * Vercel bị cắt ngang khi hết giờ; bị cắt giữa chừng thì bên gọi không biết
   * thư nào đã đi và lần sau sẽ gửi trùng — thà không bắt đầu / không thử lại
   * rồi báo lỗi rõ ràng để lần sau gửi nốt.
   */
  deadlineAt?: number;
}

export class GraphError extends Error {
  /** Mã HTTP Graph trả về; 0 nghĩa là chưa gọi tới Graph (không còn đủ thời gian). */
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
  }
}

// Graph gửi thư thường dưới 1 giây; quá 10 giây coi như treo, không để một thư
// kéo cả lô vượt thời gian tối đa của function. Hạn này phủ cả lúc đọc thân
// phản hồi vì signal gắn với cả request.
export const REQUEST_TIMEOUT_MS = 10_000;

// Microsoft khuyên chờ đúng Retry-After khi bị giới hạn tần suất (429), nhưng
// một function không thể chờ lâu, nên chặn trên ~10 giây.
export const RETRY_AFTER_CAP_MS = 10_000;
const RETRY_AFTER_DEFAULT_MS = 2_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Còn đủ thời gian để chờ `waitMs` rồi chạy trọn một request — kể cả khi nó treo
 * tới hết REQUEST_TIMEOUT_MS — trước `deadlineAt` không? Phải tính cả hạn chờ:
 * chỉ so "bây giờ + thời gian chờ" thì một lần thử lại bị treo vẫn chạy lố mốc.
 */
const fitsBefore = (deadlineAt: number | undefined, waitMs = 0) =>
  deadlineAt === undefined || Date.now() + waitMs + REQUEST_TIMEOUT_MS <= deadlineAt;

/** Đọc cấu hình Graph từ biến môi trường; thiếu biến nào thì trả null. */
export function readGraphConfig(env: Record<string, string | undefined> = process.env): GraphConfig | null {
  const tenantId = env.MS_GRAPH_TENANT_ID?.trim();
  const clientId = env.MS_GRAPH_CLIENT_ID?.trim();
  const clientSecret = env.MS_GRAPH_CLIENT_SECRET?.trim();
  const sender = env.MS_GRAPH_SENDER?.trim();
  if (!tenantId || !clientId || !clientSecret || !sender) return null;
  return { tenantId, clientId, clientSecret, sender };
}

/**
 * Số mili-giây cần chờ theo header Retry-After (dạng số giây hoặc ngày giờ HTTP),
 * đã chặn trong [0, RETRY_AFTER_CAP_MS]. Thiếu hoặc sai định dạng thì chờ mặc định.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number {
  const v = (value ?? '').trim();
  if (!v) return RETRY_AFTER_DEFAULT_MS;
  let ms: number;
  if (/^\d+$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return RETRY_AFTER_DEFAULT_MS;
    ms = at - now;
  }
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
}

/** Tóm tắt lỗi Graph / Entra ID thành một dòng ngắn để bên gọi ghi log. */
async function describeFailure(res: Response, prefix: string): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      // Graph: { error: { code, message } }; máy chủ token: { error: 'invalid_client', error_description }
      if (j.error && typeof j.error === 'object') {
        const e = j.error as { code?: unknown; message?: unknown };
        detail = [e.code, e.message].filter(x => typeof x === 'string' && x).join(': ');
      } else {
        detail = [j.error, j.error_description].filter(x => typeof x === 'string' && x).join(': ');
      }
    } catch {
      detail = text;
    }
  } catch {
    // Không đọc được nội dung lỗi thì chỉ báo mã HTTP.
  }
  return `${prefix} HTTP ${res.status}${detail ? ` — ${detail}` : ''}`.replace(/\s+/g, ' ').slice(0, 300);
}

/** Lấy access token cho Graph. Gọi 1 lần cho mỗi request rồi dùng chung cho cả lô thư. */
export async function getGraphToken(cfg: GraphConfig): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      scope: 'https://graph.microsoft.com/.default',
      client_secret: cfg.clientSecret,
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new GraphError(await describeFailure(res, 'Lấy token Microsoft Graph thất bại:'), res.status);
  const data = (await res.json()) as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new GraphError('Microsoft Graph không trả về access_token', 502);
  }
  return data.access_token;
}

const recipients = (list: string[]) => list.map(address => ({ emailAddress: { address } }));

/**
 * Gửi một thư. Thành công thì trả về, thất bại thì ném GraphError.
 *
 * Chỉ thử lại khi gặp 429: lúc đó Graph chắc chắn đã từ chối thư nên gửi lại
 * không thể thành hai thư. Lỗi mạng / hết thời gian / 5xx thì KHÔNG thử lại vì
 * thư có thể đã đi — bên gọi (agent) sẽ gửi nốt ở lần chạy sau.
 */
export async function sendMail(token: string, sender: string, msg: MailMessage, opts: SendOptions = {}): Promise<void> {
  // Giữ "@" nguyên dạng như api/send-email.ts (đã chạy thật), chỉ mã hoá ký tự
  // khác để biến môi trường gõ nhầm không làm hỏng đường dẫn.
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender).replace(/%40/g, '@')}/sendMail`;
  const payload = JSON.stringify({
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      toRecipients: recipients(msg.to),
      ...(msg.cc && msg.cc.length ? { ccRecipients: recipients(msg.cc) } : {}),
      ...(msg.replyTo && msg.replyTo.length ? { replyTo: recipients(msg.replyTo) } : {}),
    },
    saveToSentItems: msg.saveToSentItems ?? false,
  });

  const post = () =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  // Không đủ thời gian cho trọn một request thì không bắt đầu: thư chắc chắn
  // chưa đi, bên gọi gửi lại ở lần sau mà không sợ trùng.
  if (!fitsBefore(opts.deadlineAt)) {
    throw new GraphError('Hết thời gian xử lý của lần gọi này nên chưa gửi thư này', 0);
  }

  let res = await post();
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get('retry-after'));
    await res.text().catch(() => '');
    if (!fitsBefore(opts.deadlineAt, wait)) {
      throw new GraphError('Microsoft Graph báo quá tải (429), không còn đủ thời gian để thử lại', 429);
    }
    await sleep(wait);
    res = await post();
  }

  if (!res.ok) throw new GraphError(await describeFailure(res, 'Gửi email thất bại:'), res.status);
  // Graph trả 202 không có nội dung; đọc bỏ để giải phóng kết nối.
  await res.text().catch(() => '');
}
