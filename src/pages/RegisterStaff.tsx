import { Header } from '../components/Header';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { auth, db } from '../lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { Footer } from '../components/Footer';
import { safeNextPath } from './Login';

// Mã nhân viên của trường: 6 chữ số, bắt đầu bằng 10. Đối chiếu với hệ thống
// chấm công tháng 8/2026 thì toàn bộ 622 CBGV-NV đều theo đúng dạng này.
// Ràng buộc ngay từ đây là để mã trong phần mềm khớp được với máy chấm công —
// gõ sai một ký tự là người đó không đối soát được suất ăn.
const EMPLOYEE_ID_PATTERN = /^10\d{4}$/;

export default function RegisterStaff() {
  const navigate = useNavigate();
  // Trang đích sau khi khai báo (vd /cham-an từ link trong email). Lọc lại ở
  // đây chứ không tin Login đã lọc: ai cũng gõ thẳng /register?next=... được.
  const [searchParams] = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const loginPath = next ? `/login?next=${encodeURIComponent(next)}` : '/login';
  const [fullName, setFullName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [department, setDepartment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idValid = EMPLOYEE_ID_PATTERN.test(employeeId);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (!user) {
        navigate(loginPath);
        return;
      }
      if (user.displayName) setFullName(user.displayName);
      // Điền sẵn mã NV và phòng ban đã khai lần trước. Bắt gõ lại mã ở mỗi lần
      // đăng nhập là cơ hội gõ nhầm mỗi ngày: mã hồ sơ lệch với mã trên đơn
      // đăng ký thì trang Chấm ăn của tôi khó hiểu, mà gõ nhầm sang mã người
      // khác còn gây trùng mã. Chỉ điền khi ô còn trống (không đè chữ đang gõ)
      // và mã đúng dạng (mã cũ sai dạng thì để Thầy/Cô nhập lại cho đúng).
      getDoc(doc(db, 'staff', user.uid))
        .then((snap) => {
          if (!snap.exists()) return;
          const data = snap.data();
          const savedId = typeof data.employeeId === 'string' ? data.employeeId.trim() : '';
          if (EMPLOYEE_ID_PATTERN.test(savedId)) setEmployeeId((prev) => prev || savedId);
          if (typeof data.department === 'string' && data.department) {
            setDepartment((prev) => prev || data.department);
          }
        })
        // Không đọc được hồ sơ cũ thì vẫn khai báo tay như trước.
        .catch((err) => console.warn('Không đọc được hồ sơ nhân viên đã lưu:', err));
    });
    return () => unsubscribe();
  }, [navigate, loginPath]);

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
      navigate(next ?? '/schedule');
    } catch (err: any) {
      console.error(err);
      setError('Lỗi khi lưu thông tin: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-background text-on-background flex flex-col pb-[env(safe-area-inset-bottom)]">
      <Header />
      
      <main className="mx-auto w-full max-w-[680px] flex-grow px-4 pb-6 pt-[calc(80px+env(safe-area-inset-top))] sm:px-6 sm:pb-12 sm:pt-[calc(112px+env(safe-area-inset-top))]">
        <div className="mb-5 sm:mb-6">
          <p className="text-xs font-medium text-on-surface-variant">Tài khoản nhà trường / Hồ sơ nhân viên</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-on-surface sm:text-3xl">Thông tin nhân viên</h1>
          <p className="mt-2 text-body-md text-on-surface-variant">Hoàn thiện hồ sơ để đăng ký và theo dõi suất ăn của bạn.</p>
        </div>
        <section aria-labelledby="profile-title" aria-busy={loading} className="min-w-0 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-xs">
          
          <div className="flex items-start gap-3 border-b border-outline-variant p-4 sm:p-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-container text-primary" aria-hidden="true">
              <span className="material-symbols-outlined text-[22px]">manage_accounts</span>
            </span>
            <div className="min-w-0">
              <h2 id="profile-title" className="text-base font-semibold text-on-surface">Hồ sơ đăng ký ăn</h2>
              <p className="mt-1 text-body-sm text-on-surface-variant">Thông tin dùng để đối chiếu đăng ký và chấm ăn.</p>
            </div>
          </div>

          <div className="flex flex-col gap-5 p-4 sm:gap-6 sm:p-6">
            
            {error && (
              <div role="alert" className="rounded-lg border border-error/20 bg-error-container p-3 text-body-sm text-on-error-container break-words">
                {error}
              </div>
            )}

            {/* Full Name Field */}
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="fullName" className="text-sm font-semibold text-on-surface">Họ và tên</label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3" aria-hidden="true">
                  <span className="material-symbols-outlined text-[20px] text-on-surface-variant">person</span>
                </div>
                <input 
                  type="text" 
                  id="fullName" 
                  name="fullName" 
                  value={fullName}
                  readOnly
                  placeholder="Họ và tên của bạn" 
                  required 
                  aria-describedby="fullName-hint"
                  className="block min-h-11 w-full rounded-lg border border-outline-variant bg-surface-container py-2.5 pl-10 pr-3 text-base sm:text-body-md text-on-surface-variant focus-visible:outline-2 focus-visible:outline-primary"
                />
              </div>
              <p id="fullName-hint" className="text-body-sm text-on-surface-variant">Lấy từ tên hiển thị của email nhà trường, không thể chỉnh sửa tại đây.</p>
            </div>

            {/* Employee ID Field */}
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="employeeId" className="text-sm font-semibold text-on-surface">Mã nhân viên <span className="text-error" aria-hidden="true">*</span></label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3" aria-hidden="true">
                  <span className="material-symbols-outlined text-[20px] text-on-surface-variant">badge</span>
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
                  className={`block min-h-11 w-full rounded-lg border bg-surface-container-lowest py-2.5 pl-10 pr-3 text-base sm:text-body-md text-on-surface placeholder-on-surface-variant transition-shadow focus:outline-none focus:ring-2 tabular ${
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
            <div className="flex min-w-0 flex-col gap-2">
              <label htmlFor="department" className="text-sm font-semibold text-on-surface">Phòng ban / Tổ khối <span className="text-error" aria-hidden="true">*</span></label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3" aria-hidden="true">
                  <span className="material-symbols-outlined text-[20px] text-on-surface-variant">domain</span>
                </div>
                <select 
                  id="department" 
                  name="department" 
                  required 
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="block min-h-11 w-full min-w-0 appearance-none rounded-lg border border-outline-variant bg-surface-container-lowest py-2.5 pl-10 pr-9 text-base sm:text-body-md text-on-surface transition-shadow focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
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
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3" aria-hidden="true">
                  <span className="material-symbols-outlined text-[20px] text-on-surface-variant">expand_more</span>
                </div>
              </div>
            </div>

          </div>

          <div className="flex flex-col-reverse justify-end gap-2 border-t border-outline-variant bg-surface-container-low px-4 py-4 sm:flex-row sm:gap-3 sm:px-6">
            <button 
              type="button" 
              onClick={() => navigate(loginPath)}
              disabled={loading}
              className="min-h-11 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-5 py-2.5 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              Hủy
            </button>
            <button 
              type="button" 
              onClick={handleSubmit}
              disabled={loading}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {loading ? 'Đang lưu...' : 'Tiếp tục'}
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">arrow_forward</span>
            </button>
          </div>
          
        </section>
      </main>
      <Footer />
    </div>
  );
}
