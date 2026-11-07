/**
 * Chọn ai nhận email cảnh báo chấm ăn, và quyết định có nên gửi hay không (chốt
 * an toàn). Hai loại thư, xét độc lập với nhau:
 *
 *   - 'missing' — "đăng ký mà không chấm ăn": xét cho HÔM NAY, sau giờ ăn trưa.
 *     Email này nói với một người rằng họ vi phạm quy định, có thể bị tạm dừng
 *     đăng ký tháng sau;
 *   - 'extra' — "chấm ăn nhưng chưa đăng ký": xét cho NGÀY CÓ SUẤT ĂN TRƯỚC hôm
 *     nay (alertDates). Ăn trước rồi nộp đơn trong cùng ngày vẫn được tính là đã
 *     đăng ký (countsAsRegistered — hay gặp đầu tháng), nên phải hết ngày mới biết
 *     chắc một lượt chấm là "chưa đăng ký".
 *
 * Gửi oan một lần là mất lòng tin vào cả hệ thống, nên mọi bước ở đây nghiêng về
 * phía KHÔNG gửi khi có nghi ngờ: dữ liệu chưa chốt thì chờ, mã trùng thì bỏ, mã
 * không gắn chắc chắn được với một tài khoản thì bỏ, số người bất thường thì dừng
 * cả đợt và báo quản trị.
 *
 * Kết luận "đáng lẽ ăn / đã chấm / chưa chấm / chấm mà không đăng ký" của từng
 * người lấy NGUYÊN từ evaluatePersonDay() trong meal-rules.mjs — cùng hàm với trang
 * "Chấm ăn của tôi" — để email và trang cá nhân không bao giờ nói hai điều khác nhau.
 *
 * File thuần, không import Node hay Firebase.
 */

import {
  MEALS, MEAL_LABEL, MEAL_WINDOWS, normId, isUsableId, isMealDay, classifyTime, classifyTimes,
  evaluatePersonDay, formatDayLabel, formatVnDateTime, duplicateIdsOn, registrationEffectiveFrom,
  isSchoolStaffId, isMealFinal,
} from './meal-rules.mjs';
import { addDays, chunk, clip, oneLine, uniqSorted, isIsoDate, HHMM_RE } from './common.mjs';
import { normalizePeople } from './projection.mjs';
import { isSafeUid } from './registrations.mjs';
import { createCheckinExemptionMatcher, exemptionCovers } from './checkin-exemptions.mjs';
import { isOldApiKindRejection } from './endpoint.mjs';

/** Chỉ gửi tới hộp thư của trường — endpoint cũng chặn y như vậy. */
export const SCHOOL_EMAIL_RE = /^[^@\s]+@hoangmaistarschool\.edu\.vn$/i;

// Endpoint còn đòi địa chỉ chỉ gồm ký tự ASCII in được, không quá 254 ký tự;
// một địa chỉ sai là CẢ LÔ bị từ chối, nên lọc trước ở đây.
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;
/** @param {string} email */
export const isSendableEmail = email => email.length <= 254 && SCHOOL_EMAIL_RE.test(email) && PRINTABLE_ASCII_RE.test(email);

// Endpoint nhận tối đa 20 người/lần. Gửi 10 cho chắc: hàm trên Vercel có giới
// hạn thời gian chạy, mà Microsoft Graph có lúc trả 429 bắt chờ. Lô nhỏ thì
// một lần quá hạn chỉ làm lỡ ít người (lần chạy sau gửi nốt).
export const ALERT_BATCH_SIZE = 10;

/** @typedef {import('./meal-rules.mjs').Meal} Meal */
/** @typedef {{ breakfast: number, lunch: number }} PerMeal */
/** @typedef {{ expected: PerMeal, missing: PerMeal, exempt?: PerMeal }} AlertStats */

/** "Thứ 6, 09/10/2026" @param {string} date */
export const dateLabelOf = date => `${formatDayLabel(date)}/${date.slice(0, 4)}`;

/** "05:00–08:00" (gạch nối dài, đúng định dạng endpoint kiểm tra) @param {Meal} meal */
export const windowLabel = meal => `${MEAL_WINDOWS[meal].from}–${MEAL_WINDOWS[meal].to}`;

const zeroStats = () => ({ expected: { breakfast: 0, lunch: 0 }, missing: { breakfast: 0, lunch: 0 } });

/**
 * Lý do ghi vào settings/checkinSync: ai đăng nhập cũng đọc được document đó, mà
 * lỗi trả về từ endpoint hay Microsoft Graph có thể kèm địa chỉ người nhận — che
 * đi trước khi ghi, và cắt độ dài.
 * @param {unknown} reason
 */
export const publicReason = reason =>
  reason ? clip(String(reason).replace(/[^\s@"'<>()]+@[^\s@"'<>()]+/g, '[email]'), 1000) : null;

/**
 * Một mục `alerts[date]` trong settings/checkinSync — trạng thái thư THIẾU CHẤM
 * của ngày đó. (Thư chấm chưa đăng ký ghi riêng ở `alerts[date].extra`, xem
 * extraEntry; ghi mục này bằng set merge không đụng tới phần đó.)
 * @param {'sent' | 'partial' | 'guarded' | 'nothing' | 'error' | 'off_day'} status
 * @param {string} at ISO
 * @param {{ sent?: number, failed?: number, stats?: AlertStats | null, reason?: string | null, held?: boolean, invalidExemptions?: number }} [extra]
 *   held: chốt an toàn đã dừng gửi vì dữ liệu ngày này đáng ngờ. Trang "Chấm ăn
 *   của tôi" và tab quản trị đọc cờ này để KHÔNG kết luận "Chưa chấm" cho ngày
 *   đó — dừng gửi email mà trang vẫn hiện vi phạm thì chốt an toàn mất tác dụng.
 *   Cờ tự gỡ khi một lần chạy sau thấy dữ liệu ổn và ghi mục mới không có held.
 *   invalidExemptions: SỐ tài liệu miễn chấm hỏng agent thấy khi xét ngày này
 *   (chỉ số đếm — mã tài liệu và lý do chỉ in ra log trên máy HAC).
 */
export function alertEntry(status, at, { sent = 0, failed = 0, stats = null, reason = null, held = false, invalidExemptions } = {}) {
  const s = stats || zeroStats();
  return {
    status,
    at,
    held,
    sent,
    failed,
    expected: { breakfast: s.expected.breakfast, lunch: s.expected.lunch },
    missing: { breakfast: s.missing.breakfast, lunch: s.missing.lunch },
    ...(s.exempt ? { exempt: { breakfast: s.exempt.breakfast, lunch: s.exempt.lunch } } : {}),
    ...(Number.isInteger(invalidExemptions) && /** @type {number} */ (invalidExemptions) >= 0 ? { invalidExemptions } : {}),
    reason: publicReason(reason),
  };
}

// ------------------------------------------------------------ ngày xét

/** Số ngày lùi tối đa để tìm ngày có suất ăn trước đó (nghỉ dài hơn thì thôi). */
export const PREVIOUS_MEAL_DAY_LOOKBACK = 7;

/**
 * Ngày có suất ăn gần nhất TRƯỚC `date`, lùi tối đa `maxDays` ngày; null nếu không có.
 * @param {string} date @param {Iterable<string>} [offDays] @param {number} [maxDays]
 */
export function previousMealDay(date, offDays = [], maxDays = PREVIOUS_MEAL_DAY_LOOKBACK) {
  const off = new Set(offDays);
  for (let i = 1; i <= maxDays; i++) {
    const d = addDays(date, -i);
    if (isMealDay(d, off)) return d;
  }
  return null;
}

/**
 * Ngày xét của hai loại thư trong một lần chạy:
 *   - missing: hôm nay;
 *   - extra:   ngày có suất ăn trước hôm nay (null nếu 7 ngày trước đều nghỉ).
 * --alerts-date X (chỉ để xem thử): cả hai loại xét đúng ngày X.
 * @param {{ today: string, alertsDate?: string | null, offDays?: Iterable<string> }} input
 * @returns {{ missing: string, extra: string | null }}
 */
export function alertDates({ today, alertsDate = null, offDays = [] }) {
  if (alertsDate) return { missing: alertsDate, extra: alertsDate };
  return { missing: today, extra: previousMealDay(today, offDays) };
}

// ---------------------------------------------------- thư thiếu chấm (missing)

/**
 * Các cửa chặn trước khi tính toán (bước 2–5 của thư thiếu chấm).
 *
 * @param {{
 *   date: string,                       // ngày xét cảnh báo
 *   now: Date,
 *   nowVn: { date: string, time: string },
 *   offDays?: Iterable<string>,
 *   notBefore: string,                  // HH:MM
 *   coverageAt: string | null,          // lần đồng bộ đủ mọi máy có phủ ngày này (null = chưa có)
 *   failedDevices?: string[],
 *   idleDevices?: string[],             // máy trả lời được nhưng không có lượt chấm nào của ngày này
 *   configProblems?: string[],          // lỗi cấu hình alerts (chạy thật thì chặn trước mọi bước sau)
 *   existing?: { status?: string, sent?: number, failed?: number, expected?: PerMeal, missing?: PerMeal } | null,
 *   ignoreTime?: boolean,               // --alerts-date: xem thử ngày cũ, bỏ qua kiểm tra giờ
 * }} input
 * @returns {{ proceed: boolean, code: 'off_day' | 'bad_config' | 'too_early' | 'device_idle' | 'incomplete' | 'already_sent' | 'ok', write: ReturnType<typeof alertEntry> | null, message: string }}
 *   device_idle: không gửi cho CBNV, nhưng nơi gọi đi tiếp tới bước chốt an toàn
 *   (dừng với lý do `message`, báo quản trị một lần trong ngày).
 */
export function alertGate({ date, now, nowVn, offDays = [], notBefore, coverageAt, failedDevices = [], idleDevices = [], configProblems = [], existing = null, ignoreTime = false }) {
  const at = now.toISOString();
  // Không ghi đè 'sent' (đã xong việc). Cũng không ghi đè 'guarded': trạng
  // thái đó là dấu hiệu đã báo quản trị trong ngày — mất nó thì lần chốt an
  // toàn sau sẽ gửi email báo quản trị thêm lần nữa.
  const keep = existing?.status === 'sent' || existing?.status === 'guarded';
  const errorEntry = (/** @type {string} */ reason) => keep ? null : alertEntry('error', at, {
    sent: existing?.sent ?? 0,
    failed: existing?.failed ?? 0,
    stats: existing?.expected && existing?.missing ? { expected: existing.expected, missing: existing.missing } : null,
    reason,
    // Lần chạy lỗi không làm dữ liệu đáng tin hơn: ngày đang bị treo vẫn treo.
    held: /** @type {any} */ (existing)?.held === true,
  });

  if (!isMealDay(date, offDays)) {
    return {
      proceed: false,
      code: 'off_day',
      write: existing ? null : alertEntry('off_day', at, { reason: 'Không phải ngày có suất ăn (cuối tuần hoặc ngày nghỉ).' }),
      message: `${dateLabelOf(date)} không phải ngày có suất ăn — không gửi cảnh báo.`,
    };
  }

  // Cấu hình sai phải chặn TRƯỚC kiểm tra giờ: notBefore sai dạng (vd. "1:40")
  // so chuỗi với giờ hiện tại thì lúc nào cũng ra "chưa tới giờ" — cảnh báo tắt
  // lặng lẽ, mã thoát 0, không để lại dấu vết gì.
  const problems = [...configProblems];
  if (!ignoreTime && !HHMM_RE.test(String(notBefore)) && !problems.some(p => p.includes('notBefore'))) {
    problems.push('alerts.notBefore phải dạng HH:MM, ví dụ "13:40".');
  }
  if (problems.length) {
    const reason = `Cấu hình alerts trong config.json của agent chưa đúng: ${problems.join(' ')}`;
    return { proceed: false, code: 'bad_config', write: errorEntry(reason), message: reason };
  }

  if (!ignoreTime && nowVn.time < notBefore) {
    return {
      proceed: false,
      code: 'too_early',
      write: null,
      message: `Mới ${nowVn.time}, chưa tới giờ gửi cảnh báo (${notBefore}).`,
    };
  }

  if (!coverageAt && !failedDevices.length && idleDevices.length) {
    // Máy trả lời bình thường mà không có lượt chấm nào trong ngày (thường do
    // lệch giờ sau khi mất điện, vừa bị xoá bộ nhớ, hoặc cả trường không ăn):
    // người ăn ở máy đó sẽ bị coi oan là chưa chấm nếu cứ gửi. Đây là số liệu
    // bất thường chứ không phải máy lỗi — đi đường CHỐT AN TOÀN (báo quản trị
    // một lần/ngày), như trường hợp "không ai chấm" của hợp đồng.
    if (existing?.status === 'sent') {
      return { proceed: false, code: 'already_sent', write: null, message: `Cảnh báo ${dateLabelOf(date)} đã gửi xong.` };
    }
    return {
      proceed: false,
      code: 'device_idle',
      write: null,
      message: `Máy ${idleDevices.join(', ')} trả lời được nhưng không có lượt chấm nào trong ngày — nghi máy lệch giờ, khởi động lại hoặc mất dữ liệu; ` +
        'người ăn ở máy đó sẽ bị coi oan là chưa chấm.',
    };
  }

  if (!coverageAt) {
    const reason = failedDevices.length
      ? `Lần đồng bộ lúc ${formatVnDateTime(at)} không đủ máy (lỗi: ${failedDevices.join(', ')}). Chưa gửi cảnh báo; sẽ thử lại ở lần chạy sau.`
      : 'Chưa có lần đồng bộ đủ mọi máy nào phủ ngày này. Chưa gửi cảnh báo.';
    return { proceed: false, code: 'incomplete', write: errorEntry(reason), message: reason };
  }

  if (existing?.status === 'sent') {
    return { proceed: false, code: 'already_sent', write: null, message: `Cảnh báo ${dateLabelOf(date)} đã gửi xong.` };
  }

  return { proceed: true, code: 'ok', write: null, message: '' };
}

/**
 * @typedef {object} AlertRegistration
 * @property {string} uid
 * @property {string} [userId]
 * @property {unknown} employeeId
 * @property {string} [fullName]
 * @property {string} [email]        email tài khoản (Firebase Auth) — để khớp danh sách miễn chấm
 * @property {string} [month]
 * @property {number} breakfastCount
 * @property {number} lunchCount
 * @property {string} [firstMealDate]
 * @property {string} [timestamp]
 */

/**
 * @typedef {object} AlertCandidate
 * @property {string} uid
 * @property {string} employeeId   đã chuẩn hoá
 * @property {string} fullName
 * @property {Meal[]} meals        bữa cần báo
 * @property {string[]} outOfWindow lượt chấm ngoài khung trong ngày (tối đa 10)
 * @property {Partial<Record<Meal, string>>} [tapTimes]  (thư chấm chưa đăng ký) giờ chấm trong khung
 * @property {Partial<Record<Meal, string>>} [reasons]   (thư chấm chưa đăng ký) vì sao không có suất
 * @property {'month' | 'lookback'} [anchor]             (thư chấm chưa đăng ký) gắn tài khoản theo đơn nào
 */

/**
 * Ai đăng ký mà không chấm trong ngày `date` (bước 7–9).
 *
 * @param {{
 *   date: string,
 *   registrations: AlertRegistration[],                 // đơn của tháng chứa `date`
 *   cancelations?: import('./meal-rules.mjs').Cancelation[],  // các lần hủy có cancelDate == date
 *   excludedIds?: Iterable<string>,
 *   offDays?: Iterable<string>,
 *   checkinExemptions?: import('./checkin-exemptions.mjs').CheckinExemption[],  // chính sách miễn chấm HỢP LỆ
 *   quarantinedIds?: Iterable<string>,  // mã có tài liệu miễn chấm hỏng: chưa biết có được miễn không
 *   people: Record<string, { times?: unknown }> | Map<string, string[]> | null | undefined,  // checkins/{date}.people sau khi gộp
 *   coverageAt: string | null,
 *   now: Date,
 * }} input
 */
export function planAlerts({ date, registrations, cancelations = [], excludedIds = [], offDays = [], checkinExemptions = [], quarantinedIds = [], people, coverageAt, now }) {
  const taps = people instanceof Map ? people : normalizePeople(people);
  const excluded = new Set([...excludedIds].map(normId));
  const quarantined = new Set([...quarantinedIds].map(normId));
  const checkinExemptionMatcher = createCheckinExemptionMatcher(checkinExemptions);

  /** @type {{ unusable: string[], excluded: string[], duplicate: string[], quarantined: string[] }} */
  const skipped = { unusable: [], excluded: [], duplicate: [], quarantined: [] };

  /** @type {Map<string, AlertRegistration[]>} */
  const byId = new Map();
  for (const r of registrations) {
    const id = normId(r.employeeId);
    if (!isUsableId(id)) { skipped.unusable.push(r.uid); continue; }
    if (excluded.has(id)) { skipped.excluded.push(id); continue; }
    const list = byId.get(id);
    if (list) list.push(r); else byId.set(id, [r]);
  }

  // `exempt` luôn có (kể cả 0): mục alerts[date] ghi bằng set merge, thiếu trường
  // thì số của lần ghi trước còn nằm lại.
  /** @type {Required<AlertStats>} */
  const stats = { ...zeroStats(), exempt: { breakfast: 0, lunch: 0 } };
  /** @type {AlertCandidate[]} */
  const candidates = [];

  // Hai đơn (hai tài khoản) cùng một mã đã có hiệu lực hôm nay: lượt chấm của
  // mã đó là của ai thì không biết, cảnh báo ai cũng có thể oan. Bỏ cả hai,
  // quản trị xử lý tay. Cùng định nghĩa với tab quản trị (duplicateIdsOn).
  const duplicated = duplicateIdsOn(registrations.map(r => ({ ...r, userId: r.userId || r.uid })), date);

  for (const [id, regs] of byId) {
    if (duplicated.has(id)) { skipped.duplicate.push(id); continue; }
    // Tài liệu miễn chấm của mã này bị hỏng: không biết người này có được miễn
    // hay không — gửi là có thể gửi oan. Bỏ như mã trùng, chờ quản trị sửa.
    if (quarantined.has(id)) { skipped.quarantined.push(id); continue; }
    // Cùng mã nhưng đơn kia chưa có hiệu lực hôm nay (vd. nộp chiều nay sau giờ
    // ăn): chỉ đơn đã có hiệu lực được xét.
    const live = regs.length > 1
      ? regs.filter(r => { const from = registrationEffectiveFrom(/** @type {any} */ (r)); return !from || from <= date; })
      : regs;
    if (!live.length) continue;
    const reg = { ...live[0], userId: live[0].userId || live[0].uid };

    // Cùng quy tắc với buildCancelSet (meal-rules.mjs): lần hủy có tài khoản chỉ
    // hủy bữa của chính tài khoản đó; lần hủy cũ không có tài khoản thì khớp
    // theo mã. Nhờ vậy email, trang cá nhân và tab quản trị thấy cùng một tập
    // báo hủy.
    const mine = cancelations.filter(c => (c.userId ? c.userId === reg.userId : normId(c.employeeId) === id));

    const ev = evaluatePersonDay({
      date,
      registration: /** @type {any} */ (reg),
      cancelations: mine,
      times: taps.get(id) || [],
      offDays,
      excludedIds: excluded,
      checkinExemptionMatcher,
      coverageAt,
      now,
    });

    /** @type {Meal[]} */
    const missingMeals = [];
    for (const m of MEALS) {
      const code = ev.meals[m].code;
      if (code === 'ok' || code === 'missing' || code === 'pending' || code === 'exempt') stats.expected[m]++;
      if (code === 'exempt') stats.exempt[m]++;
      if (code === 'missing') { stats.missing[m]++; missingMeals.push(m); }
    }
    if (missingMeals.length) {
      candidates.push({
        uid: reg.uid,
        employeeId: id,
        fullName: oneLine(reg.fullName, 100),
        meals: missingMeals,
        outOfWindow: uniqSorted(ev.unrecognized).slice(0, 10),
      });
    }
  }

  // Số người có ít nhất một lượt chấm trong khung giờ ăn — tính cả người
  // không đăng ký. Bằng 0 vào một ngày có suất ăn nghĩa là máy hoặc đồng bộ có
  // vấn đề, không phải cả trường bỏ ăn.
  let tappers = 0;
  for (const times of taps.values()) if (times.some(t => classifyTime(t))) tappers++;

  return { stats, candidates, skipped, tappers };
}

/**
 * Số người còn phải chấm của một bữa (mẫu số của "chưa chấm x/y"): người được
 * miễn chấm không tính, kèm ghi chú để người đọc biết vì sao nhỏ hơn số đăng ký.
 * @param {AlertStats} stats @param {Meal} meal
 */
export function mealCounts(stats, meal) {
  const exempt = stats.exempt?.[meal] || 0;
  return {
    expected: stats.expected[meal] - exempt,
    missing: stats.missing[meal],
    exempt,
    note: exempt > 0 ? ` (không tính ${exempt} người được miễn chấm)` : '',
  };
}

/**
 * Danh sách miễn chấm có tài liệu hỏng KHÔNG nêu được mã NV: không biết người nào
 * đang được miễn, nên giữ lại CẢ loại thư thiếu chấm của ngày (trạng thái error)
 * cho tới khi quản trị sửa. Tài liệu hỏng có nêu mã thì chỉ giữ người đó
 * (quarantinedIds của planAlerts). Không ảnh hưởng thư chấm chưa đăng ký.
 * @param {{ unidentified: number }} quarantine kết quả exemptionQuarantine()
 * @returns {string | null} lý do giữ lại, hoặc null nếu không cần
 */
export function exemptionHold(quarantine) {
  const n = quarantine?.unidentified || 0;
  if (n <= 0) return null;
  return `Danh sách miễn chấm ăn có ${n} tài liệu hỏng không xác định được mã nhân viên, nên chưa biết ai đang được miễn — ` +
    'tạm dừng toàn bộ thư cảnh báo thiếu chấm của ngày này để không gửi nhầm. ' +
    'Quản trị sửa hoặc xoá tài liệu đó ở trang Quản trị (mục Miễn chấm ăn theo bữa); lần chạy sau sẽ tự kiểm tra lại.';
}

/**
 * Chính sách miễn chấm đang có hiệu lực ngày `date` mà KHÔNG áp được cho ai — để
 * in ra log trên máy HAC (không ghi lên hệ thống):
 *   - unmatched: mã không đứng trên đơn đăng ký nào của tháng;
 *   - emailMismatch: có đơn mang mã đó nhưng email tài khoản khác email trong
 *     danh sách (chính sách chỉ áp khi khớp CẢ mã NV lẫn email).
 * @param {{ date: string, policies: import('./checkin-exemptions.mjs').CheckinExemption[], registrations: AlertRegistration[] }} input
 */
export function exemptionAudit({ date, policies, registrations }) {
  const match = createCheckinExemptionMatcher(policies);
  /** @type {Map<string, AlertRegistration[]>} */
  const byId = new Map();
  for (const r of registrations) {
    const id = normId(r.employeeId);
    if (!isUsableId(id)) continue;
    const list = byId.get(id);
    if (list) list.push(r); else byId.set(id, [r]);
  }
  let active = 0;
  /** @type {string[]} */ const unmatched = [];
  /** @type {string[]} */ const emailMismatch = [];
  for (const policy of policies) {
    const meals = MEALS.filter(m => exemptionCovers(policy, date, m));
    if (!meals.length) continue;
    active++;
    const regs = byId.get(policy.employeeId) || [];
    if (!regs.length) { unmatched.push(policy.employeeId); continue; }
    if (regs.some(r => meals.some(meal => match.emailMismatch({ date, employeeId: policy.employeeId, email: r.email, meal })))) {
      emailMismatch.push(policy.employeeId);
    }
  }
  return { active, unmatched, emailMismatch };
}

// ------------------------------------------------- thư chấm chưa đăng ký (extra)

/** Trạng thái `alerts[ngày].extra` mà lần chạy sau KHÔNG xét lại ngày đó nữa. */
export const TERMINAL_EXTRA_STATUSES = Object.freeze(['sent', 'nothing', 'guarded', 'off_day']);
/** @param {unknown} status */
export const isTerminalExtraStatus = status => TERMINAL_EXTRA_STATUSES.includes(/** @type {any} */ (status));

/** Lý do ghi khi API email trên web còn là bản cũ (xem isOldApiKindRejection). */
export const OLD_API_EXTRA_REASON = 'API email (/api/meal-alerts) chưa hỗ trợ thư cảnh báo chấm chưa đăng ký — cần triển khai bản web mới trước.';

/** Nhãn ngắn của lý do, chỉ để in ra log. */
export const EXTRA_REASON_LOG = Object.freeze({
  no_registration: 'chưa có đơn tháng',
  meal_not_registered: 'đơn không gồm bữa này',
  before_start: 'trước ngày bắt đầu ăn trên đơn',
  registered_late: 'nộp đơn sau bữa ăn',
  canceled: 'đã báo hủy',
});

/**
 * `alerts[ngày].extra` trong settings/checkinSync — trạng thái thư chấm chưa đăng
 * ký của NGÀY ĐÓ (ghi ở lần chạy của ngày có suất ăn kế tiếp). Chỉ số đếm: không
 * bao giờ có mã NV, họ tên hay email (mọi người đã đăng nhập đều đọc được).
 * Ghi đủ mọi trường mỗi lần (reason: null) để set merge không giữ lại số cũ.
 * @param {'sent' | 'nothing' | 'partial' | 'guarded' | 'error' | 'off_day'} status
 * @param {string} at ISO
 * @param {{ candidates?: number, sent?: number, failed?: number, uncertain?: number, unmapped?: number, eventSkipped?: number, reason?: string | null }} [info]
 */
export function extraEntry(status, at, { candidates = 0, sent = 0, failed = 0, uncertain = 0, unmapped = 0, eventSkipped = 0, reason = null } = {}) {
  return { status, at, candidates, sent, failed, ...(uncertain > 0 ? { uncertain } : {}), unmapped, eventSkipped, reason: publicReason(reason) };
}

/**
 * Các cửa chặn của thư chấm chưa đăng ký. Độc lập với kết quả cửa chặn của thư
 * thiếu chấm hôm nay ('sent', 'chưa đủ máy'... không chặn được loại này), nhưng
 * vẫn theo alerts.enabled (nơi gọi), cấu hình (khoá...), giờ notBefore và dữ liệu
 * đã chốt của chính ngày xét.
 *
 * @param {{
 *   date: string,                     // ngày xét (ngày có suất ăn trước hôm nay)
 *   now: Date,
 *   nowVn: { date: string, time: string },
 *   offDays?: Iterable<string>,
 *   notBefore: string,
 *   coverageAt: string | null,        // mốc đồng bộ đủ máy mới nhất của ngày xét
 *   configProblems?: string[],
 *   existing?: { status?: string, candidates?: number, sent?: number, failed?: number, unmapped?: number, eventSkipped?: number } | null,  // alerts[date].extra
 *   held?: boolean,                   // alerts[date].held: chốt an toàn của thư thiếu chấm đã treo ngày này
 *   ignoreTime?: boolean,
 * }} input
 * @returns {{ proceed: boolean, code: 'done' | 'off_day' | 'bad_config' | 'too_early' | 'held' | 'no_coverage' | 'ok', write: ReturnType<typeof extraEntry> | null, meals: Meal[], message: string }}
 *   meals: các bữa đã chốt của ngày xét — chỉ những bữa này được xét.
 *   held: dữ liệu ngày đó bị coi là bất thường — trang "Chấm ăn của tôi" và tab
 *   Đối soát không kết luận gì cho ngày đó, nên thư này cũng không được kết luận
 *   ("email và trang cá nhân không bao giờ nói hai điều khác nhau"). Ghi
 *   'guarded' (xong hẳn), không báo quản trị lần nữa.
 */
export function extraGate({ date, now, nowVn, offDays = [], notBefore, coverageAt, configProblems = [], existing = null, held = false, ignoreTime = false }) {
  const at = now.toISOString();
  const label = dateLabelOf(date);
  const meals = MEALS.filter(m => isMealFinal(date, m, coverageAt, now));
  const errorEntry = (/** @type {string} */ reason) => extraEntry('error', at, {
    candidates: existing?.candidates ?? 0,
    sent: existing?.sent ?? 0,
    failed: existing?.failed ?? 0,
    unmapped: existing?.unmapped ?? 0,
    eventSkipped: existing?.eventSkipped ?? 0,
    reason,
  });

  // Đã xong (kể cả 'guarded' — đã báo quản trị) thì không xét lại, không ghi đè.
  if (isTerminalExtraStatus(existing?.status)) {
    return { proceed: false, code: 'done', write: null, meals, message: `Thư chấm chưa đăng ký ${label} đã xử lý xong (trạng thái ${existing?.status}).` };
  }
  if (!isMealDay(date, offDays)) {
    return {
      proceed: false,
      code: 'off_day',
      write: extraEntry('off_day', at, { reason: 'Không phải ngày có suất ăn (cuối tuần hoặc ngày nghỉ).' }),
      meals: [],
      message: `${label} không phải ngày có suất ăn — không gửi thư chấm chưa đăng ký.`,
    };
  }
  const problems = [...configProblems];
  if (!ignoreTime && !HHMM_RE.test(String(notBefore)) && !problems.some(p => p.includes('notBefore'))) {
    problems.push('alerts.notBefore phải dạng HH:MM, ví dụ "13:40".');
  }
  if (problems.length) {
    const reason = `Cấu hình alerts trong config.json của agent chưa đúng: ${problems.join(' ')}`;
    return { proceed: false, code: 'bad_config', write: errorEntry(reason), meals, message: reason };
  }
  if (!ignoreTime && nowVn.time < notBefore) {
    return { proceed: false, code: 'too_early', write: null, meals, message: `Mới ${nowVn.time}, chưa tới giờ gửi cảnh báo (${notBefore}).` };
  }
  if (held) {
    const reason = `Ngày ${label} đang bị chốt an toàn treo lại (dữ liệu máy nhận diện bất thường, xem lý do ở trạng thái thư thiếu chấm của ngày đó): ` +
      'trang Chấm ăn của tôi và tab Đối soát chưa kết luận ngày này, nên không gửi thư chấm chưa đăng ký.';
    return {
      proceed: false,
      code: 'held',
      write: extraEntry('guarded', at, {
        candidates: existing?.candidates ?? 0,
        sent: existing?.sent ?? 0,
        unmapped: existing?.unmapped ?? 0,
        eventSkipped: existing?.eventSkipped ?? 0,
        reason,
      }),
      meals,
      message: reason,
    };
  }
  if (!meals.length) {
    const reason = `Chưa có lần đồng bộ đủ mọi máy phủ ngày ${label} sau giờ ăn — chưa gửi thư chấm chưa đăng ký; sẽ thử lại ở lần chạy sau.`;
    return { proceed: false, code: 'no_coverage', write: errorEntry(reason), meals, message: reason };
  }
  // Ngày đã qua mà mới chốt được một bữa (vd. mốc đồng bộ đủ máy cuối cùng là
  // lần 08:15): xử lý luôn thì trạng thái thành "xong" và lượt chấm bữa còn lại
  // không bao giờ được xét. Chờ chốt đủ mọi bữa — lần đồng bộ sau (22:00 lấy lại
  // 7 ngày) sẽ bù. Chạy xem trước cho chính hôm nay thì xét các bữa đã chốt.
  if (meals.length < MEALS.length && nowVn?.date && date < nowVn.date) {
    const pending = MEALS.filter(m => !meals.includes(m)).map(m => MEAL_LABEL[m].toLowerCase()).join(', ');
    const reason = `Ngày ${label} chưa chốt dữ liệu ${pending} (chưa có lần đồng bộ đủ mọi máy sau giờ ăn) — chưa gửi thư chấm chưa đăng ký; sẽ thử lại ở lần chạy sau.`;
    return { proceed: false, code: 'no_coverage', write: errorEntry(reason), meals, message: reason };
  }
  return { proceed: true, code: 'ok', write: null, meals, message: '' };
}

/** Số tháng trước tháng của ngày xét được đọc để gắn mã cho người chưa có đơn tháng đó. */
export const LOOKBACK_MONTHS = 3;

/** '2026-11' -> ['2026-10', '2026-09', '2026-08'] @param {string} month @param {number} [count] */
export function lookbackMonths(month, count = LOOKBACK_MONTHS) {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Ai có lượt chấm trong khung giờ một bữa ĐÃ CHỐT mà không có đăng ký phù hợp
 * cho bữa đó, và gửi cho TÀI KHOẢN nào.
 *
 * Mã NV trên máy chỉ được gắn với tài khoản qua ĐƠN ĐĂNG KÝ — không bao giờ qua
 * hồ sơ staff/{uid}: hồ sơ do chính chủ sửa được bất cứ lúc nào, đổi mã trong hồ
 * sơ là "nhận" được giờ ăn của người khác (cùng lý do với buildOwnerIndex).
 *   (a) mã đứng trên đơn tháng của ngày xét của ĐÚNG MỘT tài khoản: gửi cho tài
 *       khoản đó, lý do từng bữa lấy từ evaluatePersonDay (đơn không gồm bữa, đã
 *       báo hủy, trước ngày bắt đầu, nộp đơn sau bữa). Từ hai tài khoản: bỏ (trùng);
 *   (b) mã không đứng trên đơn nào của tháng: xét đơn của 3 tháng trước (lookback);
 *       chỉ gắn khi đúng MỘT tài khoản từng mang mã đó, tài khoản đó KHÔNG có đơn
 *       tháng này, và không mang mã nào khác trong 3 tháng đó; lý do no_registration;
 *   (c) còn lại: không gửi, chỉ đếm (unmapped) — quản trị đối chiếu ở tab Đối soát.
 * Bỏ hẳn (không đếm) mã không phải 6 chữ số hoặc thuộc danh sách loại trừ (Bếp
 * Vina chấm công), và lượt chấm ngoài khung giờ ăn.
 *
 * lookback = null: chưa đọc đơn các tháng trước. Mã cần tới bước (b) tạm tính là
 * unmapped và `needsLookback` = true — nơi gọi đọc rồi tính lại (chỉ tốn lượt đọc
 * khi thật sự có mã như vậy).
 *
 * @param {{
 *   date: string,
 *   registrations: AlertRegistration[],                  // đơn THẬT của tháng chứa `date`
 *   lookback?: AlertRegistration[] | null,                // đơn THẬT của 3 tháng trước (có `month`)
 *   cancelations?: import('./meal-rules.mjs').Cancelation[],  // cancelDate == date
 *   excludedIds?: Iterable<string>,
 *   offDays?: Iterable<string>,
 *   people: Record<string, { times?: unknown }> | Map<string, string[]> | null | undefined,
 *   coverageAt: string | null,
 *   now: Date,
 * }} input
 */
export function planExtraAlerts({ date, registrations = [], lookback = null, cancelations = [], excludedIds = [], offDays = [], people, coverageAt, now }) {
  /** @type {AlertCandidate[]} */
  const candidates = [];
  /** @type {{ excluded: string[], duplicate: string[], unmapped: string[] }} */
  const skipped = { excluded: [], duplicate: [], unmapped: [] };
  const result = { candidates, skipped, tappers: 0, needsLookback: false, /** @type {Meal[]} */ meals: [] };
  if (!isMealDay(date, offDays)) return result;
  const meals = MEALS.filter(m => isMealFinal(date, m, coverageAt, now));
  result.meals = meals;
  if (!meals.length) return result;
  const taps = people instanceof Map ? people : normalizePeople(people);
  const excluded = new Set([...excludedIds].map(normId));

  /** Mã -> (uid -> đơn) của tháng xét. @type {Map<string, Map<string, AlertRegistration>>} */
  const owners = new Map();
  /** Tài khoản có đơn tháng xét (kể cả đơn chưa có mã dùng được). */
  const monthUids = new Set();
  for (const reg of registrations) {
    const uid = reg.userId || reg.uid;
    if (!isSafeUid(uid)) continue;
    monthUids.add(uid);
    const id = normId(reg.employeeId);
    if (!isUsableId(id)) continue;
    const group = owners.get(id) || new Map();
    if (!group.has(uid)) group.set(uid, reg);
    owners.set(id, group);
  }

  /** Mã -> (uid -> đơn gần nhất) trong 3 tháng trước. @type {Map<string, Map<string, AlertRegistration>>} */
  const backOwners = new Map();
  /** uid -> các mã đã mang trong 3 tháng trước. @type {Map<string, Set<string>>} */
  const backCodes = new Map();
  for (const reg of lookback || []) {
    const uid = reg.userId || reg.uid;
    if (!isSafeUid(uid)) continue;
    const id = normId(reg.employeeId);
    if (!isUsableId(id)) continue;
    const codes = backCodes.get(uid) || new Set();
    codes.add(id);
    backCodes.set(uid, codes);
    const group = backOwners.get(id) || new Map();
    const prev = group.get(uid);
    if (!prev || String(reg.month || '') > String(prev.month || '')) group.set(uid, reg);
    backOwners.set(id, group);
  }

  /** Mỗi tài khoản nhận nhiều nhất một thư cho một ngày. */
  const taken = new Set();
  for (const [id, times] of taps) {
    const rec = classifyTimes(times);
    if (!meals.some(m => rec[m])) continue;     // không có lượt nào trong khung một bữa đã chốt
    if (!isSchoolStaffId(id) || excluded.has(id)) { skipped.excluded.push(id); continue; }
    result.tappers++;

    /** @type {string} */ let uid;
    /** @type {AlertRegistration | null} */ let registration = null;
    /** @type {AlertRegistration} */ let source;
    /** @type {'month' | 'lookback'} */ let anchor;
    const group = owners.get(id);
    if (group && group.size > 1) { skipped.duplicate.push(id); continue; }
    if (group) {
      [[uid, registration]] = group;
      source = registration;
      anchor = 'month';
    } else {
      if (lookback === null) { result.needsLookback = true; skipped.unmapped.push(id); continue; }
      const back = backOwners.get(id);
      const only = back && back.size === 1 ? [...back][0] : null;
      if (!only || monthUids.has(only[0]) || backCodes.get(only[0])?.size !== 1) { skipped.unmapped.push(id); continue; }
      [uid, source] = only;
      anchor = 'lookback';
    }
    if (taken.has(uid)) { skipped.duplicate.push(id); continue; }
    taken.add(uid);

    const mine = cancelations.filter(c => (c.userId ? c.userId === uid : normId(c.employeeId) === id));
    const ev = evaluatePersonDay({
      date,
      registration: registration ? /** @type {any} */ ({ ...registration, userId: uid }) : null,
      cancelations: mine,
      times,
      offDays,
      excludedIds: excluded,
      coverageAt,
      now,
    });
    const extraMeals = meals.filter(m => ev.meals[m].code === 'extra' && ev.meals[m].time);
    if (!extraMeals.length) continue;
    candidates.push({
      uid,
      employeeId: id,
      fullName: oneLine(source.fullName, 100),
      meals: extraMeals,
      outOfWindow: [],
      tapTimes: Object.fromEntries(extraMeals.map(m => [m, /** @type {string} */ (ev.meals[m].time)])),
      reasons: Object.fromEntries(extraMeals.map(m => [m, /** @type {string} */ (ev.meals[m].reason)])),
      anchor,
    });
  }
  return result;
}

// Chốt an toàn của thư chấm chưa đăng ký: nhiều người cùng "chưa đăng ký" một lúc
// thường là do dữ liệu (đơn chưa đọc đủ, máy ghi sai mã) chứ không phải cả trường
// quên đăng ký.
export const EXTRA_GUARD_MIN = 30;
export const EXTRA_GUARD_RATIO = 0.25;

/**
 * @param {{ date: string, candidates: number, tappers: number }} input
 *   candidates: số người sẽ được cảnh báo (sau khi bỏ người ăn sự kiện);
 *   tappers: số mã NV của trường có lượt chấm trong khung bữa đã chốt.
 * @returns {{ stop: boolean, limit: number, reason: string | null }}
 */
export function extraGuard({ date, candidates, tappers }) {
  const limit = Math.max(EXTRA_GUARD_MIN, Math.floor(tappers * EXTRA_GUARD_RATIO));
  if (candidates <= limit) return { stop: false, limit, reason: null };
  return {
    stop: true,
    limit,
    reason: `Đợt thư cảnh báo chấm ăn chưa đăng ký ngày ${dateLabelOf(date)} có ${candidates} người, vượt ngưỡng ${limit} người ` +
      `(mức lớn hơn giữa ${EXTRA_GUARD_MIN} người và ${Math.round(EXTRA_GUARD_RATIO * 100)}% của ${tappers} người có lượt chấm trong khung giờ ăn) — ` +
      'nghi đơn đăng ký chưa được đọc đủ hoặc máy nhận diện ghi sai mã. Đã dừng toàn bộ thư chấm chưa đăng ký của ngày này.',
  };
}

/** Hạn đăng ký sự kiện cách ngày xét không quá chừng này ngày thì coi như sự kiện có thể rơi vào ngày đó. */
export const EVENT_WINDOW_DAYS = 7;
/** Sự kiện còn mở nhưng hạn đăng ký đã qua quá chừng này ngày thì coi là sự kiện cũ quên đóng. */
export const OPEN_EVENT_STALE_DAYS = 30;

/**
 * Sự kiện có thể đã có suất ăn đúng ngày `date`. Sự kiện không lưu ngày diễn ra,
 * chỉ có hạn đăng ký (expiresAt, YYYY-MM-DD) và cờ mở isOpen, nên xét rộng:
 *   - hạn đăng ký nằm trong 7 ngày trước hoặc sau ngày xét; hoặc
 *   - đang mở đăng ký — trừ khi hạn đã qua hơn 7 ngày trước ngày xét (trang đăng
 *     ký tự coi sự kiện quá hạn là đã đóng dù cờ vẫn bật; không loại thì ai từng
 *     chọn "Có ăn" ở một sự kiện cũ quên tắt cờ sẽ không bao giờ được cảnh báo).
 * @param {{ date: string, events: { id?: unknown, isOpen?: unknown, expiresAt?: unknown }[] }} input
 * @returns {string[]}
 */
export function relevantEventIds({ date, events }) {
  const from = addDays(date, -EVENT_WINDOW_DAYS);
  const to = addDays(date, EVENT_WINDOW_DAYS);
  /** @type {string[]} */
  const out = [];
  for (const event of events || []) {
    const id = typeof event?.id === 'string' ? event.id : '';
    if (!id) continue;
    const raw = typeof event.expiresAt === 'string' ? event.expiresAt.slice(0, 10) : '';
    const deadline = isIsoDate(raw) ? raw : null;
    const near = !!deadline && deadline >= from && deadline <= to;
    // Sự kiện còn mở: bữa sự kiện có thể diễn ra sau hạn đăng ký vài tuần, nên
    // vẫn tính — trừ khi hạn đã qua quá OPEN_EVENT_STALE_DAYS ngày (quản trị quên
    // đóng sự kiện cũ thì người từng chọn "Có ăn" không bị bỏ qua mãi mãi).
    const open = event.isOpen === true && !(deadline && deadline < addDays(date, -OPEN_EVENT_STALE_DAYS));
    if (near || open) out.push(id);
  }
  return uniqSorted(out);
}

/**
 * Tài khoản đã chọn "Có ăn" ở một trong các sự kiện `eventIds` — lượt chấm của họ
 * có thể là suất ăn sự kiện, không gửi thư chấm chưa đăng ký.
 * @param {{ eventIds: Iterable<string>, registrations: { userId?: unknown, eventId?: unknown, choice?: unknown }[], uids: Iterable<string> }} input
 * @returns {Set<string>}
 */
export function eventSkipUids({ eventIds, registrations, uids }) {
  const events = new Set(eventIds);
  const wanted = new Set(uids);
  /** @type {Set<string>} */
  const out = new Set();
  for (const r of registrations || []) {
    if (r?.choice !== 'yes' || typeof r.userId !== 'string' || typeof r.eventId !== 'string') continue;
    if (events.has(r.eventId) && wanted.has(r.userId)) out.add(r.userId);
  }
  return out;
}

// ------------------------------------------------------------ nhật ký gửi

/**
 * Khoá nhật ký meal_alerts. Khoá cũ `{ngày}_{uid}` vẫn là biên nhận thư THIẾU
 * CHẤM; thư chấm chưa đăng ký dùng `{ngày}:extra:{uid}`.
 * @param {string} date @param {string} uid @param {'missing' | 'extra'} [kind]
 */
export function alertJournalKey(date, uid, kind = 'missing') {
  // ':' không bao giờ có trong uid agent dùng (isSafeUid), nên biên nhận thiếu
  // chấm của một uid tự đặt không thể trùng khoá với biên nhận chấm chưa đăng ký.
  return kind === 'extra' ? `${date}:extra:${uid}` : `${date}_${uid}`;
}

/**
 * Tách các dòng nhật ký meal_alerts của một ngày theo loại thư. Dòng không có
 * `kind` (bản cũ) là thư thiếu chấm. Biên nhận extra có delivery:'uncertain'
 * cũng đã được xử lý: không tự gửi lại khi chưa biết thư trước đã đi hay chưa.
 * @param {{ uid?: unknown, kind?: unknown }[]} rows
 */
export function sentAlertsByKind(rows) {
  /** @type {Set<string>} */ const missing = new Set();
  /** @type {Set<string>} */ const extra = new Set();
  for (const row of rows) {
    if (!isSafeUid(row?.uid)) continue;
    const uid = /** @type {string} */ (row.uid);
    if (row.kind === 'extra') extra.add(uid);
    else if (row.kind === undefined || row.kind === 'missing') missing.add(uid);
  }
  return { missing, extra };
}

// Một máy được coi là "thường có người chấm bữa X" nếu trong những ngày gần
// đây có hôm có từ chừng này người chấm bữa X ở máy đó. Dưới ngưỡng (máy của
// bếp không phục vụ bữa sáng, thỉnh thoảng một hai người chấm nhầm máy) thì
// hôm nay 0 lượt cũng là bình thường.
export const MIN_TYPICAL_TAPPERS = 3;

/**
 * @typedef {{ device: string, meal: Meal, typical: number | null }} DeviceGap
 *   typical: số người nhiều nhất từng chấm bữa đó ở máy đó trong các ngày gần
 *   đây; null = chưa có ngày nào để so (vd. ngay sau khi nâng cấp)
 */

/**
 * Máy nào KHÔNG có lượt chấm nào trong khung một bữa đã chốt, trong khi mọi
 * khi máy đó vẫn có người chấm bữa ấy.
 *
 * Vì sao cần riêng kiểm tra này: mỗi máy phục vụ một bếp (Trung học, Tiểu học).
 * Máy trả lời bình thường nhưng mất lượt chấm của một bữa (lệch giờ sau mất
 * điện, khởi động lại giữa buổi) thì người ăn ở bếp đó đều thành "chưa chấm".
 * Bếp nhỏ chiếm dưới ngưỡng maxMissingRatio thì chốt theo tỉ lệ không bắt
 * được, và cả bếp đó nhận email "vi phạm" oan.
 *
 * @param {{
 *   date: string,
 *   devices: string[],                                         // mọi máy trong config
 *   dayParts: Record<string, Record<string, { times?: unknown }>> | null | undefined,  // byDevice của ngày xét
 *   history: { date: string, byDevice?: Record<string, Record<string, { times?: unknown }>> | null }[],
 *   offDays?: Iterable<string>,
 *   meals: Meal[],                                             // các bữa đã chốt cần xét
 *   minTypical?: number,
 * }} input
 * @returns {{ gaps: DeviceGap[], unknown: boolean }}
 *   unknown: ngày xét không có dữ liệu theo từng máy (document dạng cũ) nên không kiểm tra được
 */
export function deviceMealGaps({ date, devices, dayParts, history, offDays = [], meals, minTypical = MIN_TYPICAL_TAPPERS }) {
  if (!dayParts || typeof dayParts !== 'object') return { gaps: [], unknown: true };
  const off = [...offDays];
  /** Số người có ít nhất một lượt trong khung bữa `meal`. */
  const count = (/** @type {Record<string, { times?: unknown }> | undefined} */ part, /** @type {Meal} */ meal) =>
    Object.values(part || {}).filter(p => Array.isArray(p?.times) && p.times.some(t => typeof t === 'string' && HHMM_RE.test(t) && classifyTime(t) === meal)).length;

  /** @type {DeviceGap[]} */
  const gaps = [];
  for (const device of devices) {
    for (const meal of meals) {
      if (count(dayParts[device], meal) > 0) continue;
      let seen = false;
      let typical = 0;
      for (const h of history) {
        if (!h || h.date >= date || !isMealDay(h.date, off)) continue;
        const part = h.byDevice && typeof h.byDevice === 'object' ? h.byDevice[device] : undefined;
        // Ngày máy không có phần (document dạng cũ, hoặc máy không phủ ngày đó)
        // thì không dùng để so.
        if (!part || typeof part !== 'object') continue;
        seen = true;
        typical = Math.max(typical, count(part, meal));
      }
      // Chưa có ngày nào để so thì nghiêng về phía an toàn: coi là bất thường.
      if (!seen || typical >= minTypical) gaps.push({ device, meal, typical: seen ? typical : null });
    }
  }
  return { gaps, unknown: false };
}

/**
 * Chốt an toàn (bước 10): dừng cả đợt nếu số liệu trông bất thường.
 *
 * @param {{ stats: AlertStats, tappers: number, minExpected: number, maxMissingRatio: number, deviceGaps?: DeviceGap[] }} input
 * @returns {{ stop: boolean, reason: string | null }}
 */
export function guardVerdict({ stats, tappers, minExpected, maxMissingRatio, deviceGaps = [] }) {
  if (tappers === 0) {
    return {
      stop: true,
      reason: 'Hôm nay máy nhận diện không ghi nhận lượt chấm nào trong khung giờ ăn — nhiều khả năng máy hoặc việc đồng bộ có sự cố.',
    };
  }
  if (deviceGaps.length) {
    const list = deviceGaps.map(g =>
      `máy ${g.device} không có lượt chấm nào trong khung ${MEAL_LABEL[g.meal]} (${windowLabel(g.meal)})` +
      (g.typical !== null ? `, những ngày gần đây thường có tới ${g.typical} người` : ', chưa có dữ liệu những ngày trước để so')
    );
    return {
      stop: true,
      reason: `Dữ liệu một máy nhận diện bất thường — ${list.join('; ')}. Nghi máy lệch giờ, khởi động lại hoặc mất dữ liệu; ` +
        'người ăn ở máy đó sẽ bị coi oan là chưa chấm.',
    };
  }
  const reasons = [];
  for (const m of MEALS) {
    // Người được miễn chấm không tính vào mẫu số: họ không thể "chưa chấm".
    const { expected, missing } = mealCounts(stats, m);
    // Ngày ít người ăn (expected nhỏ) thì tỉ lệ dao động mạnh, không đủ căn cứ
    // để dừng — minExpected là ngưỡng bắt đầu xét tỉ lệ.
    if (expected > 0 && expected >= minExpected && missing / expected > maxMissingRatio) {
      reasons.push(
        `${MEAL_LABEL[m]}: ${missing}/${expected} người đăng ký chưa có lượt chấm ` +
        `(${Math.round((missing / expected) * 100)}%, ngưỡng ${Math.round(maxMissingRatio * 100)}%)`
      );
    }
  }
  if (reasons.length) {
    return {
      stop: true,
      reason: `Tỉ lệ chưa chấm cao bất thường — ${reasons.join('; ')}. Có thể một máy nhận diện lỗi hoặc lệch giờ.`,
    };
  }
  return { stop: false, reason: null };
}

/**
 * Những uid cần tra email (bỏ người đã được gửi hôm nay, đỡ tốn lượt gọi).
 * @param {AlertCandidate[]} candidates
 * @param {Set<string>} alreadySent
 */
export const uidsToLookup = (candidates, alreadySent) =>
  candidates.filter(c => !alreadySent.has(c.uid)).map(c => c.uid);

/**
 * Người nhận cuối cùng (bước 11).
 *
 * Email lấy từ Firebase Auth chứ KHÔNG lấy trên đơn đăng ký: trường email trên
 * đơn do trình duyệt tự ghi, ai cũng sửa được thành địa chỉ bất kỳ.
 *
 * @param {{ candidates: AlertCandidate[], alreadySent: Set<string>, emails: Map<string, string | undefined> }} input
 */
export function selectRecipients({ candidates, alreadySent, emails }) {
  /** @type {(AlertCandidate & { to: string })[]} */
  const recipients = [];
  /** @type {{ alreadySent: string[], noEmail: string[], outsideDomain: string[], duplicateEmail: string[] }} */
  const skipped = { alreadySent: [], noEmail: [], outsideDomain: [], duplicateEmail: [] };
  const seen = new Set();
  for (const c of candidates) {
    if (alreadySent.has(c.uid)) { skipped.alreadySent.push(c.uid); continue; }
    const email = String(emails.get(c.uid) || '').trim();
    if (!email) { skipped.noEmail.push(c.uid); continue; }
    if (!isSendableEmail(email)) { skipped.outsideDomain.push(c.uid); continue; }
    // Hai tài khoản cùng một địa chỉ (hiếm, nhưng endpoint sẽ từ chối cả lô vì
    // địa chỉ lặp): chỉ gửi một lần.
    const key = email.toLowerCase();
    if (seen.has(key)) { skipped.duplicateEmail.push(c.uid); continue; }
    seen.add(key);
    recipients.push({ ...c, to: email });
  }
  return { recipients, skipped };
}

/**
 * Chia người nhận thành các request gửi endpoint (Body A của hợp đồng). Thư chấm
 * chưa đăng ký ('staff-extra') có thêm giờ chấm và mã lý do của từng bữa.
 * @param {{ date: string, recipients: (AlertCandidate & { to: string })[], batchSize?: number, kind?: 'missing' | 'extra' }} input
 */
export function buildStaffBodies({ date, recipients, batchSize = ALERT_BATCH_SIZE, kind = 'missing' }) {
  return chunk(recipients, batchSize).map(group => ({
    group,
    body: {
      kind: kind === 'extra' ? 'staff-extra' : 'staff-missing',
      date,
      dateLabel: dateLabelOf(date),
      alerts: group.map(r => ({
        to: r.to,
        fullName: oneLine(r.fullName, 100),
        employeeId: oneLine(r.employeeId, 40),
        meals: r.meals.map(m => ({
          meal: m, label: MEAL_LABEL[m], window: windowLabel(m),
          ...(kind === 'extra' ? { time: r.tapTimes?.[m], reason: r.reasons?.[m] } : {}),
        })),
        outOfWindow: r.outOfWindow.slice(0, 10),
      })),
    },
  }));
}

/** Người nhận email báo quản trị: chỉ email trường, bỏ trùng (không phân biệt hoa thường), tối đa 5. @param {string[]} adminEmails */
function adminRecipients(adminEmails) {
  // Không phân biệt hoa thường khi bỏ trùng: endpoint coi A@ và a@ là lặp.
  const seen = new Set();
  const to = [];
  for (const e of adminEmails.map(x => String(x).trim()).filter(isSendableEmail)) {
    if (seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    to.push(e);
  }
  return to.slice(0, 5);
}

/**
 * Email báo quản trị khi chốt an toàn dừng đợt thư thiếu chấm (Body B).
 *
 * Không đưa tên hay mã NV của ai vào: chỉ số liệu tổng và tình trạng máy, đủ để
 * quản trị biết cần kiểm tra gì.
 *
 * @param {{
 *   date: string,
 *   adminEmails: string[],
 *   reason: string,
 *   stats: AlertStats,
 *   tappers: number,
 *   devices: { name: string, ok: boolean, events: number, error: string | null }[],
 *   agentVersion: string,
 * }} input
 */
export function buildAdminNotice({ date, adminEmails, reason, stats, tappers, devices, agentVersion }) {
  const lines = [
    ...MEALS.map(m => {
      const c = mealCounts(stats, m);
      return `${MEAL_LABEL[m]}: ${c.missing}/${c.expected} người đăng ký chưa có lượt chấm${c.note}.`;
    }),
    `Số người có lượt chấm trong khung giờ ăn hôm nay: ${tappers}.`,
    ...devices.map(d => d.ok
      ? `Máy ${d.name}: đồng bộ được, ${d.events} lượt chấm trong khoảng ngày đã lấy.`
      : `Máy ${d.name}: LỖI — ${d.error || 'không rõ nguyên nhân'}`),
    'Hệ thống đã TẠM DỪNG gửi email cảnh báo cho CBNV trong ngày để tránh cảnh báo oan.',
    'Thầy/Cô vui lòng kiểm tra máy nhận diện (giờ máy, kết nối) và tab Đối soát chấm ăn.',
    'Agent tự kiểm tra lại ở các lần chạy sau trong khung 13:45–14:45; nếu số liệu trở lại bình thường, cảnh báo sẽ được gửi như thường lệ.',
    `Phiên bản agent: ${agentVersion}.`,
  ];
  return {
    kind: 'admin-notice',
    date,
    dateLabel: dateLabelOf(date),
    to: adminRecipients(adminEmails),
    reason: oneLine(reason, 1000),
    // Lỗi của thiết bị thường nhiều dòng; endpoint chỉ nhận mỗi phần tử một dòng.
    lines: lines.map(l => oneLine(l, 300)).filter(Boolean).slice(0, 30),
  };
}

/**
 * Email báo quản trị khi chốt an toàn dừng đợt thư CHẤM CHƯA ĐĂNG KÝ của một ngày
 * (cùng loại 'admin-notice', gửi một lần cho ngày đó). Chỉ số liệu tổng.
 * @param {{ date: string, adminEmails: string[], reason: string, candidates: number, tappers: number, limit: number, unmapped?: number, eventSkipped?: number, agentVersion: string }} input
 */
export function buildExtraAdminNotice({ date, adminEmails, reason, candidates, tappers, limit, unmapped = 0, eventSkipped = 0, agentVersion }) {
  const lines = [
    'Đợt bị dừng: thư cảnh báo "chấm ăn chưa đăng ký" (có lượt chấm trong khung giờ ăn nhưng chưa có đăng ký suất ăn phù hợp).',
    `Số người sẽ nhận thư: ${candidates} (ngưỡng ${limit}).`,
    `Số người có lượt chấm trong khung giờ ăn ngày này: ${tappers}.`,
    ...(unmapped ? [`Số mã có lượt chấm chưa xác định được đúng một tài khoản: ${unmapped}.`] : []),
    ...(eventSkipped ? [`Số người bỏ qua vì có đăng ký suất ăn sự kiện gần ngày này: ${eventSkipped}.`] : []),
    'Hệ thống KHÔNG gửi thư cảnh báo chấm chưa đăng ký nào của ngày này cho CBNV và sẽ không tự gửi lại.',
    'Thầy/Cô vui lòng kiểm tra đơn đăng ký suất ăn của tháng, danh sách loại trừ và tab Đối soát chấm ăn (mục Chấm nhưng không đăng ký).',
    `Phiên bản agent: ${agentVersion}.`,
  ];
  return {
    kind: 'admin-notice',
    date,
    dateLabel: dateLabelOf(date),
    to: adminRecipients(adminEmails),
    reason: oneLine(reason, 1000),
    lines: lines.map(l => oneLine(l, 300)).filter(Boolean).slice(0, 30),
  };
}

/**
 * Trạng thái cuối của đợt gửi (bước 12).
 * @param {{ missingCount: number, failed: number }} input  missingCount: số người cần báo
 * @returns {'partial' | 'nothing' | 'sent'}
 */
export function finalAlertStatus({ missingCount, failed }) {
  if (failed > 0) return 'partial';    // lần chạy sau gửi nốt
  if (missingCount === 0) return 'nothing';
  return 'sent';
}

/**
 * Ghép kết quả endpoint trả về với lô người nhận đã gửi. Thư thiếu chấm giữ cách
 * xử lý cũ. Thư chấm chưa đăng ký: phản hồi thiếu/sai hợp đồng có thể xảy ra SAU
 * khi máy chủ đã gửi thư; ghi riêng là chưa rõ, không khẳng định đã gửi và cũng
 * không tự gửi lại. Chỉ kết quả ok:false rõ ràng mới là lỗi có thể thử lại.
 *
 * @param {{ to: string }[]} group
 * @param {unknown} response
 * @param {{ kind?: 'missing' | 'extra' }} [options]
 * @returns {{ ok: boolean, error: string | null, uncertain?: true }[]}
 */
export function matchResults(group, response, { kind = 'missing' } = {}) {
  const results = /** @type {any} */ (response)?.results;
  const unknownResult = (/** @type {string} */ error) => ({ ok: false, error, ...(kind === 'extra' ? { uncertain: /** @type {true} */ (true) } : {}) });
  if (kind === 'extra' && (!Array.isArray(results) || results.length !== group.length)) {
    return group.map(() => unknownResult('Endpoint không trả đủ kết quả đúng lô người nhận'));
  }
  return group.map((r, i) => {
    const res = Array.isArray(results) ? results[i] : undefined;
    if (!res || typeof res !== 'object' || Array.isArray(res)) return unknownResult('Endpoint không trả kết quả cho người này');
    if (String(res.to || '').toLowerCase() !== r.to.toLowerCase()) return unknownResult('Kết quả endpoint không khớp người nhận');
    if (res.ok === true) return { ok: true, error: null };
    if (kind === 'extra' && (res.ok !== false || (Object.hasOwn(res, 'maybeSent') && res.maybeSent !== false))) {
      return unknownResult(clip(res.error || 'Endpoint chưa xác nhận thư đã gửi hay chưa', 200));
    }
    return { ok: false, error: clip(res.error || 'gửi thất bại', 200) };
  });
}

/**
 * Gửi từng lô tới endpoint và ghi nhật ký `meal_alerts` NGAY sau mỗi lô (bước 12)
 * — dùng chung cho hai loại thư:
 *   - người endpoint báo ok được ghi biên nhận đã gửi. Với thư extra, phản hồi
 *     không rõ được ghi delivery:'uncertain': cần kiểm tra hộp thư thủ công,
 *     không tự thử lại. Thư thiếu chấm giữ nguyên cách xử lý lỗi trước đây;
 *   - không ghi được nhật ký thì DỪNG các lô còn lại: email đã gửi mà không được
 *     ghi nhớ sẽ bị gửi lại ở mỗi lần lặp 15 phút sau đó. Dừng ở đây thì chỉ lô
 *     vừa rồi có thể bị gửi trùng; người còn lại chờ lần chạy sau;
 *   - (thư chấm chưa đăng ký) API email bản cũ từ chối loại thư này bằng 400 nhắc
 *     tới `kind`: dừng loại thư này trong lần chạy (`unsupported`).
 *
 * @param {{
 *   date: string,
 *   kind?: 'missing' | 'extra',
 *   recipients: (AlertCandidate & { to: string })[],
 *   post: (body: unknown) => Promise<unknown>,                                    // gọi endpoint
 *   writeJournal: (rows: { id: string, data: Record<string, unknown> }[]) => Promise<void>,  // ghi meal_alerts (đã có thử lại)
 *   cleanError?: (err: any) => string,                                            // che khoá trong thông báo lỗi
 *   now?: () => string,
 *   log?: (line: string) => void,
 *   batchSize?: number,
 * }} input
 * @returns {Promise<{ sent: number, failed: number, uncertain: number, errorsSeen: string[], journalError: string | null, unsupported: boolean }>}
 */
export async function deliverAlerts({
  date, kind = 'missing', recipients, post, writeJournal,
  cleanError = err => String(err?.message ?? err), now = () => new Date().toISOString(), log = () => {}, batchSize = ALERT_BATCH_SIZE,
}) {
  let sent = 0;
  let failed = 0;
  let uncertain = 0;
  let unsupported = false;
  /** @type {string | null} */
  let journalError = null;
  /** @type {string[]} */
  const errorsSeen = [];
  for (const { group, body } of buildStaffBodies({ date, recipients, batchSize, kind })) {
    if (journalError || unsupported) { failed += group.length; continue; }
    /** @type {{ ok: boolean, error: string | null, uncertain?: true }[]} */
    let results;
    try {
      results = matchResults(group, await post(body), { kind });
    } catch (err) {
      if (kind === 'extra' && isOldApiKindRejection(err)) {
        unsupported = true;
        failed += group.length;
        continue;
      }
      const unknownDelivery = kind === 'extra' && /** @type {any} */ (err)?.delivery !== 'not_sent';
      results = group.map(() => ({ ok: false, error: cleanError(err), ...(unknownDelivery ? { uncertain: /** @type {true} */ (true) } : {}) }));
    }
    const okOnes = group.filter((_, i) => results[i].ok);
    const maybeSent = group.filter((_, i) => results[i].uncertain);
    if (okOnes.length || maybeSent.length) {
      const at = now();
      try {
        await writeJournal([
          ...okOnes.map(r => ({
            id: alertJournalKey(date, r.uid, kind),
            data: { uid: r.uid, date, kind, to: r.to, employeeId: r.employeeId, meals: r.meals, sentAt: at },
          })),
          ...maybeSent.map(r => ({
            id: alertJournalKey(date, r.uid, kind),
            data: { uid: r.uid, date, kind, to: r.to, employeeId: r.employeeId, meals: r.meals, delivery: 'uncertain', attemptedAt: at },
          })),
        ]);
      } catch (err) {
        journalError = String(/** @type {any} */ (err)?.message || err);
        log(`  LỖI: đã gửi ${okOnes.length} email${maybeSent.length ? `, ${maybeSent.length} email chưa rõ đã gửi hay chưa` : ''} nhưng không ghi được nhật ký — DỪNG gửi tiếp; lần sau những người này có thể nhận trùng. ${journalError}`);
      }
    }
    sent += okOnes.length;
    uncertain += maybeSent.length;
    failed += group.length - okOnes.length - maybeSent.length;
    for (const r of results) {
      if (!r.ok && r.error && errorsSeen.length < 3 && !errorsSeen.includes(r.error)) errorsSeen.push(r.error);
    }
  }
  if (journalError) errorsSeen.unshift('không ghi được nhật ký meal_alerts, đã dừng gửi');
  return { sent, failed, uncertain, errorsSeen, journalError, unsupported };
}

/**
 * Phần "vì sao chưa xong" của lý do ghi vào trạng thái (như các bản trước: kèm
 * tối đa 3 lỗi đầu tiên, đã che khoá; địa chỉ email được che lúc ghi).
 * @param {{ failed?: number, uncertain?: number, errorsSeen?: string[], journalError?: string | null, unreachable?: number, kind?: 'missing' | 'extra' }} input
 * @returns {string[]}
 */
export function deliveryNotes({ failed = 0, uncertain = 0, errorsSeen = [], journalError = null, unreachable = 0, kind = 'missing' }) {
  const notes = [];
  if (failed) notes.push(`${failed} email chưa gửi được${errorsSeen.length ? ` (${errorsSeen.join('; ')})` : ''}. Lần chạy sau sẽ gửi nốt.`);
  if (kind === 'extra' && uncertain) notes.push(`${uncertain} email chưa rõ đã gửi hay chưa. Không tự gửi lại; quản trị cần kiểm tra hộp thư trước khi xử lý tiếp.`);
  if (journalError) notes.push(`Lỗi ghi nhật ký: ${journalError}.`);
  if (unreachable) {
    notes.push(kind === 'extra'
      ? `${unreachable} người không có tài khoản đang hoạt động với email của trường, không gửi được.`
      : `${unreachable} người không có email của trường trong tài khoản, không gửi được.`);
  }
  return notes;
}
