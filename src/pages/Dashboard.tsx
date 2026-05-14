import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col pt-16 pb-24 md:pb-0 md:pl-64">
      <Header />
      <Navigation />
      
      <main className="flex-1 max-w-[1440px] mx-auto w-full p-sm md:p-lg lg:p-xl flex flex-col gap-md md:gap-lg">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-sm border-b md:border-b-0 border-outline-variant pb-md md:pb-0 px-md md:px-0 mt-md md:mt-0">
          <div>
            <h1 className="font-headline-lg-mobile md:text-headline-lg text-primary md:text-on-surface">Tổng Quan Tháng 05</h1>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1 text-[13px] md:text-[14px]">Tóm tắt tình trạng đăng ký suất ăn của bạn.</p>
          </div>
          <button 
            onClick={() => navigate('/schedule')}
            className="w-full md:w-auto flex items-center justify-center gap-sm bg-primary text-on-primary px-lg py-sm rounded-lg font-label-md text-label-md hover:bg-primary-container hover:text-on-primary-container transition-all shadow-sm hover:shadow-md"
          >
            <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
            Thay Đổi Đăng Ký
          </button>
        </div>

        {/* Bento Grid Layout */}
        <div className="px-md md:px-0 grid grid-cols-1 md:grid-cols-2 gap-md lg:gap-lg">
          {/* Summary Card 1 */}
          <div className="bg-surface-container-lowest rounded-xl p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-outline-variant flex flex-col gap-md">
            <div className="flex justify-between items-center">
              <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Tổng Đăng Ký Tháng Hiện Tại</span>
              <span className="material-symbols-outlined text-primary-container" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_month</span>
            </div>
            <div>
              <span className="font-headline-lg text-headline-lg text-on-surface">42</span>
              <span className="font-body-md text-body-md text-on-surface-variant ml-1">bữa ăn</span>
            </div>
            <div className="w-full bg-surface-variant rounded-full h-2 mt-auto">
              <div className="bg-primary h-2 rounded-full" style={{ width: '100%' }}></div>
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
        <div className="mx-md md:mx-0 bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-outline-variant overflow-hidden mb-24">
          <div className="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
            <h2 className="font-headline-sm text-headline-sm text-on-surface">Thực Đơn</h2>
            <a className="font-label-md text-label-md text-primary hover:underline" href="#">Xem tất cả</a>
          </div>
          <div className="divide-y divide-outline-variant">
            {/* Day Item */}
            <div className="p-md hover:bg-surface-bright transition-colors">
              <div className="flex items-start gap-md">
                <div className="w-12 h-12 rounded-lg bg-surface-container flex flex-col items-center justify-center border border-outline-variant shrink-0 mt-1">
                  <span className="font-label-md text-label-md text-on-surface-variant text-[10px] uppercase">T2</span>
                  <span className="font-headline-sm text-headline-sm text-on-surface">18</span>
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-headline-sm text-headline-sm text-[14px] text-on-surface flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px] text-primary">bakery_dining</span>
                        Bữa Sáng
                      </p>
                      <p className="font-body-md text-body-md text-on-surface-variant text-[13px]">Bánh mì ốp la, Sữa đậu nành</p>
                    </div>
                  </div>
                  <div className="w-full h-px bg-outline-variant/30 hidden md:block"></div>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-headline-sm text-headline-sm text-[14px] text-on-surface flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px] text-secondary">lunch_dining</span>
                        Bữa Trưa
                      </p>
                      <p className="font-body-md text-body-md text-on-surface-variant text-[13px]">Cơm trắng, Thịt kho tàu, Canh rau cải, Trái cây</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Day Item */}
            <div className="p-md hover:bg-surface-bright transition-colors">
              <div className="flex items-start gap-md">
                <div className="w-12 h-12 rounded-lg bg-surface-container flex flex-col items-center justify-center border border-outline-variant shrink-0 mt-1">
                  <span className="font-label-md text-label-md text-on-surface-variant text-[10px] uppercase">T3</span>
                  <span className="font-headline-sm text-headline-sm text-on-surface">19</span>
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-headline-sm text-headline-sm text-[14px] text-on-surface flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px] text-primary">bakery_dining</span>
                        Bữa Sáng
                      </p>
                      <p className="font-body-md text-body-md text-on-surface-variant text-[13px]">Phở bò viên, Trà đá</p>
                    </div>
                  </div>
                  <div className="w-full h-px bg-outline-variant/30 hidden md:block"></div>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-headline-sm text-headline-sm text-[14px] text-on-surface flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px] text-secondary">lunch_dining</span>
                        Bữa Trưa
                      </p>
                      <p className="font-body-md text-body-md text-on-surface-variant text-[13px]">Cơm chiên dương châu, Khổ qua cà ớ, Sữa chua</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Day Item */}
            <div className="p-md hover:bg-surface-bright transition-colors">
               <div className="flex items-start gap-md">
                <div className="w-12 h-12 rounded-lg bg-surface-container flex flex-col items-center justify-center border border-outline-variant shrink-0 mt-1">
                  <span className="font-label-md text-label-md text-on-surface-variant text-[10px] uppercase">T4</span>
                  <span className="font-headline-sm text-headline-sm text-on-surface">20</span>
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-headline-sm text-headline-sm text-[14px] text-on-surface flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px] text-primary">bakery_dining</span>
                        Bữa Sáng
                      </p>
                      <p className="font-body-md text-body-md text-on-surface-variant text-[13px]">Bún bò Huế</p>
                    </div>
                  </div>
                  <div className="w-full h-px bg-outline-variant/30 hidden md:block"></div>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-headline-sm text-headline-sm text-[14px] text-on-surface flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px] text-secondary">lunch_dining</span>
                        Bữa Trưa
                      </p>
                      <p className="font-body-md text-body-md text-on-surface-variant text-[13px]">Cơm trắng, Gà kho gừng, Canh mướp, Sinh tố</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
