import { useState, useEffect } from 'react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { auth, db } from '../lib/firebase';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';

interface EventData {
  id: string;
  name: string;
  isOpen: boolean;
}

export default function ScheduleEvent() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{type: 'success' | 'error' | 'info', message: string} | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>('');
  const [events, setEvents] = useState<EventData[]>([]);
  const [eventChoices, setEventChoices] = useState<Record<string, string>>({});

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user && user.email) {
        setUserEmail(user.email);
      }
    });

    fetchEvents();

    return () => unsubscribe();
  }, []);

  const fetchEvents = async () => {
    try {
      // Events
      const eventsSnapshot = await getDocs(collection(db, 'events'));
      const evts: EventData[] = [];
      const initChoices: Record<string, string> = {};
      eventsSnapshot.forEach((d) => {
        const evt = { id: d.id, ...d.data() } as EventData;
        if (evt.isOpen) {
          evts.push(evt);
          initChoices[evt.id] = 'yes';
        }
      });
      setEvents(evts);
      setEventChoices(initChoices);
    } catch (err) {
      console.error(err);
    }
  };

  const handleRegister = async () => {
    if (events.length === 0) {
      return;
    }

    setIsSubmitting(true);
    setSubmitStatus(null);
    
    // const toEmail = userEmail || 'tuan303@gmail.com'; 

    try {
      let staffData: any = {};
      
      const user = auth.currentUser;
      if (user) {
        const staffDoc = await getDoc(doc(db, 'staff', user.uid));
        staffData = staffDoc.exists() ? staffDoc.data() : {
           fullName: user.displayName || 'Unknown',
           employeeId: 'N/A',
           department: 'N/A'
        };

        // Loop over events and save if open
        for (const evt of events) {
          if (evt.isOpen) {
            await setDoc(doc(db, 'event_registrations', `${user.uid}_${evt.id}`), {
               userId: user.uid,
               eventId: evt.id,
               eventName: evt.name,
               choice: eventChoices[evt.id],
               fullName: staffData.fullName,
               employeeId: staffData.employeeId,
               department: staffData.department,
               email: user.email,
               timestamp: new Date().toISOString()
            });
          }
        }
      }

      // Send confirmation email
      const toEmail = userEmail || staffData.email;
      if (toEmail) {
        try {
          const eventsTableRows = events
            .filter(evt => evt.isOpen)
            .map(evt => `
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 12px;">${evt.name}</td>
              <td style="padding: 12px; text-align: right; color: #1a365d; font-weight: bold;">
                ${eventChoices[evt.id] === 'yes' ? 'Có ăn (1 suất)' : 'Không ăn'}
              </td>
            </tr>
          `).join('');

          const response = await fetch('/api/send-email', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              to: toEmail,
              subject: 'Xác nhận đăng ký ăn Sự kiện',
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
                  <h2 style="color: #1a365d; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">XÁC NHẬN ĐĂNG KÝ SUẤT ĂN SỰ KIỆN</h2>
                  <p>Kính gửi Anh/Chị,</p>
                  <p>Hệ thống đăng ký suất ăn Trường Ngôi Sao Hoàng Mai xin trân trọng xác nhận Anh/Chị đã thực hiện đăng ký suất ăn thành công đối với các sự kiện hiện hành. Chi tiết như sau:</p>
                  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                      <th style="padding: 12px; text-align: left;">Sự kiện</th>
                      <th style="padding: 12px; text-align: right;">Lựa chọn</th>
                    </tr>
                    ${eventsTableRows}
                  </table>
                  <div style="margin-top: 20px; color: #d21235; font-weight: bold; border: 1px solid #d21235; padding: 15px; border-radius: 8px;">
                    <p style="margin-top: 0;"><u>Lưu ý</u>:</p>
                    <ul style="margin-bottom: 0; padding-left: 20px;">
                      <li>Nếu có bất kỳ thắc mắc hoặc cần điều chỉnh đăng ký, vui lòng liên hệ trực tiếp với Bộ phận Dinh dưỡng.</li>
                      <li>Trường hợp muốn hủy ăn phải báo với bộ phận Dinh dưỡng trước 16h00 ngày hôm trước.</li>
                    </ul>
                  </div>
                  <p style="font-weight: bold; margin-top: 30px; color: #1a365d;">Trân trọng,<br>BỘ PHẬN DINH DƯỠNG</p>
                </div>
              `
            })
          });

          if (!response.ok) {
            const errorData = await response.json();
            console.error('Email failed but registration was successful:', errorData.error);
          }
        } catch (emailError) {
          console.error('Email sending error:', emailError);
        }
      }

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
              <h2 className="font-headline-lg-mobile md:text-headline-lg text-headline-lg text-primary">ĐĂNG KÝ ĂN SỰ KIỆN</h2>
              <p className="font-body-md text-body-md text-on-surface-variant mt-xs text-[13px] md:text-[14px]">Đăng ký suất ăn tham gia các sự kiện của cơ quan.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-md md:gap-gutter px-md md:px-0">
            <div className="lg:col-span-2 bg-surface-container-lowest md:bg-surface rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),_0_2px_4px_-1px_rgba(26,54,93,0.03)] flex flex-col h-full flex-shrink-0">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-sm md:gap-0 mt-xl mb-md border-b border-outline-variant pb-md">
                <h3 className="font-headline-sm text-headline-sm text-primary">DANH SÁCH SỰ KIỆN</h3>
              </div>

              <div className="space-y-sm">
                {events.length === 0 ? (
                  <div className="py-[60px] px-6 text-center bg-surface-container-lowest rounded-[24px] border border-outline-variant flex flex-col items-center justify-center w-full my-4 shadow-sm">
                    <div className="w-20 h-20 bg-surface-variant/30 rounded-full flex items-center justify-center mb-6">
                      <span className="material-symbols-outlined text-[40px] text-on-surface-variant">event_busy</span>
                    </div>
                    <h3 className="text-[20px] font-bold text-on-surface mb-3">Không có sự kiện</h3>
                    <p className="text-[15px] text-on-surface-variant max-w-[320px] leading-relaxed">
                      Hiện tại không có sự kiện nào đang trong thời gian mở đăng ký ăn. Vui lòng quay lại sau!
                    </p>
                  </div>
                ) : events.map(evt => (
                  <div key={evt.id} className="flex flex-col md:flex-row items-start md:items-center justify-between p-md bg-surface-container-low rounded-xl border border-outline-variant gap-md hover:bg-surface-container-low/80 transition-colors">
                    <div className="flex items-center gap-md">
                      <div className="w-12 h-12 bg-[#ffe4e6] rounded-full flex items-center justify-center text-[#e11d48]">
                        <span className="material-symbols-outlined text-[24px]">event</span>
                      </div>
                      <div>
                        <h5 className="font-headline-sm text-[16px] text-on-surface w-full max-w-[200px] md:max-w-none">{evt.name}</h5>
                      </div>
                    </div>
                    
                    <div className="flex gap-md w-full md:w-auto mt-2 md:mt-0 justify-end md:justify-center">
                      <label className={`flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors`}>
                        <input 
                          type="radio" 
                          name={`event_${evt.id}`} 
                          checked={eventChoices[evt.id] === 'yes'}
                          onChange={() => setEventChoices({...eventChoices, [evt.id]: 'yes'})}
                          className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer disabled:cursor-not-allowed" 
                        />
                        <span className="font-label-md text-label-md text-on-surface select-none">Có ăn</span>
                      </label>
                      <label className={`flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors`}>
                        <input 
                          type="radio" 
                          name={`event_${evt.id}`}
                          checked={eventChoices[evt.id] === 'no'}
                          onChange={() => setEventChoices({...eventChoices, [evt.id]: 'no'})}
                          className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer disabled:cursor-not-allowed" 
                        />
                        <span className="font-label-md text-label-md text-on-surface select-none">Không ăn</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Summary Card */}
            <div className="lg:col-span-1 bg-surface-bright rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] flex flex-col mb-24 h-max">
              <h3 className="font-headline-sm text-headline-sm text-primary mb-lg pb-sm border-b border-outline-variant">Thông tin xác nhận</h3>
              
              {submitStatus && (
                <div className={`mb-4 p-sm rounded-lg font-body-md text-body-md flex items-start gap-2 ${submitStatus.type === 'success' ? 'bg-[#d1fae5] text-[#065f46]' : 'bg-error-container text-on-error-container'}`}>
                  <span className="material-symbols-outlined text-[18px] mt-0.5">{submitStatus.type === 'success' ? 'check_circle' : 'error'}</span>
                  <p>{submitStatus.message}</p>
                </div>
              )}

              <div className="space-y-md flex-1">
                {events.filter(e => eventChoices[e.id] === 'yes').length === 0 ? (
                  <p className="text-on-surface-variant italic font-body-md text-[14px]">Bạn chưa đăng ký sự kiện nào.</p>
                ) : events.filter(e => eventChoices[e.id] === 'yes').map(e => (
                  <div key={e.id} className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                    <div className="flex items-center gap-sm">
                      <span className="material-symbols-outlined text-[#e11d48]">event</span>
                      <span className="font-body-md text-body-md text-on-surface max-w-[120px] md:max-w-none truncate">{e.name}</span>
                    </div>
                    <span className="font-headline-md text-headline-md text-primary ml-2">
                      1 <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                    </span>
                  </div>
                ))}
              </div>
              <button 
                onClick={handleRegister}
                disabled={isSubmitting || events.length === 0}
                className={`w-full mt-xl text-on-primary font-headline-sm text-headline-sm py-md rounded-lg transition-colors shadow-sm flex items-center justify-center gap-sm ${events.length === 0 ? 'bg-surface-variant text-on-surface-variant opacity-70 cursor-pointer hover:bg-surface-variant' : 'bg-primary hover:bg-primary-container hover:text-on-primary-container active:scale-95 duration-100 disabled:opacity-60 disabled:cursor-not-allowed'}`}
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
      {/* Professional Notification Modal */}
      {submitStatus && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setSubmitStatus(null)}></div>
          <div className={clsx(
            "relative w-full max-w-sm bg-surface rounded-[28px] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border border-outline-variant",
            submitStatus.type === 'error' ? "border-error/20" : "border-primary/20"
          )}>
            <div className="p-xl text-center flex flex-col items-center">
              <div className={clsx(
                "w-20 h-20 rounded-full flex items-center justify-center mb-md shadow-sm border-4 border-surface",
                submitStatus.type === 'success' ? "bg-green-100 text-green-600" : "bg-error-container text-on-error-container"
              )}>
                <span className="material-symbols-outlined text-[48px]">
                  {submitStatus.type === 'success' ? 'check_circle' : 'error'}
                </span>
              </div>
              
              <h3 className={clsx(
                "font-headline-sm text-headline-sm mb-sm",
                submitStatus.type === 'success' ? "text-green-800" : "text-error"
              )}>
                {submitStatus.type === 'success' ? 'Thành công!' : 'Thông báo'}
              </h3>
              
              <p className="font-body-md text-body-md text-on-surface-variant mb-xl">
                {submitStatus.message}
              </p>
              
              <button 
                onClick={() => setSubmitStatus(null)}
                className={clsx(
                  "w-full py-3 rounded-xl font-label-lg text-label-lg transition-colors shadow-sm",
                  submitStatus.type === 'success' 
                    ? "bg-primary text-on-primary hover:bg-primary/90" 
                    : "bg-error text-on-error hover:bg-error/90"
                )}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
