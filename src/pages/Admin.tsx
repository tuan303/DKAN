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
  const [eventRegistrations, setEventRegistrations] = useState<any[]>([]);
  const [admins, setAdmins] = useState<AdminData[]>([]);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('2026-05'); 
  const [selectedEventId, setSelectedEventId] = useState('');
  
  // Filters for Monthly
  const [nameFilter, setNameFilter] = useState('');
  const [idFilter, setIdFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

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
        fetchEventRegistrations();
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
      const q = query(collection(db, 'registrations'), where('month', '==', selectedMonth));
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

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [selectedMonth, isAdmin]);

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

  const filteredRegistrations = registrations.filter(reg => {
    const matchesName = reg.fullName.toLowerCase().includes(nameFilter.toLowerCase());
    const matchesId = (reg.employeeId || '').toLowerCase().includes(idFilter.toLowerCase());
    const matchesDept = (reg.department || '').toLowerCase().includes(deptFilter.toLowerCase());
    return matchesName && matchesId && matchesDept;
  });

  const totalBreakfast = filteredRegistrations.reduce((sum, reg) => sum + (reg.breakfastCount || 0), 0);
  const totalLunch = filteredRegistrations.reduce((sum, reg) => sum + (reg.lunchCount || 0), 0);

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
    const exportData = filteredRegistrations.map((reg, index) => ({
      'STT': index + 1,
      'Mã Nhân Viên': reg.employeeId || 'N/A',
      'Họ và Tên': reg.fullName || 'N/A',
      'Phòng ban/Tổ khối': reg.department || 'N/A',
      'ĐK Bữa sáng': reg.breakfastCount,
      'ĐK Bữa trưa': reg.lunchCount
    }));

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, `Dang_Ky_An_${selectedMonth}`);
    xlsx.writeFile(workbook, `Bao_Cao_Dang_Ky_An_${selectedMonth}.xlsx`);
  };

  const handleExportEventExcel = () => {
    const event = events.find(e => e.id === selectedEventId);
    if (!event) return;

    const exportData = eventRegistrations.map((reg, index) => ({
      'STT': index + 1,
      'Họ và Tên': reg.fullName || 'N/A',
      'Email': reg.email || 'N/A',
      'Lựa chọn': reg.choice === 'yes' ? 'Có ăn' : 'Không ăn',
      'Thời gian': reg.timestamp
    }));

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, `Su_Kien_${event.name}`);
    xlsx.writeFile(workbook, `Bao_Cao_${event.name}.xlsx`);
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
                  <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Tổng Đăng Ký Sáng ({selectedMonth})</span>
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
                  <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Tổng Đăng Ký Trưa ({selectedMonth})</span>
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
              <div className="lg:col-span-3 bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden flex flex-col">
                <div className="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low flex-col md:flex-row gap-4">
                  <div className="flex flex-col gap-1">
                    <h2 className="font-headline-sm text-headline-sm text-on-surface">Danh Sách Đăng Ký Ăn Hàng Tháng</h2>
                    <div className="flex items-center gap-2">
                       <span className="font-label-sm text-on-surface-variant">Tháng:</span>
                       <select 
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-surface border border-outline-variant rounded px-2 py-0.5 text-sm outline-none"
                       >
                         {MONTHS.map(m => (
                           <option key={m} value={`2026-${m}`}>Tháng {m}</option>
                         ))}
                       </select>
                    </div>
                  </div>
                  <button 
                    onClick={handleExportExcel}
                    className="flex items-center gap-2 bg-[#21a366] hover:bg-[#107c41] text-white px-4 py-2 rounded-lg font-label-md transition-colors w-full md:w-auto justify-center"
                  >
                    <span className="material-symbols-outlined text-[20px]">download</span>
                    Xuất Excel
                  </button>
                </div>

                <div className="p-md bg-surface-bright grid grid-cols-1 md:grid-cols-3 gap-md border-b border-outline-variant">
                   <div className="flex flex-col gap-1">
                      <label className="font-label-sm text-on-surface-variant">Lọc theo Tên</label>
                      <input 
                        type="text" 
                        value={nameFilter}
                        onChange={(e) => setNameFilter(e.target.value)}
                        placeholder="Nhập tên..."
                        className="bg-surface border border-outline-variant rounded px-3 py-1.5 text-[14px]"
                      />
                   </div>
                   <div className="flex flex-col gap-1">
                      <label className="font-label-sm text-on-surface-variant">Lọc theo Mã NV</label>
                      <input 
                        type="text" 
                        value={idFilter}
                        onChange={(e) => setIdFilter(e.target.value)}
                        placeholder="Nhập mã nhân viên..."
                        className="bg-surface border border-outline-variant rounded px-3 py-1.5 text-[14px]"
                      />
                   </div>
                   <div className="flex flex-col gap-1">
                      <label className="font-label-sm text-on-surface-variant">Lọc theo Phòng ban</label>
                      <input 
                        type="text" 
                        value={deptFilter}
                        onChange={(e) => setDeptFilter(e.target.value)}
                        placeholder="Nhập phòng ban..."
                        className="bg-surface border border-outline-variant rounded px-3 py-1.5 text-[14px]"
                      />
                   </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                      <tr>
                        <th className="p-md">STT</th>
                        <th className="p-md">Mã NV</th>
                        <th className="p-md">Tên</th>
                        <th className="p-md">Phòng ban</th>
                        <th className="p-md text-right">Sáng</th>
                        <th className="p-md text-right">Trưa</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant text-[14px]">
                      {filteredRegistrations.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-xl text-center text-on-surface-variant italic">
                            Chưa có dữ liệu đăng ký thỏa mãn điều kiện lọc.
                          </td>
                        </tr>
                      ) : (
                        filteredRegistrations.map((reg, index) => (
                          <tr key={reg.id || index} className="hover:bg-surface-container-lowest transition-colors">
                            <td className="p-md">{index + 1}</td>
                            <td className="p-md">{reg.employeeId || 'N/A'}</td>
                            <td className="p-md font-medium text-on-surface">{reg.fullName}</td>
                            <td className="p-md">{reg.department || 'N/A'}</td>
                            <td className="p-md text-right">{reg.breakfastCount}</td>
                            <td className="p-md text-right">{reg.lunchCount}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Event Registration List */}
              <div className="lg:col-span-3 bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden flex flex-col mt-md">
                <div className="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low flex-col md:flex-row gap-4">
                  <div className="flex flex-col gap-1">
                    <h2 className="font-headline-sm text-headline-sm text-on-surface uppercase pr-4">Danh Sách Đăng Ký Ăn Sự Kiện</h2>
                    <div className="flex items-center gap-2">
                       <span className="font-label-sm text-on-surface-variant">Sự kiện:</span>
                       <select 
                        value={selectedEventId}
                        onChange={(e) => setSelectedEventId(e.target.value)}
                        className="bg-surface border border-outline-variant rounded px-2 py-0.5 text-sm outline-none max-w-[250px]"
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
                    className="flex items-center gap-2 bg-[#21a366] hover:bg-[#107c41] text-white px-4 py-2 rounded-lg font-label-md transition-colors w-full md:w-auto justify-center disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[20px]">download</span>
                    Xuất Excel Sự Kiện
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-surface-bright border-b border-outline-variant font-label-md text-on-surface-variant text-[13px]">
                      <tr>
                        <th className="p-md">STT</th>
                        <th className="p-md">Họ và Tên</th>
                        <th className="p-md">Email</th>
                        <th className="p-md">Lựa chọn</th>
                        <th className="p-md">Thời gian đăng ký</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant text-[14px]">
                      {eventRegistrations.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="p-xl text-center text-on-surface-variant italic">
                            {!selectedEventId ? 'Vui lòng chọn sự kiện để xem danh sách.' : 'Chưa có dữ liệu đăng ký cho sự kiện này.'}
                          </td>
                        </tr>
                      ) : (
                        eventRegistrations.map((reg, index) => (
                          <tr key={reg.id || index} className="hover:bg-surface-container-lowest transition-colors">
                            <td className="p-md">{index + 1}</td>
                            <td className="p-md font-medium text-on-surface">{reg.fullName}</td>
                            <td className="p-md">{reg.email}</td>
                            <td className="p-md">
                               <span className={`px-2 py-1 rounded text-[12px] font-medium ${reg.choice === 'yes' ? 'bg-[#d1fae5] text-[#065f46]' : 'bg-error-container text-on-error-container'}`}>
                                  {reg.choice === 'yes' ? 'Có ăn' : 'Không ăn'}
                               </span>
                            </td>
                            <td className="p-md text-on-surface-variant">{new Date(reg.timestamp).toLocaleString('vi-VN')}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Admin Management */}
              <div className="lg:col-span-3 bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] border border-outline-variant overflow-hidden mt-md">
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
