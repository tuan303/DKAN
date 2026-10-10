/**
 * Gộp lượt chấm mới lấy từ máy vào document `checkins/{ngày}` đang có, và dựng
 * phần trạng thái đồng bộ ghi vào `settings/checkinSync`.
 *
 * Vì sao phải gộp chứ không ghi đè như bản cũ: bản cũ ghi đè trọn ngày bằng dữ
 * liệu của lần chạy. Một máy lỗi (mất mạng, tắt cổng web) là toàn bộ lượt chấm
 * của máy đó trong 7 ngày bị xoá khỏi hệ thống, và CBNV ăn ở máy đó bị coi là
 * "đăng ký mà không chấm". Bây giờ mỗi ngày giữ riêng phần của từng máy
 * (`byDevice`); máy thành công thì thay phần của nó — nhưng chỉ ở những ngày
 * máy thật sự trả dữ liệu (xem deviceSpans) — máy lỗi thì giữ nguyên.
 *
 * File thuần: không import Node hay Firebase, để test được mà không cần máy
 * nhận diện hay Firestore. Việc đọc/ghi do sync-checkins.mjs làm.
 */

import { ISO_DATE_RE, HHMM_RE, addDays, uniqSorted, clip } from './common.mjs';

export const SOURCE = 'hikvision-agent';

// Giữ 100 ngày cho coverage và alerts trong settings/checkinSync. Trang "Chấm
// ăn của tôi" cho xem tháng này và HAI tháng trước — xa nhất là ngày 31 xem lại
// ngày 01 của hai tháng trước, tức 91 ngày. Giữ ít hơn thì tháng cũ nhất mất
// mốc chốt và hiện "Không còn dữ liệu chốt" dù dữ liệu vẫn đủ. Không giữ mãi vì
// document này mọi người đều đọc mỗi lần mở trang (100 ngày ≈ vài chục KB).
export const KEEP_DAYS = 100;

/**
 * @typedef {{ name: string, times: string[] }} PersonTaps
 * @typedef {Record<string, PersonTaps>} People        mã NV thô -> lượt chấm
 * @typedef {Record<string, People>} DeviceParts       tên máy -> People
 * @typedef {{ employeeId: string, name?: string, time: string, device: string }} TapEvent
 */

/**
 * Gom sự kiện thô về dạng ngày -> máy -> mã NV thô -> { name, times[] }.
 *
 * Bỏ sự kiện nằm ngoài khoảng đã hỏi máy: dữ liệu của những ngày đó chỉ là
 * một phần (máy không được hỏi trọn ngày), đem gộp vào sẽ thay phần đầy đủ
 * đang có bằng phần dở dang.
 *
 * @param {TapEvent[]} events
 * @param {{ from?: string, to?: string }} [range] YYYY-MM-DD, gồm hai đầu
 * @returns {{ byDate: Record<string, DeviceParts>, outside: number }}
 */
export function groupByDateDevice(events, range = {}) {
  /** @type {Record<string, DeviceParts>} */
  const byDate = {};
  let outside = 0;
  for (const e of events) {
    // Chuỗi thời gian thiết bị trả về: 2026-08-07T07:31:22+07:00 — đã là giờ
    // địa phương của máy, nên cắt chuỗi là ra ngày/giờ Việt Nam.
    const time = String(e.time || '');
    const date = time.slice(0, 10);
    const hhmm = time.slice(11, 16);
    if (!ISO_DATE_RE.test(date) || !HHMM_RE.test(hhmm)) continue;
    if ((range.from && date < range.from) || (range.to && date > range.to)) { outside++; continue; }
    const id = String(e.employeeId || '').trim();
    if (!id) continue;

    const day = (byDate[date] ||= {});
    const part = (day[e.device] ||= {});
    const person = (part[id] ||= { name: '', times: [] });
    if (!person.name && e.name) person.name = String(e.name).trim();
    if (!person.times.includes(hhmm)) person.times.push(hhmm);
  }
  for (const day of Object.values(byDate)) {
    for (const part of Object.values(day)) {
      for (const p of Object.values(part)) p.times.sort();
    }
  }
  return { byDate, outside };
}

/**
 * Hợp nhiều phần People: cùng mã thô thì gộp giờ (duy nhất, sắp xếp), tên lấy
 * bản đầu tiên không rỗng.
 * @param {Array<People | null | undefined>} parts
 * @returns {People}
 */
export function unionPeople(parts) {
  /** @type {People} */
  const out = {};
  for (const part of parts) {
    for (const [id, p] of Object.entries(part || {})) {
      const cur = (out[id] ||= { name: '', times: [] });
      if (!cur.name && p?.name) cur.name = String(p.name);
      if (Array.isArray(p?.times)) cur.times.push(...p.times.filter(t => typeof t === 'string'));
    }
  }
  for (const p of Object.values(out)) p.times = uniqSorted(p.times);
  return out;
}

const countPeople = (/** @type {People | null | undefined} */ p) => Object.keys(p || {}).length;

/** Hai People có cùng người và cùng giờ chấm (bỏ qua tên). @param {People} a @param {People} b */
function samePeopleTimes(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(id => {
    const x = a[id]?.times || [];
    const y = b[id]?.times || [];
    return x.length === y.length && x.every((t, i) => t === y[i]);
  });
}

/**
 * @typedef {{ from: string, to: string }} Span   khoảng ngày, gồm hai đầu
 */

/**
 * Khoảng ngày mà từng máy THỰC SỰ trả dữ liệu trong lần chạy: từ ngày sớm nhất
 * tới ngày muộn nhất có lượt chấm của máy đó (trong khoảng đã hỏi). null nếu
 * máy không trả lượt chấm nào.
 *
 * Vì sao cần: máy trả lời "thành công" chưa chắc đã trả đủ cả khoảng ngày. Bộ
 * nhớ sự kiện bị xoá giữa tuần (nâng firmware, thay máy cùng tên cùng IP, bấm
 * xoá trong HAC) thì máy chỉ còn dữ liệu từ hôm đó trở đi; máy lệch giờ thì các
 * ngày gần nhất trống trơn; lấy bù --days 30 thì các ngày quá bộ nhớ của máy
 * cũng trống. Hiểu những ngày trống đó là "không ai chấm ở máy này" thì phần cũ
 * của máy bị thay bằng rỗng — mất lượt chấm vĩnh viễn, vì máy cũng không còn
 * giữ. Nên ngoài khoảng này máy coi như KHÔNG phủ ngày đó: giữ phần cũ, không
 * chốt dữ liệu ngày đó. Bên trong khoảng, ngày trống là trống thật (vd. hôm đó
 * bếp có máy này nghỉ).
 *
 * @param {Record<string, DeviceParts>} freshByDate  từ groupByDateDevice
 * @param {string[]} devices
 * @returns {Record<string, Span | null>}
 */
export function deviceSpans(freshByDate, devices) {
  /** @type {Record<string, Span | null>} */
  const spans = {};
  for (const d of devices) spans[d] = null;
  for (const date of Object.keys(freshByDate).sort()) {
    for (const d of devices) {
      if (countPeople(freshByDate[date]?.[d]) === 0) continue;
      const s = spans[d];
      spans[d] = s ? { from: s.from, to: date } : { from: date, to: date };
    }
  }
  return spans;
}

/** Máy có phủ ngày này trong lần chạy không. @param {Span | null | undefined} span @param {string} date */
export const coversDate = (span, date) => !!span && span.from <= date && date <= span.to;

/**
 * Document `checkins/{date}` sau khi gộp lần chạy này, hoặc null nếu không cần
 * ghi: ngày chưa có document và lần này cũng không ai chấm (không tạo document
 * rỗng), hoặc lần này không máy nào phủ ngày đó (không có gì để thay — giữ
 * nguyên document, kể cả cờ complete và syncedAt của lần ghi trước).
 *
 * @param {{
 *   date: string,
 *   existing?: { people?: People, byDevice?: DeviceParts } | null,  // document đang có
 *   fresh?: DeviceParts,            // phần mới của các máy THÀNH CÔNG trong ngày này
 *   okDevices: string[],            // máy thành công trong lần chạy
 *   coveringDevices?: string[],     // máy thành công VÀ phủ ngày này (xem deviceSpans); mặc định = okDevices
 *   configDevices: string[],        // mọi máy trong config
 *   syncedAt: string,
 * }} input
 */
export function mergeDayDoc({ date, existing = null, fresh = {}, okDevices, coveringDevices = okDevices, configDevices, syncedAt }) {
  // Chỉ máy thành công mới được thay phần của mình. Máy có lượt chấm trong
  // chính ngày này thì chắc chắn đã trả dữ liệu cho ngày này — tính là phủ dù
  // nơi gọi quên khai, để dữ liệu mới không bao giờ bị bỏ rơi.
  const covering = new Set(okDevices.filter(d => coveringDevices.includes(d) || countPeople(fresh[d]) > 0));
  const complete = configDevices.every(d => covering.has(d));

  // Không máy nào phủ ngày này (máy lỗi, hoặc ngày nằm ngoài phần dữ liệu máy
  // còn giữ): không có gì để thay. Ghi lại thì chỉ đổi syncedAt/complete mà
  // không thêm dữ liệu gì — với document dạng cũ còn là ghi đè people bằng
  // rỗng nếu đi vào nhánh "đủ máy" bên dưới.
  if (existing && covering.size === 0) return null;

  // Máy phủ ngày này mà không có lượt nào vẫn có phần (rỗng): máy đã trả lời
  // đầy đủ rằng hôm đó không ai chấm ở máy này.
  /** @type {DeviceParts} */
  const freshParts = {};
  for (const d of covering) freshParts[d] = unionPeople([fresh[d]]);

  const hasByDevice = !!existing && !!existing.byDevice && typeof existing.byDevice === 'object';

  /** @type {DeviceParts | null} */
  let byDevice;
  /** @type {People} */
  let people;

  if (!existing || (!hasByDevice && complete)) {
    // Ngày mới, hoặc document cũ (trước bản này) mà lần này MỌI máy đều phủ
    // ngày đó: dữ liệu mới đã trọn vẹn, ghi mới hoàn toàn.
    byDevice = freshParts;
    people = unionPeople(Object.values(byDevice));
  } else if (!hasByDevice) {
    // Document cũ không biết lượt nào của máy nào, mà lần này lại có máy lỗi
    // hoặc máy không phủ ngày này: chỉ có thể HỢP thêm, không được thay. Cũng
    // không dựng byDevice từ phần máy thành công — làm vậy thì lần sau máy kia
    // lại lỗi, phần cũ của nó không còn chỗ nào giữ và bị mất. Để nguyên dạng
    // cũ tới khi có một lần mọi máy cùng phủ ngày này.
    byDevice = null;
    people = unionPeople([existing.people, ...Object.values(freshParts)]);
    // Không thêm được gì: không ghi (đỡ lượt ghi, giữ nguyên dấu vết cũ).
    if (samePeopleTimes(people, unionPeople([existing.people]))) return null;
  } else {
    // Máy lỗi (hoặc không phủ ngày này) giữ phần cũ; máy phủ ngày này thay bằng
    // phần mới (kể cả rỗng).
    byDevice = { ...existing.byDevice, ...freshParts };
    people = unionPeople(Object.values(byDevice));
  }

  if (!existing && countPeople(people) === 0) return null;

  /** @type {Record<string, unknown>} */
  const doc = { date, month: date.slice(0, 7), people, complete, source: SOURCE, syncedAt };
  if (byDevice) doc.byDevice = byDevice;
  return doc;
}

/**
 * Máy "thành công" nhưng trả về 0 lượt chấm cho CẢ khoảng ngày, trong khi hệ
 * thống đã có lượt chấm của chính máy đó trong khoảng ấy.
 *
 * Gần như chắc chắn là máy có vấn đề (lệch giờ nên hỏi sai khoảng, vừa bị xoá
 * bộ nhớ, firmware trả lời rỗng) chứ không phải mọi người bỗng không chấm. Coi
 * là thành công thì phần của máy bị thay bằng rỗng — đúng lỗi mất dữ liệu mà
 * bản này sinh ra để sửa. Coi như máy lỗi: giữ phần cũ, không chốt dữ liệu.
 *
 * Document dạng cũ (chưa có byDevice, ghi trước bản này) không cho biết lượt
 * nào của máy nào. Lần chạy đầu sau khi nâng cấp, mọi document trong khoảng
 * đều ở dạng đó — nếu chỉ đếm byDevice thì máy lệch giờ lọt qua. Với dạng cũ:
 * trong một ngày mà máy khác có trả dữ liệu mới, người có lượt chấm trong
 * document mà không có trong dữ liệu mới của các máy khác thì lượt đó chỉ có
 * thể đến từ máy này. Ngày không máy nào khác trả dữ liệu thì không đủ căn cứ.
 *
 * @param {{
 *   okDevices: string[],
 *   freshByDate: Record<string, DeviceParts>,
 *   existingDocs: Record<string, { people?: People, byDevice?: DeviceParts } | null | undefined>,
 * }} input
 * @returns {{ name: string, knownPeople: number }[]}
 */
export function findSuspectDevices({ okDevices, freshByDate, existingDocs }) {
  const out = [];
  for (const name of okDevices) {
    const freshCount = Object.values(freshByDate).reduce((s, day) => s + countPeople(day[name]), 0);
    if (freshCount > 0) continue;
    let known = 0;
    for (const [date, doc] of Object.entries(existingDocs)) {
      if (!doc) continue;
      if (doc.byDevice && typeof doc.byDevice === 'object') {
        known += countPeople(doc.byDevice[name]);
        continue;
      }
      const others = new Set(okDevices.filter(o => o !== name).flatMap(o => Object.keys(freshByDate[date]?.[o] || {})));
      if (!others.size) continue;
      for (const [id, p] of Object.entries(doc.people || {})) {
        if (Array.isArray(p?.times) && p.times.length && !others.has(id)) known++;
      }
    }
    if (known > 0) out.push({ name, knownPeople: known });
  }
  return out;
}

/**
 * Các khoá ngày cần xoá khỏi một map theo ngày (coverage, alerts): cũ hơn
 * `keepDays` ngày tính tới hôm nay, hoặc không phải ngày hợp lệ.
 * @param {Record<string, unknown> | null | undefined} map
 * @param {string} today YYYY-MM-DD
 * @param {number} [keepDays]
 */
export function pruneDateKeys(map, today, keepDays = KEEP_DAYS) {
  const cutoff = addDays(today, -(keepDays - 1));
  return Object.keys(map || {}).filter(k => !ISO_DATE_RE.test(k) || k < cutoff);
}

/**
 * @typedef {object} DeviceResult
 * @property {string} name
 * @property {boolean} ok
 * @property {string} at       ISO, lúc xong việc với máy này
 * @property {number} events   số lượt chấm lấy được
 * @property {string | null} error
 */

/**
 * Phần cập nhật cho `settings/checkinSync` sau phần đồng bộ (chưa gồm alerts),
 * để ghi bằng set(..., { merge: true }).
 *
 * Document này mọi người đã đăng nhập đều đọc được, nên chỉ chứa thông tin về
 * máy và thời điểm — không có mã NV hay tên ai.
 *
 * @param {{
 *   agentVersion: string,
 *   runEndAt: string,               // ISO, lúc xong việc với mọi máy
 *   complete: boolean,              // mọi máy trong config đều thành công
 *   existing?: Record<string, any> | null,   // document đang có
 *   deviceResults: DeviceResult[],
 *   configDevices: string[],
 *   coveredDates: string[],         // ngày trong khoảng --days mà MỌI máy đều phủ (xem deviceSpans)
 *   today: string,
 *   del: unknown,                   // giá trị "xoá trường" (FieldValue.delete() khi chạy thật)
 *   keepDays?: number,
 * }} input
 */
export function buildSyncSettings({ agentVersion, runEndAt, complete, existing, deviceResults, configDevices, coveredDates, today, del, keepDays = KEEP_DAYS }) {
  const prev = existing || {};

  /** @type {Record<string, unknown>} */
  const devices = {};
  for (const r of deviceResults) {
    const before = prev.devices?.[r.name] || {};
    devices[r.name] = {
      ok: r.ok,
      at: r.at,
      events: r.ok ? r.events : 0,
      // Lỗi chỉ là chuyện máy (IP, cổng, mã HTTP) — không có dữ liệu cá nhân.
      error: r.ok ? null : clip(String(r.error || 'lỗi không rõ').replace(/\s*\n\s*/g, ' | '), 300),
      lastOkAt: r.ok ? r.at : (before.lastOkAt ?? null),
    };
  }
  // Máy đã bỏ khỏi config thì bỏ luôn khỏi trạng thái, nếu không trang
  // "Chấm ăn của tôi" cứ báo máy lỗi mãi.
  for (const name of Object.keys(prev.devices || {})) {
    if (!configDevices.includes(name)) devices[name] = del;
  }

  /** @type {Record<string, unknown>} */
  const out = {
    agentVersion,
    lastRunAt: runEndAt,
    lastRunComplete: complete,
    lastCompleteAt: complete ? runEndAt : (prev.lastCompleteAt ?? null),
    devices,
  };

  // coverage chỉ được đụng tới khi lần chạy đủ mọi máy: nó là lời khẳng định
  // "dữ liệu ngày này đã đủ", căn cứ để báo ai đó "chưa chấm". Và chỉ đóng dấu
  // những ngày mà MỌI máy đều thật sự trả dữ liệu (coveredDates): ngày một máy
  // không trả gì (bộ nhớ bị xoá, lệch giờ) giữ nguyên dấu của lần trước, không
  // được khẳng định lại bằng dữ liệu thiếu.
  if (complete) {
    const cutoff = addDays(today, -(keepDays - 1));
    /** @type {Record<string, unknown>} */
    const coverage = {};
    for (const d of coveredDates) if (d >= cutoff) coverage[d] = runEndAt;
    for (const k of pruneDateKeys(prev.coverage, today, keepDays)) coverage[k] = del;
    // KHÔNG ghi map rỗng: với set(..., { merge: true }), Firestore coi `coverage:
    // {}` là "đặt cả trường thành map rỗng" — xoá sạch mọi mốc chốt đang có.
    // Xảy ra khi đủ máy mà không ngày nào được mọi máy cùng phủ (vd. một máy
    // không có lượt nào hôm nay ở lần chạy --days 1).
    if (Object.keys(coverage).length) out.coverage = coverage;
  }
  return out;
}

/**
 * Số người và số lượt của một ngày, để in ra màn hình.
 * @param {People | null | undefined} people
 */
export function summarizePeople(people) {
  const list = Object.values(people || {});
  return { people: list.length, taps: list.reduce((s, p) => s + (p.times?.length || 0), 0) };
}
