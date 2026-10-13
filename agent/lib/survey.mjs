/**
 * Khảo sát chất lượng phục vụ suất ăn CBGV-NV hằng tuần — định nghĩa dùng chung
 * cho cả ba nơi:
 *   - trang khảo sát của CBNV (src/pages/MealSurvey.tsx)
 *   - tab kết quả của quản trị (src/components/SurveyResults.tsx)
 *   - agent trên máy HAC, khi gửi email mời 15:00 thứ 6 (agent/survey-invite.mjs)
 *
 * Câu hỏi, mã đáp án, cách tính tuần và hạn trả lời chỉ được sửa ở file này.
 * Mã đáp án còn được chép trong firestore.rules (hàm validSurveyAnswers) vì
 * rules không import được JS — test agent/test/survey.test.mjs đối chiếu hai
 * nơi, sửa một chỗ mà quên chỗ kia là test báo ngay.
 *
 * KHÔNG import gì từ Node hay trình duyệt: file phải chạy được ở cả hai phía.
 */

import { isMealDay, normId, isUsableId, registrationEffectiveFrom } from './meal-rules.mjs';

/** Tăng khi đổi bộ câu hỏi, để kết quả các tuần cũ vẫn đọc đúng theo bộ cũ. */
export const SURVEY_VERSION = 1;

export const SURVEY_TITLE = 'Khảo sát chất lượng phục vụ suất ăn CBGV-NV';

/**
 * @typedef {'good' | 'neutral' | 'warn' | 'bad'} Tone  màu trên biểu đồ kết quả
 * @typedef {{ value: string, label: string, tone: Tone }} SurveyOption
 * @typedef {{ id: string, kind: 'choice', label: string, required: true, options: SurveyOption[] }} ChoiceQuestion
 * @typedef {{ id: string, kind: 'text', label: string, required: boolean, maxLength: number, placeholder: string }} TextQuestion
 * @typedef {ChoiceQuestion | TextQuestion} SurveyQuestion
 */

// Nội dung theo đúng form khảo sát Microsoft của Nhóm Dinh dưỡng, đổi "đồng
// chí" thành "Thầy/Cô" và thống nhất cách gọi "CBGV-NV".
/** @type {SurveyQuestion[]} */
export const SURVEY_QUESTIONS = [
  {
    id: 'taste', kind: 'choice', required: true,
    label: 'Cảm nhận của Thầy/Cô về thức ăn trong tuần?',
    options: [
      { value: 'ngon', label: 'Ngon', tone: 'good' },
      { value: 'binh_thuong', label: 'Bình thường', tone: 'neutral' },
      { value: 'chua_ngon', label: 'Chưa ngon', tone: 'bad' },
    ],
  },
  {
    id: 'variety', kind: 'choice', required: true,
    label: 'Thực đơn có đa dạng và thay đổi theo tuần không?',
    options: [
      { value: 'da_dang', label: 'Đa dạng và phong phú, không bị lặp món trong tuần', tone: 'good' },
      { value: 'chua_da_dang', label: 'Không đa dạng, cần thêm các món mới', tone: 'bad' },
    ],
  },
  {
    id: 'warmth', kind: 'choice', required: true,
    label: 'Suất ăn có đạt độ ấm nóng không?',
    options: [
      { value: 'du_nong', label: 'Đủ độ nóng', tone: 'good' },
      { value: 'chua_du_nong', label: 'Chưa đủ nóng', tone: 'bad' },
    ],
  },
  {
    id: 'portion', kind: 'choice', required: true,
    label: 'Thầy/Cô đánh giá thế nào về định lượng suất ăn dành cho CBGV-NV?',
    options: [
      { value: 'thua', label: 'Thừa', tone: 'warn' },
      { value: 'vua_du', label: 'Vừa đủ', tone: 'good' },
      { value: 'thieu', label: 'Thiếu', tone: 'bad' },
    ],
  },
  {
    id: 'hygiene', kind: 'choice', required: true,
    label: 'Dụng cụ phục vụ suất ăn có sạch sẽ không?',
    options: [
      { value: 'sach', label: 'Sạch', tone: 'good' },
      { value: 'chua_sach', label: 'Chưa sạch', tone: 'bad' },
    ],
  },
  {
    id: 'liked', kind: 'text', required: true, maxLength: 500,
    label: 'Món ăn Thầy/Cô yêu thích?',
    placeholder: 'Ví dụ: cá kho, canh chua, bún chả…',
  },
  {
    id: 'disliked', kind: 'text', required: false, maxLength: 500,
    label: 'Món ăn Thầy/Cô không thích?',
    placeholder: 'Không bắt buộc',
  },
  {
    id: 'suggestion', kind: 'text', required: false, maxLength: 1000,
    label: 'Thầy/Cô có góp ý gì để cải thiện chất lượng bữa ăn?',
    placeholder: 'Không bắt buộc',
  },
];

export const SURVEY_ANSWER_KEYS = SURVEY_QUESTIONS.map(q => q.id);

// ------------------------------------------------------------------ tuần, hạn

/** Email mời gửi lúc 15:00 thứ 6; khảo sát đóng 12:00 thứ 2 tuần sau (giờ VN). */
export const SURVEY_SEND_TIME = '15:00';
export const SURVEY_CLOSE_TIME = '12:00';

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD, không phụ thuộc múi giờ máy. */
export const shiftDate = (/** @type {string} */ iso, /** @type {number} */ days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Thứ 2 của tuần chứa ngày `iso`. Chủ nhật thuộc tuần kết thúc hôm đó. */
export function weekStartOf(/** @type {string} */ iso) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = CN
  return shiftDate(iso, dow === 0 ? -6 : 1 - dow);
}

/**
 * Tuần khảo sát chứa ngày `iso`. Mã tuần là ngày thứ 2 (YYYY-MM-DD) — đọc là
 * hiểu ngay, sắp xếp theo chuỗi là đúng thứ tự thời gian.
 * @param {string} iso
 */
export function surveyWeek(iso) {
  const weekId = weekStartOf(iso);
  return {
    weekId,
    weekStart: weekId,
    weekEnd: shiftDate(weekId, 4),           // thứ 6
    closesOn: shiftDate(weekId, 7),          // thứ 2 tuần sau
  };
}

/**
 * Mã tuần hợp lệ: đúng dạng ngày, là ngày có thật, và là thứ 2. Phải kiểm "có
 * thật" bằng cách đổi qua lại: Date tự cuộn ngày không tồn tại sang tháng sau
 * ('2026-02-30' thành 02/03, đúng thứ 2) — không kiểm thì mã giả vẫn lọt.
 */
export const isWeekId = (/** @type {unknown} */ v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  // Mã đến từ đường link (?tuan=) nên có thể là rác như tháng 13: không được ném lỗi.
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && d.getUTCDay() === 1;
};

/** Thời điểm mở mặc định (ISO, UTC): 15:00 giờ VN thứ 6 của tuần. */
export const surveyDefaultOpensAt = (/** @type {string} */ weekId) =>
  new Date(`${shiftDate(weekId, 4)}T${SURVEY_SEND_TIME}:00+07:00`).toISOString();

/** Hạn trả lời (ISO, UTC): 12:00 giờ VN thứ 2 tuần sau. */
export const surveyClosesAt = (/** @type {string} */ weekId) =>
  new Date(`${shiftDate(weekId, 7)}T${SURVEY_CLOSE_TIME}:00+07:00`).toISOString();

const dm = (/** @type {string} */ iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** "05/10 – 09/10/2026" */
export const surveyWeekLabel = (/** @type {string} */ weekId) =>
  `${dm(weekId)} – ${dm(shiftDate(weekId, 4))}/${shiftDate(weekId, 4).slice(0, 4)}`;

/** "12h00 thứ 2, ngày 12/10/2026" — đúng cách viết của mẫu email Nhóm Dinh dưỡng. */
export const surveyDeadlineLabel = (/** @type {string} */ weekId) => {
  const d = shiftDate(weekId, 7);
  return `${SURVEY_CLOSE_TIME.replace(':', 'h')} thứ 2, ngày ${dm(d)}/${d.slice(0, 4)}`;
};

/**
 * Tuần có ít nhất một ngày có suất ăn (thứ 2–6, không phải ngày nghỉ quản trị
 * khai). Cả tuần nghỉ (Tết, nghỉ hè) thì không gửi khảo sát.
 * @param {string} weekId
 * @param {Iterable<string> | null} [offDays]
 */
export function weekHasMeals(weekId, offDays) {
  for (let i = 0; i < 5; i++) if (isMealDay(shiftDate(weekId, i), offDays)) return true;
  return false;
}

/**
 * Khảo sát đang nhận trả lời lúc `now` không.
 * @param {{ opensAt?: unknown, closesAt?: unknown } | null | undefined} survey  opensAt/closesAt dạng ISO, Date hoặc Firestore Timestamp
 * @param {Date} [now]
 */
export function isSurveyOpen(survey, now = new Date()) {
  const open = toMillis(survey?.opensAt);
  const close = toMillis(survey?.closesAt);
  if (open === null || close === null) return false;
  const t = now.getTime();
  return t >= open && t < close;
}

/** ISO / Date / Firestore Timestamp (cả bản web lẫn admin) -> mili giây, hoặc null. */
export function toMillis(/** @type {unknown} */ v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  if (typeof v === 'object') {
    const o = /** @type {any} */ (v);
    if (typeof o.toMillis === 'function') return o.toMillis();
    if (typeof o.seconds === 'number') return o.seconds * 1000 + Math.floor((o.nanoseconds || 0) / 1e6);
  }
  return null;
}

// ------------------------------------------------------------- câu trả lời

/**
 * Kiểm tra và làm sạch câu trả lời trước khi lưu. Firestore rules kiểm tra lại
 * đúng các điều kiện này (validSurveyAnswers) — trình duyệt chỉ kiểm để báo
 * lỗi dễ hiểu, không phải để chặn.
 *
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {{ ok: boolean, errors: Record<string, string>, clean: Record<string, string> }}
 */
export function validateSurveyAnswers(raw) {
  /** @type {Record<string, string>} */ const errors = {};
  /** @type {Record<string, string>} */ const clean = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const q of SURVEY_QUESTIONS) {
    const v = src[q.id];
    if (q.kind === 'choice') {
      if (typeof v === 'string' && q.options.some(o => o.value === v)) clean[q.id] = v;
      else errors[q.id] = 'Thầy/Cô vui lòng chọn một đáp án.';
      continue;
    }
    // Gộp khoảng trắng thừa, bỏ ký tự điều khiển (trừ xuống dòng) — người dùng
    // dán từ Zalo/Word hay kèm ký tự lạ.
    const text = typeof v === 'string'
      ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
      : '';
    if (text.length > q.maxLength) errors[q.id] = `Tối đa ${q.maxLength} ký tự (hiện ${text.length}).`;
    else if (q.required && !text) errors[q.id] = 'Thầy/Cô vui lòng điền câu trả lời.';
    if (text) clean[q.id] = text.slice(0, q.maxLength);
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

// ------------------------------------------------------------- người nhận

/**
 * Ai nhận email mời khảo sát của tuần `weekId`: người có đơn đăng ký ăn còn
 * hiệu lực trong tuần đó.
 *
 * - Đơn của các tháng mà tuần chạm tới (tuần vắt qua hai tháng thì cả hai);
 *   nơi gọi truyền đơn của đúng các tháng đó.
 * - Đơn có hiệu lực từ sau thứ 6 (đăng ký giữa tuần cho hết tháng thì vẫn tính
 *   nếu bắt đầu ăn trước thứ 6) thì không mời: tuần này họ chưa ăn.
 * - Đơn không đăng ký bữa nào (cả hai số đều 0) không mời.
 * - Mã thuộc bộ phận loại trừ (Bếp Vina): nhân viên bếp không tự khảo sát bếp.
 * - Không cần mã NV dùng được: khảo sát không đối chiếu máy chấm.
 * - Phải còn ít nhất MỘT ngày có suất ăn mà đơn phủ trong tuần: ngày thuộc tháng
 *   của đơn, từ ngày đơn có hiệu lực, và không phải ngày nghỉ. Người có đơn bắt
 *   đầu đúng thứ 6 mà thứ 6 là ngày nghỉ thì tuần này chưa ăn bữa nào — mời
 *   khảo sát, nhắc rồi liệt kê "chưa trả lời" là vô lý.
 *
 * @param {{
 *   registrations: { uid: string, employeeId?: unknown, month?: string, firstMealDate?: string, timestamp?: string, breakfastCount?: unknown, lunchCount?: unknown }[],
 *   weekId: string,
 *   excludedIds?: Iterable<string>,
 *   offDays?: Iterable<string>,
 * }} input
 * @returns {string[]} uid, không trùng, đã sắp xếp
 */
export function surveyRecipientUids({ registrations, weekId, excludedIds = [], offDays = [] }) {
  const days = [0, 1, 2, 3, 4].map(i => shiftDate(weekId, i));
  const off = new Set(offDays);
  const mealDays = days.filter(d => isMealDay(d, off));
  const excluded = new Set([...excludedIds].map(normId));
  const out = new Set();
  for (const r of registrations || []) {
    if (!r || !r.uid) continue;
    if (!(Number(r.breakfastCount) > 0) && !(Number(r.lunchCount) > 0)) continue;
    const id = normId(r.employeeId);
    if (isUsableId(id) && excluded.has(id)) continue;
    const from = registrationEffectiveFrom(/** @type {any} */ (r)) || '';
    // Đơn chỉ phủ ngày của tháng mình (tuần vắt qua hai tháng thì mỗi đơn một phần).
    const covers = mealDays.some(d => (!r.month || d.startsWith(`${r.month}-`)) && d >= from);
    if (covers) out.add(r.uid);
  }
  return [...out].sort();
}
