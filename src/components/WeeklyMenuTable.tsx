import { useId } from 'react';
import { MENU_ROWS } from '../../agent/lib/weekly-menu.mjs';
import type { MenuKey, WeeklyMenu } from '../../agent/lib/weekly-menu.mjs';
import { formatDate } from '../../agent/lib/meal-rules.mjs';
import { surveyWeekLabel } from '../../agent/lib/survey.mjs';

interface WeeklyMenuTableProps {
  menu: WeeklyMenu;
  onChange?: (dayIndex: number, key: MenuKey, value: string) => void;
  disabled?: boolean;
}

export function WeeklyMenuTable({ menu, onChange, disabled = false }: WeeklyMenuTableProps) {
  const captionId = useId();
  return (
    <div>
      <p className="md:hidden text-body-sm text-on-surface-variant mb-2">Vuốt ngang để xem đủ thực đơn từ thứ 2 đến thứ 6.</p>
      <div className="overflow-x-auto rounded-lg border border-outline-variant focus-visible:outline-2 focus-visible:outline-primary" tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="w-full min-w-[900px] border-collapse text-body-sm text-on-surface">
          <caption id={captionId} className="sr-only">Thực đơn tuần {surveyWeekLabel(menu.weekId)}</caption>
          <colgroup><col className="w-[90px]" /><col className="w-[128px]" /><col className="w-[40px]" />{menu.days.map(day => <col key={day.date} />)}</colgroup>
          <thead className="bg-[#fce5cd] text-primary">
            <tr>
              <th scope="col" rowSpan={2} className="border border-outline-variant p-2">Bữa ăn</th>
              <th scope="col" rowSpan={2} className="border border-outline-variant p-2">Nhóm món</th>
              <th scope="col" rowSpan={2} className="border border-outline-variant p-2">No</th>
              {menu.days.map((day, index) => <th key={day.date} scope="col" className="border border-outline-variant px-2 pt-3 pb-1 font-bold">THỨ {index + 2}</th>)}
            </tr>
            <tr>{menu.days.map(day => <th key={day.date} scope="col" className="border border-outline-variant px-2 pb-3 pt-1 font-semibold">{formatDate(day.date)}</th>)}</tr>
          </thead>
          <tbody>
            {MENU_ROWS.map((row, rowIndex) => (
              <tr key={row.key} className={rowIndex === 0 ? 'bg-[#cfe2f3]' : 'bg-surface-container-lowest'}>
                {rowIndex === 0 && <th scope="row" className="border border-outline-variant bg-[#fce5cd] p-3 text-primary font-bold">ĂN SÁNG</th>}
                {rowIndex === 1 && <th scope="rowgroup" rowSpan={6} className="border border-outline-variant bg-[#fce5cd] p-3 text-primary font-bold">ĂN TRƯA</th>}
                <th scope="row" className={`border border-outline-variant p-2 font-semibold ${rowIndex === 0 ? '' : 'bg-[#fce5cd] text-secondary italic'}`}>{rowIndex === 0 ? <span className="sr-only">{row.label}</span> : row.label.toUpperCase()}</th>
                <td className={`border border-outline-variant text-center p-2 ${rowIndex === 0 ? '' : 'bg-[#fce5cd]'}`}>{rowIndex === 0 ? 1 : rowIndex}</td>
                {menu.days.map((day, dayIndex) => (
                  <td key={day.date} className="border border-outline-variant p-2 text-center align-middle">
                    {onChange ? (
                      <textarea
                        aria-label={`${row.label}, thứ ${dayIndex + 2}, ${formatDate(day.date)}`}
                        value={day[row.key]}
                        onChange={event => onChange(dayIndex, row.key, event.target.value)}
                        maxLength={300}
                        rows={3}
                        disabled={disabled}
                        placeholder="Nhập tên món"
                        className="w-full min-w-[120px] resize-y rounded border border-outline-variant bg-white/80 px-2 py-1 text-body-sm text-center focus:outline-2 focus:outline-primary disabled:opacity-60"
                      />
                    ) : <span className="whitespace-pre-wrap break-words">{day[row.key] || '—'}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
