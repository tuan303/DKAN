// Pure policy validation shared by the HAC agent, website and Mini App.
//
// Lưu ở Firestore `meal_checkin_exemptions/{employeeId}`:
//   { employeeId: '100001', email: 'a@hoangmaistarschool.edu.vn', fullName,
//     periods: [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' | null, meals: ['breakfast' | 'lunch'] }] }
// Thiếu `meals` (dữ liệu bản đầu) = miễn bữa trưa. Thiếu `to` = chưa có ngày kết thúc.
//
// Hai mức kiểm tra:
//   - normalizeCheckinExemption(): dữ liệu người dùng vừa nhập (trang quản trị)
//     — được phép chuẩn hoá mã NV/email, báo lỗi theo từng trường;
//   - parseCheckinExemptionDocs(): dữ liệu ĐÃ LƯU — kiểm tra TỪNG tài liệu, tài
//     liệu hỏng được tách riêng (kèm mã tài liệu + lý do) thay vì làm hỏng cả
//     danh sách. Tài liệu đã lưu phải ở dạng chuẩn (email viết thường, mã tài
//     liệu = mã NV) để mọi nơi đọc (agent, đối soát, trang cá nhân, Mini App)
//     cùng một kết luận.
import { isIsoDate } from './common.mjs';

/** @typedef {'breakfast' | 'lunch'} ExemptionMeal */
/** @typedef {{ from: string, to: string | null, meals: ExemptionMeal[] }} CheckinExemptionPeriod */
/** @typedef {{ employeeId: string, email: string, fullName: string, periods: CheckinExemptionPeriod[] }} CheckinExemption */
/**
 * employeeId: mã chính để hiển thị (mã tài liệu nếu là 6 chữ số, không thì mã
 * trong dữ liệu); codes: MỌI mã bản ghi nhắc tới — đều chưa rõ có được miễn hay không.
 * @typedef {{ docId: string, employeeId: string | null, codes: string[], reason: string }} InvalidCheckinExemption
 */

export const SCHOOL_EMAIL_DOMAIN = '@hoangmaistarschool.edu.vn';
const SCHOOL_EMAIL = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@hoangmaistarschool\.edu\.vn$/;
const EMPLOYEE_ID = /^\d{6}$/;
export const MAX_EXEMPTION_PERIODS = 100;
export const MAX_EXEMPTION_NAME = 160;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
/** @type {readonly ExemptionMeal[]} */
const MEALS = ['breakfast', 'lunch'];
const MEAL_NAME = { breakfast: 'bữa sáng', lunch: 'bữa trưa' };

/** Lỗi dữ liệu miễn chấm, có thông báo tiếng Việt theo từng trường. */
export class CheckinExemptionError extends TypeError {
  /** @param {string} message @param {{ field?: string | null }} [info] */
  constructor(message, { field = null } = {}) {
    super(message);
    this.name = 'CheckinExemptionError';
    this.field = field;
  }
}
const fail = (message, field = null) => { throw new CheckinExemptionError(message, { field }); };
const shown = value => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return text ? ` (đang là "${text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 40)}")` : '';
};

/** Same normalization used for staff IDs throughout meal reconciliation. @param {unknown} value */
export const normalizeExemptionEmployeeId = value => String(value ?? '').replace(/[\s 　]/g, '').toUpperCase();
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

/**
 * Validate one record. `strict` (stored documents) refuses values that would need
 * normalizing, so a policy the agent applies is always findable by the staff
 * member's own email query.
 * @param {unknown} value @param {{ strict?: boolean }} [options] @returns {CheckinExemption}
 */
function validate(value, { strict = false } = {}) {
  if (!plain(value)) fail('Bản ghi miễn chấm ăn không hợp lệ.');
  const rawId = value.employeeId;
  if (typeof rawId !== 'string') fail(`Mã nhân viên phải là chuỗi gồm đúng 6 chữ số${shown(rawId)}.`, 'employeeId');
  const employeeId = strict ? rawId : normalizeExemptionEmployeeId(rawId);
  if (!EMPLOYEE_ID.test(employeeId)) fail(`Mã nhân viên phải gồm đúng 6 chữ số${shown(rawId)}.`, 'employeeId');

  const rawEmail = value.email;
  const email = strict ? (typeof rawEmail === 'string' ? rawEmail : '') : normalizeEmail(rawEmail);
  if (!SCHOOL_EMAIL.test(email.toLowerCase())) {
    fail(`Email phải là địa chỉ ${SCHOOL_EMAIL_DOMAIN}, không có khoảng trắng${shown(rawEmail)}.`, 'email');
  }
  if (email !== email.toLowerCase()) fail(`Email đã lưu phải viết thường${shown(rawEmail)}.`, 'email');

  if (typeof value.fullName !== 'string' || value.fullName.length > MAX_EXEMPTION_NAME
    || /[\u0000-\u001f\u007f]/.test(value.fullName)) {
    fail(`Họ tên phải là một dòng, tối đa ${MAX_EXEMPTION_NAME} ký tự.`, 'fullName');
  }
  if (!Array.isArray(value.periods) || !value.periods.length || value.periods.length > MAX_EXEMPTION_PERIODS) {
    fail(`Cần có từ 1 đến ${MAX_EXEMPTION_PERIODS} khoảng thời gian miễn chấm.`, 'periods');
  }
  const periods = value.periods.map(period => {
    if (!plain(period)) fail('Khoảng thời gian miễn chấm không hợp lệ.', 'periods');
    const to = period.to === undefined ? null : period.to;
    if (!isIsoDate(period.from)) fail(`Ngày bắt đầu phải có dạng YYYY-MM-DD${shown(period.from)}.`, 'periods');
    if (to !== null && !isIsoDate(to)) fail(`Ngày kết thúc phải có dạng YYYY-MM-DD hoặc để trống${shown(to)}.`, 'periods');
    if (to !== null && to < period.from) fail('Ngày kết thúc không được trước ngày bắt đầu.', 'periods');
    // Existing lunch-only policies remain valid after adding per-meal control.
    const selected = period.meals === undefined ? ['lunch'] : period.meals;
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > 2
      || new Set(selected).size !== selected.length || selected.some(meal => !MEALS.includes(meal))) {
      fail('Bữa miễn chấm chỉ gồm "breakfast" (bữa sáng) và/hoặc "lunch" (bữa trưa).', 'periods');
    }
    return { from: period.from, to, meals: MEALS.filter(meal => selected.includes(meal)) };
  }).sort((a, b) => a.from.localeCompare(b.from) || a.meals.join().localeCompare(b.meals.join()));
  for (const meal of MEALS) {
    const selected = periods.filter(period => period.meals.includes(meal));
    for (let index = 1; index < selected.length; index++) {
      if (selected[index - 1].to === null || selected[index].from <= selected[index - 1].to) {
        fail(`Các khoảng thời gian miễn ${MEAL_NAME[meal]} bị chồng nhau.`, 'periods');
      }
    }
  }
  return { employeeId, email, fullName: value.fullName.trim(), periods };
}

/** Input from the admin form/import: normalizes ID and email. @param {unknown} value @returns {CheckinExemption} */
export function normalizeCheckinExemption(value) {
  return validate(value);
}

/**
 * A stored document. Throws CheckinExemptionError when the document is not in
 * the canonical form written by the admin page (doc id = employeeId).
 * @param {string} docId @param {unknown} data @returns {CheckinExemption}
 */
export function validateStoredCheckinExemption(docId, data) {
  const policy = validate(data, { strict: true });
  if (docId !== policy.employeeId) fail(`Mã tài liệu "${String(docId).slice(0, 40)}" phải trùng mã nhân viên ${policy.employeeId}.`, 'docId');
  return policy;
}

/**
 * Staff codes named by a broken document (doc id and/or employeeId field), to
 * hold only those people. Doc 100009 with employeeId '100001' names both.
 * @param {string} docId @param {unknown} data @returns {string[]}
 */
function codesOfInvalid(docId, data) {
  const fromField = plain(data) ? normalizeExemptionEmployeeId(/** @type {any} */ (data).employeeId) : '';
  return [...new Set([String(docId), fromField].filter(code => EMPLOYEE_ID.test(code)))];
}

/**
 * Validate stored documents ONE BY ONE. Never throws for data problems: broken
 * documents come back in `invalid` with their id, the staff code they name (when
 * it can be told) and a Vietnamese reason. Two documents for the same staff code
 * are both invalid — neither can be trusted over the other.
 * @param {Iterable<{ id: string, data: unknown }>} docs
 * @returns {{ policies: CheckinExemption[], invalid: InvalidCheckinExemption[] }}
 */
export function parseCheckinExemptionDocs(docs = []) {
  /** @type {Map<string, { docId: string, policy: CheckinExemption }[]>} */
  const byId = new Map();
  /** @type {InvalidCheckinExemption[]} */
  const invalid = [];
  for (const { id, data } of docs) {
    const docId = String(id ?? '');
    try {
      const policy = validateStoredCheckinExemption(docId, data);
      const group = byId.get(policy.employeeId) || [];
      group.push({ docId, policy });
      byId.set(policy.employeeId, group);
    } catch (error) {
      const codes = codesOfInvalid(docId, data);
      invalid.push({
        docId,
        employeeId: codes[0] ?? null,
        codes,
        reason: error instanceof CheckinExemptionError ? error.message : 'Bản ghi miễn chấm ăn không hợp lệ.',
      });
    }
  }
  /** @type {CheckinExemption[]} */
  const policies = [];
  for (const [employeeId, group] of byId) {
    if (group.length === 1) { policies.push(group[0].policy); continue; }
    for (const { docId } of group) invalid.push({ docId, employeeId, codes: [employeeId], reason: `Trùng mã nhân viên ${employeeId} với tài liệu khác.` });
  }
  // A broken document that names a code also blocks the valid document of that code.
  const held = new Set(invalid.flatMap(item => item.codes));
  return {
    policies: policies.filter(policy => !held.has(policy.employeeId))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId)),
    invalid: invalid.sort((a, b) => a.docId.localeCompare(b.docId)),
  };
}

/**
 * Codes whose exemption state is unknown because their document is broken, and
 * whether some broken document names no code at all (then nobody's state is known).
 * @param {InvalidCheckinExemption[]} invalid
 */
export function exemptionQuarantine(invalid = []) {
  const codesOf = item => Array.isArray(item.codes) ? item.codes : item.employeeId ? [item.employeeId] : [];
  return {
    ids: new Set(invalid.flatMap(codesOf)),
    unidentified: invalid.filter(item => codesOf(item).length === 0).length,
  };
}

/** Missing legacy configuration means no exemptions. Malformed configuration throws.
 * Callers holding raw documents should use parseCheckinExemptionDocs() instead.
 * @param {unknown} [value] @returns {CheckinExemption[]}
 */
export function normalizeCheckinExemptions(value = []) {
  if (!Array.isArray(value)) fail('Danh sách miễn chấm ăn không hợp lệ.');
  const policies = value.map(normalizeCheckinExemption);
  const ids = new Set();
  for (const policy of policies) {
    if (ids.has(policy.employeeId)) fail(`Trùng mã nhân viên ${policy.employeeId} trong danh sách miễn chấm ăn.`, 'employeeId');
    ids.add(policy.employeeId);
  }
  return policies;
}

/** @param {CheckinExemption} policy @param {string} date @param {ExemptionMeal} meal */
export const exemptionCovers = (policy, date, meal) =>
  policy.periods.some(period => period.meals.includes(meal) && period.from <= date && (period.to === null || date <= period.to));

/**
 * Validate and index once for whole-school reconciliation or an Agent alert batch.
 * The returned function answers "is this registered meal exempt?"; its
 * `emailMismatch` method answers "a policy covers this code/day/meal but under
 * another email" (the policy is then NOT applied — useful as an admin hint).
 * @param {unknown} [checkinExemptions]
 */
export function createCheckinExemptionMatcher(checkinExemptions = []) {
  const policies = new Map(normalizeCheckinExemptions(checkinExemptions).map(policy => [policy.employeeId, policy]));
  /** @param {{ date: string, employeeId: unknown, email?: unknown, meal?: ExemptionMeal }} input */
  const lookup = ({ date, employeeId, meal = 'lunch' }) => {
    const policy = policies.get(normalizeExemptionEmployeeId(employeeId));
    return policy && isIsoDate(date) && MEALS.includes(meal) && exemptionCovers(policy, date, meal) ? policy : null;
  };
  /** @param {{ date: string, employeeId: unknown, email?: unknown, meal?: ExemptionMeal }} input */
  const match = input => {
    const address = normalizeEmail(input.email);
    const policy = lookup(input);
    return !!policy && SCHOOL_EMAIL.test(address) && policy.email === address;
  };
  /** @param {{ date: string, employeeId: unknown, email?: unknown, meal?: ExemptionMeal }} input */
  match.emailMismatch = input => {
    const policy = lookup(input);
    return !!policy && policy.email !== normalizeEmail(input.email);
  };
  return match;
}

// Backward-compatible caller name for the original lunch-only implementation.
export const createLunchCheckinExemptionMatcher = createCheckinExemptionMatcher;

/** This waives only the lunch tap obligation. Registration is checked by callers.
 * @param {{ date: string, employeeId: unknown, email?: unknown, checkinExemptions?: unknown }} input
 */
export function isLunchCheckinExempt({ checkinExemptions = [], ...identity }) {
  return createCheckinExemptionMatcher(checkinExemptions)({ ...identity, meal: 'lunch' });
}
