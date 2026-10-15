import { Link, useLocation } from 'react-router-dom';
import { useCurrentAccount, type CurrentAccount } from '../lib/useCurrentAccount';

export function Header({ account }: { account?: CurrentAccount | null } = {}) {
  return account === undefined ? <ConnectedHeader /> : <HeaderContent account={account} />;
}

function ConnectedHeader() {
  const account = useCurrentAccount();
  return <HeaderContent account={account} />;
}

function HeaderContent({ account }: { account: CurrentAccount | null }) {
  const location = useLocation();
  const isRegister = location.pathname.startsWith('/register');
  const isAdmin = location.pathname === '/quantri';
  const accountName = account?.fullName || 'Tài khoản';
  const accountDetail = account?.department || (account?.isSuperAdmin ? 'Quản trị cao nhất' : 'Thông tin tài khoản');

  return (
    <header className={`fixed top-0 inset-x-0 z-50 h-16 bg-surface-container-lowest border-b border-outline-variant ${isRegister ? '' : 'md:hidden'}`}>
      <div className="w-full h-full flex justify-between items-center gap-3 px-4 md:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-2">
        {!isRegister && <button type="button" aria-label="Mở menu chức năng" onClick={() => window.dispatchEvent(new Event('open-navigation'))} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-on-surface hover:bg-surface-container">
          <span className="material-symbols-outlined text-[24px]" aria-hidden="true">menu</span>
        </button>}
        <Link to="/dashboard" aria-label="Suất ăn – Trường Ngôi Sao Hoàng Mai" className="flex min-w-0 items-center gap-2 group rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
          <img
            src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png"
            alt="Trường Ngôi Sao Hoàng Mai"
            className={`h-8 w-auto object-contain shrink-0 ${isRegister ? 'max-w-[180px]' : 'max-w-[116px] sm:max-w-[156px]'}`}
          />
          <span className="hidden sm:block w-px h-7 bg-outline-variant shrink-0" aria-hidden="true" />
          <span className="hidden lg:inline text-base xl:text-lg font-bold text-on-surface whitespace-nowrap group-hover:text-primary transition-colors">
            Đăng ký suất ăn
          </span>
          <span className="hidden sm:inline lg:hidden text-sm font-bold text-primary uppercase whitespace-nowrap">Đăng ký ăn</span>
        </Link>
        </div>
        
        {!isRegister ? (
          <div className="flex shrink-0 items-center gap-2 lg:gap-4">
            {isAdmin && (
              <Link
                to="/schedule"
                aria-label="Trang đăng ký ăn"
                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-primary/15 bg-primary-container/60 px-2.5 lg:px-3 text-on-primary-container text-label-md hover:bg-primary-container transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">arrow_back</span>
                <span className="hidden lg:inline whitespace-nowrap">Trang đăng ký ăn</span>
              </Link>
            )}
            <button
              type="button"
              aria-label={`Mở thông tin tài khoản${account?.fullName ? ` của ${account.fullName}` : ''}`}
              aria-haspopup="dialog"
              onClick={() => window.dispatchEvent(new Event('open-account-modal'))}
              className="group flex min-w-0 items-center gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            >
              <span className="hidden md:flex min-w-0 flex-col max-w-[160px] xl:max-w-[210px]">
                <span title={accountName} className="truncate text-sm font-semibold leading-5 text-on-surface group-hover:text-primary transition-colors">{accountName}</span>
                <span title={accountDetail} className="truncate text-xs leading-5 text-on-surface-variant">{accountDetail}</span>
              </span>
              <span className="flex h-9 w-9 md:h-10 md:w-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary text-sm font-semibold shadow-xs group-hover:ring-2 group-hover:ring-primary/25 group-hover:ring-offset-2 transition-shadow" aria-hidden="true">
                {account?.initials || <span className="material-symbols-outlined text-[20px]">person</span>}
              </span>
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="flex w-9 h-9 rounded-full bg-surface-variant items-center justify-center text-on-surface-variant" aria-hidden="true">
              <span className="material-symbols-outlined">person</span>
            </span>
            <span className="hidden md:inline text-sm text-on-surface">Hồ sơ nhân viên</span>
          </div>
        )}
      </div>
    </header>
  );
}
