import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, db } from '../lib/firebase';
import { collection, query, where, getDocs, doc, setDoc, updateDoc, deleteDoc, addDoc } from 'firebase/firestore';
import * as xlsx from 'xlsx';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';

interface RegistrationData {
  id?: string;
  userId: string;
  fullName: string;
  employeeId: string;
  department: string;
  email: string;
  breakfastCount: number;
  lunchCount: number;
}

interface AdminData {
  email: string;
}

interface EventData {
  id: string;
  name: string;
  isOpen: boolean;
}

const SUPER_ADMIN = 'tuantm@hoangmaistarschool.edu.vn';
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

export default function Admin() {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registrations, setRegistrations] = useState<RegistrationData[]>([]);
  const [admins, setAdmins] = useState<AdminData[]>([]);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [currentMonth] = useState('2026-05'); 
  const [addingAdmin, setAddingAdmin] = useState(false);

  // New Tabs
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');

  // Settings states
  const [monthlyStatus, setMonthlyStatus] = useState<Record<string, boolean>>({});
  const [events, setEvents] = useState<EventData[]>([]);
  const [newEventName, setNewEventName] = useState('');

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user) {
        navigate('/login');
        return;
      }
      
      try {
        let isUserAdmin = user.email === SUPER_ADMIN;
        
        if (!isUserAdmin) {
          const adminsSnapshot = await getDocs(collection(db, 'admins'));
          const adminEmails = adminsSnapshot.docs.map(doc => doc.data().email);
          if (user.email && adminEmails.includes(user.email)) {
            isUserAdmin = true;
          }
        }

        if (!isUserAdmin) {
          navigate('/schedule');
          return;
        }

        setIsAdmin(true);
        fetchData();
        fetchSettings();
      } catch (err) {
        console.error('Error checking admin status:', err);
        navigate('/schedule');
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'registrations'), where('month', '==', currentMonth));
      const querySnapshot = await getDocs(q);
      const regData: RegistrationData[] = [];
      querySnapshot.forEach((doc) => {
        regData.push({ id: doc.id, ...doc.data() } as RegistrationData);
      });
      setRegistrations(regData);

      const adminsSnapshot = await getDocs(collection(db, 'admins'));
      const adminData: AdminData[] = [];
      adminsSnapshot.forEach((doc) => {
        adminData.push(doc.data() as AdminData);
      });
      setAdmins(adminData);
    } catch (err) {
      console.error('Error fetching admin data:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      // Fetch monthly config
      const { getDoc } = await import('firebase/firestore');
      const monthlyDoc = await getDoc(doc(db, 'settings', 'monthlyConfig'));
      if (monthlyDoc.exists()) {
        setMonthlyStatus(monthlyDoc.data() as Record<string, boolean>);
      } else {
        const defaultStatus = MONTHS.reduce((acc, m) => ({ ...acc, [m]: true }), {});
        setMonthlyStatus(defaultStatus);
        await setDoc(doc(db, 'settings', 'monthlyConfig'), defaultStatus);
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

  const totalBreakfast = registrations.reduce((sum, reg) => sum + (reg.breakfastCount || 0), 0);
  const totalLunch = registrations.reduce((sum, reg) => sum + (reg.lunchCount || 0), 0);

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

  const handleExportExcel = () => {
    const exportData = registrations.map((reg, index) => ({
      'STT': index + 1,
      'Mã Nhân Viên': reg.employeeId || 'N/A',
      'Họ và Tên': reg.fullName || 'N/A',
      'Phòng ban/Tổ khối': reg.department || 'N/A',
      'ĐK Bữa sáng': reg.breakfastCount,
      'ĐK Bữa trưa': reg.lunchCount
    }));

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, `Dang_Ky_An_${currentMonth}`);
    xlsx.writeFile(workbook, `Bao_Cao_Dang_Ky_An_${currentMonth}.xlsx`);
  };

  const handleToggleMonth = async (month: string) => {
    const newStatus = !monthlyStatus[month];
    const newMonthlyStatus = { ...monthlyStatus, [month]: newStatus };
    setMonthlyStatus(newMonthlyStatus);
    await updateDoc(doc(db, 'settings', 'monthlyConfig'), {
      [month]: newStatus
    });
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
    } catch (err) {
      console.error('Error adding event:', err);
    }
  };

  const handleToggleEvent = async (id: string, currentStatus: boolean) => {
    try {
      await updateDoc(doc(db, 'events', id), { isOpen: !currentStatus });
      setEvents(events.map(e => e.id === id ? { ...e, isOpen: !currentStatus } : e));
    } catch (err) {
      console.error('Error toggling event:', err);
    }
  };

  if (!isAdmin || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-md">
          <span className="material-symbols-outlined animate-spin text-[48px] text-primary">progress_activity</span>
          <p className="font-body-md text-body-md text-on-surface-variant">Đang tải dữ liệu quản trị...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-on-background min-h-screen flex flex-col font-body-md md:pl-64">
      <Header />
      <Navigation />
      
      <main className="flex-1 max-w-[1440px] w-full mx-auto p-sm md:p-lg lg:p-xl flex flex-col gap-md md:gap-lg mt-16 md:mt-2">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-sm border-b md:border-b-0 border-outline-variant pb-md md:pb-0 px-md md:px-0 mt-md md:mt-0">
          <div>
            <h1 className="font-headline-lg-mobile md:text-headline-lg text-primary md:text-on-surface">Quản Trị Hệ Thống</h1>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1 text-[13px] md:text-[14px]">Quản lý đăng ký suất ăn và tài khoản quản trị.</p>
          </div>
        </div>

        {/* Tabs navigation */}
        <div className="flex border-b border-outline-variant px-md md:px-0 mt-xs mb-sm">
          <button 
            className={`px-4 py-3 font-label-lg transition-colors border-b-2 ${activeTab === 'dashboard' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Thống kê & Báo cáo
          </button>
          <button 
            className={`px-4 py-3 font-label-lg transition-colors border-b-2 ${activeTab === 'settings' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'}`}
            onClick={() => setActiveTab('settings')}
          >
            Cấu hình đăng ký
          </button>
        </div>

        {activeTab === 'dashboard' && (
          <div className="flex flex-col gap-md lg:gap-lg">
            {/* Bento Grid Layout - Summary Statistics */}
            <div className="px-md md:px-0 grid grid-cols-1 md:grid-cols-2 gap-md lg:gap-lg">
              <div className="bg-surface-container-lowest rounded-xl p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant flex flex-col gap-md">
                <div className="flex justify-between items-center">
                  <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Tổng Đăng Ký Sáng ({currentMonth})</span>
                  <span className="material-symbols-outlined text-primary-container" style={{ fontVariationSettings: "'FILL' 1" }}>bakery_dining</span>
                </div>
                <div>
                  <span className="font-headline-lg text-headline-lg text-on-surface">{totalBreakfast}</span>
                  <span className="font-body-md text-body-md text-on-surface-variant ml-1">suất</span>
                </div>
                <div className="w-full bg-surface-variant rounded-full h-2 mt-auto">
                  <div className="bg-primary h-2 rounded-full" style={{ width: '100%' }}></div>
                </div>
              </div>

              <div className="bg-surface-container-lowest rounded-xl p-lg shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant flex flex-col gap-md">
                <div className="flex justify-between items-center">
                  <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Tổng Đăng Ký Trưa ({currentMonth})</span>
                  <span className="material-symbols-outlined text-secondary-container" style={{ fontVariationSettings: "'FILL' 1" }}>lunch_dining</span>
                </div>
                <div>
                  <span className="font-headline-lg text-headline-lg text-on-surface">{totalLunch}</span>
                  <span className="font-body-md text-body-md text-on-surface-variant ml-1">suất</span>
                </div>
                 <div className="w-full bg-surface-variant rounded-full h-2 mt-auto">
                  <div className="bg-secondary h-2 rounded-full" style={{ width: '100%' }}></div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-md lg:gap-lg px-md md:px-0">
              {/* Main Content - Registration List */}
              <div className="lg:col-span-2 bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden flex flex-col">
                <div className="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low flex-col md:flex-row gap-4">
                  <h2 className="font-headline-sm text-headline-sm text-on-surface">Danh Sách Đăng Ký ({currentMonth})</h2>
                  <button 
                    onClick={handleExportExcel}
                    className="flex items-center gap-2 bg-[#21a366] hover:bg-[#107c41] text-white px-4 py-2 rounded-lg font-label-md transition-colors w-full md:w-auto justify-center"
                  >
                    <span className="material-symbols-outlined text-[20px]">download</span>
                    Xuất Excel
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                      <tr>
                        <th className="p-md">STT</th>
                        <th className="p-md">Mã NV</th>
                        <th className="p-md">Tên</th>
                        <th className="p-md">Phòng ban</th>
                        <th className="p-md">Sáng</th>
                        <th className="p-md">Trưa</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant text-[14px]">
                      {registrations.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-xl text-center text-on-surface-variant italic">
                            Chưa có dữ liệu đăng ký.
                          </td>
                        </tr>
                      ) : (
                        registrations.map((reg, index) => (
                          <tr key={reg.id || index} className="hover:bg-surface-container-lowest transition-colors">
                            <td className="p-md">{index + 1}</td>
                            <td className="p-md">{reg.employeeId || 'N/A'}</td>
                            <td className="p-md">{reg.fullName}</td>
                            <td className="p-md">{reg.department || 'N/A'}</td>
                            <td className="p-md">{reg.breakfastCount}</td>
                            <td className="p-md">{reg.lunchCount}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Admin Management Sidebar */}
              <div className="lg:col-span-1 flex flex-col gap-md lg:gap-lg">
                <div className="bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden">
                  <div className="p-md border-b border-outline-variant bg-surface-container-low">
                    <h2 className="font-headline-sm text-headline-sm text-on-surface">Tài Khoản Quản Trị</h2>
                  </div>
                  
                  <div className="p-md space-y-md">
                    <div className="space-y-sm max-h-[300px] overflow-y-auto">
                      <div className="flex items-center gap-sm bg-surface-bright p-sm rounded border border-outline-variant">
                        <span className="material-symbols-outlined text-[18px] text-primary">admin_panel_settings</span>
                        <span className="font-body-md text-body-md flex-1 text-[14px]">{SUPER_ADMIN} (Super)</span>
                      </div>
                      {admins.map((admin, index) => (
                        <div key={index} className="flex items-center gap-sm bg-surface-bright p-sm rounded border border-outline-variant">
                          <span className="material-symbols-outlined text-[18px] text-secondary">shield_person</span>
                          <span className="font-body-md text-body-md flex-1 text-[14px] truncate">{admin.email}</span>
                        </div>
                      ))}
                    </div>

                    <div className="border-t border-outline-variant pt-md mt-md">
                      <h3 className="font-label-md text-label-md text-on-surface mb-sm">Thêm quản trị viên</h3>
                      <div className="flex gap-2">
                        <input 
                          type="email" 
                          value={newAdminEmail}
                          onChange={(e) => setNewAdminEmail(e.target.value)}
                          placeholder="Email quản trị mới"
                          className="flex-1 min-w-0 bg-surface border border-outline-variant rounded-lg px-3 py-2 text-[14px] focus:ring-1 focus:ring-primary focus:border-primary"
                        />
                        <button 
                          onClick={handleAddAdmin}
                          disabled={addingAdmin || !newAdminEmail}
                          className="bg-primary text-on-primary px-3 py-2 rounded-lg flex items-center justify-center hover:bg-primary-container disabled:opacity-50 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[20px]">person_add</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-md lg:gap-lg px-md md:px-0">
            {/* Monthly Config Section */}
            <div className="bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden flex flex-col">
              <div className="p-md border-b border-outline-variant bg-surface-container-low">
                <h2 className="font-headline-sm text-headline-sm text-on-surface">ĐK ĂN HÀNG THÁNG</h2>
                <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Đóng / Mở form đăng ký suất ăn theo tháng (Năm 2026).</p>
              </div>
              <div className="p-md grid grid-cols-2 md:grid-cols-3 gap-md">
                {MONTHS.map(month => (
                  <div key={month} className="flex items-center justify-between bg-surface p-sm rounded-lg border border-outline-variant">
                    <span className="font-label-md">Tháng {month}</span>
                    <button 
                      onClick={() => handleToggleMonth(month)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${monthlyStatus[month] ? 'bg-primary' : 'bg-surface-variant'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${monthlyStatus[month] ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Events Config Section */}
            <div className="bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden flex flex-col">
              <div className="p-md border-b border-outline-variant bg-surface-container-low">
                <h2 className="font-headline-sm text-headline-sm text-on-surface">ĐĂNG KÝ ĂN SỰ KIỆN</h2>
                <p className="font-body-md text-on-surface-variant text-[13px] mt-1">Tạo và quản lý các form đăng ký sự kiện.</p>
              </div>
              <div className="p-md flex flex-col gap-md">
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
                      <div key={event.id} className="flex justify-between items-center p-sm bg-surface border border-outline-variant rounded-lg">
                        <span className="font-body-md font-medium text-[15px]">{event.name}</span>
                        <div className="flex items-center gap-sm">
                          <span className="font-label-sm text-on-surface-variant text-[12px] uppercase">
                            {event.isOpen ? 'Mở' : 'Khóa'}
                          </span>
                          <button 
                            onClick={() => handleToggleEvent(event.id, event.isOpen)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${event.isOpen ? 'bg-primary' : 'bg-surface-variant'}`}
                          >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${event.isOpen ? 'translate-x-6' : 'translate-x-1'}`} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
