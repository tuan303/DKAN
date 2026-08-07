/**
 * Đồng bộ lượt chấm ăn từ các máy nhận diện Hikvision về Firestore.
 *
 * Chạy trên PC trong LAN (máy cài HAC), lấy sự kiện qua ISAPI của từng thiết
 * bị rồi ghi vào collection `checkins`, mỗi ngày một document.
 *
 * Cách chạy:
 *   node sync-checkins.mjs              lấy N ngày gần nhất theo config
 *   node sync-checkins.mjs --days 30    lấy 30 ngày gần nhất
 *   node sync-checkins.mjs --dry-run    chỉ in ra, không ghi Firestore
 *   node sync-checkins.mjs --debug      in thêm mã sự kiện thô của thiết bị
 *
 * Lưu ý thiết kế: script chỉ lưu GIỜ CHẤM THÔ, không tự phân bữa sáng/trưa.
 * Việc phân bữa do phần mềm làm theo khung giờ trong cấu hình, nhờ vậy sau này
 * đổi khung giờ là dữ liệu cũ tự tính lại đúng, không phải đồng bộ lại.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// firebase-admin nạp muộn, ngay trước lúc ghi: chế độ --dry-run không cần tới
// nó, nhờ vậy kiểm tra kết nối thiết bị được ngay cả khi phần Firebase chưa
// sẵn sàng.


// In ra mỗi lần chạy để biết chắc máy đang dùng bản nào — tránh mất thời gian
// vì chạy nhầm file cũ.
const AGENT_VERSION = '2026-08-07.6';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const hasFlag = f => argv.includes(f);
const flagValue = (f, fallback) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = hasFlag('--dry-run');
const DEBUG = hasFlag('--debug');

const log = (...a) => console.log(...a);
const fail = msg => { console.error('\n  LỖI: ' + msg + '\n'); process.exit(1); };

// Khi thử HTTPS với thiết bị LAN (chứng chỉ tự ký), Node in một cảnh báo dài
// chen ngang giữa dòng làm rối màn hình. Đây là việc cố ý và chỉ áp dụng cho
// thiết bị trong mạng nội bộ, nên ẩn riêng cảnh báo đó, giữ lại các cảnh báo
// khác.
process.removeAllListeners('warning');
process.on('warning', w => {
  if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(w.message)) return;
  console.warn(`${w.name}: ${w.message}`);
});

// ---------------------------------------------------------------- cấu hình

let config;
try {
  config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
} catch (err) {
  fail(
    'Không đọc được config.json. Hãy chép config.example.json thành config.json ' +
    'rồi điền thông tin hai máy chấm công.\n  Chi tiết: ' + err.message
  );
}

const DAYS = Number(flagValue('--days', config.daysToSync || 7));
if (!Number.isFinite(DAYS) || DAYS < 1) fail('Số ngày đồng bộ không hợp lệ.');
if (!Array.isArray(config.devices) || !config.devices.length) fail('config.json chưa khai máy chấm công nào.');


// ---------------------------------------------------- xác thực digest (ISAPI)

/**
 * ISAPI dùng HTTP Digest chứ không phải Basic, mà fetch không hỗ trợ sẵn:
 * gọi lần đầu để nhận 401 kèm nonce, rồi gọi lại với chữ ký MD5.
 */
const md5 = s => createHash('md5').update(s).digest('hex');

function buildDigestHeader(authHeader, { username, password, method, uri, body }) {
  const parts = {};
  for (const m of authHeader.matchAll(/(\w+)="?([^",]+)"?/g)) parts[m[1]] = m[2];

  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  const qop = (parts.qop || '').split(',')[0].trim() || 'auth';

  const ha1 = md5(`${username}:${parts.realm}:${password}`);
  const ha2 = qop === 'auth-int'
    ? md5(`${method}:${uri}:${md5(body || '')}`)
    : md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${parts.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  return `Digest username="${username}", realm="${parts.realm}", nonce="${parts.nonce}", ` +
    `uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"` +
    (parts.opaque ? `, opaque="${parts.opaque}"` : '');
}

/** Lỗi mạng của fetch rất chung chung; mã thật nằm trong err.cause. */
function describeNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';
  const map = {
    ECONNREFUSED: 'thiết bị từ chối kết nối (cổng 80 đang đóng, hoặc thiết bị chỉ chạy HTTPS)',
    ETIMEDOUT: 'hết thời gian chờ (không định tuyến tới được, hoặc tường lửa chặn)',
    EHOSTUNREACH: 'không tới được địa chỉ này từ máy đang chạy script',
    ENOTFOUND: 'không phân giải được địa chỉ',
    ECONNRESET: 'thiết bị ngắt kết nối giữa chừng',
    UND_ERR_CONNECT_TIMEOUT: 'hết thời gian chờ kết nối',
  };
  if (code) return `${code} — ${map[code] || 'lỗi kết nối'}`;
  const detail = err?.cause?.message || err?.message || '';
  return detail ? `${detail} (không rõ mã lỗi)` : 'lỗi kết nối không rõ nguyên nhân';
}

/**
 * Gọi một lần theo giao thức chỉ định. Trả về Response hoặc ném lỗi mạng.
 * Thiết bị trong LAN dùng chứng chỉ tự ký nên khi thử HTTPS phải tạm bỏ kiểm
 * tra chứng chỉ — chỉ bật trong lúc nói chuyện với thiết bị, tắt lại trước khi
 * kết nối Firebase để không làm yếu đường truyền ra Internet.
 */
async function rawPost(base, device, uri, init) {
  if (base.protocol === 'https') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fetch(`${base.protocol}://${device.ip}:${base.port}${uri}`, init);
  } finally {
    if (base.protocol === 'https') delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
}

/**
 * Cổng web của Hikvision đổi được, và có máy bị tắt hẳn HTTP. HAC nói chuyện
 * qua cổng SDK riêng (8000) nên máy "Trực tuyến" trong HAC không có nghĩa là
 * cổng web đang mở. Thử lần lượt các tổ hợp hay gặp.
 */
function baseCandidates(device) {
  if (device._workingBase) return [device._workingBase];
  if (device.protocol || device.port) {
    const protocol = device.protocol || (Number(device.port) === 443 ? 'https' : 'http');
    return [{ protocol, port: Number(device.port) || (protocol === 'https' ? 443 : 80) }];
  }
  return [
    { protocol: 'http', port: 80 },
    { protocol: 'https', port: 443 },
    { protocol: 'http', port: 8080 },
    { protocol: 'https', port: 8443 },
  ];
}

const baseLabel = b => `${b.protocol}:${b.port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Thiết bị hay rớt kết nối khi bị hỏi dồn dập — trang đầu chạy ngon rồi trang
 * sau đứt. Thử lại vài lần với giãn cách tăng dần thay vì bỏ cuộc ngay.
 */
async function postWithRetry(base, device, uri, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await rawPost(base, device, uri, init);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

async function digestPost(device, uri, payload) {
  const body = JSON.stringify(payload);
  const init = {
    method: 'POST',
    body,
    // Hikvision hay ngat ngang khi giu ket noi mo; dong luon cho gon.
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
  };

  let res;
  let lastErr;
  const tried = [];
  const candidates = baseCandidates(device);
  for (const base of candidates) {
    tried.push(baseLabel(base));
    try {
      // Lúc còn đang dò cổng thì thử ít lần cho nhanh; khi đã biết cổng chạy
      // được thì kiên nhẫn hơn vì lỗi lúc này là do thiết bị bận.
      res = await postWithRetry(base, device, uri, init, candidates.length === 1 ? 3 : 1);
      device._workingBase = base;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!res) {
    throw new Error(
      `Không kết nối được ${device.ip} — đã thử ${tried.join(', ')} — ${describeNetworkError(lastErr)}`
    );
  }

  if (res.status === 401) {
    const wwwAuth = res.headers.get('www-authenticate') || '';
    if (!/digest/i.test(wwwAuth)) throw new Error(`Thiết bị không dùng Digest: ${wwwAuth}`);
    const auth = buildDigestHeader(wwwAuth, {
      username: device.username, password: device.password, method: 'POST', uri, body,
    });
    try {
      res = await postWithRetry(device._workingBase, device, uri, {
        ...init,
        headers: { ...init.headers, Authorization: auth },
      });
    } catch (err) {
      // Trước đây lỗi ở bước này lọt ra ngoài dưới dạng "fetch failed" trần
      // trụi, không kèm gợi ý gì.
      throw new Error(
        `Không kết nối được ${device.ip} qua ${baseLabel(device._workingBase)} ` +
        `ở bước xác thực — ${describeNetworkError(err)}`
      );
    }
  }

  if (res.status === 401) throw new Error('Sai tài khoản hoặc mật khẩu thiết bị.');
  if (!res.ok) {
    // Hikvision trả lý do cụ thể trong thân phản hồi — không in ra thì mò rất lâu.
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
    const err = new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` | thiết bị trả về: ${detail}` : ''}`);
    err.httpStatus = res.status;
    throw err;
  }
  return res.json();
}

// ------------------------------------------------------------ lấy sự kiện

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Khoảng thời gian cần lấy, tính theo giờ địa phương của máy chạy script. */
function timeRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const tz = config.timezoneOffset || '+07:00';
  return {
    startTime: `${isoDate(start)}T00:00:00${tz}`,
    endTime: `${isoDate(end)}T23:59:59${tz}`,
  };
}

/**
 * Mỗi đời firmware Hikvision khó tính một kiểu với nội dung yêu cầu: có máy
 * bắt buộc phải có cả major lẫn minor, có máy giới hạn maxResults, có máy chỉ
 * chấp nhận searchID ngắn. Thử lần lượt tới khi máy chấp nhận, rồi dùng luôn
 * biến thể đó cho các trang sau.
 */
const REQUEST_VARIANTS = [
  { label: 'không lọc loại sự kiện, 30 dòng', cond: { maxResults: 30 } },
  { label: 'major=5 + minor=0, 30 dòng', cond: { maxResults: 30, major: 5, minor: 0 } },
  { label: 'major=5, 30 dòng', cond: { maxResults: 30, major: 5 } },
  { label: 'không lọc loại sự kiện, 10 dòng', cond: { maxResults: 10 } },
  { label: 'không lọc, không giới hạn dòng', cond: {} },
];

const buildBody = (variant, range, position, searchID) => ({
  AcsEventCond: {
    searchID,
    searchResultPosition: position,
    ...variant.cond,
    ...range,
  },
});

const ENDPOINT = '/ISAPI/AccessControl/AcsEvent?format=json';

/** Tìm biến thể yêu cầu mà thiết bị chấp nhận, thử trên trang đầu tiên. */
async function findVariant(device, range, searchID) {
  const problems = [];
  for (const variant of REQUEST_VARIANTS) {
    try {
      const data = await digestPost(device, ENDPOINT, buildBody(variant, range, 0, searchID));
      return { variant, first: data };
    } catch (err) {
      problems.push(`      - ${variant.label}: ${err.message}`);
      // Sai mật khẩu hay không nối được thì thử tiếp cũng vô ích.
      if (!err.httpStatus) throw err;
      if (err.httpStatus === 401 || err.httpStatus === 403) throw err;
    }
  }
  throw new Error('Thiết bị từ chối mọi kiểu yêu cầu đã thử:\n' + problems.join('\n'));
}

async function fetchDeviceEvents(device, range) {
  const events = [];
  const seenCodes = new Map();
  const searchID = randomBytes(8).toString('hex');

  const { variant, first } = await findVariant(device, range, searchID);
  if (DEBUG) log(`\n    [debug] ${device.name || device.ip} chấp nhận kiểu yêu cầu: ${variant.label}`);

  let position = 0;
  let pending = first;

  for (let guard = 0; guard < 1000; guard++) {
    let data;
    if (pending) {
      data = pending;
      pending = null;
    } else {
      // Nghỉ một nhịp giữa các trang: hỏi dồn dập là thiết bị rớt kết nối.
      await sleep(config.pageDelayMs ?? 250);
      data = await digestPost(device, ENDPOINT, buildBody(variant, range, position, searchID));
    }

    const acs = data.AcsEvent || {};
    const list = acs.InfoList || [];

    for (const e of list) {
      if (DEBUG) {
        const key = `major=${e.major} minor=${e.minor}`;
        const cur = seenCodes.get(key) || { count: 0, sample: e };
        cur.count++;
        seenCodes.set(key, cur);
      }
      // Chỉ nhận sự kiện gắn với một người cụ thể. Mở cửa bằng nút bấm, báo
      // động, cạy cửa... đều không có mã nhân viên nên tự loại.
      const employeeId = String(e.employeeNoString || e.employeeNo || '').trim();
      if (!employeeId || !e.time) continue;
      events.push({
        employeeId,
        name: String(e.name || '').trim(),
        time: String(e.time),
        device: device.name || device.ip,
      });
    }

    const matched = Number(acs.numOfMatches || list.length);
    position += matched;
    const status = String(acs.responseStatusStrg || '').toUpperCase();
    if (status !== 'MORE' || matched === 0) break;
  }

  if (DEBUG && seenCodes.size) {
    log(`\n    [debug] Mã sự kiện thiết bị ${device.name || device.ip} trả về:`);
    for (const [key, v] of seenCodes) {
      log(`      ${key}: ${v.count} lượt | ví dụ: employeeNoString=${v.sample.employeeNoString ?? '(trống)'} name=${v.sample.name ?? ''} verifyMode=${v.sample.currentVerifyMode ?? ''}`);
    }
  }

  return events;
}

// --------------------------------------------------------------- gom nhóm

/** Gom về dạng: ngày -> mã NV -> { name, times[] } */
function groupByDate(events) {
  const byDate = {};
  for (const e of events) {
    // Chuỗi thời gian thiết bị trả về: 2026-08-07T07:31:22+07:00
    const date = e.time.slice(0, 10);
    const hhmm = e.time.slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hhmm)) continue;

    const day = (byDate[date] ||= {});
    const person = (day[e.employeeId] ||= { name: e.name, times: [] });
    if (!person.name && e.name) person.name = e.name;
    if (!person.times.includes(hhmm)) person.times.push(hhmm);
  }
  for (const day of Object.values(byDate)) {
    for (const p of Object.values(day)) p.times.sort();
  }
  return byDate;
}

// ------------------------------------------------------------------- chạy

log('');
log(`  ĐỒNG BỘ LƯỢT CHẤM ĂN TỪ MÁY NHẬN DIỆN   (bản ${AGENT_VERSION})`);
log('  ' + '─'.repeat(50));

const range = timeRange(DAYS);
log(`  Khoảng lấy : ${range.startTime.slice(0, 10)} → ${range.endTime.slice(0, 10)} (${DAYS} ngày)`);
log(`  Thiết bị   : ${config.devices.map(d => d.name || d.ip).join(', ')}`);
if (DRY_RUN) log('  Chế độ     : CHẠY THỬ, không ghi lên hệ thống');
log('');

const all = [];
for (const device of config.devices) {
  process.stdout.write(`  • ${device.name || device.ip} ... `);
  try {
    const evs = await fetchDeviceEvents(device, range);
    all.push(...evs);
    log(`${evs.length} lượt chấm`);
  } catch (err) {
    log('THẤT BẠI');
    for (const line of String(err.message).split('\n')) log(`      ${line}`);
    if (/Không kết nối được/.test(err.message)) {
      log('');
      log(`      Thử mở http://${device.ip} bằng trình duyệt TRÊN CHÍNH MÁY NÀY.`);
      log('      Nếu trình duyệt vào được mà script không vào được, khả năng cao thiết bị');
      log('      hoặc cổng web bị đổi. Xem mục "Máy báo ECONNREFUSED" trong README.');
    } else {
      log('      Kiểm tra: ISAPI đã bật chưa, tài khoản mật khẩu trong config.json.');
    }
  }
}

if (!all.length) {
  log('\n  Không lấy được lượt chấm nào. Dừng lại, không ghi gì lên hệ thống.\n');
  process.exit(1);
}

const byDate = groupByDate(all);
const dates = Object.keys(byDate).sort();

log('');
log(`  Tổng cộng  : ${all.length} lượt chấm, ${dates.length} ngày có dữ liệu`);
for (const d of dates) {
  const people = Object.keys(byDate[d]).length;
  const taps = Object.values(byDate[d]).reduce((s, p) => s + p.times.length, 0);
  log(`      ${d}: ${String(people).padStart(4)} người, ${String(taps).padStart(4)} lượt`);
}

if (DRY_RUN) {
  log('\n  Chạy thử nên không ghi gì. Bỏ --dry-run để ghi thật.\n');
  process.exit(0);
}

// ------------------------------------------------------------- ghi Firestore

let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(join(HERE, config.firebaseKeyFile || 'firebase-key.json'), 'utf8'));
} catch (err) {
  fail('Không đọc được file khóa Firebase. ' + err.message);
}

const { default: admin } = await import('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

log('');
let written = 0;
for (const date of dates) {
  // Ghi đè trọn ngày: chạy lại bao nhiêu lần cũng không nhân đôi dữ liệu.
  await db.collection('checkins').doc(date).set({
    date,
    month: date.slice(0, 7),
    people: byDate[date],
    source: 'hikvision-agent',
    syncedAt: new Date().toISOString(),
  });
  written++;
  process.stdout.write(`\r  Đang ghi lên hệ thống... ${written}/${dates.length} ngày`);
}

log(`\n\n  XONG. Đã cập nhật ${written} ngày lên hệ thống.`);
log('  Mở trang Quản trị → tab Đối soát chấm ăn để xem.\n');
process.exit(0);
