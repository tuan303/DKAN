/**
 * Đọc tham số dòng lệnh và khối cấu hình `alerts` của agent.
 *
 * Tách khỏi sync-checkins.mjs để kiểm tra được bằng test: gõ sai tham số mà
 * script vẫn chạy (vd. --alerts-date mà quên --dry-run) là gửi email thật.
 * File thuần, không import Node hay Firebase.
 */

import { isIsoDate, HHMM_RE } from './common.mjs';
import { isSendableEmail } from './alert-plan.mjs';

/**
 * @typedef {object} CliArgs
 * @property {number | null} days       null = theo config
 * @property {boolean} dryRun
 * @property {boolean} debug
 * @property {boolean} quiet
 * @property {boolean} sendAlerts
 * @property {string | null} alertsDate
 * @property {string[]} errors
 */

/** Cờ không kèm giá trị. */
const BOOLEAN_FLAGS = ['--dry-run', '--debug', '--quiet', '--send-alerts'];
/** Cờ có thể kèm một giá trị ngay sau nó. */
const VALUE_FLAGS = ['--days', '--alerts-date'];
export const KNOWN_FLAGS = Object.freeze([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ today: string }} ctx  hôm nay theo giờ Việt Nam
 * @returns {CliArgs}
 */
export function parseArgs(argv, { today }) {
  const has = (/** @type {string} */ f) => argv.includes(f);
  const value = (/** @type {string} */ f) => {
    const i = argv.indexOf(f);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith('--') ? v : undefined;
  };

  // Từ chối mọi tham số lạ. Trước đây gõ nhầm "--dryrun" thì script lặng lẽ bỏ
  // qua và chạy THẬT: ghi lên hệ thống và gửi email cảnh báo cho cả trường.
  /** @type {string[]} */
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLEAN_FLAGS.includes(a)) continue;
    if (VALUE_FLAGS.includes(a)) {
      // Giá trị đi kèm (kể cả số âm như "-5") để phần kiểm tra bên dưới báo lỗi
      // cho đúng chỗ, không tính là tham số lạ.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    unknown.push(a);
  }

  /** @type {CliArgs} */
  const out = {
    days: null,
    dryRun: has('--dry-run'),
    debug: has('--debug'),
    // --quiet do dong-bo-cham-an.bat dùng (không dừng chờ bấm phím, ghi log ra
    // file); script không cần làm gì thêm, chỉ nhận cho khỏi báo lạ.
    quiet: has('--quiet'),
    sendAlerts: has('--send-alerts'),
    alertsDate: null,
    errors: [],
  };

  if (unknown.length) {
    out.errors.push(
      `Tham số không hợp lệ: ${unknown.map(a => `"${a}"`).join(', ')}. ` +
      `Chỉ nhận: ${KNOWN_FLAGS.join(', ')} (vd. --days 7, --alerts-date 2026-10-08).`
    );
  }

  if (has('--days')) {
    const raw = value('--days');
    // Như bản cũ: --days không kèm số thì dùng số ngày trong config.
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 400) out.errors.push(`Số ngày đồng bộ không hợp lệ: "${raw}" (cần số nguyên từ 1 tới 400).`);
      else out.days = n;
    }
  }

  if (has('--alerts-date')) {
    const raw = value('--alerts-date');
    if (!isIsoDate(raw)) {
      out.errors.push('--alerts-date cần một ngày dạng YYYY-MM-DD, ví dụ: --alerts-date 2026-10-08');
    } else if (!out.dryRun || !out.sendAlerts) {
      // Chỉ cho xem thử. Gửi thật cho một ngày cũ là gửi cảnh báo muộn, dựa
      // trên dữ liệu không còn kiểm chứng được — không bao giờ nên làm.
      out.errors.push('--alerts-date chỉ dùng để XEM THỬ, phải đi cùng cả --dry-run và --send-alerts.');
    } else if (/** @type {string} */ (raw) > today) {
      out.errors.push(`--alerts-date ${raw} là ngày trong tương lai.`);
    } else {
      out.alertsDate = /** @type {string} */ (raw);
    }
  }

  return out;
}

/** Giá trị mặc định của khối alerts, khớp config.example.json. */
export const ALERT_DEFAULTS = Object.freeze({
  enabled: false,
  endpoint: 'https://dkan.nshm.vn/api/meal-alerts',
  adminEmails: /** @type {string[]} */ ([]),
  notBefore: '13:40',
  minExpected: 20,
  maxMissingRatio: 0.4,
});

const MIN_SECRET_LENGTH = 32;

/**
 * Kiểm tra khối `alerts` trong config.json.
 *
 * Không bao giờ đưa giá trị secret vào thông báo lỗi: log của agent nằm trên
 * máy HAC, ai mở máy cũng đọc được.
 *
 * @param {any} raw  config.alerts
 */
export function readAlertsConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];

  const enabled = src.enabled === true;

  const endpoint = String(src.endpoint ?? ALERT_DEFAULTS.endpoint).trim();
  try {
    const u = new URL(endpoint);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    // Khoá bí mật đi kèm mỗi request: chỉ chấp nhận HTTPS (trừ thử trên máy dev).
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) errors.push('alerts.endpoint phải là địa chỉ https://');
  } catch {
    errors.push('alerts.endpoint không phải địa chỉ hợp lệ.');
  }

  const secret = typeof src.secret === 'string' ? src.secret.trim() : '';
  // Khoá đi trong header "Authorization: Bearer ...". Ký tự ngoài ASCII in được
  // (xuống dòng, tab, chữ có dấu, dấu cách) làm fetch ném lỗi "invalid header
  // value" kèm NGUYÊN khoá trong thông báo — lỗi đó sẽ vào log và vào
  // settings/checkinSync. Chặn từ đây, trước khi có request nào.
  const printable = /^[\x21-\x7e]+$/.test(secret);
  const secretOk = secret.length >= MIN_SECRET_LENGTH && !/^DIEN_/i.test(secret) && printable;
  const secretProblem = secretOk ? null
    : !secret ? 'alerts.secret đang trống.'
    : /^DIEN_/i.test(secret) ? 'alerts.secret vẫn là chữ mẫu, chưa điền khoá thật.'
    : !printable ? 'alerts.secret có ký tự không dùng được (dấu cách, xuống dòng, tab hoặc chữ có dấu). Chỉ dùng chữ, số và ký hiệu ASCII — khoá tạo bằng lệnh PowerShell trong README là hợp lệ.'
    : `alerts.secret quá ngắn (cần ít nhất ${MIN_SECRET_LENGTH} ký tự).`;

  const rawEmails = Array.isArray(src.adminEmails) ? src.adminEmails : ALERT_DEFAULTS.adminEmails;
  const adminEmails = [];
  for (const e of rawEmails) {
    const s = String(e ?? '').trim();
    if (isSendableEmail(s)) adminEmails.push(s);
    else warnings.push(`alerts.adminEmails: bỏ qua "${s}" (chỉ nhận email @hoangmaistarschool.edu.vn).`);
  }
  if (adminEmails.length > 5) warnings.push('alerts.adminEmails: chỉ dùng 5 địa chỉ đầu.');
  if (!adminEmails.length) warnings.push('alerts.adminEmails trống: khi chốt an toàn dừng gửi sẽ không có ai được báo.');

  const notBefore = String(src.notBefore ?? ALERT_DEFAULTS.notBefore).trim();
  if (!HHMM_RE.test(notBefore)) errors.push('alerts.notBefore phải dạng HH:MM, ví dụ "13:40".');

  const minExpected = Number(src.minExpected ?? ALERT_DEFAULTS.minExpected);
  if (!Number.isFinite(minExpected) || minExpected < 0) errors.push('alerts.minExpected phải là số không âm.');

  const maxMissingRatio = Number(src.maxMissingRatio ?? ALERT_DEFAULTS.maxMissingRatio);
  if (!Number.isFinite(maxMissingRatio) || maxMissingRatio <= 0 || maxMissingRatio > 1) {
    errors.push('alerts.maxMissingRatio phải lớn hơn 0 và không quá 1 (ví dụ 0.4 = 40%).');
  }

  return {
    cfg: { enabled, endpoint, secret, adminEmails: adminEmails.slice(0, 5), notBefore, minExpected, maxMissingRatio },
    secretOk,
    secretProblem,
    errors,
    warnings,
  };
}
