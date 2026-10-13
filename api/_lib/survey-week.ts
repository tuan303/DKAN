/**
 * Tuần khảo sát suất ăn — phần máy chủ cần để dựng thư mời khảo sát (nhãn tuần,
 * hạn trả lời) trong api/meal-alerts.ts.
 *
 * CHÉP đúng công thức của agent/lib/survey.mjs (isWeekId, surveyWeekLabel,
 * surveyDeadlineLabel) chứ không import: function Vercel giữ độc lập với mã của
 * agent — survey.mjs còn dùng chung cho trình duyệt và agent nên có thể đổi vì
 * lý do không liên quan tới email. Đổi công thức ở survey.mjs thì PHẢI đổi cả ở
 * đây; harness kiểm thử endpoint đối chiếu hai bên cho mọi thứ 2 của 2026–2027.
 *
 * Mọi phép tính ngày làm trên chuỗi YYYY-MM-DD ở UTC nên không phụ thuộc múi giờ
 * của máy chủ (Vercel chạy UTC, máy chạy thử có thể là giờ VN).
 */

/** Giờ đóng khảo sát (12:00 thứ 2 tuần sau), viết theo cách của mẫu email Nhóm Dinh dưỡng. */
const CLOSE_LABEL = '12h00';

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD. */
export function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Ngày YYYY-MM-DD (đã kiểm là ngày có thật) có phải thứ 2 không — mã tuần khảo sát là ngày thứ 2. */
export const isMondayIso = (iso: string): boolean => new Date(`${iso}T00:00:00Z`).getUTCDay() === 1;

const dayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** "05/10 – 09/10/2026": thứ 2 tới thứ 6 của tuần, năm lấy theo thứ 6 (tuần vắt qua năm mới). */
export function surveyWeekLabel(weekId: string): string {
  const friday = shiftIsoDate(weekId, 4);
  return `${dayMonth(weekId)} – ${dayMonth(friday)}/${friday.slice(0, 4)}`;
}

/** "12h00 thứ 2, ngày 12/10/2026": hạn trả lời là trưa thứ 2 tuần sau. */
export function surveyDeadlineLabel(weekId: string): string {
  const closesOn = shiftIsoDate(weekId, 7);
  return `${CLOSE_LABEL} thứ 2, ngày ${dayMonth(closesOn)}/${closesOn.slice(0, 4)}`;
}
