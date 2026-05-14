import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';

export function Navigation({ className }: { className?: string }) {
  const location = useLocation();

  const links = [
    { to: '/dashboard', icon: 'how_to_reg', label: 'Tổng Quan' },
    { to: '/schedule', icon: 'calendar_month', label: 'Lịch Trình' },
    { to: '#', icon: 'person', label: 'Tài Khoản' },
  ];

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className={clsx("fixed top-16 left-0 bottom-0 w-64 bg-surface border-r border-outline-variant hidden md:flex flex-col z-40", className)}>
        <nav className="flex-1 py-lg flex flex-col gap-sm px-md">
          {links.map(link => {
            const isActive = location.pathname.startsWith(link.to);
            return (
              <Link 
                key={link.to}
                to={link.to}
                className={clsx(
                  "flex items-center gap-md px-md py-sm rounded-lg transition-colors",
                  isActive 
                    ? "bg-primary-container text-on-primary-container" 
                    : "text-on-surface-variant hover:bg-surface-container"
                )}
              >
                <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive ? "'FILL' 1" : undefined }}>
                  {link.icon}
                </span>
                <span className="font-label-md text-label-md">{link.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-evenly items-center h-16 bg-surface-container border-t border-outline-variant md:hidden">
        {links.map(link => {
          const isActive = location.pathname.startsWith(link.to);
          return (
            <Link 
              key={link.to}
              to={link.to}
              className={clsx(
                "flex flex-col items-center justify-center h-full flex-1 transition-all",
                isActive 
                  ? "text-primary"
                  : "text-on-surface-variant hover:text-on-surface"
              )}
            >
              <div className={clsx(
                "px-5 py-1 rounded-full transition-colors",
                isActive ? "bg-secondary-container" : "hover:bg-surface-container-high"
              )}>
                <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive ? "'FILL' 1" : undefined }}>
                  {link.icon}
                </span>
              </div>
              <span className={clsx(
                "font-label-md text-[11px] mt-1 text-center",
                isActive ? "font-bold" : "font-normal"
              )}>
                {link.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
