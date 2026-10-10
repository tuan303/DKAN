/**
 * POST /api/meal-alerts — email cảnh báo chấm ăn.
 *
 * Chỉ agent đồng bộ trên máy HAC gọi vào (sau giờ ăn trưa), có khoá bí mật
 * MEAL_ALERT_SECRET. Hai loại thư:
 *   - 'staff-missing': mỗi CBNV đã đăng ký mà không có lượt chấm nhận 1 thư riêng.
 *   - 'admin-notice' : báo quản trị khi agent tự dừng gửi vì số liệu bất thường.
 *
 * Endpoint KHÔNG nhận HTML hay tiêu đề từ bên gọi: chỉ nhận dữ liệu đã kiểm tra
 * chặt rồi tự dựng thư bằng mẫu cố định ở đây (khác với /api/send-email hiện là
 * open relay). Khoá nằm trong agent/config.json trên máy HAC nên phải tính tới
 * chuyện khoá bị lộ. Khi đó kẻ có khoá vẫn bị giới hạn:
 *   - chỉ gửi được tới địa chỉ @hoangmaistarschool.edu.vn; thư báo quản trị chỉ
 *     tới danh sách MEAL_ALERT_ADMINS đặt trên Vercel, không tới ai tuỳ ý;
 *   - thư CBNV luôn CC MEAL_ALERT_CC (mặc định dinhduong@), dùng sai là lộ ngay;
 *   - chữ từ bên gọi chỉ là vài trường ngắn, bị escape HTML và bẻ gãy dạng link
 *     (https://, www.) nên không thành link bấm được trong thư;
 *   - mỗi lần gọi tối đa 20 thư.
 * Nhưng endpoint không giữ trạng thái giữa các lần gọi nên KHÔNG chặn được việc
 * gọi lặp: kẻ có khoá vẫn gửi được nhiều thư mang chữ ngắn tuỳ ý trong trường và
 * có thể làm hộp thư gửi chạm hạn mức của Exchange. Nghi lộ khoá thì đổi ngay
 * MEAL_ALERT_SECRET ở cả Vercel lẫn config.json.
 *
 * Chạy được cả trên Vercel (req.body đã được parse) lẫn Express trong server.ts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { formatDate } from '../agent/lib/meal-rules.mjs';
// Đuôi .js là bắt buộc: package.json đặt "type": "module" nên trên Vercel file
// này chạy dạng ESM, mà ESM của Node không tự thêm đuôi cho đường dẫn tương đối.
import { getGraphToken, readGraphConfig, sendMail, type MailMessage } from './_lib/msgraph.js';

// Vercel: cho function chạy tối đa 60 giây (đủ cho 20 thư kể cả khi phải chờ 429).
export const config = { maxDuration: 60 };

// ------------------------------------------------------------------ hằng số

const SCHOOL_EMAIL = /^[^@\s]+@hoangmaistarschool\.edu\.vn$/i;
// Hộp thư Microsoft 365 của trường chỉ dùng ký tự ASCII in được; chặn thêm để
// không lọt ký tự điều khiển hay ký tự lạ vào trường địa chỉ của Graph.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const WINDOW_RE = /^\d{2}:\d{2}–\d{2}:\d{2}$/; // dấu gạch ngang dài U+2013, đúng như agent gửi
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Khoá đi trong header HTTP: ký tự ngoài ASCII thì fetch của agent không gửi
// được, nên khoá như vậy coi như cấu hình sai thay vì để báo 401 "không khớp" mãi.
// Không cho dấu cách: agent (lib/cli.mjs) cũng từ chối khoá có dấu cách, hai
// bên phải cùng một quy tắc — lệch nhau thì khoá "hợp lệ" ở đây mà agent không
// bao giờ gửi, cảnh báo tắt lặng lẽ.
const SECRET_CHARS = /^[\x21-\x7e]+$/;

const MIN_SECRET_LENGTH = 32;
const MAX_ALERTS = 20;
const MAX_ADMIN_TO = 5;
const MAX_OUT_OF_WINDOW = 10;
const MAX_LINES = 30;
const LIMITS = { email: 254, fullName: 120, employeeId: 40, dateLabel: 60, label: 40, reason: 1000, line: 300 };

// Microsoft Graph giới hạn số thư đồng thời của một hộp thư; 4 là mức an toàn.
const CONCURRENCY = 4;

// Ngân sách thời gian, tính từ lúc VÀO handler (trước cả khi lấy token, việc
// này cũng có thể mất tới 10 giây): mọi request tới Graph, kể cả lần thử lại
// sau 429 và tính cả hạn chờ 10 giây của chính nó, phải xong trước mốc này.
// 10 giây còn lại dưới maxDuration dành cho khởi động lạnh và trả kết quả.
// Trả kết quả kịp thời quan trọng hơn gửi hết: nếu Vercel cắt ngang, agent nhận
// 504 cho cả lô, coi mọi thư là chưa gửi và lần sau gửi trùng cho người đã nhận.
// Còn thư bị bỏ vì hết giờ thì chắc chắn chưa đi, lần chạy sau gửi nốt.
const SEND_DEADLINE_MS = 50_000;

const DEFAULT_CC = 'dinhduong@hoangmaistarschool.edu.vn';
const DEFAULT_APP_URL = 'https://dkan.nshm.vn';

// ------------------------------------------------------------------ kiểu

type Meal = 'breakfast' | 'lunch';

interface StaffAlert {
  to: string;
  fullName: string;
  employeeId: string;
  meals: { meal: Meal; label: string; window: string }[];
  outOfWindow: string[];
}

type ParsedRequest =
  | { kind: 'staff-missing'; date: string; dateLabel: string; alerts: StaffAlert[] }
  | { kind: 'admin-notice'; date: string; dateLabel: string; to: string[]; reason: string; lines: string[] };

/** Đủ dùng cho cả VercelRequest lẫn express.Request. */
interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** Đủ dùng cho cả VercelResponse lẫn express.Response. */
interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): unknown;
  setHeader?(name: string, value: string): unknown;
}

interface SendResult {
  to: string;
  ok: boolean;
  error?: string;
}

// ------------------------------------------------------------------ xác thực

/**
 * So khoá theo thời gian hằng số. Băm SHA-256 cả hai phía để hai buffer luôn
 * cùng độ dài: timingSafeEqual ném lỗi khi độ dài khác, còn tự so độ dài trước
 * thì lộ độ dài khoá qua thời gian phản hồi. Khoá khác độ dài vẫn bị từ chối vì
 * bản băm khác nhau.
 *
 * Lấy NGUYÊN phần sau "Bearer " (chỉ bỏ khoảng trắng hai đầu, như agent và biến
 * môi trường đều trim). Khoá hợp lệ không có dấu cách (SECRET_CHARS), nên khoá
 * gửi lên có dấu cách giữa chừng chắc chắn không khớp.
 */
function isAuthorized(header: string | string[] | undefined, secret: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer[ \t]+(.+?)[ \t]*$/i.exec(value ?? '');
  if (!m) return false;
  const given = createHash('sha256').update(m[1], 'utf8').digest();
  const expected = createHash('sha256').update(secret, 'utf8').digest();
  return timingSafeEqual(given, expected);
}

// ------------------------------------------------------------------ kiểm tra dữ liệu

class BadRequest extends Error {}

function fail(message: string): never {
  throw new BadRequest(message);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown, field: string, max: number, opts: { min?: number; multiline?: boolean } = {}): string {
  const { min = 1, multiline = false } = opts;
  if (typeof v !== 'string') fail(`${field} phải là chuỗi.`);
  const s = v.trim();
  if (s.length < min) fail(`${field} không được để trống.`);
  if (s.length > max) fail(`${field} dài quá ${max} ký tự.`);
  if ((multiline ? CONTROL_CHARS_EXCEPT_NEWLINE : CONTROL_CHARS).test(s)) fail(`${field} chứa ký tự điều khiển.`);
  return s;
}

function schoolEmail(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length > LIMITS.email || !SCHOOL_EMAIL.test(v) || !PRINTABLE_ASCII.test(v)) {
    fail(`${field} phải là địa chỉ @hoangmaistarschool.edu.vn.`);
  }
  return v;
}

function isoDate(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) fail(`${field} phải có dạng YYYY-MM-DD.`);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) fail(`${field} không phải ngày có thật.`);
  return v;
}

const validClock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h < 24 && m < 60;
};

function clock(v: unknown, field: string): string {
  if (typeof v !== 'string' || !TIME_RE.test(v) || !validClock(v)) fail(`${field} phải có dạng HH:MM.`);
  return v;
}

function mealWindow(v: unknown, field: string): string {
  if (typeof v !== 'string' || !WINDOW_RE.test(v) || !v.split('–').every(validClock)) {
    fail(`${field} phải có dạng HH:MM–HH:MM.`);
  }
  return v;
}

function list(v: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) fail(`${field} phải là mảng.`);
  if (v.length < min || v.length > max) fail(`${field} phải có từ ${min} đến ${max} phần tử.`);
  return v;
}

/** Hai phần tử trùng nhau thì người nhận sẽ nhận 2 thư — đó là lỗi phía gọi, từ chối cả lô. */
function assertUniqueEmails(emails: string[], field: string) {
  const seen = new Set<string>();
  for (const e of emails) {
    const k = e.toLowerCase();
    if (seen.has(k)) fail(`${field}: địa chỉ ${e} bị lặp.`);
    seen.add(k);
  }
}

function parseStaffAlert(v: unknown, i: number): StaffAlert {
  const f = `alerts[${i}]`;
  if (!isObject(v)) fail(`${f} phải là object.`);
  const to = schoolEmail(v.to, `${f}.to`);
  // Họ tên có thể trống ở dữ liệu cũ; khi đó thư chỉ ghi "Thầy/Cô" thay vì từ chối cả lô.
  const fullName = text(v.fullName, `${f}.fullName`, LIMITS.fullName, { min: 0 });
  const employeeId = text(v.employeeId, `${f}.employeeId`, LIMITS.employeeId);

  const meals = list(v.meals, `${f}.meals`, 1, 2).map((m, j) => {
    const mf = `${f}.meals[${j}]`;
    if (!isObject(m)) fail(`${mf} phải là object.`);
    if (m.meal !== 'breakfast' && m.meal !== 'lunch') fail(`${mf}.meal phải là 'breakfast' hoặc 'lunch'.`);
    return { meal: m.meal as Meal, label: text(m.label, `${mf}.label`, LIMITS.label), window: mealWindow(m.window, `${mf}.window`) };
  });
  if (meals.length === 2 && meals[0].meal === meals[1].meal) fail(`${f}.meals bị lặp bữa.`);

  const outOfWindow =
    v.outOfWindow === undefined
      ? []
      : list(v.outOfWindow, `${f}.outOfWindow`, 0, MAX_OUT_OF_WINDOW).map((t, j) => clock(t, `${f}.outOfWindow[${j}]`));

  return { to, fullName, employeeId, meals, outOfWindow };
}

function parseBody(raw: unknown): unknown {
  // Vercel chỉ tự parse khi Content-Type là JSON; gọi thiếu header thì nhận chuỗi/Buffer.
  let v = raw;
  if (v instanceof Uint8Array) v = Buffer.from(v).toString('utf8');
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      fail('Nội dung yêu cầu không phải JSON hợp lệ.');
    }
  }
  return v;
}

function parseRequest(raw: unknown): ParsedRequest {
  const body = parseBody(raw);
  if (!isObject(body)) fail('Nội dung yêu cầu phải là một JSON object.');
  if (body.kind !== 'staff-missing' && body.kind !== 'admin-notice') {
    fail("kind phải là 'staff-missing' hoặc 'admin-notice'.");
  }
  const date = isoDate(body.date, 'date');
  const dateLabel = text(body.dateLabel, 'dateLabel', LIMITS.dateLabel);

  if (body.kind === 'staff-missing') {
    const alerts = list(body.alerts, 'alerts', 1, MAX_ALERTS).map(parseStaffAlert);
    assertUniqueEmails(alerts.map(a => a.to), 'alerts');
    return { kind: 'staff-missing', date, dateLabel, alerts };
  }

  const to = list(body.to, 'to', 1, MAX_ADMIN_TO).map((e, i) => schoolEmail(e, `to[${i}]`));
  assertUniqueEmails(to, 'to');
  const reason = text(body.reason, 'reason', LIMITS.reason, { multiline: true });
  const lines =
    body.lines === undefined
      ? []
      : list(body.lines, 'lines', 0, MAX_LINES).map((l, i) => text(l, `lines[${i}]`, LIMITS.line, { min: 0 }));
  return { kind: 'admin-notice', date, dateLabel, to, reason, lines };
}

// ------------------------------------------------------------------ cấu hình gửi

/** Biến môi trường đặt sai: trả 500 nêu rõ biến nào, không gửi thư nào. */
class Misconfigured extends Error {}

/**
 * Danh sách địa chỉ trong một biến môi trường (cách nhau bằng dấu phẩy hoặc
 * chấm phẩy), kiểm tra y như địa chỉ bên gọi gửi lên. Phải kiểm ở đây vì Graph
 * từ chối CẢ thư khi một người nhận sai: chỉ một lỗi gõ trong MEAL_ALERT_CC sẽ
 * làm mọi thư hỏng mà lỗi lại hiện như thể địa chỉ của CBNV sai, agent thử lại
 * suốt buổi chiều vô ích. Báo lỗi cấu hình ngay thì quản trị biết sửa chỗ nào.
 */
function envAddresses(name: string, raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;]/)) {
    const s = part.trim();
    if (!s) continue;
    if (s.length > LIMITS.email || !SCHOOL_EMAIL.test(s) || !PRINTABLE_ASCII.test(s)) {
      throw new Misconfigured(`Máy chủ cấu hình sai ${name}: "${s.slice(0, 80)}" không phải địa chỉ @hoangmaistarschool.edu.vn.`);
    }
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/**
 * CC và người nhận thư trả lời (khiếu nại). Không đặt MEAL_ALERT_CC → mặc định
 * dinhduong@; đặt chuỗi rỗng (hoặc "none", phòng khi giao diện Vercel không cho
 * lưu giá trị rỗng) → không CC, thư trả lời về hộp thư gửi.
 */
function mailSettings(sender: string) {
  const raw = process.env.MEAL_ALERT_CC;
  const cc =
    raw === undefined ? [DEFAULT_CC] : raw.trim().toLowerCase() === 'none' ? [] : envAddresses('MEAL_ALERT_CC', raw);
  return { cc, replyTo: cc.length ? cc : [sender], appUrl: appBaseUrl() };
}

/**
 * Ai được nhận thư báo quản trị. Danh sách nằm ở máy chủ chứ không tin
 * alerts.adminEmails do agent gửi lên: nếu tin thì kẻ có khoá gửi được thư mang
 * tiêu đề hệ thống, nội dung tuỳ ý, tới bất kỳ ai trong trường. Không đặt
 * MEAL_ALERT_ADMINS → chỉ hộp thư CC (dinhduong@) và hộp thư gửi.
 */
function adminAllowlist(cc: string[], sender: string): Set<string> {
  const raw = (process.env.MEAL_ALERT_ADMINS ?? '').trim();
  const list = raw ? envAddresses('MEAL_ALERT_ADMINS', raw) : [...cc, sender];
  return new Set(list.map(e => e.toLowerCase()));
}

function appBaseUrl(): string {
  const raw = (process.env.PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_APP_URL;
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(raw)) {
    console.warn(`[meal-alerts] PUBLIC_APP_URL không hợp lệ, dùng mặc định ${DEFAULT_APP_URL}`);
    return DEFAULT_APP_URL;
  }
  return raw;
}

// ------------------------------------------------------------------ mẫu thư

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape HTML — dùng cho chữ và thuộc tính do chính máy chủ dựng (link nút bấm...). */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ESCAPES[c]);

/**
 * Mọi chữ đến từ bên gọi đều phải đi qua đây trước khi vào HTML: escape rồi bẻ
 * gãy dạng link ("https://" → "https[:]//", "www." → "www[.]") để Outlook,
 * Gmail, Apple Mail không tự biến thành link bấm được. Dữ liệu thật (họ tên, mã
 * NV, nhãn bữa, lý do agent ghi) không bao giờ cần link; còn khi khoá bị lộ thì
 * đây là cách chèn link lừa đảo vào thư gửi từ hộp thư tin cậy dinhduong@.
 */
const txt = (s: string) =>
  esc(s)
    .replace(/:\/\//g, '[:]//')
    .replace(/\b(www)\./gi, '$1[.]');

const NAVY = '#12264a';
const RED = '#d21235';
const INK = '#1f2937';
const MUTED = '#5b6474';
const PAGE_BG = '#f3f5f9';
const LINE = '#dde3ee';
const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

const para = (html: string, size = 15, color = INK) =>
  `<p style="margin:0;font-family:${FONT};font-size:${size}px;line-height:${Math.round(size * 1.55)}px;color:${color};">${html}</p>`;

/** Mỗi khối là một hàng bảng có padding: Outlook bỏ qua margin của bảng nhưng tôn trọng padding của ô. */
const row = (inner: string, padding = '0 28px 18px') => `<tr><td class="px" style="padding:${padding};">${inner}</td></tr>`;

/**
 * Nút bấm "chống vỡ": Outlook desktop (bộ dựng Word) không hiểu padding của thẻ
 * <a> nên dùng VML; các ứng dụng khác dùng thẻ <a> thường.
 */
function button(href: string, label: string): string {
  const h = esc(href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="left">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${h}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="14%" stroke="f" fillcolor="${RED}">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${esc(label)}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${h}" target="_blank" style="background-color:${RED};border-radius:6px;color:#ffffff;display:inline-block;font-family:${FONT};font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;-webkit-text-size-adjust:none;">${esc(label)}</a>
<!--<![endif]-->
</td></tr></table>`;
}

/** Link dạng chữ thường dưới nút, cho ứng dụng thư chặn nút hoặc khi cần sao chép. */
const fallbackLink = (href: string) =>
  para(
    `Nếu nút trên không mở được, Thầy/Cô bấm hoặc sao chép đường dẫn sau: <a href="${esc(href)}" target="_blank" style="color:${NAVY};text-decoration:underline;word-break:break-all;">${esc(href)}</a>`,
    13,
    MUTED,
  );

/**
 * Khung chung của mọi thư: nền xám, thẻ trắng rộng tối đa 600px, dải tiêu đề navy viền đỏ.
 * `preheader` và `subheading` có chứa chữ của bên gọi (dateLabel) nên đi qua txt().
 */
function layout(o: { title: string; preheader: string; heading: string; subheading: string; rows: string[] }): string {
  return `<!DOCTYPE html>
<html lang="vi" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>${esc(o.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  @media only screen and (max-width: 480px) {
    .px { padding-left: 18px !important; padding-right: 18px !important; }
    .outer { padding: 12px 6px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE_BG};opacity:0;">${txt(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">
<tr><td class="outer" align="center" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid ${LINE};border-collapse:separate;">
<tr><td class="px" bgcolor="${NAVY}" style="background-color:${NAVY};border-top:4px solid ${RED};padding:18px 28px;">
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;letter-spacing:1px;color:#c9d3e6;text-transform:uppercase;">Hệ thống đăng ký suất ăn</p>
<p style="margin:2px 0 0;font-family:${FONT};font-size:18px;line-height:26px;font-weight:bold;color:#ffffff;">Trường Ngôi Sao Hoàng Mai</p>
</td></tr>
<tr><td class="px" style="padding:26px 28px 18px;">
<p style="margin:0;font-family:${FONT};font-size:21px;line-height:28px;font-weight:bold;color:${NAVY};">${esc(o.heading)}</p>
<p style="margin:4px 0 0;font-family:${FONT};font-size:14px;line-height:20px;color:${MUTED};">${txt(o.subheading)}</p>
</td></tr>
${o.rows.join('\n')}
<tr><td class="px" style="padding:16px 28px;border-top:1px solid ${LINE};background-color:#fafbfd;">
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">Email tự động từ Hệ thống đăng ký suất ăn — Trường Ngôi Sao Hoàng Mai.</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

function renderStaffEmail(a: StaffAlert, date: string, dateLabel: string, appUrl: string): { subject: string; html: string } {
  const subject = `[DKAN] Chưa ghi nhận chấm ăn ngày ${formatDate(date)}`;
  const historyUrl = `${appUrl}/cham-an`;
  // Dữ liệu cũ có thể thiếu họ tên: khi đó chỉ chào "Thầy/Cô", không để lại thẻ <strong> rỗng.
  const greetingName = a.fullName ? ` <strong>${txt(a.fullName)}</strong>` : '';

  const mealRows = a.meals
    .map(
      (m, i) => `<tr><td style="padding:${i ? '8px' : '0'} 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-left:4px solid ${RED};background-color:#fdf2f4;padding:10px 14px;font-family:${FONT};font-size:15px;line-height:22px;color:${NAVY};"><strong>${txt(m.label)}</strong> &nbsp;·&nbsp; khung giờ ${txt(m.window)}</td>
</tr></table></td></tr>`,
    )
    .join('');

  const rows = [
    row(para(`Kính gửi Thầy/Cô${greetingName} (Mã NV ${txt(a.employeeId)}),`)),
    row(para(`Hệ thống ghi nhận Thầy/Cô đã đăng ký suất ăn ngày <strong>${txt(dateLabel)}</strong> nhưng máy nhận diện không ghi nhận lượt chấm cho:`), '0 28px 12px'),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${mealRows}</table>`),
  ];
  if (a.outOfWindow.length) {
    const times = a.outOfWindow.map(t => `<strong>${txt(t)}</strong>`).join(', ');
    rows.push(row(para(`Máy có ghi nhận lượt chấm lúc ${times}, nằm ngoài khung giờ nên không được tính.`)));
  }
  rows.push(
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border:1px solid #f3c4cd;background-color:#fff7f8;padding:12px 16px;">${para(
      'Theo quy định của Nhà trường, đăng ký suất ăn nhưng không chấm ăn là vi phạm quy định chấm ăn; Thầy/Cô có thể bị tạm dừng đăng ký suất ăn tháng tiếp theo.',
      14,
    )}</td></tr></table>`),
    row(button(historyUrl, 'Xem lịch sử chấm ăn'), '4px 28px 10px'),
    row(fallbackLink(historyUrl)),
    row(para('Nếu Thầy/Cô đã ăn nhưng máy không ghi nhận, vui lòng trả lời email này hoặc liên hệ Bộ phận Dinh dưỡng trong ngày để được kiểm tra.')),
    row(para('Trân trọng.'), '0 28px 24px'),
  );

  const html = layout({
    title: subject,
    preheader: `Thầy/Cô đã đăng ký suất ăn ngày ${dateLabel} nhưng máy nhận diện chưa ghi nhận lượt chấm.`,
    heading: 'Chưa ghi nhận chấm ăn',
    subheading: dateLabel,
    rows,
  });
  return { subject, html };
}

function renderAdminEmail(r: Extract<ParsedRequest, { kind: 'admin-notice' }>, appUrl: string): { subject: string; html: string } {
  const subject = `[DKAN] Tạm dừng gửi cảnh báo chấm ăn ngày ${formatDate(r.date)}`;
  const adminUrl = `${appUrl}/quantri`;
  const reasonHtml = txt(r.reason).replace(/\r?\n/g, '<br>');

  const rows = [
    row(para('Kính gửi Thầy/Cô,')),
    row(
      para(
        `Hệ thống đã tạm dừng gửi email cảnh báo chấm ăn ngày <strong>${txt(r.dateLabel)}</strong> vì số liệu có dấu hiệu bất thường, để tránh gửi cảnh báo nhầm tới CBNV.`,
      ),
    ),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-left:4px solid ${NAVY};background-color:#f1f4f9;padding:12px 16px;">${para(`<strong>Lý do:</strong> ${reasonHtml}`)}</td></tr></table>`),
  ];
  if (r.lines.length) {
    const items = r.lines
      .map(
        l => `<tr><td valign="top" style="padding:0 8px 6px 0;font-family:${FONT};font-size:14px;line-height:21px;color:${MUTED};">•</td>
<td style="padding:0 0 6px;font-family:${FONT};font-size:14px;line-height:21px;color:${INK};">${txt(l) || '&nbsp;'}</td></tr>`,
      )
      .join('');
    rows.push(
      row(para('<strong>Chi tiết:</strong>'), '0 28px 8px'),
      row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>`, '0 28px 12px'),
    );
  }
  rows.push(
    row(para('Đề nghị Thầy/Cô kiểm tra tình trạng máy nhận diện và đối chiếu số liệu ở trang Quản trị (tab Đối soát chấm ăn).')),
    row(button(adminUrl, 'Mở trang quản trị'), '4px 28px 10px'),
    row(fallbackLink(adminUrl)),
    row(para('Trân trọng.'), '0 28px 24px'),
  );

  const html = layout({
    title: subject,
    preheader: `Chốt an toàn đã dừng gửi email cảnh báo chấm ăn ngày ${r.dateLabel}.`,
    heading: 'Tạm dừng gửi cảnh báo chấm ăn',
    subheading: r.dateLabel,
    rows,
  });
  return { subject, html };
}

// ------------------------------------------------------------------ gửi

/** Chạy tối đa `limit` việc cùng lúc, kết quả giữ đúng thứ tự đầu vào. `fn` không được ném lỗi. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  // Mốc ngân sách thời gian lấy ngay khi vào, trước mọi việc có thể chậm (xem SEND_DEADLINE_MS).
  const deadlineAt = Date.now() + SEND_DEADLINE_MS;

  if (req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST');
    res.status(405).json({ error: 'Chỉ chấp nhận phương thức POST.' });
    return;
  }

  // Thiếu khoá hoặc khoá quá ngắn thì luôn từ chối: không bao giờ chạy ở chế độ "không cần khoá".
  const secret = (process.env.MEAL_ALERT_SECRET ?? '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    console.error('[meal-alerts] MEAL_ALERT_SECRET chưa cấu hình hoặc ngắn hơn 32 ký tự.');
    res.status(500).json({ error: 'Máy chủ chưa cấu hình MEAL_ALERT_SECRET (tối thiểu 32 ký tự).' });
    return;
  }
  if (!SECRET_CHARS.test(secret)) {
    console.error('[meal-alerts] MEAL_ALERT_SECRET có ký tự ngoài ASCII hoặc ký tự điều khiển.');
    res.status(500).json({
      error: 'Máy chủ cấu hình sai MEAL_ALERT_SECRET: chỉ được dùng chữ không dấu, chữ số và ký hiệu ASCII, không dấu cách (nên dùng dãy hex ngẫu nhiên).',
    });
    return;
  }
  if (!isAuthorized(req.headers.authorization, secret)) {
    res.status(401).json({ error: 'Sai hoặc thiếu khoá xác thực.' });
    return;
  }

  let request: ParsedRequest;
  try {
    // Trên Vercel, req.body là getter parse lười: JSON hỏng thì chính lần đọc này
    // ném lỗi. Đổi thành 400 để bên gọi biết lỗi ở dữ liệu, không phải ở máy chủ.
    let raw: unknown;
    try {
      raw = req.body;
    } catch {
      fail('Nội dung yêu cầu không phải JSON hợp lệ.');
    }
    request = parseRequest(raw);
  } catch (e) {
    if (e instanceof BadRequest) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }

  const graph = readGraphConfig();
  if (!graph) {
    console.error('[meal-alerts] Thiếu MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET / MS_GRAPH_SENDER.');
    res.status(500).json({ error: 'Máy chủ chưa cấu hình dịch vụ email (MS_GRAPH_*).' });
    return;
  }

  // Mỗi phần tử: một thư cần gửi, hoặc lý do không gửi — giữ đúng thứ tự đầu vào.
  type Job = { to: string; mail: MailMessage } | { to: string; refused: string };
  let jobs: Job[];
  try {
    const { cc, replyTo, appUrl } = mailSettings(graph.sender);
    if (request.kind === 'staff-missing') {
      jobs = request.alerts.map(a => {
        const { subject, html } = renderStaffEmail(a, request.date, request.dateLabel, appUrl);
        // Mỗi người một thư riêng: không để CBNV thấy địa chỉ của nhau.
        return { to: a.to, mail: { to: [a.to], cc, replyTo, subject, html, saveToSentItems: false } };
      });
    } else {
      // Địa chỉ ngoài danh sách chỉ bị bỏ riêng (ok:false), không làm hỏng cả lô:
      // quản trị chính vẫn nhận được thư báo dù agent khai thêm người chưa có trên máy chủ.
      const allowed = adminAllowlist(cc, graph.sender);
      const { subject, html } = renderAdminEmail(request, appUrl);
      // Thư báo quản trị không CC: danh sách quản trị đã gồm hộp thư cần biết.
      jobs = request.to.map(to =>
        allowed.has(to.toLowerCase())
          ? { to, mail: { to: [to], replyTo, subject, html, saveToSentItems: false } }
          : { to, refused: 'Địa chỉ không có trong danh sách quản trị MEAL_ALERT_ADMINS trên máy chủ nên không gửi.' },
      );
    }
  } catch (e) {
    if (e instanceof Misconfigured) {
      console.error(`[meal-alerts] ${e.message}`);
      res.status(500).json({ error: e.message });
      return;
    }
    throw e;
  }
  for (const j of jobs) if ('refused' in j) console.warn(`[meal-alerts] Bỏ ${j.to}: ${j.refused}`);

  // Không có thư nào được phép gửi thì khỏi lấy token.
  let token = '';
  if (jobs.some(j => 'mail' in j)) {
    try {
      token = await getGraphToken(graph);
    } catch (e) {
      const error = errorMessage(e);
      console.error(`[meal-alerts] ${error}`);
      res.status(502).json({ error, results: jobs.map(j => ({ to: j.to, ok: false, error: 'refused' in j ? j.refused : error })) });
      return;
    }
  }

  const results = await mapPool(jobs, CONCURRENCY, async (job): Promise<SendResult> => {
    if ('refused' in job) return { to: job.to, ok: false, error: job.refused };
    try {
      // sendMail tự từ chối bắt đầu / thử lại khi không còn đủ thời gian trước deadlineAt.
      await sendMail(token, graph.sender, job.mail, { deadlineAt });
      return { to: job.to, ok: true };
    } catch (e) {
      const error = errorMessage(e);
      console.error(`[meal-alerts] Gửi tới ${job.to} lỗi: ${error}`);
      return { to: job.to, ok: false, error };
    }
  });

  const sent = results.filter(r => r.ok).length;
  console.log(`[meal-alerts] ${request.kind} ${request.date}: gửi được ${sent}/${results.length} thư.`);
  res.status(200).json({ results });
}
