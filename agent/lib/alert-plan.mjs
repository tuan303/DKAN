/**
 * Chọn ai nhận email "đăng ký mà không chấm ăn", và quyết định có nên gửi hay
 * không (chốt an toàn).
 *
 * Email này nói với một người rằng họ vi phạm quy định, có thể bị tạm dừng đăng
 * ký tháng sau. Gửi oan một lần là mất lòng tin vào cả hệ thống, nên mọi bước
 * ở đây nghiêng về phía KHÔNG gửi khi có nghi ngờ: dữ liệu chưa chốt thì chờ,
 * mã trùng thì bỏ, số người "chưa chấm" bất thường thì dừng cả đợt và báo quản
 * trị.
 *
 * Kết luận "đáng lẽ ăn / đã chấm / chưa chấm" của từng người lấy NGUYÊN từ
 * evaluatePersonDay() trong meal-rules.mjs — cùng hàm với trang "Chấm ăn của
 * tôi" — để email và trang cá nhân không bao giờ nói hai điều khác nhau.
 *
 * File thuần, không import Node hay Firebase.
 */

import {
  MEALS, MEAL_LABEL, MEAL_WINDOWS, normId, isUsableId, isMealDay, classifyTime,
  evaluatePersonDay, formatDayLabel, formatVnDateTime, duplicateIdsOn, registrationEffectiveFrom,
} from './meal-rules.mjs';
import { chunk, clip, oneLine, uniqSorted, HHMM_RE } from './common.mjs';
import { normalizePeople } from './projection.mjs';

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
/** @typedef {{ expected: PerMeal, missing: PerMeal }} AlertStats */

/** "Thứ 6, 09/10/2026" @param {string} date */
export const dateLabelOf = date => `${formatDayLabel(date)}/${date.slice(0, 4)}`;

/** "05:00–08:00" (gạch nối dài, đúng định dạng endpoint kiểm tra) @param {Meal} meal */
export const windowLabel = meal => `${MEAL_WINDOWS[meal].from}–${MEAL_WINDOWS[meal].to}`;

const zeroStats = () => ({ expected: { breakfast: 0, lunch: 0 }, missing: { breakfast: 0, lunch: 0 } });

/**
 * Một mục `alerts[date]` trong settings/checkinSync.
 * @param {'sent' | 'partial' | 'guarded' | 'nothing' | 'error' | 'off_day'} status
 * @param {string} at ISO
 * @param {{ sent?: number, failed?: number, stats?: AlertStats | null, reason?: string | null, held?: boolean }} [extra]
 *   held: chốt an toàn đã dừng gửi vì dữ liệu ngày này đáng ngờ. Trang "Chấm ăn
 *   của tôi" và tab quản trị đọc cờ này để KHÔNG kết luận "Chưa chấm" cho ngày
 *   đó — dừng gửi email mà trang vẫn hiện vi phạm thì chốt an toàn mất tác dụng.
 *   Cờ tự gỡ khi một lần chạy sau thấy dữ liệu ổn và ghi mục mới không có held.
 */
export function alertEntry(status, at, { sent = 0, failed = 0, stats = null, reason = null, held = false } = {}) {
  const s = stats || zeroStats();
  return {
    status,
    at,
    held,
    sent,
    failed,
    expected: { breakfast: s.expected.breakfast, lunch: s.expected.lunch },
    missing: { breakfast: s.missing.breakfast, lunch: s.missing.lunch },
    // settings/checkinSync ai đăng nhập cũng đọc được; lỗi trả về từ endpoint
    // hay Microsoft Graph có thể kèm địa chỉ người nhận — che đi trước khi ghi.
    reason: reason ? clip(String(reason).replace(/[^\s@"'<>()]+@[^\s@"'<>()]+/g, '[email]'), 1000) : null,
  };
}

/**
 * Các cửa chặn trước khi tính toán (bước 2–5 của pha cảnh báo).
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
 * @property {Meal[]} meals        bữa 'missing'
 * @property {string[]} outOfWindow lượt chấm ngoài khung trong ngày (tối đa 10)
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
 *   people: Record<string, { times?: unknown }> | Map<string, string[]> | null | undefined,  // checkins/{date}.people sau khi gộp
 *   coverageAt: string | null,
 *   now: Date,
 * }} input
 */
export function planAlerts({ date, registrations, cancelations = [], excludedIds = [], offDays = [], people, coverageAt, now }) {
  const taps = people instanceof Map ? people : normalizePeople(people);
  const excluded = new Set([...excludedIds].map(normId));

  /** @type {{ unusable: string[], excluded: string[], duplicate: string[] }} */
  const skipped = { unusable: [], excluded: [], duplicate: [] };

  /** @type {Map<string, AlertRegistration[]>} */
  const byId = new Map();
  for (const r of registrations) {
    const id = normId(r.employeeId);
    if (!isUsableId(id)) { skipped.unusable.push(r.uid); continue; }
    if (excluded.has(id)) { skipped.excluded.push(id); continue; }
    const list = byId.get(id);
    if (list) list.push(r); else byId.set(id, [r]);
  }

  const stats = zeroStats();
  /** @type {AlertCandidate[]} */
  const candidates = [];

  // Hai đơn (hai tài khoản) cùng một mã đã có hiệu lực hôm nay: lượt chấm của
  // mã đó là của ai thì không biết, cảnh báo ai cũng có thể oan. Bỏ cả hai,
  // quản trị xử lý tay. Cùng định nghĩa với tab quản trị (duplicateIdsOn).
  const duplicated = duplicateIdsOn(registrations.map(r => ({ ...r, userId: r.userId || r.uid })), date);

  for (const [id, regs] of byId) {
    if (duplicated.has(id)) { skipped.duplicate.push(id); continue; }
    // Cùng mã nhưng đơn kia chưa có hiệu lực hôm nay (vd. nộp chiều nay sau giờ
    // ăn): chỉ đơn đã có hiệu lực được xét.
    const live = regs.length > 1
      ? regs.filter(r => { const from = registrationEffectiveFrom(r); return !from || from <= date; })
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
      coverageAt,
      now,
    });

    /** @type {Meal[]} */
    const missingMeals = [];
    for (const m of MEALS) {
      const code = ev.meals[m].code;
      if (code === 'ok' || code === 'missing' || code === 'pending') stats.expected[m]++;
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
    const expected = stats.expected[m];
    const missing = stats.missing[m];
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
 * Chia người nhận thành các request gửi endpoint (Body A của hợp đồng).
 * @param {{ date: string, recipients: (AlertCandidate & { to: string })[], batchSize?: number }} input
 */
export function buildStaffBodies({ date, recipients, batchSize = ALERT_BATCH_SIZE }) {
  return chunk(recipients, batchSize).map(group => ({
    group,
    body: {
      kind: 'staff-missing',
      date,
      dateLabel: dateLabelOf(date),
      alerts: group.map(r => ({
        to: r.to,
        fullName: oneLine(r.fullName, 100),
        employeeId: oneLine(r.employeeId, 40),
        meals: r.meals.map(m => ({ meal: m, label: MEAL_LABEL[m], window: windowLabel(m) })),
        outOfWindow: r.outOfWindow.slice(0, 10),
      })),
    },
  }));
}

/**
 * Email báo quản trị khi chốt an toàn dừng đợt gửi (Body B).
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
  // Không phân biệt hoa thường khi bỏ trùng: endpoint coi A@ và a@ là lặp.
  const seen = new Set();
  const to = [];
  for (const e of adminEmails.map(x => String(x).trim()).filter(isSendableEmail)) {
    if (seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    to.push(e);
  }
  const lines = [
    ...MEALS.map(m => `${MEAL_LABEL[m]}: ${stats.missing[m]}/${stats.expected[m]} người đăng ký chưa có lượt chấm.`),
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
    to: to.slice(0, 5),
    reason: oneLine(reason, 1000),
    // Lỗi của thiết bị thường nhiều dòng; endpoint chỉ nhận mỗi phần tử một dòng.
    lines: lines.map(l => oneLine(l, 300)).filter(Boolean).slice(0, 30),
  };
}

/**
 * Trạng thái cuối của đợt gửi (bước 12).
 * @param {{ missingCount: number, failed: number }} input
 * @returns {'partial' | 'nothing' | 'sent'}
 */
export function finalAlertStatus({ missingCount, failed }) {
  if (failed > 0) return 'partial';    // lần chạy sau gửi nốt
  if (missingCount === 0) return 'nothing';
  return 'sent';
}

/**
 * Ghép kết quả endpoint trả về với lô người nhận đã gửi. Endpoint trả đúng thứ
 * tự đầu vào; kiểm thêm địa chỉ cho chắc — lệch là coi như chưa gửi được, để
 * lần sau gửi lại thay vì ghi nhầm "đã gửi" cho người khác.
 *
 * @param {{ to: string }[]} group
 * @param {unknown} response
 * @returns {{ ok: boolean, error: string | null }[]}
 */
export function matchResults(group, response) {
  const results = /** @type {any} */ (response)?.results;
  return group.map((r, i) => {
    const res = Array.isArray(results) ? results[i] : undefined;
    if (!res || typeof res !== 'object') return { ok: false, error: 'Endpoint không trả kết quả cho người này' };
    if (String(res.to || '').toLowerCase() !== r.to.toLowerCase()) return { ok: false, error: 'Kết quả endpoint không khớp người nhận' };
    if (res.ok === true) return { ok: true, error: null };
    return { ok: false, error: clip(res.error || 'gửi thất bại', 200) };
  });
}
