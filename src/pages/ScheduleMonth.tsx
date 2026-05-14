import { useState, useEffect } from 'react';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { auth } from '../lib/firebase';

export default function ScheduleMonth() {
  const [breakfastChoice, setBreakfastChoice] = useState('yes');
  const [lunchChoice, setLunchChoice] = useState('yes');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{type: 'success' | 'error', message: string} | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>('');

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user && user.email) {
        setUserEmail(user.email);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleRegister = async () => {
    setIsSubmitting(true);
    setSubmitStatus(null);
    
    // Simulate meals counts
    const breakfastCount = breakfastChoice === 'yes' ? 21 : 0;
    const lunchCount = lunchChoice === 'yes' ? 21 : 0;
    const toEmail = userEmail || 'tuan303@gmail.com'; 

    try {
      const response = await fetch('/api/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: toEmail,
          subject: 'Xác nhận đăng ký ăn Tháng 05/2026',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
              <h2 style="color: #1a365d;">XÁC NHẬN ĐĂNG KÝ SUẤT ĂN</h2>
              <p>Xin chào,</p>
              <p>Hệ thống Quản lý Căng tin Trường Ngôi Sao Hoàng Mai xác nhận bạn đã đăng ký suất ăn cho <strong>Tháng 05/2026</strong> với chi tiết như sau:</p>
              <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 10px; text-align: left;">Bữa ăn</th>
                  <th style="padding: 10px; text-align: right;">Số suất</th>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 10px;">Bữa Sáng</td>
                  <td style="padding: 10px; text-align: right;"><strong>${breakfastCount}</strong> suất</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 10px;">Bữa Trưa</td>
                  <td style="padding: 10px; text-align: right;"><strong>${lunchCount}</strong> suất</td>
                </tr>
              </table>
              <p style="margin-top: 20px; font-size: 13px; color: #64748b;">
                Đây là email tự động từ hệ thống. Vui lòng không trả lời email này. Nếu có thắc mắc, vui lòng liên hệ Bộ phận Dinh dưỡng.
              </p>
              <p style="font-weight: bold; margin-top: 30px;">Trân trọng,<br>BỘ PHẬN DINH DƯỠNG</p>
            </div>
          `
        })
      });

      if (!response.ok) {
        throw new Error('Network error');
      }

      setSubmitStatus({
        type: 'success',
        message: 'Đăng ký thành công! Đã gửi thông tin đến email của bạn.'
      });

      // Clear success message after 5 seconds
      setTimeout(() => setSubmitStatus(null), 5000);

    } catch (error) {
      console.error(error);
      setSubmitStatus({
        type: 'error',
        message: 'Có lỗi xảy ra, vui lòng thử lại sau.'
      });
    } finally {
      setIsSubmitting(false);
    }
  };

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
              <span className="font-headline-sm text-headline-sm text-primary min-w-[120px] text-center">Tháng 05, 2026</span>
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
                {/* Month header */}
                <div className="space-y-sm">
                  <h4 className="font-headline-sm text-headline-sm text-primary uppercase border-b border-outline-variant pb-xs">THÁNG 05/2026</h4>
                  
                  {/* Day Row 1 */}
                  <div className="flex flex-col md:flex-row items-start md:items-center justify-between p-md bg-surface-container-low rounded-xl border border-outline-variant gap-md hover:bg-surface-container-low/80 transition-colors">
                    <div className="flex items-center gap-md">
                      <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary">
                        <span className="material-symbols-outlined text-[24px]">bakery_dining</span>
                      </div>
                      <div>
                        <h5 className="font-headline-sm text-[16px] text-on-surface">ĐĂNG KÝ ĂN BỮA SÁNG</h5>
                        <p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">Áp dụng cho tất cả các ngày từ Thứ 2 đến Thứ 6</p>
                      </div>
                    </div>
                    
                    <div className="flex gap-md w-full md:w-auto mt-2 md:mt-0 justify-end md:justify-center">
                      <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                        <input 
                          type="radio" 
                          name="breakfast" 
                          checked={breakfastChoice === 'yes'}
                          onChange={() => setBreakfastChoice('yes')}
                          className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer" 
                        />
                        <span className="font-label-md text-label-md text-on-surface select-none">Có ăn</span>
                      </label>
                      <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                        <input 
                          type="radio" 
                          name="breakfast" 
                          checked={breakfastChoice === 'no'}
                          onChange={() => setBreakfastChoice('no')}
                          className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer" 
                        />
                        <span className="font-label-md text-label-md text-on-surface select-none">Không ăn</span>
                      </label>
                    </div>
                  </div>

                  {/* Day Row 2 */}
                  <div className="flex flex-col md:flex-row items-start md:items-center justify-between p-md bg-surface-container-low rounded-xl border border-outline-variant gap-md hover:bg-surface-container-low/80 transition-colors">
                    <div className="flex items-center gap-md">
                      <div className="w-12 h-12 bg-secondary-container rounded-full flex items-center justify-center text-on-secondary-container">
                        <span className="material-symbols-outlined text-[24px]">lunch_dining</span>
                      </div>
                      <div>
                        <h5 className="font-headline-sm text-[16px] text-on-surface">ĐĂNG KÝ ĂN BỮA TRƯA</h5>
                        <p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">Áp dụng cho tất cả các ngày từ Thứ 2 đến Thứ 6</p>
                      </div>
                    </div>
                    
                    <div className="flex gap-md w-full md:w-auto mt-2 md:mt-0 justify-end md:justify-center">
                      <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                        <input 
                          type="radio" 
                          name="lunch" 
                          checked={lunchChoice === 'yes'}
                          onChange={() => setLunchChoice('yes')}
                          className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer" 
                        />
                        <span className="font-label-md text-label-md text-on-surface select-none">Có ăn</span>
                      </label>
                      <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                        <input 
                          type="radio" 
                          name="lunch" 
                          checked={lunchChoice === 'no'}
                          onChange={() => setLunchChoice('no')}
                          className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer" 
                        />
                        <span className="font-label-md text-label-md text-on-surface select-none">Không ăn</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Remaining Days Note */}
                <div className="p-md text-center">
                  <p className="font-body-md text-body-md text-on-surface-variant italic">Bạn đang thao tác đăng ký nhanh suất ăn cho cả tháng 05/2026.</p>
                </div>
              </div>
            </div>

            {/* Summary Card */}
            <div className="lg:col-span-1 bg-surface-bright rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] flex flex-col mb-24">
              <h3 className="font-headline-sm text-headline-sm text-primary mb-lg pb-sm border-b border-outline-variant">Tổng kết tháng</h3>
              
              {submitStatus && (
                <div className={`mb-4 p-sm rounded-lg font-body-md text-body-md flex items-start gap-2 ${submitStatus.type === 'success' ? 'bg-[#d1fae5] text-[#065f46]' : 'bg-error-container text-on-error-container'}`}>
                  <span className="material-symbols-outlined text-[18px] mt-0.5">{submitStatus.type === 'success' ? 'check_circle' : 'error'}</span>
                  <p>{submitStatus.message}</p>
                </div>
              )}

              <div className="space-y-md flex-1">
                <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined text-on-surface-variant">free_breakfast</span>
                    <span className="font-body-md text-body-md text-on-surface">Bữa sáng</span>
                  </div>
                  <span className="font-headline-md text-headline-md text-primary">
                     {breakfastChoice === 'yes' ? 21 : 0} <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                  </span>
                </div>
                <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined text-on-surface-variant">restaurant</span>
                    <span className="font-body-md text-body-md text-on-surface">Bữa trưa</span>
                  </div>
                  <span className="font-headline-md text-headline-md text-primary">
                    {lunchChoice === 'yes' ? 21 : 0} <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                  </span>
                </div>
              </div>
              <button 
                onClick={handleRegister}
                disabled={isSubmitting}
                className="w-full mt-xl bg-primary text-on-primary font-headline-sm text-headline-sm py-md rounded-lg hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm active:scale-95 duration-100 flex items-center justify-center gap-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <span className="material-symbols-outlined animate-spin">refresh</span>
                ) : (
                  <span className="material-symbols-outlined">check_circle</span>
                )}
                {isSubmitting ? 'Đang gửi...' : 'Xác nhận đăng ký'}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
