import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { formatDate, vnToday } from '../../agent/lib/meal-rules.mjs';
import {
  CANTEENS, MEAL_NAMES, RESIGNATION_REASON, defaultCancelFrom, firstCancelableDate, formatRange, monthEnd,
  planResignationCancel, registeredMeals, resignationCancelDoc, undoOperations, validateResignationInput,
  type Canteen, type ExistingCancel, type ResignationRegistration, type ResignationWrite,
} from '../lib/resignationCancel';

const INPUT = 'w-full min-h-11 rounded-xl border border-outline-variant bg-surface px-3 py-2 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50';
const BUTTON = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-outline-variant px-4 py-2 text-label-lg text-primary hover:bg-primary-container/40 disabled:cursor-not-allowed disabled:opacity-50';
const DANGER = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-error px-4 py-2 text-label-lg text-on-error hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-50';
const MAX_MATCHES = 8;

/** Bỏ dấu, chữ thường — tìm "nguyen thi" ra "Nguyễn Thị". */
const fold = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

type Loaded = { status: 'idle' } | { status: 'loading' } | { status: 'error' }
  | { status: 'ready'; existing: ExistingCancel[]; offDays: string[] };

interface Done {
  registration: ResignationRegistration;
  writes: ResignationWrite[];
  undone: boolean;
}

/**
 * Hộp thoại "Hủy ăn người nghỉ việc" (tab Hủy ăn của trang Quản trị): chọn một người
 * có đơn tháng đang xem, chọn ngày bắt đầu hủy, xem trước các ngày sẽ hủy rồi ghi
 * một lô. Ghi xong có nút Hoàn tác (chỉ trong lúc hộp thoại còn mở).
 */
export function ResignationCancelDialog({ open, onClose, registrations, selectedMonth, showToast }: {
  open: boolean;
  onClose: () => void;
  /** Đơn tháng đang xem (trang Quản trị đọc theo month == selectedMonth; đơn thiếu trường month coi là của tháng đó). */
  registrations: (Omit<ResignationRegistration, 'month'> & { month?: string })[];
  selectedMonth: string;
  showToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [canteen, setCanteen] = useState<Canteen | ''>('');
  const [reason, setReason] = useState(RESIGNATION_REASON);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const today = vnToday();

  const monthRegs = useMemo<ResignationRegistration[]>(
    () => registrations
      .filter(r => (r.month ?? selectedMonth) === selectedMonth && r.userId && registeredMeals(r).length > 0)
      .map(r => ({ ...r, month: selectedMonth })),
    [registrations, selectedMonth],
  );
  const selected = monthRegs.find(r => r.userId === selectedUid) ?? null;

  // Mở lại hộp thoại hay đổi tháng: bắt đầu từ đầu.
  useEffect(() => {
    if (!open) return;
    setSearch(''); setSelectedUid(null); setCanteen(''); setReason(RESIGNATION_REASON);
    setError(null); setDone(null); setLoaded({ status: 'idle' });
  }, [open, selectedMonth]);

  // Chọn người: đọc báo hủy của đúng người đó và danh sách ngày nghỉ (2 lượt đọc nhỏ).
  useEffect(() => {
    if (!open || !selectedUid) return;
    let cancelled = false;
    setLoaded({ status: 'loading' });
    Promise.all([
      getDocs(query(collection(db, 'cancel_registrations'), where('userId', '==', selectedUid))),
      getDoc(doc(db, 'settings', 'mealOffDays')),
    ]).then(([cancels, off]) => {
      if (cancelled) return;
      const dates = off.exists() ? off.data().dates : [];
      setLoaded({
        status: 'ready',
        existing: cancels.docs.map(d => ({ id: d.id, ...d.data() })),
        offDays: Array.isArray(dates) ? dates.filter((d: unknown): d is string => typeof d === 'string') : [],
      });
    }).catch(err => {
      console.error('Không đọc được báo hủy của nhân viên:', err);
      if (!cancelled) setLoaded({ status: 'error' });
    });
    return () => { cancelled = true; };
  }, [open, selectedUid]);

  // Esc đóng hộp thoại (trừ khi đang ghi).
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  const matches = useMemo(() => {
    const q = fold(search);
    if (!q) return [];
    return monthRegs
      .filter(r => [r.fullName, r.employeeId, r.email].some(v => fold(v).includes(q)))
      .slice(0, MAX_MATCHES);
  }, [monthRegs, search]);

  const plan = useMemo(() => (selected && loaded.status === 'ready'
    ? planResignationCancel({ registration: selected, fromDate, offDays: loaded.offDays, existing: loaded.existing, today })
    : null), [selected, loaded, fromDate, today]);

  if (!open) return null;

  const choose = (reg: ResignationRegistration) => {
    setSelectedUid(reg.userId);
    setFromDate(defaultCancelFrom(reg, today));
    setError(null);
  };

  const submit = async () => {
    if (!selected || !plan?.ok || !plan.writes.length || saving) return;
    const problem = validateResignationInput({ canteen, reason });
    if (problem) { setError(problem); return; }
    const user = auth.currentUser;
    if (!user) { setError('Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.'); return; }
    setSaving(true);
    setError(null);
    try {
      const batch = writeBatch(db);
      const batchId = `resign-${selected.userId}-${Date.now()}`;
      const at = new Date().toISOString();
      for (const write of plan.writes) {
        batch.set(doc(db, 'cancel_registrations', write.id), resignationCancelDoc(write, {
          registration: selected, reason, canteen: canteen as Canteen, adminEmail: user.email || '', batchId, at,
        }));
      }
      await batch.commit();
      setDone({ registration: selected, writes: plan.writes, undone: false });
      showToast(`Đã hủy ăn ${plan.writes.length} ngày của ${selected.fullName || selected.employeeId}.`, 'success');
    } catch (err) {
      console.error('Không hủy được suất ăn:', err);
      setError('Chưa lưu được. Không có ngày nào bị hủy; Thầy/Cô thử lại giúp.');
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    if (!done || done.undone || saving) return;
    setSaving(true);
    setError(null);
    try {
      const batch = writeBatch(db);
      for (const op of undoOperations(done.writes)) {
        const ref = doc(db, 'cancel_registrations', op.id);
        if (op.op === 'set') batch.set(ref, op.data); else batch.delete(ref);
      }
      await batch.commit();
      setDone({ ...done, undone: true });
      showToast('Đã hoàn tác: các ngày vừa hủy trở lại như trước.', 'success');
    } catch (err) {
      console.error('Không hoàn tác được:', err);
      setError('Chưa hoàn tác được; Thầy/Cô thử lại giúp.');
    } finally {
      setSaving(false);
    }
  };

  const name = (r: ResignationRegistration) => r.fullName || '(chưa có tên)';
  const monthLabel = `${selectedMonth.slice(5)}/${selectedMonth.slice(0, 4)}`;
  const writeDates = plan?.ok ? plan.writes.map(w => w.date) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="resign-cancel-title"
        className="flex max-h-[92dvh] w-full max-w-[36rem] flex-col overflow-hidden rounded-t-2xl bg-surface-container-lowest shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-outline-variant px-5 py-4">
          <div className="min-w-0">
            <h2 id="resign-cancel-title" className="text-title-md font-semibold text-on-surface">Hủy ăn người nghỉ việc</h2>
            <p className="mt-0.5 text-body-sm text-on-surface-variant">
              Hủy các suất còn lại của tháng {monthLabel} cho nhân viên đã đăng ký ăn cả tháng nhưng nghỉ việc giữa chừng.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Đóng"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high disabled:opacity-50">
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {done ? (
            <div role="status" className={`rounded-xl px-4 py-3 text-body-md ${done.undone ? 'bg-surface-container text-on-surface' : 'bg-green-50 text-green-900'}`}>
              {done.undone
                ? <>Đã hoàn tác. Suất ăn của <strong>{name(done.registration)}</strong> trở lại như trước khi hủy.</>
                : <>Đã hủy <strong>{done.writes.length} ngày</strong> ăn của <strong>{name(done.registration)}</strong>
                  {' '}({formatRange(done.writes.map(w => w.date))}). Agent không gửi cảnh báo thiếu chấm cho các ngày này;
                  tab Đối soát và trang Chấm ăn của tôi ghi là đã hủy.</>}
            </div>
          ) : (
            <>
              {!selected ? (
                <div className="space-y-1.5">
                  <label htmlFor="resign-cancel-search" className="block text-label-md text-on-surface">Nhân viên có đơn tháng {monthLabel}</label>
                  <input id="resign-cancel-search" type="search" value={search} onChange={event => setSearch(event.target.value)} autoFocus
                    placeholder="Tìm theo họ tên, mã NV hoặc email" className={INPUT} />
                  {search.trim() && (
                    matches.length ? (
                      <ul className="mt-2 divide-y divide-outline-variant overflow-hidden rounded-xl border border-outline-variant">
                        {matches.map(r => (
                          <li key={r.userId}>
                            <button type="button" onClick={() => choose(r)}
                              className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-surface-container-high">
                              <span className="min-w-0">
                                <span className="block truncate text-body-md text-on-surface">{name(r)}</span>
                                <span className="block truncate text-body-sm text-on-surface-variant">{r.employeeId} · {r.email}</span>
                              </span>
                              <span className="shrink-0 text-body-sm text-on-surface-variant">{MEAL_NAMES[registeredMeals(r).length === 2 ? 'both' : registeredMeals(r)[0]]}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="text-body-sm text-on-surface-variant">Không tìm thấy ai có đơn đăng ký ăn tháng {monthLabel}.</p>
                  )}
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-body-md font-semibold text-on-surface">{name(selected)}</p>
                    <p className="text-body-sm text-on-surface-variant break-all">{selected.employeeId} · {selected.email}</p>
                    <p className="text-body-sm text-on-surface-variant">
                      Đơn tháng {monthLabel}: {MEAL_NAMES[registeredMeals(selected).length === 2 ? 'both' : registeredMeals(selected)[0]]}
                      {' '}· từ {formatDate(firstCancelableDate(selected))}
                    </p>
                  </div>
                  <button type="button" className={`${BUTTON} shrink-0 whitespace-nowrap`} disabled={saving} onClick={() => { setSelectedUid(null); setLoaded({ status: 'idle' }); }}>
                    Đổi người
                  </button>
                </div>
              )}

              {selected && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block space-y-1.5">
                      <span className="text-label-md text-on-surface">Hủy từ ngày (tới hết tháng)</span>
                      <input type="date" value={fromDate} min={firstCancelableDate(selected)} max={monthEnd(selected.month)}
                        onChange={event => setFromDate(event.target.value)} className={INPUT} />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-label-md text-on-surface">Nhà ăn</span>
                      <select value={canteen} onChange={event => setCanteen(event.target.value as Canteen | '')} className={INPUT}>
                        <option value="">-- Chọn nhà ăn --</option>
                        {Object.entries(CANTEENS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="block space-y-1.5">
                    <span className="text-label-md text-on-surface">Lý do</span>
                    <input type="text" value={reason} maxLength={200} onChange={event => setReason(event.target.value)} className={INPUT} />
                  </label>

                  {loaded.status === 'loading' && <p className="text-body-sm text-on-surface-variant">Đang đọc các lần báo hủy của nhân viên…</p>}
                  {loaded.status === 'error' && (
                    <p role="alert" className="rounded-lg bg-error-container/60 px-3 py-2 text-body-sm text-error">
                      Chưa đọc được các lần báo hủy của nhân viên này, nên chưa thể hủy. Thầy/Cô đóng rồi mở lại hộp thoại.
                    </p>
                  )}
                  {plan && !plan.ok && <p role="alert" className="rounded-lg bg-error-container/60 px-3 py-2 text-body-sm text-error">{plan.error}</p>}
                  {plan?.ok && (
                    <div className="space-y-2 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 text-body-sm text-on-surface">
                      {plan.writes.length ? (
                        <p>
                          Sẽ hủy <strong>{MEAL_NAMES[plan.cancelMeal]}</strong> của <strong>{plan.writes.length} ngày</strong> có
                          {' '}suất ăn, {formatRange(writeDates)}:
                        </p>
                      ) : <p>Không còn ngày nào cần hủy từ {formatDate(plan.start)} tới hết tháng.</p>}
                      {plan.writes.length > 0 && (
                        <ul className="flex flex-wrap gap-1.5" aria-label="Các ngày sẽ hủy">
                          {writeDates.map(date => (
                            <li key={date} className="rounded-full bg-surface-container px-2 py-0.5 tabular text-on-surface-variant">
                              {date.slice(8, 10)}/{date.slice(5, 7)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {plan.skipped.length > 0 && (
                        <p className="text-on-surface-variant">Bỏ qua {plan.skipped.length} ngày đã báo hủy từ trước.</p>
                      )}
                      {plan.pastDates.length > 0 && (
                        <p className="rounded-lg bg-warning-container/70 px-3 py-2 text-on-warning-container">
                          Có {plan.pastDates.length} ngày đã qua. Đối soát sẽ tính các ngày này là đã hủy; email cảnh báo đã gửi
                          trước đó không thu hồi được.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {error && <p role="alert" className="rounded-lg bg-error-container/60 px-3 py-2 text-body-sm text-error">{error}</p>}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-outline-variant px-5 py-4 sm:flex-row sm:justify-end">
          {done ? (
            <>
              {!done.undone && (
                <button type="button" className={BUTTON} disabled={saving} onClick={() => { void undo(); }}>
                  <span className="material-symbols-outlined text-[20px]" aria-hidden="true">undo</span>
                  {saving ? 'Đang hoàn tác…' : 'Hoàn tác'}
                </button>
              )}
              <button type="button" className={BUTTON} disabled={saving} onClick={onClose}>Đóng</button>
            </>
          ) : (
            <>
              <button type="button" className={BUTTON} disabled={saving} onClick={onClose}>Đóng</button>
              <button type="button" className={DANGER} disabled={saving || !plan?.ok || !plan.writes.length}
                onClick={() => { void submit(); }}>
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">event_busy</span>
                {saving ? 'Đang lưu…' : plan?.ok && plan.writes.length ? `Hủy ăn ${plan.writes.length} ngày` : 'Hủy ăn'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
