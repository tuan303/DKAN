import type { User } from 'firebase/auth';
import { addDoc, collection, doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

export type LoginStatus = 'success' | 'rejected';

export interface LoginLogEntry {
  id?: string;
  uid: string;
  email: string;
  displayName: string;
  /** Lấy từ hồ sơ `staff` tại thời điểm đăng nhập. Rỗng nếu người dùng chưa khai báo. */
  fullName: string;
  employeeId: string;
  department: string;
  status: LoginStatus;
  /** Lý do bị từ chối. Rỗng khi đăng nhập thành công. */
  reason: string;
  /** ISO 8601 — vừa là mốc thời gian, vừa là khóa sắp xếp và lọc khoảng ngày. */
  at: string;
  device: string;
  os: string;
  browser: string;
  userAgent: string;
}

// Suy ra thiết bị từ user agent. Không cần chính xác tuyệt đối — mục đích chỉ là
// để quản trị nhìn ra "ai đó đăng nhập bằng điện thoại lạ" chứ không phải nhận
// dạng máy. Mọi nhánh đều có giá trị mặc định để không bao giờ trả về rỗng.
function describeClient(ua: string) {
  const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const isPhone = !isTablet && /Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua);
  const device = isPhone ? 'Điện thoại' : isTablet ? 'Máy tính bảng' : 'Máy tính';

  let os = 'Khác';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';

  // Thứ tự kiểm tra quan trọng: Edge và Chrome đều tự nhận là "Chrome" trong
  // user agent, Chrome lại tự nhận là "Safari". Phải bắt từ cụ thể nhất trở đi.
  let browser = 'Khác';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return { device, os, browser };
}

/**
 * Ghi một dòng nhật ký đăng nhập vào collection `login_logs`.
 *
 * Gọi khi popup SSO trả về kết quả — kể cả khi kết quả là bị từ chối (email
 * ngoài tên miền trường), vì đó chính là thứ quản trị cần nhìn thấy. Với trường
 * hợp bị từ chối phải gọi TRƯỚC `auth.signOut()`, lúc đó token còn hiệu lực nên
 * Firestore mới nhận.
 *
 * Hàm này không bao giờ ném lỗi: ghi log hỏng thì người dùng vẫn phải vào được
 * hệ thống. Lỗi chỉ in ra console.
 */
export async function recordLoginLog(
  user: User,
  status: LoginStatus,
  reason = ''
): Promise<void> {
  try {
    // Bổ sung tên, mã NV, phòng ban để bảng nhật ký đọc được ngay mà không phải
    // đối chiếu email sang danh sách nhân sự. Người chưa khai báo thì bỏ trống.
    let fullName = '';
    let employeeId = '';
    let department = '';
    try {
      const staffDoc = await getDoc(doc(db, 'staff', user.uid));
      if (staffDoc.exists()) {
        const staff = staffDoc.data();
        fullName = staff.fullName || '';
        employeeId = staff.employeeId || '';
        department = staff.department || '';
      }
    } catch {
      // Không đọc được hồ sơ thì vẫn ghi log, chỉ thiếu vài cột.
    }

    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
    const { device, os, browser } = describeClient(ua);

    const entry: LoginLogEntry = {
      uid: user.uid,
      email: (user.email || '').trim().toLowerCase(),
      displayName: user.displayName || '',
      fullName,
      employeeId,
      department,
      status,
      reason,
      at: new Date().toISOString(),
      device,
      os,
      browser,
      userAgent: ua.slice(0, 400),
    };

    await addDoc(collection(db, 'login_logs'), entry);
  } catch (err) {
    console.error('Không ghi được nhật ký đăng nhập:', err);
  }
}
