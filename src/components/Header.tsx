import clsx from 'clsx';
import { Link, useLocation } from 'react-router-dom';

export function Header({ userName = "Nguyễn Văn A", initials = "NV" }: { userName?: string, initials?: string }) {
  const location = useLocation();
  const isRegister = location.pathname.startsWith('/register');

  return (
    <header className="fixed top-0 w-full z-50 bg-surface dark:bg-surface-dim border-b border-outline-variant shadow-sm h-16 flex justify-between items-center px-md lg:px-lg">
      <Link to="/dashboard" className="flex items-center gap-sm">
        <span className="material-symbols-outlined text-primary dark:text-primary-fixed" style={{ fontVariationSettings: "'FILL' 1" }}>school</span>
        <span className="font-headline-sm text-headline-sm font-bold text-primary dark:text-primary-fixed">Institution Registration</span>
      </Link>
      
      {!isRegister ? (
        <>
          {/* Desktop User Info */}
          <div className="hidden md:flex items-center gap-md">
            <span className="font-body-md text-body-md text-on-surface">Xin chào, {userName}</span>
            <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container font-label-md text-label-md">
              {initials}
            </div>
          </div>

          {/* Mobile User Info */}
          <div className="md:hidden w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container font-label-md text-label-md">
            {initials}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-sm">
          <div className="w-8 h-8 rounded-full bg-surface-variant flex items-center justify-center text-on-surface-variant">
            <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>person</span>
          </div>
          <span className="hidden md:inline font-body-md text-body-md text-on-surface">Staff Profile</span>
        </div>
      )}
    </header>
  );
}
