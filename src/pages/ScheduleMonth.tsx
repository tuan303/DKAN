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

import DatePickerDefault from "react-multi-date-picker";
import "react-multi-date-picker/styles/layouts/mobile.css";

const DatePicker = (DatePickerDefault as any).default || DatePickerDefault;

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
  const [cancelDates, setCancelDates] = useState<any[]>([]);
  const [cancelMeal, setCancelMeal] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelCanteen, setCancelCanteen] = useState('');
  const [isCanceling, setIsCanceling] = useState(false);
  
  const [userRegistrationForCancel, setUserRegistrationForCancel] = useState<any>(null);
  const [isCheckingRegistration, setIsCheckingRegistration] = useState(false);
  
  const [cancelExtendUntil, setCancelExtendUntil] = useState<string>('');

  const getStandardDateString = (d: any) => {
    if (d?.year && d?.month?.number && d?.day) {
      return `${d.year}-${String(d.month.number).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    }
    const dObj = new Date(d);
    if (!isNaN(dObj.getTime())) {
      return `${dObj.getFullYear()}-${String(dObj.getMonth() + 1).padStart(2, '0')}-${String(dObj.getDate()).padStart(2, '0')}`;
    }
    if (typeof d === 'string') {
      const parts = d.split('/');
      if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
      return d;
    }
    return '';
  };

  const getMinCancelDateObj = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    
    // The user requested that if today is 16/07, they cannot cancel 15/07.
    // The previous rule "before 16:00" might be too strict if they just want to block past days.
    // However, I will keep the 16:00 rule based on the UI text.
    let isLockedForTomorrow = new Date().getHours() >= 16;
    
    if (cancelExtendUntil) {
      const extendDate = new Date(cancelExtendUntil);
      if (new Date() < extendDate) {
        isLockedForTomorrow = false;
      }
    }

    if (isLockedForTomorrow) {
      d.setDate(d.getDate() + 2);
    } else {
      d.setDate(d.getDate() + 1);
    }
    return d;
  };

  const getMinCancelDate = () => {
    const d = getMinCancelDateObj();
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
      } else if (!user) {
        // Đăng xuất hoặc hết phiên: đưa về trang đăng nhập thay vì đứng lại
        // ở màn hình không còn quyền đọc dữ liệu.
        window.location.replace('/login');
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

  useEffect(() => {
    const fetchCancelMonthRegistration = async () => {
      if (!cancelDates || cancelDates.length === 0) {
        setUserRegistrationForCancel(null);
        return;
      }
      const firstDateStr = getStandardDateString(cancelDates[0]);
      const user = auth.currentUser;
      if (!user) return;
      
      setIsCheckingRegistration(true);
      const dateParts = firstDateStr.split('-');
      const yyyy = dateParts[0];
      const mm = (parseInt(dateParts[1], 10)).toString().padStart(2, '0');
      try {
        const regDocRef = doc(db, 'registrations', `${user.uid}_${yyyy}-${mm}`);
        const regDocSnap = await getDoc(regDocRef);
        if (regDocSnap.exists()) {
          const data = regDocSnap.data();
          if ((data.breakfastCount || 0) > 0 && (data.lunchCount || 0) === 0) {
            data.lunchCount = data.breakfastCount;
          }
          setUserRegistrationForCancel(data);
        } else {
          setUserRegistrationForCancel(null);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsCheckingRegistration(false);
      }
    };
    fetchCancelMonthRegistration();
  }, [cancelDates]);

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

      const cancelConfigDoc = await getDoc(doc(db, 'settings', 'cancelConfig'));
      if (cancelConfigDoc.exists()) {
        setCancelExtendUntil(cancelConfigDoc.data().extendUntil || '');
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
    const lunchCount = (breakfastChoice === 'yes' || lunchChoice === 'yes') ? weekdaysCount : 0;

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
                    <li>Để hủy đăng ký suất ăn, thầy/cô vui lòng thực hiện thao tác tại mục Hủy ăn trên hệ thống trước 16h00 của ngày hôm trước.</li>
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
    if (!cancelDates || cancelDates.length === 0 || !cancelMeal || !cancelReason || !cancelCanteen) {
      setSubmitStatus({ type: 'error', message: 'Vui lòng điền đầy đủ thông tin hủy đăng ký ăn.' });
      return;
    }

    const minDateStr = getMinCancelDate();
    const invalidDates = cancelDates
      .map(d => getStandardDateString(d))
      .filter(d => d < minDateStr);

    if (invalidDates.length > 0) {
      const lockTimeDisplay = cancelExtendUntil ? new Date(cancelExtendUntil).toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'}) : '16h00';
      setSubmitStatus({ 
        type: 'error', 
        message: `Không hợp lệ! Hủy ăn ngày mai phải đăng ký trước ${lockTimeDisplay} ngày hôm nay. (Ngày bị lỗi: ${invalidDates.join(', ')})` 
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

      const dateStrings = cancelDates.map(d => getStandardDateString(d));
      const alreadyCanceledDates: string[] = [];
      const formattedDates: string[] = [];

      for (const dateStr of dateStrings) {
        const cancelDocRef = doc(db, 'cancel_registrations', `${user.uid}_${dateStr}`);
        const cancelDocSnap = await getDoc(cancelDocRef);
        if (cancelDocSnap.exists()) {
          alreadyCanceledDates.push(dateStr);
        } else {
          const dateParts = dateStr.split('-');
          formattedDates.push(`${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`);
        }
      }

      if (alreadyCanceledDates.length > 0) {
        setSubmitStatus({
          type: 'info',
          message: `Một số ngày đã được đăng ký hủy từ trước: ${alreadyCanceledDates.join(', ')}. Vui lòng bỏ chọn các ngày này.`
        });
        setIsCanceling(false);
        return;
      }

      const promises = dateStrings.map(async (dateStr, index) => {
        const cancelDocRef = doc(db, 'cancel_registrations', `${user.uid}_${dateStr}`);
        const formattedDate = formattedDates[index];
        await setDoc(cancelDocRef, {
          userId: user.uid,
          fullName: staffData.fullName,
          employeeId: staffData.employeeId,
          department: staffData.department,
          email: user.email,
          cancelDate: dateStr,
          formattedDate,
          cancelMeal,
          cancelReason,
          cancelCanteen,
          timestamp: new Date().toISOString()
        });
      });

      await Promise.all(promises);

      const toEmail = userEmail || staffData.email || user?.email || 'tuan303@gmail.com';
      const toRecipients = `dinhduong@hoangmaistarschool.edu.vn, ${toEmail}`;
      const formattedDateList = formattedDates.join('<br>');
      const formattedDateListText = formattedDates.join(', ');

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
                  <td style="padding: 12px; color: #D21235; font-weight: bold;">${formattedDateList}</td>
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

        const gasPromises = dateStrings.map(async (dateStr, index) => {
          return fetch('/api/gas', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              'Mã Nhân Viên': staffData.employeeId || '',
              'Họ và Tên': staffData.fullName || '',
              'Phòng ban/Tổ khối': staffData.department || '',
              'Ngày hủy': formattedDates[index],
              'Bữa hủy': cancelMeal === 'both' ? 'Cả 2 bữa' : (cancelMeal === 'breakfast' ? 'Sáng' : 'Trưa'),
              'Nhà ăn': cancelCanteen === 'trunghoc' ? 'Trung học' : 'Tiểu học',
              'Lý do': cancelReason,
              'Thời gian khai báo hủy': timeString,
              
              // Send backward-compatible keys just in case GAS hasn't been deployed
              employeeId: staffData.employeeId || '',
              fullName: staffData.fullName || '',
              department: staffData.department || '',
              cancelDate: formattedDates[index],
              cancelMeal: cancelMeal,
              cancelReason: cancelReason,
              cancelCanteen: cancelCanteen,
              timestamp: timeString
            }),
          });
        });
        await Promise.all(gasPromises);
      } catch (err) {
        console.error('Failed to send data to Google Sheets', err);
      }

      setSubmitStatus({
        type: 'success',
        message: 'Gửi yêu cầu hủy đăng ký thành công cho các ngày: ' + formattedDateListText
      });
      setCancelDates([]);
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
              <h2 className="text-headline-md md:text-headline-lg text-primary">ĐK ĂN HÀNG THÁNG</h2>
              <p className="text-body-md text-on-surface-variant mt-xs text-[13px] md:text-[14px]">Chọn bữa ăn thầy/cô muốn đăng ký ăn tại trường</p>
            </div>
            {/* Month Selector */}
            <div className="w-full md:w-auto flex items-center justify-between gap-md bg-surface-container-lowest md:bg-surface border border-outline-variant rounded-lg p-sm shadow-xs">
              <button 
                onClick={handlePrevMonth}
                className="p-xs hover:bg-surface-container rounded transition-colors text-on-surface-variant flex items-center justify-center">
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <span className="text-headline-sm text-primary min-w-[120px] text-center">Tháng {monthString}, {selectedYear}</span>
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
              {/* Chỉ tab đang mở mới được tô đầy. Trước đây tab không hoạt động
                  cũng tô cùng màu ở 70% nên nhìn như cả hai đang cùng mở. */}
              <div className="flex w-full gap-1 border-b border-outline-variant mb-6 pt-2 px-2 bg-surface-container-low rounded-t-xl -mx-4 md:-mx-6 -mt-4 md:-mt-6 flex-wrap md:flex-nowrap">
                  <button
                    onClick={() => setActiveMainTab('register')}
                    aria-pressed={activeMainTab === 'register'}
                    className={clsx(
                      "relative px-6 py-2.5 rounded-t-lg text-label-lg uppercase transition-colors flex items-center justify-center gap-2 flex-1 md:flex-none md:min-w-[220px] border-t border-x",
                      activeMainTab === 'register'
                        ? "bg-primary border-primary !border-b-primary text-on-primary z-10 -mb-[1px] shadow-sm"
                        : "bg-transparent border-transparent text-on-surface-variant hover:bg-primary/10 hover:text-primary"
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">edit_calendar</span>
                    Đăng ký hàng tháng
                  </button>
                  <button
                    onClick={() => setActiveMainTab('cancel')}
                    aria-pressed={activeMainTab === 'cancel'}
                    className={clsx(
                      "relative px-6 py-2.5 rounded-t-lg text-label-lg uppercase transition-colors flex items-center justify-center gap-2 flex-1 md:flex-none md:min-w-[220px] border-t border-x",
                      activeMainTab === 'cancel'
                        ? "bg-secondary border-secondary !border-b-secondary text-on-secondary z-10 -mb-[1px] shadow-sm"
                        : "bg-transparent border-transparent text-on-surface-variant hover:bg-secondary/10 hover:text-secondary"
                    )}
                  >
                    <span className="material-symbols-outlined text-[18px]">event_busy</span>
                    Hủy đăng ký ăn
                  </button>
              </div>

              {activeMainTab === 'register' ? (
                <div className="space-y-md">
                  <div className="space-y-sm">
                    <h4 className="text-headline-sm text-primary uppercase border-b border-outline-variant pb-xs">THÁNG {monthString}/{selectedYear}</h4>
                    
                    {/* Day Row 1 */}
                    <div className="flex flex-col md:flex-row items-start md:items-center justify-between p-md bg-surface-container-low rounded-xl border border-outline-variant gap-md hover:bg-surface-container-low/80 transition-colors">
                        <div className="flex items-center gap-md">
                          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center text-primary">
                            <span className="material-symbols-outlined text-[24px]">bakery_dining</span>
                          </div>
                          <div>
                            <h5 className="font-headline-sm text-[16px] text-on-surface font-bold">ĐĂNG KÝ ĂN BỮA SÁNG + TRƯA</h5>
                            <p className="text-body-md text-on-surface-variant text-[13px] mt-0.5">Áp dụng cho tất cả các ngày từ Thứ 2 đến Thứ 6</p>
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
                            <span className="text-label-md text-on-surface select-none">Có ăn</span>
                          </label>
                          <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                            <input 
                              type="radio" 
                              name="breakfast" 
                              checked={breakfastChoice === 'no'}
                              onChange={() => setBreakfastChoice('no')}
                              className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer" 
                            />
                            <span className="text-label-md text-on-surface select-none">Không ăn</span>
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
                            <p className="text-body-md text-on-surface-variant text-[13px] mt-0.5">Áp dụng cho tất cả các ngày từ Thứ 2 đến Thứ 6</p>
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
                            <span className="text-label-md text-on-surface select-none">Có ăn</span>
                          </label>
                          <label className="flex items-center gap-sm cursor-pointer hover:bg-surface-container p-2 rounded-lg transition-colors">
                            <input 
                              type="radio" 
                              name="lunch" 
                              checked={lunchChoice === 'no'}
                              onChange={() => setLunchChoice('no')}
                              className="w-5 h-5 border-outline-variant text-primary focus:ring-primary focus:ring-2 bg-surface cursor-pointer" 
                            />
                            <span className="text-label-md text-on-surface select-none">Không ăn</span>
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
                      <DatePicker 
                        multiple
                        value={cancelDates}
                        onChange={(dates: any) => {
                          const validDates = [];
                          for (const d of (dates as any[] || [])) {
                            const dateObj = new Date(getStandardDateString(d));
                            const day = dateObj.getDay();
                            if (day === 0 || day === 6) {
                              setSubmitStatus({ type: 'error', message: 'Không thể chọn Thứ 7 hoặc Chủ Nhật (ngày nghỉ) để hủy ăn.' });
                              return;
                            }
                            validDates.push(d);
                          }
                          setSubmitStatus(null);
                          setCancelDates(validDates);
                        }}
                        format="DD/MM/YYYY"
                        placeholder="Chọn các ngày hủy (có thể chọn nhiều)"
                        minDate={getMinCancelDateObj()}
                        containerClassName="w-full"
                        inputClass="w-full bg-surface border border-outline-variant rounded-lg p-2 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                      />
                      <span className="text-[12px] italic font-bold text-secondary leading-tight">Yêu cầu hủy trước {cancelExtendUntil ? new Date(cancelExtendUntil).toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'}) : '16:00'} ngày hôm trước</span>
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="font-label-md text-on-surface">Bữa muốn hủy <span className="text-error">*</span></label>
                      <select 
                        value={cancelMeal}
                        onChange={(e) => setCancelMeal(e.target.value)}
                        className="bg-surface border border-outline-variant rounded-lg p-2 focus:ring-1 focus:ring-primary focus:border-primary outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={cancelDates.length === 0 || isCheckingRegistration || !userRegistrationForCancel || (userRegistrationForCancel.breakfastCount === 0 && userRegistrationForCancel.lunchCount === 0)}
                      >
                        <option value="">-- Chọn bữa --</option>
                        {userRegistrationForCancel?.breakfastCount > 0 && <option value="breakfast">Bữa sáng</option>}
                        {userRegistrationForCancel?.lunchCount > 0 && <option value="lunch">Bữa trưa</option>}
                        {userRegistrationForCancel?.breakfastCount > 0 && userRegistrationForCancel?.lunchCount > 0 && <option value="both">Cả 2 bữa (Sáng + Trưa)</option>}
                      </select>
                      {cancelDates.length > 0 && !isCheckingRegistration && (!userRegistrationForCancel || (userRegistrationForCancel.breakfastCount === 0 && userRegistrationForCancel.lunchCount === 0)) && (
                        <span className="text-[12px] italic font-bold text-error leading-tight">Bạn chưa đăng ký ăn trong tháng của ngày đầu tiên đã chọn.</span>
                      )}
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
            <div className="lg:col-span-1 bg-surface-bright rounded-xl border border-outline-variant p-md md:p-lg shadow-sm flex flex-col mb-24 h-max">
              {activeMainTab === 'register' ? (
                <>
                  <h3 className="text-headline-sm text-primary mb-lg pb-sm border-b border-outline-variant">Tổng kết tháng</h3>
                  
                  {isUserBlocked && (
                    <div className="mb-4 p-sm rounded-lg text-body-md flex items-start gap-2 bg-error-container text-error">
                      <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
                      <p>Thầy/Cô đã vi phạm quy định chấm ăn! Không được đăng ký ăn trong tháng này.</p>
                    </div>
                  )}

                  {!isMonthOpen && !isUserBlocked && (
                    <div className="mb-4 p-sm rounded-lg text-body-md flex items-start gap-2 bg-error-container text-error opacity-80">
                      <span className="material-symbols-outlined text-[18px] mt-0.5">info</span>
                      <p>Tháng này hiện không mở đăng ký. Vui lòng liên hệ Bộ phận Dinh dưỡng để được hỗ trợ.</p>
                    </div>
                  )}

                  <div className="space-y-md flex-1">
                    <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                      <div className="flex items-center gap-sm">
                        <span className="material-symbols-outlined text-on-surface-variant">free_breakfast</span>
                        <span className="text-body-md text-on-surface">Bữa sáng</span>
                      </div>
                      <span className="text-headline-md text-primary">
                        {breakfastChoice === 'yes' ? weekdaysCount : 0} <span className="text-body-md text-on-surface-variant">suất</span>
                      </span>
                    </div>
                    <div className="flex justify-between items-center bg-surface p-md rounded-lg border border-outline-variant">
                      <div className="flex items-center gap-sm">
                        <span className="material-symbols-outlined text-on-surface-variant">restaurant</span>
                        <span className="text-body-md text-on-surface">Bữa trưa</span>
                      </div>
                      <span className="text-headline-md text-primary">
                        {breakfastChoice === 'yes' || lunchChoice === 'yes' ? weekdaysCount : 0} <span className="text-body-md text-on-surface-variant">suất</span>
                      </span>
                    </div>
                  </div>
                  
                  <button 
                    onClick={handleRegister}
                    disabled={isSubmitting || isUserBlocked}
                    className={clsx(
                      "w-full mt-xl text-headline-sm py-md rounded-lg transition-colors shadow-sm flex items-center justify-center gap-sm duration-100 disabled:opacity-60 disabled:cursor-not-allowed",
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
                  <h3 className="text-headline-sm text-error mb-lg pb-sm border-b border-outline-variant">Xác nhận</h3>
                  <div className="space-y-md flex-1">
                    <p className="font-body-md text-on-surface-variant text-[14px]">
                      Vui lòng kiểm tra kỹ các thông tin trước khi xác nhận hủy ăn. Sau khi gửi, thông tin sẽ được ghi nhận và gửi đến Bộ phận Dinh dưỡng.
                    </p>
                  </div>
                  <button 
                    onClick={handleCancel}
                    disabled={isCanceling || cancelDates.length === 0 || isCheckingRegistration || !userRegistrationForCancel || (userRegistrationForCancel.breakfastCount === 0 && userRegistrationForCancel.lunchCount === 0)}
                    className={clsx(
                      "w-full mt-xl text-headline-sm py-md rounded-lg transition-colors shadow-sm flex items-center justify-center gap-sm duration-100 disabled:opacity-60 disabled:cursor-not-allowed",
                      "bg-error text-on-error hover:bg-secondary-dark active:scale-95"
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
                submitStatus.type === 'success' ? "bg-tertiary-container text-on-tertiary-container" : (submitStatus.type === 'info' ? "bg-primary-container text-on-primary-container" : "bg-error-container text-on-error-container")
              )}>
                <span className="material-symbols-outlined text-[48px]">
                  {submitStatus.type === 'success' ? 'check_circle' : (submitStatus.type === 'info' ? 'info' : 'error')}
                </span>
              </div>
              
              <h3 className={clsx(
                "text-headline-sm mb-sm",
                submitStatus.type === 'success' ? "text-on-tertiary-container" : (submitStatus.type === 'info' ? "text-on-primary-container" : "text-error")
              )}>
                {submitStatus.type === 'success' ? 'Thành công!' : 'Thông báo'}
              </h3>
              
              <p className={clsx(
                "text-body-md mb-xl",
                submitStatus.type === 'error' ? "text-error" : "text-on-surface-variant"
              )}>
                {submitStatus.message}
              </p>
              
              <button 
                onClick={() => setSubmitStatus(null)}
                className={clsx(
                  "w-full py-3 rounded-xl text-label-lg transition-colors shadow-sm",
                  submitStatus.type === 'success' 
                    ? "bg-primary text-on-primary hover:bg-primary/90" 
                    : (submitStatus.type === 'info' ? "bg-primary text-on-primary hover:bg-primary-dark" : "bg-error text-on-error hover:bg-error/90")
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
