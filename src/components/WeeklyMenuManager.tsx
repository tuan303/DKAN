import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import type { WorkBook } from 'xlsx';
import { auth, db } from '../lib/firebase';
import { WeeklyMenuTable } from './WeeklyMenuTable';
import { createEmptyMenu, hasMenuContent, normalizeWeeklyMenu } from '../../agent/lib/weekly-menu.mjs';
import type { MenuKey, WeeklyMenu } from '../../agent/lib/weekly-menu.mjs';
import { shiftDate, surveyWeekLabel, weekStartOf } from '../../agent/lib/survey.mjs';
import { vnToday } from '../../agent/lib/meal-rules.mjs';
import { downloadWeeklyMenuTemplate, importWeeklyMenuSheet, readWeeklyMenuWorkbook } from '../lib/weeklyMenuExcel';

interface WeeklyMenuManagerProps {
  showToast?: (message: string, type: 'success' | 'error') => void;
}

const CONTROL = 'inline-flex min-w-0 items-center justify-center gap-2 min-h-11 rounded-xl border border-outline-variant px-3 py-2 text-label-lg text-primary hover:bg-primary-container/40 disabled:opacity-50 disabled:cursor-not-allowed';

function messageOf(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') return 'Tài khoản chưa có quyền quản lý thực đơn. Vui lòng kiểm tra quyền quản trị.';
  return error instanceof Error ? error.message : 'Có lỗi xảy ra. Vui lòng thử lại.';
}

export function WeeklyMenuManager({ showToast }: WeeklyMenuManagerProps) {
  const [weekId, setWeekId] = useState(() => weekStartOf(vnToday()));
  const [menu, setMenu] = useState<WeeklyMenu>(() => createEmptyMenu(weekId));
  const [savedMenu, setSavedMenu] = useState<WeeklyMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importInvalid, setImportInvalid] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<WorkBook | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [fileName, setFileName] = useState('');
  const [retry, setRetry] = useState(0);
  const selectedWeek = useRef(weekId);
  const mounted = useRef(true);
  const fileRequest = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadId = useId();
  const sheetId = useId();
  const weekInputId = useId();
  const noteId = useId();
  selectedWeek.current = weekId;
  const dirty = menu.weekId === weekId && JSON.stringify(menu) !== JSON.stringify(savedMenu ?? createEmptyMenu(weekId));
  const busy = loading || reading || saving || menu.weekId !== weekId;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; fileRequest.current += 1; };
  }, []);

  useEffect(() => {
    let active = true;
    fileRequest.current += 1;
    setLoading(true);
    setLoadFailed(false);
    setImportInvalid(false);
    setReading(false);
    setError(null);
    setNotice(null);
    setWorkbook(null);
    setFileName('');
    setSheetName('');
    setSavedMenu(null);
    setMenu(createEmptyMenu(weekId));
    void getDoc(doc(db, 'weekly_menus', weekId)).then(snapshot => {
      if (!active || selectedWeek.current !== weekId) return;
      if (snapshot.exists()) {
        const loaded = normalizeWeeklyMenu(snapshot.data(), weekId);
        setSavedMenu(loaded);
        setMenu(loaded);
      }
    }).catch(error => {
      if (active && selectedWeek.current === weekId) {
        setLoadFailed(true);
        setError(`Không tải được thực đơn tuần này. ${messageOf(error)}`);
      }
    }).finally(() => { if (active && selectedWeek.current === weekId) setLoading(false); });
    return () => { active = false; };
  }, [weekId, retry]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const changeWeek = (next: string) => {
    if (!next || busy) return;
    const normalized = weekStartOf(next);
    if (normalized === weekId) return;
    if (dirty && !window.confirm('Thực đơn đang có thay đổi chưa lưu. Chuyển tuần và bỏ các thay đổi này?')) return;
    selectedWeek.current = normalized;
    setWeekId(normalized);
  };

  const applySheet = (nextWorkbook: WorkBook, name: string, targetWeek: string) => {
    const imported = importWeeklyMenuSheet(nextWorkbook, name, targetWeek);
    setMenu(imported);
    setImportInvalid(false);
    setError(null);
    setNotice('Đã đọc thực đơn. Kiểm tra bảng bên dưới rồi bấm “Lưu thực đơn”.');
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || loadFailed) return;
    const targetWeek = weekId;
    const request = ++fileRequest.current;
    setReading(true);
    setImportInvalid(false);
    setError(null);
    setNotice(null);
    setWorkbook(null);
    setFileName('');
    try {
      const loaded = await readWeeklyMenuWorkbook(file);
      if (!mounted.current || request !== fileRequest.current || selectedWeek.current !== targetWeek) return;
      setWorkbook(loaded);
      setFileName(file.name);
      // Prefer a data sheet rather than a cover/instructions sheet. If none
      // matches, keep the selector available so Nutrition can choose one.
      let selected = loaded.SheetNames.find(name => /th[uự]c\s*đ[oơ]n|menu/i.test(name)) ?? loaded.SheetNames[0];
      for (const name of loaded.SheetNames) {
        try { importWeeklyMenuSheet(loaded, name, targetWeek); selected = name; break; } catch { /* Try the next worksheet. */ }
      }
      setSheetName(selected);
      applySheet(loaded, selected, targetWeek);
    } catch (error) {
      if (mounted.current && request === fileRequest.current && selectedWeek.current === targetWeek) {
        setImportInvalid(true);
        setError(messageOf(error));
      }
    } finally {
      if (mounted.current && request === fileRequest.current && selectedWeek.current === targetWeek) setReading(false);
    }
  };

  const editCell = (dayIndex: number, key: MenuKey, value: string) => {
    setMenu(current => ({ ...current, days: current.days.map((day, index) => index === dayIndex ? { ...day, [key]: value } : day) }));
    setNotice(null);
  };

  const save = async () => {
    if (busy || loadFailed || importInvalid || !dirty || menu.weekId !== weekId) return;
    const user = auth.currentUser;
    if (!user) { setError('Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.'); return; }
    if (!hasMenuContent(menu)) { setError('Vui lòng nhập ít nhất một món trước khi lưu thực đơn.'); return; }
    const targetWeek = weekId;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const normalized = normalizeWeeklyMenu(menu, targetWeek);
      await setDoc(doc(db, 'weekly_menus', targetWeek), {
        ...normalized, updatedAt: serverTimestamp(), updatedBy: user.uid, publishedAt: serverTimestamp(),
      });
      if (!mounted.current || selectedWeek.current !== targetWeek) return;
      setMenu(normalized);
      setSavedMenu(normalized);
      const message = `Đã lưu thực đơn tuần ${surveyWeekLabel(targetWeek)}.`;
      setNotice(message);
      showToast?.(message, 'success');
    } catch (error) {
      if (!mounted.current || selectedWeek.current !== targetWeek) return;
      const message = `Không lưu được thực đơn. ${messageOf(error)}`;
      setError(message);
      showToast?.(message, 'error');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <section className="space-y-md">
      <div className="bg-surface-container-lowest rounded-xl border border-outline-variant p-md md:p-lg space-y-md">
        <div>
          <h2 className="text-title-lg text-primary font-bold">Thực đơn hàng tuần</h2>
          <p className="text-body-md text-on-surface-variant mt-1">Nhóm Dinh dưỡng tải mẫu Excel, điền thực đơn và nhập lại lên hệ thống. Thực đơn đã lưu sẽ hiển thị cho CBGV-NV và được đưa vào email khảo sát đúng tuần.</p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor={weekInputId} className="mb-2 block text-label-lg">Tuần bắt đầu</label>
            <div className="flex min-w-0 items-center gap-2">
              <button type="button" className={`${CONTROL} w-11 shrink-0 px-0`} disabled={busy} onClick={() => changeWeek(shiftDate(weekId, -7))} aria-label="Tuần trước"><span className="material-symbols-outlined text-[20px]" aria-hidden="true">chevron_left</span></button>
              <input id={weekInputId} type="date" value={weekId} disabled={busy} onChange={event => changeWeek(event.target.value)} className="min-h-11 min-w-0 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-2 py-2 text-body-md disabled:opacity-50" />
              <button type="button" className={`${CONTROL} w-11 shrink-0 px-0`} disabled={busy} onClick={() => changeWeek(shiftDate(weekId, 7))} aria-label="Tuần sau"><span className="material-symbols-outlined text-[20px]" aria-hidden="true">chevron_right</span></button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-start">
            <span className="text-body-sm text-on-surface-variant">{surveyWeekLabel(weekId)}</span>
            <button type="button" className={`${CONTROL} shrink-0`} disabled={busy} onClick={() => changeWeek(weekStartOf(vnToday()))}>Tuần này</button>
          </div>
        </div>
        <div className="grid grid-cols-1 items-center gap-2 min-[360px]:grid-cols-2 sm:flex sm:flex-wrap sm:gap-3">
          <button type="button" className={CONTROL} disabled={busy} onClick={() => { try { downloadWeeklyMenuTemplate(weekId); } catch (error) { setError(messageOf(error)); } }}><span className="material-symbols-outlined text-[20px]" aria-hidden="true">download</span>Tải mẫu Excel</button>
          <button type="button" disabled={busy || loadFailed} aria-controls={uploadId} className={`${CONTROL} bg-primary text-on-primary hover:bg-primary-dark`} onClick={() => fileInput.current?.click()}><span className="material-symbols-outlined text-[20px]" aria-hidden="true">upload_file</span>{reading ? 'Đang đọc Excel…' : 'Nhập file Excel'}</button>
          <input ref={fileInput} id={uploadId} type="file" accept=".xlsx,.xls" tabIndex={-1} disabled={busy || loadFailed} onChange={event => void importFile(event)} className="sr-only" aria-label="Chọn file thực đơn Excel" />
          <p className="text-body-sm text-on-surface-variant min-[360px]:col-span-2">.xlsx / .xls, tối đa 5 MB</p>
        </div>
        <p className="text-body-sm text-on-surface-variant">Mẫu gồm 5 cột từ thứ 2 đến thứ 6, bữa sáng và 6 nhóm món trưa. Điền tên món vào ô D3:H9, giữ nguyên tiêu đề và ngày. Ô trống dùng cho ngày nghỉ hoặc món không phục vụ.</p>
        {workbook && <div className="flex flex-wrap items-center gap-2 text-body-sm">
          <span className="break-all text-on-surface-variant">{fileName}</span>
          {workbook.SheetNames.length > 1 && <><label htmlFor={sheetId} className="font-semibold">Trang tính</label><select id={sheetId} value={sheetName} disabled={busy} className="border border-outline-variant rounded-lg px-3 py-2 bg-surface-container-lowest" onChange={event => { const name = event.target.value; setSheetName(name); try { applySheet(workbook, name, weekId); } catch (error) { setImportInvalid(true); setError(messageOf(error)); setNotice(null); } }}>{workbook.SheetNames.map(name => <option key={name} value={name}>{name}</option>)}</select></>}
        </div>}
        {error && <div role="alert" className="bg-error-container text-on-error-container border border-error/25 p-3 rounded-lg"><p>{error}</p>{loadFailed && <button type="button" className="underline mt-2 font-semibold" disabled={busy} onClick={() => setRetry(value => value + 1)}>Tải lại thực đơn</button>}</div>}
        {notice && <p role="status" className="bg-primary-container/50 text-on-primary-container border border-primary/15 p-3 rounded-lg">{notice}</p>}
      </div>
      {loading ? <p role="status" className="p-lg text-center text-on-surface-variant">Đang tải thực đơn…</p> : (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant p-md md:p-lg space-y-md">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-md font-bold text-primary">Thực đơn tuần {surveyWeekLabel(weekId)}</h3><span className={`rounded-full px-3 py-1 text-label-md ${dirty ? 'bg-warning-container text-on-warning-container' : savedMenu ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-surface-container text-on-surface-variant'}`}>{dirty ? 'Chưa lưu thay đổi' : savedMenu ? 'Đã lưu' : 'Chưa có thực đơn'}</span></div>
          <WeeklyMenuTable menu={menu} onChange={editCell} disabled={saving || reading || loadFailed || importInvalid} />
          <div><label htmlFor={noteId} className="block text-label-lg mb-2">Ghi chú (không bắt buộc)</label><textarea id={noteId} value={menu.note ?? ''} maxLength={1000} rows={2} disabled={saving || reading || loadFailed || importInvalid} onChange={event => { setMenu(current => ({ ...current, note: event.target.value })); setNotice(null); }} placeholder="Ví dụ: Thực đơn có thể thay đổi theo nguồn thực phẩm." className="w-full rounded-lg border border-outline-variant p-3 text-body-md bg-surface-container-lowest focus:outline-2 focus:outline-primary" /></div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
            {(dirty || importInvalid) && <button type="button" disabled={busy || loadFailed} className={CONTROL} onClick={() => { setMenu(savedMenu ?? createEmptyMenu(weekId)); setWorkbook(null); setFileName(''); setSheetName(''); setImportInvalid(false); setError(null); setNotice(null); }}>Bỏ thay đổi</button>}
            <button type="button" disabled={busy || loadFailed || importInvalid || !dirty || !hasMenuContent(menu)} onClick={() => void save()} className={`${CONTROL} bg-primary text-on-primary hover:bg-primary-dark`}><span className="material-symbols-outlined text-[20px]" aria-hidden="true">save</span>{saving ? 'Đang lưu…' : 'Lưu thực đơn'}</button>
          </div>
        </div>
      )}
    </section>
  );
}
