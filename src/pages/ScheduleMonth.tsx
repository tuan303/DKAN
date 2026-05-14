import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';

export default function ScheduleMonth() {
  return (
    <div className="font-body-lg flex flex-col pt-16 pb-24 md:pb-0 md:pl-64">
      <Header />
      <Navigation />
      
      <main className="flex-1 max-w-[1440px] w-full mx-auto py-md md:py-lg flex flex-col gap-md md:gap-lg">
        <section className="space-y-xl px-0 md:px-margin lg:px-xl">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-md px-md md:px-0">
            <div>
              <h2 className="font-headline-lg-mobile md:text-headline-lg text-headline-lg text-primary">Đăng ký suất ăn tháng</h2>
              <p className="font-body-md text-body-md text-on-surface-variant mt-xs text-[13px] md:text-[14px]">Chọn các ngày bạn muốn đăng ký ăn tại nhà ăn cơ quan.</p>
            </div>
            {/* Month Selector */}
            <div className="w-full md:w-auto flex items-center justify-between gap-md bg-surface-container-lowest md:bg-surface border border-outline-variant rounded-lg p-sm shadow-[0_2px_4px_-1px_rgba(26,54,93,0.03)]">
              <button className="p-xs hover:bg-surface-container rounded transition-colors text-on-surface-variant flex items-center justify-center">
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <span className="font-headline-sm text-headline-sm text-primary min-w-[120px] text-center">Tháng 11, 2023</span>
              <button className="p-xs hover:bg-surface-container rounded transition-colors text-on-surface-variant flex items-center justify-center">
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
          </div>

          {/* Bento Grid Layout for Content */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-md md:gap-gutter px-md md:px-0">
            {/* Calendar View */}
            <div className="lg:col-span-2 bg-surface-container-lowest md:bg-surface rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),_0_2px_4px_-1px_rgba(26,54,93,0.03)] flex flex-col h-full">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-sm md:gap-0 mb-md border-b border-outline-variant pb-md">
                <h3 className="font-headline-sm text-headline-sm text-primary">Lịch Đăng Ký</h3>
                <div className="flex gap-md md:gap-sm bg-surface-container p-1 rounded-md md:bg-transparent md:p-0">
                  <span className="flex items-center gap-xs font-label-md text-label-md text-on-surface-variant px-2 py-1">
                    <span className="w-3 h-3 rounded-full bg-primary"></span> Sáng
                  </span>
                  <span className="flex items-center gap-xs font-label-md text-label-md text-on-surface-variant px-2 py-1">
                    <span className="w-3 h-3 rounded-full bg-secondary-container border border-primary"></span> Trưa
                  </span>
                </div>
              </div>

              {/* Simplified List View */}
              <div className="overflow-y-auto max-h-[500px] flex-1 md:pr-sm space-y-md">
                {/* Week 1 */}
                <div className="space-y-sm">
                  <h4 className="font-label-md text-label-md text-outline">Tuần 1 (01/11 - 05/11)</h4>
                  
                  {/* Day Row */}
                  <div className="flex items-center justify-between p-sm hover:bg-surface-container-low rounded-lg border border-transparent hover:border-outline-variant transition-colors">
                    <div className="flex items-center gap-md w-1/3">
                      <div className="w-10 text-center">
                        <span className="block font-headline-md text-headline-md text-primary">01</span>
                        <span className="block font-label-md text-label-md text-on-surface-variant">Thứ 4</span>
                      </div>
                    </div>
                    <div className="flex flex-col md:flex-row gap-sm md:gap-md w-2/3 justify-end items-end md:items-center">
                      <label className="flex items-center gap-sm cursor-pointer">
                        <span className="font-body-md text-body-md">Đăng ký bữa sáng</span>
                        <input type="checkbox" className="w-5 h-5 rounded border-outline text-primary focus:ring-primary focus:ring-2 bg-surface" />
                      </label>
                      <label className="flex items-center gap-sm cursor-pointer">
                        <span className="font-body-md text-body-md">Đăng ký bữa trưa</span>
                        <input type="checkbox" defaultChecked className="w-5 h-5 rounded border-outline text-primary focus:ring-primary focus:ring-2 bg-surface" />
                      </label>
                    </div>
                  </div>

                  {/* Day Row */}
                  <div className="flex items-center justify-between p-sm bg-surface-container-low rounded-lg border border-outline-variant">
                    <div className="flex items-center gap-md w-1/3">
                      <div className="w-10 text-center">
                        <span className="block font-headline-md text-headline-md text-primary">02</span>
                        <span className="block font-label-md text-label-md text-on-surface-variant">Thứ 5</span>
                      </div>
                    </div>
                    <div className="flex flex-col md:flex-row gap-sm md:gap-md w-2/3 justify-end items-end md:items-center">
                      <label className="flex items-center gap-sm cursor-pointer">
                        <span className="font-body-md text-body-md">Đăng ký bữa sáng</span>
                        <input type="checkbox" defaultChecked className="w-5 h-5 rounded border-outline text-primary focus:ring-primary focus:ring-2 bg-surface" />
                      </label>
                      <label className="flex items-center gap-sm cursor-pointer">
                        <span className="font-body-md text-body-md">Đăng ký bữa trưa</span>
                        <input type="checkbox" defaultChecked className="w-5 h-5 rounded border-outline text-primary focus:ring-primary focus:ring-2 bg-surface" />
                      </label>
                    </div>
                  </div>
                </div>

                {/* Week 2 Placeholder */}
                <div className="space-y-sm opacity-60">
                  <h4 className="font-label-md text-label-md text-outline">Tuần 2 (06/11 - 12/11)</h4>
                  {/* Empty for demo */}
                </div>
              </div>
            </div>

            {/* Summary Card */}
            <div className="lg:col-span-1 bg-surface-bright rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] flex flex-col mb-24">
              <h3 className="font-headline-sm text-headline-sm text-primary mb-lg pb-sm border-b border-outline-variant">Tổng kết tháng</h3>
              <div className="space-y-md flex-1">
                <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined text-on-surface-variant">free_breakfast</span>
                    <span className="font-body-md text-body-md text-on-surface">Bữa sáng</span>
                  </div>
                  <span className="font-headline-md text-headline-md text-primary">
                    12 <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                  </span>
                </div>
                <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined text-on-surface-variant">restaurant</span>
                    <span className="font-body-md text-body-md text-on-surface">Bữa trưa</span>
                  </div>
                  <span className="font-headline-md text-headline-md text-primary">
                    20 <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                  </span>
                </div>
              </div>
              <button className="w-full mt-xl bg-primary text-on-primary font-headline-sm text-headline-sm py-md rounded-lg hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm active:scale-95 duration-100 flex items-center justify-center gap-sm">
                <span className="material-symbols-outlined">check_circle</span>
                Xác nhận đăng ký
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
