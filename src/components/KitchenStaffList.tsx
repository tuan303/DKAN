import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, runTransaction } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import {
  addManualKitchenIds, kitchenRegistrationConflicts, parseKitchenCodes, readKitchenExcludes,
  removeManualKitchenId, type KitchenExcludes,
} from '../lib/kitchenExcludes';

const EXCLUDES_DOC = 'reconcileExcludes';

/**
 * Quản trị thêm/gỡ tay mã nhân sự Bếp Vina (settings/reconcileExcludes.manualIds).
 *
 * Danh sách theo bộ phận chỉ được ghi khi tải file HAC ở tab Đối soát; người
 * của bếp mang mã 6 chữ số như CBNV mà chưa có trong file đó sẽ bị tính là
 * "chấm nhưng chưa đăng ký". Mọi nơi (agent, web, máy chủ) chỉ đọc employeeIds,
 * nên ghi ở đây có hiệu lực ngay ở lần đồng bộ kế tiếp mà không phải cập nhật agent.
 */
export function KitchenStaffList({ registrations, selectedMonth, showToast }: {
  registrations: { employeeId?: unknown; fullName?: unknown }[];
  selectedMonth: string;
  showToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [list, setList] = useState<KitchenExcludes | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [toRemove, setToRemove] = useState<string | null>(null);

  // Doc nhỏ, chỉ nghe khi đang mở tab Cấu hình (component chỉ hiện ở đó).
  useEffect(() => onSnapshot(
    doc(db, 'settings', EXCLUDES_DOC),
    (snap) => { setList(readKitchenExcludes(snap.exists() ? snap.data() : null)); setLoadError(false); },
    (err) => { console.error('Không đọc được danh sách Bếp Vina:', err); setLoadError(true); },
  ), []);

  const parsed = useMemo(() => parseKitchenCodes(text), [text]);
  const manual = useMemo(() => new Set(list?.manualIds || []), [list]);
  const fresh = parsed.ids.filter(id => !manual.has(id));
  const conflicts = useMemo(() => kitchenRegistrationConflicts(fresh, registrations), [fresh.join(','), registrations]);
  const monthLabel = `${selectedMonth.slice(5)}/${selectedMonth.slice(0, 4)}`;

  const persist = async (update: (current: KitchenExcludes) => KitchenExcludes) => {
    const ref = doc(db, 'settings', EXCLUDES_DOC);
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const before = readKitchenExcludes(snap.exists() ? snap.data() : null);
      const after = update(before);
      tx.set(ref, {
        ...(snap.exists() ? snap.data() : {}),
        ...after,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser?.email || '',
      });
      return { before, after };
    });
  };

  const handleAdd = async () => {
    if (!fresh.length || saving) return;
    setSaving(true);
    try {
      let added: string[] = [];
      await persist(current => {
        const r = addManualKitchenIds(current, fresh);
        added = r.added;
        return r.next;
      });
      setText('');
      showToast(added.length ? `Đã thêm ${added.length} mã vào danh sách Bếp Vina.` : 'Các mã này đã có trong danh sách.', 'success');
    } catch (err: any) {
      console.error('Không lưu được danh sách Bếp Vina:', err);
      showToast(err?.message?.startsWith('Danh sách') ? err.message : 'Không lưu được danh sách Bếp Vina. Thầy/Cô thử lại giúp.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    setSaving(true);
    try {
      let stillFromFile = false;
      await persist(current => {
        const r = removeManualKitchenId(current, id);
        stillFromFile = r.stillFromFile;
        return r.next;
      });
      setToRemove(null);
      showToast(
        stillFromFile
          ? `Đã gỡ ${id} khỏi danh sách thêm tay. Mã này vẫn bị loại vì file HAC xếp vào Bếp Vina.`
          : `Đã gỡ ${id}. Từ lần đồng bộ sau, mã này được đối soát như CBNV.`,
        'success',
      );
    } catch (err) {
      console.error('Không gỡ được mã Bếp Vina:', err);
      showToast('Không gỡ được mã. Thầy/Cô thử lại giúp.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden flex flex-col">
      <div className="p-md border-b border-outline-variant bg-surface-container-low">
        <h2 className="text-headline-sm text-on-surface uppercase">Nhân sự Bếp Vina</h2>
        <p className="font-body-md text-on-surface-variant text-[13px] mt-1">
          Bếp Vina chấm công trên cùng máy nhận diện nên không đưa vào đối soát suất ăn. Mã không đủ 6 chữ số
          được loại tự động. Người của bếp mang mã 6 chữ số như CBNV thì thêm vào đây: họ không bị tính
          "chấm nhưng chưa đăng ký", không nhận email cảnh báo và không vào danh sách khảo sát.
        </p>
      </div>
      <div className="p-md flex flex-col gap-sm">
        {loadError && (
          <p className="text-[12px] px-sm py-1.5 rounded-md bg-error-container text-error">
            Không đọc được danh sách. Thầy/Cô tải lại trang giúp.
          </p>
        )}
        {list && (
          <p className="text-body-sm text-on-surface-variant">
            Từ file HAC (bộ phận Bếp Vina): <strong className="tabular">{list.fileIds.length}</strong> mã ·
            Thêm tay: <strong className="tabular">{list.manualIds.length}</strong> mã. Tải file HAC mới ở tab Đối soát
            chỉ thay phần lấy từ file, mã thêm tay được giữ nguyên.
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-on-surface-variant">Mỗi dòng một người: mã NV, có thể kèm tên (tên không được lưu)</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={'101163: Đỗ Thị Quy\n101740: Lưu Thị Lan'}
            className="w-full min-w-0 bg-surface border border-outline-variant rounded-lg p-2 font-mono text-[13px] focus:ring-1 focus:ring-primary focus:border-primary outline-none"
          />
        </label>

        {text.trim() && (
          <div className="flex flex-col gap-1.5 text-[12px]">
            {fresh.length > 0 && (
              <p className="text-on-surface">Sẽ thêm <strong>{fresh.length}</strong> mã: <span className="tabular">{fresh.join(', ')}</span></p>
            )}
            {parsed.ids.length > fresh.length && (
              <p className="text-on-surface-variant">Đã có trong danh sách thêm tay: {parsed.ids.filter(id => manual.has(id)).join(', ')}</p>
            )}
            {parsed.invalid.length > 0 && (
              <p className="px-sm py-1.5 rounded-md bg-warning-container text-on-warning-container">
                Không đọc được mã ở dòng: {parsed.invalid.slice(0, 5).join(' · ')}{parsed.invalid.length > 5 ? ` và ${parsed.invalid.length - 5} dòng khác` : ''}
              </p>
            )}
            {conflicts.length > 0 && (
              <p className="px-sm py-1.5 rounded-md bg-warning-container text-on-warning-container">
                Có đơn đăng ký ăn tháng {monthLabel}:{' '}
                {conflicts.map(c => `${c.employeeId}${c.fullName ? ` (${c.fullName})` : ''}`).join(', ')}.
                Thêm vào danh sách bếp thì người này không còn được đối soát và không nhận cảnh báo. Thầy/Cô kiểm tra lại mã.
              </p>
            )}
          </div>
        )}

        <button
          onClick={handleAdd}
          disabled={saving || !list || fresh.length === 0}
          className="self-start inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary text-on-primary rounded-lg font-label-md hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <span className={`material-symbols-outlined text-[18px] ${saving ? 'animate-spin' : ''}`}>{saving ? 'progress_activity' : 'add'}</span>
          {saving ? 'Đang lưu...' : fresh.length ? `Thêm ${fresh.length} mã` : 'Thêm'}
        </button>

        {list && (
          list.manualIds.length === 0 ? (
            <p className="text-on-surface-variant text-center italic text-[14px] py-2">Chưa có mã nào thêm tay.</p>
          ) : (
            <div>
              <p className="text-label-md text-on-surface mb-1.5">Đã thêm tay ({list.manualIds.length})</p>
              <ul className="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
                {list.manualIds.map(id => (
                  <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-sm py-2 rounded-lg border bg-surface border-outline-variant">
                    <span className="material-symbols-outlined text-[18px] shrink-0 text-on-surface-variant">badge</span>
                    <span className="flex-1 whitespace-nowrap tabular font-bold">{id}</span>
                    {list.fileIds.includes(id) && (
                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant text-[11px]">Có cả trong file HAC</span>
                    )}
                    {toRemove === id ? (
                      <span className="ml-auto flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleRemove(id)}
                          disabled={saving}
                          className="px-2 py-1 rounded-md text-[12px] bg-error text-on-error hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          Xác nhận gỡ
                        </button>
                        <button
                          onClick={() => setToRemove(null)}
                          className="px-2 py-1 rounded-md text-[12px] bg-surface-variant text-on-surface-variant hover:bg-surface-variant/80 transition-colors"
                        >
                          Hủy
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setToRemove(id)}
                        disabled={saving}
                        title={`Gỡ ${id} khỏi danh sách Bếp Vina`}
                        className="ml-auto shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] text-error hover:bg-error-container disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                        Gỡ
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )
        )}

        {list && list.fileIds.length > 0 && (
          <details>
            <summary className="cursor-pointer text-label-md text-on-surface-variant select-none">
              Mã lấy từ file HAC ({list.fileIds.length})
            </summary>
            <p className="mt-1.5 text-[12px] text-on-surface-variant tabular break-words">{list.fileIds.join(', ')}</p>
          </details>
        )}
      </div>
    </div>
  );
}
