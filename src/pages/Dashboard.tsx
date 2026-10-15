import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { Footer } from '../components/Footer';
import { useCurrentAccount, type CurrentAccount } from '../lib/useCurrentAccount';

const QUICK_LINKS = [
  { to: '/schedule', icon: 'calendar_month', label: 'Đăng ký suất ăn', detail: 'Đăng ký tháng và quản lý yêu cầu hủy ăn.', tone: 'bg-primary-container text-primary' },
  { to: '/events', icon: 'event', label: 'Suất ăn sự kiện', detail: 'Xem và đăng ký các sự kiện đang mở.', tone: 'bg-warning-container text-on-warning-container' },
  { to: '/thuc-don', icon: 'restaurant_menu', label: 'Thực đơn hàng tuần', detail: 'Xem thực đơn bữa sáng, bữa trưa trong tuần.', tone: 'bg-tertiary-container text-on-tertiary-container' },
  { to: '/khao-sat', icon: 'rate_review', label: 'Khảo sát bữa ăn', detail: 'Chia sẻ ý kiến để cải thiện chất lượng suất ăn.', tone: 'bg-violet-100 text-violet-700' },
];

export function DashboardView({ account }: { account: CurrentAccount | null }) {
  const today = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
  return (
    <main className="flex-1 min-w-0 w-full max-w-[1440px] mx-auto px-4 py-6 sm:px-6 lg:p-8 space-y-5 md:space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div className="min-w-0">
          <h1 className="text-headline-md md:text-headline-lg text-on-surface">Tổng quan</h1>
          <p className="mt-2 text-body-md text-on-surface-variant break-words">Xin chào {account?.fullName ? <strong className="font-semibold text-on-surface">{account.fullName}</strong> : 'Thầy/Cô'}{account?.department ? <> · {account.department}</> : null}. Chào mừng đến với hệ thống suất ăn.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/schedule" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-label-lg text-on-primary shadow-xs hover:bg-primary-dark"><span className="material-symbols-outlined text-[18px]" aria-hidden="true">add</span>Đăng ký suất ăn</Link>
          <Link to="/cham-an" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary-container px-4 py-2 text-label-lg text-primary hover:bg-primary-container/70"><span className="material-symbols-outlined text-[18px]" aria-hidden="true">fact_check</span>Chấm ăn của tôi</Link>
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-xl bg-primary-container p-4 text-body-md text-on-primary-container">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary" aria-hidden="true"><span className="material-symbols-outlined text-[18px]">today</span></span>
        <p className="self-center"><strong className="font-semibold">{today}.</strong> Thầy/Cô có thể đăng ký suất ăn, xem thực đơn và đối chiếu lượt chấm trong các mục bên dưới.</p>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <section aria-labelledby="dashboard-functions" className="min-w-0 rounded-xl bg-surface-container-lowest p-5 shadow-xs sm:p-6">
          <h2 id="dashboard-functions" className="text-title-md text-on-surface">Dịch vụ suất ăn</h2>
          <p className="mt-1 text-body-sm text-on-surface-variant">Các chức năng dành cho cán bộ, giáo viên và nhân viên.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {QUICK_LINKS.map(link => <Link key={link.to} to={link.to} className="group flex min-w-0 items-start gap-3 rounded-xl border border-outline-variant/70 bg-surface-container-low/50 p-4 transition-colors hover:border-primary/25 hover:bg-primary/5">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${link.tone}`} aria-hidden="true"><span className="material-symbols-outlined text-[22px]">{link.icon}</span></span>
              <span className="min-w-0"><span className="block text-label-lg text-on-surface group-hover:text-primary">{link.label}</span><span className="mt-1 block text-body-sm text-on-surface-variant">{link.detail}</span></span>
            </Link>)}
          </div>
        </section>
        <div className="min-w-0 space-y-4">
          <section aria-labelledby="dashboard-account" className="rounded-xl bg-surface-container-lowest p-5 shadow-xs sm:p-6">
            <div className="flex items-center justify-between gap-2"><h2 id="dashboard-account" className="text-title-md text-on-surface">Tài khoản của tôi</h2><button type="button" onClick={() => window.dispatchEvent(new Event('open-account-modal'))} className="text-label-sm text-primary hover:underline">Chi tiết</button></div>
            <p className="mt-4 text-label-lg text-on-surface break-words">{account?.fullName || 'Đang tải thông tin…'}</p>
            <p className="mt-1 text-body-sm text-on-surface-variant break-all">{account?.email}</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-body-sm"><div className="rounded-lg bg-surface-container p-3"><dt className="text-on-surface-variant">Mã nhân viên</dt><dd className="mt-1 font-semibold break-words">{account?.employeeId || 'Chưa cập nhật'}</dd></div><div className="rounded-lg bg-surface-container p-3"><dt className="text-on-surface-variant">Phòng ban</dt><dd className="mt-1 font-semibold break-words">{account?.department || 'Chưa cập nhật'}</dd></div></dl>
          </section>
          <section className="rounded-xl bg-surface-container-lowest p-5 shadow-xs sm:p-6">
            <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-tertiary-container text-on-tertiary-container" aria-hidden="true"><span className="material-symbols-outlined text-[20px]">fact_check</span></span><h2 className="text-title-md">Lượt chấm ăn của tôi</h2></div>
            <p className="mt-3 text-body-sm text-on-surface-variant">Đối chiếu bữa đã đăng ký với lượt chấm từ máy nhận diện và xem giải thích cho từng trạng thái.</p>
            <Link to="/cham-an" className="mt-4 inline-flex items-center gap-1 text-label-md text-primary">Xem lịch sử chấm ăn<span className="material-symbols-outlined text-[18px]" aria-hidden="true">chevron_right</span></Link>
          </section>
        </div>
      </div>
    </main>
  );
}

export default function Dashboard() {
  const account = useCurrentAccount();
  return <div className="min-h-screen min-w-0 flex flex-col pt-16 pb-24 md:pt-0 md:pb-0 md:pl-64"><Header account={account} /><Navigation /><DashboardView account={account} /><Footer /></div>;
}
