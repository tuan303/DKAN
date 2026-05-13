import { useNavigate } from 'react-router-dom';

export default function Login() {
  const navigate = useNavigate();

  return (
    <div className="bg-background text-on-background min-h-screen flex antialiased">
      <div className="hidden lg:flex lg:w-1/2 relative bg-surface-variant overflow-hidden">
        <div 
          className="absolute inset-0 bg-cover bg-center transition-transform duration-1000 scale-105" 
          style={{ backgroundImage: "url('https://lh3.googleusercontent.com/aida-public/AB6AXuBGzbWicP9-rNaDYHxwfLA5Hmv_4SEN7-Y6-uhRtX8kqnkSL3rfiQeR7BAQaQh5r0Z8kttUYu6v1EsEz3d9WFXYlQ-Y64h81xLOyBPzsZEOJVt9j_a8Jw5RbE5DUWqRafY_a48W1W6bAxEf4RltBSHx2chQEn-blYaVTNHVfUGjukeMkzTlIaDNbGPaohdkCboNdXWpW_4WjjmDELvZ53OOkHCldEEIgbPsjbj1uZ8fWNiVVEY3TVaK59f-767FpZkacy-MN446A7ZW')" }}
        />
        <div className="absolute inset-0 bg-primary/20 mix-blend-multiply" />
        <div className="absolute inset-0 bg-gradient-to-t from-primary/60 via-transparent to-transparent" />
        <div className="absolute bottom-xl left-xl right-xl p-lg">
          <h2 className="font-headline-lg text-headline-lg text-on-primary mb-sm">Hiệu Quả Kép.</h2>
          <p className="font-body-lg text-body-lg text-primary-fixed-dim max-w-lg">
            Hệ thống quản lý suất ăn và giao dịch tối ưu hóa quy trình, đảm bảo phục vụ nhanh chóng và chính xác cho cán bộ nhân viên nhà trường.
          </p>
        </div>
      </div>
      <div className="w-full lg:w-1/2 flex items-center justify-center p-lg sm:p-xl bg-surface relative z-10 shadow-[-20px_0_40px_-10px_rgba(26,54,93,0.05)]">
        <div className="max-w-[400px] w-full flex flex-col gap-xl">
          <div className="flex flex-col items-center text-center gap-md">
            <div className="h-16 w-16 bg-primary rounded-xl flex items-center justify-center text-on-primary shadow-[0_4px_6px_-1px_rgba(26,54,93,0.1)] mb-sm">
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1", fontSize: "32px" }}>restaurant</span>
            </div>
            <div>
              <h1 className="font-headline-lg text-headline-lg text-on-surface mb-xs">Chào mừng trở lại</h1>
              <p className="font-body-lg text-body-lg text-on-surface-variant">
                Đăng nhập vào hệ thống quản lý căng tin để tiếp tục công việc của bạn.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-md mt-sm">
            <button 
              onClick={() => navigate('/register')}
              className="w-full bg-surface-container-lowest border border-outline-variant hover:bg-surface-container-low text-on-surface font-label-md text-label-md rounded-lg px-margin py-md flex items-center justify-center gap-md transition-all duration-200 shadow-[0_2px_4px_-1px_rgba(26,54,93,0.03)] hover:shadow-[0_4px_6px_-1px_rgba(26,54,93,0.05)] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-surface"
            >
              <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
                <path d="M0 0h10v10H0z" fill="#f25022"></path>
                <path d="M11 0h10v10H11z" fill="#7fba00"></path>
                <path d="M0 11h10v10H0z" fill="#00a4ef"></path>
                <path d="M11 11h10v10H11z" fill="#ffb900"></path>
              </svg>
              Đăng nhập bằng Microsoft
            </button>
            <div className="flex items-center gap-sm mt-md">
              <div className="h-px bg-outline-variant flex-1"></div>
              <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Nội bộ</span>
              <div className="h-px bg-outline-variant flex-1"></div>
            </div>
          </div>
          <div className="mt-xl text-center">
            <p className="font-body-md text-body-md text-on-surface-variant">
              Sử dụng tài khoản email do trường cấp (VD: ten.ho@university.edu.vn) để truy cập hệ thống.
            </p>
            <div className="mt-lg">
              <a className="font-label-md text-label-md text-primary hover:text-on-tertiary-fixed-variant transition-colors underline-offset-4 hover:underline" href="#">
                Cần hỗ trợ đăng nhập?
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
