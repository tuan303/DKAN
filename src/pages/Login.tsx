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
    <div className="min-h-screen bg-background text-on-background flex flex-col antialiased">
      <header className="border-b border-outline-variant bg-surface-container-lowest">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-5 sm:px-6">
          <img
            src="https://hoangmaistarschool.edu.vn/thongtin/LogoNSHM.png"
            alt="Trường Ngôi Sao Hoàng Mai"
            className="h-9 w-auto max-w-[190px] object-contain sm:h-10"
          />
          <span className="hidden h-8 w-px bg-outline-variant sm:block" aria-hidden="true" />
          <span className="hidden text-sm font-semibold text-on-surface sm:block">Đăng ký ăn</span>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-8 px-4 py-8 sm:px-6 sm:py-12 lg:grid-cols-[1fr_440px] lg:gap-16 lg:py-16">
        <section className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full bg-surface-container-lowest px-3 py-1.5 text-xs font-medium text-on-surface-variant">
            <span className="h-2 w-2 rounded-full bg-secondary" aria-hidden="true" />
            Dành cho Cán bộ, Giáo viên và Nhân viên
          </span>
          <h1 className="mt-5 max-w-lg text-3xl font-bold leading-tight tracking-tight text-on-surface sm:text-4xl">
            Đăng ký suất ăn<br className="hidden sm:block" /> tại nhà trường
          </h1>
          <p className="mt-4 max-w-md text-body-lg text-on-surface-variant">
            Chủ động đăng ký bữa ăn, xem thực đơn và theo dõi lịch sử chấm ăn trong cùng một hệ thống.
          </p>
          <div className="mt-8 hidden space-y-5 lg:block">
            {[
              { icon: 'calendar_month', title: 'Đăng ký suất ăn', detail: 'Đăng ký hàng tháng và các sự kiện của trường.', color: 'bg-primary-container text-primary' },
              { icon: 'restaurant_menu', title: 'Thực đơn hàng tuần', detail: 'Theo dõi các món ăn trong tuần.', color: 'bg-warning-container text-on-warning-container' },
              { icon: 'fact_check', title: 'Lịch sử chấm ăn', detail: 'Tra cứu và đối chiếu các bữa ăn của bạn.', color: 'bg-tertiary-container text-on-tertiary-container' },
            ].map((item) => (
              <div key={item.title} className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${item.color}`} aria-hidden="true">
                  <span className="material-symbols-outlined text-[21px]">{item.icon}</span>
                </span>
                <div>
                  <p className="text-sm font-semibold text-on-surface">{item.title}</p>
                  <p className="mt-1 text-body-sm text-on-surface-variant">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="login-title" aria-busy={loading} className="min-w-0 rounded-xl border border-outline-variant bg-surface-container-lowest p-5 shadow-xs sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-container text-primary" aria-hidden="true">
            <span className="material-symbols-outlined text-[26px]">account_circle</span>
          </span>
          <h2 id="login-title" className="mt-5 text-2xl font-bold text-on-surface">Đăng nhập</h2>
          <p className="mt-2 text-body-md text-on-surface-variant">Sử dụng tài khoản Microsoft của nhà trường để tiếp tục.</p>

          {error && (
            <div role="alert" className="mt-5 flex items-start gap-2 rounded-lg border border-error/20 bg-error-container p-3 text-body-sm text-on-error-container">
              <span className="material-symbols-outlined shrink-0 text-[20px]" aria-hidden="true">error</span>
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleMicrosoftLogin}
            disabled={loading}
            className="mt-6 flex min-h-12 w-full items-center justify-center gap-3 rounded-lg bg-primary px-3 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white" aria-hidden="true">
              <svg className="h-[18px] w-[18px]" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
                <path d="M0 0h10v10H0z" fill="#f25022" />
                <path d="M11 0h10v10H11z" fill="#7fba00" />
                <path d="M0 11h10v10H0z" fill="#00a4ef" />
                <path d="M11 11h10v10H11z" fill="#ffb900" />
              </svg>
            </span>
            {loading ? 'Đang đăng nhập...' : 'Đăng nhập bằng Microsoft'}
          </button>
          <div className="mt-5 rounded-lg bg-surface-container-low p-4">
            <p className="text-xs font-semibold text-on-surface">Email nhà trường</p>
            <p className="mt-1 break-all text-body-sm text-on-surface-variant">@hoangmaistarschool.edu.vn</p>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-outline-variant pt-5 text-body-sm">
            <span className="text-on-surface-variant">Bạn cần hỗ trợ đăng nhập?</span>
            <a className="rounded font-semibold text-primary underline-offset-4 transition-colors hover:text-primary-dark hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" href="https://zalo.me/664388665648927162" target="_blank" rel="noopener noreferrer">
              Liên hệ hỗ trợ
            </a>
          </div>
        </section>
      </main>
      <div className="px-4 pb-3"><Footer /></div>
    </div>
  );
}
