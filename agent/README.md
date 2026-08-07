# Đồng bộ lượt chấm ăn từ máy nhận diện

Lấy lượt chấm từ hai máy Hikvision trong LAN rồi ghi lên hệ thống, để tab
**Đối soát chấm ăn** có số liệu mà không phải xuất Excel thủ công.

Chạy trên **PC cài phần mềm HAC** — máy đó vốn đã kết nối tới hai thiết bị.

---

## Cài đặt (làm một lần)

### 1. Cài Node.js

Tải bản **LTS** tại <https://nodejs.org> rồi cài như phần mềm bình thường.
Kiểm tra: mở Command Prompt, gõ `node -v`, thấy số phiên bản là được.

### 2. Chép thư mục này về máy

Đặt ở đường dẫn cố định, ví dụ `C:\DKAN-Agent`. Đừng để trong Downloads —
dọn máy là mất.

### 3. Cài thư viện

Mở Command Prompt tại thư mục đó rồi chạy:

```
npm install
```

### 4. Khai thông tin hai máy chấm công

Chép `config.example.json` thành `config.json`, mở bằng Notepad và điền mật
khẩu thật của từng máy.

> `config.json` chứa mật khẩu thiết bị. **Không gửi file này cho ai, không đưa
> lên GitHub.** Thư mục đã cấu hình sẵn để Git bỏ qua nó.

### 5. Lấy khóa Firebase

1. Vào <https://console.firebase.google.com/project/dkan-4b061/settings/serviceaccounts/adminsdk>
2. Bấm **Tạo khóa riêng tư mới** → tải file JSON về
3. Đổi tên thành `firebase-key.json`, để cạnh `sync-checkins.mjs`

File này cho quyền ghi toàn bộ dữ liệu — giữ như giữ mật khẩu.

---

## Chạy thử trước khi dùng thật

```
node sync-checkins.mjs --dry-run --debug
```

Lệnh này **chỉ đọc, không ghi gì lên hệ thống**. Nó in ra:

- Kết nối được mấy máy, mỗi máy bao nhiêu lượt chấm
- Mỗi ngày bao nhiêu người, bao nhiêu lượt
- Các mã sự kiện thô mà thiết bị trả về (phần `[debug]`)

Nếu số liệu khớp với những gì bạn thấy trong HAC thì bỏ `--dry-run` để chạy
thật.

---

## Dùng hằng ngày

**Chạy tay:** bấm đúp `dong-bo-cham-an.bat`. Cửa sổ hiện tiến trình, xong thì
chờ bạn bấm phím bất kỳ để đóng.

**Chạy tự động 22h mỗi đêm** — dùng Task Scheduler của Windows:

1. Mở **Task Scheduler** → **Create Basic Task**
2. Tên: `Dong bo cham an DKAN`
3. Trigger: **Daily**, giờ bắt đầu **22:00**
4. Action: **Start a program**
   - Program: `C:\DKAN-Agent\dong-bo-cham-an.bat`
   - Add arguments: `--quiet`
   - Start in: `C:\DKAN-Agent`
5. Sau khi tạo xong, mở **Properties** của task và bật:
   - **Run whether user is logged on or not** — để chạy cả khi không ai đăng nhập
   - **Run with highest privileges**
   - Tab Settings: bật **Run task as soon as possible after a scheduled start is missed** — phòng khi 22h máy đang tắt

Tham số `--quiet` để cửa sổ tự đóng, không chờ bấm phím.

---

## Các tham số

| Lệnh | Tác dụng |
|---|---|
| `node sync-checkins.mjs` | Lấy số ngày theo `daysToSync` trong config (mặc định 7) |
| `node sync-checkins.mjs --days 30` | Lấy 30 ngày gần nhất, dùng khi cần lấy bù cả tháng |
| `node sync-checkins.mjs --dry-run` | Chỉ in ra, không ghi lên hệ thống |
| `node sync-checkins.mjs --debug` | In thêm mã sự kiện thô của thiết bị |

**Vì sao mỗi lần lấy nhiều ngày chứ không chỉ hôm nay:** bộ nhớ sự kiện của
thiết bị có hạn và sẽ ghi đè khi đầy. Lấy lại 7 ngày gần nhất mỗi lần thì
mạng trục trặc hay máy tắt vài hôm vẫn bù được. Chạy lại bao nhiêu lần cũng
không nhân đôi dữ liệu vì mỗi ngày ghi đè trọn một bản ghi.

---

## Khi có lỗi

| Thông báo | Nguyên nhân thường gặp |
|---|---|
| `Sai tài khoản hoặc mật khẩu thiết bị` | Kiểm tra lại `config.json` |
| `HTTP 403` hoặc `404` | ISAPI chưa bật: vào giao diện web của máy → Cấu hình → Mạng → Nâng cao → Integration Protocol |
| `HTTP 400` | Firmware kén nội dung yêu cầu. Script tự thử 5 kiểu khác nhau; nếu vẫn hỏng, nó in ra lý do thiết bị trả về — gửi phần đó để chỉnh |
| `ECONNREFUSED` | Cổng 80 đóng. Thiết bị có thể chỉ chạy HTTPS: thêm `"protocol": "https"` cho máy đó trong `config.json` |
| `ETIMEDOUT` / `EHOSTUNREACH` | Không định tuyến tới được. Thử mở `http://10.34.32.35` bằng trình duyệt **trên chính máy chạy script** |
| `Không đọc được file khóa Firebase` | Thiếu `firebase-key.json` hoặc sai tên |
| Lấy được 0 lượt chấm | Khoảng ngày không có ai chấm, hoặc giờ trên thiết bị bị lệch. Kiểm tra NTP trên máy nhận diện |

---

## Lưu ý vận hành

- **Bật NTP trên cả hai máy nhận diện.** Giờ lệch là suất ăn rơi sai khung
  giờ, thậm chí sai ngày.
- **Đặt IP tĩnh** cho hai thiết bị. IP đổi là script mất kết nối.
- Script chỉ lưu **giờ chấm thô**, không tự phân bữa sáng/trưa. Việc phân bữa
  do phần mềm làm theo khung giờ trong cấu hình — sau này đổi khung giờ thì dữ
  liệu cũ tự tính lại đúng, không phải đồng bộ lại.
- Nút tải file Excel trong tab Đối soát vẫn giữ nguyên, dùng làm đường dự
  phòng khi script hoặc mạng có sự cố.
