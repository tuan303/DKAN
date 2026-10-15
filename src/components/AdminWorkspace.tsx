import { Link } from 'react-router-dom';
import type { CurrentAccount } from '../lib/useCurrentAccount';
import { ADMIN_MENU_GROUPS, ADMIN_TABS, type AdminTabKey } from '../lib/adminNavigation';

interface AdminWorkspaceProps {
  activeTab: AdminTabKey;
  onTabChange: (tab: AdminTabKey) => void;
  account: CurrentAccount | null;
}

export function AdminWorkspace({ activeTab, onTabChange, account }: AdminWorkspaceProps) {
  const active = ADMIN_TABS.find(tab => tab.key === activeTab);
  const group = ADMIN_MENU_GROUPS.find(item => item.key === active?.group);
  return (
    <section aria-labelledby="admin-title" className="min-w-0 space-y-4">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <p className="text-body-sm text-on-surface-variant"><Link to="/quantri" className="hover:text-primary hover:underline">Quản trị</Link> <span className="px-1 text-outline" aria-hidden="true">/</span> {group?.label ?? 'Tổng quan'}</p>
          <h1 id="admin-title" className="text-headline-md sm:text-headline-lg text-on-surface mt-2">{active?.label ?? 'Tổng quan quản trị'}</h1>
          <p className="text-body-md text-on-surface-variant mt-2 break-words hidden sm:block">
            {active ? active.description : <>{account?.fullName ? <>Xin chào <span className="font-semibold text-on-surface">{account.fullName}</span>. </> : null}Chọn công việc cần xử lý trong hệ thống suất ăn nhà trường.</>}
          </p>
        </div>
        <div className="hidden flex-wrap items-center gap-2 sm:flex">
          {account && <span className="inline-flex items-center gap-1.5 rounded-lg bg-primary-container px-3 py-2 text-label-sm text-on-primary-container">
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">verified_user</span>
            {account.isSuperAdmin ? 'Quản trị cao nhất' : 'Quản trị viên'}
          </span>}
          <Link to="/schedule" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-label-md text-on-surface hover:bg-surface-container">
            <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden="true">arrow_back</span>
            Trang đăng ký ăn
          </Link>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-2 md:hidden">
        <span className="material-symbols-outlined ml-1 shrink-0 text-[20px] text-primary" aria-hidden="true">apps</span>
        <label htmlFor="admin-function" className="sr-only">Chức năng quản trị</label>
        <select id="admin-function" value={activeTab} onChange={event => onTabChange(event.target.value as AdminTabKey)} className="min-h-11 w-full min-w-0 rounded-lg bg-surface-container-lowest pl-1 pr-2 text-body-md text-on-surface">
          <option value="overview">Tổng quan quản trị</option>
          {ADMIN_MENU_GROUPS.map(item => <optgroup key={item.key} label={item.label}>
            {ADMIN_TABS.filter(tab => tab.group === item.key).map(tab => <option key={tab.key} value={tab.key}>{tab.label}</option>)}
          </optgroup>)}
        </select>
      </div>
    </section>
  );
}
