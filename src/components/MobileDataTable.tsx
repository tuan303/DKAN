import { useId, useState, type ReactNode } from 'react';

export interface MobileDataRecord {
  id: string | number;
  title: ReactNode;
  subtitle: ReactNode;
  fields: { label: string; value: ReactNode }[];
}

interface MobileDataTableProps {
  label: string;
  records: MobileDataRecord[];
  emptyMessage: string;
  children: ReactNode;
}

/** Bảng gốc và các điều khiển sắp xếp luôn có thể mở lại trên điện thoại. */
export function MobileDataTable({ label, records, emptyMessage, children }: MobileDataTableProps) {
  const [showTable, setShowTable] = useState(false);
  const contentId = useId();

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant bg-surface-container-low px-4 py-2 md:hidden">
        <span className="text-body-sm text-on-surface-variant tabular">{records.length} bản ghi</span>
        <button
          type="button"
          aria-pressed={showTable}
          aria-controls={contentId}
          onClick={() => setShowTable(value => !value)}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-label-md text-primary hover:bg-primary-container/50 transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{showTable ? 'view_agenda' : 'table_rows'}</span>
          {showTable ? 'Xem dạng thẻ' : 'Xem dạng bảng'}
        </button>
      </div>
      <div id={contentId}>
        <div className={showTable ? 'hidden' : 'md:hidden'}>
          {records.length === 0 ? (
            <p className="px-4 py-8 text-center text-body-md text-on-surface-variant">{emptyMessage}</p>
          ) : (
            <ol aria-label={label} className="space-y-3 bg-surface-container-low p-3">
              {records.map((record, index) => (
                <li key={record.id} className="min-w-0 rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
                  <div className="mb-3 flex items-start gap-2.5">
                    <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg bg-primary-container px-1 text-label-sm tabular text-primary" aria-label={`Số thứ tự ${index + 1}`}>{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-label-lg text-on-surface break-words">{record.title}</h3>
                      <div className="mt-1 text-body-sm text-on-surface-variant break-words">{record.subtitle}</div>
                    </div>
                  </div>
                  <dl className="divide-y divide-outline-variant border-t border-outline-variant">
                    {record.fields.map(field => (
                      <div key={field.label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-3 py-2.5 last:pb-0">
                        <dt className="min-w-0 text-body-sm text-on-surface-variant">{field.label}</dt>
                        <dd className="min-w-0 text-right text-body-md font-medium text-on-surface whitespace-pre-wrap break-words">{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className={`${showTable ? '' : 'hidden md:block '}overflow-x-auto [&_table]:min-w-[760px] md:[&_table]:min-w-0`} role="region" aria-label={`${label} dạng bảng`} tabIndex={0}>
          {showTable && <p className="md:hidden border-b border-outline-variant px-4 py-2 text-body-sm text-on-surface-variant">Vuốt ngang để xem các cột. Chạm tiêu đề cột để sắp xếp.</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
