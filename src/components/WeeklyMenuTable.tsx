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
  const initialDay = Math.max(0, menu.days.findIndex(day => day.date === today));
  return (
    <div className="min-w-0">
      <div className="md:hidden space-y-3" aria-label={`Thực đơn tuần ${surveyWeekLabel(menu.weekId)}`}>
        <p className="text-body-sm text-on-surface-variant">Chạm vào từng ngày để xem thực đơn.</p>
        {menu.days.map((day, index) => {
          const isToday = day.date === today;
          return (
            <details key={`${menu.weekId}-${day.date}`} open={index === initialDay} className={`group rounded-2xl border bg-surface-container-lowest overflow-hidden ${isToday ? 'border-primary/40 shadow-sm' : 'border-outline-variant'}`}>
              <summary className={`flex min-h-[76px] cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden ${isToday ? 'bg-primary-container/45' : 'bg-surface-container-low/70'}`}>
                <span className="flex min-w-0 items-center gap-3">
                  <span className={`flex h-12 w-11 shrink-0 flex-col items-center justify-center rounded-xl ${isToday ? 'bg-brand-navy text-white' : 'border border-outline-variant bg-white text-brand-navy'}`} aria-hidden="true">
                    <span className="text-[21px] leading-none font-bold tabular">{day.date.slice(8, 10)}</span>
                    <span className={`mt-1 text-[10px] leading-none ${isToday ? 'text-white/80' : 'text-on-surface-variant'}`}>THÁNG {Number(day.date.slice(5, 7))}</span>
                  </span>
                  <span className="min-w-0 flex flex-col gap-1">
                    <span className="text-label-lg text-brand-navy">Thứ {index + 2}{isToday && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">Hôm nay</span>}</span>
                    <span className="text-body-sm tabular text-on-surface-variant">{formatDate(day.date)}</span>
                  </span>
                </span>
                <span className="material-symbols-outlined text-[20px] text-on-surface-variant transition-transform group-open:rotate-180" aria-hidden="true">expand_more</span>
              </summary>
              <div className="border-t border-outline-variant px-4 pb-4 pt-3">
                <div className="rounded-xl border border-brand-amber/20 bg-brand-cream/45 p-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-label-md text-on-warning-container"><span className="material-symbols-outlined text-[18px]" aria-hidden="true">wb_sunny</span>Bữa sáng</p>
                  <p className="text-body-md font-medium text-on-surface whitespace-pre-wrap break-words">{day.breakfast || '—'}</p>
                </div>
                <h3 className="mt-4 mb-3 flex items-center gap-1.5 text-label-md text-brand-navy"><span className="material-symbols-outlined text-[18px]" aria-hidden="true">restaurant</span>Bữa trưa</h3>
                <dl className="divide-y divide-outline-variant">
                  {MENU_ROWS.slice(1).map(row => (
                    <div key={row.key} className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 py-2.5 first:pt-0 last:pb-0">
                      <dt className="text-body-sm text-on-surface-variant">{dishLabel(row.label)}</dt>
                      <dd className={`min-w-0 text-body-md text-on-surface whitespace-pre-wrap break-words ${row.key === 'main' ? 'font-semibold' : ''}`}>{day[row.key] || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </details>
          );
        })}
      </div>
      <div className="hidden md:block overflow-x-auto rounded-2xl border border-outline-variant bg-white focus-visible:outline-2 focus-visible:outline-primary" tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="w-full min-w-[860px] table-fixed border-collapse text-[13px] leading-6 text-on-surface">
          <caption id={captionId} className="sr-only">Thực đơn tuần {surveyWeekLabel(menu.weekId)}</caption>
          <colgroup><col className="w-[145px]" />{menu.days.map(day => <col key={day.date} />)}</colgroup>
          <thead>
            <tr className="border-b border-outline-variant">
              <th scope="col" className="bg-surface-container-low p-4 text-left align-middle text-label-md text-on-surface-variant">Bữa ăn<br /><span className="text-body-sm font-normal">& nhóm món</span></th>
              {menu.days.map((day, index) => {
                const isToday = day.date === today;
                return (
                  <th key={day.date} scope="col" className={`p-4 text-left align-top ${isToday ? 'bg-brand-navy text-white' : 'bg-surface-container-low text-brand-navy'}`}>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-lg">Thứ {index + 2}{isToday && <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] leading-4 font-medium">Hôm nay</span>}</span>
                    <span className={`mt-1 block text-body-sm font-normal tabular ${isToday ? 'text-white/80' : 'text-on-surface-variant'}`}>{formatDate(day.date)}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {MENU_ROWS.map((row, rowIndex) => (
              <tr key={row.key} className={`border-b last:border-b-0 border-outline-variant ${rowIndex === 0 ? 'bg-brand-cream/30' : 'bg-white'}`}>
                <th scope="row" className={`p-4 text-left align-top ${rowIndex === 0 ? 'text-on-warning-container' : 'text-brand-navy'}`}>
                  {rowIndex === 0 ? <span className="flex items-center gap-2 text-label-md"><span className="material-symbols-outlined text-[19px]" aria-hidden="true">wb_sunny</span>Bữa sáng</span> : <>
                    {rowIndex === 1 && <span className="mb-1 block text-[10px] leading-4 tracking-wider uppercase font-medium text-primary">Bữa trưa</span>}
                    <span className={rowIndex === 1 ? 'text-label-md' : 'text-body-sm font-medium text-on-surface-variant'}>{dishLabel(row.label)}</span>
                  </>}
                </th>
                {menu.days.map(day => (
                  <td key={day.date} className={`p-4 align-top whitespace-pre-wrap break-words ${day.date === today ? 'bg-primary/[0.045] border-x border-primary/10' : ''} ${rowIndex <= 1 ? 'font-medium' : ''}`}>{day[row.key] || <span className="text-outline">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
