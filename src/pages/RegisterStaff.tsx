import { Header } from '../components/Header';
import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { auth, db } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { Footer } from '../components/Footer';

// Mã nhân viên của trường: 6 chữ số, bắt đầu bằng 10. Đối chiếu với hệ thống
// chấm công tháng 8/2026 thì toàn bộ 622 CBGV-NV đều theo đúng dạng này.
// Ràng buộc ngay từ đây là để mã trong phần mềm khớp được với máy chấm công —
// gõ sai một ký tự là người đó không đối soát được suất ăn.
const EMPLOYEE_ID_PATTERN = /^10\d{4}$/;

export default function RegisterStaff() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [department, setDepartment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idValid = EMPLOYEE_ID_PATTERN.test(employeeId);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (!user) {
        navigate('/login');
      } else if (user.displayName) {
        setFullName(user.displayName);
      }
    });
    return () => unsubscribe();
  }, [navigate]);

  const handleSubmit = async () => {
    if (!fullName || !employeeId || !department) {
      setError('Vui lòng điền đầy đủ thông tin');
      return;
    }

    if (!EMPLOYEE_ID_PATTERN.test(employeeId)) {
      setError('Mã nhân viên phải gồm đúng 6 chữ số và bắt đầu bằng 10 (ví dụ: 100303).');
      return;
    }

    const user = auth.currentUser;
    if (!user) {
      setError('Bạn chưa đăng nhập');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await setDoc(doc(db, 'staff', user.uid), {
        fullName: fullName.trim(),
        employeeId,
        department,
        email: user.email,
        createdAt: new Date().toISOString(),
      });
      navigate('/schedule');
    } catch (err: any) {
      console.error(err);
      setError('Lỗi khi lưu thông tin: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background text-on-background min-h-screen flex flex-col font-body-md">
      <Header />
      
      {/* Main Content Canvas */}
      <main className="flex-grow pt-20 md:pt-24 pb-md px-4 md:px-lg flex flex-col items-center justify-center">
        <div className="w-full max-w-[600px] bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),_0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-surface-variant overflow-hidden flex flex-col">
          
          {/* Form Header */}
          <div className="p-md md:p-lg border-b border-surface-variant bg-surface-bright">
            <h2 className="text-headline-md text-on-surface mb-xs">Đăng ký thông tin</h2>
            <p className="text-body-md text-on-surface-variant italic">Trường Họ tên được mặc định theo Tên hiển thị của Email và không thể chỉnh sửa.</p>
          </div>

          {/* Form Body */}
          <div className="p-md md:p-lg flex flex-col gap-md md:gap-lg">
            
            {error && (
              <div className="bg-error-container text-on-error-container p-sm rounded-lg text-body-md">
                {error}
              </div>
            )}

            {/* Full Name Field */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="fullName" className="text-label-md text-on-surface">Họ tên</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">badge</span>
                </div>
                <input 
                  type="text" 
                  id="fullName" 
                  name="fullName" 
                  value={fullName}
                  readOnly
                  placeholder="Họ và tên của bạn" 
                  required 
                  className="block w-full pl-xl pr-md py-sm bg-surface-container border border-outline-variant rounded focus:ring-0 cursor-not-allowed text-body-md text-on-surface-variant transition-shadow" 
                />
              </div>
            </div>

            {/* Employee ID Field */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="employeeId" className="text-label-md text-on-surface">Mã nhân viên</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">badge</span>
                </div>
                <input
                  type="text"
                  id="employeeId"
                  name="employeeId"
                  value={employeeId}
                  // Chỉ nhận chữ số và tối đa 6 ký tự: chặn luôn khoảng trắng
                  // thừa ngay từ lúc gõ, vì mã dư một dấu cách là không khớp
                  // được với máy chấm công.
                  onChange={(e) => setEmployeeId(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  placeholder="Ví dụ: 100303"
                  required
                  aria-invalid={employeeId.length > 0 && !idValid}
                  aria-describedby="employeeId-hint"
                  className={`block w-full pl-xl pr-md py-sm bg-surface-container-lowest border rounded focus:ring-2 text-body-md text-on-surface placeholder-outline transition-shadow tabular ${
                    employeeId.length > 0 && !idValid
                      ? 'border-error focus:ring-error focus:border-error'
                      : 'border-outline-variant focus:ring-primary focus:border-primary'
                  }`}
                />
              </div>
              <p
                id="employeeId-hint"
                className={`text-body-sm ${employeeId.length > 0 && !idValid ? 'text-error' : 'text-on-surface-variant'}`}
              >
                {employeeId.length > 0 && !idValid
                  ? 'Mã phải gồm đúng 6 chữ số và bắt đầu bằng 10.'
                  : 'Gồm 6 chữ số, bắt đầu bằng 10 — đúng mã trên hệ thống chấm công.'}
              </p>
            </div>
            
            {/* Department/Group Field */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="department" className="text-label-md text-on-surface">Phòng ban / Tổ khối</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">domain</span>
                </div>
                <select 
                  id="department" 
                  name="department" 
                  required 
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="block w-full pl-xl pr-md py-sm bg-surface-container-lowest border border-outline-variant rounded focus:ring-2 focus:ring-primary focus:border-primary text-body-md text-on-surface appearance-none transition-shadow"
                >
                  <option value="" disabled>Chọn phòng ban / tổ / khối</option>
                  <option value="BAN LÃNH ĐẠO">BAN LÃNH ĐẠO</option>
                  <option value="THƯ KÝ - TRỢ LÝ">THƯ KÝ - TRỢ LÝ</option>
                  <option value="PHÒNG HTQT & HN">PHÒNG HTQT & HN</option>
                  <option value="PHÒNG KẾ TOÁN">PHÒNG KẾ TOÁN</option>
                  <option value="PHÒNG HÀNH CHÍNH">PHÒNG HÀNH CHÍNH</option>
                  <option value="BỘ PHẬN CNTT">BỘ PHẬN CNTT</option>
                  <option value="PHÒNG NHÂN SỰ">PHÒNG NHÂN SỰ</option>
                  <option value="PHÒNG TRUYỀN THÔNG">PHÒNG TRUYỀN THÔNG</option>
                  <option value="PHÒNG GIÁO VỤ">PHÒNG GIÁO VỤ</option>
                  <option value="PHÒNG KHẢO THÍ">PHÒNG KHẢO THÍ</option>
                  <option value="PHÒNG TUYỂN SINH">PHÒNG TUYỂN SINH</option>
                  <option value="BAN GIÁM HIỆU">BAN GIÁM HIỆU</option>
                  <option value="CHĂM SÓC HỌC SINH">CHĂM SÓC HỌC SINH</option>
                  <option value="KHỐI 1">KHỐI 1</option>
                  <option value="KHỐI 2">KHỐI 2</option>
                  <option value="KHỐI 3">KHỐI 3</option>
                  <option value="KHỐI 4">KHỐI 4</option>
                  <option value="KHỐI 5">KHỐI 5</option>
                  <option value="KHCN TiH">KHCN TiH</option>
                  <option value="TIẾNG ANH TiH">TIẾNG ANH TiH</option>
                  <option value="TỔ THỂ THAO">TỔ THỂ THAO</option>
                  <option value="TRẢI NGHIỆM">TRẢI NGHIỆM</option>
                  <option value="TỔ NĂNG KHIẾU">TỔ NĂNG KHIẾU</option>
                  <option value="TỔ TOÁN THCS">TỔ TOÁN THCS</option>
                  <option value="KHCN THCS">KHCN THCS</option>
                  <option value="XÃ HỘI THCS">XÃ HỘI THCS</option>
                  <option value="NGOẠI NGỮ THCS">NGOẠI NGỮ THCS</option>
                  <option value="TỔ TOÁN THPT">TỔ TOÁN THPT</option>
                  <option value="KHCN THPT">KHCN THPT</option>
                  <option value="XÃ HỘI THPT">XÃ HỘI THPT</option>
                  <option value="NGOẠI NGỮ THPT">NGOẠI NGỮ THPT</option>
                  <option value="GIÁO VIÊN THỈNH GIẢNG">GIÁO VIÊN THỈNH GIẢNG</option>
                  <option value="ĐỐI TÁC">ĐỐI TÁC</option>
                  <option value="CỘNG TÁC VIÊN">CỘNG TÁC VIÊN</option>
                  <option value="Khác">Khác</option>
                </select>
                <div className="absolute inset-y-0 right-0 pr-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">arrow_drop_down</span>
                </div>
              </div>
            </div>

          </div>

          {/* Form Actions */}
          <div className="p-md md:p-lg border-t border-surface-variant bg-surface-bright flex flex-col-reverse md:flex-row justify-end gap-sm md:gap-md">
            <button 
              type="button" 
              onClick={() => navigate('/login')}
              disabled={loading}
              className="w-full md:w-auto px-md py-sm bg-surface-container-lowest border border-outline text-label-md text-on-surface rounded hover:bg-surface-container-low transition-colors shadow-sm disabled:opacity-50"
            >
              Hủy
            </button>
            <button 
              type="button" 
              onClick={handleSubmit}
              disabled={loading}
              className="w-full md:w-auto justify-center px-md py-sm bg-primary border border-transparent text-label-md text-on-primary rounded hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm flex items-center gap-xs disabled:opacity-50"
            >
              {loading ? 'Đang lưu...' : 'Tiếp tục'}
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>
          
        </div>
      </main>
      <Footer />
    </div>
  );
}
