import { Link } from 'react-router-dom';
import { ADMIN_MENU_GROUPS, ADMIN_TABS, type AdminFunctionKey } from '../lib/adminNavigation';

const QUICK_FUNCTIONS: AdminFunctionKey[] = ['daily_stats', 'reconcile', 'menu', 'survey'];

const LINK_FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

/** Administration landing page. Every action opens the existing authorized workflow. */
export function AdminOverview() {
  const today = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());

  return <div className="min-w-0 space-y-6">
    <div className="flex min-w-0 items-start gap-3 rounded-xl bg-primary-container p-4 text-on-primary-container">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary" aria-hidden="true"><span className="material-symbols-outlined text-[20px]">today</span></span>
      <div className="min-w-0">
        <p className="text-label-lg">{today}</p>
        <p className="mt-1 text-body-sm">Theo dõi suất ăn, cập nhật thực đơn và quản lý hoạt động bếp ăn tại một nơi.</p>
      </div>
    </div>

    <section aria-labelledby="admin-quick-actions" className="min-w-0">
      <h2 id="admin-quick-actions" className="text-title-md text-on-surface">Thao tác thường dùng</h2>
      <p className="mt-1 text-body-sm text-on-surface-variant">Mở nhanh các công việc hằng ngày của bộ phận quản trị và dinh dưỡng.</p>
      <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {QUICK_FUNCTIONS.map(key => {
          const tab = ADMIN_TABS.find(item => item.key === key);
          if (!tab) return null;
          return <Link key={key} to={`/quantri?tab=${key}`} className={`group flex min-w-0 flex-col rounded-xl border border-outline-variant bg-surface-container-lowest p-4 shadow-xs transition-colors hover:border-primary/40 hover:bg-primary/5 ${LINK_FOCUS}`}>
            <div className="flex items-center justify-between gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tab.tone}`} aria-hidden="true"><span className="material-symbols-outlined text-[22px]">{tab.icon}</span></span>
              <span className="material-symbols-outlined text-[20px] text-outline group-hover:text-primary" aria-hidden="true">arrow_forward</span>
            </div>
            <span className="mt-4 block text-label-lg text-on-surface group-hover:text-primary">{tab.label}</span>
            <span className="mt-1 block text-body-sm text-on-surface-variant">{tab.description}</span>
          </Link>;
        })}
      </div>
    </section>

    <section aria-labelledby="admin-all-functions" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="admin-all-functions" className="text-title-md text-on-surface">Tất cả chức năng</h2>
          <p className="mt-1 text-body-sm text-on-surface-variant">Các chức năng được sắp xếp theo công việc để dễ tìm và thao tác.</p>
        </div>
      </div>
      <div className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-2">
        {ADMIN_MENU_GROUPS.map(group => {
          const tabs = ADMIN_TABS.filter(tab => tab.group === group.key);
          if (!tabs.length) return null;
          return <section key={group.key} aria-labelledby={`admin-overview-group-${group.key}`} className="min-w-0 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-xs">
            <div className="border-b border-outline-variant px-4 py-4 sm:px-5">
              <h3 id={`admin-overview-group-${group.key}`} className="text-title-md text-on-surface">{group.label}</h3>
              <p className="mt-1 text-body-sm text-on-surface-variant">{group.description}</p>
            </div>
            <div className="divide-y divide-outline-variant/70 px-3 sm:px-4">
              {tabs.map(tab => <Link key={tab.key} to={`/quantri?tab=${tab.key}`} className={`group my-1 flex min-w-0 items-center gap-3 rounded-lg px-1 py-3 transition-colors hover:bg-primary/5 sm:px-2 ${LINK_FOCUS}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tab.tone}`} aria-hidden="true"><span className="material-symbols-outlined text-[19px]">{tab.icon}</span></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label-md text-on-surface group-hover:text-primary">{tab.label}</span>
                  <span className="mt-0.5 block text-body-sm text-on-surface-variant">{tab.description}</span>
                </span>
                <span className="material-symbols-outlined text-[18px] text-outline group-hover:text-primary" aria-hidden="true">chevron_right</span>
              </Link>)}
            </div>
          </section>;
        })}
      </div>
    </section>
  </div>;
}
