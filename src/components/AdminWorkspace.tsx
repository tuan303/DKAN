import { Link } from 'react-router-dom';
import type { CurrentAccount } from '../lib/useCurrentAccount';

export type AdminTabKey = 'monthly' | 'daily_stats' | 'cancelations' | 'events' | 'blocked' | 'reconcile' | 'settings' | 'menu' | 'survey' | 'logs' | 'admins';

const MENU_GROUPS = [
  { key: 'meals', label: 'Suất ăn', icon: 'lunch_dining', columns: 'sm:grid-cols-3', layout: 'lg:col-span-3' },
  { key: 'nutrition', label: 'Dinh dưỡng', icon: 'restaurant', columns: 'lg:grid-cols-1', layout: 'lg:col-span-1' },
  { key: 'system', label: 'Hệ thống', icon: 'settings', columns: 'sm:grid-cols-3 lg:grid-cols-2', layout: 'lg:col-span-2' },
] as const;

export const ADMIN_TABS: { key: AdminTabKey; label: string; description: string; icon: string; group: typeof MENU_GROUPS[number]['key'] }[] = [
  { key: 'monthly', label: 'Đăng ký tháng', description: 'Danh sách & tổng suất', icon: 'calendar_month', group: 'meals' },
  { key: 'daily_stats', label: 'Danh sách theo ngày', description: 'Suất ăn từng ngày', icon: 'list_alt', group: 'meals' },
  { key: 'cancelations', label: 'Hủy suất ăn', description: 'Theo dõi đăng ký hủy', icon: 'event_busy', group: 'meals' },
  { key: 'reconcile', label: 'Đối soát chấm ăn', description: 'Đăng ký & lượt chấm', icon: 'fact_check', group: 'meals' },
  { key: 'events', label: 'Suất ăn sự kiện', description: 'Đăng ký theo sự kiện', icon: 'celebration', group: 'meals' },
  { key: 'blocked', label: 'Vi phạm suất ăn', description: 'Danh sách bị hạn chế', icon: 'gavel', group: 'meals' },
  { key: 'menu', label: 'Thực đơn tuần', description: 'Nhập & quản lý Excel', icon: 'restaurant_menu', group: 'nutrition' },
  { key: 'survey', label: 'Khảo sát bữa ăn', description: 'Phản hồi & chất lượng', icon: 'rate_review', group: 'nutrition' },
  { key: 'settings', label: 'Cấu hình hệ thống', description: 'Lịch & thời hạn đăng ký', icon: 'settings', group: 'system' },
  { key: 'logs', label: 'Nhật ký đăng nhập', description: 'Lịch sử truy cập', icon: 'history', group: 'system' },
  { key: 'admins', label: 'Tài khoản quản trị', description: 'Phân quyền quản lý', icon: 'admin_panel_settings', group: 'system' },
];

interface AdminWorkspaceProps {
  activeTab: AdminTabKey;
  onTabChange: (tab: AdminTabKey) => void;
  account: CurrentAccount | null;
}

export function AdminWorkspace({ activeTab, onTabChange, account }: AdminWorkspaceProps) {
  const active = ADMIN_TABS.find(tab => tab.key === activeTab) ?? ADMIN_TABS[0];
  const group = MENU_GROUPS.find(item => item.key === active.group);
  return (
    <section aria-labelledby="admin-title" className="min-w-0 space-y-4">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <p className="text-body-sm text-on-surface-variant">Quản trị <span className="px-1 text-outline" aria-hidden="true">/</span> {group?.label}</p>
          <h1 id="admin-title" className="text-headline-md sm:text-headline-lg text-on-surface mt-2">{active.label}</h1>
          <p className="text-body-md text-on-surface-variant mt-2 break-words">
            {account?.fullName ? <>Xin chào <span className="font-semibold text-on-surface">{account.fullName}</span>. </> : null}
            {active.description} trong hệ thống suất ăn nhà trường.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
      <div className="rounded-xl border border-outline-variant bg-surface-container-lowest p-3 md:hidden">
        <label htmlFor="admin-function" className="block text-label-sm text-on-surface-variant mb-2">Chức năng quản trị</label>
        <select id="admin-function" value={activeTab} onChange={event => onTabChange(event.target.value as AdminTabKey)} className="min-h-11 w-full min-w-0 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface">
          {MENU_GROUPS.map(item => <optgroup key={item.key} label={item.label}>
            {ADMIN_TABS.filter(tab => tab.group === item.key).map(tab => <option key={tab.key} value={tab.key}>{tab.label}</option>)}
          </optgroup>)}
        </select>
      </div>
    </section>
  );
}
