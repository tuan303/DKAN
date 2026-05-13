import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col pt-16 pb-24 md:pb-0 md:pl-64">
      <Header />
      <Navigation />
      
      <main className="flex-1 max-w-[1440px] mx-auto w-full p-md md:p-lg lg:p-xl flex flex-col gap-lg">
        <div className="flex justify-between items-end">
          <div>
            <h1 className="font-headline-lg-mobile md:text-headline-lg text-on-surface">Tổng Quan Tháng 10</h1>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1">Tóm tắt tình trạng đăng ký suất ăn của bạn.</p>
          </div>
          <button 
            onClick={() => navigate('/schedule')}
            className="hidden md:flex items-center justify-center gap-sm bg-primary text-on-primary px-lg py-sm rounded-lg font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-all shadow-sm hover:shadow-md"
          >
            <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
            Thay Đổi Đăng Ký
          </button>
        </div>

        {/* Bento Grid Layout */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-md lg:gap-lg">
          {/* Summary Card 1 */}
          <div className="bg-surface-container-lowest rounded-xl p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-outline-variant flex flex-col gap-md">
            <div className="flex justify-between items-center">
              <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Đã Đăng Ký</span>
              <span className="material-symbols-outlined text-primary-container" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant</span>
            </div>
            <div>
              <span className="font-headline-lg text-headline-lg text-on-surface">22</span>
              <span className="font-body-md text-body-md text-on-surface-variant ml-1">bữa ăn</span>
            </div>
            <div className="w-full bg-surface-variant rounded-full h-2 mt-auto">
              <div className="bg-primary h-2 rounded-full" style={{ width: '85%' }}></div>
            </div>
          </div>

          {/* Summary Card 2 */}
          <div className="bg-surface-container-lowest rounded-xl p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-outline-variant flex flex-col gap-md">
            <div className="flex justify-between items-center">
              <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Chi Phí Ước Tính</span>
              <span className="material-symbols-outlined text-tertiary-container" style={{ fontVariationSettings: "'FILL' 1" }}>payments</span>
            </div>
            <div>
              <span className="font-headline-lg text-headline-lg text-on-surface">660K</span>
              <span className="font-body-md text-body-md text-on-surface-variant ml-1">VNĐ</span>
            </div>
            <div className="flex items-center gap-xs mt-auto text-secondary">
              <span className="material-symbols-outlined text-[16px]">info</span>
              <span className="font-body-md text-body-md text-[12px]">Dự kiến trừ vào lương tháng 10</span>
            </div>
          </div>

          {/* Action Card */}
          <div className="bg-primary-fixed rounded-xl p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-primary-fixed-dim flex flex-col justify-center items-start gap-md relative overflow-hidden">
            <div className="z-10">
              <h3 className="font-headline-sm text-headline-sm text-on-primary-fixed mb-1">Cần thay đổi lịch?</h3>
              <p className="font-body-md text-body-md text-on-primary-fixed-variant mb-4">Hạn chót cập nhật cho tuần tới là Thứ 6, 15:00.</p>
              <button 
                onClick={() => navigate('/schedule')}
                className="bg-primary text-on-primary px-md py-sm rounded-lg font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm"
              >
                Cập Nhật Ngay
              </button>
            </div>
            <span className="material-symbols-outlined absolute -bottom-4 -right-4 text-[120px] text-primary-fixed-dim opacity-30 pointer-events-none" style={{ fontVariationSettings: "'FILL' 1" }}>
              event_upcoming
            </span>
          </div>
        </div>

        {/* Upcoming Meals List */}
        <div className="bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-outline-variant overflow-hidden">
          <div className="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
            <h2 className="font-headline-sm text-headline-sm text-on-surface">Bữa Ăn Sắp Tới (Tuần Này)</h2>
            <a className="font-label-md text-label-md text-primary hover:underline" href="#">Xem tất cả</a>
          </div>
          <div className="divide-y divide-outline-variant">
            {/* Day Item */}
            <div className="p-md flex items-center justify-between hover:bg-surface-bright transition-colors">
              <div className="flex items-center gap-md">
                <div className="w-12 h-12 rounded-lg bg-surface-container flex flex-col items-center justify-center border border-outline-variant">
                  <span className="font-label-md text-label-md text-on-surface-variant text-[10px] uppercase">T2</span>
                  <span className="font-headline-sm text-headline-sm text-on-surface">16</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm text-[16px] text-on-surface">Bữa Trưa Ca 1</p>
                  <p className="font-body-md text-body-md text-on-surface-variant text-[12px]">11:30 - 12:30 • Nhà ăn A</p>
                </div>
              </div>
              <div className="px-sm py-1 rounded bg-secondary-container text-on-secondary-container font-label-md text-label-md text-[10px] uppercase">
                Đã Đăng Ký
              </div>
            </div>

            {/* Day Item */}
            <div className="p-md flex items-center justify-between hover:bg-surface-bright transition-colors">
              <div className="flex items-center gap-md">
                <div className="w-12 h-12 rounded-lg bg-surface-container flex flex-col items-center justify-center border border-outline-variant">
                  <span className="font-label-md text-label-md text-on-surface-variant text-[10px] uppercase">T3</span>
                  <span className="font-headline-sm text-headline-sm text-on-surface">17</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm text-[16px] text-on-surface">Bữa Trưa Ca 1</p>
                  <p className="font-body-md text-body-md text-on-surface-variant text-[12px]">11:30 - 12:30 • Nhà ăn A</p>
                </div>
              </div>
              <div className="px-sm py-1 rounded bg-secondary-container text-on-secondary-container font-label-md text-label-md text-[10px] uppercase">
                Đã Đăng Ký
              </div>
            </div>

            {/* Day Item (Not registered) */}
            <div className="p-md flex items-center justify-between hover:bg-surface-bright transition-colors opacity-75">
              <div className="flex items-center gap-md">
                <div className="w-12 h-12 rounded-lg bg-surface-container flex flex-col items-center justify-center border border-outline-variant opacity-50">
                  <span className="font-label-md text-label-md text-on-surface-variant text-[10px] uppercase">T4</span>
                  <span className="font-headline-sm text-headline-sm text-on-surface">18</span>
                </div>
                <div>
                  <p className="font-headline-sm text-headline-sm text-[16px] text-on-surface-variant">Không Đăng Ký</p>
                  <p className="font-body-md text-body-md text-on-surface-variant text-[12px]">-</p>
                </div>
              </div>
              <div className="px-sm py-1 rounded border border-outline text-on-surface-variant font-label-md text-label-md text-[10px] uppercase">
                Trống
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
