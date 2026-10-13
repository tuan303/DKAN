/**
 * Quy tắc suất ăn dùng chung cho cả ba nơi:
 *   - tab Đối soát chấm ăn của quản trị (src/components/MealReconciliation.tsx)
 *   - trang "Chấm ăn của tôi" của CBNV (src/pages/MyMeals.tsx)
 *   - agent đồng bộ trên máy HAC, khi tính ai cần nhận email cảnh báo
 *
 * Ba nơi phải ra cùng một kết luận cho cùng một người, cùng một bữa. Nếu mỗi
 * nơi giữ một bản quy tắc riêng thì sớm muộn sẽ lệch nhau, và hậu quả là email
 * báo "chưa chấm" trong khi quản trị thấy "đã chấm". Vì vậy quy tắc chỉ được
 * sửa ở file này.
 *
 * File nằm trong thư mục agent/ vì agent được chép nguyên thư mục sang máy HAC;
 * để ở chỗ khác thì máy HAC sẽ thiếu file. Phía web import thẳng file này.
 *
 * KHÔNG import gì từ Node hay trình duyệt: file phải chạy được ở cả hai phía.
 */

/** @typedef {'breakfast' | 'lunch'} Meal */

/**
 * @typedef {object} Registration
 * @property {string} [userId]
 * @property {string} employeeId
 * @property {string} [fullName]
 * @property {string} [department]
 * @property {number} breakfastCount
 * @property {number} lunchCount
 * @property {string} [firstMealDate]  YYYY-MM-DD, ngày bắt đầu ăn
 * @property {string} [timestamp]      ISO, thời điểm đăng ký
 */

/**
 * @typedef {object} Cancelation
 * @property {string} [userId]
 * @property {string} [employeeId]
 * @property {string} [cancelDate]    YYYY-MM-DD
 * @property {string} [cancelMeal]    'breakfast' | 'lunch' | 'both'
 */

/**
 * @typedef {object} TapRecord
 * @property {string} employeeId
 * @property {string} name
 * @property {string} department
 * @property {string | null} breakfast  giờ chấm sớm nhất trong khung bữa sáng
 * @property {string | null} lunch      giờ chấm sớm nhất trong khung bữa trưa
 * @property {string[]} unrecognized    lượt chấm ngoài cả hai khung
 */

/** @type {readonly Meal[]} */
export const MEALS = ['breakfast', 'lunch'];

/** @type {Record<Meal, string>} */
export const MEAL_LABEL = { breakfast: 'Bữa sáng', lunch: 'Bữa trưa' };

// Quy định của nhà trường: chỉ lượt chấm trong khung mới được tính suất ăn.
// Hai đầu khung đều tính (08:00 vẫn là bữa sáng).
/** @type {Record<Meal, { from: string, to: string }>} */
export const MEAL_WINDOWS = {
  breakfast: { from: '05:00', to: '08:00' },
  lunch: { from: '10:00', to: '13:30' },
};

export const VN_TZ = 'Asia/Ho_Chi_Minh';

// ------------------------------------------------------------ mã nhân viên

/**
 * Chuẩn hoá mã nhân viên trước khi so khớp.
 *
 * Mã nhân viên là ô nhập tay và từng không được trim khi lưu, nên có bản ghi
 * mang khoảng trắng thừa — kể cả khoảng trắng không ngắt (U+00A0) và khoảng
 * trắng full-width (U+3000) khi gõ bằng bộ gõ tiếng Việt. So thô thì "101190 "
 * và "101190" là hai người khác nhau.
 *
 * @param {unknown} v
 */
export const normId = v => String(v ?? '').replace(/[\s 　]/g, '').toUpperCase();

/** Mã không dùng để đối soát được: trống, hoặc N/A do chưa khai hồ sơ nhân sự. */
export const isUsableId = (/** @type {string} */ id) => id !== '' && id !== 'N/A' && id !== 'NA';

/**
 * Mã nhân viên của trường luôn đúng 6 chữ số (vd. 101190). Trên máy chấm, mã
 * ngắn hoặc dài hơn là nhân sự Bếp Vina — họ chấm để chấm công, không phải để
 * nhận suất ăn.
 */
export const SCHOOL_STAFF_ID_RE = /^\d{6}$/;
export const isSchoolStaffId = (/** @type {unknown} */ id) => SCHOOL_STAFF_ID_RE.test(normId(id));

// --------------------------------------------------------------- giờ, ngày

/** @param {string} hhmm */
export const toMinutes = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Giờ chấm thuộc bữa nào. Ngoài cả hai khung thì trả null.
 * @param {string} hhmm
 * @returns {Meal | null}
 */
export const classifyTime = hhmm => {
  const t = toMinutes(hhmm);
  for (const meal of MEALS) {
    if (t >= toMinutes(MEAL_WINDOWS[meal].from) && t <= toMinutes(MEAL_WINDOWS[meal].to)) return meal;
  }
  return null;
};

// Dùng getUTCDay trên mốc UTC để thứ trong tuần không phụ thuộc múi giờ của
// máy đang chạy (trình duyệt, Vercel chạy UTC, máy HAC chạy giờ Việt Nam).
const weekdayOf = (/** @type {string} */ iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Thứ 2 tới thứ 6. @param {string} iso YYYY-MM-DD */
export const isWeekday = iso => {
  const d = weekdayOf(iso);
  return d !== 0 && d !== 6;
};

/** @param {Iterable<string> | null | undefined} v */
const toSet = v => (v instanceof Set ? v : new Set(v || []));

/**
 * Ngày có suất ăn: thứ 2–6 và không nằm trong danh sách ngày nghỉ quản trị
 * khai ở tab Cấu hình (lễ, Tết, nghỉ hè...).
 * @param {string} iso
 * @param {Iterable<string> | null} [offDays]
 */
export const isMealDay = (iso, offDays) => isWeekday(iso) && !toSet(offDays).has(iso);

const VN_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: VN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Ngày và giờ theo giờ Việt Nam, bất kể máy đang chạy ở múi giờ nào.
 *
 * Không dùng toISOString().slice(0, 10) để lấy "hôm nay": đó là ngày UTC,
 * trước 07:00 sáng giờ Việt Nam nó vẫn còn là hôm qua.
 *
 * @param {Date | string | number} [input] mặc định là bây giờ
 * @returns {{ date: string, time: string } | null} null nếu input không hợp lệ
 */
export function vnParts(input) {
  const d = input instanceof Date ? input : new Date(input ?? Date.now());
  if (isNaN(d.getTime())) return null;
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of VN_FORMAT.formatToParts(d)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Hôm nay theo giờ Việt Nam, YYYY-MM-DD. */
export const vnToday = () => /** @type {{ date: string }} */ (vnParts()).date;

const DAY_NAMES = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

/** "Thứ 5, 09/10" @param {string} iso */
export const formatDayLabel = iso => `${DAY_NAMES[weekdayOf(iso)]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** "09/10/2026" @param {string} iso */
export const formatDate = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** "13:46 09/10/2026" theo giờ Việt Nam, hoặc '' nếu không hợp lệ. @param {string | null | undefined} iso */
export const formatVnDateTime = iso => {
  const p = iso ? vnParts(iso) : null;
  return p ? `${p.time} ${formatDate(p.date)}` : '';
};

/**
 * Các ngày có suất ăn trong tháng, tính tới hết `until` (nếu có).
 * @param {string} month YYYY-MM
 * @param {Iterable<string> | null} [offDays]
 * @param {string} [until] YYYY-MM-DD
 */
export function mealDaysOfMonth(month, offDays, until) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const off = toSet(offDays);
  const out = [];
  for (let d = 1; d <= last; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (until && iso > until) break;
    if (isMealDay(iso, off)) out.push(iso);
  }
  return out;
}

// --------------------------------------------------------------- lượt chấm

/**
 * Phân các giờ chấm thô vào bữa. Chấm nhiều lần trong cùng một bữa thì giữ
 * lượt sớm nhất; lượt ngoài khung đưa vào `unrecognized`.
 * @param {string[] | null | undefined} times
 */
export function classifyTimes(times) {
  /** @type {{ breakfast: string | null, lunch: string | null, unrecognized: string[] }} */
  const rec = { breakfast: null, lunch: null, unrecognized: [] };
  for (const t of times || []) {
    const meal = classifyTime(t);
    if (meal) {
      const prev = rec[meal];
      rec[meal] = prev && prev < t ? prev : t;
    } else {
      rec.unrecognized.push(t);
    }
  }
  return rec;
}

/**
 * Dựng dữ liệu đối soát từ các document `checkins/{date}` mà agent ghi.
 *
 * @param {{ date: string, people?: Record<string, { name?: string, department?: string, times?: string[] }> }[]} docs
 * @returns {{ month: string, rowCount: number, byDate: Record<string, Record<string, TapRecord>>, excludedIds: string[] }}
 */
export function buildFromCheckins(docs) {
  /** @type {Record<string, Record<string, TapRecord>>} */
  const byDate = {};
  const everyone = new Set();

  for (const d of docs) {
    /** @type {Record<string, TapRecord>} */
    const day = {};
    for (const [rawId, info] of Object.entries(d.people || {})) {
      const employeeId = normId(rawId);
      if (!employeeId) continue;
      everyone.add(employeeId);
      day[employeeId] = {
        employeeId,
        name: (info.name || '').trim(),
        department: (info.department || '').trim(),
        ...classifyTimes(info.times),
      };
    }
    byDate[d.date] = day;
  }

  return { month: docs[0]?.date.slice(0, 7) || '', rowCount: everyone.size, byDate, excludedIds: [] };
}

// ------------------------------------------------- ai đáng lẽ phải ăn bữa nào

/**
 * Chuẩn hoá một bản đăng ký: mã NV về dạng so khớp được, và sửa dữ liệu cũ.
 *
 * Bản ghi trước 23/06/2026 có thể mang lunchCount = 0 dù người đó chọn "Sáng +
 * Trưa" (lỗi cũ của form). Không có lựa chọn "chỉ ăn sáng", nên có ăn sáng thì
 * chắc chắn có ăn trưa. Gọi lại nhiều lần vẫn ra cùng kết quả.
 *
 * @template {Registration} R
 * @param {R} r
 * @returns {R}
 */
export function normalizeRegistration(r) {
  const breakfastCount = Number(r.breakfastCount) || 0;
  let lunchCount = Number(r.lunchCount) || 0;
  if (breakfastCount > 0 && lunchCount === 0) lunchCount = breakfastCount;
  return { ...r, employeeId: normId(r.employeeId), breakfastCount, lunchCount };
}

/**
 * Tập khóa hủy bữa.
 *
 * Lần hủy có tài khoản (userId) chỉ hủy bữa của CHÍNH tài khoản đó ("uid:").
 * Không khớp theo mã NV nữa vì hai lẽ:
 *  - mã NV trên lần hủy là bản chụp hồ sơ lúc hủy; ai đó sửa hồ sơ sang mã của
 *    người khác rồi báo hủy thì sẽ "hủy hộ" bữa của người kia;
 *  - trang "Chấm ăn của tôi" chỉ đọc được các lần hủy của chính tài khoản
 *    (Firestore rules). Khớp theo tài khoản thì trang, email và tab quản trị
 *    nhìn cùng một tập báo hủy, không bao giờ nói khác nhau.
 * Lần hủy KHÔNG có userId (dữ liệu rất cũ) thì đành khớp theo mã NV ("id:")
 * như cách tab quản trị vẫn làm trước đây.
 *
 * @param {Cancelation[]} cancelations
 */
export function buildCancelSet(cancelations) {
  const set = new Set();
  for (const c of cancelations || []) {
    if (!c.cancelDate) continue;
    const meals = c.cancelMeal === 'both' ? MEALS : [c.cancelMeal];
    const id = normId(c.employeeId);
    for (const m of meals) {
      if (!m) continue;
      if (c.userId) set.add(`uid:${c.userId}|${c.cancelDate}|${m}`);
      else if (id) set.add(`id:${id}|${c.cancelDate}|${m}`);
    }
  }
  return set;
}

/**
 * @param {Registration} reg đã qua normalizeRegistration
 * @param {Set<string>} cancelSet
 * @param {string} date
 * @param {Meal} meal
 */
const isCanceled = (reg, cancelSet, date, meal) =>
  (!!reg.userId && cancelSet.has(`uid:${reg.userId}|${date}|${meal}`)) ||
  cancelSet.has(`id:${reg.employeeId}|${date}|${meal}`);

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD, không phụ thuộc múi giờ máy. */
const shiftDate = (/** @type {string} */ iso, /** @type {number} */ days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Ngày đầu tiên một đơn đăng ký bắt đầu có bữa phải ăn.
 *
 * Là ngày muộn hơn giữa ngày bắt đầu ăn trên đơn và ngày nộp đơn; nộp sau giờ
 * ăn trưa thì hôm đó không còn bữa nào nên tính từ hôm sau (khớp với quy tắc
 * registeredAfterMeal). Trả null nếu đơn thiếu cả hai thông tin (dữ liệu rất
 * cũ) — coi như có hiệu lực từ đầu tháng.
 *
 * @param {Registration & { month?: string }} reg
 * @returns {string | null}
 */
export function registrationEffectiveFrom(reg) {
  let start = reg.firstMealDate || (reg.month ? `${reg.month}-01` : '');
  const at = reg.timestamp ? vnParts(reg.timestamp) : null;
  if (at) {
    const day = at.time > MEAL_WINDOWS.lunch.to ? shiftDate(at.date, 1) : at.date;
    if (!start || day > start) start = day;
  }
  return start || null;
}

/**
 * Mã NV đang đứng trên đơn của từ hai tài khoản trở lên VÀO NGÀY `date` — chỉ
 * tính đơn đã có hiệu lực tới ngày đó (registrationEffectiveFrom).
 *
 * Lượt chấm của mã đó là của ai thì không biết: tính cho ai cũng có thể oan.
 * Cả ba nơi (tab quản trị, email, trang cá nhân) đều KHÔNG kết luận cho mã này
 * trong những ngày đó; quản trị phải sửa hồ sơ bằng tay.
 *
 * Xét theo ngày chứ không theo cả tháng: nếu A đăng ký từ đầu tháng, B đăng ký
 * trùng mã chiều ngày 09, thì A đã nhận cảnh báo hôm 09 một cách đúng đắn — kết
 * luận các ngày trước khi B có đơn không được "rút lại".
 *
 * @param {Registration[]} registrations
 * @param {string} date
 * @returns {Set<string>} các mã (đã normId)
 */
export function duplicateIdsOn(registrations, date) {
  /** @type {Map<string, Set<unknown>>} */
  const owners = new Map();
  (registrations || []).forEach((r, i) => {
    const id = normId(r.employeeId);
    if (!isUsableId(id)) return;
    const from = registrationEffectiveFrom(r);
    if (from && from > date) return;
    // Đơn không có userId (dữ liệu rất cũ) thì mỗi đơn coi như một người.
    const owner = r.userId || `#${i}`;
    const set = owners.get(id);
    if (set) set.add(owner); else owners.set(id, new Set([owner]));
  });
  return new Set([...owners].filter(([, s]) => s.size > 1).map(([id]) => id));
}

/**
 * Đăng ký sau khi bữa đã kết thúc thì bữa đó không tính.
 *
 * Đăng ký tháng hiện tại bắt đầu từ chính ngày đăng ký, nên ai đăng ký lúc
 * 14:00 sẽ bị tính "đáng lẽ ăn" cả bữa sáng lẫn bữa trưa hôm đó — hai bữa họ
 * không thể ăn được. Nếu không loại ra, họ nhận cảnh báo oan ngay ngày đầu.
 *
 * @param {Registration} reg
 * @param {string} date
 * @param {Meal} meal
 */
function registeredAfterMeal(reg, date, meal) {
  const at = reg.timestamp ? vnParts(reg.timestamp) : null;
  if (!at) return false;
  if (at.date > date) return true;
  return at.date === date && at.time > MEAL_WINDOWS[meal].to;
}

/**
 * Lý do một người KHÔNG nằm trong danh sách đáng lẽ ăn bữa này. Trả về null
 * nghĩa là họ đáng lẽ phải ăn.
 *
 * @param {Registration | null | undefined} reg đã qua normalizeRegistration
 * @param {Set<string>} cancelSet
 * @param {string} date
 * @param {Meal} meal
 * @returns {null | 'no_registration' | 'meal_not_registered' | 'before_start' | 'registered_late' | 'canceled'}
 */
export function notExpectedReason(reg, cancelSet, date, meal) {
  // Thứ tự kiểm tra quyết định lý do hiển thị khi nhiều điều kiện cùng đúng;
  // giữ đúng thứ tự cũ của tab Đối soát để ghi chú không đổi với dữ liệu cũ.
  if (!reg) return 'no_registration';
  if (isCanceled(reg, cancelSet, date, meal)) return 'canceled';
  // Đăng ký giữa tháng: chưa tới ngày bắt đầu thì không tính
  if (reg.firstMealDate && date < reg.firstMealDate) return 'before_start';
  const count = meal === 'breakfast' ? reg.breakfastCount : reg.lunchCount;
  if (!count) return 'meal_not_registered';
  if (registeredAfterMeal(reg, date, meal)) return 'registered_late';
  return null;
}

/**
 * Bữa này có tính là "đã đăng ký" không, khi đã biết người đó có chấm hay không.
 *
 * Giống notExpectedReason() === null, thêm một ngoại lệ: ăn TRƯỚC rồi mới nộp
 * đơn trong cùng ngày (hay gặp đầu tháng). Form đăng ký tính luôn ngày nộp vào
 * số suất, nên bữa đó nằm trong đơn và người đó đã ăn — coi như đã đăng ký và
 * đã ăn, không xếp vào "chấm nhưng không đăng ký". Nếu KHÔNG chấm thì vẫn không
 * tính là phải ăn: không ai bị cảnh báo vì bữa đã kết thúc trước khi nộp đơn.
 *
 * @param {Registration | null | undefined} reg đã qua normalizeRegistration
 * @param {Set<string>} cancelSet
 * @param {string} date
 * @param {Meal} meal
 * @param {boolean} tapped có lượt chấm trong khung giờ của bữa này
 */
export function countsAsRegistered(reg, cancelSet, date, meal, tapped) {
  const why = notExpectedReason(reg, cancelSet, date, meal);
  return why === null || (why === 'registered_late' && tapped);
}

/**
 * Diễn giải lý do cho người đọc.
 * @param {ReturnType<typeof notExpectedReason>} reason
 * @param {Registration | null | undefined} reg
 * @param {Meal} meal
 */
export function describeNotExpected(reason, reg, meal) {
  switch (reason) {
    case 'no_registration': return 'Không có đăng ký trong tháng';
    case 'meal_not_registered': return meal === 'breakfast' ? 'Chỉ đăng ký bữa trưa' : 'Chỉ đăng ký bữa sáng';
    case 'before_start': {
      const f = reg?.firstMealDate || '';
      return `Đăng ký từ ngày ${f.slice(8, 10)}/${f.slice(5, 7)}`;
    }
    case 'canceled': return 'Đã báo hủy bữa này';
    case 'registered_late': return 'Đăng ký sau giờ ăn của bữa này';
    default: return 'Chưa xác định được — vui lòng báo lại để kiểm tra';
  }
}

// ------------------------------------------------------- đối soát toàn trường

/**
 * @typedef {object} Row
 * @property {string} employeeId
 * @property {string} fullName
 * @property {string} department
 * @property {string} date
 * @property {Meal | 'none'} meal
 * @property {string} [time]
 * @property {string} [note]
 */

/**
 * Đối chiếu đăng ký với lượt chấm cho cả trường (tab Đối soát của quản trị).
 *
 * @param {{
 *   byDate: Record<string, Record<string, TapRecord>>,
 *   dates: string[],
 *   registrations: Registration[],
 *   cancelations: Cancelation[],
 *   excludedIds?: Iterable<string>,
 *   offDays?: Iterable<string>,
 * }} input
 */
export function reconcile({ byDate, dates, registrations: allRegistrations, cancelations, excludedIds = [], offDays = [] }) {
  const excluded = new Set([...excludedIds].map(normId));
  const off = toSet(offDays);

  // Chuẩn hoá ngay từ đầu để mọi so khớp về sau đều dùng chung một dạng.
  const normalized = allRegistrations.map(normalizeRegistration);

  // Đăng ký không có mã dùng được thì không thể đối soát: tách riêng, nếu để
  // lẫn thì ngày nào họ cũng bị tính là "đăng ký nhưng không chấm".
  const invalid = normalized.filter(r => !isUsableId(r.employeeId));

  // Loại cả ở phía đăng ký: nếu một người bên bếp có đăng ký trên hệ thống thì
  // cũng không được rơi vào danh sách "đăng ký nhưng không chấm".
  const registrations = normalized.filter(r => isUsableId(r.employeeId) && !excluded.has(r.employeeId));

  /** @type {Row[]} */ const registered = [];    // mọi suất đã đăng ký
  /** @type {Row[]} */ const tapped = [];        // mọi lượt chấm được ghi nhận
  /** @type {Row[]} */ const missing = [];       // đăng ký nhưng không chấm
  /** @type {Row[]} */ const extra = [];         // chấm nhưng không đăng ký
  /** @type {Row[]} */ const unrecognized = [];  // chấm ngoài khung giờ, không được ghi nhận
  /** @type {Row[]} */ const invalidRegs = [];   // đăng ký thiếu mã NV hoặc trùng mã, không đối soát được

  const cancelSet = buildCancelSet(cancelations);
  const regByEmployee = new Map(registrations.map(r => [r.employeeId, r]));

  // Lượt chấm của nhân sự Bếp Vina là chấm công, không phải suất ăn: không đưa
  // vào "chấm nhưng không đăng ký", cũng không tính là lượt chấm hợp lệ hay
  // chấm ngoài giờ. Nhận ra họ bằng danh sách loại trừ (lấy từ file HAC có cột
  // bộ phận) hoặc mã không đúng 6 chữ số của trường. Mã nào có đứng trên một
  // đơn đăng ký ăn thì KHÔNG bao giờ bị coi là bếp: loại nhầm lượt chấm của họ
  // là họ bị tính oan "đăng ký nhưng không chấm".
  const registeredIds = new Set(normalized.map(r => r.employeeId).filter(isUsableId));
  const isKitchenTap = (/** @type {string} */ id) => !registeredIds.has(id) && (excluded.has(id) || !isSchoolStaffId(id));
  /** @type {Map<string, string>} */ const kitchen = new Map();   // mã -> tên trên máy chấm

  for (const date of dates) {
    if (!isMealDay(date, off)) continue;
    /** @type {Record<string, TapRecord>} */
    const taps = {};
    for (const [employeeId, rec] of Object.entries(byDate[date] || {})) {
      if (isKitchenTap(employeeId)) {
        if (!kitchen.get(employeeId)) kitchen.set(employeeId, rec.name || '');
        continue;
      }
      taps[employeeId] = rec;
    }

    // Mã trùng giữa nhiều tài khoản trong ngày này: không kết luận được ai ăn
    // ai không — tách riêng như đơn thiếu mã, đúng như email cảnh báo và trang
    // cá nhân đang làm. Để lẫn vào thì cả hai người cùng vào danh sách vi phạm
    // dù không ai nhận được cảnh báo.
    const duplicated = duplicateIdsOn(registrations, date);
    const active = duplicated.size ? registrations.filter(r => !duplicated.has(r.employeeId)) : registrations;

    for (const meal of MEALS) {
      // Ai đáng lẽ phải ăn bữa này hôm nay
      const expected = active.filter(r => countsAsRegistered(r, cancelSet, date, meal, !!taps[r.employeeId]?.[meal]));
      const expectedIds = new Set(expected.map(r => r.employeeId));

      for (const r of expected) {
        /** @type {Row} */
        const row = { employeeId: r.employeeId, fullName: r.fullName || '', department: r.department || '', date, meal };
        registered.push(row);
        if (!taps[r.employeeId]?.[meal]) missing.push(row);
      }

      for (const [employeeId, rec] of Object.entries(taps)) {
        const time = rec[meal];
        if (!time) continue;
        /** @type {Row} */
        const row = { employeeId, fullName: rec.name, department: rec.department, date, meal, time };
        tapped.push(row);
        if (!expectedIds.has(employeeId)) {
          // Vì sao người này chấm ăn mà không nằm trong danh sách đáng lẽ ăn?
          // Phân biệt "người ngoài" với "đã báo hủy nhưng vẫn ăn".
          // Không lý do nào khớp nghĩa là dữ liệu mâu thuẫn — describeNotExpected
          // nói thẳng ra thay vì để ô ghi chú trống.
          const reg = regByEmployee.get(employeeId);
          const note = duplicated.has(employeeId)
            ? 'Mã NV trùng giữa nhiều đăng ký — chưa xác định được người ăn'
            : describeNotExpected(notExpectedReason(reg, cancelSet, date, meal), reg, meal);
          extra.push({ ...row, note });
        }
      }
    }

    for (const [employeeId, rec] of Object.entries(taps)) {
      for (const t of rec.unrecognized) {
        unrecognized.push({ employeeId, fullName: rec.name, department: rec.department, date, meal: 'none', time: t });
      }
    }

    for (const r of invalid) {
      for (const meal of MEALS) {
        const count = meal === 'breakfast' ? r.breakfastCount : r.lunchCount;
        if (!count) continue;
        if (r.firstMealDate && date < r.firstMealDate) continue;
        invalidRegs.push({
          employeeId: r.employeeId || '(trống)',
          fullName: r.fullName || '',
          department: r.department || '',
          date,
          meal,
          note: 'Hồ sơ nhân sự chưa có mã nhân viên',
        });
      }
    }

    for (const r of registrations) {
      if (!duplicated.has(r.employeeId)) continue;
      for (const meal of MEALS) {
        if (notExpectedReason(r, cancelSet, date, meal) !== null) continue;
        invalidRegs.push({
          employeeId: r.employeeId,
          fullName: r.fullName || '',
          department: r.department || '',
          date,
          meal,
          note: 'Mã NV trùng với đăng ký của người khác',
        });
      }
    }
  }

  const byDateThenName = (/** @type {Row} */ a, /** @type {Row} */ b) =>
    a.date === b.date ? a.fullName.localeCompare(b.fullName, 'vi') : a.date.localeCompare(b.date);

  return {
    registered: registered.sort(byDateThenName),
    tapped: tapped.sort(byDateThenName),
    missing: missing.sort(byDateThenName),
    extra: extra.sort(byDateThenName),
    unrecognized: unrecognized.sort(byDateThenName),
    invalidRegs: invalidRegs.sort(byDateThenName),
    /** Nhân sự Bếp Vina đã bị loại khỏi các danh sách lượt chấm (để báo cho quản trị biết). */
    kitchenExcluded: [...kitchen]
      .map(([employeeId, fullName]) => ({ employeeId, fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi') || a.employeeId.localeCompare(b.employeeId)),
  };
}

// ----------------------------------------------------- tình trạng một người

/**
 * @typedef {'off_day'      // cuối tuần hoặc ngày nghỉ quản trị đã khai
 *   | 'excluded'          // thuộc bộ phận không đối soát (Bếp Vina)
 *   | 'invalid_id'        // có đăng ký nhưng hồ sơ thiếu mã NV, không đối chiếu được
 *   | 'not_registered'    // không phải ăn bữa này, và cũng không chấm
 *   | 'extra'             // không phải ăn bữa này nhưng có chấm
 *   | 'ok'                // phải ăn, đã chấm trong khung giờ
 *   | 'pending'           // phải ăn, chưa thấy lượt chấm, nhưng chưa có dữ liệu chốt
 *   | 'missing'           // phải ăn, dữ liệu đã chốt mà không có lượt chấm
 * } MealStatusCode
 */

/**
 * @typedef {object} MealStatus
 * @property {MealStatusCode} code
 * @property {string | null} time  giờ chấm trong khung (nếu có)
 * @property {ReturnType<typeof notExpectedReason>} [reason]  vì sao không phải ăn (với not_registered / extra)
 */

/**
 * Dữ liệu một bữa đã "chốt" chưa: bữa đã kết thúc, VÀ có một lần đồng bộ đủ
 * tất cả máy chấm diễn ra sau giờ kết thúc bữa đó.
 *
 * Phải đủ cả hai điều kiện. Chỉ xét giờ thì lúc 14:00 mà máy chưa đồng bộ, ai
 * cũng bị coi là chưa chấm. Chỉ xét đồng bộ thì lần đồng bộ 08:15 không nói
 * được gì về bữa trưa.
 *
 * @param {string} date
 * @param {Meal} meal
 * @param {string | null | undefined} coverageAt ISO — lần đồng bộ đủ máy gần nhất có phủ ngày này
 * @param {Date} [now]
 */
export function isMealFinal(date, meal, coverageAt, now) {
  const end = MEAL_WINDOWS[meal].to;
  const n = /** @type {{ date: string, time: string }} */ (vnParts(now ?? new Date()));
  const ended = date < n.date || (date === n.date && n.time > end);
  if (!ended) return false;
  const c = coverageAt ? vnParts(coverageAt) : null;
  if (!c) return false;
  return c.date > date || (c.date === date && c.time > end);
}

/**
 * Tình trạng từng bữa của MỘT người trong MỘT ngày.
 *
 * Dùng cho trang "Chấm ăn của tôi" và cho agent khi chọn người nhận email.
 * Cho ra cùng kết luận "đáng lẽ ăn / không" với reconcile() vì cùng gọi
 * notExpectedReason().
 *
 * @param {{
 *   date: string,
 *   registration?: Registration | null,  // đăng ký tháng của người này
 *   cancelations?: Cancelation[],        // các lần báo hủy của người này
 *   times?: string[],                    // giờ chấm thô HH:MM trong ngày
 *   offDays?: Iterable<string>,
 *   excludedIds?: Iterable<string>,
 *   coverageAt?: string | null,
 *   now?: Date,
 * }} input
 */
export function evaluatePersonDay({ date, registration, cancelations = [], times = [], offDays = [], excludedIds = [], coverageAt = null, now }) {
  const rec = classifyTimes(times);
  const reg = registration ? normalizeRegistration(registration) : null;
  const cancelSet = buildCancelSet(cancelations);
  const excluded = new Set([...excludedIds].map(normId));
  const offDay = !isMealDay(date, offDays);

  /** @type {Record<Meal, MealStatus>} */
  const meals = /** @type {any} */ ({});
  for (const meal of MEALS) {
    const time = rec[meal];
    if (offDay) { meals[meal] = { code: 'off_day', time }; continue; }
    if (reg && isUsableId(reg.employeeId) && excluded.has(reg.employeeId)) { meals[meal] = { code: 'excluded', time }; continue; }

    const reason = notExpectedReason(reg, cancelSet, date, meal);
    if (!countsAsRegistered(reg, cancelSet, date, meal, !!time)) {
      meals[meal] = { code: time ? 'extra' : 'not_registered', time, reason };
      continue;
    }
    if (reg && !isUsableId(reg.employeeId)) { meals[meal] = { code: 'invalid_id', time }; continue; }
    if (time) { meals[meal] = { code: 'ok', time }; continue; }
    meals[meal] = { code: isMealFinal(date, meal, coverageAt, now) ? 'missing' : 'pending', time: null };
  }

  return { date, offDay, meals, unrecognized: rec.unrecognized };
}
