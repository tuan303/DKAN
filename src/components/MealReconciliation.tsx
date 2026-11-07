import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as xlsx from 'xlsx';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { ReconciliationMonthPicker } from './ReconciliationMonthPicker';
import { filterReferenceCheckins, referenceCheckinDates, referenceCheckinRows } from '../lib/mealReference';
import { agentSupports } from '../lib/agentFeatures';
import {
  exemptionQuarantine,
  parseCheckinExemptionDocs,
  type CheckinExemption,
  type InvalidCheckinExemption,
} from '../../agent/lib/checkin-exemptions.mjs';
// Quy tắc suất ăn (khung giờ, chuẩn hoá mã NV, ai đáng lẽ phải ăn, ngày nghỉ,
// giờ Việt Nam) dùng chung với trang "Chấm ăn của tôi" và agent gửi email cảnh
// báo. Không viết lại quy tắc ở file này: lệch một chỗ là quản trị thấy "đã
// chấm" trong khi CBNV nhận email "chưa chấm".
import {
  MEALS,
  MEAL_LABEL,
  MEAL_WINDOWS,
  buildFromCheckins,
  classifyTimes,
  formatDate,
  formatDayLabel,
  formatVnDateTime,
  isMealDay,
  isMealFinal,
  isWeekday,
  normId,
  reconcile,
  vnParts,
  vnToday,
} from '../../agent/lib/meal-rules.mjs';
import type { Cancelation, Meal, Registration, Row, TapRecord } from '../../agent/lib/meal-rules.mjs';

// Dữ liệu từ máy nhận diện không có cột bộ phận nên không tự lọc được Bếp
// Vina. Khi đọc file Excel của HAC (có bộ phận), app ghi lại danh sách mã cần
// loại vào đây để chế độ tự động dùng lại.
const EXCLUDES_DOC = 'reconcileExcludes';
// Ngày nghỉ (lễ, Tết...) quản trị khai ở tab Cấu hình.
const OFF_DAYS_DOC = 'mealOffDays';
// Tình trạng đồng bộ và gửi cảnh báo do agent trên máy HAC ghi.
const SYNC_DOC = 'checkinSync';

/**
 * Đối soát đăng ký ăn (DKAN) với dữ liệu chấm ăn xuất từ phần mềm HAC.
 *
 * File HAC là "Báo cáo chấm vào&ra hàng tháng": mỗi người một dòng, mỗi ngày
 * một ô dạng "07:43-11:49", "Không-11:49", "07:43-Không", hoặc "-" khi không
 * có lượt chấm nào.
 *
 * Phân bữa theo GIỜ CHẤM so với hai khung giờ trong meal-rules.mjs, không theo
 * vị trí trong ô: HAC xếp lượt chấm đầu tiên trong ngày vào vị trí 1 dù người
 * đó chỉ ăn trưa, nên vị trí không phản ánh đúng bữa. Lượt chấm rơi ngoài cả
 * hai khung thì không được ghi nhận, nhưng vẫn liệt kê riêng để nhà trường rà
 * soát.
 */

// Bộ phận không đưa vào đối soát: nhân sự bếp quẹt thẻ để chấm công chứ không
// phải để nhận suất ăn, tính vào sẽ làm phình danh sách "chấm không đăng ký".
// Chỉ file Excel của HAC có cột bộ phận nên phần này nằm ở đây, không ở
// meal-rules.mjs; các nơi khác dùng danh sách mã đã lưu ở settings/reconcileExcludes.
const EXCLUDED_DEPARTMENTS = ['NSHM>Bếp Vina'];

// So theo đoạn cuối sau dấu '>' nên vẫn khớp nếu HAC đổi tiền tố hoặc thêm
// khoảng trắng, ví dụ "Bếp Vina" hay "NSHM > Bếp Vina".
const deptLeaf = (d: string) => (d.split('>').pop() || d).replace(/\s+/g, ' ').trim().toLowerCase();
const EXCLUDED_LEAVES = new Set(EXCLUDED_DEPARTMENTS.map(deptLeaf));
const isExcludedDept = (d: string) => EXCLUDED_LEAVES.has(deptLeaf(d));

interface ParsedFile {
  month: string;
  fileName: string;
  rowCount: number;
  // date (YYYY-MM-DD) -> mã NV -> lượt chấm
  byDate: Record<string, Record<string, TapRecord>>;
  // Mã NV thuộc bộ phận bị loại, dùng để loại luôn ở phía đăng ký
  excludedIds: string[];
  // Ngày -> thời điểm (ISO) mà dữ liệu ngày đó chắc chắn đã đầy đủ, để hỏi
  // isMealFinal. Tự động: lần đồng bộ đủ mọi máy (coverageOfDocs). File Excel:
  // giờ file được lưu (parseHacWorkbook). Để tuỳ chọn để parseHacRows giữ
  // nguyên kết quả như bản cũ; thiếu mốc thì bữa coi như chưa chốt.
  coverage?: Record<string, string | null>;
  // Chỉ ở chế độ file: giờ file được lưu, hiện ra để quản trị biết số liệu
  // được coi là đầy đủ tới lúc nào.
  savedAt?: string;
  // Chỉ ở chế độ tự động: ngày chỉ có dữ liệu do agent bản cũ ghi, không có
  // mốc đủ mọi máy nào (xem legacyDatesOf).
  legacyDates?: string[];
  // Chỉ ở chế độ tự động: ngày chốt an toàn của agent đã dừng gửi cảnh báo vì
  // dữ liệu máy bất thường -> lý do (xem coverageOfDocs).
  heldDates?: Record<string, string>;
}

// Shape của settings/checkinSync (xem CONTRACT). Mọi trường để tuỳ chọn vì doc
// do agent ghi, có thể là bản agent cũ hoặc ghi dở — giao diện không được vỡ.
type AlertStatus = 'sent' | 'partial' | 'guarded' | 'nothing' | 'error' | 'off_day';

interface DeviceHealth {
  ok?: boolean;
  at?: string;
  events?: number;
  error?: string | null;
  lastOkAt?: string | null;
}

/**
 * Kết quả gửi thư "chấm nhưng chưa đăng ký" của MỘT ngày ăn. Agent xử lý nhóm
 * này ở lần chạy cảnh báo của NGÀY CÓ SUẤT ĂN KẾ TIẾP (cần dữ liệu cả ngày đã
 * chốt), rồi ghi vào alerts[ngày đó].extra. Chỉ có số đếm, không có danh tính.
 */
export interface ExtraAlertDay {
  status?: AlertStatus;
  at?: string;
  /** Số người đã xác định được tài khoản để gửi. */
  candidates?: number;
  sent?: number;
  failed?: number;
  /** Đã gọi gửi nhưng chưa xác nhận kết quả — không tự thử lại. */
  uncertain?: number;
  /** Mã có lượt chấm nhưng không gắn được với đúng một tài khoản — không gửi. */
  unmapped?: number;
  /** Có đăng ký ăn sự kiện ngày đó — không gửi. */
  eventSkipped?: number;
  reason?: string | null;
}

export interface AlertDay {
  status?: AlertStatus;
  at?: string;
  sent?: number;
  failed?: number;
  /** Đếm cả suất được miễn chấm; người còn phải chấm = expected − exempt. */
  expected?: { breakfast?: number; lunch?: number };
  missing?: { breakfast?: number; lunch?: number };
  /** Suất đã đăng ký được miễn chấm (agent có hỗ trợ miễn chấm mới ghi). */
  exempt?: { breakfast?: number; lunch?: number };
  reason?: string | null;
  /** Chốt an toàn đã dừng gửi vì dữ liệu ngày này đáng ngờ — chưa được kết luận. */
  held?: boolean;
  extra?: ExtraAlertDay;
}

export interface CheckinSync {
  agentVersion?: string;
  /** Tính năng agent đang chạy hỗ trợ, vd. ['checkinExemptions', 'extraAlerts']. */
  agentFeatures?: unknown;
  lastRunAt?: string;
  lastRunComplete?: boolean;
  lastCompleteAt?: string | null;
  devices?: Record<string, DeviceHealth>;
  coverage?: Record<string, string>;
  alerts?: Record<string, AlertDay>;
}

const mealLabel = (m: Meal | 'none') => (m === 'none' ? '—' : MEAL_LABEL[m]);

/**
 * Dữ liệu một bữa đã chốt chưa — cùng quy tắc isMealFinal mà trang Chấm ăn
 * của tôi và agent dùng để phân biệt "chưa chấm" với "chưa có dữ liệu". Tab này
 * không tự đặt quy tắc riêng, chỉ chọn mốc dữ liệu để hỏi (data.coverage):
 * - Tự động: thời điểm đồng bộ đủ mọi máy của ngày đó (xem coverageOfDocs).
 * - File Excel: giờ file được lưu (xem parseHacWorkbook). Không dùng "bây
 *   giờ": file xuất lúc 11:00 mà 14:00 mới mở thì bữa trưa hôm đó chưa có
 *   trong file, coi là đã chốt sẽ xếp cả trường vào "đăng ký nhưng không chấm".
 * Không có mốc thì coi như chưa chốt — lệch về phía số tạm là lệch an toàn.
 */
function mealFinal(data: Pick<ParsedFile, 'coverage'>, date: string, meal: Meal, now: Date): boolean {
  return isMealFinal(date, meal, data.coverage?.[date] ?? null, now);
}

const validIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

type CheckinDocMeta = { date: string; complete?: unknown; syncedAt?: unknown };

/**
 * Mốc "dữ liệu đã đủ mọi máy" của từng ngày ở chế độ tự động.
 *
 * Ưu tiên coverage do agent ghi trong settings/checkinSync — đúng mốc mà trang
 * Chấm ăn của tôi và agent dùng. Ngoài ra chỉ tin chính doc ngày đó khi nó ghi
 * rõ complete: true (lần ghi gần nhất đủ mọi máy, dữ liệu đầy đủ tới
 * syncedAt): agent ghi checkins trước rồi mới ghi coverage, lỡ bước sau hỏng
 * thì doc vẫn là bằng chứng hợp lệ. Có cả hai thì lấy mốc muộn hơn.
 *
 * Doc do agent bản cũ ghi (không có trường complete) KHÔNG được coi là đủ:
 * bản cũ ghi đè cả ngày mỗi lần chạy, một máy lỗi là mất lượt chấm của máy đó.
 * Trang Chấm ăn của tôi cũng không có mốc cho những ngày này nên CBNV thấy
 * "Chưa có dữ liệu" — tab này mà xếp họ vào "Đăng ký nhưng không chấm" thì hai
 * nơi nói hai kiểu về cùng một bữa của cùng một người. Những ngày đó để ở số
 * tạm; cần số chốt thì dùng file Excel của HAC (xem legacyDatesOf).
 */
function coverageOfDocs(docs: CheckinDocMeta[], sync: CheckinSync | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const d of docs) {
    // Chốt an toàn đã dừng gửi cảnh báo ngày này vì dữ liệu máy bất thường: không
    // coi là đã chốt, dù có mốc đồng bộ đủ mọi máy. Nếu không, những người email
    // không cảnh báo (để tránh oan) lại nằm trong danh sách xử lý vi phạm ở đây.
    if (sync?.alerts?.[d.date]?.held === true) {
      out[d.date] = null;
      continue;
    }
    const candidates = [sync?.coverage?.[d.date], d.complete === true ? d.syncedAt : null].filter(validIso);
    candidates.sort((a, b) => Date.parse(a) - Date.parse(b));
    out[d.date] = candidates.pop() ?? null;
  }
  return out;
}

/**
 * Ngày chỉ có dữ liệu của agent bản cũ: doc không có trường complete và
 * settings/checkinSync cũng chưa có mốc nào cho ngày đó. Tách riêng để dải "số
 * liệu tạm" nói đúng lý do và chỉ cách lấy số chốt (file Excel), thay vì để
 * quản trị chờ một lần đồng bộ sẽ không bao giờ tới với ngày đã qua.
 */
function legacyDatesOf(docs: CheckinDocMeta[], sync: CheckinSync | null): string[] {
  return docs
    .filter(d => typeof d.complete !== 'boolean' && !validIso(sync?.coverage?.[d.date]))
    .map(d => d.date)
    .sort();
}

/** Bóc tách các dòng đã đọc từ sheet. Tách riêng khỏi phần đọc file để kiểm
 *  thử được bằng Node với file Excel thật. */
export function parseHacRows(rows: string[][]): Omit<ParsedFile, 'fileName'> {
  // Năm nằm ở dòng "Khoảng thời gian: 2026-07-01 - 2026-07-31", cột ngày chỉ
  // ghi MM-DD nên bắt buộc phải lấy năm từ đây, không được đoán.
  const rangeRow = rows.find(r => String(r[0] || '').startsWith('Khoảng thời gian'));
  const yearMatch = String(rangeRow?.[0] || '').match(/(\d{4})-(\d{2})-\d{2}/);
  if (!yearMatch) throw new Error('Không tìm thấy dòng "Khoảng thời gian" để xác định tháng của báo cáo.');
  const month = `${yearMatch[1]}-${yearMatch[2]}`;

  const headerIdx = rows.findIndex(r => String(r[0] || '').trim() === 'Tên');
  if (headerIdx === -1) throw new Error('Không tìm thấy dòng tiêu đề (cột "Tên").');
  const header = rows[headerIdx].map(c => String(c || '').trim());

  const colId = header.indexOf('ID');
  const colDept = header.indexOf('Bộ phận');
  if (colId === -1) throw new Error('Không tìm thấy cột "ID" (mã nhân viên).');

  const dayCols: { idx: number; date: string }[] = [];
  header.forEach((h, idx) => {
    const m = h.match(/^(\d{2})-(\d{2})$/);
    if (m) dayCols.push({ idx, date: `${yearMatch[1]}-${m[1]}-${m[2]}` });
  });
  if (!dayCols.length) throw new Error('Không tìm thấy cột ngày nào (dạng MM-DD).');

  const byDate: ParsedFile['byDate'] = {};
  dayCols.forEach(c => { byDate[c.date] = {}; });

  let rowCount = 0;
  const excludedIds: string[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const employeeId = normId(row[colId]);
    if (!employeeId) continue;
    const name = String(row[0] || '').trim();
    const department = colDept >= 0 ? String(row[colDept] || '').trim() : '';
    if (isExcludedDept(department)) {
      excludedIds.push(employeeId);
      continue;
    }
    rowCount++;

    for (const c of dayCols) {
      const cell = String(row[c.idx] || '').trim();
      if (!cell || cell === '-') continue;
      const times = cell.match(/\d{1,2}:\d{2}/g);
      if (!times) continue;
      // Phân bữa bằng đúng hàm mà đường đồng bộ tự động, trang CBNV và agent
      // dùng (giữ lượt sớm nhất mỗi bữa, lượt ngoài khung vào unrecognized),
      // để đọc file Excel hay đọc từ máy chấm đều ra cùng một kết luận.
      byDate[c.date][employeeId] = { employeeId, name, department, ...classifyTimes(times) };
    }
  }

  return { month, rowCount, byDate, excludedIds };
}

function parseHacWorkbook(file: File): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không đọc được file.'));
    reader.onload = () => {
      try {
        const wb = xlsx.read(reader.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = xlsx.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' });
        const parsedRows = parseHacRows(rows);
        // Mốc chốt của file là giờ file được lưu (lastModified), không phải lúc
        // mở: file chỉ có lượt chấm tới lúc xuất từ HAC. Giờ lưu không sớm hơn
        // giờ xuất (chép bằng Explorer giữ nguyên giờ; tải về qua trình duyệt,
        // Zalo... thì thành giờ tải, muộn hơn) nên vẫn có thể lệch về phía "đã
        // chốt" — vì thế giờ này được hiện cạnh tên file để quản trị đối chiếu.
        // Kẹp về hiện tại phòng đồng hồ máy lưu file chạy nhanh.
        const savedMs = file.lastModified > 0 ? Math.min(file.lastModified, Date.now()) : Date.now();
        const savedAt = new Date(savedMs).toISOString();
        const coverage = Object.fromEntries(Object.keys(parsedRows.byDate).map(d => [d, savedAt]));
        resolve({ ...parsedRows, coverage, savedAt, fileName: file.name });
      } catch (err: any) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Danh sách ngày nghỉ đã lưu. Trả null khi đọc lỗi để giao diện báo cho quản
 *  trị biết — im lặng coi như "không có ngày nghỉ" thì ngày lễ sẽ hiện thành
 *  hàng loạt "đăng ký nhưng không chấm" mà không ai hiểu vì sao. */
async function loadOffDays(): Promise<string[] | null> {
  try {
    const snap = await getDoc(doc(db, 'settings', OFF_DAYS_DOC));
    const dates: unknown = snap.exists() ? snap.data().dates : [];
    return Array.isArray(dates) ? dates.filter((d): d is string => typeof d === 'string') : [];
  } catch (err) {
    console.error('Không đọc được danh sách ngày nghỉ:', err);
    return null;
  }
}

/** Tình trạng đồng bộ. Doc chưa có (agent bản cũ) hay đọc lỗi thì trả null và
 *  dải tình trạng đơn giản là không hiện, không chặn phần đối soát. */
async function loadSyncInfo(): Promise<CheckinSync | null> {
  try {
    const snap = await getDoc(doc(db, 'settings', SYNC_DOC));
    return snap.exists() ? (snap.data() as CheckinSync) : null;
  } catch (err) {
    console.error('Không đọc được tình trạng đồng bộ máy chấm:', err);
    return null;
  }
}

// ------------------------------------------------------- danh sách miễn chấm

/** Danh sách miễn chấm đã đọc: bản ghi hợp lệ, bản ghi lỗi (kèm lý do) và lúc đọc (ms). */
export type ExemptionList = { policies: CheckinExemption[]; invalid: InvalidCheckinExemption[]; loadedAt: number };

/** Trạng thái danh sách miễn chấm của tab. Không bao giờ chặn đối soát hay xuất Excel. */
export type ExemptionLoad =
  | { status: 'loading' }
  | ({ status: 'ready' } & ExemptionList)
  | { status: 'error'; code: string };

// Danh sách miễn chấm ít khi đổi, mà tab này mở lại nhiều lần trong phiên (đổi
// tháng, chuyển tab là component được dựng lại). Đọc lại cả collection mỗi lần
// thì tốn lượt đọc của gói Spark miễn phí, nên giữ trong bộ nhớ ~10 phút; nút
// "Tải lại dữ liệu" luôn đọc mới.
const EXEMPTION_CACHE_MS = 10 * 60_000;
type ExemptionCacheEntry = { at: number; promise: Promise<ExemptionList>; value: ExemptionList | null };
let exemptionCache: ExemptionCacheEntry | null = null;

/** Bỏ danh sách miễn chấm đang nhớ, để lần mở/tải sau đọc lại (vd. ngay sau khi quản trị sửa danh sách). */
export function invalidateCheckinExemptionCache() {
  exemptionCache = null;
}

// Hàm async: lỗi ném ngay (không qua promise) của SDK cũng thành promise bị từ chối.
async function readCheckinExemptionList(): Promise<ExemptionList> {
  const snap = await getDocs(collection(db, 'meal_checkin_exemptions'));
  // Kiểm tra TỪNG bản ghi: một bản ghi hỏng không làm mất cả danh sách.
  return { ...parseCheckinExemptionDocs(snap.docs.map(d => ({ id: d.id, data: d.data() }))), loadedAt: Date.now() };
}

/** Đọc cả danh sách miễn chấm (chỉ quản trị đọc được), dùng bản đã nhớ nếu còn hạn. */
export function loadCheckinExemptionList(): Promise<ExemptionList> {
  const now = Date.now();
  if (exemptionCache && now - exemptionCache.at < EXEMPTION_CACHE_MS) return exemptionCache.promise;
  const promise = readCheckinExemptionList();
  const entry: ExemptionCacheEntry = { at: now, promise, value: null };
  exemptionCache = entry;
  promise.then(
    value => { entry.value = value; },
    // Lỗi thì không nhớ: lần mở hoặc bấm tải lại sau sẽ đọc lại.
    () => { if (exemptionCache === entry) exemptionCache = null; },
  );
  return promise;
}

/** Bản đã đọc xong và còn hạn — để mở lại tab không phải chờ (và không nháy số). */
function cachedExemptionLoad(): ExemptionLoad {
  const entry = exemptionCache;
  return entry?.value && Date.now() - entry.at < EXEMPTION_CACHE_MS ? { status: 'ready', ...entry.value } : { status: 'loading' };
}

const errorCodeOf = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};

/** Ghi chú cho dòng "Đăng ký nhưng không chấm" của mã có bản ghi miễn chấm đang lỗi. */
export const BROKEN_EXEMPTION_NOTE = 'Bản ghi miễn chấm của mã này đang lỗi — chưa kết luận';
/** Có bản ghi lỗi không nêu được mã: chưa biết ai được miễn, nên mọi dòng thiếu chấm đều chưa kết luận. */
export const UNIDENTIFIED_EXEMPTION_NOTE = 'Có bản ghi miễn chấm lỗi không rõ mã — chưa kết luận';
/** Chưa tải được danh sách miễn chấm: dòng thiếu chấm có thể là người được miễn. */
export const UNAVAILABLE_EXEMPTION_NOTE = 'Chưa tải được danh sách miễn chấm — kiểm tra lại trước khi xử lý';

/**
 * reconcile() với danh sách miễn chấm ở bất kỳ trạng thái nào: chưa tải xong hay
 * tải lỗi thì đối soát như không ai được miễn (giao diện báo rõ), bản ghi lỗi thì
 * chỉ áp dụng bản ghi hợp lệ và ghi chú các dòng thiếu chấm chưa kết luận được —
 * của mã bị lỗi, hoặc của mọi người khi có bản ghi lỗi không rõ mã (agent cũng
 * giữ thư thiếu chấm theo đúng hai trường hợp này).
 */
export function reconcileWithExemptions(
  input: Omit<Parameters<typeof reconcile>[0], 'checkinExemptions'>,
  exemptions: ExemptionLoad,
): ReturnType<typeof reconcile> {
  const ready = exemptions.status === 'ready' ? exemptions : null;
  const result = reconcile({ ...input, checkinExemptions: ready?.policies ?? [] });
  const { ids: held, unidentified } = exemptionQuarantine(ready?.invalid ?? []);
  // Tệp Excel là thứ Bộ phận Dinh dưỡng dùng để xử lý vi phạm: khi chưa tải được
  // danh sách miễn chấm, cảnh báo trên màn hình không đi theo tệp — ghi vào từng dòng.
  const unavailable = exemptions.status === 'error';
  if (!held.size && !unidentified && !unavailable) return result;
  const noteOf = (employeeId: string) =>
    held.has(employeeId) ? BROKEN_EXEMPTION_NOTE
      : unidentified ? UNIDENTIFIED_EXEMPTION_NOTE
        : unavailable ? UNAVAILABLE_EXEMPTION_NOTE : null;
  return {
    ...result,
    missing: result.missing.map(row => {
      const note = noteOf(row.employeeId);
      return note ? { ...row, note: row.note ? `${row.note}; ${note}` : note } : row;
    }),
  };
}

const countOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Trạng thái mà agent đã thực sự đếm người đáng lẽ ăn / chưa chấm.
const COUNTED_STATUSES = new Set<AlertStatus>(['sent', 'partial', 'guarded', 'nothing']);

// Lịch Task Scheduler của agent: pha cảnh báo chạy từ 13:45, lặp mỗi 15 phút
// trong 1 giờ (xem agent/README.md).
const ALERT_WINDOW_START = '13:45';
const ALERT_WINDOW_END = '14:45';

type AlertInfo = { tone: 'ok' | 'warn' | 'error' | 'neutral'; text: string };

/**
 * "Gửi được 30, lỗi 2 email: <lý do> — lần chạy sau sẽ gửi nốt." Thư lỗi là thư
 * chắc chắn chưa đi nên lần chạy cảnh báo kế tiếp gửi nốt; chỉ hứa điều đó khi
 * thật sự có thư lỗi và hôm nay còn lần chạy tự động (13:45 tới khoảng 14:45).
 */
/**
 * Lý do agent ghi đã kèm "Lần chạy sau sẽ gửi nốt." và các câu đếm người bỏ qua;
 * trang tự viết các phần đó từ số liệu (đúng theo giờ hiện tại), nên bỏ chúng
 * khỏi lý do để không lặp hay mâu thuẫn. Phần còn lại (lỗi cụ thể) giữ nguyên.
 */
export function agentReasonText(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  const cleaned = reason
    .replace(/\s*Lần chạy sau sẽ gửi nốt\.?/g, '')
    .replace(/\s*\d+ mã có lượt chấm chưa gắn được với đúng một tài khoản, không gửi\.?/g, '')
    .replace(/\s*\d+ người có đăng ký suất ăn sự kiện gần ngày này, không gửi\.?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned ? `: ${cleaned.replace(/\.$/, '')}` : '';
}

function partialText(sentLabel: string, failed: number, reason: string, retryOpen: boolean) {
  if (failed <= 0) return `Gửi được ${sentLabel} email${reason}.`;
  return `Gửi được ${sentLabel}, lỗi ${failed} email${reason} — ${
    retryOpen ? 'lần chạy sau sẽ gửi nốt' : 'hôm nay không còn lần chạy tự động nào để gửi nốt'
  }.`;
}

/**
 * Diễn giải trạng thái gửi email cảnh báo thiếu chấm của hôm nay.
 * @param nowTime giờ Việt Nam hiện tại, HH:MM
 */
export function describeAlert(
  alert: AlertDay | undefined,
  mealDay: boolean,
  nowTime: string
): AlertInfo {
  if (!alert || !alert.status) {
    if (!mealDay) return { tone: 'neutral', text: 'Hôm nay không có suất ăn, không gửi cảnh báo.' };
    // Agent chỉ ghi kết quả cảnh báo khi pha cảnh báo thật sự chạy VÀ
    // alerts.enabled đang bật (bản mẫu config để tắt). Không có kết quả chưa
    // chắc là agent không chạy — dòng "Lần chạy gần nhất" ngay trên mới nói
    // điều đó. Viết "chưa có lần chạy nào" thì quản trị tưởng lịch chạy hỏng.
    return nowTime < ALERT_WINDOW_END
      ? { tone: 'neutral', text: 'Chưa có kết quả gửi cảnh báo hôm nay (pha cảnh báo chạy từ 13:45 tới khoảng 14:45).' }
      : {
          tone: 'neutral',
          text: 'Chưa có kết quả gửi cảnh báo hôm nay: agent chưa chạy pha cảnh báo, hoặc chức năng gửi cảnh báo đang tắt (alerts.enabled trong config.json của agent).',
        };
  }
  const reason = agentReasonText(alert.reason);
  switch (alert.status) {
    case 'sent':
      return { tone: 'ok', text: `Đã gửi ${countOf(alert.sent)} email cảnh báo.` };
    case 'partial':
      return {
        tone: 'warn',
        text: partialText(String(countOf(alert.sent)), countOf(alert.failed), reason, nowTime < ALERT_WINDOW_END),
      };
    case 'guarded':
      return { tone: 'warn', text: `Đã tạm dừng gửi theo chốt an toàn${reason}` };
    case 'error': {
      // Agent giữ lại số đã gửi của lần chạy trước khi ghi 'error' (ví dụ 13:45
      // gửi được 30, 14:00 một máy lỗi). Chỉ ghi "Chưa gửi được" thì quản trị
      // tưởng chưa ai nhận email và có thể nhắc lại cả trường lần nữa.
      const sent = countOf(alert.sent);
      const failed = countOf(alert.failed);
      if (sent > 0) {
        return {
          tone: 'error',
          text: `Đã gửi ${sent} email${failed > 0 ? `, còn ${failed} email chưa gửi được` : ''}; lần chạy gần nhất chưa gửi tiếp được${reason}`,
        };
      }
      return { tone: 'error', text: `Chưa gửi được${reason}` };
    }
    case 'off_day':
      return { tone: 'neutral', text: 'Ngày nghỉ, không gửi cảnh báo.' };
    case 'nothing':
      return { tone: 'ok', text: 'Không có ai cần cảnh báo.' };
    default:
      return { tone: 'neutral', text: `Trạng thái: ${String(alert.status)}${reason}` };
  }
}

/**
 * Diễn giải kết quả gửi thư "chấm nhưng chưa đăng ký" của một ngày ăn đã qua.
 * Agent chỉ xử lý nhóm này ở lần chạy cảnh báo của ngày có suất ăn kế tiếp, nên
 * chưa có kết quả chưa chắc là lỗi: chỉ báo "Đang chờ" khi agent có hỗ trợ và
 * lần chạy đó thật sự còn ở phía trước.
 */
export function describeExtraAlert(
  extra: ExtraAlertDay | undefined,
  { supported, agentVersion, today, alertRunToday, nowTime }: {
    /** Agent đang chạy có gửi loại thư này (agentSupports(sync, 'extraAlerts')). */
    supported: boolean;
    agentVersion: string;
    /** Hôm nay theo giờ Việt Nam, YYYY-MM-DD. */
    today: string;
    /**
     * Hôm nay có lần chạy cảnh báo theo lịch (DKAN 2 chạy thứ 2–6, kể cả ngày
     * nghỉ giữa tuần: nhóm thư này nói về ngày ăn trước đó nên vẫn được gửi).
     */
    alertRunToday: boolean;
    /** Giờ Việt Nam hiện tại, HH:MM. */
    nowTime: string;
  },
): AlertInfo {
  if (!extra || !extra.status) {
    if (!supported) {
      return { tone: 'neutral', text: `Agent trên máy HAC chưa hỗ trợ gửi loại thư này (bản đang chạy: ${agentVersion}).` };
    }
    if (!alertRunToday) return { tone: 'neutral', text: 'Đang chờ — gửi vào lần chạy cảnh báo của ngày làm việc kế tiếp (thứ 2–6, từ 13:45).' };
    return nowTime < ALERT_WINDOW_END
      ? { tone: 'neutral', text: `Đang chờ — gửi trong lần chạy cảnh báo hôm nay (từ ${ALERT_WINDOW_START} tới khoảng ${ALERT_WINDOW_END}).` }
      : { tone: 'neutral', text: 'Chưa có kết quả: agent chưa chạy pha cảnh báo hôm nay, hoặc chức năng gửi cảnh báo đang tắt.' };
  }
  const reason = agentReasonText(extra.reason);
  const sent = countOf(extra.sent);
  const failed = countOf(extra.failed);
  const uncertain = countOf(extra.uncertain);
  const candidates = countOf(extra.candidates);
  const sentLabel = candidates > 0 ? `${sent}/${candidates}` : String(sent);
  // Chỉ còn gửi nốt được nếu kết quả là của hôm nay và hôm nay còn lần chạy tự động.
  const retryOpen = alertRunToday && nowTime < ALERT_WINDOW_END && vnParts(extra.at ?? '')?.date === today;
  let info: AlertInfo;
  switch (extra.status) {
    case 'sent':
      // Còn người không nhận được thư (không có tài khoản trường đang hoạt động…):
      // nói lý do, không để "3/4" màu xanh mà không giải thích.
      info = sent < candidates || reason
        ? { tone: 'warn', text: `Đã gửi ${sentLabel} email${reason}.` }
        : { tone: 'ok', text: `Đã gửi ${sentLabel} email.` };
      break;
    case 'partial':
      info = uncertain > 0
        ? { tone: 'warn', text: `Gửi được ${sentLabel} email, ${uncertain} email chưa rõ đã gửi hay chưa${failed > 0 ? `, lỗi ${failed} email` : ''}${reason}. Không tự gửi lại email chưa rõ; cần kiểm tra hộp thư trước khi xử lý tiếp.` }
        : { tone: 'warn', text: partialText(sentLabel, failed, reason, retryOpen) };
      break;
    case 'nothing':
      info = { tone: 'ok', text: 'Không có ai cần cảnh báo.' };
      break;
    case 'guarded':
      info = { tone: 'warn', text: `Đã tạm dừng gửi theo chốt an toàn${reason}` };
      break;
    case 'error':
      info = sent > 0
        ? { tone: 'error', text: `Đã gửi ${sentLabel} email${failed > 0 ? `, còn ${failed} email chưa gửi được` : ''}; lần chạy gần nhất chưa gửi tiếp được${reason}` }
        : { tone: 'error', text: `Chưa gửi được${reason}` };
      break;
    case 'off_day':
      info = { tone: 'neutral', text: 'Ngày nghỉ, không gửi cảnh báo.' };
      break;
    default:
      info = { tone: 'neutral', text: `Trạng thái: ${String(extra.status)}${reason}` };
  }
  // Số người không gửi được vì chưa xác định được tài khoản cần quản trị đối chiếu tay.
  const unmapped = countOf(extra.unmapped);
  const eventSkipped = countOf(extra.eventSkipped);
  const notes = [
    unmapped > 0 ? `${unmapped} mã chưa gắn được với đúng một tài khoản, không gửi — cần đối chiếu` : '',
    eventSkipped > 0 ? `${eventSkipped} người có đăng ký ăn sự kiện, không gửi` : '',
  ].filter(Boolean);
  if (!notes.length) return info;
  return {
    tone: unmapped > 0 && info.tone === 'ok' ? 'warn' : info.tone,
    text: `${info.text.replace(/\.$/, '')} · ${notes.join(' · ')}.`,
  };
}

/**
 * "sáng 3/120, trưa 5/98 (miễn chấm 12)". Mẫu số là người còn phải chấm: agent
 * đếm cả suất được miễn vào expected, nên trừ đi exempt (agent cũ không ghi = 0).
 */
export function missingCountsText(alert: Pick<AlertDay, 'expected' | 'missing' | 'exempt'>) {
  return MEALS.map(meal => {
    const exempt = countOf(alert.exempt?.[meal]);
    const due = Math.max(0, countOf(alert.expected?.[meal]) - exempt);
    return `${meal === 'breakfast' ? 'sáng' : 'trưa'} ${countOf(alert.missing?.[meal])}/${due}${exempt > 0 ? ` (miễn chấm ${exempt})` : ''}`;
  }).join(', ');
}

/**
 * Ngày có suất ăn gần nhất trước `today`, hoặc null. Tìm lùi tối đa 7 ngày —
 * đúng như agent (PREVIOUS_MEAL_DAY_LOOKBACK trong agent/lib/alert-plan.mjs):
 * sau kỳ nghỉ dài hơn, agent không xét lại ngày ăn trước kỳ nghỉ.
 */
function previousMealDay(today: string, offDays: string[]): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const [y, m, d] = today.split('-').map(Number);
  for (let back = 1; back <= 7; back++) {
    const iso = new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
    if (isMealDay(iso, offDays)) return iso;
  }
  return null;
}

const agentVersionLabel = (sync: CheckinSync | null) =>
  typeof sync?.agentVersion === 'string' && sync.agentVersion.trim() ? sync.agentVersion.trim().slice(0, 40) : 'không rõ';

const TONE_CLASS = {
  ok: 'bg-tertiary-container text-on-tertiary-container',
  warn: 'bg-warning-container text-on-warning-container',
  error: 'bg-error-container text-on-error-container',
  neutral: 'bg-surface-container text-on-surface-variant',
} as const;

/**
 * Dải tình trạng đồng bộ: máy chấm nào đang đọc được, lần đồng bộ đủ máy gần
 * nhất, và email cảnh báo hôm nay đã gửi chưa. Quản trị cần thấy ngay những
 * điều này trước khi tin con số đối soát — một máy lỗi là cả dãy người "đăng ký
 * nhưng không chấm" có thể chỉ do thiếu dữ liệu.
 */
export function SyncHealthStrip({ sync, offDays, now: at }: { sync: CheckinSync; offDays: string[]; now?: Date }) {
  const devices = Object.entries(sync.devices || {})
    .filter(([, d]) => d && typeof d === 'object')
    .sort(([a], [b]) => a.localeCompare(b, 'vi'));
  // Doc có mà chưa có gì để xem (ghi dở) thì thôi không hiện.
  if (!devices.length && !sync.lastRunAt && !sync.alerts) return null;

  const now = vnParts(at);
  const today = now?.date ?? vnToday();
  const nowTime = now?.time ?? '00:00';
  const todayMealDay = isMealDay(today, offDays);
  const alert = sync.alerts?.[today];
  const alertInfo = describeAlert(alert, todayMealDay, nowTime);
  const failed = devices.filter(([, d]) => !d.ok);
  // Chỉ những trạng thái có tính lại số liệu mới hiện "Chưa chấm x/y". Với
  // 'error' agent không tính gì (doc mang 0/0 hoặc số của lần chạy trước), hiện
  // ra sẽ đọc thành "không ai thiếu" trong khi thật ra chưa biết.
  const showCounts = !!alert && !!alert.status && COUNTED_STATUSES.has(alert.status) && !!alert.expected;
  // Thư "chấm nhưng chưa đăng ký" của một ngày được gửi ở lần chạy cảnh báo của
  // ngày ăn kế tiếp, nên dòng này nói về ngày ăn gần nhất trước hôm nay.
  const extraDate = previousMealDay(today, offDays);
  const extra = extraDate ? sync.alerts?.[extraDate]?.extra : undefined;
  const extraInfo = extraDate
    ? describeExtraAlert(extra, {
        supported: agentSupports(sync, 'extraAlerts'),
        agentVersion: agentVersionLabel(sync),
        today,
        alertRunToday: isWeekday(today),
        nowTime,
      })
    : null;

  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-sm flex flex-col gap-2 text-body-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-on-surface-variant">
        <span className="inline-flex items-center gap-1.5 text-label-md text-on-surface">
          <span className="material-symbols-outlined text-[18px]">monitor_heart</span>
          Tình trạng đồng bộ
        </span>
        {sync.lastRunAt && (
          <span>
            Lần chạy gần nhất: <strong className="text-on-surface tabular">{formatVnDateTime(sync.lastRunAt) || '—'}</strong>
            {sync.lastRunComplete === false && <span className="text-error"> (thiếu máy)</span>}
          </span>
        )}
        <span>
          Lần đủ mọi máy gần nhất:{' '}
          <strong className="text-on-surface tabular">{formatVnDateTime(sync.lastCompleteAt) || 'chưa có'}</strong>
        </span>
      </div>

      {devices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {devices.map(([name, d]) => (
            <span
              key={name}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-label-sm ${d.ok ? TONE_CLASS.ok : TONE_CLASS.error}`}
              title={d.ok ? undefined : d.error || undefined}
            >
              <span className="material-symbols-outlined text-[16px]">{d.ok ? 'check_circle' : 'error'}</span>
              <span className="font-bold">{name}</span>
              <span>{d.ok ? 'hoạt động' : 'lỗi'}</span>
              <span className="opacity-80 tabular">
                · đọc được lần cuối {formatVnDateTime(d.lastOkAt) || 'chưa từng'}
              </span>
            </span>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-on-error-container">
          {failed.map(([name, d]) => (
            <li key={name} className="break-words">
              <strong>{name}</strong>: {d.error || 'không rõ lỗi'}
              {d.at && <span className="text-on-surface-variant tabular"> (lúc {formatVnDateTime(d.at)})</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <span className="text-on-surface-variant min-w-0 pt-0.5">Cảnh báo thiếu chấm hôm nay ({formatDayLabel(today)}):</span>
        <span className={`inline-flex items-start gap-1.5 px-2.5 py-0.5 rounded-lg break-words min-w-0 ${TONE_CLASS[alertInfo.tone]}`}>
          {alertInfo.text}
          {alert?.at && <span className="opacity-80 tabular whitespace-nowrap"> · {formatVnDateTime(alert.at)}</span>}
        </span>
        {showCounts && alert && (
          <span className="text-on-surface-variant pt-0.5 tabular">Chưa chấm: {missingCountsText(alert)}</span>
        )}
      </div>

      {extraDate && extraInfo && (
        <div className="flex flex-wrap items-start gap-2">
          <span className="text-on-surface-variant min-w-0 pt-0.5">
            Cảnh báo chấm chưa đăng ký ngày {formatDayLabel(extraDate)}:
          </span>
          <span className={`inline-flex items-start gap-1.5 px-2.5 py-0.5 rounded-lg break-words min-w-0 ${TONE_CLASS[extraInfo.tone]}`}>
            {extraInfo.text}
            {extra?.status && extra.at && <span className="opacity-80 tabular whitespace-nowrap"> · {formatVnDateTime(extra.at)}</span>}
          </span>
        </div>
      )}
    </div>
  );
}

// Câu cảnh báo bản ghi miễn chấm lỗi chỉ kể vài mã; đủ danh sách (kèm lý do) ở phần mở rộng.
const INVALID_CODES_SHOWN = 10;
const INVALID_REASONS_SHOWN = 20;

/**
 * Cảnh báo về danh sách miễn chấm: đang tải, đọc lỗi (nói rõ nguyên nhân), có
 * bản ghi lỗi, hoặc agent trên máy HAC chưa áp dụng được. Không chặn gì — đối
 * soát và xuất Excel vẫn chạy, các dòng này nói số liệu đang được tính ra sao.
 */
export function ExemptionNotices({ exemptions, sync, today }: {
  exemptions: ExemptionLoad;
  sync: CheckinSync | null;
  /** Hôm nay theo giờ Việt Nam, YYYY-MM-DD. */
  today: string;
}) {
  if (exemptions.status === 'loading') {
    return (
      <div role="status" className="p-sm rounded-lg bg-surface-container text-on-surface-variant text-body-sm flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] animate-spin shrink-0" aria-hidden="true">progress_activity</span>
        Đang tải danh sách miễn chấm ăn...
      </div>
    );
  }

  if (exemptions.status === 'error') {
    return (
      <div role="alert" className="p-sm md:p-md rounded-lg border border-warning/40 bg-warning-container text-on-warning-container text-body-md flex items-start gap-2">
        <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">gpp_maybe</span>
        <span>
          <strong>
            {exemptions.code === 'permission-denied'
              ? 'Firestore Rules chưa cho phép đọc danh sách miễn chấm — dán bản firestore.rules mới rồi bấm Tải lại dữ liệu.'
              : `Chưa tải được danh sách miễn chấm ăn${exemptions.code ? ` (mã lỗi: ${exemptions.code})` : ''} — bấm Tải lại dữ liệu để thử lại.`}
          </strong>{' '}
          Kết quả bên dưới đang tính như không ai được miễn chấm, nên người được miễn có thể nằm trong danh sách
          “Đăng ký nhưng không chấm”.
        </span>
      </div>
    );
  }

  const { invalid, policies } = exemptions;
  // Cùng quy tắc với agent: mọi mã mà bản ghi lỗi nhắc tới (mã tài liệu và mã trong dữ liệu).
  const quarantine = exemptionQuarantine(invalid);
  const codes = [...quarantine.ids].sort();
  const unknown = quarantine.unidentified;
  const named = [
    codes.length
      ? `mã: ${codes.slice(0, INVALID_CODES_SHOWN).join(', ')}${codes.length > INVALID_CODES_SHOWN ? ` và ${codes.length - INVALID_CODES_SHOWN} mã khác` : ''}`
      : '',
    unknown ? `${unknown} bản ghi không rõ mã` : '',
  ].filter(Boolean).join('; ');
  // Còn hiệu lực = đang áp dụng hoặc sắp áp dụng: agent cũ sẽ gửi cảnh báo thiếu chấm cho những người này.
  const current = policies.some(policy => policy.periods.some(period => period.to === null || period.to >= today));
  const agentBehind = current && !!sync && !agentSupports(sync, 'checkinExemptions');
  if (!invalid.length && !agentBehind) return null;

  return (
    <>
      {invalid.length > 0 && (
        <div role="alert" className="p-sm md:p-md rounded-lg border border-warning/40 bg-warning-container text-on-warning-container text-body-md flex items-start gap-2">
          <span className="material-symbols-outlined text-[20px] shrink-0" aria-hidden="true">gpp_maybe</span>
          <div className="min-w-0 flex-1 space-y-1">
            <p>
              <strong>{invalid.length} bản ghi miễn chấm bị lỗi ({named}) chưa được áp dụng</strong> — sửa ở{' '}
              <Link to="/quantri?tab=exemptions" className="font-semibold underline underline-offset-2">
                Miễn chấm theo bữa
              </Link>
              .
            </p>
            {codes.length > 0 && (
              <p className="text-body-sm">
                Các dòng “Đăng ký nhưng không chấm” của {codes.length === 1 ? 'mã này' : 'những mã này'} có ghi chú “{BROKEN_EXEMPTION_NOTE}”.
              </p>
            )}
            {unknown > 0 && (
              <p className="text-body-sm">
                Có bản ghi không xác định được mã nhân viên nên chưa biết ai đang được miễn: mọi dòng “Đăng ký nhưng không
                chấm”{codes.length > 0 ? ' còn lại' : ''} được ghi chú “{UNIDENTIFIED_EXEMPTION_NOTE}”.
              </p>
            )}
            <details className="text-body-sm">
              <summary className="cursor-pointer font-semibold">Xem lý do từng bản ghi</summary>
              <ul className="mt-1 list-disc pl-5 space-y-0.5">
                {invalid.slice(0, INVALID_REASONS_SHOWN).map((item, i) => (
                  <li key={`${item.docId}-${i}`} className="break-words">
                    <span className="tabular">{item.docId.slice(0, 60) || '(không có mã tài liệu)'}</span>: {item.reason}
                  </li>
                ))}
              </ul>
              {invalid.length > INVALID_REASONS_SHOWN && <p className="mt-1">… và {invalid.length - INVALID_REASONS_SHOWN} bản ghi khác.</p>}
            </details>
          </div>
        </div>
      )}
      {agentBehind && (
        <div className="p-sm rounded-lg border border-warning/40 bg-warning-container text-on-warning-container text-body-sm flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">update</span>
          <span>
            Agent trên máy HAC chưa hỗ trợ miễn chấm (bản đang chạy: {agentVersionLabel(sync)}): người trong danh sách vẫn có
            thể nhận email cảnh báo thiếu chấm.
          </span>
        </div>
      )}
    </>
  );
}

type CardKey = 'registered' | 'tapped' | 'missing' | 'pending' | 'exempt' | 'extra' | 'unrecognized' | 'invalidRegs';

// Dải "số liệu tạm" chỉ liệt kê vài ngày đầu; xem cả tháng file Excel giữa
// tháng thì có thể tới hơn chục ngày chưa tới.
const UNSETTLED_SHOWN = 4;
// Dòng báo nhân sự Bếp Vina bị loại chỉ kể vài tên; đủ danh sách nằm ở tooltip.
const KITCHEN_SHOWN = 5;

type Unsettled = { date: string; meals: Meal[] };

/** "Thứ 6, 09/10 (bữa trưa)" */
const describeUnsettled = ({ date, meals }: Unsettled) =>
  `${formatDayLabel(date)} (${meals.length === MEALS.length ? 'cả hai bữa' : meals.map(m => MEAL_LABEL[m].toLowerCase()).join(', ')})`;

/**
 * Ngày chọn sẵn khi mở dữ liệu: ngày gần nhất mà cả hai bữa đã chốt. Agent
 * đồng bộ cả lúc 08:15 và trong giờ trưa nên doc hôm nay có từ sáng; mở thẳng
 * hôm nay lúc 10:30 thì danh sách là số tạm, dễ bị đem đi xử lý như số thật.
 * Chưa ngày nào chốt (đầu tháng, hay file của tháng chưa tới) thì như trước:
 * hôm nay nếu có, không thì ngày cuối.
 */
function defaultDatesOf(data: Pick<ParsedFile, 'byDate' | 'coverage'>, off: string[], now: Date) {
  const days = Object.keys(data.byDate).filter(d => isMealDay(d, off)).sort();
  const settled = days.filter(d => MEALS.every(m => mealFinal(data, d, m, now)));
  // "Hôm nay" theo giờ Việt Nam. toISOString() là ngày UTC, trước 07:00 sáng
  // sẽ chọn nhầm sang hôm qua.
  const today = vnParts(now)?.date ?? vnToday();
  const pick = settled[settled.length - 1] || (days.includes(today) ? today : (days[days.length - 1] || ''));
  return { first: days[0] || '', pick };
}

/** Các bữa chưa chốt dữ liệu trong những ngày đang xem. */
function unsettledMeals(data: Pick<ParsedFile, 'coverage'>, dates: string[], now: Date): Unsettled[] {
  const out: Unsettled[] = [];
  for (const date of dates) {
    const meals = MEALS.filter(m => !mealFinal(data, date, m, now));
    if (meals.length) out.push({ date, meals });
  }
  return out;
}

/** Tách "đăng ký nhưng không chấm" của reconcile() thành phần đã chốt và phần số tạm. */
function splitMissing(rows: Row[], unsettled: Unsettled[]) {
  const open = new Set(unsettled.flatMap(u => u.meals.map(m => `${u.date}|${m}`)));
  const split = { missing: [] as Row[], pending: [] as Row[] };
  for (const r of rows) (open.has(`${r.date}|${r.meal}`) ? split.pending : split.missing).push(r);
  return split;
}

/**
 * Sổ Excel đối soát của phạm vi đang xem. `missing`/`pending` là hai phần của
 * result.missing đã tách theo bữa đã chốt / chưa chốt (splitMissing).
 */
export function buildReconciliationWorkbook({ result, missing, pending }: {
  result: ReturnType<typeof reconcile>;
  missing: Row[];
  pending: Row[];
}) {
  const sheet = (rows: Row[], withTime: boolean, withNote = false, noteLabel = 'Lý do') =>
    xlsx.utils.json_to_sheet(
      rows.map((r, i) => {
        const base: Record<string, string | number> = {
          'STT': i + 1,
          'Ngày': formatDate(r.date),
          'Mã NV': r.employeeId,
          'Họ và tên': r.fullName || '(không có trong file)',
          'Bộ phận': r.department || '',
          'Bữa': mealLabel(r.meal),
        };
        if (withTime) base['Giờ chấm'] = r.time || '';
        if (withNote) base[noteLabel] = r.note || '';
        return base;
      })
    );

  const wb = xlsx.utils.book_new();
  // 'DK khong cham' chỉ gồm bữa đã chốt dữ liệu; số tạm để sheet riêng cho
  // khỏi bị đem đi xử lý vi phạm cùng. Luôn có cột Ghi chú: dòng có ghi chú về
  // miễn chấm (email lệch, bản ghi lỗi) cần kiểm tra trước khi xử lý.
  xlsx.utils.book_append_sheet(wb, sheet(missing, false, true, 'Ghi chú'), 'DK khong cham');
  if (pending.length) xlsx.utils.book_append_sheet(wb, sheet(pending, false, true, 'Ghi chú'), 'Chua cham - so tam');
  xlsx.utils.book_append_sheet(wb, sheet(result.extra, true, true), 'Cham khong DK');
  xlsx.utils.book_append_sheet(wb, sheet(result.unrecognized, true), 'Cham ngoai gio');
  xlsx.utils.book_append_sheet(wb, sheet(result.registered, false), 'Suat da dang ky');
  xlsx.utils.book_append_sheet(wb, sheet(result.tapped, true), 'Luot cham hop le');
  xlsx.utils.book_append_sheet(wb, sheet(result.exempt, false), 'Mien cham theo bua');
  return wb;
}

const PAGE_SIZES = [50, 100, 500, 1000];

/** Dãy số trang rút gọn: 1 … 45 46 47 … 93 */
function pageList(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push('…');
  for (let i = start; i <= end; i++) out.push(i);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}

/** Lượt chấm thực tế của ngày nghỉ/ăn sự kiện: chỉ xem, không đối soát suất tháng. */
export function OffDayCheckinsReference({ byDate, offDays, registrations, excludedIds, today = vnToday() }: {
  byDate: ParsedFile['byDate'];
  offDays: string[];
  registrations: Registration[];
  excludedIds: string[];
  today?: string;
}) {
  const dates = useMemo(() => referenceCheckinDates(byDate, offDays, today), [byDate, offDays, today]);
  const [selectedDate, setSelectedDate] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const date = dates.includes(selectedDate) ? selectedDate : dates[0] || '';
  const { rows, excludedCount } = useMemo(
    () => referenceCheckinRows(byDate[date] || {}, registrations, excludedIds),
    [byDate, date, registrations, excludedIds],
  );
  const visible = useMemo(() => filterReferenceCheckins(rows, search), [rows, search]);
  const totalPages = Math.max(1, Math.ceil(visible.length / 50));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * 50;
  const pageRows = visible.slice(start, start + 50);
  useEffect(() => { setPage(1); }, [date, search]);
  if (!dates.length) return null;

  return (
    <section aria-labelledby="offday-reference-title" className="rounded-xl border border-primary/20 bg-surface-container-lowest overflow-hidden">
      <div className="p-md bg-primary-container/30 border-b border-primary/15 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="offday-reference-title" className="text-headline-sm text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary" aria-hidden="true">event_available</span>
            Lượt chấm ngày nghỉ / ăn sự kiện
          </h3>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Chỉ tham khảo, không tính vào suất ăn tháng hoặc vi phạm.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-label-sm text-on-surface-variant shrink-0">
          Ngày có lượt chấm
          <select aria-label="Ngày xem lượt chấm tham khảo" value={date} onChange={event => { setSelectedDate(event.target.value); setSearch(''); setPage(1); }}
            className="min-h-11 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-primary font-bold outline-none focus:ring-2 focus:ring-primary/30">
            {dates.map(day => <option key={day} value={day}>{formatDayLabel(day)}</option>)}
          </select>
        </label>
      </div>
      <div className="p-md flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-body-sm text-on-surface-variant">
          <span><strong className="text-on-surface tabular">{rows.length}</strong> người có giờ chấm</span>
          <span>Sáng: <strong className="text-on-surface tabular">{rows.filter(row => row.breakfast).length}</strong> người</span>
          <span>Trưa: <strong className="text-on-surface tabular">{rows.filter(row => row.lunch).length}</strong> người</span>
        </div>
        <p className="text-body-sm text-on-surface-variant">
          Giờ chấm theo bữa: hiển thị lượt sớm nhất trong khung giờ sáng/trưa; các giờ ngoài khung được liệt kê riêng.
          {' '}Đây là dữ liệu máy nhận diện, chưa phải kết quả đối soát đăng ký ăn sự kiện.
        </p>
        {excludedCount > 0 && <p className="text-body-sm text-on-surface-variant">Đã loại {excludedCount} mã theo quy tắc loại lượt chấm công Bếp Vina như đối soát suất tháng.</p>}
        <label className="relative block sm:max-w-[360px]">
          <span className="sr-only">Tìm người trong lượt chấm tham khảo</span>
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-on-surface-variant" aria-hidden="true">search</span>
          <input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Tìm mã NV hoặc họ tên..."
            className="w-full min-h-11 rounded-lg border border-outline-variant bg-surface pl-10 pr-3 text-body-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary" />
        </label>
      </div>
      <div className="hidden lg:grid grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] gap-3 px-md py-2 bg-surface-container-low text-label-sm uppercase text-on-surface-variant" aria-hidden="true">
        <span>Nhân sự</span><span>Bữa sáng</span><span>Bữa trưa</span><span>Ngoài khung giờ</span>
      </div>
      <ol className="divide-y divide-outline-variant max-h-[440px] overflow-y-auto">
        {pageRows.map(row => (
          <li key={row.employeeId} className="p-md grid grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] gap-x-3 gap-y-2 text-body-sm hover:bg-surface-container-low">
            <div className="col-span-2 lg:col-span-1 min-w-0">
              <p className="font-bold text-on-surface break-words">{row.name || '(Không có tên trên máy)'}</p>
              <p className="text-on-surface-variant"><span className="tabular">{row.employeeId}</span>{row.department && ` · ${row.department}`}</p>
            </div>
            {(['breakfast', 'lunch'] as const).map(meal => (
              <div key={meal}>
                <span className="block lg:sr-only text-label-sm text-on-surface-variant mb-1">{MEAL_LABEL[meal]}</span>
                <span className={`inline-flex rounded-md px-2 py-1 tabular ${row[meal] ? 'bg-primary-container/50 text-on-primary-container font-bold' : 'text-on-surface-variant'}`}>{row[meal] || '—'}</span>
              </div>
            ))}
            <div className="col-span-2 lg:col-span-1 text-on-surface-variant">
              <span className="lg:sr-only">Ngoài khung giờ: </span><span className="tabular break-words">{row.unrecognized.join(', ') || '—'}</span>
            </div>
          </li>
        ))}
      </ol>
      {visible.length === 0 && <p className="p-md text-body-sm text-on-surface-variant">{search.trim() ? 'Không tìm thấy người khớp với nội dung tìm kiếm.' : 'Không có lượt chấm sau khi áp dụng danh sách loại trừ.'}</p>}
      <div className="border-t border-outline-variant p-sm flex flex-wrap items-center gap-2 text-body-sm text-on-surface-variant">
        <span role="status">{visible.length ? `${start + 1}–${Math.min(start + 50, visible.length)} / ${visible.length} người` : '0 người'}</span>
        {totalPages > 1 && <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} aria-label="Trang tham khảo trước" className="min-h-11 min-w-11 rounded-lg border border-outline-variant disabled:opacity-40 hover:bg-surface-container">‹</button>
          <span className="tabular">{currentPage} / {totalPages}</span>
          <button type="button" onClick={() => setPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} aria-label="Trang tham khảo sau" className="min-h-11 min-w-11 rounded-lg border border-outline-variant disabled:opacity-40 hover:bg-surface-container">›</button>
        </div>}
      </div>
    </section>
  );
}

export function MealReconciliation({
  registrations,
  cancelations,
  selectedMonth,
  onMonthChange,
  registrationDataReady,
  registrationDataError,
  onReloadRegistrations,
}: {
  registrations: Registration[];
  cancelations: Cancelation[];
  selectedMonth: string;
  onMonthChange: (month: string) => void;
  registrationDataReady: boolean;
  registrationDataError: string | null;
  onReloadRegistrations: () => void;
}) {
  const [source, setSource] = useState<'auto' | 'file'>('auto');
  const [fileData, setFileData] = useState<ParsedFile | null>(null);
  const [autoData, setAutoData] = useState<ParsedFile | null>(null);
  const [autoState, setAutoState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [savedExcludes, setSavedExcludes] = useState<string[]>([]);
  const [offDays, setOffDays] = useState<string[]>([]);
  const [offDaysError, setOffDaysError] = useState(false);
  // Lấy ngay bản đã nhớ trong phiên (nếu còn hạn) để đổi tháng, chuyển tab
  // không phải đọc lại cũng không nháy số.
  const [exemptions, setExemptions] = useState<ExemptionLoad>(cachedExemptionLoad);
  const [syncInfo, setSyncInfo] = useState<CheckinSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const loadedMonth = useRef<string | null>(null);

  // A previous month can remain in memory while its replacement is loading.
  // Keep it out of the view, including error/empty states of the new month.
  const parsed = source === 'auto' ? (autoData?.month === selectedMonth ? autoData : null) : fileData;
  const excludedIds = source === 'auto' ? savedExcludes : (fileData?.excludedIds || []);

  // Nhận danh sách ngày nghỉ qua tham số thay vì đọc state: lúc vừa tải xong,
  // state offDays của lần render này vẫn là giá trị cũ.
  const pickDefaultDates = (data: Omit<ParsedFile, 'fileName'>, off: string[]) => {
    const { first, pick } = defaultDatesOf(data, off, new Date());
    setSelectedDate(pick);
    setRangeFrom(first);
    setRangeTo(pick);
    setOpenCard(null);
    setPage(1);
  };

  // Lấy lượt chấm đã được agent đồng bộ từ máy nhận diện, kèm danh sách ngày
  // nghỉ (cả chế độ file Excel cũng cần) và tình trạng đồng bộ.
  //
  // Dùng allSettled chứ không dùng Promise.all: đọc checkins hỏng (ví dụ rule
  // chặn) thì quản trị sẽ chuyển sang Tải file Excel — lúc đó vẫn phải có danh
  // sách ngày nghỉ, nếu không cột ngày lễ thành cả trường "đăng ký nhưng không
  // chấm" mà không có cảnh báo nào.
  //
  // Danh sách miễn chấm cũng vậy: đọc lỗi (rules dán tay có thể lên sau bản web)
  // thì vẫn đối soát như không ai được miễn và báo rõ nguyên nhân, không chặn.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAutoState('loading');
      const [checkinsRes, excludesRes, offRes, syncRes, exemptionsRes] = await Promise.allSettled([
        getDocs(query(collection(db, 'checkins'), where('month', '==', selectedMonth))),
        getDoc(doc(db, 'settings', EXCLUDES_DOC)),
        loadOffDays(),
        loadSyncInfo(),
        loadCheckinExemptionList(),
      ]);
      if (cancelled) return;

      // loadOffDays/loadSyncInfo tự bắt lỗi và trả null; nhánh rejected chỉ
      // để phòng hờ, xử lý giống "đọc lỗi".
      const offList = offRes.status === 'fulfilled' ? offRes.value : null;
      const sync = syncRes.status === 'fulfilled' ? syncRes.value : null;
      const off = offList ?? [];
      setOffDays(off);
      setOffDaysError(offList === null);
      setSyncInfo(sync);
      if (exemptionsRes.status === 'fulfilled') {
        setExemptions({ status: 'ready', ...exemptionsRes.value });
      } else {
        console.error('Không đọc được danh sách miễn chấm ăn:', exemptionsRes.reason);
        setExemptions({ status: 'error', code: errorCodeOf(exemptionsRes.reason) });
      }

      if (checkinsRes.status === 'rejected' || excludesRes.status === 'rejected') {
        console.error(
          'Không đọc được dữ liệu chấm ăn đã đồng bộ:',
          checkinsRes.status === 'rejected' ? checkinsRes.reason : (excludesRes as PromiseRejectedResult).reason
        );
        setAutoState('error');
        return;
      }
      // Doc do agent ghi, có thể hỏng dạng: lỗi khi dựng dữ liệu cũng báo
      // "không đọc được" thay vì kẹt mãi ở trạng thái đang tải.
      try {
        const snap = checkinsRes.value;
        const excludeSnap = excludesRes.value;
        setSavedExcludes(excludeSnap.exists() ? (excludeSnap.data().employeeIds || []) : []);

        const docs = snap.docs
          .map(d => d.data() as { date: string; people: Record<string, any>; syncedAt?: string; complete?: boolean });
        // Ngày đã đồng bộ đủ mọi máy mà không có doc nào: không ai chấm cả ngày
        // (agent không tạo doc rỗng) — vd. nghỉ đột xuất mà quên khai ngày nghỉ.
        // Trang "Chấm ăn của tôi" vẫn hiện ngày đó, nên tab này cũng phải có để
        // quản trị thấy được điều CBNV đang thấy.
        const have = new Set(docs.map(d => d.date));
        const todayVn = vnToday();
        for (const [date, at] of Object.entries(sync?.coverage || {})) {
          if (!date.startsWith(`${selectedMonth}-`) || have.has(date) || date > todayVn || !validIso(at)) continue;
          docs.push({ date, people: {} });
        }
        docs.sort((a, b) => a.date.localeCompare(b.date));
        if (!docs.length) {
          setAutoData(null);
          setAutoState('empty');
          return;
        }
        // syncedAt là ISO UTC; hiện theo giờ Việt Nam, nếu không sẽ lệch 7 tiếng.
        const latestSync = docs.map(d => d.syncedAt || '').sort().pop() || '';
        const syncedLabel = formatVnDateTime(latestSync);
        const built = {
          ...buildFromCheckins(docs),
          coverage: coverageOfDocs(docs, sync),
          legacyDates: legacyDatesOf(docs, sync),
          heldDates: Object.fromEntries(
            docs
              .filter(d => sync?.alerts?.[d.date]?.held === true)
              .map(d => [d.date, sync?.alerts?.[d.date]?.reason || 'dữ liệu máy nhận diện bất thường']),
          ),
        };
        setAutoData({ ...built, fileName: syncedLabel ? `Đồng bộ tự động · ${syncedLabel}` : 'Đồng bộ tự động' });
        setAutoState('ready');
        // Tải lại cùng tháng không thay ngày/khoảng ngày quản trị đang xem.
        if (loadedMonth.current !== selectedMonth) pickDefaultDates(built, off);
        loadedMonth.current = selectedMonth;
      } catch (err) {
        console.error('Không dựng được dữ liệu chấm ăn đã đồng bộ:', err);
        setAutoState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedMonth, reloadVersion]);
  const [scope, setScope] = useState<'day' | 'range' | 'month'>('day');
  const [selectedDate, setSelectedDate] = useState('');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [openCard, setOpenCard] = useState<CardKey | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState('');

  // Đổi phạm vi xem hay đổi bảng thì quay về trang 1, nếu không người dùng sẽ
  // thấy một trang trống vì bảng mới ít dòng hơn.
  const resetPaging = () => setPage(1);

  // "Tải lại dữ liệu": đọc lại lượt chấm, cấu hình và danh sách miễn chấm (có thể
  // vừa được sửa ở tab Cấu hình). Đăng ký và hủy ăn do trang quản trị nghe
  // realtime nên vốn đã mới — chỉ đăng ký nghe lại khi đang lỗi, vì nghe lại là
  // đọc lại toàn bộ lịch sử hủy ăn.
  const reloadAll = () => {
    invalidateCheckinExemptionCache();
    setReloadVersion(version => version + 1);
    if (registrationDataError) onReloadRegistrations();
  };

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    setIsParsing(true);
    setError(null);
    try {
      const result = await parseHacWorkbook(file);
      setFileData(result);
      setSource('file');
      pickDefaultDates(result, offDays);

      // File Excel là nguồn duy nhất biết ai thuộc bộ phận nào, nên nhân dịp
      // này ghi lại danh sách cần loại để chế độ tự động dùng được.
      if (result.excludedIds.length) {
        try {
          await setDoc(doc(db, 'settings', EXCLUDES_DOC), {
            employeeIds: result.excludedIds,
            departments: EXCLUDED_DEPARTMENTS,
            updatedAt: new Date().toISOString(),
          });
          setSavedExcludes(result.excludedIds);
        } catch (err) {
          console.error('Không lưu được danh sách bộ phận loại trừ:', err);
        }
      }
    } catch (err: any) {
      setFileData(null);
      setError(err?.message || 'File không đúng định dạng báo cáo của HAC.');
    } finally {
      setIsParsing(false);
    }
  };

  // Chỉ những ngày có suất ăn: bỏ cuối tuần và ngày nghỉ quản trị đã khai. Ở
  // chế độ file Excel, mỗi cột MM-DD đều là một ngày, nên thiếu bước này thì cột
  // ngày lễ sẽ biến cả trường thành "đăng ký nhưng không chấm".
  const dates = useMemo(
    () => (parsed ? Object.keys(parsed.byDate).filter(d => isMealDay(d, offDays)).sort() : []),
    [parsed, offDays]
  );

  // Danh sách ngày nghỉ có thể về SAU khi file Excel đã đọc xong (mạng chậm),
  // hoặc đổi nguồn dữ liệu làm ngày đang chọn không còn trong danh sách. Khi đó
  // chọn lại mặc định, thay vì để ô chọn trỏ vào một ngày lễ đã bị loại và đối
  // soát ra toàn số 0 khó hiểu.
  useEffect(() => {
    if (!parsed || !dates.length) return;
    const valid = (d: string) => dates.includes(d);
    if (valid(selectedDate) && valid(rangeFrom) && valid(rangeTo)) return;
    pickDefaultDates(parsed, offDays);
    // Chỉ chạy lại khi danh sách ngày đổi; selectedDate/rangeFrom/rangeTo là
    // thứ hàm này đặt, đưa vào phụ thuộc thì mỗi lần người dùng chọn ngày lại chạy.
  }, [dates]);

  // Ngày nghỉ rơi vào thứ 2–6 của tháng đang xem, để báo cho quản trị biết đã
  // bỏ qua ngày nào (cuối tuần thì ai cũng hiểu, không cần liệt kê).
  const offDaysInMonth = useMemo(
    () => (parsed ? offDays.filter(d => d.startsWith(`${parsed.month}-`) && isWeekday(d)).sort() : []),
    [parsed, offDays]
  );

  const monthMismatch = !!parsed && parsed.month !== selectedMonth;
  // Danh sách miễn chấm cố ý không có mặt ở đây: chưa tải xong hay tải lỗi thì
  // vẫn đối soát (như không ai được miễn) và ExemptionNotices nói rõ.
  const comparisonReady = registrationDataReady && !registrationDataError && !monthMismatch
    && (source !== 'auto' || autoState !== 'loading');
  const mainLoading = !registrationDataError && (!registrationDataReady || (source === 'auto' && autoState === 'loading'));

  const activeDates = useMemo(() => {
    // Lệch tháng thì không đối soát: so lượt chấm tháng này với đăng ký tháng
    // khác chỉ ra số rác, thà không hiện gì còn hơn hiện số sai.
    if (!parsed || !comparisonReady) return [];
    if (scope === 'month') return dates;
    if (scope === 'day') return selectedDate ? [selectedDate] : [];
    if (!rangeFrom || !rangeTo) return [];
    const [from, to] = rangeFrom <= rangeTo ? [rangeFrom, rangeTo] : [rangeTo, rangeFrom];
    return dates.filter(d => d >= from && d <= to);
  }, [parsed, scope, dates, selectedDate, rangeFrom, rangeTo, comparisonReady]);

  // Chính sách miễn chấm khớp theo mã NV + email trên đơn (đơn từ 05/2026 đều
  // có email). Không đọc collection staff để bù email: hồ sơ do CBNV tự sửa.
  const result = useMemo(
    () => reconcileWithExemptions(
      { byDate: parsed?.byDate || {}, dates: activeDates, registrations, cancelations, excludedIds, offDays },
      exemptions,
    ),
    [parsed, activeDates, registrations, cancelations, excludedIds, offDays, exemptions]
  );

  // Những bữa trong phạm vi đang xem mà dữ liệu chưa chốt (bữa chưa kết thúc,
  // hoặc chưa có lần đồng bộ đủ mọi máy sau giờ ăn). reconcile() không biết giờ
  // nên coi mọi người chưa chấm là "đăng ký nhưng không chấm"; danh sách đó là
  // thứ Bộ phận Dinh dưỡng dùng để xử lý vi phạm, nên phải tách số tạm ra —
  // cùng cách trang Chấm ăn của tôi và agent phân biệt 'missing' với 'pending'.
  const unsettled = useMemo(
    () => (parsed ? unsettledMeals(parsed, activeDates, new Date()) : []),
    [parsed, activeDates]
  );

  const { missing, pending } = useMemo(() => splitMissing(result.missing, unsettled), [result, unsettled]);

  // Ngày chưa chốt vì chỉ có dữ liệu của agent bản cũ: ngày đã qua nên không
  // lần đồng bộ thường lệ nào chốt lại được, phải nói rõ cách lấy số chốt.
  // Ngày chưa chốt vì chốt an toàn của agent đã treo (dữ liệu máy bất thường).
  const heldUnsettled = useMemo(() => {
    const held = parsed?.heldDates || {};
    return [...new Set(unsettled.map(u => u.date))].filter(d => d in held);
  }, [parsed, unsettled]);

  const legacyUnsettled = useMemo(() => {
    const legacy = new Set(parsed?.legacyDates || []);
    return unsettled.map(u => u.date).filter(d => legacy.has(d));
  }, [parsed, unsettled]);


  const CARDS: {
    key: CardKey;
    icon: string;
    label: string;
    rows: Row[];
    tone: string;
    active: string;
    withTime: boolean;
    withNote?: boolean;
    /** Tên cột ghi chú (mặc định "Lý do"). */
    noteLabel?: string;
    hint?: string;
  }[] = [
    {
      key: 'registered', icon: 'assignment_turned_in', label: 'Suất đã đăng ký', rows: result.registered,
      tone: 'bg-primary-container/40 border-primary/20 text-on-primary-container',
      active: 'ring-2 ring-primary', withTime: false,
    },
    {
      key: 'tapped', icon: 'how_to_reg', label: 'Lượt chấm hợp lệ', rows: result.tapped,
      tone: 'bg-tertiary-container/50 border-tertiary/25 text-on-tertiary-container',
      active: 'ring-2 ring-tertiary', withTime: true,
    },
    {
      key: 'exempt', icon: 'verified_user', label: 'Suất được miễn chấm', rows: result.exempt,
      tone: 'bg-primary-container/30 border-primary/20 text-on-primary-container',
      active: 'ring-2 ring-primary', withTime: false,
      hint: 'Các suất đã đăng ký thuộc bữa và thời hạn được miễn điểm danh. Lượt chấm thực tế được hiển thị ở danh sách lượt chấm.'
        + (exemptions.status === 'ready'
          ? ` Danh sách miễn chấm tải lúc ${formatVnDateTime(new Date(exemptions.loadedAt).toISOString())}; vừa sửa danh sách thì bấm Tải lại dữ liệu.`
          : ''),
    },
    {
      // Ghi chú (email trên đơn khác email trong danh sách miễn chấm, bản ghi
      // miễn chấm đang lỗi) phải thấy được trước khi đem danh sách đi xử lý vi phạm.
      key: 'missing', icon: 'no_meals', label: 'Đăng ký nhưng không chấm', rows: missing,
      tone: 'bg-warning-container border-warning/30 text-on-warning-container',
      active: 'ring-2 ring-warning', withTime: false,
      withNote: missing.some(r => r.note), noteLabel: 'Ghi chú',
      hint: missing.some(r => r.note)
        ? 'Dòng có ghi chú liên quan tới danh sách miễn chấm: kiểm tra lại ở menu Miễn chấm theo bữa trước khi xử lý vi phạm.'
        : undefined,
    },
    // Chỉ hiện khi phạm vi đang xem có bữa chưa chốt dữ liệu.
    ...(pending.length
      ? [{
          key: 'pending' as const, icon: 'hourglass_top', label: 'Chưa chấm — số liệu tạm', rows: pending,
          tone: 'bg-surface-container border-outline-variant text-on-surface-variant',
          active: 'ring-2 ring-outline', withTime: false,
          withNote: pending.some(r => r.note), noteLabel: 'Ghi chú',
          hint: 'Những người đã đăng ký nhưng chưa thấy lượt chấm, ở các bữa chưa chốt dữ liệu (lý do ghi ở dòng "Số liệu tạm" phía trên). Có thể họ chưa ăn, hoặc lượt chấm chưa về tới hệ thống. Không xử lý vi phạm theo danh sách này.',
        }]
      : []),
    {
      key: 'extra', icon: 'person_alert', label: 'Chấm nhưng không đăng ký', rows: result.extra,
      tone: 'bg-error-container border-error/25 text-on-error-container',
      active: 'ring-2 ring-error', withTime: true, withNote: true,
    },
    {
      key: 'unrecognized', icon: 'schedule', label: 'Chấm ngoài giờ, không tính', rows: result.unrecognized,
      tone: 'bg-surface-container border-outline-variant text-on-surface-variant',
      active: 'ring-2 ring-outline', withTime: true,
      hint: `Lượt chấm nằm ngoài hai khung giờ nên không được tính là đã ăn. Kiểm tra xem có phải người đó đến muộn, hay đồng hồ máy chấm bị lệch.`,
    },
    {
      key: 'invalidRegs', icon: 'badge', label: 'Đăng ký thiếu hoặc trùng mã NV', rows: result.invalidRegs,
      tone: 'bg-surface-container border-outline-variant text-on-surface-variant',
      active: 'ring-2 ring-outline', withTime: false, withNote: true,
      hint: 'Những đơn này không đối chiếu được với máy chấm: hoặc hồ sơ nhân sự chưa có mã nhân viên, hoặc cùng một mã đứng trên đơn của từ hai tài khoản trở lên (không biết lượt chấm của mã đó là của ai — email cảnh báo và trang cá nhân cũng không kết luận). Cần sửa mã cho đúng người, nếu không họ sẽ mãi không xuất hiện đúng ở bất kỳ danh sách nào.',
    },
  ];

  const handleExport = () => {
    if (!parsed || !comparisonReady) return;
    const suffix =
      scope === 'month' ? selectedMonth
        : scope === 'day' ? selectedDate
          : `${rangeFrom}_den_${rangeTo}`;
    xlsx.writeFile(buildReconciliationWorkbook({ result, missing, pending }), `Doi_soat_cham_an_${suffix}.xlsx`);
  };

  const openedCard = CARDS.find(c => c.key === openCard);

  // Tìm theo mã NV hoặc tên, dùng để tra một trường hợp cụ thể mà không phải
  // lật qua hàng chục trang.
  const visibleRows = useMemo(() => {
    if (!openedCard) return [];
    const q = searchText.trim().toLowerCase();
    if (!q) return openedCard.rows;
    const qId = normId(q);
    return openedCard.rows.filter(
      r => r.fullName.toLowerCase().includes(q) || (qId !== '' && r.employeeId.includes(qId))
    );
  }, [openedCard, searchText]);

  // Kẹp số trang lại phòng khi dữ liệu đổi mà trang hiện tại vượt quá số trang.
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const firstRowIndex = (safePage - 1) * pageSize;
  const pageRows = visibleRows.slice(firstRowIndex, firstRowIndex + pageSize);

  return (
    <div className="px-md md:px-0 flex flex-col gap-md lg:gap-lg">
      <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
        <div className="p-md border-b border-outline-variant bg-surface-container-low">
          <h2 className="text-headline-sm text-on-surface uppercase">Đối soát chấm ăn</h2>
          <p className="text-on-surface-variant text-[13px] mt-1">
            So sánh đăng ký trên hệ thống với dữ liệu chấm ăn xuất từ phần mềm HAC.
            Chỉ ghi nhận lượt chấm bữa sáng trong khoảng {MEAL_WINDOWS.breakfast.from}–{MEAL_WINDOWS.breakfast.to} và
            bữa trưa trong khoảng {MEAL_WINDOWS.lunch.from}–{MEAL_WINDOWS.lunch.to}.
          </p>
        </div>

        <div className="p-md flex flex-col gap-md">
          <ReconciliationMonthPicker selectedMonth={selectedMonth} onMonthChange={onMonthChange} />
          <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-lg border border-outline-variant overflow-hidden w-fit">
            {([['auto', 'Tự động từ máy chấm công', 'sync'], ['file', 'Tải file Excel', 'upload_file']] as const).map(([s, label, icon]) => (
              <button
                key={s}
                onClick={() => { setSource(s); setOpenCard(null); resetPaging(); }}
                className={`px-4 py-2 text-label-md inline-flex items-center gap-2 transition-colors ${
                  source === s ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">{icon}</span>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={reloadAll} disabled={autoState === 'loading'} aria-busy={autoState === 'loading'}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-label-md text-primary hover:bg-primary-container/30 disabled:opacity-50">
            <span className={`material-symbols-outlined text-[18px] ${autoState === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true">{autoState === 'loading' ? 'progress_activity' : 'refresh'}</span>
            {autoState === 'loading' ? 'Đang tải dữ liệu...' : 'Tải lại dữ liệu'}
          </button>
          </div>

          {source === 'auto' && syncInfo && <SyncHealthStrip sync={syncInfo} offDays={offDays} />}

          {/* Lúc cả tab đang tải thì dòng "đang tải" chung đã đủ. */}
          {!(mainLoading && exemptions.status === 'loading') && (
            <ExemptionNotices exemptions={exemptions} sync={syncInfo} today={vnToday()} />
          )}

          {offDaysError && (
            <div className="p-sm rounded-lg bg-warning-container text-on-warning-container text-body-sm flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] shrink-0">event_busy</span>
              <span>
                Không đọc được danh sách ngày nghỉ ở tab Cấu hình. Ngày lễ rơi vào thứ 2–6 (nếu có) đang bị tính như
                ngày có suất ăn — Thầy/Cô tải lại trang trước khi dùng số liệu những ngày đó.
              </span>
            </div>
          )}

          {mainLoading && (
            <div role="status" className="p-md rounded-lg bg-surface-container text-on-surface-variant text-body-md flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] animate-spin">progress_activity</span>
              Đang tải đăng ký, hủy ăn và lượt chấm tháng {selectedMonth.slice(5)}/{selectedMonth.slice(0, 4)}...
            </div>
          )}

          {registrationDataError && (
            <div role="alert" className="p-md rounded-lg bg-error-container text-on-error-container text-body-md">
              {registrationDataError} Bấm Tải lại dữ liệu để thử lại. Kết quả đối soát và xuất Excel tạm dừng cho đến khi tải đủ dữ liệu cùng tháng.
            </div>
          )}

          {source === 'auto' && autoState === 'empty' && (
            <div className="p-md rounded-lg bg-warning-container text-on-warning-container text-body-md flex items-start gap-2">
              <span className="material-symbols-outlined text-[20px] shrink-0">info</span>
              <span>
                Chưa có dữ liệu đồng bộ cho tháng {selectedMonth.slice(5)}/{selectedMonth.slice(0, 4)}.
                Kiểm tra xem chương trình đồng bộ trên máy cài HAC đã chạy chưa — bình thường nó chạy lúc 08:15 và
                13:45 các ngày thứ 2–6, và 22:00 mỗi đêm.
                Trong lúc chờ, Thầy/Cô có thể chuyển sang <strong>Tải file Excel</strong> để đối soát ngay.
              </span>
            </div>
          )}

          {source === 'auto' && autoState === 'error' && (
            <div className="p-md rounded-lg bg-error-container text-on-error-container text-body-md flex items-start gap-2">
              <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
              <span>Chưa tải được dữ liệu mới. Dữ liệu đã tải (nếu có) vẫn đang hiển thị. Bấm Tải lại dữ liệu để thử lại.</span>
            </div>
          )}

          {source === 'auto' && autoState === 'ready' && savedExcludes.length === 0 && (
            <div className="p-sm rounded-lg bg-surface-container text-on-surface-variant text-body-sm flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] shrink-0">filter_alt_off</span>
              <span>
                Dữ liệu từ máy chấm công không có cột bộ phận nên chưa loại được nhân sự bếp.
                Tải một lần file Excel của HAC ở tab bên cạnh, hệ thống sẽ ghi nhớ danh sách này cho các lần sau.
              </span>
            </div>
          )}

          {source === 'file' && (
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-outline-variant rounded-xl p-lg cursor-pointer hover:border-primary hover:bg-primary-container/20 transition-colors text-center">
              <span className="material-symbols-outlined text-[32px] text-primary">upload_file</span>
              <span className="text-label-lg text-on-surface">
                {isParsing ? 'Đang đọc file...' : 'Chọn file Excel xuất từ HAC'}
              </span>
              <span className="text-body-sm text-on-surface-variant">
                Dùng báo cáo <strong>Chấm vào &amp; ra hàng tháng</strong>, không dùng bảng tổng hợp chấm công.
              </span>
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => handleFile(e.target.files?.[0])} />
            </label>
          )}

          {error && (
            <div className="p-sm rounded-lg bg-error-container text-on-error-container text-body-md flex items-start gap-2">
              <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
              <span>{error}</span>
            </div>
          )}

          {parsed && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-body-sm text-on-surface-variant">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-tertiary-container text-on-tertiary-container">
                  <span className="material-symbols-outlined text-[16px]">description</span>
                  {parsed.fileName}
                  {parsed.savedAt && (
                    <span
                      className="opacity-80 tabular"
                      title="Giờ file được lưu trên máy này. Số liệu được coi là đầy đủ tới thời điểm này. Nếu file được tải về hoặc chép từ máy khác, giờ lưu có thể muộn hơn giờ xuất thật từ HAC."
                    >
                      · lưu lúc {formatVnDateTime(parsed.savedAt)}
                    </span>
                  )}
                </span>
                <span>Tháng {parsed.month.slice(5)}/{parsed.month.slice(0, 4)} · {parsed.rowCount} người</span>
                {excludedIds.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container text-on-surface-variant"
                    title={`Bộ phận không đưa vào đối soát: ${EXCLUDED_DEPARTMENTS.join(', ')}`}
                  >
                    <span className="material-symbols-outlined text-[16px]">filter_alt_off</span>
                    Đã loại {excludedIds.length} người thuộc {EXCLUDED_DEPARTMENTS.join(', ')}
                  </span>
                )}
                {offDaysInMonth.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container text-on-surface-variant"
                    title={`Ngày nghỉ khai ở tab Cấu hình: ${offDaysInMonth.map(formatDayLabel).join('; ')}`}
                  >
                    <span className="material-symbols-outlined text-[16px]">event_busy</span>
                    Không tính {offDaysInMonth.length} ngày nghỉ: {offDaysInMonth.map(d => `${d.slice(8, 10)}/${d.slice(5, 7)}`).join(', ')}
                  </span>
                )}
              </div>

              {comparisonReady && <OffDayCheckinsReference byDate={parsed.byDate} offDays={offDays} registrations={registrations} excludedIds={excludedIds} />}

              {monthMismatch && (
                <div className="p-sm rounded-lg bg-warning-container text-on-warning-container text-body-md flex items-start gap-2">
                  <span className="material-symbols-outlined text-[20px] shrink-0">warning</span>
                  <span>
                    Dữ liệu là tháng <strong>{parsed.month.slice(5)}/{parsed.month.slice(0, 4)}</strong> nhưng danh sách đăng ký
                    đang xem là tháng <strong>{selectedMonth.slice(5)}/{selectedMonth.slice(0, 4)}</strong>.
                    <strong> Đã tạm dừng đối soát</strong> để không đưa ra con số sai — vui lòng chọn lại
                    <strong> Tháng đối soát</strong> ở phía trên cho khớp với file.
                  </span>
                </div>
              )}

              {comparisonReady && <>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex rounded-lg border border-outline-variant overflow-hidden">
                  {([['day', 'Theo ngày'], ['range', 'Khoảng ngày'], ['month', 'Cả tháng']] as const).map(([s, label]) => (
                    <button
                      key={s}
                      onClick={() => { setScope(s); resetPaging(); }}
                      className={`px-4 py-2 text-label-md transition-colors ${
                        scope === s ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {scope === 'day' && (
                  <select
                    value={selectedDate}
                    onChange={e => { setSelectedDate(e.target.value); resetPaging(); }}
                    className="bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md text-primary font-bold outline-none cursor-pointer"
                  >
                    {dates.map(d => <option key={d} value={d}>{formatDayLabel(d)}</option>)}
                  </select>
                )}

                {scope === 'range' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={rangeFrom}
                      onChange={e => { setRangeFrom(e.target.value); resetPaging(); }}
                      className="bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md text-primary font-bold outline-none cursor-pointer"
                    >
                      {dates.map(d => <option key={d} value={d}>{formatDayLabel(d)}</option>)}
                    </select>
                    <span className="text-on-surface-variant text-body-sm">đến</span>
                    <select
                      value={rangeTo}
                      onChange={e => { setRangeTo(e.target.value); resetPaging(); }}
                      className="bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md text-primary font-bold outline-none cursor-pointer"
                    >
                      {dates.map(d => <option key={d} value={d}>{formatDayLabel(d)}</option>)}
                    </select>
                    <span className="text-body-sm text-on-surface-variant">({activeDates.length} ngày có suất ăn)</span>
                  </div>
                )}

                <button
                  onClick={handleExport}
                  className="ml-auto inline-flex items-center gap-2 px-4 py-2 bg-tertiary text-on-tertiary rounded-lg text-label-md hover:bg-tertiary-dark transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">download</span>
                  Xuất Excel
                </button>
              </div>

              {unsettled.length > 0 && (
                <div className="p-sm rounded-lg bg-warning-container text-on-warning-container text-body-sm flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] shrink-0">hourglass_top</span>
                  <span>
                    <strong>Số liệu tạm, chưa chốt:</strong>{' '}
                    {unsettled.slice(0, UNSETTLED_SHOWN).map(describeUnsettled).join('; ')}
                    {unsettled.length > UNSETTLED_SHOWN && ` và ${unsettled.length - UNSETTLED_SHOWN} ngày khác`}.{' '}
                    {source === 'auto' ? (
                      legacyUnsettled.length === unsettled.length ? (
                        <>
                          Các ngày này chỉ có dữ liệu do chương trình đồng bộ bản cũ ghi, không có mốc đồng bộ đủ mọi máy chấm
                          (bản cũ có thể làm mất lượt chấm khi một máy lỗi). Cần số chốt cho những ngày này thì Thầy/Cô
                          dùng <strong>Tải file Excel</strong> của HAC.
                        </>
                      ) : (
                        <>
                          Bữa chưa kết thúc, hoặc chưa có lần đồng bộ đủ mọi máy chấm sau giờ ăn.
                          {legacyUnsettled.length > 0 && (
                            <>
                              {' '}Riêng {legacyUnsettled.length} ngày (
                              {legacyUnsettled.slice(0, UNSETTLED_SHOWN).map(d => `${d.slice(8, 10)}/${d.slice(5, 7)}`).join(', ')}
                              {legacyUnsettled.length > UNSETTLED_SHOWN && '...'}) chỉ có dữ liệu do chương trình đồng bộ bản cũ
                              ghi — cần số chốt cho những ngày đó thì dùng <strong>Tải file Excel</strong> của HAC.
                            </>
                          )}
                        </>
                      )
                    ) : (
                      `Bữa kết thúc sau lúc file được lưu${parsed.savedAt ? ` (${formatVnDateTime(parsed.savedAt)})` : ''} — file Excel chỉ có lượt chấm tới lúc xuất từ HAC.`
                    )}
                    {source === 'auto' && heldUnsettled.length > 0 && (
                      <>
                        {' '}<strong>Chốt an toàn đã dừng gửi cảnh báo</strong> ngày{' '}
                        {heldUnsettled.map(d => `${d.slice(8, 10)}/${d.slice(5, 7)}`).join(', ')} vì dữ liệu máy nhận diện bất
                        thường ({parsed.heldDates?.[heldUnsettled[0]]}). Đối chiếu bằng <strong>Tải file Excel</strong> của HAC
                        trước khi xử lý vi phạm những ngày này.
                      </>
                    )}
                    {pending.length > 0 && (
                      <>
                        {' '}Người chưa có lượt chấm ở các bữa này được tách sang thẻ <strong>Chưa chấm — số liệu tạm</strong>,
                        không tính vào <strong>Đăng ký nhưng không chấm</strong>.
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* Nhân sự Bếp Vina chấm công trên cùng máy: đã bị loại khỏi các
                  danh sách lượt chấm. Nói rõ ai bị loại để quản trị soát được
                  khi có người của trường bị nhận nhầm (mã sai trên máy chấm). */}
              {result.kitchenExcluded.length > 0 && (
                <div
                  className="p-sm rounded-lg bg-surface-container text-on-surface-variant text-body-sm flex items-start gap-2"
                  title={result.kitchenExcluded.map(k => `${k.fullName || '(không tên)'} — ${k.employeeId}`).join('\n')}
                >
                  <span className="material-symbols-outlined text-[18px] shrink-0">soup_kitchen</span>
                  <span>
                    Đã loại <strong>{result.kitchenExcluded.length}</strong> người thuộc Bếp Vina khỏi các danh sách lượt chấm
                    (mã trên máy chấm không đủ 6 chữ số, hoặc thuộc bộ phận Bếp Vina): {' '}
                    {result.kitchenExcluded.slice(0, KITCHEN_SHOWN).map(k => `${k.fullName || '(không tên)'} (${k.employeeId})`).join(', ')}
                    {result.kitchenExcluded.length > KITCHEN_SHOWN && ` và ${result.kitchenExcluded.length - KITCHEN_SHOWN} người khác`}.
                    {' '}Người có đơn đăng ký ăn thì không bao giờ bị loại.
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-md">
                {CARDS.map(card => {
                  const isOpen = openCard === card.key;
                  return (
                    <button
                      key={card.key}
                      onClick={() => { setOpenCard(isOpen ? null : card.key); resetPaging(); }}
                      aria-expanded={isOpen}
                      title={isOpen ? 'Bấm để thu gọn' : 'Bấm để xem danh sách'}
                      className={`p-md rounded-lg border text-left flex items-center gap-3 transition-all hover:brightness-[0.97] ${card.tone} ${isOpen ? card.active : ''}`}
                    >
                      <span className="material-symbols-outlined text-[26px] shrink-0">{card.icon}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[28px] font-extrabold leading-none tabular">{card.rows.length}</p>
                        <p className="text-body-sm mt-1">{card.label}</p>
                      </div>
                      <span className={`material-symbols-outlined text-[20px] shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                        expand_more
                      </span>
                    </button>
                  );
                })}
              </div>
              </>}
            </>
          )}
        </div>
      </div>

      {parsed && comparisonReady && openedCard && (
        <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
          <div className="p-md border-b border-outline-variant bg-surface-container-low flex items-center gap-2">
            <span className="material-symbols-outlined text-on-surface-variant">{openedCard.icon}</span>
            <h3 className="text-headline-sm text-on-surface uppercase flex-1">
              {openedCard.label} ({openedCard.rows.length})
            </h3>
            <button
              onClick={() => setOpenCard(null)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-label-md text-on-surface-variant hover:bg-surface-container transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
              Thu gọn
            </button>
          </div>

          {openedCard.hint && (
            <p className="px-md pt-md text-body-sm text-on-surface-variant">{openedCard.hint}</p>
          )}

          <div className="px-md pt-md">
            <div className="relative max-w-[360px]">
              <span className="material-symbols-outlined text-[18px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">search</span>
              <input
                type="search"
                value={searchText}
                onChange={e => { setSearchText(e.target.value); resetPaging(); }}
                placeholder="Tìm theo mã NV hoặc họ tên..."
                className="w-full bg-surface border border-outline-variant rounded-lg pl-10 pr-3 py-2 text-body-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
            {searchText.trim() !== "" && (
              <p className="text-body-sm text-on-surface-variant mt-2">
                Tìm thấy {visibleRows.length} dòng khớp &quot;{searchText.trim()}&quot;.
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            {visibleRows.length === 0 ? (
              <p className="text-body-sm text-on-surface-variant italic p-md">{searchText.trim() ? "Không tìm thấy dòng nào khớp." : "Không có trường hợp nào."}</p>
            ) : (
              <table className="w-full text-left text-body-sm min-w-[600px]">
                <thead className="bg-surface-container-low text-on-surface-variant text-label-sm uppercase">
                  <tr>
                    <th className="p-sm w-12">STT</th>
                    <th className="p-sm">Ngày</th>
                    <th className="p-sm">Mã NV</th>
                    <th className="p-sm">Họ và tên</th>
                    <th className="p-sm">Bộ phận</th>
                    <th className="p-sm">Bữa</th>
                    {openedCard.withTime && <th className="p-sm">Giờ chấm</th>}
                    {openedCard.withNote && <th className="p-sm">{openedCard.noteLabel ?? 'Lý do'}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {pageRows.map((r, i) => (
                    <tr key={`${r.date}-${r.employeeId}-${r.meal}-${i}`} className="hover:bg-surface-container-low">
                      <td className="p-sm tabular text-on-surface-variant">{firstRowIndex + i + 1}</td>
                      <td className="p-sm tabular whitespace-nowrap">{formatDayLabel(r.date)}</td>
                      <td className="p-sm tabular">{r.employeeId}</td>
                      <td className="p-sm text-on-surface">
                        {r.fullName || <span className="italic text-on-surface-variant">(không có trong file)</span>}
                      </td>
                      <td className="p-sm text-on-surface-variant">{r.department}</td>
                      <td className="p-sm whitespace-nowrap">{mealLabel(r.meal)}</td>
                      {openedCard.withTime && <td className="p-sm tabular">{r.time}</td>}
                      {openedCard.withNote && (
                        <td className="p-sm">
                          {/* Ghi chú dài (vd. về miễn chấm) xuống dòng thay vì kéo giãn cả bảng. */}
                          {r.note && (
                            <span className={`inline-block px-2 py-0.5 bg-error-container text-on-error-container text-label-sm ${
                              r.note.length > 40 ? 'rounded-lg max-w-[22rem] whitespace-normal' : 'rounded-full whitespace-nowrap'
                            }`}>
                              {r.note}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {visibleRows.length > 0 && (
            <div className="p-sm border-t border-outline-variant flex flex-wrap items-center gap-3">
              <select
                value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); resetPaging(); }}
                aria-label="Số dòng mỗi trang"
                className="bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm outline-none cursor-pointer"
              >
                {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>

              <span className="text-body-sm text-on-surface-variant">
                {firstRowIndex + 1}–{Math.min(firstRowIndex + pageSize, visibleRows.length)} trong tổng số {visibleRows.length}
              </span>

              {totalPages > 1 && (
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    aria-label="Trang trước"
                    className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  </button>

                  {pageList(safePage, totalPages).map((p, i) =>
                    p === '…' ? (
                      <span key={`gap-${i}`} className="w-8 h-8 inline-flex items-center justify-center text-on-surface-variant">…</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        aria-current={p === safePage ? 'page' : undefined}
                        className={`min-w-8 h-8 px-2 inline-flex items-center justify-center rounded-lg text-label-md tabular transition-colors ${
                          p === safePage
                            ? 'bg-primary text-on-primary'
                            : 'text-on-surface-variant hover:bg-surface-container'
                        }`}
                      >
                        {p}
                      </button>
                    )
                  )}

                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    aria-label="Trang sau"
                    className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
