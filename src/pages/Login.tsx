import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { signInWithPopup } from 'firebase/auth';
import { auth, microsoftProvider } from '../lib/firebase';
import { recordLoginLog } from '../lib/loginLog';
import { Footer } from '../components/Footer';

/**
 * Lọc tham số `?next=` (trang cần quay lại sau đăng nhập, vd link "Xem lịch sử
 * chấm ăn" trong email cảnh báo). Trả null nếu không an toàn.
 *
 * Chỉ nhận đường dẫn nội bộ: nếu nhận bừa, ai đó gửi link
 * /login?next=//trang-gia-mao.com là đăng nhập xong người dùng bị đẩy sang
 * trang lừa đảo trông như vẫn ở trong hệ thống của trường.
 *   - phải bắt đầu bằng một dấu '/';
 *   - '//x' và '/\x' trình duyệt đều hiểu là sang tên miền x, nên chặn;
 *   - chặn mọi khoảng trắng / ký tự điều khiển / dấu '\': trình duyệt bỏ tab,
 *     xuống dòng trước khi phân tích, nên '/\t/x' sẽ thành '//x'.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 300) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleMicrosoftLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await signInWithPopup(auth, microsoftProvider);
      
      const email = result.user.email;
      if (email && !email.endsWith('@hoangmaistarschool.edu.vn')) {
        // Ghi log trước khi signOut: sau khi đăng xuất là mất token, Firestore
        // từ chối ghi và lần đăng nhập sai tên miền này sẽ không để lại vết.
        await recordLoginLog(result.user, 'rejected', 'Email ngoài tên miền của trường');
        await auth.signOut();
        setError("Vui lòng sử dụng tài khoản email của trường (@hoangmaistarschool.edu.vn).");
        return;
      }

      await recordLoginLog(result.user, 'success');
      // Vẫn đi qua trang khai báo thông tin như cũ, chỉ mang theo trang đích.
      navigate(next ? `/register?next=${encodeURIComponent(next)}` : '/register');
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
    <div className="flex min-h-dvh bg-background text-on-background antialiased">
      {/* Khôi phục bố cục gốc: ảnh trường bên trái, khu đăng nhập bên phải. */}
      <div className="relative hidden overflow-hidden bg-[#121a4a] lg:block lg:w-1/2">
        <img
          src="https://hoangmaistarschool.edu.vn/thongtin/truong.jpg"
          alt="Trường Ngôi Sao Hoàng Mai"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
      <main className="relative z-10 flex min-h-dvh w-full min-w-0 flex-col items-center bg-surface px-4 pt-[max(16px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))] shadow-[-20px_0_40px_-10px_rgba(210,18,53,0.1)] sm:px-8 lg:w-1/2">
        <header className="flex w-full shrink-0 justify-center">
          <img
            src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png"
            alt="Trường Ngôi Sao Hoàng Mai"
            className="h-[50px] w-auto max-w-full object-contain md:h-[60px]"
          />
        </header>
        <div className="flex w-full max-w-[420px] flex-1 flex-col">
          <section aria-labelledby="login-title" aria-busy={loading} className="flex flex-1 flex-col justify-center gap-y-7 py-8 md:gap-y-12 md:py-10">
            <div className="flex flex-col items-center gap-y-3 text-center sm:gap-y-4">
              <div className="mb-1 flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-brand-navy text-white shadow-md md:h-16 md:w-16" aria-hidden="true">
                <span className="material-symbols-outlined text-[30px]" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant</span>
              </div>
              <div className="min-w-0">
                <h1 id="login-title" className="mb-xs text-xl font-bold leading-snug uppercase tracking-tight text-brand-navy md:text-headline-md">Hệ thống đăng ký suất ăn</h1>
                <span className="mb-3 inline-block h-[3px] w-10 rounded-full bg-secondary" aria-hidden="true" />
                <p className="text-body-sm text-on-surface-variant md:text-body-md">
                  Đăng nhập để đăng ký suất ăn hàng tháng và các sự kiện của nhà trường.
                </p>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-y-4">
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-lg border border-error/25 bg-error-container p-3 text-body-md text-on-error-container">
                  <span className="material-symbols-outlined shrink-0 text-[20px]" aria-hidden="true">error</span>
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">{error}</span>
                </div>
              )}
              <button
                type="button"
                onClick={handleMicrosoftLogin}
                disabled={loading}
                className="flex min-h-12 w-full items-center justify-center gap-3 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-3 text-label-lg text-on-surface shadow-xs transition-all duration-200 hover:border-brand-navy/40 hover:bg-surface-container-low hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy disabled:cursor-not-allowed disabled:opacity-75 md:gap-md md:px-margin md:py-md"
              >
                <svg className="h-5 w-5 shrink-0" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M0 0h10v10H0z" fill="#f25022" />
                  <path d="M11 0h10v10H11z" fill="#7fba00" />
                  <path d="M0 11h10v10H0z" fill="#00a4ef" />
                  <path d="M11 11h10v10H11z" fill="#ffb900" />
                </svg>
                {loading ? 'Đang đăng nhập...' : 'Đăng nhập bằng Microsoft'}
              </button>
              <div className="flex items-center gap-sm" aria-hidden="true">
                <div className="h-px flex-1 bg-outline-variant" />
                <span className="text-center text-[10px] font-semibold leading-4 tracking-[0.1em] text-brand-navy sm:text-label-sm sm:tracking-[0.16em]">HỆ THỐNG NỘI BỘ DÀNH CHO CBGV-NV</span>
                <div className="h-px flex-1 bg-outline-variant" />
              </div>
              <div className="flex min-w-0 flex-col items-center text-center">
                <p className="text-body-sm text-on-surface-variant [overflow-wrap:anywhere] md:text-body-md">
                  Sử dụng email @hoangmaistarschool.edu.vn để truy cập.
                </p>
                <a className="mt-1 inline-flex min-h-11 items-center justify-center rounded px-3 text-label-md text-secondary underline-offset-4 transition-colors hover:text-secondary-dark hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy" href="https://zalo.me/664388665648927162" target="_blank" rel="noopener noreferrer">
                  Cần hỗ trợ?
                </a>
              </div>
            </div>
          </section>
          <div className="shrink-0"><Footer /></div>
        </div>
      </main>
    </div>
  );
}
