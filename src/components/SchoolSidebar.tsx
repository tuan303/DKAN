import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import type { CurrentAccount } from '../lib/useCurrentAccount';
import { matchesMenuSearch } from '../lib/adminNavigation';

export type SchoolNavigationLink = { to: string; label: string; icon: string; tone: string; description?: string };
export type SchoolNavigationGroup = { key: string; label: string; links: SchoolNavigationLink[] };

export function SchoolBrand({ onNavigate }: { onNavigate?: () => void }) {
  return <Link to="/dashboard" onClick={onNavigate} aria-label="Suất ăn – Trường Ngôi Sao Hoàng Mai" className="flex min-w-0 items-center gap-2.5 rounded-lg">
    <span className="block h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-white" aria-hidden="true"><img src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png" alt="" className="h-9 w-auto max-w-none" /></span>
    <span className="min-w-0"><span className="block text-[17px] font-bold leading-6 text-on-surface">Suất ăn</span><span className="block text-[10px] leading-4 text-on-surface-variant">Trường Ngôi Sao Hoàng Mai</span></span>
  </Link>;
}

type SchoolSidebarProps = {
  groups: SchoolNavigationGroup[];
  activeHref: string;
  account: CurrentAccount | null;
  isAdmin?: boolean;
  adminMode?: boolean;
  className?: string;
  signingOut?: boolean;
  visible?: boolean;
  onNavigate?: () => void;
  onAccountClick: () => void;
  onSignOut: () => void;
};

/** Presentational shell; permissions and profile reads belong to Navigation. */
export function SchoolSidebar({ groups, activeHref, account, isAdmin, adminMode, className, signingOut, visible = true, onNavigate, onAccountClick, onSignOut }: SchoolSidebarProps) {
  const idPrefix = useId();
  const [search, setSearch] = useState('');
  const nav = useRef<HTMLElement>(null);
  const filteredGroups = groups.map(group => ({ ...group, links: group.links.filter(link => matchesMenuSearch(search, group.label, link.label, link.description ?? '')) })).filter(group => group.links.length > 0);
  const resultCount = filteredGroups.reduce((sum, group) => sum + group.links.length, 0);

  useEffect(() => { setSearch(''); }, [activeHref]);
  useEffect(() => {
    if (!visible) return;
    if (search) nav.current?.scrollTo({ top: 0 });
    else nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeHref, search, visible]);

  return <aside className={clsx('flex h-full min-h-0 flex-col border-r border-outline-variant bg-surface', className)}>
    <div className="shrink-0 px-4 pb-3 pt-5"><SchoolBrand onNavigate={onNavigate} /></div>
    {isAdmin && <div className="shrink-0 px-3 pb-3">
      <nav aria-label="Chuyển không gian làm việc" className="grid grid-cols-2 gap-1 rounded-xl border border-outline-variant bg-surface-container p-1 text-[12px] font-semibold">
        {[{ to: '/dashboard', label: 'Cá nhân', icon: 'person', selected: !adminMode }, { to: '/quantri', label: 'Quản trị', icon: 'admin_panel_settings', selected: adminMode }].map(item => <Link key={item.to} to={item.to} onClick={onNavigate} aria-current={item.selected ? 'true' : undefined} className={clsx('flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 md:min-h-9', item.selected ? 'bg-surface-container-lowest text-primary shadow-xs' : 'text-on-surface-variant hover:bg-surface-container-lowest/60')}><span className="material-symbols-outlined text-[17px]" aria-hidden="true">{item.icon}</span>{item.label}</Link>)}
      </nav>
    </div>}
    {adminMode && <div role="search" aria-label="Tìm chức năng quản trị" className="shrink-0 px-3 pb-3">
      <label htmlFor={`${idPrefix}-search`} className="sr-only">Tìm chức năng quản trị</label>
      <div className="relative flex items-center">
        <span className="material-symbols-outlined pointer-events-none absolute left-2.5 text-[19px] text-on-surface-variant" aria-hidden="true">search</span>
        <input id={`${idPrefix}-search`} type="search" autoComplete="off" value={search} onChange={event => setSearch(event.target.value)} placeholder="Tìm chức năng…" className="min-h-10 w-full min-w-0 rounded-lg border border-outline-variant bg-surface-container-lowest py-2 pl-9 pr-11 text-[13px] md:pr-9 [&::-webkit-search-cancel-button]:appearance-none" />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Xóa tìm kiếm chức năng" className="absolute right-0 flex h-11 w-11 items-center justify-center rounded-lg text-on-surface-variant hover:text-primary md:h-10 md:w-9"><span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span></button>}
      </div>
      {search && <p role="status" className="mt-2 px-1 text-[11px] text-on-surface-variant">{resultCount ? `${resultCount} chức năng phù hợp` : 'Không tìm thấy chức năng.'}</p>}
    </div>}
    <nav ref={nav} aria-label={adminMode ? 'Chức năng quản trị' : 'Điều hướng chính'} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-5 [scrollbar-gutter:stable]">
      <div className="space-y-4">{filteredGroups.map(group => <section key={group.key} aria-labelledby={`${idPrefix}-${group.key}`}>
        <h2 id={`${idPrefix}-${group.key}`} className="mb-1.5 px-2 text-[11px] font-semibold leading-4 text-on-surface-variant">{group.label}</h2>
        <div className="space-y-1">{group.links.map(link => {
          const selected = activeHref === link.to;
          return <Link key={link.to} to={link.to} onClick={onNavigate} title={link.description} aria-current={selected ? 'page' : undefined} className={clsx('flex min-h-12 min-w-0 items-center gap-2.5 rounded-[10px] px-2 py-2 text-[14px] leading-5 transition-colors md:min-h-11 md:text-[13px]', selected ? 'bg-primary font-semibold text-white shadow-xs' : 'text-on-surface hover:bg-surface-container')}>
            <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', selected ? 'bg-white/15 text-white' : link.tone)} aria-hidden="true"><span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: selected ? "'FILL' 1" : undefined }}>{link.icon}</span></span>
            <span className="min-w-0 break-words">{link.label}</span>
          </Link>;
        })}</div>
      </section>)}</div>
    </nav>
    <div className="shrink-0 border-t border-outline-variant px-3 py-3">
      <button type="button" onClick={onAccountClick} aria-haspopup="dialog" aria-label="Mở thông tin tài khoản" className="flex w-full min-w-0 items-center gap-2.5 rounded-lg p-1 text-left hover:bg-surface-container">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-amber text-[13px] font-bold text-on-warning" aria-hidden="true">{account?.initials || <span className="material-symbols-outlined text-[20px]">person</span>}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold leading-5 text-on-surface" title={account?.fullName}>{account?.fullName || 'Tài khoản của tôi'}</span><span className="block truncate text-[11px] leading-4 text-on-surface-variant" title={account?.department}>{account?.department || (account?.isSuperAdmin ? 'Quản trị cao nhất' : isAdmin ? 'Quản trị viên' : 'Thông tin tài khoản')}</span></span>
        <span className="material-symbols-outlined shrink-0 text-[17px] text-on-surface-variant" aria-hidden="true">unfold_more</span>
      </button>
      <button type="button" onClick={onSignOut} disabled={signingOut} className="mt-1.5 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg text-[12px] font-medium text-on-surface-variant hover:bg-error/5 hover:text-error disabled:opacity-60 md:min-h-8 md:text-[11px]"><span className={clsx('material-symbols-outlined text-[16px]', signingOut && 'animate-spin')} aria-hidden="true">{signingOut ? 'progress_activity' : 'logout'}</span>{signingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button>
    </div>
  </aside>;
}
