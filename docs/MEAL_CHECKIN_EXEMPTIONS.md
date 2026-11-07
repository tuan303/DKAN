# Miễn chấm theo bữa và cảnh báo chấm khi chưa đăng ký

Bản cập nhật `2026-11-06.1`.

## Quản lý danh sách

Mở **Quản trị → Miễn chấm theo bữa** (`/quantri?tab=exemptions`).

1. Chọn **Bữa trưa** (mặc định), **Bữa sáng** hoặc **Cả hai bữa**.
2. Chọn ngày bắt đầu và ngày kết thúc nếu có. Ngày kết thúc được tính hết ngày.
3. Thêm một người bằng mã nhân viên 6 chữ số, họ tên và email trường; hoặc tải tệp mẫu, điền danh sách rồi chọn **Excel / CSV**.
4. Xem trước các dòng, đối chiếu mã/email và thời hạn sau khi lưu. Xác nhận lưu khi danh sách đúng.
5. Trong danh sách đã lưu có thể tìm nhân viên, sửa thời hạn/email hoặc ngừng miễn từng bữa. Thao tác ngừng miễn giữ lịch sử trước đó; nếu bữa hôm nay đã bắt đầu thì giữ miễn cho bữa hôm nay.

Ví dụ: chỉ miễn **Bữa trưa** cho một người thì bữa sáng vẫn yêu cầu chấm như bình thường. Miễn chấm không tự đăng ký suất ăn, không tạo lượt chấm giả và không miễn cho lượt ăn chưa đăng ký. Chính sách chỉ áp dụng khi khớp cả mã nhân viên và email của tài khoản đăng ký.

File nhập có ba cột: **Mã nhân viên | Họ tên | Email**. Mỗi lần tối đa 500 dòng. Màn hình báo lỗi theo dòng, có xem trước trước khi ghi; có thể chỉ lưu các dòng hợp lệ sau khi kiểm tra. Không đưa danh sách nhân sự thật vào mã nguồn GitHub.

## Theo dõi kết quả

- **Đối soát chấm ăn** có nhóm **Suất được miễn chấm**, tách khỏi **Đăng ký nhưng không chấm**; số suất đăng ký vẫn được giữ.
- **Chấm ăn của tôi** và bản Mini App mới hiển thị **Miễn chấm ăn** ở đúng bữa/ngày.
- File xuất Excel có sheet `Mien cham theo bua`.
- Khi danh sách có bản ghi lỗi, quản trị được chỉ rõ nơi sửa. Những trường hợp chưa xác minh được không được kết luận là vi phạm.
- Trang quản trị báo nếu Agent trên máy HAC chưa hỗ trợ tính năng. Chỉ cập nhật web sẽ chưa thay đổi cách Agent cũ gửi cảnh báo.

## Email chấm ăn khi chưa đăng ký

Agent gửi riêng thư **Chấm ăn nhưng chưa có đăng ký phù hợp**. Chỉ xét lượt chấm trong khung giờ ăn, có dữ liệu chốt đủ máy, gắn được với đúng một tài khoản đang hoạt động có email trường. Trường hợp đã báo hủy hoặc chưa tới ngày bắt đầu cũng được giải thích trong thư. Bỏ trường hợp có đăng ký ăn sự kiện phù hợp để tránh gửi nhầm.

Thư thiếu chấm vẫn xét **hôm nay** sau giờ ăn. Thư chấm chưa đăng ký xét **ngày có suất ăn trước đó**, tại lần chạy cảnh báo của ngày có suất ăn tiếp theo (lịch hiện tại 13:45). Lý do: người ăn trước rồi nộp đơn trong cùng ngày vẫn được tính là đã đăng ký; cần chờ hết ngày để kết luận. Đây không phải gửi ngay khi vừa chấm máy. Không tự gửi bù hàng loạt các ngày cũ.

Mã chưa gắn chắc chắn với tài khoản, dữ liệu thiếu máy hoặc số người bất thường được giữ để quản trị kiểm tra. Người chưa từng có đơn đăng ký không tự được ánh xạ bằng họ tên trên máy; quản trị vẫn tra cứu được ở mục đối soát.

Nhật ký tách hai loại thư theo người/ngày. Với thư chấm chưa đăng ký, kết quả gửi không rõ được ghi **Chưa rõ kết quả**, yêu cầu kiểm tra hộp thư và không tự gửi lại; lỗi xác định chắc chắn chưa gửi được mới thử lại. Nên chỉ vận hành một Agent gửi cảnh báo. Lỗi ghi nhật ký sau khi gửi vẫn là giới hạn cần xử lý thủ công, Agent dừng các lô tiếp theo.

## Thứ tự triển khai

1. Triển khai website/API `/api/meal-alerts` bản mới và Firestore Rules của dự án đang sử dụng. Collection `meal_checkin_exemptions` cho quản trị quản lý, mỗi CBNV chỉ đọc chính sách theo email của mình.
2. Nếu sử dụng Zalo: deploy Mini App mới trước khi thay API trên VPS. Client cũ chưa nhận biết trạng thái `exempt`. Giữ nguyên cấu hình và các khóa trên VPS.
3. Trên máy HAC, sao lưu thư mục Agent, chép các tệp trong gói cập nhật vào đúng `C:\DKAN-Agent`, gồm **toàn bộ `lib` đi kèm**. Giữ `config.json`, khóa Firebase, cấu hình Task Scheduler và log hiện có.
4. Chạy kiểm tra trước, không gửi thư:

   ```powershell
   Set-Location -LiteralPath C:\DKAN-Agent
   node .\sync-checkins.mjs --dry-run --days 1 --send-alerts
   ```

   Kiểm tra phiên bản `2026-11-06.1`, dữ liệu đủ máy, danh sách người được miễn và hai loại cảnh báo. Nếu log ghi `alerts.enabled đang tắt`, lần chạy thật vẫn chưa gửi cảnh báo; cần đặt `alerts.enabled: true` trong `config.json` khi quyết định vận hành. Không dán các dòng JSON vào PowerShell.

5. Nhập danh sách miễn chấm và kiểm tra một trường hợp chỉ miễn trưa: trưa hiển thị miễn, sáng vẫn giữ trạng thái chấm thực tế.
6. Giữ lịch đồng bộ/cảnh báo hiện tại với `--send-alerts`; chưa cần tạo thêm tác vụ. Hai loại thư dùng cùng kết nối email đã cấu hình.

Không chạy lệnh gửi thật trước khi đã kiểm tra danh sách và cấu hình. Các bước kiểm thử tự động của bản cập nhật dùng dữ liệu giả, không gửi email và không ghi lên hệ thống thật.
