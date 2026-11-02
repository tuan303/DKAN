import { isIsoDate } from '../../agent/lib/common.mjs';
import { vnToday } from '../../agent/lib/meal-rules.mjs';

const isMonth = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) && isIsoDate(`${value}-01`);

/** Calendar months from a Vietnam calendar date, with no browser/UTC offset. */
export function reconciliationMonthOptions(today: string, selectedMonth?: string): string[] {
  if (!isIsoDate(today)) return [];
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  const months: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    month--;
    if (month === 0) { month = 12; year--; }
  }
  // Other admin tabs and a HAC workbook can already select another month.
  // Preserve that selection instead of silently replacing it with this month.
  if (isMonth(selectedMonth) && !months.includes(selectedMonth)) months.push(selectedMonth);
  return months;
}

type Props = {
  selectedMonth: string;
  onMonthChange: (month: string) => void;
  today?: string;
};

export function ReconciliationMonthPicker({ selectedMonth, onMonthChange, today = vnToday() }: Props) {
  const options = reconciliationMonthOptions(today, selectedMonth);
  const currentMonth = options[0];
  const relativeLabels = ['Tháng hiện tại', 'Tháng trước', 'Hai tháng trước'];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-low p-3 sm:flex-row sm:items-end sm:justify-between sm:p-4">
      <div className="min-w-0">
        <label htmlFor="reconciliation-month" className="block text-label-md font-semibold text-on-surface">
          Tháng đối soát
        </label>
        <p id="reconciliation-month-hint" className="mt-1 text-body-sm text-on-surface-variant">
          Tra cứu tháng hiện tại và hai tháng trước. Bộ lọc ngày và báo cáo Excel dùng tháng đã chọn.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
        <select
          id="reconciliation-month"
          value={selectedMonth}
          onChange={event => {
            if (options.includes(event.target.value)) onMonthChange(event.target.value);
          }}
          aria-describedby="reconciliation-month-hint"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body-md font-semibold text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary sm:flex-none"
        >
          {options.map((month, index) => (
            <option key={month} value={month}>
              Tháng {month.slice(5)}/{month.slice(0, 4)}{index < 3 ? ` · ${relativeLabels[index]}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => { if (currentMonth) onMonthChange(currentMonth); }}
          disabled={!currentMonth || selectedMonth === currentMonth}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-label-md text-primary hover:bg-primary-container/30 disabled:cursor-default disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">today</span>
          Tháng hiện tại
        </button>
      </div>
    </div>
  );
}
