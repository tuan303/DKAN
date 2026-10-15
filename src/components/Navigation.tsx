import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { isSuperAdmin } from '../lib/adminAccess';
import { useCurrentAccount } from '../lib/useCurrentAccount';
import { ADMIN_MENU_GROUPS, ADMIN_TABS, resolveAdminTab } from '../lib/adminNavigation';
import { SchoolSidebar, type SchoolNavigationGroup, type SchoolNavigationLink } from './SchoolSidebar';

const PERSONAL_LINKS: SchoolNavigationLink[] = [
  { to: '/dashboard', icon: 'space_dashboard', label: 'Tổng quan', tone: 'bg-[#1677e8] text-white' },
  { to: '/schedule', icon: 'calendar_month', label: 'Đăng ký ăn tháng', tone: 'bg-[#ff4050] text-white' },
  { to: '/events', icon: 'event', label: 'Suất ăn sự kiện', tone: 'bg-[#f39a00] text-white' },
  { to: '/cham-an', icon: 'fact_check', label: 'Chấm ăn của tôi', tone: 'bg-[#6554d9] text-white' },
];
const NUTRITION_LINKS: SchoolNavigationLink[] = [
  { to: '/thuc-don', icon: 'restaurant_menu', label: 'Thực đơn tuần', tone: 'bg-[#16a2b8] text-white' },
  { to: '/khao-sat', icon: 'rate_review', label: 'Khảo sát bữa ăn', tone: 'bg-[#249e59] text-white' },
];

export function Navigation({ className, adminMode = false }: { className?: string; adminMode?: boolean }) {
  const location = useLocation();
  const account = useCurrentAccount();
  const [isAdmin, setIsAdmin] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [monthlyStatus, setMonthlyStatus] = useState<Record<string, boolean>>({});
  const [configLoading, setConfigLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const accountDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    let requestVersion = 0;
    const unsubscribe = auth.onAuthStateChanged(user => {
      const version = ++requestVersion;
      const current = () => active && version === requestVersion && auth.currentUser?.uid === user?.uid;
      setIsAdmin(Boolean(user && isSuperAdmin(user.email)));
      setMonthlyStatus({});
      setConfigLoading(Boolean(user));
      if (!user) return;

      if (!isSuperAdmin(user.email) && user.email) {
        const email = user.email.trim().toLowerCase();
        void (async () => {
          try {
            const adminDoc = await getDoc(doc(db, 'admins', email.replace(/[^a-z0-9]/g, '_')));
            if (!current()) return;
            if (adminDoc.exists()) { setIsAdmin(true); return; }
            const admins = await getDocs(collection(db, 'admins'));
            if (!current()) return;
            setIsAdmin(admins.docs.some(snapshot => {
              const value = snapshot.data().email;
              return typeof value === 'string' && value.trim().toLowerCase() === email;
            }));
          } catch (error) {
            if (current()) console.error('Error checking admin status in Navigation:', error);
          }
        })();
      }

      void getDoc(doc(db, 'settings', 'monthlyConfig')).then(snapshot => {
        if (!current()) return;
        if (snapshot.exists()) setMonthlyStatus(Object.fromEntries(Object.entries(snapshot.data()).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')));
      }).catch(error => {
        if (current()) console.error('Error loading registration configuration:', error);
      }).finally(() => {
        if (current()) setConfigLoading(false);
      });
    });
    return () => { active = false; requestVersion++; unsubscribe(); };
  }, []);

  const closeDrawer = () => drawer.current?.close();
  const openAccount = () => {
    drawer.current?.close();
    if (accountDialog.current && !accountDialog.current.open) accountDialog.current.showModal();
  };

  useEffect(() => {
    const handleAccount = () => {
      drawer.current?.close();
      if (accountDialog.current && !accountDialog.current.open) accountDialog.current.showModal();
    };
    const handleNavigation = () => {
      if (drawer.current && !drawer.current.open) { drawer.current.showModal(); setDrawerOpen(true); }
    };
    window.addEventListener('open-account-modal', handleAccount);
    window.addEventListener('open-navigation', handleNavigation);
    return () => {
      window.removeEventListener('open-account-modal', handleAccount);
      window.removeEventListener('open-navigation', handleNavigation);
    };
  }, []);

  useEffect(() => { drawer.current?.close(); }, [location.pathname, location.search]);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await auth.signOut();
      // Reload to discard Firestore listeners which lose access after sign-out.
      window.location.replace('/login');
    } catch (error) {
      console.error('Error signing out:', error);
      setSignOutError('Không đăng xuất được. Vui lòng kiểm tra kết nối mạng rồi thử lại.');
      setSigningOut(false);
      openAccount();
    }
  };

  const groups: SchoolNavigationGroup[] = adminMode ? [
    { key: 'overview', label: 'Không gian quản trị', links: [{ to: '/quantri?tab=overview', icon: 'space_dashboard', label: 'Tổng quan quản trị', description: 'Truy cập nhanh các công việc và toàn bộ chức năng.', tone: 'bg-[#1677e8] text-white' }] },
    ...ADMIN_MENU_GROUPS.map(group => ({
    ...group,
    links: ADMIN_TABS.filter(tab => tab.group === group.key).map(tab => ({ to: `/quantri?tab=${tab.key}`, icon: tab.icon, label: tab.label, description: tab.description, tone: tab.tone })),
  }))] : [
    { key: 'personal', label: 'Cá nhân', links: PERSONAL_LINKS },
    { key: 'nutrition', label: 'Dinh dưỡng', links: NUTRITION_LINKS },
    ...(isAdmin ? [{ key: 'admin', label: 'Quản trị', links: [{ to: '/quantri', label: 'Quản trị suất ăn', icon: 'admin_panel_settings', tone: 'bg-[#d21235] text-white' }] }] : []),
  ];
  const requestedTab = new URLSearchParams(location.search).get('tab');
  const activeHref = adminMode ? `/quantri?tab=${resolveAdminTab(requestedTab)}` : location.pathname;
  const canManage = adminMode || isAdmin;
  const sidebarProps = { groups, activeHref, account, isAdmin: canManage, adminMode, signingOut, onAccountClick: openAccount, onSignOut: handleSignOut };
  const mobileLinks = adminMode ? [
    { to: '/quantri?tab=overview', icon: 'space_dashboard', label: 'Tổng quan' },
    { to: '/quantri?tab=daily_stats', icon: 'list_alt', label: 'Theo ngày' },
    { to: '/quantri?tab=menu', icon: 'restaurant_menu', label: 'Thực đơn' },
  ] : [
    { to: '/schedule', icon: 'calendar_month', label: 'Đăng ký' },
    { to: '/cham-an', icon: 'fact_check', label: 'Chấm ăn' },
    { to: '/thuc-don', icon: 'restaurant_menu', label: 'Thực đơn' },
  ];

  return <>
    {adminMode && <a href="#admin-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-white">Bỏ qua menu, tới nội dung</a>}
    <SchoolSidebar {...sidebarProps} className={clsx('fixed inset-y-0 left-0 z-40 hidden w-64 md:flex', className)} />
    <nav aria-label="Điều hướng trên điện thoại" className="fixed inset-x-0 bottom-0 z-50 grid h-[72px] grid-cols-4 border-t border-outline-variant bg-surface-container-lowest pb-safe shadow-[0_-2px_12px_rgb(0_0_0_/_0.04)] md:hidden">
      {mobileLinks.map(link => {
        const selected = activeHref === link.to;
        return <Link key={link.to} to={link.to} aria-current={selected ? 'page' : undefined} className={clsx('flex min-w-0 flex-col items-center justify-center gap-1 text-[11px] leading-4', selected ? 'font-semibold text-primary' : 'text-on-surface-variant')}>
          <span className={clsx('flex h-8 w-12 items-center justify-center rounded-xl', selected && 'bg-primary/10')} aria-hidden="true"><span className="material-symbols-outlined text-[23px]" style={{ fontVariationSettings: selected ? "'FILL' 1" : undefined }}>{link.icon}</span></span>{link.label}
        </Link>;
      })}
      <button type="button" aria-label={adminMode ? 'Mở tất cả chức năng quản trị' : 'Mở tất cả chức năng'} aria-haspopup="dialog" aria-expanded={drawerOpen} aria-controls="navigation-drawer" onClick={() => { if (drawer.current && !drawer.current.open) drawer.current.showModal(); setDrawerOpen(true); }} className={clsx('flex min-w-0 flex-col items-center justify-center gap-1 text-[11px] leading-4', drawerOpen || (adminMode && !mobileLinks.some(link => link.to === activeHref)) ? 'font-semibold text-primary' : 'text-on-surface-variant')}>
        <span className={clsx('flex h-8 w-12 items-center justify-center rounded-xl', (drawerOpen || (adminMode && !mobileLinks.some(link => link.to === activeHref))) && 'bg-primary/10')} aria-hidden="true"><span className="material-symbols-outlined text-[23px]">apps</span></span>{adminMode ? 'Menu' : 'Tất cả'}
      </button>
    </nav>

    <dialog ref={drawer} id="navigation-drawer" aria-label="Tất cả chức năng" onClose={() => setDrawerOpen(false)} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }} className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-[min(320px,calc(100vw-32px))] max-w-none border-0 bg-surface p-0 text-on-surface shadow-xl backdrop:bg-black/35 backdrop:backdrop-blur-[2px]">
      <button type="button" autoFocus aria-label="Đóng điều hướng" onClick={closeDrawer} className="absolute right-0 top-0 z-10 flex h-11 w-11 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container"><span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span></button>
      <SchoolSidebar {...sidebarProps} visible={drawerOpen} className="border-r-0" onNavigate={closeDrawer} />
    </dialog>

    <dialog ref={accountDialog} aria-labelledby="account-title" onCancel={event => { if (signingOut) event.preventDefault(); }} onClick={event => { if (!signingOut && event.target === event.currentTarget) event.currentTarget.close(); }} className="m-auto max-h-[88dvh] w-[min(440px,calc(100vw-32px))] max-w-none overflow-y-auto rounded-2xl border border-outline-variant bg-surface-container-lowest p-0 text-on-surface shadow-xl backdrop:bg-black/35 backdrop:backdrop-blur-[2px]">
      <div className="flex items-center justify-between gap-4 border-b border-outline-variant px-5 py-4">
        <h2 id="account-title" className="text-headline-sm">Thông tin tài khoản</h2>
        <button type="button" autoFocus disabled={signingOut} aria-label="Đóng thông tin tài khoản" onClick={() => accountDialog.current?.close()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant hover:bg-surface-container-high disabled:opacity-60"><span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span></button>
      </div>
      <div className="space-y-5 p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-amber text-lg font-bold text-on-warning" aria-hidden="true">{account?.initials || <span className="material-symbols-outlined">person</span>}</span>
          <div className="min-w-0"><p className="text-label-lg break-words">{account?.fullName || 'Tài khoản nhân viên'}</p><p className="mt-1 text-body-sm text-on-surface-variant">{account?.isSuperAdmin ? 'Quản trị cao nhất' : canManage ? 'Quản trị viên' : 'Cán bộ, giáo viên, nhân viên'}</p></div>
        </div>
        <dl className="divide-y divide-outline-variant rounded-xl bg-surface-container-low px-4">
          {[
            ['Email', account?.email || 'Chưa cập nhật'],
            ['Mã nhân viên', account?.employeeId || 'Chưa cập nhật'],
            ['Phòng ban', account?.department || 'Chưa cập nhật'],
          ].map(([label, value]) => <div key={label} className="py-3"><dt className="text-body-sm text-on-surface-variant">{label}</dt><dd className="mt-1 break-words text-body-md font-medium [overflow-wrap:anywhere]">{value}</dd></div>)}
        </dl>
        <section aria-labelledby="account-registration-title">
          <h3 id="account-registration-title" className="mb-2 text-label-md text-on-surface">Trạng thái đăng ký theo tháng</h3>
          <div className="space-y-2">
            {Object.entries(monthlyStatus).sort(([a], [b]) => a.localeCompare(b)).map(([month, isOpen]) => <div key={month} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-container-low px-3 py-2.5 text-body-sm"><span>Tháng {month}</span><span className={clsx('rounded-md px-2 py-1 text-[11px] font-semibold', isOpen ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-surface-container text-on-surface-variant')}>{isOpen ? 'Mở đăng ký' : 'Đã khóa'}</span></div>)}
            {Object.keys(monthlyStatus).length === 0 && <p className="rounded-lg bg-surface-container-low p-3 text-body-sm text-on-surface-variant">{configLoading ? 'Đang tải cấu hình…' : 'Chưa có dữ liệu cấu hình tháng.'}</p>}
          </div>
        </section>
        {canManage && <Link to={adminMode ? '/dashboard' : '/quantri'} onClick={() => accountDialog.current?.close()} className="flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary/10 px-3 text-label-md text-primary hover:bg-primary/15"><span className="material-symbols-outlined text-[19px]" aria-hidden="true">{adminMode ? 'arrow_back' : 'admin_panel_settings'}</span>{adminMode ? 'Trang cá nhân' : 'Trang quản trị'}</Link>}
        {signOutError && <p role="alert" className="rounded-lg bg-error-container px-3 py-2 text-body-sm text-on-error-container">{signOutError}</p>}
      </div>
      <div className="flex gap-3 border-t border-outline-variant bg-surface-container-low p-4">
        <button type="button" disabled={signingOut} onClick={() => accountDialog.current?.close()} className="min-h-11 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-label-md hover:bg-surface-container disabled:opacity-60">Đóng</button>
        <button type="button" disabled={signingOut} onClick={handleSignOut} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-error px-3 text-label-md text-on-error hover:bg-error-dark disabled:opacity-60"><span className={clsx('material-symbols-outlined text-[18px]', signingOut && 'animate-spin')} aria-hidden="true">{signingOut ? 'progress_activity' : 'logout'}</span>{signingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>
      </div>
    </dialog>
  </>;
}
