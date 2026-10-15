import { useId } from 'react';
import { MENU_ROWS } from '../../agent/lib/weekly-menu.mjs';
import type { MenuKey, WeeklyMenu } from '../../agent/lib/weekly-menu.mjs';
import { formatDate, vnToday } from '../../agent/lib/meal-rules.mjs';
import { surveyWeekLabel } from '../../agent/lib/survey.mjs';

interface WeeklyMenuTableProps {
  menu: WeeklyMenu;
  onChange?: (dayIndex: number, key: MenuKey, value: string) => void;
  disabled?: boolean;
}

const dishLabel = (label: string) => label.charAt(0) + label.slice(1).toLocaleLowerCase('vi');

function WeeklyMenuReader({ menu, captionId }: { menu: WeeklyMenu; captionId: string }) {
  const today = vnToday();
  return (
    <section className="min-w-0" aria-labelledby={captionId}>
      <h2 id={captionId} className="sr-only">Thực đơn tuần {surveyWeekLabel(menu.weekId)}</h2>
      <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {menu.days.map((day, index) => {
          const isToday = day.date === today;
          return (
            <article key={day.date} aria-label={`Thực đơn thứ ${index + 2}, ${formatDate(day.date)}`} className={`min-w-0 overflow-hidden rounded-2xl border bg-white shadow-sm ${isToday ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-slate-200/80'}`}>
              <header className="bg-[#6366f1] px-4 py-4 text-center text-white">
                <h3 className="text-[19px] leading-7 font-bold">Thứ {index + 2}</h3>
                <p className="mt-0.5 text-[13px] leading-5 tabular text-indigo-100">{formatDate(day.date)}</p>
                {isToday && <span className="mt-2 inline-flex rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] leading-4 font-semibold">Hôm nay</span>}
              </header>
              <div className="p-4">
                <section className="mb-4 border-b border-slate-100 pb-4" aria-label="Bữa sáng">
                  <h4 className="mb-2 flex items-center gap-2 text-[14px] leading-5 font-bold text-amber-700">
                    <span className="material-symbols-outlined shrink-0 text-[19px]" aria-hidden="true">wb_sunny</span>Bữa sáng
                  </h4>
                  <p className="min-w-0 pl-[27px] text-[14px] leading-[22px] text-slate-700 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{day.breakfast || '—'}</p>
                </section>
                <section aria-label="Bữa trưa">
                  <h4 className="mb-3 flex items-center gap-2 text-[14px] leading-5 font-bold text-emerald-700">
                    <span className="material-symbols-outlined shrink-0 text-[19px]" aria-hidden="true">restaurant</span>Bữa trưa
                  </h4>
                  <dl className="space-y-3 text-[13px] leading-[21px] text-slate-700">
                    {MENU_ROWS.slice(1).map(row => (
                      <div key={row.key} className="min-w-0 [overflow-wrap:anywhere]">
                        <dt className="inline font-semibold text-slate-900">{dishLabel(row.label)}: </dt>
                        <dd className="inline whitespace-pre-wrap break-words">{day[row.key] || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function WeeklyMenuTable({ menu, onChange, disabled = false }: WeeklyMenuTableProps) {
  const captionId = useId();
  if (!onChange) return <WeeklyMenuReader menu={menu} captionId={captionId} />;
  return (
    <div className="min-w-0">
      <p className="md:hidden text-body-sm text-on-surface-variant mb-2">Vuốt ngang trong bảng để nhập đủ thực đơn từ thứ 2 đến thứ 6.</p>
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
