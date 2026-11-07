// Nạp trước agent bằng `node --import <file này>`: "bây giờ" bắt đầu đúng ở
// FAKE_NOW (ISO) rồi chạy tiếp theo đồng hồ thật — để test chọn được giờ chạy
// (13:50 thứ 2, 14:00 thứ 5...) mà agent vẫn đo được thời gian trôi.
// Không có FAKE_NOW thì không làm gì (`npm test` trong thư mục agent coi mọi
// file .mjs trong test/ là file test và sẽ chạy cả file này).
const start = Date.parse(process.env.FAKE_NOW ?? '');
if (Number.isFinite(start)) {
  const RealDate = Date;
  const t0 = RealDate.now();
  const now = () => start + (RealDate.now() - t0);
  // Thay Date bằng một hàm: `new Date()` không tham số và Date.now() lấy giờ đã dời,
  // `Date()` gọi như hàm trả chuỗi giờ đã dời; mọi đối tượng tạo ra vẫn là Date thật
  // (chung prototype), nên `instanceof Date` và các hàm Intl vẫn chạy như thường.
  function StartAtDate(...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length ? args : [now()], new.target);
  }
  StartAtDate.prototype = RealDate.prototype;
  StartAtDate.now = now;
  StartAtDate.parse = RealDate.parse;
  StartAtDate.UTC = RealDate.UTC;
  globalThis.Date = StartAtDate;
}
