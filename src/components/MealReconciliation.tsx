import { useMemo, useState } from 'react';
import * as xlsx from 'xlsx';

/**
 * Đối soát đăng ký ăn (DKAN) với dữ liệu chấm ăn xuất từ phần mềm HAC.
 *
 * File HAC là "Báo cáo chấm vào&ra hàng tháng": mỗi người một dòng, mỗi ngày
 * một ô dạng "07:43-11:49", "Không-11:49", "07:43-Không", hoặc "-" khi không
 * có lượt chấm nào.
 *
 * Phân bữa theo GIỜ CHẤM so với hai khung dưới đây, không theo vị trí trong ô:
 * HAC xếp lượt chấm đầu tiên trong ngày vào vị trí 1 dù người đó chỉ ăn trưa,
 * nên vị trí không phản ánh đúng bữa. Lượt chấm rơi ngoài cả hai khung thì
 * không được ghi nhận, nhưng vẫn liệt kê riêng để nhà trường rà soát.
 */

type Meal = 'breakfast' | 'lunch';

const MEAL_LABEL: Record<Meal, string> = { breakfast: 'Bữa sáng', lunch: 'Bữa trưa' };

// Quy định của nhà trường: chỉ lượt chấm trong khung mới được tính suất ăn.
const MEAL_WINDOWS: Record<Meal, { from: string; to: string }> = {
  breakfast: { from: '05:00', to: '08:00' },
  lunch: { from: '10:00', to: '13:30' },
};

// Bộ phận không đưa vào đối soát: nhân sự bếp quẹt thẻ để chấm công chứ không
// phải để nhận suất ăn, tính vào sẽ làm phình danh sách "chấm không đăng ký".
const EXCLUDED_DEPARTMENTS = ['NSHM>Bếp Vina'];

// So theo đoạn cuối sau dấu '>' nên vẫn khớp nếu HAC đổi tiền tố hoặc thêm
// khoảng trắng, ví dụ "Bếp Vina" hay "NSHM > Bếp Vina".
const deptLeaf = (d: string) => (d.split('>').pop() || d).replace(/\s+/g, ' ').trim().toLowerCase();
const EXCLUDED_LEAVES = new Set(EXCLUDED_DEPARTMENTS.map(deptLeaf));
const isExcludedDept = (d: string) => EXCLUDED_LEAVES.has(deptLeaf(d));

interface Registration {
  employeeId: string;
  fullName: string;
  department: string;
  breakfastCount: number;
  lunchCount: number;
  firstMealDate?: string;
}

interface Cancelation {
  employeeId?: string;
  cancelDate?: string;
  cancelMeal?: string;
}

interface TapRecord {
  employeeId: string;
  name: string;
  department: string;
  breakfast: string | null;
  lunch: string | null;
  unrecognized: string[];
}

interface ParsedFile {
  month: string;
  fileName: string;
  rowCount: number;
  // date (YYYY-MM-DD) -> mã NV -> lượt chấm
  byDate: Record<string, Record<string, TapRecord>>;
  // Mã NV thuộc bộ phận bị loại, dùng để loại luôn ở phía đăng ký
  excludedIds: string[];
}

interface Row {
  employeeId: string;
  fullName: string;
  department: string;
  date: string;
  meal: Meal | 'none';
  time?: string;
  note?: string;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const classifyTime = (hhmm: string): Meal | null => {
  const t = toMinutes(hhmm);
  for (const meal of ['breakfast', 'lunch'] as Meal[]) {
    if (t >= toMinutes(MEAL_WINDOWS[meal].from) && t <= toMinutes(MEAL_WINDOWS[meal].to)) return meal;
  }
  return null;
};

const mealLabel = (m: Meal | 'none') => (m === 'none' ? '—' : MEAL_LABEL[m]);

const isWeekday = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`).getDay();
  return d !== 0 && d !== 6;
};

const DAY_NAMES = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const formatDayLabel = (iso: string) =>
  `${DAY_NAMES[new Date(`${iso}T00:00:00`).getDay()]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const formatDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

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
    const employeeId = String(row[colId] || '').trim();
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

      const rec: TapRecord = { employeeId, name, department, breakfast: null, lunch: null, unrecognized: [] };
      for (const t of times) {
        const meal = classifyTime(t);
        // Chấm nhiều lần trong cùng một bữa: giữ lượt sớm nhất.
        if (meal) rec[meal] = rec[meal] && (rec[meal] as string) < t ? rec[meal] : t;
        else rec.unrecognized.push(t);
      }
      byDate[c.date][employeeId] = rec;
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
        resolve({ ...parseHacRows(rows), fileName: file.name });
      } catch (err: any) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Đối chiếu đăng ký với lượt chấm. Hàm thuần, tách khỏi giao diện để kiểm thử
 * được bằng Node — đây là chỗ ra con số nên Bộ phận Dinh dưỡng sẽ hành động.
 */
export function reconcile({
  byDate,
  dates,
  registrations: allRegistrations,
  cancelations,
  excludedIds = [],
}: {
  byDate: ParsedFile['byDate'];
  dates: string[];
  registrations: Registration[];
  cancelations: Cancelation[];
  excludedIds?: string[];
}) {
  // Loại cả ở phía đăng ký: nếu một người bên bếp có đăng ký trên hệ thống thì
  // cũng không được rơi vào danh sách "đăng ký nhưng không chấm".
  const excluded = new Set(excludedIds);
  const registrations = excluded.size
    ? allRegistrations.filter(r => !excluded.has(r.employeeId))
    : allRegistrations;

  const registered: Row[] = [];    // mọi suất đã đăng ký
  const tapped: Row[] = [];        // mọi lượt chấm được ghi nhận
  const missing: Row[] = [];       // đăng ký nhưng không chấm
  const extra: Row[] = [];         // chấm nhưng không đăng ký
  const unrecognized: Row[] = [];  // chấm ngoài khung giờ, không được ghi nhận

  // Ngày nào bị hủy bữa nào: khóa "mã NV|ngày|bữa"
  const cancelSet = new Set<string>();
  for (const c of cancelations) {
    if (!c.employeeId || !c.cancelDate) continue;
    const meals = c.cancelMeal === 'both' ? ['breakfast', 'lunch'] : [c.cancelMeal];
    for (const m of meals) if (m) cancelSet.add(`${c.employeeId}|${c.cancelDate}|${m}`);
  }

  const regByEmployee = new Map(registrations.map(r => [r.employeeId, r]));

  // Vì sao người này chấm ăn mà không nằm trong danh sách đáng lẽ ăn? Phân biệt
  // "người ngoài" với "đã báo hủy nhưng vẫn ăn" — hai chuyện rất khác nhau.
  const explainExtra = (employeeId: string, date: string, meal: Meal) => {
    const reg = regByEmployee.get(employeeId);
    if (!reg) return 'Không có đăng ký trong tháng';
    if (cancelSet.has(`${employeeId}|${date}|${meal}`)) return 'Đã báo hủy bữa này';
    if (reg.firstMealDate && date < reg.firstMealDate) {
      return `Đăng ký từ ngày ${reg.firstMealDate.slice(8, 10)}/${reg.firstMealDate.slice(5, 7)}`;
    }
    const count = meal === 'breakfast' ? reg.breakfastCount : reg.lunchCount;
    if (!count) return meal === 'breakfast' ? 'Chỉ đăng ký bữa trưa' : 'Không đăng ký bữa này';
    return '';
  };

  for (const date of dates) {
    const taps = byDate[date] || {};

    for (const meal of ['breakfast', 'lunch'] as Meal[]) {
      // Ai đáng lẽ phải ăn bữa này hôm nay
      const expected = registrations.filter(r => {
        const count = meal === 'breakfast' ? r.breakfastCount : r.lunchCount;
        if (!count) return false;
        // Đăng ký giữa tháng: chưa tới ngày bắt đầu thì không tính
        if (r.firstMealDate && date < r.firstMealDate) return false;
        if (cancelSet.has(`${r.employeeId}|${date}|${meal}`)) return false;
        return true;
      });

      const expectedIds = new Set(expected.map(r => r.employeeId));

      for (const r of expected) {
        const row = { employeeId: r.employeeId, fullName: r.fullName, department: r.department, date, meal };
        registered.push(row);
        if (!taps[r.employeeId]?.[meal]) missing.push(row);
      }

      for (const [employeeId, rec] of Object.entries(taps)) {
        const time = rec[meal];
        if (!time) continue;
        const row = { employeeId, fullName: rec.name, department: rec.department, date, meal, time };
        tapped.push(row);
        if (!expectedIds.has(employeeId)) {
          extra.push({ ...row, note: explainExtra(employeeId, date, meal) });
        }
      }
    }

    for (const [employeeId, rec] of Object.entries(taps)) {
      for (const t of rec.unrecognized) {
        unrecognized.push({ employeeId, fullName: rec.name, department: rec.department, date, meal: 'none', time: t });
      }
    }
  }

  const byDateThenName = (a: Row, b: Row) =>
    a.date === b.date ? a.fullName.localeCompare(b.fullName, 'vi') : a.date.localeCompare(b.date);

  return {
    registered: registered.sort(byDateThenName),
    tapped: tapped.sort(byDateThenName),
    missing: missing.sort(byDateThenName),
    extra: extra.sort(byDateThenName),
    unrecognized: unrecognized.sort(byDateThenName),
  };
}

type CardKey = 'registered' | 'tapped' | 'missing' | 'extra' | 'unrecognized';

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
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [scope, setScope] = useState<'day' | 'range' | 'month'>('day');
  const [selectedDate, setSelectedDate] = useState('');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [openCard, setOpenCard] = useState<CardKey | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);

  // Đổi phạm vi xem hay đổi bảng thì quay về trang 1, nếu không người dùng sẽ
  // thấy một trang trống vì bảng mới ít dòng hơn.
  const resetPaging = () => setPage(1);

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    setIsParsing(true);
    setError(null);
    try {
      const result = await parseHacWorkbook(file);
      setParsed(result);
      const days = Object.keys(result.byDate).filter(isWeekday).sort();
      const today = new Date().toISOString().slice(0, 10);
      const fallback = days.includes(today) ? today : (days[days.length - 1] || '');
      setSelectedDate(fallback);
      setRangeFrom(days[0] || '');
      setRangeTo(fallback);
      setOpenCard(null);
      resetPaging();
    } catch (err: any) {
      setParsed(null);
      setError(err?.message || 'File không đúng định dạng báo cáo của HAC.');
    } finally {
      setIsParsing(false);
    }
  };

  const dates = useMemo(
    () => (parsed ? Object.keys(parsed.byDate).filter(isWeekday).sort() : []),
    [parsed]
  );

  const activeDates = useMemo(() => {
    if (!parsed) return [];
    if (scope === 'month') return dates;
    if (scope === 'day') return selectedDate ? [selectedDate] : [];
    if (!rangeFrom || !rangeTo) return [];
    const [from, to] = rangeFrom <= rangeTo ? [rangeFrom, rangeTo] : [rangeTo, rangeFrom];
    return dates.filter(d => d >= from && d <= to);
  }, [parsed, scope, dates, selectedDate, rangeFrom, rangeTo]);

  const result = useMemo(
    () => reconcile({
      byDate: parsed?.byDate || {},
      dates: activeDates,
      registrations,
      cancelations,
      excludedIds: parsed?.excludedIds,
    }),
    [parsed, activeDates, registrations, cancelations]
  );

  const monthMismatch = parsed && parsed.month !== selectedMonth;

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
      key: 'missing', icon: 'no_meals', label: 'Đăng ký nhưng không chấm', rows: result.missing,
      tone: 'bg-warning-container border-warning/30 text-on-warning-container',
      active: 'ring-2 ring-warning', withTime: false,
    },
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
    xlsx.utils.book_append_sheet(wb, sheet(result.missing, false), 'DK khong cham');
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

  // Kẹp số trang lại phòng khi dữ liệu đổi mà trang hiện tại vượt quá số trang.
  const totalPages = Math.max(1, Math.ceil((openedCard?.rows.length || 0) / pageSize));
  const safePage = Math.min(page, totalPages);
  const firstRowIndex = (safePage - 1) * pageSize;
  const pageRows = openedCard ? openedCard.rows.slice(firstRowIndex, firstRowIndex + pageSize) : [];

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
                </span>
                <span>Tháng {parsed.month.slice(5)}/{parsed.month.slice(0, 4)} · {parsed.rowCount} người</span>
                {parsed.excludedIds.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container text-on-surface-variant"
                    title={`Bộ phận không đưa vào đối soát: ${EXCLUDED_DEPARTMENTS.join(', ')}`}
                  >
                    <span className="material-symbols-outlined text-[16px]">filter_alt_off</span>
                    Đã loại {parsed.excludedIds.length} người thuộc {EXCLUDED_DEPARTMENTS.join(', ')}
                  </span>
                )}
              </div>

              {monthMismatch && (
                <div className="p-sm rounded-lg bg-warning-container text-on-warning-container text-body-md flex items-start gap-2">
                  <span className="material-symbols-outlined text-[20px] shrink-0">warning</span>
                  <span>
                    File là tháng <strong>{parsed.month.slice(5)}/{parsed.month.slice(0, 4)}</strong> nhưng danh sách đăng ký
                    đang xem là tháng <strong>{selectedMonth.slice(5)}/{selectedMonth.slice(0, 4)}</strong>. Đổi tháng ở tab
                    ĐK ăn hàng tháng cho khớp, nếu không kết quả đối soát sẽ sai.
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
                    <span className="text-body-sm text-on-surface-variant">({activeDates.length} ngày làm việc)</span>
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

          <div className="overflow-x-auto">
            {openedCard.rows.length === 0 ? (
              <p className="text-body-sm text-on-surface-variant italic p-md">Không có trường hợp nào.</p>
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

          {openedCard.rows.length > 0 && (
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
                {firstRowIndex + 1}–{Math.min(firstRowIndex + pageSize, openedCard.rows.length)} trong tổng số {openedCard.rows.length}
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
