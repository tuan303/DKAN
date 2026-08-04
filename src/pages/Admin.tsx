import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auth, db } from '../lib/firebase';
import { collection, query, where, getDocs, doc, setDoc, updateDoc, deleteDoc, addDoc, getDoc, onSnapshot } from 'firebase/firestore';
import * as xlsx from 'xlsx';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

function useSortableData(items: any[], initialConfig = null) {
  const [sortConfig, setSortConfig] = useState<{key: string, direction: 'asc' | 'desc'} | null>(initialConfig);

  const sortedItems = useMemo(() => {
    let sortableItems = [...items];
    if (sortConfig !== null) {
      sortableItems.sort((a, b) => {
        let aValue = a[sortConfig.key];
        let bValue = b[sortConfig.key];
        
        if (aValue === undefined || aValue === null) aValue = '';
        if (bValue === undefined || bValue === null) bValue = '';
        
        if (sortConfig.key === 'timestamp' || sortConfig.key === 'createdAt' || sortConfig.key === 'cancelTime') {
          const timeA = aValue ? new Date(aValue).getTime() : 0;
          const timeB = bValue ? new Date(bValue).getTime() : 0;
          return sortConfig.direction === 'asc' ? timeA - timeB : timeB - timeA;
        }

        const numA = parseInt(aValue, 10);
        const numB = parseInt(bValue, 10);
        if (sortConfig.key === 'employeeId' || sortConfig.key === 'adjustedBreakfastCount' || sortConfig.key === 'adjustedLunchCount') {
          if (!isNaN(numA) && !isNaN(numB)) {
              return sortConfig.direction === 'asc' ? numA - numB : numB - numA;
          }
        }

        const strA = String(aValue).toLowerCase();
        const strB = String(bValue).toLowerCase();
        
        if (strA < strB) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (strA > strB) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableItems;
  }, [items, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  return { items: sortedItems, requestSort, sortConfig };
}

const SortIcon = ({ sortConfig, columnKey }: { sortConfig: any, columnKey: string }) => {
    if (!sortConfig || sortConfig.key !== columnKey) {
      return <span className="material-symbols-outlined text-[16px] text-outline opacity-40">unfold_more</span>;
    }
    return (
      <span className="material-symbols-outlined text-[16px] text-primary">
        {sortConfig.direction === 'asc' ? 'arrow_upward' : 'arrow_downward'}
      </span>
    );
};

interface RegistrationData {
  id?: string;
  userId: string;
  fullName: string;
  employeeId: string;
  department: string;
  email: string;
  breakfastCount: number;
  lunchCount: number;
  timestamp?: string;
}

interface AdminData {
  id?: string;
  email: string;
}

interface EventData {
  id: string;
  name: string;
  isOpen: boolean;
  expiresAt?: string;
}

// Phải khớp với hàm isSuperAdmin() trong firestore.rules, nếu không giao diện sẽ
// cho vào trang quản trị nhưng Firestore lại từ chối mọi thao tác ghi.
const SUPER_ADMINS = ['tuantm@hoangmaistarschool.edu.vn', 'tuyetkta@hoangmaistarschool.edu.vn', 'tuan303@gmail.com'];
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

type AdminTabKey = 'monthly' | 'daily_stats' | 'cancelations' | 'events' | 'blocked' | 'settings' | 'admins';

const ADMIN_TABS: { key: AdminTabKey; label: string; icon: string }[] = [
  { key: 'monthly', label: 'ĐK ăn hàng tháng', icon: 'calendar_month' },
  { key: 'daily_stats', label: 'DS ĐK theo ngày', icon: 'list_alt' },
  { key: 'cancelations', label: 'ĐK hủy ăn', icon: 'event_busy' },
  { key: 'events', label: 'ĐK ăn sự kiện', icon: 'celebration' },
  { key: 'blocked', label: 'Vi phạm', icon: 'gavel' },
  { key: 'settings', label: 'Cấu hình', icon: 'settings' },
  { key: 'admins', label: 'Quản trị', icon: 'admin_panel_settings' },
];

export default function Admin() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<RegistrationData[]>([]);
  const [eventRegistrations, setEventRegistrations] = useState<any[]>([]);
  const [admins, setAdmins] = useState<AdminData[]>([]);
  const [cancelations, setCancelations] = useState<any[]>([]);
  
  const [globalCancelStats, setGlobalCancelStats] = useState({
    todayStr: '', todayCount: 0, todayBreakfast: 0, todayLunch: 0,
    tomorrowStr: '', tomorrowCount: 0, tomorrowBreakfast: 0, tomorrowLunch: 0
  });

  const [newAdminEmail, setNewAdminEmail] = useState('');
  const currentDate = new Date();
  const currentMonthStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
  
  const [selectedMonth, setSelectedMonth] = useState(currentMonthStr); 
  const [selectedDay, setSelectedDay] = useState(currentDate.getDate());
  const [selectedEventId, setSelectedEventId] = useState('');
  
  // Filters for Monthly
  const [nameFilter, setNameFilter] = useState('');
  const [idFilter, setIdFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [cancelDateFilter, setCancelDateFilter] = useState('');
  const [cancelMealFilter, setCancelMealFilter] = useState<'all'|'breakfast'|'lunch'>('all');


  const [dailyFilterByMeal, setDailyFilterByMeal] = useState<'all'|'breakfast'|'lunch'>('all');

  const [addingAdmin, setAddingAdmin] = useState(false);

  // Blocked users
  const [blockedEmails, setBlockedEmails] = useState<string[]>([]);
  const [blockedEmailsInput, setBlockedEmailsInput] = useState('');

  // Tabs from URL
  const activeTab = (searchParams.get('tab') || 'monthly') as AdminTabKey;
  const setActiveTab = (tab: AdminTabKey) => setSearchParams({ tab });

  // Settings states
  const [monthlyStatus, setMonthlyStatus] = useState<Record<string, boolean>>({});
  const [monthlyExpiry, setMonthlyExpiry] = useState<Record<string, string>>({});
  const [cancelExtendUntil, setCancelExtendUntil] = useState<string>('');
  const [isSavingCancelExtend, setIsSavingCancelExtend] = useState(false);
  const [events, setEvents] = useState<EventData[]>([]);
  const [newEventName, setNewEventName] = useState('');
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editingEventName, setEditingEventName] = useState('');

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user) {
        navigate('/login');
        return;
      }
      
      try {
        let isUserAdmin = !!user.email && SUPER_ADMINS.includes(user.email.toLowerCase());
        
        if (!isUserAdmin && user.email) {
          // First check by standard doc ID
          const docId = user.email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
          const adminDoc = await getDoc(doc(db, 'admins', docId));
          if (adminDoc.exists()) {
            isUserAdmin = true;
          } else {
            // Fallback to checking the collection
            const adminsSnapshot = await getDocs(collection(db, 'admins'));
            const adminEmails = adminsSnapshot.docs.map(doc => {
              const email = doc.data().email;
              return typeof email === 'string' ? email.toLowerCase().trim() : '';
            });
            if (adminEmails.includes(user.email.toLowerCase().trim())) {
              isUserAdmin = true;
            }
          }
        }

        if (!isUserAdmin) {
          navigate('/schedule');
          return;
        }

        setIsAdmin(true);
        fetchData();
        fetchSettings();
        fetchEventRegistrations();
      } catch (err) {
        console.error('Error checking admin status:', err);
        navigate('/schedule');
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  useEffect(() => {
    let cancelUnsubscribe: any = null;
    let registrationsUnsubscribe: any = null;

    const setupRealtimeListeners = async () => {
      setLoading(true);
      try {
        const q = query(collection(db, 'registrations'), where('month', '==', selectedMonth));
        registrationsUnsubscribe = onSnapshot(q, (querySnapshot) => {
          const regData: RegistrationData[] = [];
          querySnapshot.forEach((doc) => {
            const data = doc.data() as RegistrationData;
            // Retroactive fix: If breakfast was registered but lunch wasn't (due to previous bug), 
            // it means "Sáng + Trưa" was selected.
            if ((data.breakfastCount || 0) > 0 && (data.lunchCount || 0) === 0) {
              data.lunchCount = data.breakfastCount;
            }
            regData.push({ id: doc.id, ...data });
          });
          setRegistrations(regData);
        });

        const cancelQ = query(collection(db, 'cancel_registrations'));
        cancelUnsubscribe = onSnapshot(cancelQ, (cancelSnapshot) => {
          const cancelData: any[] = [];
          
          const d1 = new Date();
          const d2 = new Date(); d2.setDate(d2.getDate() + 1);
          const f1 = `${d1.getFullYear()}-${String(d1.getMonth()+1).padStart(2,'0')}-${String(d1.getDate()).padStart(2,'0')}`;
          const f2 = `${d2.getFullYear()}-${String(d2.getMonth()+1).padStart(2,'0')}-${String(d2.getDate()).padStart(2,'0')}`;
          
          let tC=0, tB=0, tL=0;
          let tmC=0, tmB=0, tmL=0;

          cancelSnapshot.forEach((doc) => {
            const data = doc.data();
            if (data.cancelDate && data.cancelDate.startsWith(selectedMonth)) {
              cancelData.push(data);
            }
            
            if (data.cancelDate === f1) {
              tC++;
              if(data.cancelMeal === 'breakfast' || data.cancelMeal === 'both') tB++;
              if(data.cancelMeal === 'lunch' || data.cancelMeal === 'both') tL++;
            }
            if (data.cancelDate === f2) {
              tmC++;
              if(data.cancelMeal === 'breakfast' || data.cancelMeal === 'both') tmB++;
              if(data.cancelMeal === 'lunch' || data.cancelMeal === 'both') tmL++;
            }
          });
          setCancelations(cancelData);
          setGlobalCancelStats({
             todayStr: `${String(d1.getDate()).padStart(2,'0')}/${String(d1.getMonth()+1).padStart(2,'0')}/${d1.getFullYear()}`,
             todayCount: tC, todayBreakfast: tB, todayLunch: tL,
             tomorrowStr: `${String(d2.getDate()).padStart(2,'0')}/${String(d2.getMonth()+1).padStart(2,'0')}/${d2.getFullYear()}`,
             tomorrowCount: tmC, tomorrowBreakfast: tmB, tomorrowLunch: tmL
          });
        });

        const adminsSnapshot = await getDocs(collection(db, 'admins'));
        const adminData: AdminData[] = [];
        adminsSnapshot.forEach((doc) => {
          adminData.push({ id: doc.id, ...doc.data() } as AdminData);
        });
        setAdmins(adminData);
      } catch (err) {
        console.error('Error fetching admin data:', err);
      } finally {
        setLoading(false);
      }
    };

    if (isAdmin) {
      setupRealtimeListeners();
      fetchBlockedEmails();
    }

    return () => {
      if (cancelUnsubscribe) cancelUnsubscribe();
      if (registrationsUnsubscribe) registrationsUnsubscribe();
    };
  }, [selectedMonth, isAdmin]);

  const fetchBlockedEmails = async () => {
    try {
      const docRef = doc(db, 'blocked_users', selectedMonth);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        setBlockedEmails(docSnap.data().emails || []);
      } else {
        setBlockedEmails([]);
      }
    } catch (err) {
      console.error('Error fetching blocked emails:', err);
    }
  };

  const handleSaveBlockedEmails = async (emails: string[]) => {
    try {
      await setDoc(doc(db, 'blocked_users', selectedMonth), { emails });
      setBlockedEmails(emails);
      showToast('Lưu danh sách thành công!', 'success');
    } catch (err) {
      console.error('Error saving blocked emails:', err);
      showToast('Lỗi khi lưu danh sách vi phạm!', 'error');
    }
  };

  const handleAddBlockedEmails = () => {
    const newEmails = blockedEmailsInput
      .split('\n')
      .map(e => e.trim().toLowerCase())
      .filter(e => e.length > 0 && e.includes('@'));
    
    if (newEmails.length === 0) return;
    
    const uniqueEmails = Array.from(new Set([...blockedEmails, ...newEmails]));
    handleSaveBlockedEmails(uniqueEmails);
    setBlockedEmailsInput('');
  };

  const handleRemoveBlockedEmail = (emailToRemove: string) => {
    const updated = blockedEmails.filter(e => e !== emailToRemove);
    handleSaveBlockedEmails(updated);
  };

  const fetchData = async () => {
    // Only used conceptually now by add/remove admin if needed, 
    // but the real-time handles most updates. 
    // For admins we just fetch once anyway.
    try {
        const adminsSnapshot = await getDocs(collection(db, 'admins'));
        const adminData: AdminData[] = [];
        adminsSnapshot.forEach((doc) => {
          adminData.push({ id: doc.id, ...doc.data() } as AdminData);
        });
        setAdmins(adminData);
    } catch (err) {}
  };

  useEffect(() => {
    if (isAdmin && selectedEventId) fetchEventRegistrations();
  }, [selectedEventId, isAdmin]);

  const fetchEventRegistrations = async () => {
    if (!selectedEventId) {
      setEventRegistrations([]);
      return;
    }
    try {
      const q = query(collection(db, 'event_registrations'), where('eventId', '==', selectedEventId));
      const querySnapshot = await getDocs(q);
      const evRegData: any[] = [];
      querySnapshot.forEach((doc) => {
        evRegData.push({ id: doc.id, ...doc.data() });
      });
      setEventRegistrations(evRegData);
    } catch (err) {
      console.error('Error fetching event registrations:', err);
    }
  };
  const fetchSettings = async () => {
    try {
      const monthlyDoc = await getDocs(collection(db, 'settings'));
      const monthlyConfig = monthlyDoc.docs.find(d => d.id === 'monthlyConfig');
      if (monthlyConfig) {
        setMonthlyStatus(monthlyConfig.data() as Record<string, boolean>);
      } else {
        const defaultStatus = MONTHS.reduce((acc, m) => ({ ...acc, [m]: true }), {});
        setMonthlyStatus(defaultStatus);
        await setDoc(doc(db, 'settings', 'monthlyConfig'), defaultStatus);
      }
      const expiryConfig = monthlyDoc.docs.find(d => d.id === 'monthlyExpiry');
      if (expiryConfig) {
        setMonthlyExpiry(expiryConfig.data() as Record<string, string>);
      }
      
      const cancelConfig = monthlyDoc.docs.find(d => d.id === 'cancelConfig');
      if (cancelConfig) {
        setCancelExtendUntil(cancelConfig.data().extendUntil || '');
      }

      // Fetch Events
      const eventsSnapshot = await getDocs(collection(db, 'events'));
      const evtData: EventData[] = [];
      eventsSnapshot.forEach((doc) => evtData.push({ id: doc.id, ...doc.data() } as EventData));
      setEvents(evtData);
    } catch (err) {
      console.error('Error fetching settings:', err);
    }
  };

  const filteredRegistrations = registrations.filter(reg => {
    const matchesName = reg.fullName.toLowerCase().includes(nameFilter.toLowerCase());
    const matchesId = (reg.employeeId || '').toLowerCase().includes(idFilter.toLowerCase());
    const matchesDept = (reg.department || '').toLowerCase().includes(deptFilter.toLowerCase());
    return matchesName && matchesId && matchesDept;
  });

  const formatCancelDate = (dateStr: string) => {
    if (!dateStr) return 'N/A';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
  };

  const filteredCancelations = [...cancelations]
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .filter(c => {
    const matchesName = (c.fullName || '').toLowerCase().includes(nameFilter.toLowerCase());
    const matchesId = (c.employeeId || '').toLowerCase().includes(idFilter.toLowerCase());
    const matchesDept = (c.department || '').toLowerCase().includes(deptFilter.toLowerCase());
    const formattedDateStr = formatCancelDate(c.cancelDate || '');
    const matchesDate = formattedDateStr.includes(cancelDateFilter) || (c.cancelDate || '').includes(cancelDateFilter);
    const matchesMeal = cancelMealFilter === 'all' || c.cancelMeal === 'both' || c.cancelMeal === cancelMealFilter;
    return matchesName && matchesId && matchesDept && matchesDate && matchesMeal;
  });

  const registrationsWithCancelations = filteredRegistrations.map(reg => {
    const userCancelations = filteredCancelations.filter(c => c.userId === reg.userId);
    const userCancelBreakfastCount = userCancelations.filter(c => c.cancelMeal === 'breakfast' || c.cancelMeal === 'both').length;
    const userCancelLunchCount = userCancelations.filter(c => c.cancelMeal === 'lunch' || c.cancelMeal === 'both').length;
    
    return {
      ...reg,
      adjustedBreakfastCount: Math.max(0, (reg.breakfastCount || 0) - userCancelBreakfastCount),
      adjustedLunchCount: Math.max(0, (reg.lunchCount || 0) - userCancelLunchCount)
    };
  });

  const totalCancelledBreakfastInMonth = filteredCancelations.filter(c => c.cancelMeal === 'breakfast' || c.cancelMeal === 'both').length;
  const totalCancelledLunchInMonth = filteredCancelations.filter(c => c.cancelMeal === 'lunch' || c.cancelMeal === 'both').length;

  const totalBreakfast = registrationsWithCancelations.reduce((sum, reg) => sum + reg.adjustedBreakfastCount, 0);
  const totalLunch = registrationsWithCancelations.reduce((sum, reg) => sum + reg.adjustedLunchCount, 0);

  // Daily statistics calculations 
  const [yearStr, monthStr] = selectedMonth.split('-');
  const selYear = parseInt(yearStr);
  const selMonthIndex = parseInt(monthStr) - 1; 
  
  const daysInMonth = new Date(selYear, selMonthIndex + 1, 0).getDate();
  const cappedSelectedDay = Math.min(selectedDay, daysInMonth);
  const selectedDateObj = new Date(selYear, selMonthIndex, cappedSelectedDay);
  const isSelectedDayWeekday = selectedDateObj.getDay() !== 0 && selectedDateObj.getDay() !== 6;

  const selectedDateStr = `${selYear}-${String(selMonthIndex + 1).padStart(2, '0')}-${String(cappedSelectedDay).padStart(2, '0')}`;
  
  const cancelledBreakfastToday = filteredCancelations.filter(c => c.cancelDate === selectedDateStr && (c.cancelMeal === 'breakfast' || c.cancelMeal === 'both')).length;
  const cancelledLunchToday = filteredCancelations.filter(c => c.cancelDate === selectedDateStr && (c.cancelMeal === 'lunch' || c.cancelMeal === 'both')).length;

  const dailyBreakfast = Math.max(0, (isSelectedDayWeekday ? filteredRegistrations.filter(reg => (reg.breakfastCount || 0) > 0).length : 0) - cancelledBreakfastToday);
  const dailyLunch = Math.max(0, (isSelectedDayWeekday ? filteredRegistrations.filter(reg => (reg.lunchCount || 0) > 0).length : 0) - cancelledLunchToday);

  const dailyRegistrationsBase = isSelectedDayWeekday ? filteredRegistrations.reduce((acc, reg) => {
    const hasCancelledBreakfast = filteredCancelations.some(c => c.cancelDate === selectedDateStr && c.userId === reg.userId && (c.cancelMeal === 'breakfast' || c.cancelMeal === 'both'));
    const hasCancelledLunch = filteredCancelations.some(c => c.cancelDate === selectedDateStr && c.userId === reg.userId && (c.cancelMeal === 'lunch' || c.cancelMeal === 'both'));
    
    const eatsBreakfast = (reg.breakfastCount || 0) > 0 && !hasCancelledBreakfast;
    const eatsLunch = (reg.lunchCount || 0) > 0 && !hasCancelledLunch;
    
    if (eatsBreakfast || eatsLunch) {
      acc.push({
        ...reg,
        eatsBreakfast,
        eatsLunch
      });
    }
    return acc;
  }, [] as any[]) : [];

  const dailyRegistrations = dailyRegistrationsBase.filter((reg: any) => {
    if (dailyFilterByMeal === 'breakfast' && !reg.eatsBreakfast) return false;
    if (dailyFilterByMeal === 'lunch' && !reg.eatsLunch) return false;
    
    const matchesName = reg.fullName.toLowerCase().includes(nameFilter.toLowerCase());
    const matchesId = (reg.employeeId || '').toLowerCase().includes(idFilter.toLowerCase());
    const matchesDept = (reg.department || '').toLowerCase().includes(deptFilter.toLowerCase());
    return matchesName && matchesId && matchesDept;
  });

  const handleAddAdmin = async () => {
    if (!newAdminEmail.trim() || !newAdminEmail.includes('@')) return;
    setAddingAdmin(true);
    try {
      const docId = newAdminEmail.trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
      await setDoc(doc(db, 'admins', docId), { email: newAdminEmail.trim().toLowerCase() });
      setNewAdminEmail('');
      fetchData(); 
    } catch (err) {
      console.error('Error adding admin:', err);
    } finally {
      setAddingAdmin(false);
    }
  };

  const [adminToDelete, setAdminToDelete] = useState<{id: string, email: string} | null>(null);
  const [eventToDelete, setEventToDelete] = useState<string | null>(null);

  const handleRemoveAdmin = async (adminId: string, email: string) => {
    try {
      await deleteDoc(doc(db, 'admins', adminId));
      fetchData();
      setAdminToDelete(null);
    } catch (err) {
      console.error('Error removing admin:', err);
      showToast('Có lỗi xảy ra khi xóa quyền quản trị. Vui lòng thử lại.', 'error');
    }
  };

  const formatTimestamp = (ts: any) => {
    if (!ts) return 'N/A';
    const date = new Date(ts);
    if (isNaN(date.getTime())) return 'N/A';
    
    const pad = (n: number) => n.toString().padStart(2, '0');
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    const d = pad(date.getDate());
    const m = pad(date.getMonth() + 1);
    const y = date.getFullYear();
    
    return `${hh}:${mm}:${ss} Ngày ${d}/${m}/${y}`;
  };

  const handleExportExcel = () => {
    const exportData = registrationsWithCancelations.map((reg, index) => ({
      'STT': index + 1,
      'Mã Nhân Viên': reg.employeeId || 'N/A',
      'Họ và Tên': reg.fullName || 'N/A',
      'Phòng ban/Tổ khối': reg.department || 'N/A',
      'ĐK Bữa sáng': reg.adjustedBreakfastCount,
      'ĐK Bữa trưa': reg.adjustedLunchCount,
      'Thời gian đăng ký': formatTimestamp(reg.timestamp)
    }));

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, `Dang_Ky_An_${selectedMonth}`);
    xlsx.writeFile(workbook, `Bao_Cao_Dang_Ky_An_${selectedMonth}.xlsx`);
  };

  const handleExportCancelationsExcel = () => {
    const cancelExportData = filteredCancelations.map((c, index) => ({
      'STT': index + 1,
      'Mã Nhân Viên': c.employeeId || 'N/A',
      'Họ và Tên': c.fullName || 'N/A',
      'Phòng ban/Tổ khối': c.department || 'N/A',
      'Ngày hủy': formatCancelDate(c.cancelDate),
      'Bữa hủy': c.cancelMeal === 'both' ? 'Cả 2 bữa' : (c.cancelMeal === 'breakfast' ? 'Sáng' : 'Trưa'),
      'Nhà ăn': c.cancelCanteen === 'trunghoc' ? 'Trung học' : 'Tiểu học',
      'Lý do': c.cancelReason || 'N/A',
      'Thời gian khai báo hủy': formatTimestamp(c.timestamp)
    }));

    const cancelWorksheet = xlsx.utils.json_to_sheet(cancelExportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, cancelWorksheet, `Huy_An_${selectedMonth}`);
    xlsx.writeFile(workbook, `Bao_Cao_Huy_An_${selectedMonth}.xlsx`);
  };

  const handleExportDailyExcel = () => {
    const exportData = dailyRegistrations.map((reg, index) => {
      const rowData: any = {
        'STT': index + 1,
        'Mã Nhân Viên': reg.employeeId || 'N/A',
        'Họ và Tên': reg.fullName || 'N/A',
        'Phòng ban/Tổ khối': reg.department || 'N/A',
      };
      if (dailyFilterByMeal === 'all' || dailyFilterByMeal === 'breakfast') {
        rowData['Bữa sáng'] = reg.eatsBreakfast ? 'Có ăn' : 'Không ăn';
      }
      if (dailyFilterByMeal === 'all' || dailyFilterByMeal === 'lunch') {
        rowData['Bữa trưa'] = reg.eatsLunch ? 'Có ăn' : 'Không ăn';
      }
      rowData['Thời gian đăng ký ban đầu'] = formatTimestamp(reg.timestamp);
      return rowData;
    });

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, `DS_${selectedDateStr}`);
    xlsx.writeFile(workbook, `Danh_Sach_An_Ngay_${selectedDateStr}.xlsx`);
  };

  const handleExportEventExcel = () => {
    const event = events.find(e => e.id === selectedEventId);
    if (!event) return;

    const exportData = eventRegistrations.map((reg, index) => ({
      'STT': index + 1,
      'Mã Nhân Viên': reg.employeeId || 'N/A',
      'Họ và Tên': reg.fullName || 'N/A',
      'Email': reg.email || 'N/A',
      'Phòng ban': reg.department || 'N/A',
      'Lựa chọn': reg.choice === 'yes' ? 'Có ăn' : 'Không ăn',
      'Thời gian': formatTimestamp(reg.timestamp)
    }));

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    
    const safeSheetName = `Event_${event.name}`.replace(/[\[\]*?:\/\\]/g, '_').substring(0, 31);
    const safeFileName = `Bao_Cao_${event.name}`.replace(/[\\/:*?"<>|]/g, '_') + '.xlsx';
    
    xlsx.utils.book_append_sheet(workbook, worksheet, safeSheetName);
    xlsx.writeFile(workbook, safeFileName);
  };

  const [savingMonths, setSavingMonths] = useState<Record<string, boolean>>({});

  const handleSetMonthExpiry = (month: string, dateStr: string) => {
    setMonthlyExpiry(prev => ({ ...prev, [month]: dateStr }));
  };

  const [toast, setToast] = useState<{message: string, type: 'success' | 'error'} | null>(null);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), type === 'error' ? 6000 : 3000);
  };

  // Diễn giải lỗi Firebase ra tiếng Việt để biết ngay là lỗi quyền hay lỗi mạng.
  const describeFirebaseError = (err: any) => {
    const code = err?.code ? String(err.code) : '';
    if (code.includes('permission-denied') || code.includes('insufficient')) {
      return `Tài khoản ${auth.currentUser?.email || ''} chưa được cấp quyền ghi trên Firestore. Cần cập nhật Firestore Rules.`;
    }
    if (code.includes('unauthenticated')) {
      return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng xuất và đăng nhập lại.';
    }
    if (code.includes('unavailable') || code.includes('deadline-exceeded')) {
      return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
    }
    if (code.includes('not-found')) {
      return 'Không tìm thấy dữ liệu cấu hình trên máy chủ.';
    }
    return code ? `Mã lỗi: ${code}` : (err?.message || 'Lỗi không xác định');
  };

  const handleSaveMonthExpiry = async (month: string) => {
    setSavingMonths(prev => ({ ...prev, [month]: true }));
    try {
      const newExpiry = { ...monthlyExpiry };
      await setDoc(doc(db, 'settings', 'monthlyExpiry'), newExpiry, { merge: true });
      showToast(`Đã lưu thời gian khóa của tháng ${month}!`, 'success');
    } catch (err) {
      console.error('Lỗi khi lưu cấu hình:', err);
      showToast(`Không lưu được cấu hình. ${describeFirebaseError(err)}`, 'error');
    } finally {
      setSavingMonths(prev => ({ ...prev, [month]: false }));
    }
  };

  const handleToggleMonth = async (month: string) => {
    const oldStatus = !!monthlyStatus[month];
    const newStatus = !oldStatus;
    setMonthlyStatus({ ...monthlyStatus, [month]: newStatus });
    try {
      // setDoc + merge thay cho updateDoc: vẫn chạy được khi doc cấu hình chưa tồn tại.
      await setDoc(doc(db, 'settings', 'monthlyConfig'), { [month]: newStatus }, { merge: true });
      showToast(`Đã ${newStatus ? 'MỞ' : 'KHÓA'} đăng ký tháng ${month}.`, 'success');
    } catch (err) {
      console.error('Lỗi khi đổi trạng thái tháng:', err);
      // Trả giao diện về đúng trạng thái thật trên máy chủ.
      setMonthlyStatus(prev => ({ ...prev, [month]: oldStatus }));
      showToast(`Không đổi được trạng thái tháng ${month}. ${describeFirebaseError(err)}`, 'error');
    }
  };

  const handleSaveCancelExtend = async () => {
    setIsSavingCancelExtend(true);
    try {
      await setDoc(doc(db, 'settings', 'cancelConfig'), { extendUntil: cancelExtendUntil }, { merge: true });
      showToast('Đã lưu cấu hình hủy ăn thành công!', 'success');
    } catch (err) {
      console.error('Error saving cancel config:', err);
      showToast(`Không lưu được cấu hình hủy ăn. ${describeFirebaseError(err)}`, 'error');
    } finally {
      setIsSavingCancelExtend(false);
    }
  };

  const handleAddEvent = async () => {
    if (!newEventName.trim()) return;
    try {
      const docRef = await addDoc(collection(db, 'events'), {
        name: newEventName.trim(),
        isOpen: true,
        createdAt: new Date().toISOString()
      });
      setEvents([...events, { id: docRef.id, name: newEventName.trim(), isOpen: true }]);
      setNewEventName('');
      showToast('Đã thêm sự kiện thành công!', 'success');
    } catch (err) {
      console.error('Error adding event:', err);
      showToast('Có lỗi xảy ra khi thêm sự kiện. Vui lòng thử lại!', 'error');
    }
  };

  const handleToggleEvent = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, 'events', id), { isOpen: !currentStatus });
      setEvents(events.map(e => e.id === id ? { ...e, isOpen: !currentStatus } : e));
    } catch (err) {
      console.error('Error toggling event:', err);
      showToast('Có lỗi xảy ra khi cập nhật trạng thái sự kiện!', 'error');
    }
  };

  const handleSetEventExpiry = async (id: string, dateStr: string) => {
    try {
      await updateDoc(doc(db, 'events', id), { expiresAt: dateStr });
      setEvents(events.map(e => e.id === id ? { ...e, expiresAt: dateStr } : e));
      showToast('Lưu hạn đóng thành công!', 'success');
    } catch (err) {
      console.error('Error setting event expiry:', err);
      showToast('Có lỗi xảy ra khi lưu hạn đóng!', 'error');
    }
  };

  const handleEditEvent = async (id: string) => {
    if (!editingEventName.trim()) return;
    try {
      await updateDoc(doc(db, 'events', id), { name: editingEventName.trim() });
      setEvents(events.map(e => e.id === id ? { ...e, name: editingEventName.trim() } : e));
      setEditingEventId(null);
      setEditingEventName('');
      showToast('Chỉnh sửa sự kiện thành công!', 'success');
    } catch (err) {
      console.error('Error editing event:', err);
      showToast('Có lỗi xảy ra khi chỉnh sửa sự kiện!', 'error');
    }
  };

  const handleDeleteEvent = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'events', id));
      setEvents(events.filter(e => e.id !== id));
      if (selectedEventId === id) {
        setSelectedEventId('');
      }
      setEventToDelete(null);
      showToast('Xóa sự kiện thành công!', 'success');
    } catch (err) {
      console.error('Error deleting event:', err);
      showToast('Có lỗi xảy ra khi xóa sự kiện!', 'error');
    }
  };

  const { items: sortedMonthlyRegistrations, requestSort: requestSortMonthly, sortConfig: sortConfigMonthly } = useSortableData(registrationsWithCancelations);
  const { items: sortedDailyRegistrations, requestSort: requestSortDaily, sortConfig: sortConfigDaily } = useSortableData(dailyRegistrations);
  const { items: sortedCancelations, requestSort: requestSortCancelations, sortConfig: sortConfigCancelations } = useSortableData(filteredCancelations);
  const { items: sortedEventRegistrations, requestSort: requestSortEvent, sortConfig: sortConfigEvent } = useSortableData(eventRegistrations);

  if (!isAdmin || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-md">
          <span className="material-symbols-outlined animate-spin text-[48px] text-primary">progress_activity</span>
          <p className="text-body-md text-on-surface-variant">Đang tải dữ liệu quản trị...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-on-background min-h-screen flex flex-col font-body-md relative">
      {/* Toast — top-20 để nằm dưới thanh header cố định (h-16), không đè lên */}
      {toast && (
        <div className={`fixed top-20 right-4 z-[100] max-w-[min(420px,calc(100vw-2rem))] px-4 py-3 rounded-lg shadow-lg border flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300 ${
          toast.type === 'success' 
            ? 'bg-tertiary-container border-tertiary text-on-tertiary-container'
            : 'bg-error-container border-error text-on-error-container'
        }`}>
          <span className="material-symbols-outlined text-[20px] shrink-0">
            {toast.type === 'success' ? 'check_circle' : 'error'}
          </span>
          <p className="font-label-md leading-5">{toast.message}</p>
        </div>
      )}

      <Header />
      
      <main className="flex-1 max-w-[1440px] w-full mx-auto p-sm md:p-lg lg:p-xl flex flex-col gap-md md:gap-lg mt-16 md:mt-2">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-sm border-b md:border-b-0 border-outline-variant pb-md md:pb-0 px-md md:px-0 mt-md md:mt-0">
          <div className="flex items-center gap-3">
            <span className="hidden md:block w-1 h-11 rounded-full bg-secondary shrink-0" aria-hidden="true" />
            <div>
              <h1 className="text-headline-md md:text-headline-lg text-primary">Quản Trị Hệ Thống</h1>
              <p className="text-body-sm md:text-body-md text-on-surface-variant mt-0.5">Quản lý đăng ký suất ăn và tài khoản quản trị.</p>
            </div>
          </div>
        </div>

        {/* Tabs navigation */}
        <div
          role="tablist"
          aria-label="Khu vực quản trị"
          className="flex gap-1 px-1 py-1 mt-xs bg-surface-container-lowest border border-outline-variant overflow-x-auto whitespace-nowrap hide-scrollbar flex-nowrap rounded-xl w-full lg:w-fit shadow-xs"
        >
          {ADMIN_TABS.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                title={tab.label}
                className={`px-4 py-2 text-label-md uppercase tracking-wide transition-colors rounded-lg shrink-0 inline-flex items-center gap-2 ${
                  isActive
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'bg-transparent text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                }`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={{ fontVariationSettings: isActive ? "'FILL' 1" : undefined }}
                >
                  {tab.icon}
                </span>
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'monthly' && (
          <div className="flex flex-col gap-md lg:gap-lg">
            {/* Bento Grid Layout - Summary Statistics */}
            <div className="px-md md:px-0 grid grid-cols-1 md:grid-cols-2 gap-md lg:gap-lg">
              {/* Bữa sáng = navy, bữa trưa = đỏ trường: phân biệt được ngay mà vẫn đúng nhận diện */}
              <div className="bg-gradient-to-br from-primary to-primary-darker rounded-xl p-lg md:p-8 shadow-md flex flex-col justify-center gap-md relative overflow-hidden min-h-[200px]">
                <div className="absolute -top-2 -right-2 opacity-[0.12] pointer-events-none" aria-hidden="true">
                  <span className="material-symbols-outlined text-[120px] leading-none">bakery_dining</span>
                </div>
                <div className="flex justify-between items-start gap-3 relative z-10">
                  <span className="text-label-md text-on-primary/90 uppercase tracking-wider">Tổng suất đăng ký ăn sáng · Tháng {selectedMonth.split('-')[1]}/{selectedMonth.split('-')[0]}</span>
                  <span className="material-symbols-outlined text-on-primary/80 shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>bakery_dining</span>
                </div>
                <div className="relative z-10 flex items-baseline gap-2">
                  <span className="text-[44px] font-extrabold text-on-primary leading-none tabular">{totalBreakfast}</span>
                  <span className="text-body-md text-on-primary/80">suất</span>
                </div>
                <div className="w-full bg-black/20 rounded-full h-1 mt-auto relative z-10">
                  <div className="bg-on-primary h-1 rounded-full" style={{ width: '100%' }}></div>
                </div>
              </div>

              <div className="bg-gradient-to-br from-secondary to-secondary-dark rounded-xl p-lg md:p-8 shadow-md flex flex-col justify-center gap-md relative overflow-hidden min-h-[200px]">
                <div className="absolute -top-2 -right-2 opacity-[0.12] pointer-events-none" aria-hidden="true">
                  <span className="material-symbols-outlined text-[120px] leading-none">lunch_dining</span>
                </div>
                <div className="flex justify-between items-start gap-3 relative z-10">
                  <span className="text-label-md text-on-secondary/90 uppercase tracking-wider">Tổng suất đăng ký ăn trưa · Tháng {selectedMonth.split('-')[1]}/{selectedMonth.split('-')[0]}</span>
                  <span className="material-symbols-outlined text-on-secondary/80 shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>lunch_dining</span>
                </div>
                <div className="relative z-10 flex items-baseline gap-2">
                  <span className="text-[44px] font-extrabold text-on-secondary leading-none tabular">{totalLunch}</span>
                  <span className="text-body-md text-on-secondary/80">suất</span>
                </div>
                <div className="w-full bg-black/20 rounded-full h-1 mt-auto relative z-10">
                  <div className="bg-on-secondary h-1 rounded-full" style={{ width: '100%' }}></div>
                </div>
              </div>
            </div>

            {/* Daily Statistics */}
            <div className="px-md md:px-0 mt-2">
              <div className="bg-gradient-to-r from-surface-container-lowest to-surface rounded-2xl p-md lg:p-lg shadow-sm border border-outline-variant flex flex-col gap-md">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                  <div className="flex items-center gap-3">
                    <h2 className="font-headline-sm text-[18px] text-primary uppercase focus:outline-none m-0 tracking-wide font-black">THỐNG KÊ THEO NGÀY</h2>
                    <select 
                      value={selectedDay}
                      onChange={(e) => setSelectedDay(parseInt(e.target.value))}
                      className="bg-surface-container-lowest border border-primary/20 hover:border-primary/40 transition-colors rounded-lg px-4 py-2 text-[14px] outline-none font-bold text-primary shadow-sm cursor-pointer"
                    >
                      {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => (
                        <option key={d} value={d}>Ngày {d.toString().padStart(2, '0')}/{monthStr}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-4 flex-wrap w-full md:w-auto">
                    <button 
                      onClick={() => {
                        setDailyFilterByMeal('breakfast');
                        setActiveTab('daily_stats');
                      }}
                      className="flex items-center justify-between md:justify-start gap-4 bg-primary hover:bg-primary-dark transition-colors text-on-primary px-5 py-2.5 rounded-lg flex-1 md:flex-initial shadow-sm focus:outline-none"
                    >
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[20px] text-on-primary/80" style={{ fontVariationSettings: "'FILL' 1" }}>bakery_dining</span>
                        <span className="text-label-md uppercase tracking-wide">Tổng đăng ký ăn sáng</span>
                      </div>
                      <span className="text-headline-sm tabular">{dailyBreakfast}</span>
                    </button>
                    <button 
                      onClick={() => {
                        setDailyFilterByMeal('lunch');
                        setActiveTab('daily_stats');
                      }}
                      className="flex items-center justify-between md:justify-start gap-4 bg-secondary hover:bg-secondary-dark transition-colors text-on-secondary px-5 py-2.5 rounded-lg flex-1 md:flex-initial shadow-sm focus:outline-none"
                    >
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[20px] text-on-secondary/80" style={{ fontVariationSettings: "'FILL' 1" }}>lunch_dining</span>
                        <span className="text-label-md uppercase tracking-wide">Tổng đăng ký ăn trưa</span>
                      </div>
                      <span className="text-headline-sm tabular">{dailyLunch}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-md lg:gap-lg px-md md:px-0">
              {/* Main Content - Registration List */}
              <div className="lg:col-span-3 bg-surface-container-lowest rounded-2xl shadow-sm border border-outline-variant overflow-hidden flex flex-col">
                <div className="p-lg md:p-xl border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest flex-col md:flex-row gap-4">
                  <div className="flex flex-col gap-2">
                    <h2 className="font-headline-sm text-[18px] text-primary uppercase focus:outline-none font-black tracking-wide m-0">Danh Sách Đăng Ký Ăn Hàng Tháng</h2>
                    <div className="flex items-center gap-2">
                       <span className="font-label-sm text-on-surface-variant font-medium">Chọn Tháng:</span>
                       <select 
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-surface border border-outline-variant hover:border-primary/40 transition-colors rounded-lg px-3 py-1.5 text-sm outline-none font-bold text-primary shadow-sm cursor-pointer"
                       >
                         {MONTHS.map(m => (
                           <option key={m} value={`2026-${m}`}>Tháng {m}/2026</option>
                         ))}
                       </select>
                    </div>
                  </div>
                  <button 
                    onClick={handleExportExcel}
                    className="flex items-center gap-2 bg-gradient-to-r from-tertiary to-tertiary-dark hover:from-tertiary hover:to-tertiary-dark shadow-md text-white px-5 py-2.5 rounded-xl font-label-md transition-all w-full md:w-auto justify-center transform hover:-translate-y-0.5"
                  >
                    <span className="material-symbols-outlined text-[20px]">download</span>
                    <span className="font-bold tracking-wide">Xuất Excel</span>
                  </button>
                </div>

                <div className="p-lg bg-surface-container-lowest grid grid-cols-1 md:grid-cols-3 gap-lg border-b border-outline-variant focus:outline-none">
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Tên</label>
                      <input 
                        type="text" 
                        value={nameFilter}
                        onChange={(e) => setNameFilter(e.target.value)}
                        placeholder="Nhập tên nhân viên..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Mã NV</label>
                      <input 
                        type="text" 
                        value={idFilter}
                        onChange={(e) => setIdFilter(e.target.value)}
                        placeholder="Nhập mã nhân viên..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Phòng ban</label>
                      <input 
                        type="text" 
                        value={deptFilter}
                        onChange={(e) => setDeptFilter(e.target.value)}
                        placeholder="Nhập phòng ban..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                        <tr>
                          <th className="p-md text-center">STT</th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortMonthly('employeeId')}>
                            <div className="flex items-center gap-1">Mã NV <SortIcon sortConfig={sortConfigMonthly} columnKey="employeeId" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortMonthly('fullName')}>
                            <div className="flex items-center gap-1">Tên <SortIcon sortConfig={sortConfigMonthly} columnKey="fullName" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortMonthly('department')}>
                            <div className="flex items-center gap-1">Phòng ban <SortIcon sortConfig={sortConfigMonthly} columnKey="department" /></div>
                          </th>
                          <th className="p-md text-right cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortMonthly('adjustedBreakfastCount')}>
                            <div className="flex items-center justify-end gap-1">Sáng <SortIcon sortConfig={sortConfigMonthly} columnKey="adjustedBreakfastCount" /></div>
                          </th>
                          <th className="p-md text-right cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortMonthly('adjustedLunchCount')}>
                            <div className="flex items-center justify-end gap-1">Trưa <SortIcon sortConfig={sortConfigMonthly} columnKey="adjustedLunchCount" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortMonthly('timestamp')}>
                            <div className="flex items-center gap-1">Thời gian đăng ký <SortIcon sortConfig={sortConfigMonthly} columnKey="timestamp" /></div>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant text-[14px]">
                        {sortedMonthlyRegistrations.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="p-xl text-center text-on-surface-variant italic">
                              Chưa có dữ liệu đăng ký thỏa mãn điều kiện lọc.
                            </td>
                          </tr>
                        ) : (
                          sortedMonthlyRegistrations.map((reg, index) => (
                            <tr key={reg.id || index} className="hover:bg-surface-container-lowest transition-colors">
                              <td className="p-md">{index + 1}</td>
                              <td className="p-md">{reg.employeeId || 'N/A'}</td>
                              <td className="p-md font-medium text-on-surface">{reg.fullName}</td>
                              <td className="p-md">{reg.department || 'N/A'}</td>
                              <td className="p-md text-right">{reg.adjustedBreakfastCount}</td>
                              <td className="p-md text-right">{reg.adjustedLunchCount}</td>
                              <td className="p-md text-on-surface-variant">{formatTimestamp(reg.timestamp)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'cancelations' && (
          <div className="flex flex-col gap-md lg:gap-lg">
            <div className="px-md md:px-0 grid grid-cols-1 md:grid-cols-2 gap-md lg:gap-lg">
              <div className="bg-gradient-to-br from-secondary to-secondary-dark rounded-2xl p-lg md:p-8 shadow-lg border border-white/10 flex flex-col justify-center gap-md relative overflow-hidden min-h-[220px]">
                <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                  <span className="material-symbols-outlined text-[100px]">event_busy</span>
                </div>
                <div className="flex justify-between items-center relative z-10">
                  <span className="font-label-lg font-bold text-white uppercase tracking-wider drop-shadow-sm">ĐÃ HỦY ĂN HÔM NAY ({globalCancelStats.todayStr})</span>
                  <span className="material-symbols-outlined text-white/90" style={{ fontVariationSettings: "'FILL' 1" }}>event_busy</span>
                </div>
                <div className="relative z-10">
                  <span className="font-headline-lg text-[48px] text-white font-black drop-shadow-sm leading-none">{globalCancelStats.todayBreakfast + globalCancelStats.todayLunch}</span>
                  <span className="text-body-md text-white/90 ml-2 font-medium">suất</span>
                </div>
                <div className="text-[16px] text-white/90 mt-auto font-medium flex gap-3 relative z-10 bg-black/20 px-4 py-2 rounded-full backdrop-blur-sm border border-white/5 w-fit">
                  <button onClick={() => {
                    const d = new Date();
                    setCancelDateFilter(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
                    setCancelMealFilter('breakfast');
                  }} className="hover:text-white transition-colors flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">bakery_dining</span> {globalCancelStats.todayBreakfast} Sáng</button>
                  <span className="opacity-50">|</span>
                  <button onClick={() => {
                    const d = new Date();
                    setCancelDateFilter(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
                    setCancelMealFilter('lunch');
                  }} className="hover:text-white transition-colors flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">lunch_dining</span> {globalCancelStats.todayLunch} Trưa</button>
                </div>
              </div>

              <div className="bg-gradient-to-br from-secondary to-secondary-dark rounded-2xl p-lg md:p-8 shadow-lg border border-white/10 flex flex-col justify-center gap-md relative overflow-hidden min-h-[220px]">
                <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                  <span className="material-symbols-outlined text-[100px]">next_plan</span>
                </div>
                <div className="flex justify-between items-center relative z-10">
                  <span className="font-label-lg font-bold text-white uppercase tracking-wider drop-shadow-sm">ĐÃ HỦY ĂN NGÀY MAI ({globalCancelStats.tomorrowStr})</span>
                  <span className="material-symbols-outlined text-white/90" style={{ fontVariationSettings: "'FILL' 1" }}>next_plan</span>
                </div>
                <div className="relative z-10">
                  <span className="font-headline-lg text-[48px] text-white font-black drop-shadow-sm leading-none">{globalCancelStats.tomorrowBreakfast + globalCancelStats.tomorrowLunch}</span>
                  <span className="text-body-md text-white/90 ml-2 font-medium">suất</span>
                </div>
                <div className="text-[16px] text-white/90 mt-auto font-medium flex gap-3 relative z-10 bg-black/20 px-4 py-2 rounded-full backdrop-blur-sm border border-white/5 w-fit">
                  <button onClick={() => {
                    const d = new Date();
                    d.setDate(d.getDate() + 1);
                    setCancelDateFilter(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
                    setCancelMealFilter('breakfast');
                  }} className="hover:text-white transition-colors flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">bakery_dining</span> {globalCancelStats.tomorrowBreakfast} Sáng</button>
                  <span className="opacity-50">|</span>
                  <button onClick={() => {
                    const d = new Date();
                    d.setDate(d.getDate() + 1);
                    setCancelDateFilter(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
                    setCancelMealFilter('lunch');
                  }} className="hover:text-white transition-colors flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">lunch_dining</span> {globalCancelStats.tomorrowLunch} Trưa</button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-md lg:gap-lg px-md md:px-0">
              <div className="bg-surface-container-lowest rounded-2xl shadow-sm border border-outline-variant overflow-hidden flex flex-col">
                <div className="p-lg md:p-xl border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest flex-col md:flex-row gap-4">
                  <div className="flex flex-col gap-2">
                    <h2 className="font-headline-sm text-[18px] text-primary uppercase focus:outline-none font-black tracking-wide m-0">Danh Sách Đăng Ký Hủy Ăn</h2>
                    <div className="flex items-center gap-2">
                       <span className="font-label-sm text-on-surface-variant font-medium">Chọn Tháng:</span>
                       <select 
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-surface border border-outline-variant hover:border-primary/40 transition-colors rounded-lg px-3 py-1.5 text-sm outline-none font-bold text-primary shadow-sm cursor-pointer"
                       >
                         {MONTHS.map(m => (
                           <option key={m} value={`2026-${m}`}>Tháng {m}/2026</option>
                         ))}
                       </select>
                    </div>
                  </div>
                  <button 
                    onClick={handleExportCancelationsExcel}
                    className="flex items-center gap-2 bg-gradient-to-r from-tertiary to-tertiary-dark hover:from-tertiary hover:to-tertiary-dark shadow-md text-white px-5 py-2.5 rounded-xl font-label-md transition-all w-full md:w-auto justify-center transform hover:-translate-y-0.5"
                  >
                    <span className="material-symbols-outlined text-[20px]">download</span>
                    <span className="font-bold tracking-wide">Xuất Excel</span>
                  </button>
                </div>

                <div className="p-lg bg-surface-container-lowest grid grid-cols-1 md:grid-cols-5 gap-lg border-b border-outline-variant focus:outline-none">
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Tên</label>
                      <input 
                        type="text" 
                        value={nameFilter}
                        onChange={(e) => setNameFilter(e.target.value)}
                        placeholder="Nhập tên nhân viên..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Mã NV</label>
                      <input 
                        type="text" 
                        value={idFilter}
                        onChange={(e) => setIdFilter(e.target.value)}
                        placeholder="Nhập mã nhân viên..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Phòng ban</label>
                      <input 
                        type="text" 
                        value={deptFilter}
                        onChange={(e) => setDeptFilter(e.target.value)}
                        placeholder="Nhập phòng ban..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Bữa</label>
                      <select 
                        value={cancelMealFilter}
                        onChange={(e) => setCancelMealFilter(e.target.value as any)}
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none cursor-pointer"
                      >
                        <option value="all">Tất cả</option>
                        <option value="breakfast">Bữa sáng</option>
                        <option value="lunch">Bữa trưa</option>
                      </select>
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Ngày</label>
                      <input 
                        type="date" 
                        value={cancelDateFilter}
                        onChange={(e) => setCancelDateFilter(e.target.value)}
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                        <tr>
                          <th className="p-md text-center">STT</th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('employeeId')}>
                            <div className="flex items-center gap-1">Mã NV <SortIcon sortConfig={sortConfigCancelations} columnKey="employeeId" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('fullName')}>
                            <div className="flex items-center gap-1">Tên <SortIcon sortConfig={sortConfigCancelations} columnKey="fullName" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('department')}>
                            <div className="flex items-center gap-1">Phòng ban <SortIcon sortConfig={sortConfigCancelations} columnKey="department" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('cancelDate')}>
                            <div className="flex items-center gap-1">Ngày hủy <SortIcon sortConfig={sortConfigCancelations} columnKey="cancelDate" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('cancelMeal')}>
                            <div className="flex items-center gap-1">Bữa hủy <SortIcon sortConfig={sortConfigCancelations} columnKey="cancelMeal" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('cancelCanteen')}>
                            <div className="flex items-center gap-1">Nhà ăn <SortIcon sortConfig={sortConfigCancelations} columnKey="cancelCanteen" /></div>
                          </th>
                          <th className="p-md w-1/4 cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('cancelReason')}>
                            <div className="flex items-center gap-1">Lý do <SortIcon sortConfig={sortConfigCancelations} columnKey="cancelReason" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortCancelations('timestamp')}>
                            <div className="flex items-center gap-1">Thời gian khai báo <SortIcon sortConfig={sortConfigCancelations} columnKey="timestamp" /></div>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant text-[14px]">
                        {sortedCancelations.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="p-xl text-center text-on-surface-variant italic">
                              Chưa có dữ liệu hủy đăng ký thỏa mãn điều kiện lọc.
                            </td>
                          </tr>
                        ) : (
                          sortedCancelations.map((c, index) => (
                            <tr key={c.id || index} className="hover:bg-surface-container-lowest transition-colors">
                              <td className="p-md">{index + 1}</td>
                              <td className="p-md">{c.employeeId || 'N/A'}</td>
                              <td className="p-md font-medium text-on-surface">{c.fullName}</td>
                              <td className="p-md">{c.department || 'N/A'}</td>
                              <td className="p-md font-bold text-secondary">{formatCancelDate(c.cancelDate)}</td>
                              <td className="p-md">
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                  c.cancelMeal === 'both' ? 'bg-secondary/10 text-secondary' : 'bg-primary/10 text-primary'
                                }`}>
                                  {c.cancelMeal === 'both' ? 'Cả 2 bữa' : (c.cancelMeal === 'breakfast' ? 'Sáng' : 'Trưa')}
                                </span>
                              </td>
                              <td className="p-md">{c.cancelCanteen === 'trunghoc' ? 'Trung học' : 'Tiểu học'}</td>
                              <td className="p-md text-on-surface-variant">{c.cancelReason}</td>
                              <td className="p-md text-on-surface-variant text-xs">{formatTimestamp(c.timestamp)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'events' && (
          <div className="flex flex-col gap-md lg:gap-lg">
            {/* Event Summary */}
            {selectedEventId && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-md lg:gap-lg px-md md:px-0">
                <div className="bg-gradient-to-br from-tertiary-container to-tertiary-container-strong rounded-2xl p-lg shadow-lg border border-tertiary/20 flex flex-col gap-md relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                    <span className="material-symbols-outlined text-[100px]">restaurant</span>
                  </div>
                  <div className="flex justify-between items-center relative z-10">
                    <span className="font-label-lg font-bold text-on-tertiary-container uppercase tracking-wider drop-shadow-sm">CÓ ĂN ({events.find(e => e.id === selectedEventId)?.name || ''})</span>
                    <span className="material-symbols-outlined text-on-tertiary-container" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant</span>
                  </div>
                  <div className="relative z-10">
                    <span className="text-headline-lg text-on-tertiary-container font-black drop-shadow-sm">{eventRegistrations.filter(r => r.choice === 'yes').length}</span>
                    <span className="text-body-md text-on-tertiary-container/90 ml-2 font-medium">suất</span>
                  </div>
                   <div className="w-full bg-on-tertiary-container/20 rounded-full h-1.5 mt-auto relative z-10">
                    <div className="bg-on-tertiary-container h-1.5 rounded-full" style={{ width: '100%' }}></div>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-error-container to-error-container-strong rounded-2xl p-lg shadow-lg border border-error/20 flex flex-col gap-md relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                    <span className="material-symbols-outlined text-[100px]">no_meals</span>
                  </div>
                  <div className="flex justify-between items-center relative z-10">
                    <span className="font-label-lg font-bold text-on-error-container uppercase tracking-wider drop-shadow-sm">KHÔNG ĂN ({events.find(e => e.id === selectedEventId)?.name || ''})</span>
                    <span className="material-symbols-outlined text-on-error-container" style={{ fontVariationSettings: "'FILL' 1" }}>no_meals</span>
                  </div>
                  <div className="relative z-10">
                    <span className="text-headline-lg text-on-error-container font-black drop-shadow-sm">{eventRegistrations.filter(r => r.choice === 'no').length}</span>
                    <span className="text-body-md text-on-error-container/90 ml-2 font-medium">suất</span>
                  </div>
                   <div className="w-full bg-on-error-container/20 rounded-full h-1.5 mt-auto relative z-10">
                    <div className="bg-on-error-container h-1.5 rounded-full" style={{ width: '100%' }}></div>
                  </div>
                </div>
              </div>
            )}

            {/* Event Registration List */}
            <div className="bg-surface-container-lowest rounded-2xl shadow-sm border border-outline-variant overflow-hidden flex flex-col px-md md:px-0 mx-md md:mx-0">
              <div className="p-lg md:p-xl border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest flex-col md:flex-row gap-4">
                <div className="flex flex-col gap-2 w-full md:w-auto">
                  <h2 className="font-headline-sm text-[18px] text-primary uppercase pr-4 focus:outline-none font-black tracking-wide m-0">Danh Sách Đăng Ký Ăn Sự Kiện</h2>
                  <div className="flex items-center gap-2">
                     <span className="font-label-sm text-on-surface-variant font-medium">Sự kiện:</span>
                     <select 
                      value={selectedEventId}
                      onChange={(e) => setSelectedEventId(e.target.value)}
                      className="bg-surface border border-outline-variant hover:border-primary/40 transition-colors rounded-lg px-3 py-1.5 text-sm outline-none font-bold text-primary shadow-sm cursor-pointer max-w-[250px] w-full"
                     >
                       <option value="">-- Chọn sự kiện --</option>
                       {events.map(event => (
                         <option key={event.id} value={event.id}>{event.name}</option>
                       ))}
                     </select>
                  </div>
                </div>
                <button 
                  onClick={handleExportEventExcel}
                  disabled={!selectedEventId}
                  className="flex items-center gap-2 bg-gradient-to-r from-tertiary to-tertiary-dark hover:from-tertiary hover:to-tertiary-dark shadow-md text-white px-5 py-2.5 rounded-xl font-label-md transition-all w-full md:w-auto justify-center disabled:opacity-50 disabled:cursor-not-allowed transform hover:-translate-y-0.5"
                >
                  <span className="material-symbols-outlined text-[20px]">download</span>
                  <span className="font-bold tracking-wide">Xuất Excel Sự Kiện</span>
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                    <tr>
                      <th className="p-md text-center">STT</th>
                      <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortEvent('employeeId')}>
                        <div className="flex items-center gap-1">Mã NV <SortIcon sortConfig={sortConfigEvent} columnKey="employeeId" /></div>
                      </th>
                      <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortEvent('fullName')}>
                        <div className="flex items-center gap-1">Họ và Tên <SortIcon sortConfig={sortConfigEvent} columnKey="fullName" /></div>
                      </th>
                      <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortEvent('email')}>
                        <div className="flex items-center gap-1">Email <SortIcon sortConfig={sortConfigEvent} columnKey="email" /></div>
                      </th>
                      <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortEvent('department')}>
                        <div className="flex items-center gap-1">Phòng ban <SortIcon sortConfig={sortConfigEvent} columnKey="department" /></div>
                      </th>
                      <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortEvent('choice')}>
                        <div className="flex items-center gap-1">Lựa chọn <SortIcon sortConfig={sortConfigEvent} columnKey="choice" /></div>
                      </th>
                      <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortEvent('timestamp')}>
                        <div className="flex items-center gap-1">Thời gian đăng ký <SortIcon sortConfig={sortConfigEvent} columnKey="timestamp" /></div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant text-[14px]">
                    {sortedEventRegistrations.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-xl text-center text-on-surface-variant italic">
                          {!selectedEventId ? 'Vui lòng chọn sự kiện để xem danh sách.' : 'Chưa có dữ liệu đăng ký cho sự kiện này.'}
                        </td>
                      </tr>
                    ) : (
                      sortedEventRegistrations.map((reg, index) => (
                        <tr key={reg.id || index} className="hover:bg-surface-container-lowest transition-colors">
                          <td className="p-md">{index + 1}</td>
                          <td className="p-md">{reg.employeeId || 'N/A'}</td>
                          <td className="p-md font-medium text-on-surface">{reg.fullName}</td>
                          <td className="p-md">{reg.email}</td>
                          <td className="p-md">{reg.department || 'N/A'}</td>
                          <td className="p-md">
                             <span className={`px-2 py-1 rounded text-[12px] font-medium ${reg.choice === 'yes' ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-error-container text-on-error-container'}`}>
                                {reg.choice === 'yes' ? 'Có ăn' : 'Không ăn'}
                             </span>
                          </td>
                          <td className="p-md text-on-surface-variant">{formatTimestamp(reg.timestamp)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'daily_stats' && (
          <div className="flex flex-col gap-md lg:gap-lg">
            <div className="grid grid-cols-1 gap-md lg:gap-lg px-md md:px-0">
              <div className="bg-surface-container-lowest rounded-2xl shadow-sm border border-outline-variant overflow-hidden flex flex-col">
                <div className="p-lg md:p-xl border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest flex-col md:flex-row gap-4">
                  <div className="flex flex-col gap-2">
                    <h2 className="font-headline-sm text-[18px] text-primary uppercase focus:outline-none font-black tracking-wide m-0">Danh Sách Đăng Ký Ăn Theo Ngày</h2>
                    <div className="flex flex-col md:flex-row items-start md:items-center gap-4 mt-2">
                      <div className="flex items-center gap-2">
                        <span className="font-label-sm text-on-surface-variant font-medium">Tháng:</span>
                        <select 
                          value={selectedMonth}
                          onChange={(e) => setSelectedMonth(e.target.value)}
                          className="bg-surface border border-outline-variant hover:border-primary/40 transition-colors rounded-lg px-3 py-1.5 text-sm outline-none cursor-pointer"
                        >
                          {MONTHS.map(m => (
                            <option key={m} value={`2026-${m}`}>Tháng {m}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-label-sm text-on-surface-variant font-medium">Ngày:</span>
                        <select 
                          value={selectedDay}
                          onChange={(e) => setSelectedDay(parseInt(e.target.value))}
                          className="bg-surface border border-primary/20 hover:border-primary/40 transition-colors rounded-lg px-3 py-1.5 text-sm outline-none font-bold text-primary cursor-pointer"
                        >
                          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => (
                            <option key={d} value={d}>Ngày {d.toString().padStart(2, '0')}/{monthStr}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-label-sm text-on-surface-variant font-medium">Bữa:</span>
                        <select 
                          value={dailyFilterByMeal}
                          onChange={(e) => setDailyFilterByMeal(e.target.value as any)}
                          className="bg-surface border border-primary/20 hover:border-primary/40 transition-colors rounded-lg px-3 py-1.5 text-sm outline-none font-bold text-primary cursor-pointer"
                        >
                          <option value="all">Tất cả</option>
                          <option value="breakfast">Bữa sáng</option>
                          <option value="lunch">Bữa trưa</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  <button 
                    onClick={handleExportDailyExcel}
                    className="flex items-center gap-2 bg-gradient-to-r from-tertiary to-tertiary-dark hover:from-tertiary hover:to-tertiary-dark shadow-md text-white px-5 py-2.5 rounded-xl font-label-md transition-all w-full md:w-auto justify-center transform hover:-translate-y-0.5"
                  >
                    <span className="material-symbols-outlined text-[20px]">download</span>
                    <span className="font-bold tracking-wide">Xuất Excel</span>
                  </button>
                </div>

                <div className="p-lg bg-surface-container-lowest grid grid-cols-1 md:grid-cols-3 gap-lg border-b border-outline-variant focus:outline-none">
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Tên</label>
                      <input 
                        type="text" 
                        value={nameFilter}
                        onChange={(e) => setNameFilter(e.target.value)}
                        placeholder="Nhập tên nhân viên..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Mã NV</label>
                      <input 
                        type="text" 
                        value={idFilter}
                        onChange={(e) => setIdFilter(e.target.value)}
                        placeholder="Nhập mã nhân viên..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                   <div className="flex flex-col gap-1.5">
                      <label className="font-label-sm text-primary font-bold">Lọc theo Phòng ban</label>
                      <input 
                        type="text" 
                        value={deptFilter}
                        onChange={(e) => setDeptFilter(e.target.value)}
                        placeholder="Nhập phòng ban..."
                        className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary transition-all rounded-lg px-4 py-2 text-[14px] shadow-sm outline-none"
                      />
                   </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                        <tr>
                          <th className="p-md text-center">STT</th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortDaily('employeeId')}>
                            <div className="flex items-center gap-1">Mã NV <SortIcon sortConfig={sortConfigDaily} columnKey="employeeId" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortDaily('fullName')}>
                            <div className="flex items-center gap-1">Tên <SortIcon sortConfig={sortConfigDaily} columnKey="fullName" /></div>
                          </th>
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortDaily('department')}>
                            <div className="flex items-center gap-1">Phòng ban <SortIcon sortConfig={sortConfigDaily} columnKey="department" /></div>
                          </th>
                          {(dailyFilterByMeal === 'all' || dailyFilterByMeal === 'breakfast') && (
                            <th className="p-md cursor-pointer hover:bg-surface-container select-none text-center" onClick={() => requestSortDaily('eatsBreakfast')}>
                              <div className="flex items-center justify-center gap-1">Sáng <SortIcon sortConfig={sortConfigDaily} columnKey="eatsBreakfast" /></div>
                            </th>
                          )}
                          {(dailyFilterByMeal === 'all' || dailyFilterByMeal === 'lunch') && (
                            <th className="p-md cursor-pointer hover:bg-surface-container select-none text-center" onClick={() => requestSortDaily('eatsLunch')}>
                              <div className="flex items-center justify-center gap-1">Trưa <SortIcon sortConfig={sortConfigDaily} columnKey="eatsLunch" /></div>
                            </th>
                          )}
                          <th className="p-md cursor-pointer hover:bg-surface-container select-none" onClick={() => requestSortDaily('timestamp')}>
                            <div className="flex items-center gap-1">Thời gian ĐK ban đầu <SortIcon sortConfig={sortConfigDaily} columnKey="timestamp" /></div>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant text-[14px]">
                        {sortedDailyRegistrations.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="p-xl text-center text-on-surface-variant italic">
                              {!isSelectedDayWeekday ? 'Ngày được chọn là Thứ 7 hoặc Chủ Nhật (không có lịch ăn).' : 'Chưa có dữ liệu đăng ký thỏa mãn điều kiện lọc.'}
                            </td>
                          </tr>
                        ) : (
                          sortedDailyRegistrations.map((reg: any, index: number) => (
                            <tr key={reg.id || index} className="hover:bg-surface-container-lowest transition-colors">
                              <td className="p-md text-center">{index + 1}</td>
                              <td className="p-md">{reg.employeeId || 'N/A'}</td>
                              <td className="p-md font-medium text-on-surface">{reg.fullName}</td>
                              <td className="p-md">{reg.department || 'N/A'}</td>
                              {(dailyFilterByMeal === 'all' || dailyFilterByMeal === 'breakfast') && (
                                <td className="p-md text-center">
                                   {reg.eatsBreakfast ? <span className="material-symbols-outlined text-tertiary">check_circle</span> : <span className="material-symbols-outlined text-outline-variant">cancel</span>}
                                </td>
                              )}
                              {(dailyFilterByMeal === 'all' || dailyFilterByMeal === 'lunch') && (
                                <td className="p-md text-center">
                                   {reg.eatsLunch ? <span className="material-symbols-outlined text-tertiary">check_circle</span> : <span className="material-symbols-outlined text-outline-variant">cancel</span>}
                                </td>
                              )}
                              <td className="p-md text-on-surface-variant">{formatTimestamp(reg.timestamp)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-md lg:gap-lg px-md md:px-0">
            {/* Monthly Config Section */}
            <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden flex flex-col">
              <div className="p-md border-b border-outline-variant bg-surface-container-low focus:outline-none">
                <h2 className="text-headline-sm text-on-surface uppercase">Cấu hình ĐK ĂN HÀNG THÁNG</h2>
                <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Đóng / Mở form đăng ký suất ăn theo tháng (Năm 2026).</p>
              </div>
              <div className="p-md grid grid-cols-2 md:grid-cols-3 gap-md focus:outline-none">
                {MONTHS.map(month => (
                  <div key={month} className="flex flex-col self-start min-w-0 bg-surface p-sm rounded-lg border border-outline-variant gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-label-md truncate">Tháng {month}</span>
                      <button
                        onClick={() => handleToggleMonth(month)}
                        title={monthlyStatus[month] ? 'Đang mở đăng ký — bấm để khóa' : 'Đang khóa — bấm để mở đăng ký'}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${monthlyStatus[month] ? 'bg-primary' : 'bg-surface-container-high'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-surface-container-lowest shadow-sm transition-transform ${monthlyStatus[month] ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </div>
                    {monthlyStatus[month] && (
                      <div className="flex flex-col gap-1.5 mt-1 border-t border-outline-variant pt-2">
                        <label className="text-[11px] text-on-surface-variant">Tự động khóa lúc:</label>
                        {/* Input và nút Lưu xếp dọc: ô datetime-local có bề rộng tối thiểu khá lớn,
                            để cùng hàng sẽ tràn ra ngoài thẻ tháng ở lưới 2–3 cột. */}
                        <input
                          type="datetime-local"
                          value={monthlyExpiry[month] || ''}
                          onChange={(e) => handleSetMonthExpiry(month, e.target.value)}
                          className="w-full min-w-0 text-xs px-2 py-1.5 bg-surface-bright border border-outline-variant rounded-md text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                        />
                        <button
                          onClick={() => handleSaveMonthExpiry(month)}
                          disabled={savingMonths[month]}
                          className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 bg-primary text-on-primary text-xs rounded-md font-medium hover:bg-primary/90 active:bg-primary/80 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                        >
                          <span className={`material-symbols-outlined text-[15px] ${savingMonths[month] ? 'animate-spin' : ''}`}>
                            {savingMonths[month] ? 'progress_activity' : 'save'}
                          </span>
                          {savingMonths[month] ? 'Đang lưu...' : 'Lưu'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Cancel Config Section */}
            <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden flex flex-col md:col-span-2 lg:col-span-1">
              <div className="p-md border-b border-outline-variant bg-surface-container-low">
                <h2 className="text-headline-sm text-on-surface uppercase">Cấu hình ĐK HỦY ĂN</h2>
                <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Gia hạn thời gian khóa hủy ăn (Mặc định tự động khóa lúc 16:00 ngày hôm trước).</p>
              </div>
              <div className="p-md flex flex-col gap-sm">
                <label className="font-label-md text-on-surface">Mở thêm thời gian khóa tự động đến:</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="datetime-local"
                    value={cancelExtendUntil}
                    onChange={(e) => setCancelExtendUntil(e.target.value)}
                    className="flex-1 min-w-0 bg-surface border border-outline-variant rounded-lg p-2 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                  />
                  <button
                    onClick={handleSaveCancelExtend}
                    disabled={isSavingCancelExtend}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary text-on-primary rounded-lg font-label-md hover:bg-primary/90 active:bg-primary/80 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className={`material-symbols-outlined text-[18px] ${isSavingCancelExtend ? 'animate-spin' : ''}`}>
                      {isSavingCancelExtend ? 'progress_activity' : 'save'}
                    </span>
                    {isSavingCancelExtend ? 'Đang lưu...' : 'Lưu lại'}
                  </button>
                </div>
                <p className="text-[12px] text-on-surface-variant italic">Nếu để trống, hệ thống sẽ giới hạn mặc định lúc 16:00 mỗi ngày.</p>
              </div>
            </div>

            {/* Events Config Section */}
            <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden flex flex-col">
              <div className="p-md border-b border-outline-variant bg-surface-container-low focus:outline-none">
                <h2 className="text-headline-sm text-on-surface uppercase">Cấu hình ĐĂNG KÝ ĂN SỰ KIỆN</h2>
                <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Tạo và quản lý các form đăng ký sự kiện.</p>
              </div>
              <div className="p-md flex flex-col gap-md focus:outline-none">
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={newEventName}
                    onChange={(e) => setNewEventName(e.target.value)}
                    placeholder="Tên sự kiện mới..."
                    className="flex-1 bg-surface border border-outline-variant rounded-lg px-3 py-2 text-[14px] focus:ring-1 focus:ring-primary focus:border-primary"
                  />
                  <button 
                    onClick={handleAddEvent}
                    disabled={!newEventName.trim()}
                    className="bg-primary text-on-primary px-4 py-2 rounded-lg font-label-md hover:bg-primary-container transition-colors disabled:opacity-50"
                  >
                    Thêm
                  </button>
                </div>
                
                <div className="space-y-sm mt-sm max-h-[400px] overflow-y-auto">
                  {events.length === 0 ? (
                    <p className="text-on-surface-variant text-center italic text-[14px] py-4">Chưa có sự kiện nào.</p>
                  ) : (
                    events.map(event => (
                      <div key={event.id} className="flex flex-col bg-surface p-sm border border-outline-variant rounded-lg gap-2 group">
                        <div className="flex justify-between items-center">
                          {editingEventId === event.id ? (
                            <div className="flex-1 flex gap-2 mr-4">
                              <input
                                type="text"
                                value={editingEventName}
                                onChange={(e) => setEditingEventName(e.target.value)}
                                className="flex-1 bg-surface border border-outline-variant rounded px-2 py-1 text-[14px] focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                                autoFocus
                              />
                              <button
                                onClick={() => handleEditEvent(event.id as string)}
                                disabled={!editingEventName.trim()}
                                className="text-xs bg-primary text-on-primary px-2 py-1 rounded disabled:opacity-50 hover:bg-primary/90"
                              >
                                Lưu
                              </button>
                              <button
                                onClick={() => setEditingEventId(null)}
                                className="text-xs bg-surface-variant text-on-surface-variant px-2 py-1 rounded hover:bg-surface-variant/80"
                              >
                                Hủy
                              </button>
                            </div>
                          ) : (
                            <span className="font-body-md font-medium text-[15px]">{event.name}</span>
                          )}
                          <div className="flex items-center gap-sm">
                            {editingEventId !== event.id && (
                              <div className="flex items-center gap-1 mr-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => {
                                    setEditingEventId(event.id as string);
                                    setEditingEventName(event.name);
                                  }}
                                  className="w-7 h-7 flex items-center justify-center text-primary hover:bg-primary-container rounded"
                                  title="Sửa tên"
                                >
                                  <span className="material-symbols-outlined text-[16px]">edit</span>
                                </button>
                                {eventToDelete === event.id ? (
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => handleDeleteEvent(event.id as string)}
                                      className="px-2 py-1 text-xs bg-error text-on-error rounded hover:bg-error/90 transition-colors"
                                    >
                                      Xác nhận
                                    </button>
                                    <button
                                      onClick={() => setEventToDelete(null)}
                                      className="px-2 py-1 text-xs bg-surface-variant text-on-surface-variant rounded hover:bg-surface-variant/80 transition-colors"
                                    >
                                      Hủy
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setEventToDelete(event.id as string)}
                                    className="w-7 h-7 flex items-center justify-center text-error hover:bg-error-container rounded"
                                    title="Xóa"
                                  >
                                    <span className="material-symbols-outlined text-[16px]">delete</span>
                                  </button>
                                )}
                              </div>
                            )}
                            <span className="font-label-sm text-on-surface-variant text-[12px] uppercase">
                              {event.isOpen ? 'Mở' : 'Khóa'}
                            </span>
                            <button 
                              onClick={() => handleToggleEvent(event.id, event.isOpen)}
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${event.isOpen ? 'bg-primary' : 'bg-surface-variant'}`}
                            >
                              <span className={`inline-block h-4 w-4 transform rounded-full bg-surface-container-lowest transition-transform ${event.isOpen ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                          </div>
                        </div>
                        {event.isOpen && (
                          <div className="flex items-center justify-between border-t border-outline-variant pt-2 mt-1">
                            <label className="text-[12px] text-on-surface-variant">Tự động khóa lúc:</label>
                            <input 
                              type="datetime-local"
                              value={event.expiresAt || ''}
                              onChange={(e) => handleSetEventExpiry(event.id, e.target.value)}
                              className="text-xs p-1 bg-surface-bright border border-outline-variant rounded text-on-surface focus:outline-none focus:border-primary max-w-[200px]"
                            />
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'blocked' && (
          <div className="px-md md:px-0 grid grid-cols-1 gap-md">
            {/* Blocked Users Management */}
            <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
                <div className="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low flex-col md:flex-row gap-4">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-headline-sm text-on-surface uppercase focus:outline-none">Quản Lý Vi Phạm</h2>
                    <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Danh sách người dùng không được đăng ký ăn trong thời gian đã chọn.</p>
                  </div>
                  <div className="flex items-center gap-2">
                     <span className="font-label-sm text-on-surface-variant">Tháng áp dụng:</span>
                     <select 
                      value={selectedMonth}
                      onChange={(e) => setSelectedMonth(e.target.value)}
                      className="bg-surface border border-outline-variant rounded px-2 py-0.5 text-sm outline-none"
                     >
                       {MONTHS.map(m => (
                         <option key={m} value={`2026-${m}`}>Tháng {m} / 2026</option>
                       ))}
                     </select>
                  </div>
                </div>
                
                <div className="p-md grid grid-cols-1 md:grid-cols-2 gap-lg items-start">
                  <div className="flex flex-col gap-md">
                    <h3 className="text-label-md text-on-surface">Thêm Email Vi Phạm</h3>
                    <p className="text-sm text-on-surface-variant">Nhập danh sách email cần chặn, mỗi email trên 1 dòng.</p>
                    <textarea 
                      value={blockedEmailsInput}
                      onChange={(e) => setBlockedEmailsInput(e.target.value)}
                      placeholder="email1@school.edu.vn&#10;email2@school.edu.vn"
                      className="w-full bg-surface border border-outline-variant rounded-lg p-3 min-h-[150px] text-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none resize-y"
                    ></textarea>
                    <button 
                      onClick={handleAddBlockedEmails}
                      disabled={!blockedEmailsInput.trim()}
                      className="bg-error text-on-error px-4 py-2 rounded-lg font-label-md disabled:opacity-50 flex justify-center items-center gap-2 hover:bg-error/90 transition-colors w-fit"
                    >
                      <span className="material-symbols-outlined text-[18px]">block</span>
                      Cập nhật danh sách chặn
                    </button>
                  </div>

                  <div className="flex flex-col gap-md">
                    <div className="flex items-center gap-2">
                      <h3 className="text-label-md text-on-surface">Danh sách đang chặn</h3>
                      <span className="bg-error-container text-on-error-container text-xs px-2 py-0.5 rounded-full font-bold">{blockedEmails.length}</span>
                    </div>
                    
                    <div className="bg-surface border border-outline-variant flex-1 rounded-lg overflow-y-auto max-h-[300px] min-h-[200px] flex flex-col p-2 space-y-2">
                      {blockedEmails.length === 0 ? (
                        <div className="flex-1 flex items-center justify-center text-on-surface-variant italic text-sm">
                          Chưa có email nào bị chặn trong tháng này
                        </div>
                      ) : (
                        blockedEmails.map((email, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-surface-bright p-sm rounded border border-outline-variant group hover:border-error transition-colors">
                            <span className="font-body-md text-sm truncate pr-2">{email}</span>
                            <button 
                              onClick={() => handleRemoveBlockedEmail(email)}
                              className="text-on-surface-variant hover:text-error transition-colors p-1"
                              title="Gỡ chặn"
                            >
                              <span className="material-symbols-outlined text-[18px]">close</span>
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
          </div>
        )}

        {activeTab === 'admins' && (
          <div className="px-md md:px-0 grid grid-cols-1 gap-md">
            {/* Admin Management */}
            <div className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
                <div className="p-md border-b border-outline-variant bg-surface-container-low focus:outline-none">
                  <h2 className="text-headline-sm text-on-surface uppercase">Tài Khoản Quản Trị Hệ Thống</h2>
                  <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Danh sách người dùng có quyền truy cập trang quản trị.</p>
                </div>
                
                <div className="p-md space-y-md">
                  <div className="space-y-sm max-h-[500px] overflow-y-auto focus:outline-none">
                    {SUPER_ADMINS.map(sa => (
                      <div key={sa} className="flex items-center justify-between bg-surface-bright p-sm rounded border border-outline-variant">
                        <div className="flex items-center gap-sm">
                          <span className="material-symbols-outlined text-[18px] text-primary">admin_panel_settings</span>
                          <span className="text-body-md text-[14px]">{sa}</span>
                        </div>
                        <span className="font-label-sm px-2 py-0.5 bg-primary-container text-on-primary-container rounded">Super Admin</span>
                      </div>
                    ))}
                    {admins.map((admin, index) => (
                      <div key={index} className="flex items-center justify-between bg-surface-bright p-sm rounded border border-outline-variant">
                        <div className="flex items-center gap-sm">
                          <span className="material-symbols-outlined text-[18px] text-secondary">shield_person</span>
                          <span className="text-body-md text-[14px] truncate">{admin.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-label-sm px-2 py-0.5 bg-surface-variant text-on-surface-variant rounded">Admin</span>
                          {auth.currentUser?.email && SUPER_ADMINS.includes(auth.currentUser.email.toLowerCase()) && admin.id && (
                            adminToDelete?.id === admin.id ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleRemoveAdmin(admin.id as string, admin.email)}
                                  className="px-2 py-1 text-xs bg-error text-on-error rounded hover:bg-error/90 transition-colors"
                                >
                                  Xác nhận
                                </button>
                                <button
                                  onClick={() => setAdminToDelete(null)}
                                  className="px-2 py-1 text-xs bg-surface-variant text-on-surface-variant rounded hover:bg-surface-variant/80 transition-colors"
                                >
                                  Hủy
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setAdminToDelete({ id: admin.id as string, email: admin.email })}
                                className="w-8 h-8 flex items-center justify-center text-error hover:bg-error-container hover:text-on-error-container transition-colors rounded"
                                title="Xóa quyền quản trị"
                              >
                                <span className="material-symbols-outlined text-[18px]">delete</span>
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-outline-variant pt-md mt-md">
                    <h3 className="text-label-md text-on-surface mb-sm">Thêm quản trị viên mới</h3>
                    <div className="flex flex-col sm:flex-row gap-3 max-w-md">
                      <input 
                        type="email" 
                        value={newAdminEmail}
                        onChange={(e) => setNewAdminEmail(e.target.value)}
                        placeholder="Nhập email nhân viên..."
                        className="flex-1 bg-surface border border-outline-variant rounded-lg px-4 py-2 text-[14px] focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                      />
                      <button 
                        onClick={handleAddAdmin}
                        disabled={addingAdmin || !newAdminEmail}
                        className="bg-primary text-on-primary px-4 py-2 flex-shrink-0 rounded-lg flex items-center justify-center hover:bg-primary-container disabled:opacity-50 transition-colors gap-2"
                      >
                        <span className="material-symbols-outlined text-[20px]">person_add</span>
                        <span>Thêm Admin</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
          </div>
        )}

      </main>
      <Footer />
    </div>
  );
}
