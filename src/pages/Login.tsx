import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPopup } from 'firebase/auth';
import { auth, microsoftProvider } from '../lib/firebase';
import { Footer } from '../components/Footer';

export default function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleMicrosoftLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await signInWithPopup(auth, microsoftProvider);
      
      const email = result.user.email;
      if (email && !email.endsWith('@hoangmaistarschool.edu.vn')) {
        await auth.signOut();
        setError("Vui lòng sử dụng tài khoản email của trường (@hoangmaistarschool.edu.vn).");
        return;
      }

      navigate('/register');
    } catch (err: any) {
      console.error(err);
      if (err.code === 'auth/unauthorized-domain') {
        setError("Tên miền này chưa được cấp phép trong Firebase Console. Vui lòng kiểm tra mục 'Authorized domains'.");
      } else if (err.code === 'auth/configuration-not-found') {
        setError("Chưa cấu hình Microsoft Provider trong Firebase Console.");
      } else if (err.message?.includes('AADSTS7000215')) {
        setError("Lỗi Microsoft: ID hoặc Secret của ứng dụng không chính xác. Vui lòng kiểm tra lại cấu hình Azure.");
      } else {
        setError(err.message || "Đã xảy ra lỗi khi đăng nhập.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background text-on-background min-h-screen flex antialiased">
      {/* Panel thương hiệu: dựng bằng CSS nên luôn kín khung, không bị hở viền
          như ảnh poster đặt bg-contain trước đây. */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-gradient-to-br from-primary via-primary-dark to-primary-darker overflow-hidden">
        {/* Khối sáng trang trí */}
        <div className="absolute -top-32 -left-24 w-[420px] h-[420px] rounded-full bg-brand-sky/20 blur-3xl" aria-hidden="true" />
        <div className="absolute -bottom-40 -right-16 w-[460px] h-[460px] rounded-full bg-secondary/25 blur-3xl" aria-hidden="true" />
        <div
          className="absolute inset-0 opacity-[0.07]"
          aria-hidden="true"
          style={{
            backgroundImage: 'radial-gradient(circle, #ffffff 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />

        <div className="relative z-10 flex flex-col justify-center gap-7 xl:gap-8 px-10 xl:px-16 py-12 w-full">
          <div className="inline-flex items-center gap-3 bg-surface-container-lowest rounded-xl px-4 py-3 shadow-lg w-fit">
            <img
              src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png"
              alt="Trường Ngôi Sao Hoàng Mai"
              className="h-11 w-auto object-contain"
            />
          </div>

          <div>
            <p className="text-label-sm text-brand-sky uppercase tracking-[0.2em] mb-3">Phần mềm đăng ký ăn</p>
            <h2 className="text-[32px] xl:text-[44px] font-extrabold text-on-primary leading-[1.12] tracking-tight">
              Đăng ký suất ăn
              <br />
              <span className="text-warning">nhanh chóng, chính xác</span>
            </h2>
            <span className="inline-block w-16 h-1 rounded-full bg-secondary mt-5" aria-hidden="true" />
          </div>

          <ul className="flex flex-col gap-4 max-w-[440px]">
            {[
              { icon: 'restaurant_menu', title: 'Đăng ký suất ăn hàng tháng', desc: 'Chọn bữa sáng, bữa trưa cho cả tháng chỉ trong một lần thao tác.' },
              { icon: 'event_available', title: 'Mở đăng ký từ ngày 25 đến 28', desc: 'Hệ thống tự khóa đúng hạn, không cần nhắc thủ công.' },
              { icon: 'event_busy', title: 'Hủy ăn trước 16:00 hôm trước', desc: 'Báo hủy theo ngày, gửi thẳng tới Bộ phận Dinh dưỡng.' },
              { icon: 'verified', title: 'Số liệu minh bạch', desc: 'Thầy/cô và bộ phận quản lý xem cùng một nguồn dữ liệu.' },
            ].map(item => (
              <li key={item.icon} className="flex items-start gap-3.5">
                <span className="shrink-0 w-10 h-10 rounded-lg bg-on-primary/10 border border-on-primary/15 flex items-center justify-center text-brand-sky">
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                    {item.icon}
                  </span>
                </span>
                <div>
                  <p className="text-label-lg text-on-primary">{item.title}</p>
                  <p className="text-body-sm text-on-primary/65 mt-0.5">{item.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Dải màu nhận diện chạy dọc mép phải */}
        <div className="absolute inset-y-0 right-0 w-[6px] flex flex-col z-20" aria-hidden="true">
          <span className="flex-[4] bg-primary" />
          <span className="flex-[2] bg-secondary" />
          <span className="flex-1 bg-warning" />
          <span className="flex-1 bg-tertiary" />
        </div>
      </div>
      <div className="w-full lg:w-1/2 flex items-center justify-center p-md sm:p-xl bg-surface relative z-10 shadow-[-20px_0_40px_-10px_rgba(210,18,53,0.1)] h-[100dvh] lg:h-screen overflow-hidden">
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 flex items-center justify-center z-20">
          <img src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png" alt="NSHM Logo" className="h-[50px] md:h-[60px] object-contain" />
        </div>
        <div className="max-w-[420px] w-full flex flex-col h-full justify-between pt-12">
          <div className="flex-1 flex flex-col justify-center gap-y-8 md:gap-y-12">
            <div className="flex flex-col items-center text-center gap-y-3 sm:gap-y-4">
              <div className="h-14 w-14 md:h-16 md:w-16 bg-primary rounded-xl flex items-center justify-center text-on-primary shadow-md mb-1">
                <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1", fontSize: "30px" }}>restaurant</span>
              </div>
              <div>
                <h1 className="text-headline-sm md:text-headline-md text-primary mb-xs uppercase">Hệ thống đăng ký suất ăn</h1>
                <span className="inline-block w-10 h-[3px] rounded-full bg-secondary mb-3" aria-hidden="true" />
                <p className="text-body-sm md:text-body-md text-on-surface-variant line-clamp-2 md:line-clamp-none">
                  Đăng nhập để đăng ký suất ăn hàng tháng và các sự kiện của nhà trường.
                </p>
              </div>
            </div>
            
            <div className="flex flex-col gap-y-4">
              {error && (
                <div className="bg-error-container text-on-error-container border border-error/25 p-sm rounded-lg text-body-md flex items-start gap-2">
                  <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
                  <span>{error}</span>
                </div>
              )}
              <button
                onClick={handleMicrosoftLogin}
                disabled={loading}
                className="w-full bg-surface-container-lowest border border-outline-variant hover:border-primary/40 hover:bg-surface-container-low text-on-surface text-label-lg rounded-lg px-margin py-3 md:py-md flex items-center justify-center gap-md transition-all duration-200 shadow-xs hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-surface disabled:opacity-75 disabled:cursor-not-allowed"
              >
                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
                  <path d="M0 0h10v10H0z" fill="#f25022"></path>
                  <path d="M11 0h10v10H11z" fill="#7fba00"></path>
                  <path d="M0 11h10v10H0z" fill="#00a4ef"></path>
                  <path d="M11 11h10v10H11z" fill="#ffb900"></path>
                </svg>
                {loading ? "Đang đăng nhập..." : "Đăng nhập bằng Microsoft"}
              </button>
              <div className="flex items-center gap-sm">
                <div className="h-px bg-outline-variant flex-1"></div>
                <span className="text-label-sm text-primary uppercase tracking-[0.16em] text-center">HỆ THỐNG NỘI BỘ DÀNH CHO CBGV-NV</span>
                <div className="h-px bg-outline-variant flex-1"></div>
              </div>
              <div className="text-center flex flex-col justify-center">
                <p className="text-body-sm md:text-body-md text-on-surface-variant px-4">
                  Sử dụng email @hoangmaistarschool.edu.vn để truy cập.
                </p>
                <div className="mt-1">
                  <a className="text-label-md text-secondary hover:text-secondary-dark transition-colors underline-offset-4 hover:underline" href="https://zalo.me/664388665648927162" target="_blank" rel="noopener noreferrer">
                    Cần hỗ trợ?
                  </a>
                </div>
              </div>
            </div>
          </div>
          
          <div className="mt-4">
            <Footer />
          </div>
        </div>
      </div>
    </div>
  );
}
