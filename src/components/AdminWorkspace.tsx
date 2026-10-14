import { useEffect, useRef } from 'react';
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
  const accountDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const open = () => { if (accountDialog.current && !accountDialog.current.open) accountDialog.current.showModal(); };
    window.addEventListener('open-account-modal', open);
    return () => window.removeEventListener('open-account-modal', open);
  }, []);
  const active = ADMIN_TABS.find(tab => tab.key === activeTab) ?? ADMIN_TABS[0];
  const today = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

  return (
    <>
      <section aria-labelledby="admin-title" className="grid items-center gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <div className="min-w-0">
          <p className="text-label-sm uppercase tracking-[0.12em] text-on-surface-variant">Ngôi Sao Hoàng Mai <span className="px-1 text-outline" aria-hidden="true">/</span> Quản trị</p>
          <h1 id="admin-title" className="text-headline-md sm:text-headline-lg text-primary mt-2">Trung tâm quản trị suất ăn</h1>
          <p className="text-body-sm sm:text-body-md text-on-surface-variant mt-2 max-w-[68ch]">Quản lý đăng ký, đối soát chấm ăn, thực đơn và chất lượng bữa ăn trong một không gian.</p>
          <p className="inline-flex items-center gap-2 text-body-sm text-on-surface-variant mt-3">
            <span className="material-symbols-outlined text-[16px] text-primary" aria-hidden="true">today</span>
            {today}
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-xs">
          <div className="flex items-center justify-between gap-3">
            <p className="text-label-sm text-on-surface-variant">Tài khoản quản trị</p>
            <span className="inline-flex items-center gap-1 rounded-md bg-primary/5 px-2 py-1 text-label-sm text-primary">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">verified_user</span>
              {account ? (account.isSuperAdmin ? 'Quản trị cao nhất' : 'Quản trị viên') : 'Đang tải…'}
            </span>
          </div>
          <p className="text-label-lg text-on-surface mt-3 break-words">{account?.fullName || 'Tài khoản quản trị'}</p>
          <p className="text-body-sm text-on-surface-variant mt-1 break-all">{account?.email || 'Đang tải thông tin tài khoản…'}</p>
          {account && <p className="flex flex-wrap gap-x-3 gap-y-1 text-body-sm text-on-surface-variant mt-2">
            <span>Phòng ban: <span className="text-on-surface">{account.department || 'Chưa cập nhật'}</span></span>
            <span>Mã NV: <span className="text-on-surface">{account.employeeId || 'Chưa cập nhật'}</span></span>
          </p>}
        </div>
      </section>

      <nav aria-label="Chức năng quản trị" className="rounded-xl border border-outline-variant bg-surface-container-lowest p-3 sm:p-4 shadow-xs min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3 mb-3 border-b border-outline-variant">
          <p className="text-label-lg text-on-surface">Chức năng quản lý</p>
          <p className="text-body-sm text-on-surface-variant">Đang xem: <span className="font-semibold text-primary">{active.label}</span></p>
        </div>
        <div className="grid gap-5 lg:grid-cols-6 lg:gap-4">
          {MENU_GROUPS.map(group => (
            <section key={group.key} aria-labelledby={`admin-group-${group.key}`} className={`min-w-0 ${group.layout}`}>
              <h2 id={`admin-group-${group.key}`} className="flex items-center gap-2 text-label-sm uppercase tracking-wider text-on-surface-variant mb-2">
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{group.icon}</span>
                {group.label}
              </h2>
              <div className={`grid grid-cols-2 gap-2 ${group.columns}`}>
                {ADMIN_TABS.filter(tab => tab.group === group.key).map(tab => {
                  const selected = activeTab === tab.key;
                  return (
                    <button key={tab.key} type="button" aria-pressed={selected} title={tab.description} onClick={() => onTabChange(tab.key)}
                      className={`group flex min-h-14 min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors sm:min-h-[72px] ${tab.key === 'admins' ? 'lg:col-span-2' : ''} ${selected
                        ? 'border-primary bg-primary text-on-primary shadow-sm'
                        : 'border-outline-variant/60 bg-surface-container-low/50 text-on-surface hover:border-primary/25 hover:bg-primary/5'}`}>
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${selected ? 'bg-white/15 text-white' : 'bg-primary/5 text-primary group-hover:bg-primary/10'}`} aria-hidden="true">
                        <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: selected ? "'FILL' 1" : undefined }}>{tab.icon}</span>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-label-md leading-5 break-words">{tab.label}</span>
                        <span className={`mt-0.5 hidden sm:block text-[10px] leading-4 break-words ${selected ? 'text-white/75' : 'text-on-surface-variant'}`}>{tab.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </nav>

      <dialog ref={accountDialog} aria-labelledby="admin-account-title" onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}
        className="m-auto w-[calc(100%-2rem)] max-w-[448px] max-h-[85vh] overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-lowest p-0 text-on-surface shadow-xl backdrop:bg-primary-darker/40 backdrop:backdrop-blur-sm">
        <div className="p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 id="admin-account-title" className="text-headline-sm text-primary">Thông tin tài khoản</h2>
            <button type="button" autoFocus aria-label="Đóng thông tin tài khoản" onClick={() => accountDialog.current?.close()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container hover:bg-surface-container-high">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
            </button>
          </div>
          <dl className="mt-5 divide-y divide-outline-variant text-body-sm">
            {[
              ['Họ tên', account?.fullName || 'Chưa cập nhật'],
              ['Email', account?.email || 'Đang tải…'],
              ['Vai trò', account ? (account.isSuperAdmin ? 'Quản trị cao nhất' : 'Quản trị viên') : 'Đang tải…'],
              ['Phòng ban', account?.department || 'Chưa cập nhật'],
              ['Mã nhân viên', account?.employeeId || 'Chưa cập nhật'],
            ].map(([label, value]) => <div key={label} className="py-3 first:pt-0 last:pb-0">
              <dt className="text-on-surface-variant">{label}</dt>
              <dd className="mt-1 font-semibold break-words [overflow-wrap:anywhere]">{value}</dd>
            </div>)}
          </dl>
        </div>
      </dialog>
    </>
  );
}
