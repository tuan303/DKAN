import { Header } from '../components/Header';
import { useNavigate } from 'react-router-dom';

export default function RegisterStaff() {
  const navigate = useNavigate();

  return (
    <div className="bg-background text-on-background min-h-screen flex flex-col font-body-md">
      <Header />
      
      {/* Main Content Canvas */}
      <main className="flex-grow pt-24 pb-md px-md md:px-lg flex flex-col items-center justify-center">
        <div className="w-full max-w-[600px] bg-surface-container-lowest rounded-xl shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05),_0_2px_4px_-1px_rgba(26,54,93,0.03)] border border-surface-variant overflow-hidden flex flex-col">
          
          {/* Form Header */}
          <div className="p-lg border-b border-surface-variant bg-surface-bright">
            <h2 className="font-headline-md text-headline-md text-on-surface mb-xs">Đăng ký thông tin</h2>
            <p className="font-body-md text-body-md text-on-surface-variant">Vui lòng điền đầy đủ thông tin bên dưới để tiếp tục.</p>
          </div>

          {/* Form Body */}
          <div className="p-lg flex flex-col gap-lg">
            
            {/* Full Name Field */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="fullName" className="font-label-md text-label-md text-on-surface">Họ tên</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">badge</span>
                </div>
                <input 
                  type="text" 
                  id="fullName" 
                  name="fullName" 
                  placeholder="Nhập họ và tên của bạn" 
                  required 
                  className="block w-full pl-xl pr-md py-sm bg-surface-container-lowest border border-outline-variant rounded focus:ring-2 focus:ring-primary focus:border-primary font-body-md text-body-md text-on-surface placeholder-outline transition-shadow" 
                />
              </div>
            </div>

            {/* Employee ID Field */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="employeeId" className="font-label-md text-label-md text-on-surface">Mã nhân viên</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">badge</span>
                </div>
                <input 
                  type="text" 
                  id="employeeId" 
                  name="employeeId" 
                  placeholder="Nhập mã nhân viên của bạn" 
                  required 
                  className="block w-full pl-xl pr-md py-sm bg-surface-container-lowest border border-outline-variant rounded focus:ring-2 focus:ring-primary focus:border-primary font-body-md text-body-md text-on-surface placeholder-outline transition-shadow" 
                />
              </div>
            </div>
            
            {/* Department/Group Field */}
            <div className="flex flex-col gap-sm">
              <label htmlFor="department" className="font-label-md text-label-md text-on-surface">Phòng ban / Tổ khối</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">domain</span>
                </div>
                <select 
                  id="department" 
                  name="department" 
                  required 
                  defaultValue=""
                  className="block w-full pl-xl pr-md py-sm bg-surface-container-lowest border border-outline-variant rounded focus:ring-2 focus:ring-primary focus:border-primary font-body-md text-body-md text-on-surface appearance-none transition-shadow"
                >
                  <option value="" disabled>Chọn phòng ban / tổ khối</option>
                  <option value="admin">Ban Giám Hiệu</option>
                  <option value="hr">Phòng Hành Chính - Nhân Sự</option>
                  <option value="finance">Phòng Tài Vụ</option>
                  <option value="teachers">Tổ Giáo Viên</option>
                  <option value="cafeteria">Tổ Bếp / Căn Tin</option>
                </select>
                <div className="absolute inset-y-0 right-0 pr-sm flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline">arrow_drop_down</span>
                </div>
              </div>
            </div>

          </div>

          {/* Form Actions */}
          <div className="p-lg border-t border-surface-variant bg-surface-bright flex justify-end gap-md">
            <button 
              type="button" 
              onClick={() => navigate('/login')}
              className="px-md py-sm bg-surface-container-lowest border border-outline font-label-md text-label-md text-on-surface rounded hover:bg-surface-container-low transition-colors shadow-sm"
            >
              Hủy
            </button>
            <button 
              type="button" 
              onClick={() => navigate('/dashboard')}
              className="px-md py-sm bg-primary border border-transparent font-label-md text-label-md text-on-primary rounded hover:bg-primary-container hover:text-on-primary-container transition-colors shadow-sm flex items-center gap-xs"
            >
              Tiếp tục
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>
          
        </div>
      </main>
    </div>
  );
}
