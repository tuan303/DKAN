# Đồng bộ lượt chấm ăn từ máy nhận diện

Lấy lượt chấm từ hai máy Hikvision trong LAN rồi ghi lên hệ thống, để:

- tab **Đối soát chấm ăn** của quản trị có số liệu mà không phải xuất Excel thủ công;
- CBNV tự xem lượt chấm của mình ở trang **Chấm ăn của tôi**;
- sau giờ ăn trưa, người **đã đăng ký mà không có lượt chấm** nhận **một email
  cảnh báo** (gửi qua hộp thư dinhduong@, có CC dinhduong@);
- **15:00 thứ 6 hằng tuần**, CBGV-NV có đăng ký ăn nhận **email mời khảo sát
  chất lượng suất ăn** của tuần (script riêng `survey-invite.mjs`, xem mục
  **Khảo sát bữa ăn hằng tuần**).

Chạy trên **PC cài phần mềm HAC** — máy đó vốn đã kết nối tới hai thiết bị.

Bản hiện tại: **2026-10-09.1** (script in số bản ở dòng đầu mỗi lần chạy).
Script khảo sát: **2026-10-13.4**.

---

## Cài đặt (làm một lần)

### 1. Cài Node.js

Tải bản **LTS** tại <https://nodejs.org> rồi cài như phần mềm bình thường.
Kiểm tra: mở Command Prompt, gõ `node -v`, thấy số phiên bản là được.

### 2. Chép thư mục này về máy

Đặt ở đường dẫn cố định, ví dụ `C:\DKAN-Agent`. Đừng để trong Downloads —
dọn máy là mất.

Chép **cả thư mục**, gồm cả thư mục con `lib\` — script không chạy được nếu
thiếu nó (`lib\meal-rules.mjs` là quy tắc suất ăn dùng chung với trang web).

### 3. Cài thư viện

Mở Command Prompt tại thư mục đó rồi chạy:

```
npm install
```

### 4. Khai thông tin hai máy chấm công

Chép `config.example.json` thành `config.json`, mở bằng Notepad và điền mật
khẩu thật của từng máy.

> `config.json` chứa mật khẩu thiết bị và khoá gửi email. **Không gửi file này
> cho ai, không đưa lên GitHub.** Thư mục đã cấu hình sẵn để Git bỏ qua nó.

### 5. Lấy khóa Firebase

1. Vào <https://console.firebase.google.com/project/dkan-4b061/settings/serviceaccounts/adminsdk>
2. Bấm **Tạo khóa riêng tư mới** → tải file JSON về
3. Đổi tên thành `firebase-key.json`, để cạnh `sync-checkins.mjs`

File này cho quyền ghi toàn bộ dữ liệu — giữ như giữ mật khẩu.

### 6. Cấu hình email cảnh báo

Trong `config.json` có khối `alerts` (chép từ `config.example.json`):

```json
"alerts": {
  "enabled": false,
  "endpoint": "https://dkan.nshm.vn/api/meal-alerts",
  "secret": "DIEN_KHOA_GIONG_HET_MEAL_ALERT_SECRET_TREN_VERCEL",
  "adminEmails": ["dinhduong@hoangmaistarschool.edu.vn", "tuantm@hoangmaistarschool.edu.vn"],
  "notBefore": "13:40",
  "minExpected": 20,
  "maxMissingRatio": 0.4
}
```

| Khoá | Ý nghĩa |
|---|---|
| `enabled` | `true` mới gửi thật. Để `false` cho tới khi chạy thử xong (mục **Thử cảnh báo an toàn**) |
| `endpoint` | Địa chỉ gửi email trên web. Giữ nguyên |
| `secret` | Khoá bí mật, phải **giống hệt** biến `MEAL_ALERT_SECRET` trên Vercel (xem dưới) |
| `adminEmails` | Ai được báo khi chốt an toàn tự dừng gửi. Tối đa 5, chỉ nhận email `@hoangmaistarschool.edu.vn` |
| `notBefore` | Trước giờ này không gửi, dù được gọi |
| `minExpected`, `maxMissingRatio` | Chốt an toàn: bữa nào có từ `minExpected` người đáng lẽ ăn trở lên mà quá `maxMissingRatio` (0.4 = 40%) trong số đó chưa chấm thì **dừng cả đợt**, không gửi cho ai, báo quản trị |

**Tạo khoá bí mật** — mở **PowerShell** (không phải Command Prompt), dán nguyên
dòng này rồi Enter:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

Máy in ra một dãy 64 ký tự. Dùng **đúng dãy đó** cho cả hai nơi:

1. **Vercel**: vào project → **Settings → Environment Variables** → thêm
   `MEAL_ALERT_SECRET` = dãy vừa tạo (môi trường **Production**). Lưu xong phải
   **Redeploy** bản đang chạy thì biến mới có hiệu lực.
2. **config.json** trên máy HAC: dán vào `"secret": "..."`.

Cùng lúc trên Vercel, thêm biến **`MEAL_ALERT_ADMINS`** = các địa chỉ nhận thư
báo khi agent tự dừng gửi cảnh báo (chốt an toàn), cách nhau bằng dấu phẩy —
**giống hệt** danh sách `adminEmails` trong `config.json`, ví dụ:

```
dinhduong@hoangmaistarschool.edu.vn,tuantm@hoangmaistarschool.edu.vn
```

Máy chủ chỉ gửi thư báo quản trị tới địa chỉ có trong biến này, không tin danh
sách agent gửi lên — nếu tin thì ai lấy được khoá sẽ gửi được thư mang tiêu đề hệ
thống tới bất kỳ ai trong trường. Thiếu biến này thì chỉ dinhduong@ nhận được;
địa chỉ còn lại hiện trong log là "Không gửi được tới ...".

Hai biến tuỳ chọn khác (để trống là dùng mặc định):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MEAL_ALERT_CC` | `dinhduong@hoangmaistarschool.edu.vn` | Hộp thư được CC mọi email cảnh báo, cũng là nơi CBNV trả lời để khiếu nại. Đặt `none` để không CC |
| `PUBLIC_APP_URL` | `https://dkan.nshm.vn` | Địa chỉ trang web, dùng cho nút "Xem lịch sử chấm ăn" trong email |

Khoá ngắn hơn 32 ký tự, còn là chữ mẫu `DIEN_...`, hoặc có dấu cách / xuống
dòng / chữ có dấu thì script không gửi (báo lỗi cấu hình). Dãy do lệnh trên tạo
ra luôn hợp lệ — dán nguyên dãy, đừng gõ lại tay.
Script không bao giờ in khoá ra màn hình hay file log. Nghi lộ khoá thì tạo khoá
mới, thay ở cả hai nơi.

---

## Cập nhật từ bản cũ lên 2026-10-09.1

1. Chép đè **toàn bộ** thư mục mới vào `C:\DKAN-Agent` — `sync-checkins.mjs`,
   `dong-bo-cham-an.bat`, `package.json`, `README.md` **và thư mục `lib\`**.
   Chỉ chép mỗi `sync-checkins.mjs` là script báo `Cannot find module ... lib`.
   **Giữ nguyên** `config.json` và `firebase-key.json` đang có.
2. Mở `config.json`, thêm khối `alerts` như mục 6 ở trên (chép từ
   `config.example.json`), để `"enabled": false`.
3. Chạy `npm install` một lần cho chắc.
4. Chạy `node sync-checkins.mjs --dry-run`, xem dòng đầu có in
   `(bản 2026-10-09.1)`.
5. **Nạp dữ liệu các tháng trước — chạy MỘT lần**, ngoài giờ ăn và không trùng
   giờ task nào (vd. bắt đầu lúc 18:00, có thể chạy tới khoảng một giờ):

   ```
   node sync-checkins.mjs --days 70
   ```

   Trang "Chấm ăn của tôi" cho CBNV xem tháng này và hai tháng trước, nhưng các
   lần chạy hằng ngày chỉ lấy 1–7 ngày gần nhất. Không chạy lệnh này thì tháng
   trước, tháng trước nữa trên trang sẽ báo "chưa được đối chiếu tự động". Lệnh
   hỏi lại máy chấm 70 ngày nên chạy lâu. Ngày nào máy không còn
   lưu thì script giữ nguyên lượt chấm bản cũ đã đồng bộ, không làm mất gì.
6. Sửa lịch Task Scheduler thành **ba** task như mục **Chạy tự động** dưới đây.

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

## Thử cảnh báo an toàn

Làm theo thứ tự, **trước khi** bật `"enabled": true`:

**1. Xem thử với một ngày đã qua** — chọn một ngày thứ 2–6 trong **7 ngày gần
nhất**, và đừng thêm `--days` (để lần chạy thử lấy lại đủ 7 ngày, có dữ liệu
chốt cho ngày đó):

```
node sync-checkins.mjs --dry-run --send-alerts --alerts-date 2026-10-08
```

Script đọc hệ thống (cần `firebase-key.json`) và in ra: số người đáng lẽ ăn,
số người chưa chấm từng bữa, kết luận của chốt an toàn, và **danh sách sẽ nhận
email** kèm bữa thiếu. **Không gửi email nào, không ghi gì.** So danh sách này
với tab **Đối soát chấm ăn → Đăng ký nhưng không chấm** của ngày đó — phải khớp.

`--alerts-date` chỉ chạy được khi có cả `--dry-run` và `--send-alerts`; thiếu
là script từ chối, nên không thể lỡ tay gửi thật cho ngày cũ.

**2. Xem thử hôm nay**, sau 13:45:

```
node sync-checkins.mjs --dry-run --send-alerts
```

**3. Bật thật**: sửa `"enabled": true` trong `config.json`. Lần gửi thật đầu
tiên nên để **task 13:45 tự chạy**, rồi xem `dong-bo.log`. Nếu muốn chạy tay
thì chạy **sau 14:50** (khi task 13:45 đã lặp xong) hoặc tạm **Disable** task
13:45 trước:

```
node sync-checkins.mjs --days 1 --send-alerts
```

Mỗi người chỉ nhận **một email mỗi ngày**: script ghi nhớ ai đã nhận
(collection `meal_alerts`), các lần chạy nối tiếp nhau không gửi trùng. Hai lần
chạy thật **cùng lúc trên cùng máy** (chạy tay đúng lúc task đang chạy) tự xếp
hàng: lần sau chờ lần trước xong (file `dong-bo.lock` cạnh script, tối đa 10
phút) rồi mới chạy. **Chỉ cài agent chạy tự động trên MỘT máy** — hai máy cùng
chạy thì không chặn được nhau, có thể gửi trùng.

Gõ sai tham số (vd. `--dryrun` thay vì `--dry-run`) thì script **từ chối chạy**
và in danh sách tham số hợp lệ — không bao giờ lặng lẽ chạy thật.

---

## Dùng hằng ngày

**Chạy tay:** bấm đúp `dong-bo-cham-an.bat`. Cửa sổ hiện tiến trình, xong thì
chờ bạn bấm phím bất kỳ để đóng.

### Chạy tự động — ba task trong Task Scheduler

| Task | Lịch | Add arguments | Để làm gì |
|---|---|---|---|
| `DKAN 1 - Dong bo 08h15` | Thứ 2–6, 08:15 | `--quiet --days 1` | Có lượt chấm bữa sáng trên trang cá nhân |
| `DKAN 2 - Canh bao 13h45` | Thứ 2–6, 13:45, **lặp mỗi 15 phút trong 1 giờ** | `--quiet --days 1 --send-alerts` | Đồng bộ bữa trưa rồi gửi email cảnh báo |
| `DKAN 3 - Dong bo 22h` | Hằng ngày, 22:00 | `--quiet` | Lấy lại 7 ngày gần nhất, bù khi có trục trặc |

Gửi lời mời khảo sát (15:00 thứ 6, kèm các lần gửi bù) là task thứ tư, chạy
file `.bat` riêng — xem mục **Khảo sát bữa ăn hằng tuần**.

Task 2 chạy lúc 13:45 rồi cứ 15 phút một lần tới khoảng 14:45: lần đầu gửi,
các lần sau chỉ gửi nốt cho người lần trước gửi lỗi, hoặc thử lại nếu lần
trước có máy lỗi. Người đã được ghi vào nhật ký `meal_alerts` không nhận lần
hai trong ngày.

Ba task khác giờ nên không chạy chồng nhau; nếu lỡ chồng (một lần chạy kéo
dài, hay chạy tay đúng lúc task đang chạy), lần sau tự chờ lần trước xong nhờ
file `dong-bo.lock`.

Đã có task 22h từ bản cũ (`Dong bo cham an DKAN`, tham số `--quiet`) thì đó
chính là task 3 — giữ nguyên, chỉ mở **Properties** kiểm tra lại tab
**Settings** như bước 5 dưới đây.

Tạo từng task như sau — dùng **Create Task...** (không dùng Create Basic Task,
vì thiếu các tuỳ chọn cần thiết):

1. Mở **Task Scheduler** → **Create Task...**
2. Tab **General**:
   - Name: tên trong bảng trên
   - Chọn **Run whether user is logged on or not**
   - Tích **Run with highest privileges**
3. Tab **Triggers** → **New...** → Begin the task: **On a schedule**
   - Task 1 và 2: chọn **Weekly**, Start: giờ trong bảng, Recur every **1**
     weeks on: tích **Monday, Tuesday, Wednesday, Thursday, Friday**
   - Task 2 thêm: ở **Advanced settings** tích **Repeat task every: 15 minutes**,
     **for a duration of: 1 hour**
   - Task 3: chọn **Daily**, Start **22:00**, Recur every **1** days
   - Đảm bảo **Enabled** được tích
4. Tab **Actions** → **New...** → **Start a program**
   - Program/script: `C:\DKAN-Agent\dong-bo-cham-an.bat`
   - Add arguments: theo bảng trên
   - Start in: `C:\DKAN-Agent`
5. Tab **Settings**:
   - Tích **Allow task to be run on demand**
   - Tích **Run task as soon as possible after a scheduled start is missed** —
     phòng khi đúng giờ đó máy đang tắt
   - Tích **Stop the task if it runs longer than: 1 hour**
   - Mục **If the task is already running, then the following rule applies**:
     chọn **Do not start a new instance**
6. Bấm **OK**, nhập mật khẩu tài khoản Windows khi được hỏi.

Tạo xong, bấm chuột phải từng task → **Run** để chạy thử một lần, rồi xem cột
**Last Run Result** và cuối file `dong-bo.log`.

Tham số `--quiet` để cửa sổ tự đóng, không chờ bấm phím, và **ghi toàn bộ kết
quả vào `dong-bo.log`** cạnh file `.bat` (quá 5 MB thì tự đổi tên thành
`dong-bo.old.log`). Muốn biết lần chạy tự động gần nhất ra sao: mở file này,
xem cuối file.

Cột **Last Run Result** trong Task Scheduler cho biết kết quả:

| Mã | Ý nghĩa |
|---|---|
| `0x0` | Ổn |
| `0x1` | Có máy nhận diện lỗi (hoặc lỗi chung: thiếu khoá Firebase, sai tham số, đang có lần chạy khác quá 10 phút). Lượt chấm của máy lỗi được giữ nguyên, không bị xoá |
| `0x2` | Đồng bộ ổn nhưng pha gửi cảnh báo có lỗi: cấu hình `alerts` sai, hoặc gửi lỗi (xem `dong-bo.log`) |

---

## Các tham số

| Lệnh | Tác dụng |
|---|---|
| `node sync-checkins.mjs` | Lấy số ngày theo `daysToSync` trong config (mặc định 7) |
| `node sync-checkins.mjs --days 30` | Lấy 30 ngày gần nhất, dùng khi cần lấy bù cả tháng. Ngày nào quá bộ nhớ của máy thì giữ nguyên dữ liệu cũ (không bị xoá) |
| `node sync-checkins.mjs --dry-run` | Chỉ in ra, không ghi lên hệ thống |
| `node sync-checkins.mjs --debug` | In thêm mã sự kiện thô của thiết bị |
| `node sync-checkins.mjs --send-alerts` | Đồng bộ xong thì chạy pha gửi email cảnh báo (cần `alerts.enabled: true`) |
| `node sync-checkins.mjs --dry-run --send-alerts` | Xem thử ai sẽ nhận email hôm nay, không gửi, không ghi |
| `node sync-checkins.mjs --dry-run --send-alerts --alerts-date 2026-10-08` | Xem thử cho một ngày đã qua, bỏ qua kiểm tra giờ |
| `node survey-invite.mjs --dry-run` | Xem thử lời mời khảo sát tuần này: ai sẽ nhận, mấy thư — không gửi, không ghi (xem mục **Khảo sát bữa ăn hằng tuần**) |
| `npm test` | Chạy bộ kiểm tra tự động của script (không cần máy nhận diện hay Firebase) |

**Vì sao mỗi lần lấy nhiều ngày chứ không chỉ hôm nay:** bộ nhớ sự kiện của
thiết bị có hạn và sẽ ghi đè khi đầy. Lấy lại 7 ngày gần nhất mỗi đêm thì mạng
trục trặc hay máy tắt vài hôm vẫn bù được. Chạy lại bao nhiêu lần cũng không
nhân đôi dữ liệu.

**Một máy lỗi không làm mất dữ liệu:** mỗi ngày lưu riêng phần của từng máy.
Máy chạy được thì phần của nó được cập nhật; máy lỗi thì phần cũ của nó giữ
nguyên. (Bản trước 2026-10-09 ghi đè cả ngày, một máy lỗi là mất lượt chấm của
máy đó tới 7 ngày.)

**Máy trả lời được nhưng thiếu ngày cũng không làm mất dữ liệu:** mỗi máy chỉ
được tính là có dữ liệu cho các ngày từ ngày sớm nhất tới ngày muộn nhất nó trả
về. Bộ nhớ sự kiện bị xoá giữa tuần (nâng firmware, thay máy, xoá trong HAC),
máy lệch giờ, hay lấy bù quá bộ nhớ của máy: những ngày máy không trả gì thì
phần cũ của máy giữ nguyên và ngày đó **chưa được chốt** (trang cá nhân hiện
"Chưa có dữ liệu" chứ không báo "Chưa chấm"). Script in dòng
`Lưu ý: <máy> chỉ trả lượt chấm từ ... tới ...` để biết.

**Lấy không trọn thì coi như máy lỗi:** nếu thiết bị có quá nhiều sự kiện
(chạm giới hạn 3.000 trang) hoặc trả ít hơn số nó tự báo, máy được tính là
**lỗi** trong lần đó — dữ liệu cũ giữ nguyên — thay vì "thành công" với dữ liệu
thiếu.

**Khi quản trị sửa mã NV** (hết trùng mã, sửa mã trong hồ sơ hay trên đơn),
lần chạy kế tiếp tự tách lại lượt chấm **cả tháng** cho người đó, không chỉ 7
ngày gần nhất — các ngày đầu tháng không còn "Chưa chấm" oan hay giờ ăn của mã
cũ.

---

## Script ghi những gì lên hệ thống

| Nơi ghi | Nội dung | Ai đọc được |
|---|---|---|
| `checkins/{ngày}` | Lượt chấm cả trường trong ngày, gộp và theo từng máy | Quản trị |
| `meal_taps/{tài khoản}/months/{tháng}` | Lượt chấm của từng người | Chính người đó và quản trị |
| `settings/checkinSync` | Lần đồng bộ gần nhất, máy nào lỗi, ngày nào đã có dữ liệu đủ, trạng thái cảnh báo từng ngày. **Không có tên hay mã NV** | Mọi người đã đăng nhập |
| `meal_alerts/{ngày}_{tài khoản}` | Ai đã được gửi email cảnh báo ngày nào | Quản trị |
| `meal_surveys/{thứ 2 của tuần}` | (script khảo sát) Lịch mở/đóng khảo sát tuần và trạng thái email mời. **Không có tên hay email** | Mọi người đã đăng nhập |
| `meal_surveys/{tuần}/private/invited` | (script khảo sát) Ai được mời (họ tên, bộ phận, email), ai đã nhận thư (`sentEmails`), ai **không rõ** đã nhận chưa (`uncertainEmails`, chỉ có khi một thư gửi không rõ kết quả) | Quản trị |
| `meal_surveys/{tuần}/private/lock` | (script khảo sát) Quyền gửi lời mời của tuần: máy nào đang gửi, tới lúc nào — để hai máy không cùng gửi | Quản trị |

Lượt chấm được gán cho tài khoản theo **mã NV trên đơn đăng ký tháng đó**
(giống tab Đối soát); người không có đơn thì theo mã trong hồ sơ. Hai tài khoản
cùng một mã thì không ai thấy lượt chấm của mã đó — trang cá nhân báo
**trùng mã** để người đó liên hệ sửa.

Script **bỏ qua** (có in ra) các đơn đăng ký không do trang đăng ký tạo ra: id
đơn không phải `{tài khoản}_{tháng}`, `userId` sai dạng, hoặc tài khoản không
còn tồn tại trong Firebase Authentication. Một đơn hỏng không làm hỏng cả lần
chạy, và một đơn "ma" mang mã NV của người khác không làm người đó bị coi là
trùng mã. Thấy dòng `Bỏ qua N đơn đăng ký ... không hợp lệ` thì quản trị nên
xoá các đơn được liệt kê.

Ngoài các nơi trên, script tạo file `dong-bo.lock` cạnh nó trong lúc chạy thật
(xoá khi xong) để hai lần chạy không chồng lên nhau.

---

## Cảnh báo được gửi khi nào

Ở mỗi lần chạy có `--send-alerts`, script kiểm tra lần lượt:

1. `alerts.enabled` phải là `true`.
2. Hôm nay phải là ngày có suất ăn (thứ 2–6, không nằm trong danh sách ngày
   nghỉ ở tab Cấu hình).
3. Khối `alerts` trong `config.json` phải đúng (khoá, địa chỉ, `notBefore` dạng
   `HH:MM`...). Sai thì trạng thái `error`, mã thoát `0x2` — không bao giờ tắt
   lặng lẽ.
4. Đã qua giờ `notBefore` (13:40).
5. Lần đồng bộ **vừa xong phải đủ cả hai máy**. Thiếu máy thì chưa gửi — người
   ăn ở máy lỗi sẽ bị coi oan là chưa chấm. Lần chạy 15 phút sau thử lại.
   Máy trả lời được mà **0 lượt chấm trong ngày** (thường do lệch giờ sau mất
   điện) cũng không gửi, và đi thẳng tới chốt an toàn ở bước 8.
6. Hôm nay chưa gửi xong.
7. Tính ai đăng ký mà không có lượt chấm (đã trừ người báo hủy, người đăng ký
   sau giờ ăn, mã thuộc danh sách loại trừ, mã trùng giữa nhiều đơn, đơn của
   tài khoản không tồn tại).
8. **Chốt an toàn** → **dừng cả đợt**, gửi một email báo `adminEmails` (mỗi
   ngày một lần), nếu:
   - hôm nay không ai chấm trong khung giờ ăn; hoặc
   - một máy trả lời được nhưng **không có lượt chấm nào trong ngày**; hoặc
   - một máy **không có lượt chấm nào trong khung một bữa** (vd. mất riêng bữa
     trưa) trong khi những ngày gần đây máy đó vẫn có người chấm bữa ấy — máy
     của bếp không phục vụ bữa sáng thì không bị tính; hoặc
   - một bữa có tỉ lệ chưa chấm quá ngưỡng.
9. Gửi email. Địa chỉ lấy từ **tài khoản đăng nhập** của người đó (không lấy
   email trên đơn), chỉ gửi tới email `@hoangmaistarschool.edu.vn`. Sau mỗi
   lô, ghi nhật ký `meal_alerts`; ghi nhật ký lỗi thì **dừng gửi** các lô còn
   lại (trạng thái `partial`), để không gửi trùng ở các lần chạy sau.

### Trạng thái cảnh báo

Xem trong Firebase Console: `settings` → `checkinSync` → `alerts` → ngày.

| Trạng thái | Nghĩa | Lần chạy sau trong ngày |
|---|---|---|
| `sent` | Đã gửi xong cho mọi người cần cảnh báo | Bỏ qua |
| `partial` | Có email gửi lỗi, hoặc dừng giữa chừng vì không ghi được nhật ký (`failed` > 0), lý do ở `reason` | Gửi nốt cho người chưa nhận |
| `nothing` | Không ai đăng ký mà thiếu lượt chấm | Kiểm tra lại |
| `guarded` | Chốt an toàn dừng gửi (không ai chấm, một máy không có lượt chấm nào trong ngày hoặc mất trọn một bữa, hoặc tỉ lệ chưa chấm quá ngưỡng), đã báo quản trị, lý do ở `reason` | Kiểm tra lại; số liệu bình thường trở lại thì gửi, không báo quản trị lần nữa |
| `error` | Chưa gửi được: lần đồng bộ thiếu máy, cấu hình sai, hoặc lỗi giữa chừng — xem `reason` | Thử lại |
| `off_day` | Không phải ngày có suất ăn | Bỏ qua |

`expected` / `missing` là số người đáng lẽ ăn / chưa chấm của từng bữa;
`sent` là tổng số email đã gửi trong ngày.

---

## Khảo sát bữa ăn hằng tuần

**15:00 thứ 6** hằng tuần, script `survey-invite.mjs` gửi email mời **CBGV-NV
có đăng ký ăn trong tuần** làm khảo sát chất lượng phục vụ suất ăn của tuần đó.
Thư đi từ hộp thư Nhóm Dinh dưỡng qua đúng đường email cảnh báo
(`/api/meal-alerts`, cùng khoá bí mật); nút **Tham gia khảo sát** trong thư mở
trang `/khao-sat` của phần mềm. Hạn trả lời **12h00 thứ 2 tuần sau** (quản trị
gia hạn hoặc đóng sớm được — thư luôn ghi đúng hạn đang đặt lúc gửi). Kết quả
xem ở trang Quản trị → tab **Khảo sát bữa ăn**.

Script này **độc lập** với `sync-checkins.mjs`: không hỏi máy nhận diện, không
cần `alerts.enabled` bật, chỉ dùng lại `alerts.endpoint` và `alerts.secret`.

### Cài đặt (làm một lần)

1. Chép đè **cả thư mục** agent mới vào `C:\DKAN-Agent` — có thêm
   `survey-invite.mjs`, `khao-sat-bua-an.bat` và các file mới trong `lib\`.
   **Giữ nguyên** `config.json` và `firebase-key.json`.
2. Bản web đang chạy (Vercel) phải là bản có trang **/khao-sat** — endpoint
   của bản cũ không biết loại thư `survey-invite` (script báo `HTTP 400`).
   Cập nhật web **trước hoặc cùng lúc** với agent: bản agent này gửi kèm hạn
   trả lời thật (`closesAt`) để thư ghi đúng hạn, và cần endpoint báo rõ thư
   "có thể đã đi" (`maybeSent`) để không gửi trùng (xem **Thư "không rõ đã đi
   chưa"**).
3. Mở `config.json`, thêm khối `survey` (chép từ `config.example.json`), **để
   tắt** cho tới khi chạy thử xong:

   ```json
   "survey": {
     "enabled": false
   }
   ```

   Không có khoá mới nào: script dùng `alerts.endpoint` và `alerts.secret` đã
   khai ở mục 6 (phải là khoá thật, giống hệt `MEAL_ALERT_SECRET` trên Vercel).
   Thiếu `alerts.endpoint`, khoá còn là chữ mẫu `DIEN_...` hay quá ngắn thì
   script báo lỗi cấu hình, mã thoát `0x1`, không gửi gì.

   Trên Vercel: `PUBLIC_APP_URL` là địa chỉ nút **Tham gia khảo sát** trong thư;
   `MEAL_ALERT_CC` (mặc định dinhduong@) là hộp thư đứng ở ô **To** và nhận thư
   trả lời. Người được mời nằm ở **Bcc** — không ai thấy địa chỉ của người khác.

### Chạy thử

```
node survey-invite.mjs --dry-run
```

Chạy được **bất cứ lúc nào**, kể cả khi `survey.enabled` còn tắt hay chưa tới
15:00 thứ 6. Script đọc hệ thống (cần `firebase-key.json`) rồi in: tuần nào,
số đơn đăng ký, số người được mời, đã gửi trước đó bao nhiêu, sẽ gửi mấy thư,
5 người nhận đầu tiên (địa chỉ đã che, vd. `n***@hoangmaistarschool.edu.vn`) và
**kết luận** lần chạy thật lúc này sẽ làm gì. **Không gửi email, không ghi gì.**
Xem tuần khác: `node survey-invite.mjs --dry-run --week 2026-10-05` (ngày thứ 2
của tuần).

So số người được mời với số CBGV-NV đăng ký ăn tháng này — phải gần bằng nhau.
Rồi sửa `"enabled": true`.

### Chạy tự động — task thứ tư trong Task Scheduler

| Task | Lịch (3 trigger) | Program/script | Add arguments |
|---|---|---|---|
| `DKAN 4 - Khao sat 15h thu 6` | ① **Thứ 6, 15:00**, lặp mỗi 15 phút trong 1 giờ; ② **hằng ngày 07:30**, lặp mỗi 1 giờ trong 5 giờ; ③ **lúc khởi động máy**, chờ 5 phút | `C:\DKAN-Agent\khao-sat-bua-an.bat` | `--quiet` |

Tạo như các task ở mục **Chạy tự động** (Create Task..., Run whether user is
logged on or not, Run with highest privileges, Start in `C:\DKAN-Agent`), khác ở:

- Tab **Triggers** — bấm **New...** ba lần:
  1. **Weekly**, Start **15:00**, Recur every **1** weeks on: chỉ tích
     **Friday**; ở **Advanced settings** tích **Repeat task every: 15
     minutes**, **for a duration of: 1 hour**. Đây là lần gửi chính.
  2. **Daily**, Start **07:30**, Recur every **1** days; **Repeat task every:
     1 hour**, **for a duration of: 5 hours** (07:30 → 12:30). Đây là các lần
     **gửi bù** thứ 7, chủ nhật, sáng thứ 2 khi chiều thứ 6 gửi không được
     (mất mạng, Vercel/Microsoft lỗi, máy tắt) — xem mục **Gửi bù** để biết
     chính xác khi nào lần chạy tự động còn gửi, khi nào phải chạy tay.
  3. Begin the task: **At startup**, tích **Delay task for: 5 minutes** (chờ
     mạng lên). Máy bật lại sau khi tắt suốt chiều thứ 6 thì gửi bù ngay.
- Tab **Settings**: như các task kia — tích **Run task as soon as possible
  after a scheduled start is missed**, **Stop the task if it runs longer than:
  1 hour**, và **If the task is already running... : Do not start a new
  instance**.

Trigger ② và ③ chạy cả những ngày không có gì để gửi — **rất rẻ**: trước 15:00
thứ 6 script thoát ngay, không đọc hệ thống; tuần đã gửi xong thì chỉ đọc 2
document rồi thôi.

Lần 15:00 gửi; các lần sau chỉ gửi nốt cho người **chắc chắn chưa nhận** (thư
lỗi mà Microsoft Graph chắc chắn chưa gửi), không thì thấy "đã gửi xong" và
thôi. Thư **không rõ đã đi chưa** thì không bao giờ tự gửi lại — nên không ai
tự nhận hai thư. Chạy tay trùng lúc
task đang chạy thì lần sau tự chờ (file `khao-sat.lock` cạnh script, chỉ có
trong lúc chạy). Chạy thêm **từ máy khác** (cùng `config.json` +
`firebase-key.json`, vd. máy quản trị IT) đúng lúc máy HAC đang gửi cũng không
gửi trùng: lần chạy giữ **quyền gửi** của tuần trên hệ thống
(`meal_surveys/{tuần}/private/lock`, tự hết sau 10 phút nếu lần chạy chết giữa
chừng); lần chạy kia báo `Một lần chạy khác (máy ...) đang gửi` và thôi.

`--quiet` ghi toàn bộ kết quả vào **`khao-sat.log`** cạnh file `.bat` (quá 5 MB
thì đổi tên thành `khao-sat.old.log`). Hai file log này đã được cấu hình để
Git bỏ qua. Bấm đúp `khao-sat-bua-an.bat` (không `--quiet`) là chạy tay, xem kết
quả trên màn hình — **có gửi thật** nếu đúng giờ; muốn xem thử thì dùng
`--dry-run` như trên.

| Last Run Result | Ý nghĩa |
|---|---|
| `0x0` | Ổn: đã gửi xong, hoặc không có gì phải làm (chưa tới giờ, đã gửi rồi, tuần nghỉ, khảo sát đã đóng, máy khác đang gửi, tính năng đang tắt) |
| `0x1` | Lỗi cấu hình hoặc lỗi chung (sai tham số, thiếu khoá Firebase, không đọc được hệ thống...) — **lần này chưa gửi lời mời nào**, xem `khao-sat.log`. Lần chạy kế tiếp thử lại |
| `0x2` | Có thư gửi lỗi, hoặc thư **không rõ** đã đi chưa (trạng thái `partial` hoặc `error`). Người chắc chắn chưa gửi được thì lần chạy **tự động** gửi nốt — nhưng chỉ trong khung ở mục **Gửi bù** (tới trước 12:00 thứ 2 và còn ít nhất 1 giờ tới hạn); ngoài khung đó phải chạy tay `--week` (giờ cuối trước hạn: thêm `--force`). Người **không rõ** thì **không bao giờ** tự gửi lại — chạy `--force --week`. Xem `reason` |
| `0x3` | **Đã gửi** lời mời nhưng sau đó lỗi (thường là không ghi được trạng thái email lên hệ thống). Danh sách đã nhận đã ghi sau từng thư nên lần sau không gửi trùng và tự ghi lại trạng thái; xem `khao-sat.log` |

### Mỗi lần chạy, script làm gì

1. `survey.enabled` phải là `true` (chạy thử thì bỏ qua bước này).
2. Chọn tuần: tuần chứa hôm nay (giờ Việt Nam) — riêng **sáng thứ 2 trước
   12:00** là tuần vừa qua (khảo sát của nó còn mở). Mốc 12:00 này là hạn
   **mặc định**: quản trị gia hạn tuần trước sang thứ 3, 4... thì từ 12:00 thứ
   2 lần chạy tự động vẫn chuyển sang tuần mới. `--week` chọn tuần khác.
3. **Chưa tới 15:00 thứ 6** của tuần đó: không làm gì, không đọc hệ thống.
4. Tuần đó **đã gửi xong**: không làm gì.
5. **Cả tuần nghỉ** (thứ 2–6 đều là ngày nghỉ khai ở tab Cấu hình): ghi trạng
   thái `skipped`, **không mở khảo sát**, không gửi.
6. Khảo sát tuần đó **đã đóng** (quá hạn, hoặc quản trị bấm "Đóng ngay"): không
   gửi. Gửi **bù** (sau thứ 6) mà còn **chưa tới 1 giờ** là hết hạn trả lời:
   cũng không gửi (không ai kịp trả lời) — trừ khi chạy `--force`.
7. Người được mời: có **đơn đăng ký ăn** của tháng (tuần vắt qua hai tháng thì
   cả hai tháng) **đã có hiệu lực trước thứ 6**, có đăng ký ít nhất một bữa,
   không thuộc danh sách loại trừ (Bếp Vina). Địa chỉ lấy từ **tài khoản đăng
   nhập** (không lấy trên đơn), chỉ gửi tới `@hoangmaistarschool.edu.vn`; hai
   tài khoản chung một địa chỉ thì gửi một lần. Bỏ người đã nhận thư ở lần
   chạy trước.
8. **Mở khảo sát** (document `meal_surveys/{tuần}`) trong **một giao dịch**
   cùng lần đọc lại document tuần ngay lúc đó: quyết định lại (quản trị có thể
   vừa bấm "Đóng ngay" trong lúc script tra danh sách — khi đó không gửi), giành
   **quyền gửi** của tuần (`private/lock`), và chỉ ghi **phần còn thiếu**: chưa
   có giờ mở thì mở từ lúc đó **theo giờ máy chủ** (đồng hồ máy HAC lệch cũng
   không làm Thầy/Cô bấm link bị từ chối), chưa có hạn thì 12:00 thứ 2 tuần sau.
   Giờ mở/hạn quản trị **đã đặt, gia hạn hay đóng sớm** thì không bao giờ bị
   ghi lại.
9. Gửi theo thư, mỗi thư tối đa **400 người Bcc**. **Trước mỗi thư** đọc lại
   hạn đóng và quyền gửi (quản trị đóng giữa chừng thì dừng); hạn vừa đọc gửi
   kèm cho endpoint nên dòng "Thời hạn hoàn thành khảo sát" trong thư là hạn
   **thật** lúc gửi (đã gia hạn thì ghi hạn mới). Sau **mỗi thư**
   ghi ngay ai đã nhận (`private/invited`); không ghi được thì **dừng gửi** các
   thư còn lại để lần sau không gửi trùng. Thư **không rõ đã đi chưa** (xem
   dưới) được ghi riêng và **không tự gửi lại**.
10. Ghi trạng thái email vào document tuần (chỉ số đếm, không tên, không email)
    — chỉ khối `email`, không đụng giờ mở/hạn.

### Gửi bù

**Lần chạy tự động** (Task Scheduler, không `--week`, không `--force`) gửi —
hay gửi nốt — lời mời của tuần X khi **cả hai** điều sau đúng lúc nó chạy:

- nó chạy từ **15:00 thứ 6** tuần X tới **trước 12:00 thứ 2** tuần sau (từ
  12:00 thứ 2 nó chỉ lo tuần mới), và khảo sát **chưa đóng**;
- nếu đã qua thứ 6 (gửi **bù**): còn **ít nhất 1 giờ** tới hạn thật (không ai
  kịp trả lời một khảo sát sắp đóng). Thứ 6 thì không xét điều này.

Với lịch ở trên, các lần chạy theo lịch đó là:

| Ngày | Giờ chạy theo lịch có gửi | Trigger |
|---|---|---|
| Thứ 6 tuần X | 15:00, 15:15, 15:30, 15:45, 16:00 (quản trị rút hạn về chiều thứ 6 thì chỉ các lần trước hạn) | ① |
| Thứ 7, chủ nhật | 07:30, 08:30, 09:30, 10:30, 11:30, 12:30 (lần nào còn ≥ 1 giờ tới hạn) | ② |
| Thứ 2 tuần sau | 07:30, 08:30, 09:30, 10:30 với hạn mặc định 12:00 — lần 11:30 không gửi (còn 30 phút). Đã gia hạn tới 12:30 thứ 2 trở đi thì có cả 11:30. Lần 12:30 đã là tuần mới | ② |
| Lúc bật máy (5 phút sau khởi động) | bất kỳ giờ nào thỏa hai điều trên | ③ |

Với hạn mặc định 12:00 thứ 2, lần theo lịch cuối cùng là **10:30 thứ 2** (bật
máy thì trước 11:00). Log ghi rõ `GỬI BÙ`, trạng thái có ghi chú "Gửi bù sau
15:00 thứ 6"; khảo sát mở từ lúc gửi bù.

Lần chạy tự động **KHÔNG** gửi — phải chạy tay trên máy HAC — trong các trường
hợp:

- **Đã qua 12:00 thứ 2**, kể cả khi quản trị đã **gia hạn** tuần đó sang thứ
  3, 4...: lần chạy tự động chỉ xét tuần mới. Chạy
  `node survey-invite.mjs --week <thứ 2 của tuần đó>` (được khi khảo sát còn
  mở và còn ít nhất 1 giờ tới hạn).
- **Còn dưới 1 giờ tới hạn thật** (vd. 11:00 → 12:00 thứ 2, hay giờ cuối trước
  hạn quản trị đã đặt): cả lần tự động lẫn `--week` đều không gửi (báo `chỉ
  còn N phút`). Muốn vẫn mời: quản trị **Gia hạn** rồi chạy `--week`, hoặc
  chạy thêm `--force` (`node survey-invite.mjs --force`, hay `--force --week
  <thứ 2>` nếu đã sang tuần mới).
- **Người "không rõ đã nhận"** (xem dưới): không bao giờ tự gửi lại, ở bất kỳ
  lần chạy nào không có `--force`. Chạy `node survey-invite.mjs --force --week
  <thứ 2>` nếu đã xác nhận họ chưa nhận.
- **Khảo sát đã đóng** (quá hạn, hoặc quản trị bấm "Đóng ngay"): không gửi, kể
  cả `--force` (mời làm một khảo sát đã đóng là vô ích). Muốn vẫn thu ý kiến:
  quản trị bấm **Gia hạn** trong tab Khảo sát bữa ăn, rồi chạy
  `node survey-invite.mjs --week <thứ 2 của tuần đó>` — thư ghi **hạn mới**.

Khi còn người chưa gửi được, `reason` của trạng thái email (Firebase
Console: `meal_surveys` → tuần → `email`) ghi lần chạy **theo lịch** kế tiếp
sẽ gửi nốt và lần theo lịch cuối cùng cho tuần đó (`Lần chạy sau sẽ gửi nốt
(lần theo lịch kế tiếp ...)`), hoặc `Không còn lần chạy tự động nào gửi nốt`
kèm lệnh chạy tay (khảo sát đã đóng thì kèm lời nhắc gia hạn trước). Câu này
tính từ lúc lần chạy kết thúc, theo hạn lúc đó, và không tính lần bật máy. Tab Khảo sát bữa ăn không hiện câu này mà tự tính lại
việc cần làm theo giờ hiện tại và hạn đang lưu (quản trị có thể đã gia hạn sau
đó).

Các cách chạy tay khác:

- **Gửi bù bằng tay** sau 15:00 thứ 6: chạy `node survey-invite.mjs` (tuần
  này, hoặc tuần vừa qua nếu là sáng thứ 2 trước 12:00) hoặc
  `node survey-invite.mjs --week 2026-10-05`.
- **Gửi sớm, không chờ 15:00 thứ 6** (vd. thứ 6 trường nghỉ, muốn gửi từ chiều
  thứ 5): `node survey-invite.mjs --force`. `--force` bỏ qua kiểm tra giờ (kể
  cả quy tắc "còn chưa tới 1 giờ") và **gửi lại cho người "không rõ đã nhận"**
  (xem dưới); vẫn **không gửi lại** người đã nhận, tuần đã gửi xong, không gửi
  cho tuần nghỉ, không gửi khi khảo sát đã đóng. Khảo sát mở từ lúc chạy.

### Trạng thái email

Xem ở tab **Khảo sát bữa ăn** (hoặc Firebase Console: `meal_surveys` → tuần →
`email`).

| Trạng thái | Nghĩa | Lần chạy sau |
|---|---|---|
| `sent` | Mọi thư đều đi; `sent` người đã nhận | Bỏ qua — không bao giờ gửi lại tuần này |
| `partial` | Có thư lỗi; dừng giữa chừng (không ghi được danh sách đã nhận, hay quản trị đóng khảo sát giữa chừng); hoặc có thư **không rõ đã đi chưa**. Người đã nhận vẫn được nhớ. Lý do ở `reason` | Lần chạy tự động gửi nốt cho người chắc chắn chưa nhận **chỉ trong khung tự động** ở mục **Gửi bù** (thứ 6 từ 15:00; thứ 7, CN, sáng thứ 2 tới trước 12:00 và còn ≥ 1 giờ tới hạn). Ngoài khung đó — kể cả khi quản trị đã gia hạn — phải chạy tay `--week <thứ 2>` (giờ cuối trước hạn: thêm `--force`). Người **không rõ** thì không bao giờ tự gửi lại (`--force --week`) |
| `error` | Chưa ai nhận được thư (endpoint lỗi, sai khoá...) — xem `reason`. Khảo sát vẫn đã mở | Thử gửi lại như `partial` (cùng khung tự động, ngoài khung thì chạy tay). Lỗi do cấu hình (sai khoá, bản web cũ) thì sửa xong mới hết |
| `skipped` | Không gửi: cả tuần nghỉ, hoặc không có ai để mời (chưa ai đăng ký, hay mọi tài khoản thiếu email trường). Khảo sát **không** được mở | Kiểm tra lại; tuần có suất ăn trở lại (quản trị bỏ ngày nghỉ) thì gửi |

Các trường còn lại: `at` lúc ghi trạng thái, `sentAt` lúc thư cuối cùng đi,
`recipients` số người được mời, `sent` số người đã nhận thư, `failed` số người
lần này chắc chắn chưa gửi được, `reason` ghi chú (gửi bù, số người không rõ
đã nhận, số người không có email trường...).

### Thư "không rõ đã đi chưa"

Trường ~300 CBGV-NV nên thường **chỉ một thư** (Bcc) cho **cả trường**. Có
những lỗi mà không ai biết chắc thư đã đi hay chưa:

- giữa máy HAC và Vercel: endpoint không trả lời trong 90 giây, đứt kết nối
  giữa chừng, Vercel trả trang lỗi `502`/`504`;
- giữa Vercel và Microsoft Graph, **sau khi** Graph đã nhận yêu cầu gửi: Graph
  không trả lời trong 10 giây, trả lỗi `5xx`, hoặc đứt kết nối. Endpoint báo
  những trường hợp này bằng `maybeSent: true` trong kết quả (HTTP 200).

Gửi lại "cho chắc" thì nếu Microsoft Graph thực ra đã gửi, **mọi CBGV-NV nhận
hai thư** (và hộp thư gửi không lưu thư đã gửi để đối chiếu). Vì vậy script:

- chỉ tự gửi lại khi **chắc chắn chưa gửi**: không kết nối được tới máy chủ,
  máy chủ từ chối (`4xx`, kể cả `HTTP 400` vì hạn trả lời đã qua), hoặc
  endpoint báo rõ Graph **chưa** gửi — Graph từ chối thư (`4xx`, quá tải
  `429`) hay endpoint hết thời gian trước khi kịp gửi;
- thư **không rõ** thì ghi người nhận vào `private/invited.uncertainEmails`,
  trạng thái `partial`, `reason` ghi `N người KHÔNG RÕ đã nhận thư mời hay
  chưa (Microsoft Graph có thể đã nhận thư: ...)`, mã thoát `0x2` — và
  **không** tự gửi lại ở các lần sau, kể cả lần chạy tự động trong khung gửi
  bù.

Cách xử lý: hỏi vài Thầy/Cô xem đã nhận thư chưa (hoặc xem lượt trả lời trong
tab Khảo sát bữa ăn có tăng không). **Đã nhận** thì thôi (trạng thái giữ
`partial`, không ảnh hưởng khảo sát). **Chưa nhận** thì trên máy HAC chạy
`node survey-invite.mjs --force --week <thứ 2 của tuần>` — gửi lại đúng những
người "không rõ" (và người chưa nhận), xong thì trạng thái thành `sent`.

### Lỗi thường gặp

| Thông báo | Nguyên nhân / cách xử lý |
|---|---|
| `survey.enabled đang tắt` / `chưa có khối "survey"` | Chưa bật. Thêm/sửa `"survey": { "enabled": true }` sau khi đã chạy thử |
| `alerts.secret vẫn là chữ mẫu` / `quá ngắn` / `alerts.endpoint đang trống` | Điền khối `alerts` như mục 6 — dùng chung với email cảnh báo |
| `Chưa tới giờ gửi: ... gửi từ 15:00 ...` | Bình thường khi chạy trước 15:00 thứ 6. Muốn gửi sớm thì `--force`; muốn xem thử thì `--dry-run` |
| `Khảo sát tuần ... đã đóng lúc ...` | Quá hạn trả lời hoặc quản trị đã đóng. Xem mục **Gửi bù** |
| `... chỉ còn N phút là hết hạn trả lời ... không gửi bù` | Gửi bù quá sát hạn. Muốn vẫn mời: quản trị **Gia hạn** rồi chạy `--week <thứ 2>`, hoặc chạy `--force` |
| `Kiểm tra lại ngay trước khi gửi: ... đã đóng` / `Thư i/n: KHÔNG gửi — khảo sát đã đóng` | Quản trị vừa đóng khảo sát trong lúc script chạy — script tôn trọng, không gửi tiếp |
| `Thư i/n: KHÔNG gửi — không kiểm tra được trạng thái khảo sát trước khi gửi (...) — dừng gửi các thư còn lại` | Mất kết nối Firestore ngay trước thư đó. Thư đó và các thư sau **chắc chắn chưa gửi**; `reason` ghi lần chạy theo lịch nào gửi nốt, hay phải chạy tay `--week <thứ 2>` (xem mục **Gửi bù**) |
| `Một lần chạy khác (máy ...) đang gửi lời mời tuần này` | Máy khác (hoặc lần chạy khác) đang giữ quyền gửi — bình thường, mã `0x0`. Lần chạy kia chết giữa chừng thì quyền tự hết sau 10 phút |
| `Thư i/n: KHÔNG RÕ đã gửi hay chưa` / `N người KHÔNG RÕ đã nhận` | Xem mục **Thư "không rõ đã đi chưa"** |
| `ĐÃ GỬI N lời mời nhưng không ghi được trạng thái email` | Mã `0x3`. Thư đã đi, danh sách đã nhận đã ghi; lần chạy sau tự ghi lại trạng thái, không gửi trùng |
| `Endpoint trả HTTP 400: ... kind` | Bản web trên Vercel chưa có tính năng khảo sát — cập nhật web rồi chạy lại |
| `Endpoint trả HTTP 400: Khảo sát tuần này đã đóng lúc ...` | Hạn trả lời đã qua ngay lúc gửi (quản trị vừa đóng, hoặc đồng hồ máy HAC chậm). Chưa gửi gì. Muốn vẫn mời: **Gia hạn** rồi chạy `--week <thứ 2>` |
| `Endpoint trả HTTP 400: closesAt phải sau 00:00 thứ 2 của tuần và không quá 40 ngày sau đó` | Hạn trả lời của tuần đặt quá xa (hơn 40 ngày sau thứ 2 đầu tuần) — endpoint không in một hạn vô lý vào thư. Chưa gửi gì. Quản trị đặt lại hạn gần hơn rồi chạy `--week <thứ 2>` |
| `Endpoint trả HTTP 401` / `500` / `404`, `Không gọi được ...` | Như email cảnh báo — xem bảng **Lỗi ở pha cảnh báo** |
| `Không có CBGV-NV nào để mời` | Không ai có đơn đăng ký ăn tuần đó (hoặc tài khoản không có email trường). Trạng thái `skipped` |
| `N người không có email @hoangmaistarschool.edu.vn trong tài khoản` | Tài khoản đăng nhập dùng email ngoài trường — không gửi được, cần nhắc trực tiếp |
| `không ghi được danh sách đã nhận — DỪNG gửi tiếp` | Mất kết nối Firestore (đã thử lại 3 lần). Người của thư vừa gửi có thể nhận trùng ở lần sau; báo lại để kiểm tra |
| `Vẫn đang có một lần gửi lời mời khác sau 10 phút chờ` | Lần chạy trước bị treo. Chắc chắn không còn `node.exe` nào chạy thì xoá `khao-sat.lock` cạnh script |

Còn một khe nhỏ có thể gửi trùng: thư đã đi mà máy mất kết nối Firestore
**đúng lúc** ghi danh sách đã nhận (đã thử lại 3 lần, trong khi Firestore vừa
trả lời được ngay trước đó) — script dừng gửi tiếp, báo `không ghi được danh
sách đã nhận`, và người trong **thư đó** (thường là cả trường) có thể nhận lại
ở lần chạy sau.

---

## Khi có lỗi

| Thông báo | Nguyên nhân thường gặp |
|---|---|
| `Sai tài khoản hoặc mật khẩu thiết bị` | Kiểm tra lại `config.json` |
| `HTTP 403` hoặc `404` | ISAPI chưa bật: vào giao diện web của máy → Cấu hình → Mạng → Nâng cao → Integration Protocol |
| `HTTP 400` | Firmware kén nội dung yêu cầu. Script tự thử 5 kiểu khác nhau; nếu vẫn hỏng, nó in ra lý do thiết bị trả về — gửi phần đó để chỉnh |
| `ECONNREFUSED` | Cổng 80 đóng. Thiết bị có thể chỉ chạy HTTPS: thêm `"protocol": "https"` cho máy đó trong `config.json` |
| `ETIMEDOUT` / `EHOSTUNREACH` | Không định tuyến tới được. Thử mở `http://10.34.32.35` bằng trình duyệt **trên chính máy chạy script** |
| `TIMEOUT — thiết bị không trả lời trong 20 giây` | Xem mục **Máy báo TIMEOUT** dưới đây |
| `Máy trả về 0 lượt chấm cho cả 7 ngày, trong khi hệ thống đã có lượt chấm...` | Máy trả lời bình thường nhưng không có sự kiện nào — gần như chắc chắn **giờ trên máy bị lệch** (hỏi sai khoảng ngày) hoặc **bộ nhớ sự kiện vừa bị xoá**. Script coi như máy lỗi, giữ nguyên dữ liệu cũ. Kiểm tra NTP trên máy nhận diện |
| `Không máy nào trả được dữ liệu` | Cả hai máy lỗi. Lượt chấm trên hệ thống giữ nguyên; trang cá nhân hiện cảnh báo đồng bộ lỗi |
| `Không đọc được file khóa Firebase` | Thiếu `firebase-key.json` hoặc sai tên |
| `Chưa cài thư viện firebase-admin` | Chạy `npm install` trong thư mục agent |
| `Cannot find module ...\lib\...` | Chỉ chép mỗi `sync-checkins.mjs`. Chép lại **cả thư mục**, gồm `lib\` |
| Lấy được 0 lượt chấm | Khoảng ngày không có ai chấm, hoặc giờ trên thiết bị bị lệch. Kiểm tra NTP trên máy nhận diện |
| `Thiết bị có quá nhiều sự kiện...` / `Thiết bị báo có X sự kiện nhưng chỉ lấy được Y` | Xem mục **Dữ liệu bị cắt** dưới đây |
| `Lưu ý: <máy> chỉ trả lượt chấm từ ... tới ...` | Máy không có dữ liệu cho các ngày đầu/cuối khoảng đã hỏi. Ngày cuối tuần, ngày nghỉ thì bình thường. Ngày đi làm thì kiểm tra giờ (NTP) và bộ nhớ sự kiện của máy. Phần cũ của máy ở những ngày đó được giữ nguyên |
| `Tham số không hợp lệ: "..."` | Gõ sai tham số. Script in danh sách tham số đúng; không chạy gì cả |
| `Đang có một lần chạy khác ... chờ nó xong` | Bình thường khi chạy tay trùng lúc task đang chạy — script tự chờ |
| `Vẫn đang có một lần chạy khác của agent sau 10 phút chờ` | Lần chạy trước bị treo hoặc rất lâu. Mở Task Manager xem còn `node.exe` chạy không. Chắc chắn không còn thì xoá file `dong-bo.lock` cạnh script (khoá của tiến trình đã tắt tự hết hiệu lực, nên hiếm khi phải làm) |
| `Bỏ qua N đơn đăng ký tháng ... không hợp lệ` | Có đơn không do trang đăng ký tạo ra (id lạ, `userId` sai dạng). Script đã bỏ qua; quản trị nên xoá các đơn được liệt kê trong Firebase Console |
| `Bỏ qua N đơn tháng ... của tài khoản không còn tồn tại` | Đơn của tài khoản đã bị xoá khỏi Authentication. Không ảnh hưởng gì; có thể xoá đơn đó |

### Lỗi ở pha cảnh báo

| Thông báo | Nguyên nhân / cách xử lý |
|---|---|
| `alerts.enabled đang tắt` | Chưa bật. Sửa `"enabled": true` sau khi đã chạy thử |
| `alerts.secret vẫn là chữ mẫu` / `quá ngắn` | Chưa điền khoá thật — xem mục 6 |
| `alerts.secret có ký tự không dùng được` | Khoá có dấu cách, xuống dòng, tab hoặc chữ có dấu (thường do gõ lại tay hoặc dán thừa). Tạo lại bằng lệnh ở mục 6, dán nguyên dãy vào cả hai nơi |
| `Cấu hình alerts trong config.json của agent chưa đúng: ...` | Trạng thái `error`, mã thoát `0x2`. Sửa đúng mục được nêu (vd. `"notBefore": "13:40"` — phải đủ hai chữ số giờ) |
| `Endpoint trả HTTP 401 ... không khớp biến MEAL_ALERT_SECRET` | Khoá trong `config.json` khác khoá trên Vercel. Sửa cho giống hệt; nếu vừa đổi trên Vercel thì phải **Redeploy** |
| `Endpoint trả HTTP 500 ... chưa cấu hình` | Vercel chưa có `MEAL_ALERT_SECRET` (hoặc ngắn hơn 32 ký tự), hoặc chưa Redeploy sau khi thêm |
| `Endpoint trả HTTP 404` | Sai `alerts.endpoint`, hoặc bản web đang chạy chưa có tính năng cảnh báo |
| `Không gọi được dkan.nshm.vn` | Máy HAC không ra được Internet, hoặc tường lửa chặn |
| `Mới HH:MM, chưa tới giờ gửi cảnh báo` | Bình thường khi chạy tay trước `notBefore`. Muốn xem thử thì dùng `--dry-run --send-alerts --alerts-date ...` |
| `Lần đồng bộ lúc ... không đủ máy` | Trạng thái `error`. Sửa máy lỗi; lần lặp 15 phút sau tự thử lại |
| `CHỐT AN TOÀN — DỪNG ... Máy X trả lời được nhưng không có lượt chấm nào trong ngày` | Máy trả lời được nhưng 0 lượt hôm nay. Trạng thái `guarded`, quản trị được báo một lần, không gửi cho CBNV. Kiểm tra giờ trên máy (thường lệch sau mất điện); số liệu đúng trở lại thì lần lặp sau tự gửi. Nếu bếp đó nghỉ thật cả ngày, hôm đó sẽ không gửi cảnh báo |
| `CHỐT AN TOÀN — DỪNG ... máy X không có lượt chấm nào trong khung Bữa ...` | Máy X có lượt chấm hôm nay nhưng mất trọn một bữa, trong khi những ngày trước vẫn có người chấm bữa đó ở máy X — thường do máy khởi động lại / lệch giờ giữa buổi. Kiểm tra máy; số liệu đúng trở lại thì lần lặp sau tự gửi |
| `CHỐT AN TOÀN — DỪNG` (tỉ lệ) | Số người chưa chấm cao bất thường: thường do một máy lệch giờ hoặc trả thiếu dữ liệu. Kiểm tra máy và tab Đối soát. Nếu cả trường có sự kiện không ăn (dã ngoại, nghỉ đột xuất), quản trị nên khai ngày đó là **ngày nghỉ** ở tab Cấu hình **trước** 13:45 |
| `Không gửi được cho N người: tài khoản không có email @hoangmaistarschool.edu.vn` | Tài khoản đăng nhập của họ dùng email ngoài trường. Không gửi được, cần nhắc trực tiếp |
| `Bỏ qua N mã NV trùng giữa nhiều đơn` | Hai đơn đăng ký cùng một mã NV. Không ai trong số đó nhận cảnh báo cho tới khi quản trị sửa đơn |
| `đã gửi N email nhưng không ghi được nhật ký — DỪNG gửi tiếp` | Mất kết nối Firestore hoặc hết hạn mức ghi miễn phí trong ngày (đã thử lại 3 lần). Script dừng gửi các lô còn lại (trạng thái `partial`) nên chỉ N người của lô đó có thể nhận trùng ở lần sau. Báo lại để kiểm tra |

---

## Máy báo ECONNREFUSED hoặc ECONNRESET

Nghĩa là **tới được máy nhưng cổng web không mở**, không phải hỏng mạng.

Điểm dễ hiểu nhầm: **HAC không nói chuyện với thiết bị qua HTTP** mà qua cổng
SDK riêng của Hikvision (thường là 8000). Nên máy hiện **Trực tuyến** trong HAC
vẫn có thể đang tắt cổng web — mà ISAPI thì bắt buộc phải có cổng web.

Script tự thử `http:80`, `https:443`, `http:8080`, `https:8443`. Nếu vẫn hỏng:

**1. Mở `http://<IP>` bằng trình duyệt trên chính máy chạy script.**

- Ra trang đăng nhập Hikvision → cổng web đang mở, vấn đề nằm chỗ khác
- Không ra gì → cổng web đóng hoặc đã đổi số

**2. Xem cổng web thật của máy đó.** Trong HAC, vào phần cấu hình từ xa của
thiết bị → Mạng → cổng HTTP. So với máy đang chạy được (`CA_TIH` dùng cổng 80)
xem có khác không.

**3. Khai cổng đúng vào `config.json`:**

```json
{
  "name": "CA_TrH",
  "ip": "10.34.32.35",
  "port": 8080,
  "username": "admin",
  "password": "..."
}
```

**4. Nếu cổng web bị tắt hẳn**, bật lại trong cấu hình thiết bị: Mạng → Cơ bản
→ cho phép HTTP. Bật xong nhớ đổi mật khẩu mạnh nếu chưa làm.

---

## Máy báo TIMEOUT

Nghĩa là máy **nhận kết nối nhưng không trả lời** trong 20 giây — thường do máy
đang treo hoặc quá tải. Script không chờ mãi (trước đây có thể treo cả buổi,
làm Task Scheduler bỏ qua các lần chạy sau).

1. Khởi động lại máy nhận diện (rút nguồn hoặc khởi động lại từ HAC).
2. Chạy tay `node sync-checkins.mjs --dry-run` để xem đã hết chưa.
3. Nếu máy chỉ chậm chứ không treo (mạng yếu), tăng hạn chờ bằng cách thêm vào
   `config.json` dòng `"deviceTimeoutMs": 40000` (40 giây).

---

## Dữ liệu bị cắt

Thông báo `Thiết bị có quá nhiều sự kiện trong khoảng ngày đã hỏi...` hoặc
`Thiết bị báo có X sự kiện nhưng chỉ lấy được Y` nghĩa là máy trả lời bình
thường nhưng script **không lấy được trọn** dữ liệu. Lần đó máy được tính là
**lỗi**: lượt chấm cũ của máy trên hệ thống giữ nguyên, không ngày nào bị chốt
thiếu, không ai bị cảnh báo oan.

- **Quá nhiều sự kiện**: thường do hỏi khoảng ngày quá dài (vd. `--days 90`)
  với máy chỉ trả 10 dòng mỗi lần. Giảm `--days` (vd. 14) rồi chạy lại.
- **Lấy ít hơn số máy báo**: thiết bị trả lời bất thường. Chạy lại với
  `--dry-run --debug`; nếu lần nào cũng vậy, khởi động lại máy nhận diện và gửi
  phần thông báo lỗi để kiểm tra.

---

## Lưu ý vận hành

- **Bật NTP trên cả hai máy nhận diện.** Giờ lệch là suất ăn rơi sai khung
  giờ, thậm chí sai ngày — và có thể làm người đã ăn nhận email cảnh báo oan.
- **Đặt IP tĩnh** cho hai thiết bị. IP đổi là script mất kết nối.
- **Đổi tên máy trong `config.json` (`name`) thì báo lại**: tên máy là khoá
  lưu phần dữ liệu riêng của từng máy.
- Script chỉ lưu **giờ chấm thô**, không tự phân bữa sáng/trưa. Việc phân bữa
  do phần mềm làm theo khung giờ trong `lib\meal-rules.mjs` — sau này đổi khung
  giờ thì dữ liệu cũ tự tính lại đúng, không phải đồng bộ lại.
- Nút tải file Excel trong tab Đối soát vẫn giữ nguyên, dùng làm đường dự
  phòng khi script hoặc mạng có sự cố.
