import { useState, useEffect } from 'react';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { auth, db } from '../lib/firebase';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';

interface EventData {
  id: string;
  name: string;
  isOpen: boolean;
}

export default function ScheduleMonth() {
  const [breakfastChoice, setBreakfastChoice] = useState('yes');
  const [lunchChoice, setLunchChoice] = useState('yes');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{type: 'success' | 'error' | 'info', message: string} | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>('');
  const [isMonthOpen, setIsMonthOpen] = useState(true);
  const [events, setEvents] = useState<EventData[]>([]);
  const [eventChoices, setEventChoices] = useState<Record<string, string>>({});

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user && user.email) {
        setUserEmail(user.email);
      }
    });

    fetchConfigAndEvents();

    return () => unsubscribe();
  }, []);

  const fetchConfigAndEvents = async () => {
    try {
      // Current month config check
      const monthlyDoc = await getDoc(doc(db, 'settings', 'monthlyConfig'));
      if (monthlyDoc.exists()) {
        const data = monthlyDoc.data();
        if (data && data['05'] !== undefined) {
          setIsMonthOpen(data['05']);
        }
      }

      // Events
      const eventsSnapshot = await getDocs(collection(db, 'events'));
      const evts: EventData[] = [];
      const initChoices: Record<string, string> = {};
      eventsSnapshot.forEach((d) => {
        const evt = { id: d.id, ...d.data() } as EventData;
        evts.push(evt);
        initChoices[evt.id] = 'yes';
      });
      setEvents(evts);
      setEventChoices(initChoices);
    } catch (err) {
      console.error(err);
    }
  };

  const handleRegister = async () => {
    if (!isMonthOpen) {
      alert("Hiện đăng ký ăn đã bị khóa, vui lòng liên hệ với Bộ phận Dinh dưỡng");
      return;
    }

    setIsSubmitting(true);
    setSubmitStatus(null);
    
    // Simulate meals counts
    const breakfastCount = breakfastChoice === 'yes' ? 21 : 0;
    const lunchCount = lunchChoice === 'yes' ? 21 : 0;
    const toEmail = userEmail || 'tuan303@gmail.com'; 

    try {
      const user = auth.currentUser;
      if (user) {
        const staffDoc = await getDoc(doc(db, 'staff', user.uid));
        const staffData = staffDoc.exists() ? staffDoc.data() : {
           fullName: user.displayName || 'Unknown',
           employeeId: 'N/A',
           department: 'N/A'
        };

        // Monthly
        await setDoc(doc(db, 'registrations', `${user.uid}_2026-05`), {
          userId: user.uid,
          month: '2026-05',
          breakfastCount,
          lunchCount,
          fullName: staffData.fullName,
          employeeId: staffData.employeeId,
          department: staffData.department,
          email: user.email,
          timestamp: new Date().toISOString()
        });

        // Loop over events and save if open
        for (const evt of events) {
          if (evt.isOpen) {
            await setDoc(doc(db, 'event_registrations', `${user.uid}_${evt.id}`), {
               userId: user.uid,
               eventId: evt.id,
               eventName: evt.name,
               choice: eventChoices[evt.id],
               fullName: staffData.fullName,
               email: user.email,
               timestamp: new Date().toISOString()
            });
          }
        }
      }

      const response = await fetch('/api/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: toEmail,
          subject: 'Xác nhận đăng ký ăn Tháng 05/2026',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
              <h2 style="color: #1a365d; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">XÁC NHẬN ĐĂNG KÝ SUẤT ĂN</h2>
              <p>Kính gửi Anh/Chị,</p>
              <p>Hệ thống Quản lý Căng tin Trường Ngôi Sao Hoàng Mai xin trân trọng xác nhận Anh/Chị đã thực hiện đăng ký suất ăn thành công cho <strong>Tháng 05/2026</strong>. Chi tiết số lượng suất ăn như sau:</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 12px; text-align: left;">Hạng mục</th>
                  <th style="padding: 12px; text-align: right;">Số lượng đã đăng ký</th>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px;">Đăng ký ăn Sáng</td>
                  <td style="padding: 12px; text-align: right; color: #1a365d; font-weight: bold;">${breakfastCount} suất</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px;">Đăng ký ăn Trưa</td>
                  <td style="padding: 12px; text-align: right; color: #1a365d; font-weight: bold;">${lunchCount} suất</td>
                </tr>
              </table>
              <p style="margin-top: 20px; font-size: 13px; color: #64748b; font-style: italic;">
                Lưu ý: Nếu có bất kỳ thắc mắc hoặc cần điều chỉnh đăng ký, vui lòng liên hệ trực tiếp với Bộ phận Dinh dưỡng.
              </p>
              <p style="font-weight: bold; margin-top: 30px; color: #1a365d;">Trân trọng,<br>BỘ PHẬN DINH DƯỠNG</p>
            </div>
          `
        })
      });

      setSubmitStatus({
        type: 'success',
        message: 'Đăng ký thành công! Đã gửi thông tin đến email của bạn.'
      });

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
              <h2 className="font-headline-lg-mobile md:text-headline-lg text-headline-lg text-primary">ĐĂNG KÝ ĂN HÀNG THÁNG</h2>
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
            <div className="lg:col-span-2 bg-surface-container-lowest md:bg-surface rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),_0_2px_4px_-1px_rgba(26,54,93,0.03)] flex flex-col h-full flex-shrink-0">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-sm md:gap-0 mb-md border-b border-outline-variant pb-md">
                <h3 className="font-headline-sm text-headline-sm text-primary">ĐĂNG KÝ ĂN HÀNG THÁNG</h3>
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
              <div className="space-y-md">
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

                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-sm md:gap-0 mt-xl mb-md border-b border-outline-variant pb-md">
                  <h3 className="font-headline-sm text-headline-sm text-primary">ĐĂNG KÝ ĂN SỰ KIỆN</h3>
                </div>

                <div className="space-y-sm">
                  {events.length === 0 ? (
                     <div className="p-md text-center">
                        <p className="font-body-md text-body-md text-on-surface-variant italic">Không có sự kiện nào đang mở đăng ký.</p>
                     </div>
                  ) : events.map(evt => (
                    <div key={evt.id} className="flex flex-col md:flex-row items-start md:items-center justify-between p-md bg-surface-container-low rounded-xl border border-outline-variant gap-md hover:bg-surface-container-low/80 transition-colors">
                      <div className="flex items-center gap-md">
                        <div className="w-12 h-12 bg-[#ffe4e6] rounded-full flex items-center justify-center text-[#e11d48]">
                          <span className="material-symbols-outlined text-[24px]">event</span>
                        </div>
                        <div>
                          <h5 className="font-headline-sm text-[16px] text-on-surface w-full max-w-[200px] md:max-w-none">{evt.name}</h5>
                          {!evt.isOpen && <p className="font-body-md text-error text-[13px] mt-0.5">Sự kiện đã khóa đăng ký</p>}
                        </div>
                      </div>
                      
                      <div className="flex gap-md w-full md:w-auto mt-2 md:mt-0 justify-end md:justify-center">
                        <label className={`flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors ${!evt.isOpen ? 'opacity-50 pointer-events-none' : ''}`}>
                          <input 
                            type="radio" 
                            name={`event_${evt.id}`} 
                            checked={eventChoices[evt.id] === 'yes'}
                            onChange={() => setEventChoices({...eventChoices, [evt.id]: 'yes'})}
                            disabled={!evt.isOpen}
                            className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer disabled:cursor-not-allowed" 
                          />
                          <span className="font-label-md text-label-md text-on-surface select-none">Có ăn</span>
                        </label>
                        <label className={`flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors ${!evt.isOpen ? 'opacity-50 pointer-events-none' : ''}`}>
                          <input 
                            type="radio" 
                            name={`event_${evt.id}`}
                            checked={eventChoices[evt.id] === 'no'}
                            onChange={() => setEventChoices({...eventChoices, [evt.id]: 'no'})}
                            disabled={!evt.isOpen}
                            className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer disabled:cursor-not-allowed" 
                          />
                          <span className="font-label-md text-label-md text-on-surface select-none">Không ăn</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

              </div>
            </div>

            {/* Summary Card */}
            <div className="lg:col-span-1 bg-surface-bright rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] flex flex-col mb-24 h-max">
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
                
                {events.filter(e => eventChoices[e.id] === 'yes').map(e => (
                  <div key={e.id} className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                    <div className="flex items-center gap-sm">
                      <span className="material-symbols-outlined text-[#e11d48]">event</span>
                      <span className="font-body-md text-body-md text-on-surface max-w-[120px] truncate">{e.name}</span>
                    </div>
                    <span className="font-headline-md text-headline-md text-primary">
                      1 <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                    </span>
                  </div>
                ))}
              </div>
              <button 
                onClick={handleRegister}
                disabled={isSubmitting}
                className={`w-full mt-xl text-on-primary font-headline-sm text-headline-sm py-md rounded-lg transition-colors shadow-sm flex items-center justify-center gap-sm ${!isMonthOpen ? 'bg-surface-variant text-on-surface-variant opacity-70 cursor-pointer hover:bg-surface-variant' : 'bg-primary hover:bg-primary-container hover:text-on-primary-container active:scale-95 duration-100 disabled:opacity-60 disabled:cursor-not-allowed'}`}
              >
                {isSubmitting ? (
                  <span className="material-symbols-outlined animate-spin">refresh</span>
                ) : (
                  <span className="material-symbols-outlined">{!isMonthOpen ? 'lock' : 'check_circle'}</span>
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
