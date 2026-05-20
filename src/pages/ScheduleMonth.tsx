import { useState, useEffect } from 'react';
import clsx from 'clsx';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { auth, db } from '../lib/firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where } from 'firebase/firestore';
import { Footer } from '../components/Footer';

interface EventData {
  id: string;
  name: string;
  isOpen: boolean;
}

export default function ScheduleMonth() {
  const [breakfastChoice, setBreakfastChoice] = useState('');
  const [lunchChoice, setLunchChoice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{type: 'success' | 'error' | 'info', message: string} | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>('');
  const [monthlyStatus, setMonthlyStatus] = useState<Record<string, boolean>>({});
  const [monthlyExpiry, setMonthlyExpiry] = useState<Record<string, string>>({});
  
  const [blockedMonths, setBlockedMonths] = useState<Record<string, boolean>>({});
  
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const [activeMainTab, setActiveMainTab] = useState<'register' | 'cancel'>('register');
  const [cancelDate, setCancelDate] = useState('');
  const [cancelMeal, setCancelMeal] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelCanteen, setCancelCanteen] = useState('');
  const [isCanceling, setIsCanceling] = useState(false);

  const getMinCancelDate = () => {
    const d = new Date();
    if (d.getHours() >= 16) {
      d.setDate(d.getDate() + 2);
    } else {
      d.setDate(d.getDate() + 1);
    }
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const getWeekdaysCount = (month: number, year: number) => {
    let count = 0;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) {
      const day = new Date(year, month, i).getDay();
      if (day !== 0 && day !== 6) { // Not Sunday (0) or Saturday (6)
        count++;
      }
    }
    return count;
  };

  const weekdaysCount = getWeekdaysCount(selectedMonthIndex, selectedYear);
  const monthString = (selectedMonthIndex + 1).toString().padStart(2, '0');
  let isMonthOpen = monthlyStatus[monthString] ?? false; 
  if (isMonthOpen && monthlyExpiry[monthString]) {
    const expiryDate = new Date(monthlyExpiry[monthString]);
    if (new Date() > expiryDate) {
      isMonthOpen = false;
    }
  }
  const isUserBlocked = blockedMonths[`${selectedYear}-${monthString}`] ?? false;

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user && user.email) {
        setUserEmail(user.email);
      }
    });

    fetchConfigAndEvents();

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const checkBlockedStatus = async () => {
      if (!userEmail) return;
      const monthKey = `${selectedYear}-${monthString}`;
      try {
        const docRef = doc(db, 'blocked_users', monthKey);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const emails: string[] = docSnap.data().emails || [];
          setBlockedMonths(prev => ({
            ...prev,
            [monthKey]: emails.includes(userEmail.toLowerCase())
          }));
        } else {
          setBlockedMonths(prev => ({
            ...prev,
            [monthKey]: false
          }));
        }
      } catch (err) {
        console.error('Error checking block status', err);
      }
    };
    checkBlockedStatus();
  }, [selectedYear, monthString, userEmail]);

  const fetchConfigAndEvents = async () => {
    try {
      // Current month config check
      const monthlyDoc = await getDoc(doc(db, 'settings', 'monthlyConfig'));
      if (monthlyDoc.exists()) {
        const data = monthlyDoc.data() as Record<string, boolean>;
        setMonthlyStatus(data);
      }
      
      const expiryDoc = await getDoc(doc(db, 'settings', 'monthlyExpiry'));
      if (expiryDoc.exists()) {
        setMonthlyExpiry(expiryDoc.data() as Record<string, string>);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handlePrevMonth = () => {
    setSelectedMonthIndex((prev) => {
      if (prev === 0) {
        setSelectedYear((y) => y - 1);
        return 11;
      }
      return prev - 1;
    });
  };

  const handleNextMonth = () => {
    setSelectedMonthIndex((prev) => {
      if (prev === 11) {
        setSelectedYear((y) => y + 1);
        return 0;
      }
      return prev + 1;
    });
  };

  const handleRegister = async () => {
    if (isUserBlocked) {
      setSubmitStatus({
        type: 'error',
        message: 'Thầy/Cô đã vi phạm quy định chấm ăn! Không được đăng ký ăn trong tháng này'
      });
      return;
    }

    if (!isMonthOpen) {
      setSubmitStatus({
        type: 'error',
        message: 'Tháng này hiện không mở đăng ký. Vui lòng liên hệ Bộ phận Dinh dưỡng để được hỗ trợ.'
      });
      return;
    }

    if (!breakfastChoice || !lunchChoice) {
      setSubmitStatus({
        type: 'error',
        message: 'Vui lòng chọn trạng thái Có ăn hoặc Không ăn cho tùy chọn bữa ăn.'
      });
      return;
    }

    setIsSubmitting(true);
    setSubmitStatus(null);
    
    // Calculate meals counts
    const breakfastCount = breakfastChoice === 'yes' ? weekdaysCount : 0;
    const lunchCount = lunchChoice === 'yes' ? weekdaysCount : 0;

    try {
      let staffData: any = {};
      const user = auth.currentUser;
      if (user) {
        // Check if already registered
        const regDocRef = doc(db, 'registrations', `${user.uid}_${selectedYear}-${monthString}`);
        const regDocSnap = await getDoc(regDocRef);
        
        if (regDocSnap.exists()) {
          const data = regDocSnap.data();
          let dateStr = '';
          if (data.timestamp) {
            const date = new Date(data.timestamp);
            const hh = date.getHours().toString().padStart(2, '0');
            const mm = date.getMinutes().toString().padStart(2, '0');
            const dd = date.getDate().toString().padStart(2, '0');
            const MM = (date.getMonth() + 1).toString().padStart(2, '0');
            const yyyy = date.getFullYear();
            dateStr = `${hh}:${mm} ngày ${dd}/${MM}/${yyyy}`;
          }
          
          setSubmitStatus({
            type: 'info',
            message: `Thầy/Cô đã đăng ký lúc: ${dateStr}`
          });
          setIsSubmitting(false);
          return;
        }

        const staffDoc = await getDoc(doc(db, 'staff', user.uid));
        staffData = staffDoc.exists() ? staffDoc.data() : {
           fullName: user.displayName || 'Unknown',
           employeeId: 'N/A',
           department: 'N/A'
        };

        // Monthly
        await setDoc(doc(db, 'registrations', `${user.uid}_${selectedYear}-${monthString}`), {
          userId: user.uid,
          month: `${selectedYear}-${monthString}`,
          breakfastCount,
          lunchCount,
          fullName: staffData.fullName,
          employeeId: staffData.employeeId,
          department: staffData.department,
          email: user.email,
          timestamp: new Date().toISOString()
        });
      }

      const toEmail = userEmail || staffData.email || 'tuan303@gmail.com'; 
      try {
        const response = await fetch('/api/send-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: toEmail,
            subject: `Xác nhận đăng ký ăn Tháng ${monthString}/${selectedYear}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
                <h2 style="color: #D21235; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">XÁC NHẬN ĐĂNG KÝ SUẤT ĂN</h2>
                <p>Kính gửi Thầy/Cô: ${staffData.fullName || 'Thầy/Cô'},</p>
                <p>Hệ thống đăng ký suất ăn Trường Ngôi Sao Hoàng Mai xin xác nhận Thầy/Cô đã thực hiện đăng ký suất ăn thành công cho <strong>Tháng ${monthString}/${selectedYear}</strong>. Chi tiết như sau:</p>
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                  <tr style="background-color: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                    <th style="padding: 12px; text-align: left;">Thông tin</th>
                    <th style="padding: 12px; text-align: right;">Số lượng đã đăng ký</th>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 12px;">Bữa Sáng + Trưa (T2 - T6)</td>
                    <td style="padding: 12px; text-align: right; color: #D21235; font-weight: bold;">
                      ${breakfastChoice === 'yes' ? 'Có ăn (' + (weekdaysCount * 2) + ' suất)' : '-'}
                    </td>
                  </tr>
                  <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 12px;">Chỉ ăn Bữa Trưa (T2 - T6)</td>
                    <td style="padding: 12px; text-align: right; color: #D21235; font-weight: bold;">
                      ${lunchChoice === 'yes' ? 'Có ăn (' + weekdaysCount + ' suất)' : '-'}
                    </td>
                  </tr>
                </table>
                <div style="margin-top: 20px; color: #D21235; font-weight: bold; border: 1px solid #D21235; padding: 15px; border-radius: 8px;">
                  <p style="margin-top: 0;"><u>Lưu ý</u>:</p>
                  <ul style="margin-bottom: 0; padding-left: 20px;">
                    <li>Nếu có bất kỳ thắc mắc hoặc cần điều chỉnh đăng ký, vui lòng liên hệ trực tiếp với Bộ phận Dinh dưỡng.</li>
                    <li>Trường hợp muốn hủy ăn phải báo với bộ phận Dinh dưỡng trước 16h00 ngày hôm trước.</li>
                  </ul>
                </div>
                <p style="font-weight: bold; margin-top: 30px; color: #333;">Trân trọng,<br>BỘ PHẬN DINH DƯỠNG</p>
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

  const handleCancel = async () => {
    if (!cancelDate || !cancelMeal || !cancelReason || !cancelCanteen) {
      setSubmitStatus({ type: 'error', message: 'Vui lòng điền đầy đủ thông tin hủy đăng ký ăn.' });
      return;
    }

    const minDateStr = getMinCancelDate();
    if (cancelDate < minDateStr) {
      setSubmitStatus({ 
        type: 'error', 
        message: 'Không hợp lệ! Hủy ăn ngày mai phải đăng ký trước 16h00 ngày hôm nay.' 
      });
      return;
    }

    setIsCanceling(true);
    setSubmitStatus(null);
    try {
      const user = auth.currentUser;
      if (!user) {
        setSubmitStatus({ type: 'error', message: 'Vui lòng đăng nhập để thực hiện.' });
        setIsCanceling(false);
        return;
      }

      const staffDoc = await getDoc(doc(db, 'staff', user.uid));
      const staffData = staffDoc.exists() ? staffDoc.data() : {
         fullName: user.displayName || 'Unknown',
         employeeId: 'N/A',
         department: 'N/A'
      };

      const cancelDocRef = doc(db, 'cancel_registrations', `${user.uid}_${cancelDate}`);
      const cancelDocSnap = await getDoc(cancelDocRef);

      if (cancelDocSnap.exists()) {
        const data = cancelDocSnap.data();
        let dateStr = '';
        if (data.timestamp) {
          const date = new Date(data.timestamp);
          const hh = date.getHours().toString().padStart(2, '0');
          const mm = date.getMinutes().toString().padStart(2, '0');
          const dd = date.getDate().toString().padStart(2, '0');
          const MM = (date.getMonth() + 1).toString().padStart(2, '0');
          const yy = date.getFullYear().toString().slice(2);
          dateStr = `${hh}:${mm} ngày ${dd}/${MM}/${yy}`;
        }
        
        const dateParts = cancelDate.split('-');
        const formattedDateForMsg = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
        
        setSubmitStatus({
          type: 'info',
          message: `Thầy/Cô đã đăng ký hủy ăn cho ngày ${formattedDateForMsg} (thực hiện lúc ${dateStr})`
        });
        setIsCanceling(false);
        return;
      }

      const dateParts = cancelDate.split('-');
      const formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;

      await setDoc(cancelDocRef, {
        userId: user.uid,
        fullName: staffData.fullName,
        employeeId: staffData.employeeId,
        department: staffData.department,
        email: user.email,
        cancelDate,
        formattedDate,
        cancelMeal,
        cancelReason,
        cancelCanteen,
        timestamp: new Date().toISOString()
      });

      const toEmail = userEmail || staffData.email || user?.email || 'tuan303@gmail.com';
      const toRecipients = `dinhduong@hoangmaistarschool.edu.vn, ${toEmail}`;

      const response = await fetch('/api/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: toRecipients,
          subject: `Yêu cầu hủy suất ăn - ${staffData.fullName || 'Nhân viên'}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
              <h2 style="color: #D21235; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">THÔNG BÁO HỦY SUẤT ĂN</h2>
              <p>Kính gửi Thầy/Cô và Bộ phận Dinh dưỡng,</p>
              <p>Hệ thống đăng ký suất ăn Trường Ngôi Sao Hoàng Mai xin xác nhận yêu cầu hủy suất ăn với chi tiết như sau:</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold; width: 35%;">Mã NV:</td>
                  <td style="padding: 12px;">${staffData.employeeId}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold;">Họ Tên:</td>
                  <td style="padding: 12px;">${staffData.fullName}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold;">Bộ Phận:</td>
                  <td style="padding: 12px;">${staffData.department}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold;">Ngày Hủy:</td>
                  <td style="padding: 12px; color: #D21235; font-weight: bold;">${formattedDate}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold;">Bữa Hủy:</td>
                  <td style="padding: 12px; font-weight: bold;">${cancelMeal === 'both' ? 'Cả 2 bữa' : (cancelMeal === 'breakfast' ? 'Sáng' : 'Trưa')}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold;">Nhà Ăn:</td>
                  <td style="padding: 12px;">${cancelCanteen === 'trunghoc' ? 'Trung học' : 'Tiểu học'}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px; background-color: #f8fafc; font-weight: bold;">Lý do hủy:</td>
                  <td style="padding: 12px;">${cancelReason}</td>
                </tr>
              </table>
              <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">
                <p style="margin: 0;">Email này được gửi tự động từ Hệ thống Đăng ký Suất ăn Trường Ngôi Sao Hoàng Mai.</p>
                <p style="margin: 4px 0 0 0;">Vui lòng không phản hồi lại email này.</p>
              </div>
            </div>
          `
        })
      });

      if (!response.ok) {
        console.error('Email sending failed');
      }

      try {
        const now = new Date();
        const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')} ${now.getDate().toString().padStart(2, '0')}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;

        const gasUrl = 'https://script.google.com/macros/s/AKfycbxwWwLIUDdFzDqIz5yWxnRWcYJDVMHl6yPr9tTkbyPzXiyubzF8D3rHTLeTjpcZxE51/exec';

        await fetch(gasUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8',
          },
          body: JSON.stringify({
            employeeId: staffData.employeeId || '',
            fullName: staffData.fullName || '',
            department: staffData.department || '',
            cancelDate: formattedDate,
            cancelMeal: cancelMeal,
            cancelReason: cancelReason,
            cancelCanteen: cancelCanteen
          }),
        });
      } catch (err) {
        console.error('Failed to send data to Google Sheets', err);
      }

      setSubmitStatus({
        type: 'success',
        message: 'Gửi yêu cầu hủy đăng ký thành công! (Dữ liệu đã được lưu trữ & Gửi email)'
      });
      setCancelDate('');
      setCancelMeal('');
      setCancelReason('');
      setCancelCanteen('');
      setTimeout(() => setSubmitStatus(null), 5000);
    } catch (e: any) {
      console.error(e);
      setSubmitStatus({ type: 'error', message: 'Lỗi: ' + (e.message || 'Thử lại sau') });
    } finally {
      setIsCanceling(false);
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
              <h2 className="font-headline-lg-mobile md:text-headline-lg text-headline-lg text-primary">ĐK ĂN HÀNG THÁNG</h2>
              <p className="font-body-md text-body-md text-on-surface-variant mt-xs text-[13px] md:text-[14px]">Chọn bữa ăn thầy/cô muốn đăng ký ăn tại trường</p>
            </div>
            {/* Month Selector */}
            <div className="w-full md:w-auto flex items-center justify-between gap-md bg-surface-container-lowest md:bg-surface border border-outline-variant rounded-lg p-sm shadow-[0_2px_4px_-1px_rgba(26,54,93,0.03)]">
              <button 
                onClick={handlePrevMonth}
                className="p-xs hover:bg-surface-container rounded transition-colors text-on-surface-variant flex items-center justify-center">
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <span className="font-headline-sm text-headline-sm text-primary min-w-[120px] text-center">Tháng {monthString}, {selectedYear}</span>
              <button 
                onClick={handleNextMonth}
                className="p-xs hover:bg-surface-container rounded transition-colors text-on-surface-variant flex items-center justify-center">
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
          </div>

          {/* Bento Grid Layout for Content */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-md md:gap-gutter px-md md:px-0">
            {/* Calendar View */}
            <div className="lg:col-span-2 bg-surface-container-lowest md:bg-surface rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),_0_2px_4px_-1px_rgba(26,54,93,0.03)] flex flex-col h-full flex-shrink-0">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-md">
                <div className="flex bg-surface-variant/30 p-1.5 rounded-xl border border-outline-variant/50 w-full md:w-auto">
                  <button 
                    onClick={() => setActiveMainTab('register')}
                    className={clsx(
                      "flex-1 md:flex-none px-6 py-2.5 rounded-lg font-headline-sm font-bold text-[14px] transition-all duration-200 flex items-center justify-center gap-2",
                      activeMainTab === 'register' ? "bg-primary text-white shadow" : "text-on-surface-variant hover:text-primary hover:bg-surface-variant/50"
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
                    ĐĂNG KÝ HÀNG THÁNG
                  </button>
                  <button 
                    onClick={() => setActiveMainTab('cancel')}
                    className={clsx(
                      "flex-1 md:flex-none px-6 py-2.5 rounded-lg font-headline-sm font-bold text-[14px] transition-all duration-200 flex items-center justify-center gap-2",
                      activeMainTab === 'cancel' ? "bg-[#b00f2c] text-white shadow" : "text-[#b00f2c] opacity-80 hover:opacity-100 hover:bg-[#b00f2c]/10"
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">event_busy</span>
                    HỦY ĐĂNG KÝ
                  </button>
                </div>
              </div>

              {activeMainTab === 'register' ? (
                <div className="space-y-md">
                  <div className="space-y-sm">
                    <h4 className="font-headline-sm text-headline-sm text-primary uppercase border-b border-outline-variant pb-xs">THÁNG {monthString}/{selectedYear}</h4>
                    
                    {/* Day Row 1 */}
                    <div className="flex flex-col md:flex-row items-start md:items-center justify-between p-md bg-surface-container-low rounded-xl border border-outline-variant gap-md hover:bg-surface-container-low/80 transition-colors">
                        <div className="flex items-center gap-md">
                          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary">
                            <span className="material-symbols-outlined text-[24px]">bakery_dining</span>
                          </div>
                          <div>
                            <h5 className="font-headline-sm text-[16px] text-on-surface font-bold">ĐĂNG KÝ ĂN BỮA SÁNG + TRƯA</h5>
                            <p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">Áp dụng cho tất cả các ngày từ Thứ 2 đến Thứ 6</p>
                          </div>
                        </div>
                        
                        <div className="flex gap-md w-full md:w-auto mt-2 md:mt-0 justify-end md:justify-center">
                          <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                            <input 
                              type="radio" 
                              name="breakfast" 
                              checked={breakfastChoice === 'yes'}
                              onChange={() => {
                                setBreakfastChoice('yes');
                                setLunchChoice('no');
                              }}
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
                            <h5 className="font-headline-sm text-[16px] text-on-surface font-bold">ĐĂNG KÝ CHỈ ĂN BỮA TRƯA</h5>
                            <p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">Áp dụng cho tất cả các ngày từ Thứ 2 đến Thứ 6</p>
                          </div>
                        </div>
                        
                        <div className="flex gap-md w-full md:w-auto mt-2 md:mt-0 justify-end md:justify-center">
                          <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                            <input 
                              type="radio" 
                              name="lunch" 
                              checked={lunchChoice === 'yes'}
                              onChange={() => {
                                setLunchChoice('yes');
                                setBreakfastChoice('no');
                              }}
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
              </div>
              ) : (
                <div className="space-y-md flex-1">
                  <div className="p-md bg-surface-container-low rounded-xl border border-outline-variant grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-2 relative">
                      <label className="font-label-md text-on-surface">Ngày hủy suất ăn <span className="text-error">*</span></label>
                      <input 
                        type="date" 
                        value={cancelDate}
                        min={getMinCancelDate()}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) {
                            const day = new Date(val).getDay();
                            if (day === 0 || day === 6) {
                              setSubmitStatus({ type: 'error', message: 'Không thể chọn Thứ 7 hoặc Chủ Nhật (ngày nghỉ) để hủy ăn.' });
                              setCancelDate('');
                              return;
                            }
                          }
                          setSubmitStatus(null);
                          setCancelDate(val);
                        }}
                        className="bg-surface border border-outline-variant rounded-lg p-2 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                      />
                      <span className="text-[12px] italic font-bold text-[#D21235] leading-tight">Yêu cầu hủy trước 16:00 ngày hôm trước</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="font-label-md text-on-surface">Bữa muốn hủy <span className="text-error">*</span></label>
                      <select 
                        value={cancelMeal}
                        onChange={(e) => setCancelMeal(e.target.value)}
                        className="bg-surface border border-outline-variant rounded-lg p-2 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                      >
                        <option value="">-- Chọn bữa --</option>
                        <option value="breakfast">Bữa sáng</option>
                        <option value="lunch">Bữa trưa</option>
                        <option value="both">Cả 2 bữa (Sáng + Trưa)</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-2 md:col-span-2">
                      <label className="font-label-md text-on-surface">Nhà ăn <span className="text-error">*</span></label>
                      <select 
                        value={cancelCanteen}
                        onChange={(e) => setCancelCanteen(e.target.value)}
                        className="bg-surface border border-outline-variant rounded-lg p-2 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                      >
                        <option value="">-- Chọn nhà ăn --</option>
                        <option value="tieuhoc">Nhà ăn Tiểu học</option>
                        <option value="trunghoc">Nhà ăn Trung học</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-2 md:col-span-2">
                      <label className="font-label-md text-on-surface">Lý do hủy ăn <span className="text-error">*</span></label>
                      <textarea 
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        placeholder="Nhập lý do hủy đăng ký ăn..."
                        className="bg-surface border border-outline-variant rounded-lg p-2 min-h-[80px] focus:ring-1 focus:ring-primary focus:border-primary outline-none resize-y"
                      ></textarea>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Summary Card */}
            <div className="lg:col-span-1 bg-surface-bright rounded-xl border border-outline-variant p-md md:p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] flex flex-col mb-24 h-max">
              {activeMainTab === 'register' ? (
                <>
                  <h3 className="font-headline-sm text-headline-sm text-primary mb-lg pb-sm border-b border-outline-variant">Tổng kết tháng</h3>
                  
                  {isUserBlocked && (
                    <div className="mb-4 p-sm rounded-lg font-body-md text-body-md flex items-start gap-2 bg-error-container text-error">
                      <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
                      <p>Thầy/Cô đã vi phạm quy định chấm ăn! Không được đăng ký ăn trong tháng này.</p>
                    </div>
                  )}

                  {!isMonthOpen && !isUserBlocked && (
                    <div className="mb-4 p-sm rounded-lg font-body-md text-body-md flex items-start gap-2 bg-error-container text-error opacity-80">
                      <span className="material-symbols-outlined text-[18px] mt-0.5">info</span>
                      <p>Tháng này hiện không mở đăng ký. Vui lòng liên hệ Bộ phận Dinh dưỡng để được hỗ trợ.</p>
                    </div>
                  )}

                  <div className="space-y-md flex-1">
                    <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                      <div className="flex items-center gap-sm">
                        <span className="material-symbols-outlined text-on-surface-variant">free_breakfast</span>
                        <span className="font-body-md text-body-md text-on-surface">Bữa sáng</span>
                      </div>
                      <span className="font-headline-md text-headline-md text-primary">
                        {breakfastChoice === 'yes' ? weekdaysCount : 0} <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                      </span>
                    </div>
                    <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                      <div className="flex items-center gap-sm">
                        <span className="material-symbols-outlined text-on-surface-variant">restaurant</span>
                        <span className="font-body-md text-body-md text-on-surface">Bữa trưa</span>
                      </div>
                      <span className="font-headline-md text-headline-md text-primary">
                        {breakfastChoice === 'yes' || lunchChoice === 'yes' ? weekdaysCount : 0} <span className="font-body-md text-body-md text-on-surface-variant">suất</span>
                      </span>
                    </div>
                  </div>
                  
                  <button 
                    onClick={handleRegister}
                    disabled={isSubmitting || isUserBlocked}
                    className={clsx(
                      "w-full mt-xl font-headline-sm text-headline-sm py-md rounded-lg transition-colors shadow-sm flex items-center justify-center gap-sm duration-100 disabled:opacity-60 disabled:cursor-not-allowed",
                      (!isMonthOpen || isUserBlocked)
                        ? "bg-surface-variant text-on-surface-variant opacity-70 hover:opacity-80" 
                        : "bg-primary text-on-primary hover:bg-primary-container hover:text-on-primary-container active:scale-95"
                    )}
                  >
                    {isSubmitting ? (
                      <span className="material-symbols-outlined animate-spin">refresh</span>
                    ) : (
                      <span className="material-symbols-outlined">check_circle</span>
                    )}
                    {isSubmitting ? 'Đang gửi...' : 'Xác nhận đăng ký'}
                  </button>
                </>
              ) : (
                <>
                  <h3 className="font-headline-sm text-headline-sm text-error mb-lg pb-sm border-b border-outline-variant">Xác nhận</h3>
                  <div className="space-y-md flex-1">
                    <p className="font-body-md text-on-surface-variant text-[14px]">
                      Vui lòng kiểm tra kỹ các thông tin trước khi xác nhận hủy ăn. Sau khi gửi, thông tin sẽ được ghi nhận và gửi đến Bộ phận Dinh dưỡng.
                    </p>
                  </div>
                  <button 
                    onClick={handleCancel}
                    disabled={isCanceling}
                    className={clsx(
                      "w-full mt-xl font-headline-sm text-headline-sm py-md rounded-lg transition-colors shadow-sm flex items-center justify-center gap-sm duration-100 disabled:opacity-60 disabled:cursor-not-allowed",
                      "bg-error text-on-error hover:bg-[#b00f2c] active:scale-95"
                    )}
                  >
                    {isCanceling ? (
                      <span className="material-symbols-outlined animate-spin">refresh</span>
                    ) : (
                      <span className="material-symbols-outlined">cancel</span>
                    )}
                    {isCanceling ? 'Đang gửi...' : 'Xác nhận hủy ăn'}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      </main>
      {/* Professional Notification Modal */}
      {submitStatus && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setSubmitStatus(null)}></div>
          <div className={clsx(
            "relative w-[min(calc(100vw-32px),384px)] bg-surface rounded-[28px] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 border border-outline-variant",
            submitStatus.type === 'error' ? "border-error/20" : "border-primary/20"
          )}>
            <div className="p-xl text-center flex flex-col items-center">
              <div className={clsx(
                "w-20 h-20 rounded-full flex items-center justify-center mb-md shadow-sm border-4 border-surface",
                submitStatus.type === 'success' ? "bg-green-100 text-green-600" : (submitStatus.type === 'info' ? "bg-blue-100 text-blue-600" : "bg-error-container text-on-error-container")
              )}>
                <span className="material-symbols-outlined text-[48px]">
                  {submitStatus.type === 'success' ? 'check_circle' : (submitStatus.type === 'info' ? 'info' : 'error')}
                </span>
              </div>
              
              <h3 className={clsx(
                "font-headline-sm text-headline-sm mb-sm",
                submitStatus.type === 'success' ? "text-green-800" : (submitStatus.type === 'info' ? "text-blue-800" : "text-error")
              )}>
                {submitStatus.type === 'success' ? 'Thành công!' : 'Thông báo'}
              </h3>
              
              <p className={clsx(
                "font-body-md text-body-md mb-xl",
                submitStatus.type === 'error' ? "text-error" : "text-on-surface-variant"
              )}>
                {submitStatus.message}
              </p>
              
              <button 
                onClick={() => setSubmitStatus(null)}
                className={clsx(
                  "w-full py-3 rounded-xl font-label-lg text-label-lg transition-colors shadow-sm",
                  submitStatus.type === 'success' 
                    ? "bg-primary text-on-primary hover:bg-primary/90" 
                    : (submitStatus.type === 'info' ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-error text-on-error hover:bg-error/90")
                )}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
      <Footer />
    </div>
  );
}
