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
    // inset-x-0: thiếu left-0 thì header fixed lấy vị trí tĩnh, bị đẩy sang
    // phải đúng bằng pl-64 của sidebar và tràn mất phần tài khoản bên phải.
    <header className="fixed top-0 inset-x-0 z-50 bg-surface-container-lowest border-b border-outline-variant shadow-xs h-16">
      {/* Dải màu nhận diện: navy - đỏ - vàng - lá */}
      <div className="absolute inset-x-0 top-0 h-[3px] flex" aria-hidden="true">
        <span className="flex-[4] bg-primary" />
        <span className="flex-[2] bg-secondary" />
        <span className="flex-1 bg-warning" />
        <span className="flex-1 bg-tertiary" />
      </div>
      {/* Header trải hết bề ngang: bọc max-w-1440 + mx-auto sẽ thụt logo vào
          giữa, để lại mảng trắng trống phía trên sidebar ở màn hình rộng. */}
      <div className="w-full h-full flex justify-between items-center gap-4 pl-4 md:pl-8 pr-4 md:pr-6 lg:pr-8">
        <Link to="/schedule" className="flex items-center gap-sm shrink-0 group">
          <img
            src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png"
            alt="Trường Ngôi Sao Hoàng Mai"
            className="h-9 w-auto object-contain shrink-0"
          />
          {/* Logo đã có sẵn tên trường nên chỉ cần gạch ngăn + tên phần mềm */}
          <span className="hidden sm:block w-px h-8 bg-outline-variant shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline text-headline-sm text-primary uppercase whitespace-nowrap group-hover:text-primary-dark transition-colors">
            Phần mềm đăng ký ăn
          </span>
          <span className="sm:hidden text-headline-sm text-primary uppercase whitespace-nowrap">Đăng ký ăn</span>
        </Link>
        
        {!isRegister ? (
          <div className="flex items-center gap-4">
            {location.pathname === '/quantri' && (
              <Link
                to="/schedule"
                className="hidden md:flex items-center gap-2 bg-primary-container/60 hover:bg-primary-container text-on-primary-container border border-primary/15 px-4 py-2 rounded-lg text-label-md transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                Quay về giao diện đăng ký ăn
              </Link>
            )}
            {/* Desktop User Info */}
            <div 
              className="hidden md:flex items-center gap-md cursor-pointer group"
              onClick={() => window.dispatchEvent(new Event('open-account-modal'))}
            >
              <span className="text-body-md text-on-surface-variant group-hover:text-primary transition-colors whitespace-nowrap">
                Xin chào, <span className="text-label-lg text-on-surface">{userName}</span>
              </span>
              <div className="w-10 h-10 rounded-full bg-primary text-on-primary flex items-center justify-center text-label-md group-hover:ring-2 group-hover:ring-primary/30 group-hover:ring-offset-2 transition-all shadow-xs">
                {initials}
              </div>
            </div>

            {/* Mobile User Info */}
            <div className="flex items-center gap-2 md:hidden">
              {location.pathname === '/quantri' && (
                <Link
                  to="/schedule"
                  aria-label="Quay về giao diện đăng ký ăn"
                  className="w-9 h-9 rounded-lg bg-primary-container/60 flex items-center justify-center text-on-primary-container hover:bg-primary-container transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                </Link>
              )}
              <div
                className="w-9 h-9 rounded-full bg-primary text-on-primary flex items-center justify-center text-label-md cursor-pointer hover:ring-2 hover:ring-primary/30 hover:ring-offset-2 transition-all active:scale-95"
                onClick={() => window.dispatchEvent(new Event('open-account-modal'))}
              >
                {initials}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-sm">
            <div className="w-8 h-8 rounded-full bg-surface-variant flex items-center justify-center text-on-surface-variant">
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>person</span>
            </div>
            <span className="hidden md:inline text-body-md text-on-surface">Staff Profile</span>
          </div>
        )}
      </div>
    </header>
  );
}
