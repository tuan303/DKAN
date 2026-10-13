/**
 * Phần thuần của việc gửi email mời khảo sát chất lượng suất ăn hằng tuần
 * (agent/survey-invite.mjs): chọn tuần, cổng giờ 15:00 thứ 6 (kể cả gửi bù),
 * phần ghi để mở khảo sát, chọn người nhận, chia lô, quyền gửi (lease), vòng
 * gửi từng lô (sendInvitations), phân loại kết quả gửi, trạng thái cuối.
 *
 * Tách khỏi script để kiểm tra bằng node:test: lỗi ở đây là gửi trùng cho cả
 * trường, hoặc mở khảo sát cho một tuần nghỉ — không thử trên dữ liệu thật
 * được.
 *
 * Câu hỏi, cách tính tuần và hạn trả lời KHÔNG nằm ở đây mà ở lib/survey.mjs
 * (dùng chung với trang web). File thuần, không import Node hay Firebase.
 */

import { vnParts, formatVnDateTime } from './meal-rules.mjs';
import { chunk, clip, oneLine, isIsoDate, redact } from './common.mjs';
import { isSendableEmail } from './alert-plan.mjs';
import { readAlertsConfig } from './cli.mjs';
import {
  SURVEY_VERSION, surveyWeek, isWeekId, weekStartOf, shiftDate, surveyDefaultOpensAt, surveyClosesAt,
  surveyWeekLabel, weekHasMeals, toMillis,
} from './survey.mjs';

/**
 * Số người Bcc tối đa trong MỘT thư — endpoint nhận 1..400. Exchange Online
 * cho tối đa 500 người nhận mỗi thư (To + Cc + Bcc); 400 còn dư chỗ cho hộp
 * thư To/Reply-To. Trường ~300 CBGV-NV nên thường chỉ một lô.
 */
export const SURVEY_BATCH_SIZE = 400;

// ------------------------------------------------------------- tham số

const BOOLEAN_FLAGS = ['--dry-run', '--force', '--quiet'];
const VALUE_FLAGS = ['--week'];
export const SURVEY_FLAGS = Object.freeze([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

/**
 * @typedef {object} SurveyArgs
 * @property {boolean} dryRun
 * @property {boolean} force
 * @property {boolean} quiet
 * @property {string | null} week   null = tuần mặc định (defaultSurveyWeekId)
 * @property {string[]} errors
 */

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ today: string }} ctx  hôm nay theo giờ Việt Nam
 * @returns {SurveyArgs}
 */
export function parseSurveyArgs(argv, { today }) {
  /** @type {string[]} */ const unknown = [];
  let weekGiven = false;
  /** @type {string | undefined} */ let weekRaw;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLEAN_FLAGS.includes(a)) continue;
    if (a === '--week') {
      weekGiven = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { weekRaw = next; i++; }
      continue;
    }
    unknown.push(a);
  }

  /** @type {SurveyArgs} */
  const out = {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    // --quiet do khao-sat-bua-an.bat dùng (ghi log ra file, không chờ bấm
    // phím); script không làm gì thêm, chỉ nhận cho khỏi báo lạ.
    quiet: argv.includes('--quiet'),
    week: null,
    errors: [],
  };

  // Gõ nhầm tham số (vd. "--dryrun") mà script vẫn chạy là gửi thật cho cả
  // trường — như sync-checkins.mjs, từ chối mọi tham số lạ.
  if (unknown.length) {
    out.errors.push(
      `Tham số không hợp lệ: ${unknown.map(a => `"${a}"`).join(', ')}. ` +
      `Chỉ nhận: ${SURVEY_FLAGS.join(', ')} (vd. --dry-run, --week 2026-10-05).`
    );
  }

  if (weekGiven) {
    if (!isIsoDate(weekRaw)) {
      out.errors.push('--week cần ngày thứ 2 của tuần, dạng YYYY-MM-DD, ví dụ: --week 2026-10-05');
    } else if (!isWeekId(weekRaw)) {
      out.errors.push(`--week ${weekRaw} không phải thứ 2. Thứ 2 của tuần đó là ${weekStartOf(/** @type {string} */ (weekRaw))}.`);
    } else if (/** @type {string} */ (weekRaw) > weekStartOf(today)) {
      // Mở khảo sát cho tuần chưa ăn (kể cả với --force) thì câu trả lời vô nghĩa.
      out.errors.push(`--week ${weekRaw} là tuần trong tương lai.`);
    } else {
      out.week = /** @type {string} */ (weekRaw);
    }
  }
  return out;
}

// ------------------------------------------------------------- cấu hình

/**
 * Đọc cấu hình cho việc gửi lời mời: khối `survey` (chỉ có `enabled`) và
 * `alerts.endpoint` + `alerts.secret` dùng chung với email cảnh báo — một khoá,
 * một endpoint, không thêm gì phải giữ bí mật.
 *
 * Không bao giờ đưa giá trị khoá vào thông báo (readAlertsConfig cũng vậy).
 *
 * @param {any} config  nội dung config.json
 */
export function readSurveyConfig(config) {
  const src = config && typeof config === 'object' ? config : {};
  const survey = src.survey && typeof src.survey === 'object' ? src.survey : null;
  // Chỉ đúng `true` mới là bật — "true" dạng chuỗi không tính, như alerts.
  const enabled = survey?.enabled === true;
  const disabledReason = enabled ? null
    : !survey ? 'config.json chưa có khối "survey" (thêm "survey": { "enabled": true } để bật gửi lời mời khảo sát)'
    : 'survey.enabled đang tắt trong config.json';

  /** @type {string[]} */ const problems = [];
  let cfg = { endpoint: '', secret: '' };
  const alerts = src.alerts && typeof src.alerts === 'object' ? src.alerts : null;
  if (!alerts) {
    problems.push('config.json chưa có khối "alerts" — lời mời khảo sát dùng chung alerts.endpoint và alerts.secret với email cảnh báo.');
  } else {
    const a = readAlertsConfig(alerts);
    // readAlertsConfig tự lấy địa chỉ mặc định khi thiếu endpoint; ở đây đòi
    // khai rõ, vì đây là nơi gửi khoá bí mật tới.
    if (typeof alerts.endpoint !== 'string' || !alerts.endpoint.trim()) problems.push('alerts.endpoint đang trống.');
    else problems.push(...a.errors.filter(e => e.startsWith('alerts.endpoint')));
    if (!a.secretOk && a.secretProblem) problems.push(a.secretProblem);
    cfg = { endpoint: a.cfg.endpoint, secret: a.cfg.secret };
  }
  return { enabled, disabledReason, cfg, problems };
}

// ------------------------------------------------------------- tuần, cổng giờ

/**
 * Tuần mặc định khi không có --week: tuần chứa hôm nay (giờ VN) — trừ sáng thứ
 * 2 trước 12:00, khi khảo sát của tuần TRƯỚC còn mở. Máy HAC tắt suốt chiều
 * thứ 6 thì Task Scheduler ("chạy bù khi lỡ giờ") chạy lại lúc bật máy sáng
 * thứ 2; lấy tuần mới lúc đó là bỏ lỡ hẳn lời mời của tuần trước.
 *
 * @param {Date} now
 */
export function defaultSurveyWeekId(now) {
  const today = /** @type {{ date: string }} */ (vnParts(now)).date;
  const week = weekStartOf(today);
  const prev = shiftDate(week, -7);
  if (today === week && now.getTime() < Date.parse(surveyClosesAt(prev))) return prev;
  return week;
}

/**
 * Cổng giờ: lời mời chỉ đi từ 15:00 thứ 6 của tuần đó (giờ VN).
 *
 * - trước 15:00 thứ 6: 'early' — không làm gì (không cả đọc Firestore);
 * - thứ 6 từ 15:00: 'on_time';
 * - sau thứ 6 (thứ 7, CN, sáng thứ 2): 'catch_up' — gửi bù nếu tuần đó chưa
 *   gửi xong và khảo sát chưa đóng (decideWeek kiểm phần này);
 * - --force: 'forced' — bỏ qua giờ (quản trị chủ động gửi bù/gửi sớm).
 *
 * @param {{ weekId: string, now: Date, force?: boolean }} input
 * @returns {{ verdict: 'early' | 'on_time' | 'catch_up' | 'forced', opensAt: string }}
 */
export function timeGate({ weekId, now, force = false }) {
  const opensAt = surveyDefaultOpensAt(weekId);
  if (force) return { verdict: 'forced', opensAt };
  if (now.getTime() < Date.parse(opensAt)) return { verdict: 'early', opensAt };
  const today = /** @type {{ date: string }} */ (vnParts(now)).date;
  return { verdict: today === shiftDate(weekId, 4) ? 'on_time' : 'catch_up', opensAt };
}

export const NO_MEALS_REASON = 'Cả tuần không có ngày nào có suất ăn (ngày nghỉ khai ở tab Cấu hình) — không mở khảo sát, không gửi email.';

/**
 * Gửi BÙ (sau thứ 6) chỉ khi còn ít nhất chừng này tới hạn trả lời. Máy bật lúc
 * 11:55 thứ 2 mà mời cả trường làm khảo sát đóng lúc 12:00 thì chẳng ai kịp trả
 * lời, chỉ thêm một thư làm phiền. Đúng giờ (thứ 6) và --force thì không xét.
 */
export const MIN_CATCH_UP_MS = 60 * 60_000;

/**
 * Lần chạy này làm gì với tuần `weekId`.
 *
 * Thứ tự kiểm tra:
 *   1. cổng giờ ('wait');
 *   2. đã gửi xong ('already_sent') — xét TRƯỚC tuần nghỉ: quản trị khai ngày
 *      nghỉ muộn cũng không được xoá dấu vết "đã gửi" của tuần đó;
 *   3. cả tuần không có suất ăn ('skip_no_meals');
 *   4. khảo sát đã đóng ('closed') — mời làm một khảo sát không còn nhận trả
 *      lời là vô ích; hạn lấy từ document tuần (quản trị có thể đã gia hạn
 *      hoặc đóng sớm), chưa có thì là 12:00 thứ 2 tuần sau;
 *   5. gửi bù mà còn chưa tới MIN_CATCH_UP_MS là đóng ('too_late');
 *   6. gửi ('send').
 *
 * `now` phải là giờ LÚC QUYẾT ĐỊNH (script đọc lại đồng hồ sau khi chờ khoá và
 * đọc Firestore), không phải giờ khởi động.
 *
 * @param {{ weekId: string, now: Date, force?: boolean, existing?: any, offDays?: Iterable<string> | null }} input
 */
export function decideWeek({ weekId, now, force = false, existing = null, offDays = [] }) {
  const label = surveyWeekLabel(weekId);
  const gate = timeGate({ weekId, now, force });
  if (gate.verdict === 'early') {
    return {
      action: /** @type {const} */ ('wait'), gate,
      message: `Chưa tới giờ gửi: lời mời khảo sát tuần ${label} gửi từ ${formatVnDateTime(gate.opensAt)} (15:00 thứ 6). Không làm gì.`,
    };
  }
  const prev = existing?.email && typeof existing.email === 'object' ? existing.email : null;
  if (prev?.status === 'sent') {
    const at = typeof prev.sentAt === 'string' ? formatVnDateTime(prev.sentAt) : '';
    return {
      action: /** @type {const} */ ('already_sent'), gate,
      message: `Lời mời khảo sát tuần ${label} đã gửi xong${at ? ` lúc ${at}` : ''} — không gửi lại.`,
    };
  }
  if (!weekHasMeals(weekId, offDays)) {
    return {
      action: /** @type {const} */ ('skip_no_meals'), gate,
      // Đã ghi đúng lý do này rồi thì lần lặp 15 phút sau khỏi ghi lại.
      recorded: prev?.status === 'skipped' && prev?.reason === NO_MEALS_REASON,
      reason: NO_MEALS_REASON,
      message: `Tuần ${label}: ${NO_MEALS_REASON}`,
    };
  }
  const closesMs = toMillis(existing?.closesAt) ?? Date.parse(surveyClosesAt(weekId));
  if (now.getTime() >= closesMs) {
    return {
      action: /** @type {const} */ ('closed'), gate,
      message: `Khảo sát tuần ${label} đã đóng lúc ${formatVnDateTime(new Date(closesMs).toISOString())} — không gửi lời mời. ` +
        `Muốn gửi bù: quản trị bấm "Gia hạn" trong tab Khảo sát bữa ăn, rồi chạy lại với --week ${weekId}.`,
    };
  }
  const closesLabel = formatVnDateTime(new Date(closesMs).toISOString());
  if (gate.verdict === 'catch_up' && closesMs - now.getTime() < MIN_CATCH_UP_MS) {
    const minutes = Math.max(1, Math.ceil((closesMs - now.getTime()) / 60_000));
    return {
      action: /** @type {const} */ ('too_late'), gate,
      message: `Lời mời khảo sát tuần ${label} chưa gửi xong nhưng chỉ còn ${minutes} phút là hết hạn trả lời (${closesLabel}) — ` +
        `không gửi bù (Thầy/Cô không kịp trả lời). Muốn vẫn mời: quản trị bấm "Gia hạn" trong tab Khảo sát bữa ăn rồi chạy lại ` +
        `với --week ${weekId}, hoặc chạy với --force.`,
    };
  }
  return {
    action: /** @type {const} */ ('send'), gate,
    catchUp: gate.verdict === 'catch_up',
    message: gate.verdict === 'catch_up'
      ? `GỬI BÙ: đã qua 15:00 thứ 6 mà lời mời tuần ${label} chưa gửi xong; khảo sát còn mở tới ${closesLabel}.`
      : gate.verdict === 'forced'
        ? `--force: bỏ qua kiểm tra giờ 15:00 thứ 6; khảo sát tuần ${label} mở tới ${closesLabel}.`
        : `Đúng giờ gửi lời mời khảo sát tuần ${label}; khảo sát mở tới ${closesLabel}.`,
  };
}

// ------------------------------------------------------------- document tuần

/** createdAt cũ (ISO; Timestamp thì đổi về ISO cho đúng hợp đồng), hoặc bây giờ. */
const keepCreatedAt = (/** @type {unknown} */ v, /** @type {Date} */ now) => {
  if (typeof v === 'string' && v) return v;
  const ms = toMillis(v);
  return ms !== null ? new Date(ms).toISOString() : now.toISOString();
};

/**
 * Phần ghi (set merge) vào `meal_surveys/{weekId}` để MỞ khảo sát trước khi
 * gửi lời mời.
 *
 * CHỈ ghi phần còn thiếu. opensAt / closesAt / openedBy / createdAt / version đã
 * có thì không đụng tới — kể cả "ghi lại đúng giá trị cũ": quản trị có thể bấm
 * "Đóng ngay" hay "Gia hạn" đúng lúc agent đang chạy, và ghi lại giá trị đọc từ
 * vài giây trước là lặng lẽ đè mất thao tác đó (mở lại khảo sát vừa đóng, cắt
 * mất phần gia hạn). Script gọi hàm này TRONG giao dịch Firestore, cùng lần đọc
 * `existing`, nên "còn thiếu" là thiếu thật tại lúc ghi.
 *
 * Chưa có opensAt: mở từ `serverTime` — script truyền serverTimestamp(), vì
 * rules so request.time (giờ máy chủ) với opensAt: đồng hồ máy HAC nhanh vài
 * phút thì Thầy/Cô bấm link ngay khi nhận thư sẽ bị từ chối. Không truyền thì
 * dùng `now`. Mở từ lúc gửi, không phải 15:00 thứ 6 (gửi bù thứ 7 thì khảo sát
 * cũng chỉ mở từ lúc gửi). Chưa có closesAt: 12:00 thứ 2 tuần sau, dạng Date
 * (firebase-admin ghi thành Timestamp, đúng kiểu rules so với request.time).
 * Bản ghi lỡ là chuỗi ISO (rules không so được) thì ghi lại thành Date đúng
 * thời điểm đó — an toàn vì cùng lần đọc trong giao dịch.
 *
 * @param {{ weekId: string, existing?: any, now: Date, serverTime?: unknown }} input
 */
export function openWeekPatch({ weekId, existing = null, now, serverTime }) {
  const w = surveyWeek(weekId);
  const ex = existing && typeof existing === 'object' ? existing : {};
  const oldOpens = toMillis(ex.opensAt);
  const oldCloses = toMillis(ex.closesAt);
  const defaultCloses = Date.parse(surveyClosesAt(weekId));
  /** @type {Record<string, unknown>} */
  const data = { weekId, weekStart: w.weekStart, weekEnd: w.weekEnd };
  if (typeof ex.version !== 'number') data.version = SURVEY_VERSION;
  if (oldOpens === null) data.opensAt = serverTime === undefined ? new Date(now.getTime()) : serverTime;
  else if (typeof ex.opensAt === 'string') data.opensAt = new Date(oldOpens);
  if (oldCloses === null) data.closesAt = new Date(defaultCloses);
  else if (typeof ex.closesAt === 'string') data.closesAt = new Date(oldCloses);
  if (!(typeof ex.openedBy === 'string' && ex.openedBy.trim())) data.openedBy = 'agent';
  if (!(typeof ex.createdAt === 'string' && ex.createdAt)) data.createdAt = keepCreatedAt(ex.createdAt, now);
  return {
    data,
    keptOpens: oldOpens !== null,
    keptCloses: oldCloses !== null,
    /** Giờ mở đã có (ms), null = mở từ lúc ghi. */
    opensMs: oldOpens,
    /** Hạn đóng sau khi ghi (ms). */
    closesMs: oldCloses ?? defaultCloses,
  };
}

/**
 * Trạng thái email trong document tuần. Chỉ có số đếm và lý do — KHÔNG email,
 * KHÔNG uid: mọi người đã đăng nhập đều đọc được document này. Lý do có thể
 * chép từ thông báo lỗi của endpoint, nên vẫn xoá hẳn địa chỉ email (không chỉ
 * che như trong log) và che khoá cho chắc.
 *
 * @param {{ status: 'sent' | 'partial' | 'error' | 'skipped', at: string, sentAt?: string | null,
 *           recipients?: number, sent?: number, failed?: number, reason?: string | null, secret?: string }} input
 */
export function buildEmailStatus({ status, at, sentAt = null, recipients = 0, sent = 0, failed = 0, reason = null, secret = '' }) {
  const n = (/** @type {unknown} */ v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const text = reason ? clip(scrubEmails(redact(reason, secret), () => '(địa chỉ email)'), 500) : '';
  return {
    status,
    at,
    sentAt: typeof sentAt === 'string' && sentAt ? sentAt : null,
    recipients: n(recipients),
    sent: n(sent),
    failed: n(failed),
    reason: text || null,
  };
}

/**
 * Document tuần khi KHÔNG gửi (tuần nghỉ, không có ai để mời): chỉ ghi trạng
 * thái email, không đặt opensAt/closesAt — tức là không mở khảo sát. Đã có
 * opensAt/closesAt (quản trị mở tay) thì set-merge giữ nguyên.
 *
 * @param {{ weekId: string, existing?: any, now: Date, reason: string }} input
 */
export function skippedWeekDoc({ weekId, existing = null, now, reason }) {
  const w = surveyWeek(weekId);
  const ex = existing && typeof existing === 'object' ? existing : {};
  const prev = ex.email && typeof ex.email === 'object' ? ex.email : {};
  return {
    weekId,
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    version: SURVEY_VERSION,
    createdAt: keepCreatedAt(ex.createdAt, now),
    // Số đã gửi ở lần trước (nếu có) vẫn đúng — giữ lại, chỉ đổi trạng thái.
    email: buildEmailStatus({
      status: 'skipped', at: now.toISOString(), sentAt: prev.sentAt ?? null,
      recipients: prev.recipients, sent: prev.sent, failed: 0, reason,
    }),
  };
}

// ------------------------------------------------------------- người nhận

/**
 * @typedef {{ uid: string, fullName: string, department: string, email: string }} Invitee
 */

/**
 * Ghép uid người được mời (surveyRecipientUids) với email trong Firebase Auth
 * và họ tên / bộ phận trên đơn đăng ký.
 *
 * - Email lấy từ TÀI KHOẢN đăng nhập, không lấy trên đơn (đơn do trình duyệt
 *   ghi, ai cũng điền được email bất kỳ).
 * - Chỉ gửi tới hộp thư @hoangmaistarschool.edu.vn, ASCII in được — endpoint
 *   từ chối CẢ LÔ nếu có một địa chỉ sai, nên lọc trước ở đây.
 * - Hai tài khoản chung một địa chỉ thì chỉ gửi một lần (endpoint cũng từ chối
 *   cả lô nếu Bcc trùng).
 * - Người có đơn ở cả hai tháng (tuần vắt tháng): họ tên/bộ phận theo đơn
 *   tháng sau — mới hơn.
 *
 * @param {{ uids: string[], registrations: { uid: string, month?: string, fullName?: unknown, department?: unknown }[],
 *           emails: Map<string, string | null | undefined> }} input
 */
export function buildInvitees({ uids, registrations, emails }) {
  /** @type {Map<string, any>} */
  const regOf = new Map();
  for (const r of registrations || []) {
    if (!r || !r.uid) continue;
    const cur = regOf.get(r.uid);
    if (!cur || String(r.month || '') >= String(cur.month || '')) regOf.set(r.uid, r);
  }
  /** @type {Invitee[]} */ const invitees = [];
  const skipped = { noEmail: /** @type {string[]} */ ([]), outsideDomain: /** @type {string[]} */ ([]), duplicateEmail: /** @type {string[]} */ ([]) };
  const seen = new Set();
  for (const uid of uids) {
    const email = String(emails.get(uid) ?? '').trim();
    if (!email) { skipped.noEmail.push(uid); continue; }
    if (!isSendableEmail(email)) { skipped.outsideDomain.push(uid); continue; }
    const key = email.toLowerCase();
    if (seen.has(key)) { skipped.duplicateEmail.push(uid); continue; }
    seen.add(key);
    const reg = regOf.get(uid) || {};
    invitees.push({ uid, fullName: oneLine(reg.fullName, 120), department: oneLine(reg.department, 120), email });
  }
  return { invitees, skipped };
}

/** Tập email đã gửi (chữ thường), bỏ giá trị rác. @param {unknown} list */
const sentSetOf = list => new Set((Array.isArray(list) ? list : []).filter(s => typeof s === 'string').map(s => s.toLowerCase()));

/**
 * Người chưa nhận lời mời: bỏ ai đã có trong private/invited.sentEmails. Nhờ
 * vậy lần chạy lặp sau một lô lỗi chỉ gửi nốt, không gửi trùng.
 *
 * `hold`: người KHÔNG RÕ đã nhận thư chưa (private/invited.uncertainEmails) —
 * cũng không tự gửi lại; chỉ gửi lại khi người vận hành chạy --force (script
 * truyền hold rỗng).
 *
 * @param {Invitee[]} invitees @param {unknown} sentEmails @param {unknown} [hold]
 */
export function pendingInvitees(invitees, sentEmails, hold = []) {
  const sent = sentSetOf(sentEmails);
  const held = sentSetOf(hold);
  return invitees.filter(r => !sent.has(r.email.toLowerCase()) && !held.has(r.email.toLowerCase()));
}

/** Danh sách email hợp lệ (chuỗi) từ một trường Firestore. @param {unknown} v @returns {string[]} */
export const emailList = v => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim() !== '') : []);

/** Chia lô ≤ SURVEY_BATCH_SIZE người, mỗi lô là một thư (Bcc). @param {Invitee[]} pending */
export const inviteBatches = (pending, size = SURVEY_BATCH_SIZE) => chunk(pending, Math.max(1, Math.min(size, SURVEY_BATCH_SIZE)));

/**
 * Danh sách `recipients` ghi vào private/invited (quản trị dùng để xem ai chưa
 * trả lời): người đang được mời lần này + người lần trước ĐÃ nhận thư mà nay
 * không còn trong danh sách (vd. vừa huỷ đơn) — họ vẫn đã được mời thật.
 * Script truyền `sentEmails` gồm cả người "không rõ đã nhận" (có thể đã nhận).
 *
 * @param {{ previous?: unknown, current: Invitee[], sentEmails?: unknown }} input
 * @returns {Invitee[]}
 */
export function mergeInvitedRecipients({ previous, current, sentEmails }) {
  const sent = sentSetOf(sentEmails);
  /** @type {Map<string, Invitee>} */
  const out = new Map();
  for (const r of current) out.set(r.uid, r);
  for (const r of Array.isArray(previous) ? previous : []) {
    if (!r || typeof r !== 'object' || typeof r.uid !== 'string' || out.has(r.uid)) continue;
    if (typeof r.email !== 'string' || !sent.has(r.email.toLowerCase())) continue;
    out.set(r.uid, { uid: r.uid, fullName: oneLine(r.fullName, 120), department: oneLine(r.department, 120), email: r.email });
  }
  return [...out.values()];
}

/**
 * @typedef {{ delivery: 'sent' | 'not_sent' | 'unknown', count: number | null, error: string | null }} InviteOutcome
 *   sent      — endpoint báo đã gửi;
 *   not_sent  — chắc chắn chưa gửi: lỗi kết nối trước khi yêu cầu rời máy, máy
 *               chủ từ chối (4xx, lỗi JSON của chính hàm), hoặc endpoint trả
 *               `ok: false` KHÔNG kèm `maybeSent` (Graph từ chối thư hay chưa kịp
 *               gửi) -> lần sau gửi lại được;
 *   unknown   — không biết: endpoint trả `ok: false, maybeSent: true` (Graph hết
 *               giờ chờ / 5xx / đứt kết nối SAU khi đã nhận yêu cầu gửi), hết giờ
 *               chờ endpoint, đứt kết nối giữa chừng, 502/504 của Vercel, thân
 *               phản hồi lạ -> KHÔNG tự gửi lại.
 */

/**
 * Dấu hiệu trong thông báo lỗi của endpoint cho thấy lỗi xảy ra SAU khi yêu cầu
 * gửi thư đã tới Graph: Graph 5xx, hết giờ chờ, đứt kết nối. Endpoint hiện tại
 * tự báo `maybeSent: true` cho mọi trường hợp này; đây là lưới thứ hai phòng bản
 * web cũ hơn (trả ok:false trơn cho mọi lỗi). Chỉ dò chữ kỹ thuật tiếng Anh: lỗi
 * "chưa gửi" của endpoint viết tiếng Việt ("Hết thời gian xử lý ... nên chưa gửi
 * thư này", "báo quá tải (429)") không khớp. Đoán nhầm sang "không rõ" chỉ khiến
 * người vận hành phải chạy --force; đoán nhầm sang "chưa gửi" là cả trường nhận
 * hai thư.
 */
const MAYBE_SENT_HINT =
  /\bHTTP 5\d\d\b|\btime(?:d)?[ -]?out\b|TimeoutError|AbortError|\baborted\b|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|other side closed|\bterminated\b/i;

/**
 * Kết quả gửi một lô, từ thân phản hồi của endpoint (`{ results: [ { ok,
 * count, maybeSent?, error? } ] }`) hoặc từ lỗi postAlerts ném ra
 * (lib/endpoint.mjs gắn `delivery` cho lỗi).
 *
 * Mỗi lô thường là MỘT thư Bcc cho CẢ TRƯỜNG (~300 người < 400). Coi một lỗi
 * "không rõ" là "chưa gửi" thì lần lặp 15 phút sau gửi lại, và nếu Graph thực
 * ra đã gửi, mọi CBGV-NV nhận hai thư — nên chỉ "chắc chắn chưa gửi" mới được
 * gửi lại tự động: `ok: false` chỉ là "chưa gửi" khi endpoint KHÔNG báo
 * maybeSent và thông báo lỗi không có dấu hiệu lỗi sau khi gửi (MAYBE_SENT_HINT).
 *
 * @param {{ response?: unknown, error?: unknown }} input
 * @returns {InviteOutcome}
 */
export function inviteOutcome({ response, error }) {
  if (error !== undefined) {
    const e = /** @type {any} */ (error);
    return {
      delivery: e?.delivery === 'not_sent' ? 'not_sent' : 'unknown',
      count: null,
      error: clip(e?.message || String(e ?? '') || 'lỗi không rõ', 300),
    };
  }
  const results = /** @type {any} */ (response)?.results;
  const r = Array.isArray(results) ? results[0] : undefined;
  if (r && typeof r === 'object') {
    if (r.ok === true) return { delivery: 'sent', count: Number.isFinite(Number(r.count)) ? Number(r.count) : null, error: null };
    if (r.ok === false) {
      const text = typeof r.error === 'string' ? r.error : '';
      // maybeSent khác "không có / false" (kể cả giá trị lạ) thì coi là có thể đã đi.
      const maybeSent = (r.maybeSent !== undefined && r.maybeSent !== false) || MAYBE_SENT_HINT.test(text);
      return maybeSent
        ? { delivery: 'unknown', count: null, error: clip(`Microsoft Graph có thể đã nhận thư: ${text || 'lỗi sau khi đã gửi yêu cầu'}`, 200) }
        : { delivery: 'not_sent', count: null, error: clip(text || 'gửi thất bại', 200) };
    }
  }
  // HTTP 2xx mà thân không đúng dạng: hàm đã chạy, không biết đã gửi chưa.
  return { delivery: 'unknown', count: null, error: 'Endpoint trả lời không đúng dạng — không rõ thư đã đi hay chưa' };
}

/**
 * Thân yêu cầu gửi MỘT thư mời tới endpoint (kind 'survey-invite').
 *
 * Kèm `closesAt` — hạn trả lời THẬT đọc ở document tuần ngay trước thư (ISO):
 * quản trị có thể đã gia hạn hay đóng sớm, và endpoint chỉ biết mã tuần thì thư
 * sẽ ghi hạn mặc định 12h00 thứ 2 (gửi bù sau khi gia hạn là ghi một hạn đã
 * qua). Endpoint tự định dạng hạn và từ chối (400 — chắc chắn chưa gửi) nếu hạn
 * đã qua. Không có hạn hợp lệ (không xảy ra: batchGate dừng trước khi gửi nếu
 * document tuần thiếu closesAt) thì bỏ trường, endpoint dùng hạn mặc định.
 *
 * @param {{ weekId: string, closesMs: number | null | undefined, emails: string[] }} input
 */
export function inviteRequest({ weekId, closesMs, emails }) {
  // Không được ném lỗi: lỗi ở đây rơi vào nhánh "không rõ đã gửi" của vòng gửi.
  const d = typeof closesMs === 'number' ? new Date(closesMs) : null;
  const bcc = [...emails];
  return d && !isNaN(d.getTime())
    ? { kind: /** @type {const} */ ('survey-invite'), weekId, closesAt: d.toISOString(), bcc }
    : { kind: /** @type {const} */ ('survey-invite'), weekId, bcc };
}

// ------------------------------------------------------------- quyền gửi (lease)

/**
 * Thời hạn giữ quyền gửi lời mời một tuần (`meal_surveys/{tuần}/private/lock`).
 * Khoá file khao-sat.lock chỉ chặn hai lần chạy trên CÙNG một máy; chạy thêm từ
 * máy khác với cùng config.json + firebase-key.json (vd. máy của quản trị IT,
 * `--force` lúc 15:02) thì chỉ Firestore mới thấy nhau. Lần chạy giữ quyền gia
 * hạn trước mỗi thư; chết giữa chừng thì quyền tự hết sau chừng này (lần lặp 15
 * phút sau làm tiếp). Dài hơn hẳn một thư (endpoint chờ tối đa 90 giây, ghi
 * Firestore thử lại 3 lần).
 */
export const SEND_LEASE_MS = 10 * 60_000;

/**
 * Tình trạng quyền gửi đối với lần chạy có `token`:
 *   'mine' — của mình (kể cả đã quá hạn mà chưa ai lấy: vẫn còn ghi token mình);
 *   'busy' — lần chạy khác đang giữ, chưa hết hạn;
 *   'free' — chưa ai giữ, đã trả, hoặc đã hết hạn.
 * `nowMs` nên là giờ máy chủ (readTime của lần đọc) để hai máy lệch đồng hồ vẫn
 * so cùng một thước.
 *
 * @param {{ lease: unknown, token: string, nowMs: number }} input
 * @returns {'mine' | 'busy' | 'free'}
 */
export function leaseState({ lease, token, nowMs }) {
  const l = /** @type {any} */ (lease);
  if (!l || typeof l !== 'object' || l.released === true) return 'free';
  if (typeof l.token === 'string' && l.token === token) return 'mine';
  const until = toMillis(l.until);
  return until !== null && until > nowMs ? 'busy' : 'free';
}

/**
 * Bản ghi quyền gửi. Không có dữ liệu cá nhân (tên máy, PID, giờ).
 *
 * @param {{ token: string, host?: string, pid?: number, nowMs: number, startedAt: string }} input
 */
export function buildLease({ token, host = '', pid = 0, nowMs, startedAt }) {
  return {
    token,
    host: oneLine(host, 80),
    pid: Number.isInteger(pid) ? pid : 0,
    startedAt,
    until: new Date(nowMs + SEND_LEASE_MS),
    released: false,
  };
}

/**
 * Kiểm tra NGAY TRƯỚC mỗi thư (script đọc lại document tuần và quyền gửi trong
 * một giao dịch): còn giữ quyền gửi, và khảo sát chưa đóng theo hạn MỚI NHẤT —
 * quản trị có thể vừa bấm "Đóng ngay" trong lúc script đang tra danh sách hay
 * đang gửi thư trước. Trả null = gửi được, hoặc lý do dừng.
 *
 * @param {{ week: any, lease: unknown, token: string, now: Date }} input
 * @returns {string | null}
 */
export function batchGate({ week, lease, token, now }) {
  if (leaseState({ lease, token, nowMs: now.getTime() }) !== 'mine') {
    return 'một lần chạy khác (có thể từ máy khác) đã nhận quyền gửi lời mời tuần này — dừng để không gửi trùng.';
  }
  const closes = toMillis(week?.closesAt);
  if (closes === null) return 'document tuần không còn hạn đóng (closesAt) — dừng gửi, kiểm tra tab Khảo sát bữa ăn.';
  if (now.getTime() >= closes) {
    return `khảo sát đã đóng lúc ${formatVnDateTime(new Date(closes).toISOString())} (quản trị vừa bấm "Đóng ngay", hoặc đã hết hạn) — dừng gửi lời mời.`;
  }
  return null;
}

// ------------------------------------------------------------- vòng gửi

/**
 * Gửi các lô lời mời. Thuần — mọi việc mạng/Firestore đi qua tham số — để test
 * được những điều mà sai là cả trường nhận thư hai lần:
 *
 *   - trước mỗi thư gọi `beforeBatch` (còn quyền gửi? khảo sát còn mở?); lỗi
 *     hay có lý do dừng thì KHÔNG gửi thư đó và mọi thư sau;
 *   - sau mỗi thư đã đi (hay không rõ đã đi chưa) gọi `journal` NGAY để lưu
 *     sentEmails / uncertainEmails — lần chạy sau dựa vào đó để không gửi lại;
 *   - `journal` lỗi thì DỪNG: thư đi mà không được ghi nhớ sẽ bị gửi lại;
 *   - thư "không rõ" (InviteOutcome 'unknown') không tính là lỗi để gửi lại,
 *     mà vào uncertainEmails;
 *   - thư lỗi chắc chắn chưa gửi ('not_sent') thì lần sau gửi nốt.
 *
 * @param {{
 *   batches: Invitee[][],
 *   sentEmails?: string[],
 *   uncertainEmails?: string[],
 *   beforeBatch?: (index: number) => Promise<string | null>,
 *   post: (batch: Invitee[]) => Promise<InviteOutcome>,
 *   journal: (state: { sentEmails: string[], uncertainEmails: string[], at: string }) => Promise<void>,
 *   clock?: () => Date,
 *   log?: (line: string) => void,
 * }} input
 */
export async function sendInvitations({
  batches, sentEmails = [], uncertainEmails = [], beforeBatch, post, journal, clock = () => new Date(), log = () => {},
}) {
  const lower = (/** @type {string} */ s) => s.toLowerCase();
  const sent = [...emailList(sentEmails)];
  const sentKeys = new Set(sent.map(lower));
  let uncertain = [...new Map(emailList(uncertainEmails).filter(e => !sentKeys.has(lower(e))).map(e => [lower(e), e])).values()];
  const out = {
    sentNow: 0,
    /** Người lần này chắc chắn chưa gửi được (lỗi, hoặc dừng trước khi gửi). */
    failed: 0,
    uncertainNow: 0,
    /** @type {string[]} */ errors: [],
    /** @type {string[]} */ unknownErrors: [],
    /** @type {string | null} */ journalError: null,
    /** @type {string | null} */ stopReason: null,
    /**
     * Dừng vì lỗi tạm (không đọc được Firestore), không phải vì khảo sát đã
     * đóng hay máy khác đang gửi: lần chạy sau có thể gửi nốt — runReasons
     * nói lần chạy theo lịch nào (nếu có) sẽ làm việc đó.
     */
    stopRetryable: false,
    /** @type {string | null} */ lastSentAt: null,
  };
  const note = (/** @type {string[]} */ list, /** @type {string} */ e) => { if (list.length < 3 && !list.includes(e)) list.push(e); };

  for (const [i, batch] of batches.entries()) {
    const tag = `Thư ${i + 1}/${batches.length} (${batch.length} người)`;
    if (out.journalError || out.stopReason) {
      // Không ghi nhớ được, hay đã có lý do dừng: các thư còn lại để lần sau.
      out.failed += batch.length;
      continue;
    }
    if (beforeBatch) {
      /** @type {string | null} */ let stop;
      try {
        stop = await beforeBatch(i);
      } catch (err) {
        // Không hứa "lần chạy sau gửi tiếp" ở đây: có còn lần chạy tự động
        // nào gửi hay không tuỳ giờ và hạn — runReasons tính (stopRetryable).
        stop = `không kiểm tra được trạng thái khảo sát trước khi gửi (${shorten(scrubEmails(/** @type {any} */ (err)?.message || err), 100)}) — dừng gửi các thư còn lại.`;
        out.stopRetryable = true;
      }
      if (stop) {
        out.stopReason = stop;
        out.failed += batch.length;
        log(`  ${tag}: KHÔNG gửi — ${stop}`);
        continue;
      }
    }

    /** @type {InviteOutcome} */ let res;
    try {
      res = await post(batch);
    } catch (err) {
      res = { delivery: 'unknown', count: null, error: String(/** @type {any} */ (err)?.message || err) };
    }
    const error = scrubEmails(res.error || 'gửi thất bại');
    const keys = new Set(batch.map(r => lower(r.email)));
    if (res.delivery === 'sent') {
      for (const r of batch) {
        if (!sentKeys.has(lower(r.email))) { sentKeys.add(lower(r.email)); sent.push(r.email); }
      }
      uncertain = uncertain.filter(e => !keys.has(lower(e)));
      out.sentNow += batch.length;
      out.lastSentAt = clock().toISOString();
      log(`  ${tag}: đã gửi.`);
      if (res.count !== null && res.count !== batch.length) {
        log(`  Lưu ý: endpoint báo đã gửi cho ${res.count} người, lô có ${batch.length} người.`);
      }
    } else if (res.delivery === 'unknown') {
      const known = new Set(uncertain.map(lower));
      for (const r of batch) if (!known.has(lower(r.email)) && !sentKeys.has(lower(r.email))) uncertain.push(r.email);
      out.uncertainNow += batch.length;
      note(out.unknownErrors, error);
      log(`  ${tag}: KHÔNG RÕ đã gửi hay chưa — ${error}. Không tự gửi lại thư này (tránh nhận hai lần).`);
    } else {
      out.failed += batch.length;
      note(out.errors, error);
      log(`  ${tag}: LỖI — ${error}`);
      continue; // chắc chắn chưa gửi: không có gì phải ghi nhớ
    }

    // Ghi ngay sau mỗi thư: thư sau có hỏng thì người đã nhận (hay có thể đã
    // nhận) vẫn được nhớ, lần chạy sau không gửi lại cho họ.
    try {
      await journal({ sentEmails: [...sent], uncertainEmails: [...uncertain], at: clock().toISOString() });
    } catch (err) {
      out.journalError = scrubEmails(String(/** @type {any} */ (err)?.message || err));
      log(res.delivery === 'sent'
        ? `  LỖI: đã gửi ${batch.length} lời mời nhưng không ghi được danh sách đã nhận — DỪNG gửi tiếp; lần sau những người này có thể nhận trùng. ${out.journalError}`
        : `  LỖI: không ghi được danh sách "không rõ đã nhận" — DỪNG gửi tiếp; lần sau những người này có thể nhận trùng. ${out.journalError}`);
    }
  }
  return { ...out, sentEmails: sent, uncertainEmails: uncertain };
}

/**
 * Trạng thái cuối của lần gửi:
 *   - mọi thư đều đi (kể cả không còn ai phải gửi) -> 'sent';
 *   - có người chưa gửi được nhưng đã có người nhận / có thể đã nhận -> 'partial',
 *     người chưa gửi được gửi nốt ở lần chạy sau (theo lịch nếu còn lần tự động
 *     gửi được — xem runReasons — không thì chạy tay --week);
 *   - còn người KHÔNG RÕ đã nhận chưa -> 'partial' (quản trị cần kiểm tra; không
 *     tự gửi lại — xem inviteOutcome);
 *   - chưa ai nhận được -> 'error'.
 *
 * @param {{ sentTotal: number, failed: number, uncertain?: number }} input
 * @returns {'sent' | 'partial' | 'error'}
 */
export function finalSurveyStatus({ sentTotal, failed, uncertain = 0 }) {
  if (failed > 0) return sentTotal > 0 || uncertain > 0 ? 'partial' : 'error';
  if (uncertain > 0) return 'partial';
  return 'sent';
}

// ------------------------------------------------------------- lịch tự động

/**
 * Giờ chạy THEO LỊCH của task "DKAN 4 - Khao sat 15h thu 6" trên máy HAC
 * (agent/README.md, mục "Chạy tự động — task thứ tư"): ① thứ 6 15:00, lặp 15
 * phút một lần trong 1 giờ (15:00 → 16:00); ② hằng ngày 07:30, lặp mỗi giờ
 * trong 5 giờ (07:30 → 12:30). Trigger ③ (lúc bật máy) không có giờ nào cố
 * định nên KHÔNG tính: hứa "lần chạy sau sẽ gửi nốt" dựa vào việc ai đó bật
 * lại máy là hứa một lần gửi có thể không bao giờ xảy ra. Tab quản trị
 * (src/components/SurveyResults.tsx) dùng cùng lịch này — đổi lịch thì đổi cả
 * hai nơi và README.
 */
export const SURVEY_FRIDAY_RUN_TIMES = Object.freeze(['15:00', '15:15', '15:30', '15:45', '16:00']);
export const SURVEY_DAILY_RUN_TIMES = Object.freeze(['07:30', '08:30', '09:30', '10:30', '11:30', '12:30']);

/**
 * Các lần chạy theo lịch (ms, tăng dần) có thể còn xử lý tuần `weekId`: từ thứ 6
 * tuần đó tới hết thứ 2 tuần sau. Không cần xét xa hơn: từ 12:00 thứ 2 lần chạy
 * không --week đã chọn tuần mới (defaultSurveyWeekId), kể cả khi tuần này đã
 * được gia hạn.
 *
 * @param {string} weekId
 * @returns {number[]}
 */
export function scheduledSurveyRuns(weekId) {
  /** @type {number[]} */ const out = [];
  for (let d = 4; d <= 7; d++) {
    const date = shiftDate(weekId, d);
    for (const hhmm of d === 4 ? [...SURVEY_DAILY_RUN_TIMES, ...SURVEY_FRIDAY_RUN_TIMES] : SURVEY_DAILY_RUN_TIMES) {
      out.push(Date.parse(`${date}T${hhmm}:00+07:00`));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Các lần chạy theo lịch, SAU `afterMs`, mà agent thật sự gửi (nốt) cho tuần
 * `weekId` khi tuần đó còn người chắc chắn chưa nhận thư. Không tự suy luận
 * lại quy tắc mà chạy đúng hai hàm quyết định của lần chạy theo lịch: chọn tuần
 * mặc định (task không truyền --week) và decideWeek — giờ 15:00 thứ 6 (thứ 6
 * không xét quy tắc 1 giờ), hạn `closesMs` (đã gia hạn / rút ngắn), không gửi
 * bù khi còn chưa tới 1 giờ. Rỗng = không còn lần tự động nào, phải chạy tay.
 *
 * @param {{ weekId: string, afterMs: number, closesMs?: number | null }} input
 * @returns {number[]}
 */
export function autoSendRuns({ weekId, afterMs, closesMs = null }) {
  // Còn người chưa gửi thì trạng thái là partial/error (không phải 'sent').
  // closesMs không hợp lệ -> Date hỏng -> toMillis trả null -> hạn mặc định.
  const existing = { email: { status: 'partial' }, closesAt: typeof closesMs === 'number' ? new Date(closesMs) : null };
  return scheduledSurveyRuns(weekId).filter(ms => {
    if (!(ms > afterMs)) return false;
    const now = new Date(ms);
    return defaultSurveyWeekId(now) === weekId && decideWeek({ weekId, now, existing }).action === 'send';
  });
}

/**
 * Câu nói ai gửi nốt cho người CHẮC CHẮN chưa nhận thư (thư lỗi chắc chắn, hay
 * vòng gửi dừng vì lỗi tạm). Chỉ hứa lần chạy tự động khi có một giờ chạy THEO
 * LỊCH sau lúc lần này kết thúc mà agent thật sự gửi (autoSendRuns); không có
 * thì nói thẳng phải chạy tay — vd. lỗi lúc 10:30 thứ 2 (hạn mặc định): lần
 * 11:30 còn chưa tới 1 giờ nên không gửi, không còn lần tự động nào.
 *
 * HỢP ĐỒNG với tab quản trị: agentNote (src/components/SurveyResults.tsx) bỏ
 * hẳn câu này — thẻ tự tính việc tiếp theo theo giờ HIỆN TẠI và hạn đang lưu —
 * nên câu chỉ được có một trong hai dạng, phần trong ngoặc không chứa dấu ngoặc:
 *   "Lần chạy sau sẽ gửi nốt (…)."
 *   "Không còn lần chạy tự động nào gửi nốt: … (…)."
 *
 * @param {{ weekId: string, atMs: number, closesMs?: number | null }} input
 */
function catchUpSentence({ weekId, atMs, closesMs = null }) {
  if (Number.isNaN(atMs)) {
    // Không biết giờ chạy: chỉ nêu điều kiện, không hứa lần nào cụ thể.
    return `Lần chạy sau sẽ gửi nốt (nếu còn lần chạy tự động theo lịch trước 12:00 thứ 2 và còn ít nhất 1 giờ tới hạn; không thì chạy tay --week ${weekId}).`;
  }
  const runs = autoSendRuns({ weekId, afterMs: atMs, closesMs });
  if (!runs.length) {
    // Khảo sát đã đóng thì chạy tay (kể cả --force) cũng không gửi: phải gia hạn trước.
    const closes = typeof closesMs === 'number' && Number.isFinite(closesMs) ? closesMs : Date.parse(surveyClosesAt(weekId));
    if (closes <= atMs) {
      return `Không còn lần chạy tự động nào gửi nốt: khảo sát đã đóng, muốn mời thì quản trị Gia hạn rồi chạy tay node survey-invite.mjs --week ${weekId} (thư ghi hạn mới).`;
    }
    return `Không còn lần chạy tự động nào gửi nốt: chạy tay node survey-invite.mjs --week ${weekId} (còn dưới 1 giờ tới hạn thì thêm --force).`;
  }
  const at = (/** @type {number} */ ms) => formatVnDateTime(new Date(ms).toISOString());
  const last = runs.length > 1 ? `, lần tự động cuối cùng ${at(runs[runs.length - 1])}` : ', cũng là lần tự động cuối cùng';
  return `Lần chạy sau sẽ gửi nốt (lần theo lịch kế tiếp ${at(runs[0])}${last}; sau đó phải chạy tay --week ${weekId}).`;
}

/**
 * Lý do ghi vào email.reason của document tuần (chỉ số đếm, không địa chỉ —
 * buildEmailStatus còn xoá địa chỉ lần nữa).
 *
 * Người chắc chắn chưa gửi được thì nói lần chạy THEO LỊCH nào còn gửi nốt, hay
 * phải chạy tay (catchUpSentence) — không hứa điều agent không làm. Tính từ
 * `endedAt` (lúc lần này kết thúc), không phải `ranAt`: task đặt "Do not start a
 * new instance" nên giờ lặp nào rơi vào lúc lần này còn chạy thì bị bỏ.
 *
 * @param {{ weekId: string, catchUp?: boolean, ranAt?: string, endedAt?: string, closesMs?: number | null, failed?: number,
 *           errors?: string[], stopReason?: string | null, stopRetryable?: boolean, journalError?: string | null,
 *           uncertain?: number, unknownErrors?: string[], notes?: string[] }} input
 * @returns {string[]}
 */
export function runReasons({
  weekId, catchUp = false, ranAt = '', endedAt = '', closesMs = null, failed = 0, errors = [], stopReason = null,
  stopRetryable = false, journalError = null, uncertain = 0, unknownErrors = [], notes = [],
}) {
  const out = [];
  const next = () => catchUpSentence({ weekId, atMs: Date.parse(endedAt || ranAt), closesMs });
  // email.reason bị cắt ở 500 ký tự (buildEmailStatus). Rút gọn phần lỗi (bản
  // đầy đủ có trong khao-sat.log, từng thư) để câu "việc tiếp theo" đứng sau
  // không bị cắt dở: tab quản trị bỏ trọn câu đó theo đúng dạng của nó, cắt
  // dở thì còn lại một mẩu "(lần theo lịch kế tiếp …" trên thẻ.
  const errText = shorten(errors.join('; '), 180);
  if (catchUp) out.push(`Gửi bù sau 15:00 thứ 6 (máy chạy lúc ${formatVnDateTime(ranAt) || ranAt}).`);
  // Dừng vì khảo sát đã đóng / máy khác đang gửi: không có gì để hứa. Dừng vì
  // lỗi tạm (stopRetryable): nói lần chạy nào gửi nốt, như với thư lỗi.
  if (failed && stopReason) out.push(`${failed} người chưa được gửi: ${stopReason}${stopRetryable ? ` ${next()}` : ''}`);
  else if (failed) out.push(`${failed} người chưa gửi được (${errText || 'dừng giữa chừng'}). ${next()}`);
  if (journalError) out.push(`Lỗi ghi danh sách đã nhận: ${journalError}.`);
  if (uncertain) {
    out.push(
      `${uncertain} người KHÔNG RÕ đã nhận thư mời hay chưa${unknownErrors.length ? ` (${unknownErrors.join('; ')})` : ''}: ` +
      `không tự gửi lại để tránh mỗi người nhận hai thư. Hỏi vài Thầy/Cô xem đã nhận chưa; nếu chưa thì chạy ` +
      `node survey-invite.mjs --force --week ${weekId} trên máy HAC.`
    );
  }
  out.push(...notes);
  return out;
}

/** Ghi chú về người không gửi được (chỉ số đếm, không tên). @param {{ noEmail: string[], outsideDomain: string[], duplicateEmail: string[] }} skipped */
export function inviteeNotes(skipped) {
  const notes = [];
  const unreachable = skipped.noEmail.length + skipped.outsideDomain.length;
  if (unreachable) notes.push(`${unreachable} người không có email @hoangmaistarschool.edu.vn trong tài khoản, không gửi được.`);
  if (skipped.duplicateEmail.length) notes.push(`${skipped.duplicateEmail.length} tài khoản dùng chung địa chỉ email với người khác, chỉ gửi một lần.`);
  return notes;
}

// ------------------------------------------------------------- in ra màn hình

/** "nguyenvana@x.vn" -> "n***@x.vn": log nằm trên máy HAC, ai mở máy cũng đọc được. @param {string} email */
export function maskEmail(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${s[0]}***${s.slice(at)}`;
}

/**
 * Che mọi địa chỉ email trong một đoạn chữ (thông báo lỗi trước khi in/ghi).
 * Mặc định che kiểu maskEmail (đủ cho log trên máy HAC); truyền `replace` để
 * thay hẳn.
 *
 * @param {unknown} text
 * @param {(email: string) => string} [replace]
 */
export const scrubEmails = (text, replace = maskEmail) =>
  String(text ?? '').replace(/[^\s@<>"'(),;:[\]]+@[^\s@<>"'(),;:[\]]+/g, m => replace(m));

/**
 * Rút gọn một đoạn chữ về tối đa `max` ký tự, có dấu "…" khi phải cắt (để người
 * đọc biết là đã bị cắt, xem bản đầy đủ trong khao-sat.log).
 *
 * @param {unknown} text
 * @param {number} max
 */
export function shorten(text, max) {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
