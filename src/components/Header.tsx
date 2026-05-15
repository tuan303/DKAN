import clsx from 'clsx';
import { Link, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { auth } from '../lib/firebase';

export function Header() {
  const location = useLocation();
  const isRegister = location.pathname.startsWith('/register');
  const [userName, setUserName] = useState("Nguyễn Văn A");
  const [initials, setInitials] = useState("NV");

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user && user.displayName) {
        setUserName(user.displayName);
        
        // Calculate initials from name
        const names = user.displayName.split(' ');
        if (names.length > 1) {
          setInitials(`${names[0][0]}${names[names.length - 1][0]}`.toUpperCase());
        } else {
          setInitials(user.displayName.substring(0, 2).toUpperCase());
        }
      }
    });
    return () => unsubscribe();
  }, []);

  return (
    <header className="fixed top-0 w-full z-50 bg-surface dark:bg-surface-dim border-b border-outline-variant shadow-sm h-16">
      <div className="max-w-[1440px] w-full mx-auto h-full flex justify-between items-center px-4 md:px-8 lg:px-12">
        <Link to="/schedule" className="flex items-center gap-sm shrink-0">
          <span className="material-symbols-outlined text-primary dark:text-primary-fixed" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant</span>
          <span className="font-headline-sm text-headline-sm font-bold text-primary dark:text-primary-fixed uppercase whitespace-nowrap">PHẦN MỀM ĐĂNG KÝ ĂN</span>
        </Link>
        
        {!isRegister ? (
          <>
            {/* Desktop User Info */}
            <div 
              className="hidden md:flex items-center gap-md cursor-pointer group"
              onClick={() => window.dispatchEvent(new Event('open-account-modal'))}
            >
              <span className="font-body-md text-body-md text-on-surface group-hover:text-primary transition-colors whitespace-nowrap">Xin chào, {userName}</span>
              <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container font-bold text-[14px] group-hover:ring-2 group-hover:ring-primary/50 transition-all shadow-sm">
                {initials}
              </div>
            </div>

            {/* Mobile User Info */}
            <div 
              className="md:hidden w-8 h-8 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container font-label-md text-label-md cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all active:scale-95"
              onClick={() => window.dispatchEvent(new Event('open-account-modal'))}
            >
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
      </div>
    </header>
  );
}
