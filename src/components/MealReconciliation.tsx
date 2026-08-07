import { useMemo, useState } from 'react';
import * as xlsx from 'xlsx';

/**
 * Đối soát đăng ký ăn (DKAN) với dữ liệu chấm ăn xuất từ phần mềm HAC.
 *
 * File HAC là "Báo cáo chấm vào&ra hàng tháng": mỗi người một dòng, mỗi ngày
 * một ô dạng "07:43-11:49" (giờ vào – giờ ra), "Không-11:49" (thiếu giờ vào)
 * hoặc "-" (không có lượt chấm nào).
 *
 * Không dựa vào vị trí vào/ra của HAC mà phân bữa theo GIỜ THỰC TẾ so với hai
 * khung giờ bên dưới: như vậy lượt chấm lệch khung sẽ lộ ra thay vì bị gán bừa.
 */

// Khung giờ chấm, khớp cấu hình ca "Chấm ăn" trong HAC.
const MEAL_WINDOWS = {
  breakfast: { from: '06:00', to: '07:45', label: 'Bữa sáng' },
  lunch: { from: '11:00', to: '14:30', label: 'Bữa trưa' },
};

type Meal = 'breakfast' | 'lunch';

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
  fullName?: string;
  cancelDate?: string;
  cancelMeal?: string;
}

interface TapRecord {
  employeeId: string;
  name: string;
  department: string;
  breakfast: string | null;
  lunch: string | null;
  outside: string[];
}

interface ParsedFile {
  month: string;
  fileName: string;
  rowCount: number;
  // date (YYYY-MM-DD) -> mã NV -> lượt chấm
  byDate: Record<string, Record<string, TapRecord>>;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const classifyTime = (hhmm: string): Meal | null => {
  const t = toMinutes(hhmm);
  if (t >= toMinutes(MEAL_WINDOWS.breakfast.from) && t <= toMinutes(MEAL_WINDOWS.breakfast.to)) return 'breakfast';
  if (t >= toMinutes(MEAL_WINDOWS.lunch.from) && t <= toMinutes(MEAL_WINDOWS.lunch.to)) return 'lunch';
  return null;
};

const isWeekday = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`).getDay();
  return d !== 0 && d !== 6;
};

const formatDayLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  const names = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  return `${names[d.getDay()]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
};

/** Bóc tách các dòng đã đọc từ sheet. Tách riêng khỏi phần đọc file để chạy
 *  kiểm thử được bằng Node với file Excel thật. */
export function parseHacRows(rows: string[][]): Omit<ParsedFile, 'fileName'> {
  // Năm nằm ở dòng "Khoảng thời gian: 2026-07-01 - 2026-07-31", cột ngày
  // chỉ ghi MM-DD nên bắt buộc phải lấy năm từ đây, không được đoán.
  const rangeRow = rows.find(r => String(r[0] || '').startsWith('Khoảng thời gian'));
  const yearMatch = String(rangeRow?.[0] || '').match(/(\d{4})-(\d{2})-\d{2}/);
  if (!yearMatch) throw new Error('Không tìm thấy dòng "Khoảng thời gian" để xác định tháng của báo cáo.');
  const year = yearMatch[1];
  const month = `${yearMatch[1]}-${yearMatch[2]}`;

  const headerIdx = rows.findIndex(r => String(r[0] || '').trim() === 'Tên');
  if (headerIdx === -1) throw new Error('Không tìm thấy dòng tiêu đề (cột "Tên").');
  const header = rows[headerIdx].map(c => String(c || '').trim());

  const colId = header.indexOf('ID');
  const colDept = header.indexOf('Bộ phận');
  if (colId === -1) throw new Error('Không tìm thấy cột "ID" (mã nhân viên).');

  // Cột ngày có dạng MM-DD
  const dayCols: { idx: number; date: string }[] = [];
  header.forEach((h, idx) => {
    const m = h.match(/^(\d{2})-(\d{2})$/);
    if (m) dayCols.push({ idx, date: `${year}-${m[1]}-${m[2]}` });
  });
  if (!dayCols.length) throw new Error('Không tìm thấy cột ngày nào (dạng MM-DD).');

  const byDate: ParsedFile['byDate'] = {};
  dayCols.forEach(c => { byDate[c.date] = {}; });

  let rowCount = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const employeeId = String(row[colId] || '').trim();
    if (!employeeId) continue;
    const name = String(row[0] || '').trim();
    const department = colDept >= 0 ? String(row[colDept] || '').trim() : '';
    rowCount++;

    for (const c of dayCols) {
      const cell = String(row[c.idx] || '').trim();
      if (!cell || cell === '-') continue;
      const times = cell.match(/\d{1,2}:\d{2}/g);
      if (!times) continue;

      const rec: TapRecord = { employeeId, name, department, breakfast: null, lunch: null, outside: [] };
      for (const t of times) {
        const meal = classifyTime(t);
        // Chấm nhiều lần trong cùng một bữa: giữ lượt sớm nhất.
        if (meal === 'breakfast') rec.breakfast = rec.breakfast && rec.breakfast < t ? rec.breakfast : t;
        else if (meal === 'lunch') rec.lunch = rec.lunch && rec.lunch < t ? rec.lunch : t;
        else rec.outside.push(t);
      }
      byDate[c.date][employeeId] = rec;
    }
  }

  return { month, rowCount, byDate };
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

interface Row {
  employeeId: string;
  fullName: string;
  department: string;
  date: string;
  // 'none' = lượt chấm không rơi vào bữa nào
  meal: Meal | 'none';
  time?: string;
  note?: string;
}

const mealLabel = (m: Meal | 'none') => (m === 'none' ? '—' : MEAL_WINDOWS[m].label);

/**
 * Đối chiếu đăng ký với lượt chấm. Hàm thuần, tách khỏi giao diện để kiểm thử
 * được bằng Node — đây là chỗ ra con số nên Bộ phận Dinh dưỡng sẽ hành động,
 * không nên để nó nằm lẫn trong component.
 */
export function reconcile({
  byDate,
  dates,
  registrations,
  cancelations,
}: {
  byDate: ParsedFile['byDate'];
  dates: string[];
  registrations: Registration[];
  cancelations: Cancelation[];
}) {
  const missing: Row[] = [];   // đăng ký nhưng không chấm
  const extra: Row[] = [];     // chấm nhưng không đăng ký
  const outside: Row[] = [];   // chấm ngoài khung giờ
  let expectedCount = 0;
  let actualCount = 0;

  // Ngày nào bị hủy bữa nào: khóa "mã NV|ngày|bữa"
  const cancelSet = new Set<string>();
  for (const c of cancelations) {
    if (!c.employeeId || !c.cancelDate) continue;
    const meals = c.cancelMeal === 'both' ? ['breakfast', 'lunch'] : [c.cancelMeal];
    for (const m of meals) if (m) cancelSet.add(`${c.employeeId}|${c.cancelDate}|${m}`);
  }

  const regByEmployee = new Map(registrations.map(r => [r.employeeId, r]));

  // Vì sao người này chấm ăn mà không nằm trong danh sách đáng lẽ ăn?
  // Phân biệt "người ngoài" với "đã báo hủy nhưng vẫn ăn" — hai chuyện rất
  // khác nhau khi Bộ phận Dinh dưỡng xử lý.
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
      expectedCount += expected.length;

      const expectedIds = new Set(expected.map(r => r.employeeId));

      for (const r of expected) {
        if (!taps[r.employeeId]?.[meal]) {
          missing.push({ employeeId: r.employeeId, fullName: r.fullName, department: r.department, date, meal });
        }
      }

      for (const [employeeId, rec] of Object.entries(taps)) {
        if (!rec[meal]) continue;
        actualCount++;
        if (!expectedIds.has(employeeId)) {
          extra.push({
            employeeId,
            fullName: rec.name,
            department: rec.department,
            date,
            meal,
            time: rec[meal] as string,
            note: explainExtra(employeeId, date, meal),
          });
        }
      }
    }

    for (const [employeeId, rec] of Object.entries(taps)) {
      for (const t of rec.outside) {
        outside.push({ employeeId, fullName: rec.name, department: rec.department, date, meal: 'none', time: t });
      }
    }
  }

  const byDateThenName = (a: Row, b: Row) =>
    a.date === b.date ? a.fullName.localeCompare(b.fullName, 'vi') : a.date.localeCompare(b.date);

  return {
    missing: missing.sort(byDateThenName),
    extra: extra.sort(byDateThenName),
    outside: outside.sort(byDateThenName),
    expectedCount,
    actualCount,
  };
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
  const [scope, setScope] = useState<'day' | 'month'>('day');
  const [selectedDate, setSelectedDate] = useState<string>('');

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    setIsParsing(true);
    setError(null);
    try {
      const result = await parseHacWorkbook(file);
      setParsed(result);
      const dates = Object.keys(result.byDate).filter(isWeekday).sort();
      const today = new Date().toISOString().slice(0, 10);
      setSelectedDate(dates.includes(today) ? today : (dates[dates.length - 1] || ''));
    } catch (err: any) {
      setParsed(null);
      setError(err?.message || 'File không đúng định dạng báo cáo của HAC.');
    } finally {
      setIsParsing(false);
    }
  };

  const dates = useMemo(() => {
    if (!parsed) return [];
    return Object.keys(parsed.byDate).filter(isWeekday).sort();
  }, [parsed]);

  const activeDates = useMemo(() => {
    if (!parsed) return [];
    return scope === 'month' ? dates : (selectedDate ? [selectedDate] : []);
  }, [parsed, scope, dates, selectedDate]);

  const result = useMemo(
    () => reconcile({ byDate: parsed?.byDate || {}, dates: activeDates, registrations, cancelations }),
    [parsed, activeDates, registrations, cancelations]
  );


  const monthMismatch = parsed && parsed.month !== selectedMonth;

  const handleExport = () => {
    const sheet = (rows: Row[], withTime: boolean, withNote = false) =>
      xlsx.utils.json_to_sheet(
        rows.map((r, i) => {
          const base: Record<string, string | number> = {
            'STT': i + 1,
            'Ngày': `${r.date.slice(8, 10)}/${r.date.slice(5, 7)}/${r.date.slice(0, 4)}`,
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
    xlsx.utils.book_append_sheet(wb, sheet(result.outside, true), 'Cham ngoai gio');
    const suffix = scope === 'month' ? selectedMonth : selectedDate;
    xlsx.writeFile(wb, `Doi_soat_cham_an_${suffix}.xlsx`);
  };

  const Table = ({ rows, withTime, empty, withNote = false }: { rows: Row[]; withTime: boolean; empty: string; withNote?: boolean }) => (
    <div className="overflow-x-auto">
      {rows.length === 0 ? (
        <p className="text-body-sm text-on-surface-variant italic p-md">{empty}</p>
      ) : (
        <table className="w-full text-left text-body-sm min-w-[560px]">
          <thead className="bg-surface-container-low text-on-surface-variant text-label-sm uppercase">
            <tr>
              <th className="p-sm w-12">STT</th>
              <th className="p-sm">Ngày</th>
              <th className="p-sm">Mã NV</th>
              <th className="p-sm">Họ và tên</th>
              <th className="p-sm">Bộ phận</th>
              <th className="p-sm">Bữa</th>
              {withTime && <th className="p-sm">Giờ chấm</th>}
              {withNote && <th className="p-sm">Lý do</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {rows.slice(0, 300).map((r, i) => (
              <tr key={`${r.date}-${r.employeeId}-${r.meal}-${i}`} className="hover:bg-surface-container-low">
                <td className="p-sm tabular text-on-surface-variant">{i + 1}</td>
                <td className="p-sm tabular whitespace-nowrap">{formatDayLabel(r.date)}</td>
                <td className="p-sm tabular">{r.employeeId}</td>
                <td className="p-sm text-on-surface">{r.fullName || <span className="italic text-on-surface-variant">(không có trong file)</span>}</td>
                <td className="p-sm text-on-surface-variant">{r.department}</td>
                <td className="p-sm">{mealLabel(r.meal)}</td>
                {withTime && <td className="p-sm tabular">{r.time}</td>}
                {withNote && (
                  <td className="p-sm">
                    {r.note ? (
                      <span className="inline-block px-2 py-0.5 rounded-full bg-error-container text-on-error-container text-label-sm whitespace-nowrap">
                        {r.note}
                      </span>
                    ) : ''}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 300 && (
        <p className="text-body-sm text-on-surface-variant p-sm">
          Đang hiển thị 300 dòng đầu trong tổng số {rows.length}. Xuất Excel để xem đầy đủ.
        </p>
      )}
    </div>
  );

  const Card = ({ icon, label, value, tone }: { icon: string; label: string; value: number; tone: string }) => (
    <div className={`p-md rounded-lg border flex items-center gap-3 ${tone}`}>
      <span className="material-symbols-outlined text-[26px] shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[28px] font-extrabold leading-none tabular">{value}</p>
        <p className="text-body-sm mt-1">{label}</p>
      </div>
    </div>
  );

  return (
    <div className="px-md md:px-0 flex flex-col gap-md lg:gap-lg">
      <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
        <div className="p-md border-b border-outline-variant bg-surface-container-low">
          <h2 className="text-headline-sm text-on-surface uppercase">Đối soát chấm ăn</h2>
          <p className="text-on-surface-variant text-[13px] mt-1">
            So sánh đăng ký trên hệ thống với dữ liệu chấm ăn xuất từ phần mềm HAC.
            Bữa sáng tính lượt chấm {MEAL_WINDOWS.breakfast.from}–{MEAL_WINDOWS.breakfast.to},
            bữa trưa {MEAL_WINDOWS.lunch.from}–{MEAL_WINDOWS.lunch.to}.
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
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={e => handleFile(e.target.files?.[0])}
            />
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
                  {(['day', 'month'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setScope(s)}
                      className={`px-4 py-2 text-label-md transition-colors ${
                        scope === s ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container'
                      }`}
                    >
                      {s === 'day' ? 'Theo ngày' : 'Cả tháng'}
                    </button>
                  ))}
                </div>

                {scope === 'day' && (
                  <select
                    value={selectedDate}
                    onChange={e => setSelectedDate(e.target.value)}
                    className="bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md text-primary font-bold outline-none cursor-pointer"
                  >
                    {dates.map(d => (
                      <option key={d} value={d}>{formatDayLabel(d)}</option>
                    ))}
                  </select>
                )}

                <button
                  onClick={handleExport}
                  className="ml-auto inline-flex items-center gap-2 px-4 py-2 bg-tertiary text-on-tertiary rounded-lg text-label-md hover:bg-tertiary-dark transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">download</span>
                  Xuất Excel
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-md">
                <Card icon="assignment_turned_in" label="Suất đã đăng ký" value={result.expectedCount} tone="bg-primary-container/40 border-primary/20 text-on-primary-container" />
                <Card icon="how_to_reg" label="Lượt chấm hợp lệ" value={result.actualCount} tone="bg-tertiary-container/50 border-tertiary/25 text-on-tertiary-container" />
                <Card icon="no_meals" label="Đăng ký nhưng không chấm" value={result.missing.length} tone="bg-warning-container border-warning/30 text-on-warning-container" />
                <Card icon="person_alert" label="Chấm nhưng không đăng ký" value={result.extra.length} tone="bg-error-container border-error/25 text-on-error-container" />
              </div>
            </>
          )}
        </div>
      </div>

      {parsed && (
        <>
          <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
            <div className="p-md border-b border-outline-variant bg-surface-container-low flex items-center gap-2">
              <span className="material-symbols-outlined text-on-warning-container">no_meals</span>
              <h3 className="text-headline-sm text-on-surface uppercase">Đăng ký nhưng không chấm ăn ({result.missing.length})</h3>
            </div>
            <Table rows={result.missing} withTime={false} empty="Không có trường hợp nào — mọi suất đã đăng ký đều được chấm." />
          </div>

          <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
            <div className="p-md border-b border-outline-variant bg-surface-container-low flex items-center gap-2">
              <span className="material-symbols-outlined text-error">person_alert</span>
              <h3 className="text-headline-sm text-on-surface uppercase">Chấm ăn nhưng không đăng ký ({result.extra.length})</h3>
            </div>
            <Table rows={result.extra} withTime withNote empty="Không có trường hợp nào." />
          </div>

          <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
            <div className="p-md border-b border-outline-variant bg-surface-container-low flex items-center gap-2">
              <span className="material-symbols-outlined text-on-surface-variant">schedule</span>
              <h3 className="text-headline-sm text-on-surface uppercase">Chấm ngoài khung giờ ({result.outside.length})</h3>
            </div>
            <div className="px-md pt-md">
              <p className="text-body-sm text-on-surface-variant">
                Lượt chấm không rơi vào khung nào. Thường do đến muộn, hoặc đồng hồ máy chấm công bị lệch giờ.
              </p>
            </div>
            <Table rows={result.outside} withTime empty="Không có lượt chấm nào ngoài khung giờ." />
          </div>
        </>
      )}
    </div>
  );
}
