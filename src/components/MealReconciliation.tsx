import { useEffect, useMemo, useState } from 'react';
import * as xlsx from 'xlsx';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
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

interface AlertDay {
  status?: AlertStatus;
  at?: string;
  sent?: number;
  failed?: number;
  expected?: { breakfast?: number; lunch?: number };
  missing?: { breakfast?: number; lunch?: number };
  reason?: string | null;
  /** Chốt an toàn đã dừng gửi vì dữ liệu ngày này đáng ngờ — chưa được kết luận. */
  held?: boolean;
}

interface CheckinSync {
  agentVersion?: string;
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

const countOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Trạng thái mà agent đã thực sự đếm người đáng lẽ ăn / chưa chấm.
const COUNTED_STATUSES = new Set<AlertStatus>(['sent', 'partial', 'guarded', 'nothing']);

// Lịch Task Scheduler của agent: pha cảnh báo chạy từ 13:45, lặp mỗi 15 phút
// trong 1 giờ (xem agent/README.md).
const ALERT_WINDOW_END = '14:45';

/**
 * Diễn giải trạng thái gửi email cảnh báo của một ngày.
 * @param nowTime giờ Việt Nam hiện tại, HH:MM
 */
function describeAlert(
  alert: AlertDay | undefined,
  mealDay: boolean,
  nowTime: string
): { tone: 'ok' | 'warn' | 'error' | 'neutral'; text: string } {
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
  const reason = alert.reason ? `: ${alert.reason}` : '';
  switch (alert.status) {
    case 'sent':
      return { tone: 'ok', text: `Đã gửi ${countOf(alert.sent)} email cảnh báo.` };
    case 'partial':
      return {
        tone: 'warn',
        text: `Gửi được ${countOf(alert.sent)}, lỗi ${countOf(alert.failed)} email — lần chạy sau sẽ gửi nốt.`,
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
function SyncHealthStrip({ sync, offDays }: { sync: CheckinSync; offDays: string[] }) {
  const devices = Object.entries(sync.devices || {})
    .filter(([, d]) => d && typeof d === 'object')
    .sort(([a], [b]) => a.localeCompare(b, 'vi'));
  // Doc có mà chưa có gì để xem (ghi dở) thì thôi không hiện.
  if (!devices.length && !sync.lastRunAt && !sync.alerts) return null;

  const now = vnParts();
  const today = now?.date ?? vnToday();
  const alert = sync.alerts?.[today];
  const alertInfo = describeAlert(alert, isMealDay(today, offDays), now?.time ?? '00:00');
  const failed = devices.filter(([, d]) => !d.ok);
  // Chỉ những trạng thái có tính lại số liệu mới hiện "Chưa chấm x/y". Với
  // 'error' agent không tính gì (doc mang 0/0 hoặc số của lần chạy trước), hiện
  // ra sẽ đọc thành "không ai thiếu" trong khi thật ra chưa biết.
  const showCounts = !!alert && !!alert.status && COUNTED_STATUSES.has(alert.status) && !!alert.expected;

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
        <span className="text-on-surface-variant shrink-0 pt-0.5">Email cảnh báo hôm nay ({formatDayLabel(today)}):</span>
        <span className={`inline-flex items-start gap-1.5 px-2.5 py-0.5 rounded-lg break-words min-w-0 ${TONE_CLASS[alertInfo.tone]}`}>
          {alertInfo.text}
          {alert?.at && <span className="opacity-80 tabular whitespace-nowrap"> · {formatVnDateTime(alert.at)}</span>}
        </span>
        {showCounts && (
          <span className="text-on-surface-variant pt-0.5 tabular">
            Chưa chấm: sáng {countOf(alert?.missing?.breakfast)}/{countOf(alert?.expected?.breakfast)},
            trưa {countOf(alert?.missing?.lunch)}/{countOf(alert?.expected?.lunch)}
          </span>
        )}
      </div>
    </div>
  );
}

type CardKey = 'registered' | 'tapped' | 'missing' | 'pending' | 'extra' | 'unrecognized' | 'invalidRegs';

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

export function MealReconciliation({
  registrations,
  cancelations,
  selectedMonth,
}: {
  registrations: Registration[];
  cancelations: Cancelation[];
  selectedMonth: string;
}) {
  const [source, setSource] = useState<'auto' | 'file'>('auto');
  const [fileData, setFileData] = useState<ParsedFile | null>(null);
  const [autoData, setAutoData] = useState<ParsedFile | null>(null);
  const [autoState, setAutoState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [savedExcludes, setSavedExcludes] = useState<string[]>([]);
  const [offDays, setOffDays] = useState<string[]>([]);
  const [offDaysError, setOffDaysError] = useState(false);
  const [syncInfo, setSyncInfo] = useState<CheckinSync | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  const parsed = source === 'auto' ? autoData : fileData;
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAutoState('loading');
      const [checkinsRes, excludesRes, offRes, syncRes] = await Promise.allSettled([
        getDocs(query(collection(db, 'checkins'), where('month', '==', selectedMonth))),
        getDoc(doc(db, 'settings', EXCLUDES_DOC)),
        loadOffDays(),
        loadSyncInfo(),
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
        pickDefaultDates(built, off);
      } catch (err) {
        console.error('Không dựng được dữ liệu chấm ăn đã đồng bộ:', err);
        setAutoState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedMonth]);
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

  const activeDates = useMemo(() => {
    // Lệch tháng thì không đối soát: so lượt chấm tháng này với đăng ký tháng
    // khác chỉ ra số rác, thà không hiện gì còn hơn hiện số sai.
    if (!parsed || monthMismatch) return [];
    if (scope === 'month') return dates;
    if (scope === 'day') return selectedDate ? [selectedDate] : [];
    if (!rangeFrom || !rangeTo) return [];
    const [from, to] = rangeFrom <= rangeTo ? [rangeFrom, rangeTo] : [rangeTo, rangeFrom];
    return dates.filter(d => d >= from && d <= to);
  }, [parsed, scope, dates, selectedDate, rangeFrom, rangeTo, monthMismatch]);

  const result = useMemo(
    () => reconcile({
      byDate: parsed?.byDate || {},
      dates: activeDates,
      registrations,
      cancelations,
      excludedIds,
      offDays,
    }),
    [parsed, activeDates, registrations, cancelations, excludedIds, offDays]
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
      key: 'missing', icon: 'no_meals', label: 'Đăng ký nhưng không chấm', rows: missing,
      tone: 'bg-warning-container border-warning/30 text-on-warning-container',
      active: 'ring-2 ring-warning', withTime: false,
    },
    // Chỉ hiện khi phạm vi đang xem có bữa chưa chốt dữ liệu.
    ...(pending.length
      ? [{
          key: 'pending' as const, icon: 'hourglass_top', label: 'Chưa chấm — số liệu tạm', rows: pending,
          tone: 'bg-surface-container border-outline-variant text-on-surface-variant',
          active: 'ring-2 ring-outline', withTime: false,
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
    const sheet = (rows: Row[], withTime: boolean, withNote = false) =>
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
          if (withNote) base['Lý do'] = r.note || '';
          return base;
        })
      );

    const wb = xlsx.utils.book_new();
    // 'DK khong cham' chỉ gồm bữa đã chốt dữ liệu; số tạm để sheet riêng cho
    // khỏi bị đem đi xử lý vi phạm cùng.
    xlsx.utils.book_append_sheet(wb, sheet(missing, false), 'DK khong cham');
    if (pending.length) xlsx.utils.book_append_sheet(wb, sheet(pending, false), 'Chua cham - so tam');
    xlsx.utils.book_append_sheet(wb, sheet(result.extra, true, true), 'Cham khong DK');
    xlsx.utils.book_append_sheet(wb, sheet(result.unrecognized, true), 'Cham ngoai gio');
    xlsx.utils.book_append_sheet(wb, sheet(result.registered, false), 'Suat da dang ky');
    xlsx.utils.book_append_sheet(wb, sheet(result.tapped, true), 'Luot cham hop le');

    const suffix =
      scope === 'month' ? selectedMonth
        : scope === 'day' ? selectedDate
          : `${rangeFrom}_den_${rangeTo}`;
    xlsx.writeFile(wb, `Doi_soat_cham_an_${suffix}.xlsx`);
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

          {source === 'auto' && syncInfo && <SyncHealthStrip sync={syncInfo} offDays={offDays} />}

          {offDaysError && (
            <div className="p-sm rounded-lg bg-warning-container text-on-warning-container text-body-sm flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] shrink-0">event_busy</span>
              <span>
                Không đọc được danh sách ngày nghỉ ở tab Cấu hình. Ngày lễ rơi vào thứ 2–6 (nếu có) đang bị tính như
                ngày có suất ăn — Thầy/Cô tải lại trang trước khi dùng số liệu những ngày đó.
              </span>
            </div>
          )}

          {source === 'auto' && autoState === 'loading' && (
            <div className="p-md rounded-lg bg-surface-container text-on-surface-variant text-body-md flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] animate-spin">progress_activity</span>
              Đang lấy dữ liệu chấm ăn đã đồng bộ...
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
              <span>Không đọc được dữ liệu đã đồng bộ. Nếu vừa cập nhật Firestore Rules, hãy tải lại trang.</span>
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

              {monthMismatch && (
                <div className="p-sm rounded-lg bg-warning-container text-on-warning-container text-body-md flex items-start gap-2">
                  <span className="material-symbols-outlined text-[20px] shrink-0">warning</span>
                  <span>
                    Dữ liệu là tháng <strong>{parsed.month.slice(5)}/{parsed.month.slice(0, 4)}</strong> nhưng danh sách đăng ký
                    đang xem là tháng <strong>{selectedMonth.slice(5)}/{selectedMonth.slice(0, 4)}</strong>.
                    <strong> Đã tạm dừng đối soát</strong> để không đưa ra con số sai — vui lòng đổi tháng ở tab
                    ĐK ăn hàng tháng cho khớp.
                  </span>
                </div>
              )}

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
            </>
          )}
        </div>
      </div>

      {parsed && openedCard && (
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
                    {openedCard.withNote && <th className="p-sm">Lý do</th>}
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
                          {r.note && (
                            <span className="inline-block px-2 py-0.5 rounded-full bg-error-container text-on-error-container text-label-sm whitespace-nowrap">
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
