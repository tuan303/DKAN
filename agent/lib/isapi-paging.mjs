/**
 * Đọc từng trang kết quả AcsEvent của Hikvision và quyết định lần lấy dữ liệu
 * của một máy có TRỌN VẸN hay không.
 *
 * Vì sao phải quyết định chặt: từ bản 2026-10-09.1, máy được coi là "thành
 * công" thì phần dữ liệu của nó trong các ngày được THAY bằng dữ liệu vừa lấy.
 * Trước đây vòng lặp phân trang dừng lặng lẽ khi chạm giới hạn số trang và trả
 * về phần đã lấy — máy vẫn được coi là thành công, nên lượt chấm của những ngày
 * bị cắt (thiết bị trả sự kiện cũ trước, mới sau: bị cắt là các ngày gần nhất)
 * bị thay bằng rỗng. Bây giờ hễ không chắc đã lấy đủ là coi máy đó lỗi: phần cũ
 * của máy được giữ nguyên, không ngày nào bị chốt thiếu.
 *
 * File thuần, không import Node hay Firebase.
 */

// 3.000 trang: 90.000 sự kiện với kiểu 30 dòng/trang, 30.000 với kiểu 10
// dòng/trang. Cả trường (~300 người, 2 bữa) chỉ khoảng 600 lượt chấm một ngày,
// nên chạm ngưỡng này gần như chắc chắn là hỏi khoảng ngày quá dài (vd.
// --days 400) hoặc thiết bị trả lời bất thường. Mỗi trang mất ~0,3–0,5 giây
// nên ngưỡng này cũng giữ một lần chạy dưới khoảng 25 phút.
export const MAX_PAGES = 3000;

/**
 * @typedef {object} AcsPage
 * @property {any[]} list            các sự kiện của trang
 * @property {number} matched        số sự kiện thiết bị nói trang này có
 * @property {boolean} more          thiết bị báo còn trang sau (responseStatusStrg = MORE)
 * @property {number | null} total   tổng số sự kiện khớp điều kiện, nếu thiết bị có báo
 */

/**
 * @param {any} data  JSON thiết bị trả về cho một trang
 * @returns {AcsPage}
 */
export function readAcsPage(data) {
  const acs = data && typeof data === 'object' && data.AcsEvent && typeof data.AcsEvent === 'object' ? data.AcsEvent : {};
  const list = Array.isArray(acs.InfoList) ? acs.InfoList : [];
  const n = Number(acs.numOfMatches);
  const matched = Number.isFinite(n) && n > 0 ? n : list.length;
  const t = Number(acs.totalMatches);
  return {
    list,
    matched,
    more: String(acs.responseStatusStrg || '').toUpperCase() === 'MORE',
    total: acs.totalMatches !== undefined && acs.totalMatches !== null && acs.totalMatches !== '' && Number.isFinite(t) && t >= 0 ? t : null,
  };
}

/**
 * Lần lấy dữ liệu của một máy có bị cắt không. Trả về thông báo lỗi (tiếng
 * Việt, để in ra và ghi vào trạng thái máy) hoặc null nếu đã lấy trọn.
 *
 * @param {{
 *   finished: boolean,       // thiết bị đã báo hết dữ liệu (không còn MORE)
 *   stalled: boolean,        // thiết bị báo còn MORE nhưng trang trả về 0 sự kiện
 *   position: number,        // tổng số sự kiện đã lấy qua các trang
 *   total: number | null,    // totalMatches ở trang cuối cùng thiết bị trả
 *   pages: number,           // số trang đã đọc
 *   maxPages?: number,
 * }} input
 * @returns {string | null}
 */
export function pagingProblem({ finished, stalled, position, total, pages, maxPages = MAX_PAGES }) {
  if (!finished && !stalled) {
    return `Thiết bị có quá nhiều sự kiện trong khoảng ngày đã hỏi: đã đọc ${pages} trang (${position} sự kiện) mà thiết bị vẫn báo còn ` +
      `(giới hạn ${maxPages} trang). Dữ liệu bị cắt nên coi như máy lỗi, giữ nguyên dữ liệu cũ của máy — hãy giảm --days.`;
  }
  // So với tổng thiết bị báo ở trang CUỐI: sự kiện mới phát sinh trong lúc
  // đang đọc làm tổng tăng dần, trang cuối là con số mới nhất.
  if (total !== null && position < total) {
    return `Thiết bị báo có ${total} sự kiện nhưng chỉ lấy được ${position} — dữ liệu bị cắt nên coi như máy lỗi, giữ nguyên dữ liệu cũ của máy.`;
  }
  // Còn lại: hết dữ liệu bình thường, hoặc thiết bị báo MORE mà trả trang rỗng
  // và không báo tổng — giữ cách hiểu của các bản trước là đã hết.
  return null;
}
