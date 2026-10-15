import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { Footer } from '../components/Footer';
import { WeeklyMenuTable } from '../components/WeeklyMenuTable';
import { hasMenuContent, normalizeWeeklyMenu } from '../../agent/lib/weekly-menu.mjs';
import type { WeeklyMenu as WeeklyMenuData } from '../../agent/lib/weekly-menu.mjs';
import { isWeekId, shiftDate, surveyWeekLabel, weekStartOf } from '../../agent/lib/survey.mjs';
import { vnToday } from '../../agent/lib/meal-rules.mjs';

const CONTROL = 'inline-flex shrink-0 items-center justify-center min-h-10 gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-label-lg text-on-surface hover:bg-surface-container transition-colors disabled:opacity-50';

export default function WeeklyMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tuan');
  const validLink = requested === null || isWeekId(requested);
  const weekId = requested && isWeekId(requested) ? requested : weekStartOf(vnToday());
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [menu, setMenu] = useState<WeeklyMenuData | null>(null);
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const selfPath = useRef(location.pathname + location.search);
  selfPath.current = location.pathname + location.search;

  useEffect(() => auth.onAuthStateChanged(current => {
    setUser(current);
    setAuthReady(true);
    if (!current) navigate(`/login?next=${encodeURIComponent(selfPath.current)}`, { replace: true });
  }), [navigate]);

  useEffect(() => {
    if (!user || !validLink) return;
    let active = true;
    setLoading(true);
    setError(null);
    setMenu(null);
    setLoadedWeek(null);
    void getDoc(doc(db, 'weekly_menus', weekId)).then(snapshot => {
      if (!active) return;
      setMenu(snapshot.exists() ? normalizeWeeklyMenu(snapshot.data(), weekId) : null);
      setLoadedWeek(weekId);
    }).catch(error => {
      if (!active) return;
      const denied = error?.code === 'permission-denied';
      setError(denied ? 'Không có quyền đọc thực đơn. Vui lòng đăng nhập lại hoặc liên hệ Nhóm Dinh dưỡng.' : 'Không tải được thực đơn. Vui lòng kiểm tra kết nối mạng và thử lại.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user, weekId, validLink, retry]);

  const changeWeek = (date: string) => {
    if (!date) return;
    const next = new URLSearchParams(params);
    next.set('tuan', weekStartOf(date));
    setParams(next);
  };
  const displayMenu = loadedWeek === weekId ? menu : null;

  return (
    <div className="font-body-lg flex min-h-screen min-w-0 flex-col pt-16 pb-24 md:pt-0 md:pb-0 md:pl-64">
      <Header />
      <Navigation />
      <main className="flex-1 min-w-0 w-full max-w-[1440px] mx-auto py-md md:py-lg px-md md:px-margin lg:px-xl space-y-md md:space-y-lg">
        <div>
          <p className="text-body-sm text-on-surface-variant mb-2">Suất ăn / Dinh dưỡng</p>
          <h1 className="text-headline-md md:text-headline-lg text-on-surface">Thực đơn hàng tuần</h1>
          <p className="text-body-md text-on-surface-variant mt-2">Thực đơn bữa sáng và bữa trưa dành cho CBGV-NV.</p>
        </div>
        <section className="min-w-0 rounded-2xl border border-outline-variant bg-surface-container-lowest p-md md:p-lg space-y-md">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-md pb-md border-b border-outline-variant">
            <div className="min-w-0 flex flex-col gap-2">
              <label htmlFor="menu-week" className="text-label-lg text-on-surface">Tuần bắt đầu</label>
              <div className="flex min-w-0 items-center gap-2">
                <button type="button" className={CONTROL} onClick={() => changeWeek(shiftDate(weekId, -7))} aria-label="Tuần trước"><span className="material-symbols-outlined text-[20px]" aria-hidden="true">chevron_left</span></button>
                <input id="menu-week" type="date" value={weekId} onChange={event => changeWeek(event.target.value)} className="min-h-10 min-w-0 w-full sm:w-44 rounded-lg border border-outline-variant bg-surface-container-lowest px-2 py-2 text-body-md text-on-surface" />
                <button type="button" className={CONTROL} onClick={() => changeWeek(shiftDate(weekId, 7))} aria-label="Tuần sau"><span className="material-symbols-outlined text-[20px]" aria-hidden="true">chevron_right</span></button>
              </div>
            </div>
            <button type="button" className={`${CONTROL} self-start sm:self-auto`} onClick={() => changeWeek(vnToday())}><span className="material-symbols-outlined text-[18px] text-primary" aria-hidden="true">today</span>Tuần này</button>
          </div>
          {!validLink ? <div role="alert" className="rounded-lg p-4 bg-error-container text-on-error-container"><p>Đường dẫn tuần không hợp lệ. Mã tuần phải là ngày thứ 2 theo dạng YYYY-MM-DD.</p><button type="button" onClick={() => changeWeek(vnToday())} className="underline font-semibold mt-2">Xem thực đơn tuần này</button></div> : (
            <>
              <h2 className="text-title-lg font-semibold text-on-surface">Tuần {surveyWeekLabel(weekId)}</h2>
              {!authReady || !user || loading || (!error && loadedWeek !== weekId) ? <p role="status" className="p-lg text-center text-on-surface-variant">Đang tải thực đơn…</p> : error ? <div role="alert" className="rounded-lg p-4 bg-error-container text-on-error-container"><p>{error}</p><button type="button" className="underline font-semibold mt-2" onClick={() => setRetry(value => value + 1)}>Thử lại</button></div> : displayMenu && hasMenuContent(displayMenu) ? <><WeeklyMenuTable menu={displayMenu} />{displayMenu.note && <p className="text-body-md text-on-surface-variant whitespace-pre-wrap break-words"><span className="font-semibold">Ghi chú: </span>{displayMenu.note}</p>}</> : <div className="text-center rounded-lg bg-surface-container-low p-lg"><span className="material-symbols-outlined text-[40px] text-outline mb-2" aria-hidden="true">restaurant_menu</span><p className="text-title-md text-on-surface font-semibold">Tuần này chưa có thực đơn</p><p className="text-body-md text-on-surface-variant mt-1">Nhóm Dinh dưỡng sẽ cập nhật thực đơn trên hệ thống.</p></div>}
            </>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
}
