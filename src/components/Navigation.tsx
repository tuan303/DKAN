import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { useState, useEffect } from 'react';
import { auth, db } from '../lib/firebase';
import { collection, getDocs, doc, getDoc } from 'firebase/firestore';

const SUPER_ADMIN = 'tuantm@hoangmaistarschool.edu.vn';

export function Navigation({ className }: { className?: string }) {
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<{name: string, email: string, employeeId?: string, department?: string} | null>(null);
  const [monthlyStatus, setMonthlyStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (user) {
        setUserInfo({ name: user.displayName || 'Người dùng', email: user.email || '' });
        
        try {
          const staffDoc = await getDoc(doc(db, 'staff', user.uid));
          if (staffDoc.exists()) {
             const data = staffDoc.data();
             setUserInfo(prev => prev ? {
               ...prev,
               name: data.fullName || prev.name,
               employeeId: data.employeeId,
               department: data.department
             } : null);
          }
        } catch(e) {}

        let isUserAdmin = user.email === SUPER_ADMIN;
        if (!isUserAdmin && user.email) {
          try {
            // First check by standard doc ID
            const docId = user.email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
            const adminDoc = await getDoc(doc(db, 'admins', docId));
            if (adminDoc.exists()) {
              isUserAdmin = true;
            } else {
              // Fallback to checking the collection (if document has random ID)
              const adminsSnapshot = await getDocs(collection(db, 'admins'));
              const adminEmails = adminsSnapshot.docs.map(doc => {
                const email = doc.data().email;
                return typeof email === 'string' ? email.toLowerCase().trim() : '';
              });
              if (adminEmails.includes(user.email.toLowerCase().trim())) {
                isUserAdmin = true;
              }
            }
          } catch (err) {
            console.error('Error checking admin status in Navigation:', err);
          }
        }
        setIsAdmin(isUserAdmin);
        
        // Fetch monthly status for account info
        try {
          const configDoc = await getDoc(doc(db, 'settings', 'monthlyConfig'));
          if (configDoc.exists()) {
            setMonthlyStatus(configDoc.data() as Record<string, boolean>);
          }
        } catch (e) {
          console.error(e);
        }
      } else {
        setIsAdmin(false);
        setUserInfo(null);
      }
    });

    const handleOpenModal = () => setShowAccountModal(true);
    window.addEventListener('open-account-modal', handleOpenModal);

    return () => {
      unsubscribe();
      window.removeEventListener('open-account-modal', handleOpenModal);
    };
  }, []);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await auth.signOut();
      setShowAccountModal(false);
      // Nạp lại hẳn trang /login thay vì chuyển route: đăng xuất xong mọi
      // listener Firestore đang mở đều mất quyền đọc, tải lại là sạch nhất.
      window.location.replace('/login');
    } catch (error) {
      console.error('Error signing out:', error);
      setSignOutError('Không đăng xuất được. Vui lòng kiểm tra kết nối mạng rồi thử lại.');
      setSigningOut(false);
    }
  };

  const links = [
    { to: '/schedule', icon: 'calendar_month', label: 'ĐK ĂN HÀNG THÁNG' },
    { to: '/events', icon: 'event', label: 'ĐĂNG KÝ ĂN SỰ KIỆN' },
  ];

  let displayLinks = links;

  if (isAdmin) {
    if (location.pathname.startsWith('/quantri')) {
      displayLinks = [
        { to: '/quantri?tab=monthly', icon: 'calendar_month', label: 'ĐK ĂN HÀNG THÁNG' },
        { to: '/quantri?tab=events', icon: 'event', label: 'ĐĂNG KÝ ĂN SỰ KIỆN' },
        { to: '/quantri?tab=settings', icon: 'settings', label: 'CẤU HÌNH' },
        { to: '/quantri?tab=admins', icon: 'admin_panel_settings', label: 'QUẢN TRỊ' },
      ];
    } else {
      displayLinks = [...links, { to: '/quantri', icon: 'admin_panel_settings', label: 'QUẢN TRỊ' }];
    }
  }

  const renderLinkItems = (isMobile: boolean) => {
    return displayLinks.map(link => {
      const isAccount = link.to === '#account';
      const isActive = !isAccount && (
        location.pathname + location.search === link.to ||
        (link.to === '/quantri' && location.pathname.startsWith('/quantri')) ||
        (link.to !== '/quantri' && !location.pathname.startsWith('/quantri') && location.pathname.startsWith(link.to))
      );

      if (isMobile) {
        const isProminent = link.to === '/schedule' || link.to === '/events';
        return (
          <button 
            key={link.to}
            onClick={() => {
              if (isAccount) {
                setShowAccountModal(true);
              } else {
                window.location.href = link.to;
              }
            }}
            className={clsx(
              "flex flex-col items-center justify-center h-full flex-1 transition-all relative",
              isActive 
                ? "text-primary"
                : "text-on-surface-variant hover:text-on-surface"
            )}
          >
            <div className={clsx(
              "px-5 py-1 rounded-full transition-colors relative",
              isActive ? "bg-primary-container/40" : "hover:bg-surface-container-high",
              isProminent && !isActive && "text-primary/70"
            )}>
              <span className="material-symbols-outlined text-[26px]" style={{ fontVariationSettings: isActive ? "'FILL' 1" : undefined }}>
                {link.icon}
              </span>
              {isActive && <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary rounded-full md:hidden"></div>}
            </div>
            <span className={clsx(
              "font-label-md text-[10px] mt-1 text-center max-w-[80px] uppercase tracking-wider transition-all",
              isActive || isProminent ? "font-bold text-primary scale-105" : "font-normal opacity-80"
            )}>
              {link.label}
            </span>
          </button>
        );
      }

      // Desktop Link Items
      if (isAccount) {
        return (
          <button 
            key={link.to}
            onClick={() => setShowAccountModal(true)}
            className="flex w-full items-center gap-md px-md py-sm rounded-lg transition-colors text-on-surface-variant hover:bg-surface-container"
          >
            <span className="material-symbols-outlined">{link.icon}</span>
            <span className="text-label-md">{link.label}</span>
          </button>
        );
      }

      return (
        <Link 
          key={link.to}
          to={link.to}
          className={clsx(
            "flex items-center gap-md px-md py-sm rounded-lg transition-colors",
            isActive 
              ? "bg-primary-container text-on-primary-container font-bold" 
              : "text-on-surface-variant hover:bg-surface-container"
          )}
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive ? "'FILL' 1" : undefined }}>
            {link.icon}
          </span>
          <span className="text-label-md">{link.label}</span>
        </Link>
      );
    });
  };

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className={clsx("fixed top-16 left-0 bottom-0 w-64 bg-surface border-r border-outline-variant hidden md:flex flex-col z-40", className)}>
        <nav className="flex-1 py-lg flex flex-col gap-sm px-md">
          {renderLinkItems(false)}
        </nav>
      </aside>

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-evenly items-center h-[72px] bg-surface-container-lowest pb-safe border-t border-outline-variant shadow-[0_-4px_12px_-2px_rgb(35_50_140_/_0.08)] md:hidden">
        {renderLinkItems(true)}
      </nav>

      {/* Account Modal */}
      {showAccountModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setShowAccountModal(false)}></div>
          <div className="bg-surface-container-lowest relative w-[min(calc(100vw-32px),380px)] rounded-xl shadow-xl overflow-hidden animate-in zoom-in-95 duration-200 border border-outline-variant flex flex-col max-h-[85vh]">
            
            {/* Header Pattern */}
            <div className="px-6 pt-8 pb-5 flex flex-col items-center flex-shrink-0 bg-surface z-10 border-b border-outline-variant/40">
              <div className="relative mb-4">
                <div className="w-20 h-20 bg-primary/10 text-primary rounded-full flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-[40px]">person</span>
                </div>
                <div className="absolute bottom-0 right-0 w-6 h-6 bg-tertiary border-[3px] border-surface rounded-full flex items-center justify-center"></div>
              </div>
              <h3 className="text-[20px] font-bold text-on-surface tracking-tight text-center w-full truncate px-2">
                {userInfo?.name || auth.currentUser?.displayName || 'Tài khoản nhân viên'}
              </h3>
              <p className="text-[14px] text-on-surface-variant mt-1 text-center truncate w-full px-4">
                {userInfo?.email || auth.currentUser?.email || ''}
              </p>
            </div>
            
            {/* Scrollable content area */}
            <div className="overflow-y-auto px-5 py-6 flex-1 space-y-6 flex flex-col w-full min-h-0 bg-surface-container-lowest">
              
              {/* Detailed info table */}
              <div className="w-full">
                <h4 className="text-[13px] font-bold text-primary uppercase mb-3 px-1 flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px]">badge</span>
                  Thông tin nhân sự
                </h4>
                <div className="bg-surface rounded-2xl border border-outline-variant overflow-hidden w-full shadow-sm">
                  <div className="flex flex-col sm:flex-row justify-between p-3.5 border-b border-outline-variant/50 gap-1 sm:items-center bg-surface">
                      <span className="text-[13px] text-on-surface-variant min-w-[110px]">Họ tên</span>
                      <span className="text-[14px] font-semibold text-on-surface sm:text-right">{userInfo?.name || auth.currentUser?.displayName || 'Trống'}</span>
                  </div>
                  <div className="flex flex-col sm:flex-row justify-between p-3.5 border-b border-outline-variant/50 gap-1 sm:items-center bg-surface">
                      <span className="text-[13px] text-on-surface-variant min-w-[110px]">Email</span>
                      <span className="text-[14px] font-semibold text-on-surface sm:text-right break-words">{userInfo?.email || auth.currentUser?.email || 'Trống'}</span>
                  </div>
                  <div className="flex flex-col sm:flex-row justify-between p-3.5 border-b border-outline-variant/50 gap-1 sm:items-center bg-surface">
                      <span className="text-[13px] text-on-surface-variant min-w-[110px]">Mã nhân viên</span>
                      <span className="text-[14px] font-semibold text-on-surface sm:text-right">{userInfo?.employeeId || 'Chưa cập nhật'}</span>
                  </div>
                  <div className="flex flex-col sm:flex-row justify-between p-3.5 gap-1 sm:items-center bg-surface">
                      <span className="text-[13px] text-on-surface-variant min-w-[110px]">Phòng ban</span>
                      <span className="text-[14px] font-semibold text-on-surface sm:text-right">{userInfo?.department || 'Chưa cập nhật'}</span>
                  </div>
                </div>
              </div>

              {/* Status Section */}
              <div className="w-full">
                <h4 className="text-[13px] font-bold text-primary uppercase mb-3 px-1 flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px]">event_available</span>
                  Cấu hình tháng
                </h4>
                <div className="space-y-2.5">
                  {Object.entries(monthlyStatus).sort((a,b) => a[0].localeCompare(b[0])).map(([month, isOpen]) => (
                    <div key={month} className="flex items-center justify-between p-3.5 px-4 bg-surface rounded-2xl border border-outline-variant shadow-sm hover:border-outline transition-colors">
                      <span className="text-[14px] text-on-surface font-medium flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-outline-variant"></span>
                        Tháng {month}
                      </span>
                      {isOpen ? (
                        <div className="px-3 py-1.5 bg-tertiary-container/80 text-on-tertiary-container rounded-full text-[12px] font-bold flex items-center gap-1.5 shrink-0">
                          <span className="material-symbols-outlined text-[15px]">check_circle</span>
                          Mở đăng ký
                        </div>
                      ) : (
                        <div className="px-3 py-1.5 bg-surface-variant/70 text-on-surface-variant rounded-full text-[12px] font-bold flex items-center gap-1.5 shrink-0">
                          <span className="material-symbols-outlined text-[15px]">lock</span>
                          Đã khóa
                        </div>
                      )}
                    </div>
                  ))}
                  {Object.keys(monthlyStatus).length === 0 && (
                    <div className="p-4 bg-surface rounded-2xl border border-outline-variant text-center">
                      <p className="italic text-on-surface-variant text-[13px]">Chưa có dữ liệu tháng...</p>
                    </div>
                  )}
                </div>
              </div>
              
            </div>

            {/* Footer Buttons */}
            <div className="p-5 border-t border-outline-variant/40 flex flex-col gap-3 flex-shrink-0 bg-surface">
              {isAdmin && (
                <Link 
                  to="/quantri"
                  onClick={() => setShowAccountModal(false)}
                  className="w-full flex items-center justify-center gap-2 bg-primary-container text-on-primary-container hover:brightness-95 font-bold text-[15px] h-12 rounded-[14px] transition-all focus:ring-2 focus:ring-primary/50 outline-none"
                >
                  <span className="material-symbols-outlined text-[20px]">admin_panel_settings</span>
                  Trang quản trị
                </Link>
              )}
              
              {signOutError && (
                <p className="text-[13px] text-on-error-container bg-error-container border border-error/25 rounded-lg px-3 py-2">
                  {signOutError}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setShowAccountModal(false)}
                  disabled={signingOut}
                  className="flex-1 h-12 rounded-lg font-bold text-[15px] text-on-surface bg-surface border border-outline-variant hover:bg-surface-container transition-all disabled:opacity-60 disabled:cursor-not-allowed outline-none"
                >
                  Đóng
                </button>
                <button
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="flex-1 flex items-center justify-center gap-2 bg-error text-on-error hover:bg-error-dark font-bold text-[15px] h-12 rounded-lg transition-colors shadow-sm disabled:opacity-70 disabled:cursor-not-allowed outline-none"
                >
                  <span className={`material-symbols-outlined text-[20px] ${signingOut ? 'animate-spin' : ''}`}>
                    {signingOut ? 'progress_activity' : 'logout'}
                  </span>
                  {signingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
