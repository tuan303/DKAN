/**
 * Tách lượt chấm của cả trường (`checkins/{ngày}`, chỉ quản trị đọc) thành
 * lượt chấm của TỪNG NGƯỜI (`meal_taps/{uid}/months/{tháng}`), để CBNV tự xem
 * trên trang "Chấm ăn của tôi" mà không lộ giờ ăn của người khác.
 *
 * Khó nhất là gán mã NV trên máy cho đúng tài khoản. Theo đúng tab Đối soát
 * của quản trị và email cảnh báo: CHỈ mã chụp trên đơn đăng ký tháng đó là căn
 * cứ. Mã mà hai tài khoản cùng đứng thì từ ngày trùng không đưa lượt chấm cho ai
 * cả: đưa nhầm là lộ giờ ăn của người này cho người kia.
 *
 * File thuần, không import Node hay Firebase.
 */

import { normId, isUsableId, registrationEffectiveFrom } from './meal-rules.mjs';
import { HHMM_RE, uniqSorted, sameList } from './common.mjs';

/**
 * `people` thô của một document checkins -> Map mã NV đã chuẩn hoá -> giờ chấm.
 *
 * Hai khoá thô khác nhau có thể cùng là một người ("101190" và "101190 " do
 * từng nhập tay không trim) — gộp giờ lại.
 *
 * @param {Record<string, { times?: unknown }> | null | undefined} people
 * @returns {Map<string, string[]>}
 */
export function normalizePeople(people) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const [raw, info] of Object.entries(people || {})) {
    const id = normId(raw);
    if (!id) continue;
    const times = Array.isArray(info?.times) ? info.times.filter(t => typeof t === 'string' && HHMM_RE.test(t)) : [];
    map.set(id, (map.get(id) || []).concat(times));
  }
  for (const [id, t] of map) map.set(id, uniqSorted(t));
  return map;
}

/**
 * @template K, V
 * @param {Map<K, Set<V>>} map @param {K} key @param {V} value
 */
const addTo = (map, key, value) => {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(value);
};

/**
 * @typedef {object} OwnerIndex
 * @property {Map<string, string>} ownerOf       mã NV -> uid được nhận lượt chấm của mã đó
 * @property {Map<string, string[]>} idsOf       uid -> mọi mã gắn với uid (kể cả mã trùng)
 * @property {Map<string, string[]>} conflictsOf uid -> các mã bị trùng của uid
 * @property {Map<string, string | null>} conflictSinceOf uid -> ngày bắt đầu trùng (null = cả tháng)
 * @property {Map<string, { uid: string, until: string }>} earlyOwnerOf
 *   mã trùng -> người đăng ký trước, được nhận lượt chấm của mã đó TRƯỚC ngày trùng
 */

/**
 * Bảng gán mã NV -> tài khoản cho một tháng, CHỈ theo đơn đăng ký của tháng.
 *
 * KHÔNG dùng mã trong hồ sơ staff: hồ sơ do chính chủ sửa được bất cứ lúc nào,
 * nên người chưa đăng ký chỉ cần đổi mã trong hồ sơ là "nhận" được giờ ăn của
 * một người không có tài khoản (vd. nhân viên bếp) rồi xem trên trang cá nhân.
 * Người không đăng ký tháng đó thì không có bữa nào để đối chiếu, trang cá nhân
 * cũng không cần lượt chấm của họ.
 *
 * Mã thuộc bộ phận loại trừ (Bếp Vina) cũng không gán cho ai: ai đăng ký mang
 * mã đó sẽ thấy giờ chấm công của nhân viên bếp.
 *
 * Mã đứng trên đơn của hai tài khoản: từ ngày đơn thứ hai có hiệu lực
 * (registrationEffectiveFrom) thì không biết lượt chấm là của ai — không gán cho
 * ai, cả hai bị đánh dấu trùng từ ngày đó (conflictSince). TRƯỚC ngày đó lượt
 * chấm vẫn thuộc người đăng ký trước (earlyOwnerOf) — đúng như email cảnh báo
 * và tab quản trị (duplicateIdsOn), để trang cá nhân không "rút lại" một kết
 * luận đã gửi email.
 *
 * @param {{
 *   registrations?: { uid: string, employeeId?: unknown, month?: string, firstMealDate?: string, timestamp?: string }[],  // đơn của tháng
 *   excludedIds?: Iterable<string>,
 * }} input
 * @returns {OwnerIndex}
 */
export function buildOwnerIndex({ registrations = [], excludedIds = [] }) {
  const excluded = new Set([...excludedIds].map(normId));
  /** mã -> uid -> ngày bắt đầu hiệu lực ('' = không rõ, coi như đầu tháng) */
  /** @type {Map<string, Map<string, string>>} */ const holders = new Map();
  for (const r of registrations) {
    if (!r.uid) continue;
    const id = normId(r.employeeId);
    if (!isUsableId(id) || excluded.has(id)) continue;
    const from = registrationEffectiveFrom(/** @type {any} */ (r)) || '';
    let m = holders.get(id);
    if (!m) holders.set(id, (m = new Map()));
    const prev = m.get(r.uid);
    if (prev === undefined || from < prev) m.set(r.uid, from);
  }

  /** @type {Map<string, string>} */ const ownerOf = new Map();
  /** @type {Map<string, Set<string>>} */ const ids = new Map();
  /** @type {Map<string, Set<string>>} */ const conflicts = new Map();
  /** @type {Map<string, string | null>} */ const conflictSinceOf = new Map();
  /** @type {Map<string, { uid: string, until: string }>} */ const earlyOwnerOf = new Map();

  for (const [id, m] of holders) {
    for (const u of m.keys()) addTo(ids, u, id);
    if (m.size === 1) {
      ownerOf.set(id, [...m.keys()][0]);
      continue;
    }
    const byStart = [...m].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
    const since = byStart[1][1]; // ngày đơn thứ hai có hiệu lực
    if (since && byStart[0][1] < since) earlyOwnerOf.set(id, { uid: byStart[0][0], until: since });
    for (const [u] of byStart) {
      addTo(conflicts, u, id);
      const sinceOrNull = since || null;
      const cur = conflictSinceOf.get(u);
      // Một người trùng nhiều mã: lấy ngày trùng sớm nhất (null = cả tháng là sớm nhất).
      if (cur === undefined || (cur !== null && (sinceOrNull === null || sinceOrNull < cur))) conflictSinceOf.set(u, sinceOrNull);
    }
  }

  const sortedMap = (/** @type {Map<string, Set<string>>} */ m) =>
    new Map([...m].map(([k, v]) => [k, uniqSorted(v)]));
  return { ownerOf, idsOf: sortedMap(ids), conflictsOf: sortedMap(conflicts), conflictSinceOf, earlyOwnerOf };
}

/**
 * @typedef {object} TapPlan
 * @property {string[]} employeeIds
 * @property {boolean} conflict
 * @property {string[]} conflictIds
 * @property {string | null} conflictSince  ngày bắt đầu trùng mã (null = cả tháng, hoặc không trùng)
 * @property {Record<string, string[]>} days  ngày -> giờ chấm (chỉ ngày có lượt chấm)
 */

/**
 * Lượt chấm của từng tài khoản trong các ngày của MỘT tháng.
 *
 * Gom theo uid trước khi ghi: một người có thể nhận lượt chấm từ hơn một mã
 * (vd. hai đơn khác mã) — hợp giờ lại thay vì ghi hai lần đè nhau.
 *
 * @param {{
 *   dates: string[],                                   // các ngày của tháng có trong lần chạy
 *   peopleByDate: Record<string, Map<string, string[]> | undefined>,  // từ normalizePeople
 *   index: OwnerIndex,
 * }} input
 * @returns {{ plans: Map<string, TapPlan>, unclaimed: Set<string> }}
 *   unclaimed: mã có lượt chấm mà không gắn được với tài khoản nào (để in thống kê)
 */
export function projectMonth({ dates, peopleByDate, index }) {
  /** @type {Map<string, TapPlan>} */
  const plans = new Map();
  for (const [uid, ids] of index.idsOf) {
    const conflictIds = index.conflictsOf.get(uid) || [];
    const conflict = conflictIds.length > 0;
    const conflictSince = conflict ? (index.conflictSinceOf?.get(uid) ?? null) : null;
    plans.set(uid, { employeeIds: ids, conflict, conflictIds, conflictSince, days: {} });
  }

  // Mã đang gắn với ít nhất một tài khoản (kể cả mã trùng) — phần còn lại là
  // mã không ai nhận, chỉ để thống kê.
  const known = new Set([...index.idsOf.values()].flat());
  /** @type {Set<string>} */
  const unclaimed = new Set();
  for (const date of dates) {
    const people = peopleByDate[date];
    if (!people) continue;
    for (const [id, times] of people) {
      if (!times.length) continue;
      let uid = index.ownerOf.get(id);
      if (!uid) {
        // Mã trùng: trước ngày trùng, lượt chấm vẫn là của người đăng ký trước.
        const early = index.earlyOwnerOf?.get(id);
        if (early && date < early.until) uid = early.uid;
      }
      const plan = uid ? plans.get(uid) : undefined;
      if (!plan) {
        if (!known.has(id)) unclaimed.add(id);
        continue;
      }
      // Từ ngày trùng mã, tài khoản không nhận lượt chấm nào, kể cả của mã không
      // trùng: trang cá nhân báo trùng mã thay vì hiện nửa đúng nửa sai.
      if (plan.conflict && (!plan.conflictSince || date >= plan.conflictSince)) continue;
      plan.days[date] = uniqSorted([...(plan.days[date] || []), ...times]);
    }
  }
  return { plans, unclaimed };
}

/**
 * Cách gán mã NV cho tài khoản này trong tháng đã đổi so với lần ghi trước
 * (hoặc chưa từng ghi) — khi đó phải tách lại CẢ THÁNG cho tài khoản này chứ
 * không chỉ các ngày của lần chạy.
 *
 * Vì sao: lần chạy hằng đêm chỉ lấy 7 ngày. Một người bị trùng mã từ đầu tháng
 * (không được ghi ngày nào) tới khi quản trị sửa mã ngày 13 thì lần chạy đêm
 * đó chỉ ghi các ngày 7–13; các ngày 1–6 không bao giờ được ghi — trang "Chấm
 * ăn của tôi" báo "Chưa chấm" oan cho những ngày đó vì dữ liệu đã chốt. Ngược
 * lại, người sửa mã trong hồ sơ thì các ngày cũ vẫn giữ giờ ăn của MÃ CŨ — giờ
 * ăn của người khác.
 *
 * @param {{ employeeIds?: unknown, conflict?: unknown, conflictIds?: unknown, conflictSince?: unknown } | null | undefined} existing
 * @param {TapPlan} plan
 */
export function mappingChanged(existing, plan) {
  if (!existing) return true;
  return !sameList(existing.employeeIds, plan.employeeIds) ||
    existing.conflict !== plan.conflict ||
    (existing.conflictSince ?? null) !== (plan.conflict ? plan.conflictSince ?? null : null) ||
    !sameList(existing.conflictIds, plan.conflictIds);
}

/**
 * Nội dung cần ghi vào `meal_taps/{uid}/months/{month}` (set merge), hoặc null
 * nếu document đã đúng — để không tốn lượt ghi của gói Spark cho document
 * không đổi (agent chạy nhiều lần mỗi ngày, phần lớn người không đổi gì).
 *
 * Chỉ đụng tới các ngày trong `dates`: ngày ngoài danh sách giữ nguyên. Nơi gọi
 * truyền các ngày của lần chạy, hoặc mọi ngày của tháng tới hôm nay khi cách
 * gán mã đã đổi (xem mappingChanged). Ngày trong danh sách mà nay không còn
 * lượt chấm của người này (vd. mã vừa được gán lại cho đúng người) thì xoá
 * ngày đó bằng `del`.
 *
 * @param {{
 *   uid: string,
 *   month: string,
 *   existing?: { uid?: string, month?: string, employeeIds?: string[], conflict?: boolean, conflictIds?: string[], conflictSince?: string | null, days?: Record<string, string[]> } | null,
 *   plan: TapPlan,
 *   dates: string[],
 *   updatedAt: string,
 *   del: unknown,   // FieldValue.delete() khi chạy thật
 * }} input
 * @returns {Record<string, unknown> | null}
 */
export function diffTapDoc({ uid, month, existing = null, plan, dates, updatedAt, del }) {
  /** @type {Record<string, unknown>} */
  const days = {};
  // Tài khoản trùng mã: từ ngày trùng không ghi `days` (đúng hợp đồng), chỉ
  // bật cờ trùng; các ngày trước đó lượt chấm vẫn rõ chủ nên vẫn ghi.
  const writable = plan.conflict
    ? dates.filter(d => !!plan.conflictSince && d < plan.conflictSince)
    : dates;
  {
    for (const d of writable) {
      const next = plan.days[d];
      const prev = existing?.days?.[d];
      if (next && next.length) {
        if (!sameList(prev, next)) days[d] = next;
      } else if (prev !== undefined) {
        days[d] = del;
      }
    }
  }

  // Ngày bắt đầu trùng mã, tính từ chính các đơn (buildOwnerIndex) chứ không từ
  // ngày agent chạy: trang "Chấm ăn của tôi" chỉ treo kết luận từ ngày này trở
  // đi, khớp với email cảnh báo và tab quản trị. null = trùng cả tháng.
  const conflictSince = plan.conflict ? plan.conflictSince ?? null : null;
  const meta = { uid, month, employeeIds: plan.employeeIds, conflict: plan.conflict, conflictIds: plan.conflictIds, conflictSince };

  if (!existing) {
    // Không tạo document cho người chưa từng chấm: trang cá nhân hiểu "không có
    // document" là chưa có lượt chấm. Riêng người trùng mã thì phải tạo, vì đó
    // là cách duy nhất để báo cho họ biết.
    if (!Object.keys(days).length && !plan.conflict) return null;
    return { ...meta, days, updatedAt };
  }

  const metaChanged =
    existing.uid !== uid ||
    existing.month !== month ||
    !sameList(existing.employeeIds, meta.employeeIds) ||
    existing.conflict !== meta.conflict ||
    (existing.conflictSince ?? null) !== meta.conflictSince ||
    !sameList(existing.conflictIds, meta.conflictIds);
  if (!metaChanged && !Object.keys(days).length) return null;

  /** @type {Record<string, unknown>} */
  const out = { ...meta, updatedAt };
  if (Object.keys(days).length) out.days = days;
  return out;
}
