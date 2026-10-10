/**
 * Đồng bộ lượt chấm ăn từ các máy nhận diện Hikvision về Firestore.
 *
 * Chạy trên PC trong LAN (máy cài HAC), lấy sự kiện qua ISAPI của từng thiết
 * bị rồi:
 *   1. gộp vào collection `checkins`, mỗi ngày một document (phần của từng máy
 *      giữ riêng, máy lỗi không làm mất lượt chấm đã có);
 *   2. tách lượt chấm cho từng người vào `meal_taps/{uid}/months/{tháng}` để
 *      CBNV tự xem trên trang "Chấm ăn của tôi";
 *   3. ghi trạng thái đồng bộ vào `settings/checkinSync`;
 *   4. (khi có --send-alerts) gửi email cảnh báo "đăng ký mà không chấm ăn".
 *
 * Cách chạy:
 *   node sync-checkins.mjs                  lấy N ngày gần nhất theo config
 *   node sync-checkins.mjs --days 30        lấy 30 ngày gần nhất
 *   node sync-checkins.mjs --dry-run        chỉ in ra, không ghi Firestore
 *   node sync-checkins.mjs --debug          in thêm mã sự kiện thô của thiết bị
 *   node sync-checkins.mjs --send-alerts    đồng bộ xong thì chạy pha cảnh báo
 *   node sync-checkins.mjs --dry-run --send-alerts --alerts-date 2026-10-08
 *                                           xem thử ai sẽ nhận email của một ngày cũ
 *
 * Lưu ý thiết kế: script chỉ lưu GIỜ CHẤM THÔ, không tự phân bữa sáng/trưa.
 * Việc phân bữa do phần mềm làm theo khung giờ trong lib/meal-rules.mjs, nhờ
 * vậy sau này đổi khung giờ là dữ liệu cũ tự tính lại đúng, không phải đồng bộ
 * lại.
 *
 * Mọi quy tắc nghiệp vụ nằm trong lib/ (thuần, có test). File này chỉ lo nói
 * chuyện với thiết bị, Firestore và endpoint gửi email.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vnParts, vnToday, formatVnDateTime, isWeekday, isMealFinal, MEALS, MEAL_LABEL } from './lib/meal-rules.mjs';
import { addDays, datesFromTo, monthDates, chunk, redact, ISO_DATE_RE } from './lib/common.mjs';
import { parseArgs, readAlertsConfig } from './lib/cli.mjs';
import {
  groupByDateDevice, mergeDayDoc, findSuspectDevices, buildSyncSettings, pruneDateKeys,
  summarizePeople, unionPeople, deviceSpans, coversDate,
} from './lib/sync-merge.mjs';
import { normalizePeople, buildOwnerIndex, projectMonth, diffTapDoc, mappingChanged } from './lib/projection.mjs';
import { cleanRegistrations, dropGhosts } from './lib/registrations.mjs';
import {
  alertGate, planAlerts, guardVerdict, uidsToLookup, selectRecipients, buildStaffBodies,
  buildAdminNotice, alertEntry, finalAlertStatus, matchResults, dateLabelOf, deviceMealGaps,
} from './lib/alert-plan.mjs';
import { readAcsPage, pagingProblem, MAX_PAGES } from './lib/isapi-paging.mjs';
import { acquireLock } from './lib/run-lock.mjs';
// firebase-admin nạp muộn, ngay trước lúc cần Firestore: chế độ --dry-run
// không cần tới nó, nhờ vậy kiểm tra kết nối thiết bị được ngay cả khi phần
// Firebase chưa sẵn sàng. Test cũng không bao giờ phải nạp nó.


// In ra mỗi lần chạy để biết chắc máy đang dùng bản nào — tránh mất thời gian
// vì chạy nhầm file cũ. Cũng được ghi vào settings/checkinSync.
const AGENT_VERSION = '2026-10-09.1';

const HERE = dirname(fileURLToPath(import.meta.url));

const log = (...a) => console.log(...a);
// Chỉ dùng cho lỗi cấu hình, TRƯỚC khi có request mạng nào (xem cuối file vì
// sao không được gọi process.exit() sau khi đã dùng fetch).
const fail = msg => { console.error('\n  LỖI: ' + msg + '\n'); process.exit(1); };
/** Lỗi dừng hẳn, đã có thông báo dễ hiểu — in ra không kèm stack. */
class FatalError extends Error {}

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

// "Hôm nay" luôn theo giờ Việt Nam, không theo đồng hồ UTC hay múi giờ máy.
const TODAY = vnToday();

const args = parseArgs(process.argv.slice(2), { today: TODAY });
if (args.errors.length) fail(args.errors.join('\n  '));
const DRY_RUN = args.dryRun;
const DEBUG = args.debug;

let config;
try {
  config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
} catch (err) {
  fail(
    'Không đọc được config.json. Hãy chép config.example.json thành config.json ' +
    'rồi điền thông tin hai máy chấm công.\n  Chi tiết: ' + err.message
  );
}

const DAYS = args.days ?? Number(config.daysToSync || 7);
if (!Number.isInteger(DAYS) || DAYS < 1) fail('Số ngày đồng bộ không hợp lệ.');
if (!Array.isArray(config.devices) || !config.devices.length) fail('config.json chưa khai máy chấm công nào.');

const deviceName = d => String(d.name || d.ip || '').trim();
const DEVICE_NAMES = config.devices.map(deviceName);
if (DEVICE_NAMES.some(n => !n)) fail('Có máy trong config.json thiếu cả "name" lẫn "ip".');
// Tên máy là khoá của phần dữ liệu riêng từng máy (byDevice). Hai máy trùng tên
// thì phần của máy này đè phần của máy kia.
if (new Set(DEVICE_NAMES).size !== DEVICE_NAMES.length) fail('Hai máy trong config.json trùng "name". Mỗi máy cần một tên riêng.');

// Thiết bị treo (nhận kết nối rồi im lặng) mà không có hạn chờ thì script đứng
// mãi, Task Scheduler không chạy được lần sau vì lần trước chưa xong.
const DEVICE_TIMEOUT_MS = Number(config.deviceTimeoutMs) > 0 ? Number(config.deviceTimeoutMs) : 20_000;
// Endpoint gửi email có thể phải chờ Microsoft Graph (429) — cho rộng hơn.
const ALERT_TIMEOUT_MS = 90_000;

const ALERTS = args.sendAlerts ? readAlertsConfig(config.alerts) : null;

// firebase-admin sau khi nạp — giữ lại để đóng kết nối lúc kết thúc.
let firebaseAdmin = null;
// Giải phóng khoá "đang chạy" (xem lib/run-lock.mjs) lúc kết thúc.
let releaseLock = () => {};

// Nhật ký email đã gửi (meal_alerts) chưa ghi được thì dừng gửi — nhưng trước
// đó thử lại vài lần, phòng lỗi mạng thoáng qua.
const JOURNAL_ATTEMPTS = 3;

const RANGE_START = addDays(TODAY, -(DAYS - 1));
const RANGE_DATES = datesFromTo(RANGE_START, TODAY);


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
  // Hết hạn chờ do AbortSignal.timeout: không có mã kiểu ECONN..., phải nhận
  // theo tên lỗi.
  const name = err?.name || err?.cause?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `TIMEOUT — thiết bị không trả lời trong ${Math.round(DEVICE_TIMEOUT_MS / 1000)} giây`;
  }
  const code = err?.cause?.code || err?.code || '';
  const map = {
    ECONNREFUSED: 'thiết bị từ chối kết nối (cổng 80 đang đóng, hoặc thiết bị chỉ chạy HTTPS)',
    ETIMEDOUT: 'hết thời gian chờ (không định tuyến tới được, hoặc tường lửa chặn)',
    EHOSTUNREACH: 'không tới được địa chỉ này từ máy đang chạy script',
    ENOTFOUND: 'không phân giải được địa chỉ',
    ECONNRESET: 'thiết bị ngắt kết nối giữa chừng',
    UND_ERR_CONNECT_TIMEOUT: 'hết thời gian chờ kết nối',
  };
  if (code && typeof code === 'string') return `${code} — ${map[code] || 'lỗi kết nối'}`;
  const detail = err?.cause?.message || err?.message || '';
  return detail ? `${detail} (không rõ mã lỗi)` : 'lỗi kết nối không rõ nguyên nhân';
}

/**
 * Gọi một lần theo giao thức chỉ định. Trả về Response hoặc ném lỗi mạng.
 * Thiết bị trong LAN dùng chứng chỉ tự ký nên khi thử HTTPS phải tạm bỏ kiểm
 * tra chứng chỉ — chỉ bật trong lúc nói chuyện với thiết bị, tắt lại trước khi
 * kết nối Firebase hay endpoint gửi email để không làm yếu đường truyền ra
 * Internet.
 */
async function rawPost(base, device, uri, init) {
  if (base.protocol === 'https') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    // Mỗi lần gọi một hạn chờ riêng: lần thử lại phải được chờ trọn hạn, không
    // dùng chung đồng hồ với lần trước đã hết giờ.
    return await fetch(`${base.protocol}://${device.ip}:${base.port}${uri}`, {
      ...init,
      signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
    });
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
  try {
    return await res.json();
  } catch (err) {
    // Hạn chờ cũng áp cho lúc đọc thân phản hồi: máy gửi dở rồi treo sẽ rơi
    // vào đây chứ không treo cả script.
    throw new Error(`Thiết bị trả dữ liệu dở dang hoặc không đọc được — ${describeNetworkError(err)}`);
  }
}

// ------------------------------------------------------------ lấy sự kiện

/** Khoảng thời gian cần lấy: từ đầu ngày RANGE_START tới hết hôm nay (giờ VN). */
function timeRange() {
  const tz = config.timezoneOffset || '+07:00';
  return {
    startTime: `${RANGE_START}T00:00:00${tz}`,
    endTime: `${TODAY}T23:59:59${tz}`,
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
  if (DEBUG) log(`\n    [debug] ${deviceName(device)} chấp nhận kiểu yêu cầu: ${variant.label}`);

  let position = 0;
  let pending = first;
  let pages = 0;
  let finished = false;
  let stalled = false;
  /** @type {number | null} */
  let total = null;

  while (pages < MAX_PAGES) {
    let data;
    if (pending) {
      data = pending;
      pending = null;
    } else {
      // Nghỉ một nhịp giữa các trang: hỏi dồn dập là thiết bị rớt kết nối.
      await sleep(config.pageDelayMs ?? 250);
      data = await digestPost(device, ENDPOINT, buildBody(variant, range, position, searchID));
    }
    pages++;

    const page = readAcsPage(data);
    const list = page.list;

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
        device: deviceName(device),
      });
    }

    position += page.matched;
    if (page.total !== null) total = page.total;
    if (!page.more) { finished = true; break; }
    // Báo còn mà trang rỗng: hỏi tiếp cũng chỉ nhận lại đúng trang đó.
    if (page.matched === 0) { stalled = true; break; }
  }

  // Dừng vì chạm giới hạn số trang, hoặc lấy ít hơn số thiết bị báo: dữ liệu bị
  // cắt. Ném lỗi để máy này bị tính là LỖI — phần cũ của nó được giữ nguyên —
  // thay vì "thành công" với dữ liệu thiếu (sẽ thay phần cũ bằng rỗng).
  const problem = pagingProblem({ finished, stalled, position, total, pages });
  if (problem) throw new Error(problem);

  if (DEBUG && seenCodes.size) {
    log(`\n    [debug] Mã sự kiện thiết bị ${deviceName(device)} trả về:`);
    for (const [key, v] of seenCodes) {
      log(`      ${key}: ${v.count} lượt | ví dụ: employeeNoString=${v.sample.employeeNoString ?? '(trống)'} name=${v.sample.name ?? ''} verifyMode=${v.sample.currentVerifyMode ?? ''}`);
    }
  }

  return events;
}

// ------------------------------------------------------- Firestore tiện ích

// Firestore cho tối đa 500 thao tác một batch, và một lần commit không quá
// ~10 MB. Document checkins của một ngày có thể tới ~100 KB (cả trường, hai
// máy) nên ghi checkins theo lô nhỏ; document cá nhân thì nhỏ, lô lớn.
const BATCH_SMALL_DOCS = 400;
const BATCH_DAY_DOCS = 20;

async function commitAll(db, ops, size = BATCH_SMALL_DOCS) {
  for (const group of chunk(ops, size)) {
    const batch = db.batch();
    for (const op of group) {
      if (op.merge) batch.set(op.ref, op.data, { merge: true });
      else batch.set(op.ref, op.data);
    }
    await batch.commit();
  }
}

/** Tên tháng các ngày thuộc về, theo thứ tự. */
const monthsOf = dates => [...new Set(dates.map(d => d.slice(0, 7)))];

// ------------------------------------------------------------------- chạy

async function main() {
  const startedAt = new Date();
  log('');
  log(`  ĐỒNG BỘ LƯỢT CHẤM ĂN TỪ MÁY NHẬN DIỆN   (bản ${AGENT_VERSION})`);
  log('  ' + '─'.repeat(50));
  log(`  Lúc chạy   : ${formatVnDateTime(startedAt.toISOString())} (giờ Việt Nam)`);
  log(`  Khoảng lấy : ${RANGE_START} → ${TODAY} (${DAYS} ngày)`);
  log(`  Thiết bị   : ${DEVICE_NAMES.join(', ')}`);
  if (DRY_RUN) log('  Chế độ     : CHẠY THỬ, không ghi lên hệ thống, không gửi email');
  if (args.sendAlerts) {
    log(`  Cảnh báo   : ${args.alertsDate ? `xem thử cho ngày ${args.alertsDate}` : DRY_RUN ? 'xem thử cho hôm nay' : 'có chạy pha gửi email cảnh báo'}`);
  }
  log('');

  // ---------------------------------------------- 0. chỉ một lần chạy thật

  // Chạy thử không ghi, không gửi nên không cần khoá (và không phải chờ).
  if (!DRY_RUN) {
    const lock = await acquireLock({
      path: join(HERE, 'dong-bo.lock'),
      info: { pid: process.pid, token: randomBytes(8).toString('hex'), startedAt: startedAt.toISOString(), args: process.argv.slice(2).join(' ') },
      deps: {
        tryCreate: (p, text) => {
          try { writeFileSync(p, text, { flag: 'wx' }); return true; } catch (err) {
            if (err?.code === 'EEXIST') return false;
            throw err;
          }
        },
        read: p => {
          try { return { text: readFileSync(p, 'utf8'), mtimeMs: statSync(p).mtimeMs }; } catch (err) {
            if (err?.code === 'ENOENT') return null;
            throw err;
          }
        },
        remove: p => { try { unlinkSync(p); } catch (err) { if (err?.code !== 'ENOENT') throw err; } },
        now: () => Date.now(),
        isAlive: pid => {
          try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
        },
        sleep,
      },
      onWait: holder => log(
        `  Đang có một lần chạy khác${holder ? ` (PID ${holder.pid}, bắt đầu lúc ${formatVnDateTime(holder.startedAt) || '?'}, tham số: ${holder.args || '(không có)'})` : ''} — chờ nó xong (tối đa 10 phút)...`
      ),
    });
    if (!lock.ok) {
      throw new FatalError(
        'Vẫn đang có một lần chạy khác của agent sau 10 phút chờ — bỏ qua lần này để không ghi chồng và không gửi trùng email. ' +
        `Nếu chắc chắn không có lần chạy nào (vd. vừa tắt ngang), xoá file dong-bo.lock cạnh script.`
      );
    }
    releaseLock = lock.release;
  }

  // ---------------------------------------------- 1. hỏi từng thiết bị

  const range = timeRange();
  const allEvents = [];
  /** @type {import('./lib/sync-merge.mjs').DeviceResult[]} */
  const deviceResults = [];

  for (const device of config.devices) {
    const name = deviceName(device);
    process.stdout.write(`  • ${name} ... `);
    try {
      const evs = await fetchDeviceEvents(device, range);
      allEvents.push(...evs);
      deviceResults.push({ name, ok: true, at: new Date().toISOString(), events: evs.length, error: null });
      log(`${evs.length} lượt chấm`);
    } catch (err) {
      deviceResults.push({ name, ok: false, at: new Date().toISOString(), events: 0, error: String(err.message) });
      log('THẤT BẠI');
      for (const line of String(err.message).split('\n')) log(`      ${line}`);
      if (/dữ liệu bị cắt|quá nhiều sự kiện/.test(err.message)) {
        log('      Máy trả lời bình thường nhưng không lấy được trọn dữ liệu, nên lần này máy được tính là LỖI:');
        log('      lượt chấm cũ của máy giữ nguyên, không ngày nào bị chốt thiếu. Xem mục "Dữ liệu bị cắt" trong README.');
      } else if (/TIMEOUT/.test(err.message)) {
        // Xét trước "Không kết nối được": thông báo hết hạn chờ cũng mở đầu
        // bằng câu đó, nhưng cách xử lý khác hẳn.
        log('      Thiết bị nhận kết nối nhưng không trả lời. Thử khởi động lại máy nhận diện;');
        log('      xem mục "Máy báo TIMEOUT" trong README.');
      } else if (/Không kết nối được/.test(err.message)) {
        log('');
        log(`      Thử mở http://${device.ip} bằng trình duyệt TRÊN CHÍNH MÁY NÀY.`);
        log('      Nếu trình duyệt vào được mà script không vào được, khả năng cao thiết bị');
        log('      hoặc cổng web bị đổi. Xem mục "Máy báo ECONNREFUSED" trong README.');
      } else {
        log('      Kiểm tra: ISAPI đã bật chưa, tài khoản mật khẩu trong config.json.');
      }
    }
  }

  // Xong mọi việc với thiết bị. Từ đây trở đi chỉ nói chuyện ra Internet
  // (Firestore, endpoint gửi email) nên bảo đảm kiểm tra chứng chỉ đã bật lại.
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  // Mốc "kết thúc lần đồng bộ": coverage và việc chốt bữa ăn dựa vào mốc này.
  const runEndAt = new Date().toISOString();

  const { byDate: freshByDate, outside } = groupByDateDevice(allEvents, { from: RANGE_START, to: TODAY });
  if (outside && DEBUG) log(`\n    [debug] Bỏ ${outside} lượt chấm nằm ngoài khoảng ngày đã hỏi.`);

  const freshDates = Object.keys(freshByDate).sort();
  const okCount = deviceResults.filter(r => r.ok).length;

  log('');
  if (!okCount) {
    log('  Không máy nào trả được dữ liệu. Không thay đổi lượt chấm trên hệ thống.');
  } else {
    log(`  Tổng cộng  : ${allEvents.length} lượt chấm, ${freshDates.length} ngày có dữ liệu`);
    for (const d of freshDates) {
      const s = summarizePeople(unionPeople(Object.values(freshByDate[d])));
      log(`      ${d}: ${String(s.people).padStart(4)} người, ${String(s.taps).padStart(4)} lượt`);
    }
  }

  if (DRY_RUN && !args.sendAlerts) {
    log('\n  Chạy thử nên không ghi gì. Bỏ --dry-run để ghi thật.\n');
    return okCount === deviceResults.length ? 0 : 1;
  }

  // ---------------------------------------------- 2. kết nối Firestore

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(readFileSync(join(HERE, config.firebaseKeyFile || 'firebase-key.json'), 'utf8'));
  } catch (err) {
    throw new FatalError('Không đọc được file khóa Firebase. ' + err.message);
  }

  let admin;
  try {
    ({ default: admin } = await import('firebase-admin'));
  } catch (err) {
    throw new FatalError('Chưa cài thư viện firebase-admin. Mở Command Prompt tại thư mục agent rồi chạy: npm install\n  Chi tiết: ' + err.message);
  }
  firebaseAdmin = admin;
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();
  const DEL = admin.firestore.FieldValue.delete();

  const settingsRef = db.collection('settings').doc('checkinSync');
  const syncDoc = (await settingsRef.get()).data() || {};

  // Document checkins đang có của mọi ngày trong khoảng, đọc một lượt.
  /** @type {Record<string, any>} */
  const existingDocs = {};
  for (const group of chunk(RANGE_DATES, 100)) {
    const snaps = await db.getAll(...group.map(d => db.collection('checkins').doc(d)));
    for (const s of snaps) existingDocs[s.id] = s.exists ? s.data() : null;
  }

  // Máy trả 0 lượt cho cả khoảng mà hệ thống đã có lượt của nó: coi như lỗi.
  const suspects = findSuspectDevices({
    okDevices: deviceResults.filter(r => r.ok).map(r => r.name),
    freshByDate,
    existingDocs,
  });
  for (const s of suspects) {
    const r = deviceResults.find(x => x.name === s.name);
    r.ok = false;
    r.error = `Máy trả về 0 lượt chấm cho cả ${DAYS} ngày, trong khi hệ thống đã có lượt chấm của ${s.knownPeople} người ở máy này — ` +
      'nghi máy lệch giờ hoặc mất bộ nhớ. Giữ nguyên dữ liệu cũ của máy.';
    log('');
    log(`  CẢNH BÁO: ${s.name} — ${r.error}`);
    log('  Kiểm tra giờ (NTP) trên máy nhận diện.');
  }

  const okDevices = deviceResults.filter(r => r.ok).map(r => r.name);
  const failedDevices = deviceResults.filter(r => !r.ok).map(r => r.name);
  const complete = failedDevices.length === 0;

  // Mỗi máy chỉ "phủ" những ngày nằm giữa ngày sớm nhất và muộn nhất nó trả về
  // (xem deviceSpans). Ngày máy không phủ: giữ phần cũ của máy, không chốt dữ
  // liệu ngày đó. Máy lỗi không phủ ngày nào.
  const spans = deviceSpans(freshByDate, okDevices);
  const coveringOf = (/** @type {string} */ date) => okDevices.filter(d => coversDate(spans[d], date));
  /** Ngày mà MỌI máy trong config đều trả dữ liệu — chỉ những ngày này được chốt (coverage). */
  const coveredDates = RANGE_DATES.filter(date => DEVICE_NAMES.every(d => coversDate(spans[d], date)));
  for (const name of okDevices) {
    // Chỉ nhắc khi thiếu ngày thứ 2–6: cuối tuần không ai chấm là bình thường.
    const missed = RANGE_DATES.filter(d => isWeekday(d) && !coversDate(spans[name], d));
    if (!missed.length) continue;
    const span = spans[name];
    log('');
    log(span
      ? `  Lưu ý: ${name} chỉ trả lượt chấm từ ${span.from} tới ${span.to}; các ngày thứ 2–6 ${missed.join(', ')} không có dữ liệu từ máy này.`
      : `  Lưu ý: ${name} trả lời được nhưng không có lượt chấm nào trong khoảng đã hỏi (${missed.join(', ')}).`);
    log('        Giữ nguyên phần cũ của máy ở những ngày đó và chưa chốt dữ liệu những ngày đó. Nếu là ngày đi làm bình thường,');
    log('        kiểm tra giờ (NTP) và bộ nhớ sự kiện của máy.');
  }

  // ---------------------------------------------- 3. gộp checkins

  /** Dữ liệu từng ngày SAU lần chạy này (dùng cho bước tách cá nhân và cảnh báo). */
  /** @type {Record<string, any>} */
  const finalDocs = {};
  const dayWrites = [];
  for (const date of RANGE_DATES) {
    const merged = okDevices.length
      ? mergeDayDoc({
        date, existing: existingDocs[date], fresh: freshByDate[date] || {},
        okDevices, coveringDevices: coveringOf(date), configDevices: DEVICE_NAMES, syncedAt: runEndAt,
      })
      : null;
    finalDocs[date] = merged || existingDocs[date] || null;
    if (merged) dayWrites.push({ ref: db.collection('checkins').doc(date), data: merged });
  }

  log('');
  if (DRY_RUN) {
    log(`  Chạy thử: sẽ cập nhật ${dayWrites.length} ngày lượt chấm (không ghi).`);
  } else {
    await commitAll(db, dayWrites, BATCH_DAY_DOCS);
    log(`  Đã cập nhật ${dayWrites.length} ngày lượt chấm${complete ? '' : ` (giữ nguyên phần của máy lỗi: ${failedDevices.join(', ')})`}.`);
  }

  // ---------------------------------------------- 4. tách lượt chấm cá nhân

  // Tài khoản Firebase Auth đã tra: uid -> { email } (có tài khoản) | null (không có).
  /** @type {Map<string, { email: string } | null>} */
  const authCache = new Map();
  const lookupUsers = async (/** @type {string[]} */ uids) => {
    const need = [...new Set(uids)].filter(u => !authCache.has(u));
    for (const group of chunk(need, 100)) {
      const res = await admin.auth().getUsers(group.map(uid => ({ uid })));
      for (const u of res.users) authCache.set(u.uid, { email: u.email || '' });
      for (const uid of group) if (!authCache.has(uid)) authCache.set(uid, null);
    }
  };

  // Đơn đăng ký theo tháng: dùng cho cả bước tách cá nhân và pha cảnh báo.
  // Đơn hỏng (uid không dùng làm đường dẫn được, id không khớp) bị bỏ ở đây —
  // một đơn hỏng không được làm hỏng cả lần chạy (xem lib/registrations.mjs).
  const regCache = new Map();
  const registrationsOf = async month => {
    if (!regCache.has(month)) {
      const snap = await db.collection('registrations').where('month', '==', month).get();
      const { registrations, rejected } = cleanRegistrations({ docs: snap.docs.map(d => ({ id: d.id, data: d.data() })), month });
      if (rejected.length) {
        log(`  Bỏ qua ${rejected.length} đơn đăng ký tháng ${month} không hợp lệ (quản trị nên kiểm tra và xoá):`);
        for (const r of rejected.slice(0, 10)) log(`      - registrations/${String(r.id).slice(0, 80)}: ${r.why}`);
      }
      regCache.set(month, registrations);
    }
    return regCache.get(month);
  };

  // Đơn của tài khoản không tồn tại trong Firebase Auth không được tính: không
  // ai nhận được lượt chấm hay email của nó, mà để lại thì một đơn "ma" mang mã
  // NV của người khác làm người đó bị coi là trùng mã.
  const ghostLogged = new Set();
  const realRegistrationsOf = async (/** @type {string} */ month, { strict }) => {
    const regs = await registrationsOf(month);
    try {
      await lookupUsers(regs.map(r => r.uid));
    } catch (err) {
      // Pha cảnh báo (strict) phải dừng; bước tách cá nhân thì làm tiếp như
      // các bản trước (không lọc) thay vì bỏ cả bước.
      if (strict) throw err;
      log(`  Lưu ý: không tra được tài khoản Firebase Auth (${err.message}); bước tách cá nhân không lọc đơn của tài khoản đã xoá.`);
      return regs;
    }
    const { kept, ghosts } = dropGhosts(regs, uid => !!authCache.get(uid));
    if (ghosts.length && !ghostLogged.has(month)) {
      ghostLogged.add(month);
      log(`  Bỏ qua ${ghosts.length} đơn tháng ${month} của tài khoản không còn tồn tại.`);
    }
    return kept;
  };

  // Mã bộ phận loại trừ (Bếp Vina): không gán lượt chấm của các mã này cho ai
  // (xem buildOwnerIndex). Đọc một lần cho cả lần chạy.
  let excludedList = null;
  const excludedIdsList = async () => {
    if (!excludedList) {
      const snap = await db.collection('settings').doc('reconcileExcludes').get();
      const ids = snap.exists ? snap.get('employeeIds') : null;
      excludedList = Array.isArray(ids) ? ids.filter(v => typeof v === 'string') : [];
    }
    return excludedList;
  };

  if (DRY_RUN) {
    log('  Chạy thử: bỏ qua bước tách lượt chấm cá nhân.');
  } else if (!okDevices.length) {
    log('  Không có dữ liệu mới: bỏ qua bước tách lượt chấm cá nhân.');
  } else {
    for (const month of monthsOf(RANGE_DATES)) {
      const dates = RANGE_DATES.filter(d => d.startsWith(month));
      // Tháng không có ngày nào có lượt chấm trong khoảng này (vd. mấy ngày
      // cuối tháng trước toàn cuối tuần) thì không có gì để tách — bỏ qua cho
      // đỡ ~1.000 lượt đọc đơn đăng ký và hồ sơ.
      if (!dates.some(d => finalDocs[d])) continue;
      /** @type {Record<string, Map<string, string[]> | undefined>} */
      const peopleByDate = {};
      for (const d of dates) peopleByDate[d] = finalDocs[d] ? normalizePeople(finalDocs[d].people) : undefined;

      const index = buildOwnerIndex({ registrations: await realRegistrationsOf(month, { strict: false }), excludedIds: await excludedIdsList() });
      let { plans, unclaimed } = projectMonth({ dates, peopleByDate, index });

      // Đọc document cá nhân đang có để chỉ ghi người thay đổi: agent chạy
      // nhiều lần mỗi ngày, ghi lại cả trường mỗi lần sẽ ăn hết hạn mức ghi
      // miễn phí của Firestore.
      const tapRef = uid => db.collection('meal_taps').doc(uid).collection('months').doc(month);
      const existingTaps = new Map();
      for (const group of chunk([...plans.keys()], 100)) {
        const snaps = await db.getAll(...group.map(tapRef));
        for (const s of snaps) existingTaps.set(s.ref.parent.parent.id, s.exists ? s.data() : null);
      }

      // Tài khoản đổi cách gán mã (mới có mã, sửa mã, hết/bị trùng mã) phải
      // được tách lại CẢ THÁNG, không chỉ các ngày của lần chạy — nếu không,
      // các ngày đầu tháng giữ dữ liệu sai mãi (xem mappingChanged). Khi đó đọc
      // các ngày còn lại của tháng một lượt (≤ 31 lượt đọc). Tài khoản chưa có
      // document nào cũng tính là đổi, nên việc này diễn ra ở hầu hết các lần
      // chạy — chấp nhận được với hạn mức đọc 50.000/ngày của gói Spark.
      const changed = new Set([...plans].filter(([uid, plan]) => mappingChanged(existingTaps.get(uid), plan)).map(([uid]) => uid));
      let fullDates = dates;
      if (changed.size) {
        fullDates = monthDates(month, TODAY);
        const snap = await db.collection('checkins').where('month', '==', month).get();
        for (const s of snap.docs) {
          // Ngày trong lần chạy đã có bản SAU khi gộp ở finalDocs.
          if (dates.includes(s.id) || !ISO_DATE_RE.test(s.id) || !fullDates.includes(s.id)) continue;
          peopleByDate[s.id] = normalizePeople(s.get('people'));
        }
        ({ plans, unclaimed } = projectMonth({ dates: fullDates, peopleByDate, index }));
      }

      const updatedAt = new Date().toISOString();
      const tapWrites = [];
      let conflicted = 0;
      for (const [uid, plan] of plans) {
        if (plan.conflict) conflicted++;
        const data = diffTapDoc({
          uid, month, existing: existingTaps.get(uid), plan,
          dates: changed.has(uid) ? fullDates : dates,
          updatedAt, del: DEL,
        });
        if (data) tapWrites.push({ ref: tapRef(uid), data, merge: true });
      }
      await commitAll(db, tapWrites);

      log(
        `  Lượt chấm cá nhân tháng ${month}: ${tapWrites.length} người cập nhật, ${plans.size - tapWrites.length} không đổi` +
        (conflicted ? `, ${conflicted} tài khoản trùng mã NV` : '') +
        (unclaimed.size ? `, ${unclaimed.size} mã có lượt chấm chưa gắn tài khoản nào` : '') + '.'
      );
    }
  }

  // ---------------------------------------------- 5. trạng thái đồng bộ

  // Ghi SAU checkins và meal_taps: coverage là lời khẳng định "dữ liệu đã đủ";
  // ghi trước thì trang cá nhân có thể báo "chưa chấm" trong lúc lượt chấm của
  // người đó chưa kịp tách ra.
  if (!DRY_RUN) {
    await settingsRef.set(buildSyncSettings({
      agentVersion: AGENT_VERSION,
      runEndAt,
      complete,
      existing: syncDoc,
      deviceResults,
      configDevices: DEVICE_NAMES,
      coveredDates,
      today: TODAY,
      del: DEL,
    }), { merge: true });
    const uncovered = RANGE_DATES.filter(d => isWeekday(d) && !coveredDates.includes(d));
    log(`  Đã ghi trạng thái đồng bộ (${complete ? 'đủ mọi máy' : `THIẾU máy: ${failedDevices.join(', ')}`}` +
      (complete && uncovered.length ? `; chưa chốt các ngày ${uncovered.join(', ')} vì có máy không trả dữ liệu ngày đó` : '') + ').');
  }

  let code = complete ? 0 : 1;

  // ---------------------------------------------- 6. cảnh báo

  // Đặt cuối cùng: mọi request tới thiết bị đã xong, không còn lúc nào tạm tắt
  // kiểm tra chứng chỉ trong khi gửi khoá bí mật ra Internet.
  if (args.sendAlerts) {
    let alertCode = 0;
    try {
      alertCode = await runAlerts({
        db, DEL, settingsRef, syncDoc, finalDocs, runEndAt, coveredDates, failedDevices, deviceResults,
        idleDevicesOn: date => okDevices.filter(d => !coversDate(spans[d], date)),
        realRegistrationsOf, lookupUsers, authCache,
      });
    } catch (err) {
      alertCode = 2;
      const message = redact(err.message, ALERTS?.cfg.secret);
      log(`\n  LỖI ở pha cảnh báo: ${message}`);
      if (!DRY_RUN) {
        try {
          const date = TODAY;
          const prev = syncDoc.alerts?.[date];
          if (prev?.status !== 'sent' && prev?.status !== 'guarded') {
            await settingsRef.set({ alerts: { [date]: alertEntry('error', new Date().toISOString(), {
              sent: prev?.sent ?? 0,
              reason: `Pha cảnh báo gặp lỗi: ${message}. Sẽ thử lại ở lần chạy sau.`,
            }) } }, { merge: true });
          }
        } catch { /* đã in lỗi ở trên; không để lỗi phụ che lỗi chính */ }
      }
    }
    if (code === 0) code = alertCode;
  }

  if (!DRY_RUN) {
    log(`\n  XONG${complete ? '' : ' (CÓ MÁY LỖI — xem phía trên)'}. Mở trang Quản trị → tab Đối soát chấm ăn để xem.\n`);
  } else {
    log('\n  Chạy thử xong: không ghi gì, không gửi email nào.\n');
  }
  return code;
}

// ------------------------------------------------------------- pha cảnh báo

/**
 * Gửi một request tới endpoint /api/meal-alerts. Ném lỗi nếu không phải 200.
 * Không bao giờ in khoá bí mật — kể cả trong thông báo lỗi.
 */
async function postAlerts(cfg, body) {
  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err?.name || err?.cause?.name || '';
    // TypeError ném ra TRƯỚC khi gửi (header hoặc địa chỉ không hợp lệ): thông
    // báo gốc có thể chép nguyên "Bearer <khoá>" — không bao giờ dùng nó.
    const why = name === 'TimeoutError'
      ? `không trả lời trong ${ALERT_TIMEOUT_MS / 1000} giây`
      : err instanceof TypeError && !err.cause
        ? 'không tạo được yêu cầu gửi (kiểm tra alerts.endpoint và alerts.secret trong config.json)'
        : (err?.cause?.code || err?.cause?.message || err?.message || 'lỗi kết nối');
    let host = 'endpoint';
    try { host = new URL(cfg.endpoint).host; } catch { /* đã báo ở bước kiểm tra cấu hình */ }
    throw new Error(redact(`Không gọi được ${host} — ${why}`, cfg.secret));
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* thân không phải JSON */ }
  if (!res.ok) {
    const msg = String(data?.error || data?.message || text).replace(/\s+/g, ' ').slice(0, 200);
    const hint = res.status === 401 ? ' — alerts.secret không khớp biến MEAL_ALERT_SECRET trên Vercel'
      : res.status === 500 && /MEAL_ALERT_SECRET/.test(msg) ? ' — đặt biến này trên Vercel (ít nhất 32 ký tự) rồi Redeploy'
      : res.status === 404 ? ' — sai alerts.endpoint, hoặc bản web chưa có /api/meal-alerts'
      : '';
    throw new Error(redact(`Endpoint trả HTTP ${res.status}${msg ? `: ${msg}` : ''}${hint}`, cfg.secret));
  }
  return data;
}

/** Ghi một lô vào Firestore, thử lại khi lỗi (lỗi mạng thoáng qua). */
async function commitWithRetry(db, ops) {
  let lastErr;
  for (let i = 0; i < JOURNAL_ATTEMPTS; i++) {
    try {
      await commitAll(db, ops);
      return;
    } catch (err) {
      lastErr = err;
      if (i < JOURNAL_ATTEMPTS - 1) await sleep(1000 * (i + 1) * 2);
    }
  }
  throw lastErr;
}

/** Số ngày trước ngày xét được đọc để biết từng máy "thường" có bao nhiêu người chấm mỗi bữa. */
const GAP_HISTORY_DAYS = 10;

async function runAlerts({
  db, DEL, settingsRef, syncDoc, finalDocs, runEndAt, coveredDates, failedDevices, deviceResults,
  idleDevicesOn, realRegistrationsOf, lookupUsers, authCache,
}) {
  const { cfg, secretOk, secretProblem, errors, warnings } = ALERTS;
  log('');
  log('  CẢNH BÁO "ĐĂNG KÝ MÀ KHÔNG CHẤM ĂN"');
  log('  ' + '─'.repeat(50));
  for (const w of warnings) log(`  Lưu ý: ${w}`);

  // Bước 1: chỉ chạy khi được bật. Xem thử thì vẫn cho chạy để kiểm tra trước
  // khi bật — không gửi gì cả.
  if (!cfg.enabled) {
    if (!DRY_RUN) {
      log('  alerts.enabled đang tắt trong config.json — bỏ qua, không gửi gì.');
      return 0;
    }
    log('  (alerts.enabled đang tắt: lần chạy thật sẽ bỏ qua pha này. Chạy thử vẫn tính để Thầy/Cô xem.)');
  }

  const configProblems = [...errors, ...(secretOk ? [] : [secretProblem])];
  if (configProblems.length) {
    for (const p of configProblems) log(`  ${DRY_RUN ? 'Lưu ý' : 'LỖI'}: ${p}`);
  }

  const date = args.alertsDate || TODAY;
  const now = new Date();
  const nowVn = vnParts(now);

  const offSnap = await db.collection('settings').doc('mealOffDays').get();
  const offDays = Array.isArray(offSnap.data()?.dates) ? offSnap.data().dates : [];
  const existing = syncDoc.alerts?.[date] || null;

  // Mốc chốt dữ liệu: lần chạy này nếu MỌI máy đều trả dữ liệu cho ngày đó.
  // Xem thử một ngày cũ ngoài khoảng vừa lấy thì dựa vào coverage đã ghi từ
  // trước.
  const coverageAt = coveredDates.includes(date)
    ? runEndAt
    : (args.alertsDate ? (syncDoc.coverage?.[date] ?? null) : null);
  // Máy trả lời được mà không có lượt chấm nào của ngày đó (chỉ biết được với
  // ngày trong khoảng vừa lấy).
  const idleDevices = RANGE_DATES.includes(date) ? idleDevicesOn(date) : [];

  const writeStatus = async entry => {
    if (DRY_RUN) return;
    /** @type {Record<string, unknown>} */
    const alerts = { [date]: entry };
    for (const k of pruneDateKeys(syncDoc.alerts, TODAY)) if (k !== date) alerts[k] = DEL;
    await settingsRef.set({ alerts }, { merge: true });
  };

  // Bước 2–5. Cấu hình sai được chặn ngay sau bước "ngày nghỉ", trước kiểm tra
  // giờ (xem alertGate). Chạy thử thì cho đi tiếp dù chưa điền khoá — để xem
  // trước danh sách khi còn đang chuẩn bị.
  const gate = alertGate({
    date, now, nowVn, offDays,
    notBefore: cfg.notBefore,
    coverageAt,
    failedDevices,
    idleDevices,
    configProblems: DRY_RUN ? [] : configProblems,
    existing,
    ignoreTime: !!args.alertsDate,
  });
  if (gate.write) await writeStatus(gate.write);
  // Máy trả lời được mà không có lượt chấm nào trong ngày: không gửi cho CBNV,
  // nhưng vẫn tính số liệu để đi đường chốt an toàn (báo quản trị) ở bước 10.
  const forcedStop = gate.code === 'device_idle' ? gate.message : null;
  if (!gate.proceed && !forcedStop) {
    log(`  ${gate.message}`);
    // Cấu hình sai: mã 2 để Task Scheduler hiện "Last Run Result" khác 0.
    if (gate.code === 'bad_config') return 2;
    if (!(DRY_RUN && gate.code === 'already_sent')) return 0;
    log('  (Chạy thử: vẫn tính danh sách để Thầy/Cô xem.)');
  }
  // Số liệu cho email báo quản trị khi máy không có dữ liệu: tính như thể lần
  // đồng bộ này đã chốt — chỉ để quản trị thấy quy mô, không dùng để gửi ai.
  const planCoverageAt = forcedStop ? runEndAt : coverageAt;

  // Bước 6: đọc dữ liệu. Đơn của tài khoản không tồn tại bị bỏ (xem
  // lib/registrations.mjs) — tra Auth lỗi thì dừng pha này, lần sau thử lại.
  const registrations = await realRegistrationsOf(date.slice(0, 7), { strict: true });
  const cancelations = (await db.collection('cancel_registrations').where('cancelDate', '==', date).get()).docs.map(d => d.data());
  const excludedIds = (await db.collection('settings').doc('reconcileExcludes').get()).data()?.employeeIds || [];
  const sentSnap = await db.collection('meal_alerts').where('date', '==', date).get();
  const alreadySent = new Set(sentSnap.docs.map(d => d.get('uid')).filter(Boolean));

  // Bước 7: lượt chấm của ngày SAU khi gộp lần này
  let dayDoc;
  if (RANGE_DATES.includes(date)) {
    dayDoc = finalDocs[date] || null;
  } else {
    const s = await db.collection('checkins').doc(date).get();
    dayDoc = s.exists ? s.data() : null;
  }
  const people = dayDoc?.people ?? null;

  // Bước 8–9
  const plan = planAlerts({
    date,
    registrations,
    cancelations,
    excludedIds: Array.isArray(excludedIds) ? excludedIds : [],
    offDays,
    people,
    coverageAt: planCoverageAt,
    now,
  });
  const { stats } = plan;

  log(`  Ngày       : ${dateLabelOf(date)}`);
  log(`  Dữ liệu chốt lúc: ${coverageAt ? formatVnDateTime(coverageAt) : forcedStop ? 'CHƯA CHỐT — có máy không trả dữ liệu ngày này (số liệu dưới đây chỉ để báo quản trị)' : 'CHƯA CÓ lần đồng bộ đủ máy — mọi bữa đang "chưa có dữ liệu", không ai bị coi là chưa chấm'}`);
  for (const m of MEALS) {
    log(`  ${MEAL_LABEL[m].padEnd(9)}: ${stats.expected[m]} người đáng lẽ ăn, ${stats.missing[m]} người chưa có lượt chấm`);
  }
  log(`  Có lượt chấm trong khung giờ ăn: ${plan.tappers} người`);
  if (plan.skipped.unusable.length) log(`  Bỏ qua ${plan.skipped.unusable.length} đơn thiếu mã NV (không đối soát được).`);
  if (plan.skipped.excluded.length) log(`  Bỏ qua ${plan.skipped.excluded.length} đơn thuộc danh sách loại trừ.`);
  if (plan.skipped.duplicate.length) {
    log(`  Bỏ qua ${plan.skipped.duplicate.length} mã NV trùng giữa nhiều đơn: ${plan.skipped.duplicate.join(', ')} — quản trị cần sửa tay.`);
  }

  // Bước 10a: từng máy có lượt chấm của mọi bữa đã chốt không — so với chính
  // máy đó những ngày gần đây (máy của bếp không phục vụ bữa sáng thì 0 lượt
  // bữa sáng là bình thường). Chỉ cần khi đã có người chấm; không ai chấm thì
  // chốt an toàn dừng luôn ở bước sau.
  let deviceGaps = [];
  const finalMeals = MEALS.filter(m => isMealFinal(date, m, coverageAt, now));
  if (!forcedStop && plan.tappers > 0 && finalMeals.length) {
    const historyDates = datesFromTo(addDays(date, -GAP_HISTORY_DAYS), addDays(date, -1));
    const toRead = historyDates.filter(d => !(d in finalDocs));
    /** @type {Record<string, any>} */
    const historyDocs = {};
    for (const d of historyDates) if (d in finalDocs) historyDocs[d] = finalDocs[d];
    if (toRead.length) {
      const snaps = await db.getAll(...toRead.map(d => db.collection('checkins').doc(d)));
      for (const s of snaps) historyDocs[s.id] = s.exists ? s.data() : null;
    }
    const gapCheck = deviceMealGaps({
      date,
      devices: DEVICE_NAMES,
      dayParts: dayDoc?.byDevice,
      history: historyDates.map(d => ({ date: d, byDevice: historyDocs[d]?.byDevice })),
      offDays,
      meals: finalMeals,
    });
    if (gapCheck.unknown) log('  Lưu ý: dữ liệu ngày này ở dạng cũ (không tách theo máy) nên không kiểm tra được từng máy.');
    deviceGaps = gapCheck.gaps;
  }

  // Bước 10: chốt an toàn
  const guard = forcedStop
    ? { stop: true, reason: forcedStop }
    : guardVerdict({ stats, tappers: plan.tappers, minExpected: cfg.minExpected, maxMissingRatio: cfg.maxMissingRatio, deviceGaps });
  if (guard.stop) {
    log('');
    log(`  CHỐT AN TOÀN — DỪNG, không gửi email cho CBNV: ${guard.reason}`);
    const noticeNeeded = existing?.status !== 'guarded';
    if (DRY_RUN) {
      log(noticeNeeded
        ? `  Lần chạy thật sẽ báo quản trị: ${cfg.adminEmails.join(', ') || '(chưa khai adminEmails)'}`
        : '  Hôm nay đã báo quản trị rồi, lần chạy thật sẽ không báo lại.');
      return 0;
    }
    const at = new Date().toISOString();
    let entry = alertEntry('guarded', at, { stats, sent: alreadySent.size, reason: guard.reason, held: true });
    let code = 0;
    if (noticeNeeded && cfg.adminEmails.length) {
      try {
        const notice = buildAdminNotice({
          date, adminEmails: cfg.adminEmails, reason: guard.reason, stats, tappers: plan.tappers,
          devices: deviceResults, agentVersion: AGENT_VERSION,
        });
        const res = await postAlerts(cfg, notice);
        const results = Array.isArray(res?.results) ? res.results : [];
        if (!results.some(r => r?.ok === true)) {
          throw new Error(results.map(r => r?.error).filter(Boolean)[0] || 'endpoint báo không gửi được');
        }
        // Máy chủ chỉ gửi tới địa chỉ có trong MEAL_ALERT_ADMINS trên Vercel; địa
        // chỉ ngoài danh sách bị từ chối riêng lẻ. Liệt kê từng địa chỉ để người
        // xem log biết ai thực sự đã nhận, thay vì in cả danh sách như đã gửi hết.
        const delivered = results.filter(r => r?.ok === true).map(r => r.to);
        log(`  Đã gửi email báo quản trị: ${delivered.join(', ')}`);
        for (const r of results) {
          if (r?.ok !== true) log(`  Không gửi được tới ${r?.to || '(không rõ)'}: ${redact(String(r?.error || 'lỗi không rõ'), cfg.secret)}`);
        }
      } catch (err) {
        // Chưa báo được thì để 'error' (không phải 'guarded') để lần sau thử
        // báo lại — 'guarded' nghĩa là quản trị ĐÃ được báo.
        const message = redact(err.message, cfg.secret);
        entry = alertEntry('error', at, {
          stats,
          sent: alreadySent.size,
          reason: `${guard.reason} Gửi email báo quản trị thất bại: ${message}. Sẽ thử lại ở lần chạy sau.`,
          held: true,
        });
        log(`  LỖI: không gửi được email báo quản trị — ${message}`);
        code = 2;
      }
    } else if (noticeNeeded) {
      log('  Chưa khai alerts.adminEmails nên không báo được cho ai.');
    } else {
      log('  Hôm nay đã báo quản trị rồi, không báo lại.');
    }
    await writeStatus(entry);
    return code;
  }

  // Bước 11: người nhận — email lấy từ Firebase Auth (đã tra cùng lúc lọc đơn
  // ở bước 6; tra lại phần còn thiếu nếu có).
  await lookupUsers(uidsToLookup(plan.candidates, alreadySent));
  const emails = new Map(plan.candidates.map(c => [c.uid, authCache.get(c.uid)?.email]));
  const { recipients, skipped } = selectRecipients({ candidates: plan.candidates, alreadySent, emails });

  log('');
  log(`  Cần cảnh báo: ${plan.candidates.length} người — đã gửi trước đó ${skipped.alreadySent.length}, sẽ gửi ${recipients.length}`);
  const unreachable = skipped.noEmail.length + skipped.outsideDomain.length;
  if (unreachable) log(`  Không gửi được cho ${unreachable} người: tài khoản không có email @hoangmaistarschool.edu.vn.`);
  if (skipped.duplicateEmail.length) log(`  Bỏ ${skipped.duplicateEmail.length} người dùng chung địa chỉ email với người khác trong danh sách (chỉ gửi một lần).`);

  if (DRY_RUN) {
    if (recipients.length) {
      log('');
      log('  Danh sách sẽ nhận email (chạy thử, KHÔNG gửi):');
      for (const r of recipients) {
        const meals = r.meals.map(m => MEAL_LABEL[m]).join(' + ');
        const extra = r.outOfWindow.length ? ` | chấm ngoài khung: ${r.outOfWindow.join(', ')}` : '';
        log(`    - ${r.fullName || '(không tên)'} (Mã NV ${r.employeeId}) <${r.to}>: ${meals}${extra}`);
      }
    }
    log(`  Kết luận: lần chạy thật sẽ ghi trạng thái "${finalAlertStatus({ missingCount: plan.candidates.length, failed: 0 })}".`);
    return 0;
  }

  // Bước 12: gửi
  let sentNow = 0;
  let failed = 0;
  const errorsSeen = [];
  /** Lỗi ghi nhật ký meal_alerts (null = chưa lỗi). */
  let journalError = null;
  for (const { group, body } of buildStaffBodies({ date, recipients })) {
    if (journalError) {
      // Không ghi được nhật ký thì KHÔNG gửi thêm: email đã gửi mà không được
      // ghi nhớ sẽ bị gửi lại ở mỗi lần lặp 15 phút sau đó. Dừng ở đây thì chỉ
      // lô vừa rồi có thể bị gửi trùng; người còn lại chờ lần chạy sau.
      failed += group.length;
      continue;
    }
    let results;
    try {
      results = matchResults(group, await postAlerts(cfg, body));
    } catch (err) {
      results = group.map(() => ({ ok: false, error: redact(err.message, cfg.secret) }));
    }
    const okOnes = group.filter((_, i) => results[i].ok);
    if (okOnes.length) {
      // Ghi nhật ký ngay sau mỗi lô: lô sau có hỏng giữa chừng thì những người
      // đã nhận email vẫn được nhớ, lần chạy sau không gửi trùng.
      const sentAt = new Date().toISOString();
      try {
        await commitWithRetry(db, okOnes.map(r => ({
          ref: db.collection('meal_alerts').doc(`${date}_${r.uid}`),
          data: { uid: r.uid, date, to: r.to, employeeId: r.employeeId, meals: r.meals, sentAt },
        })));
      } catch (err) {
        journalError = String(err?.message || err);
        log(`  LỖI: đã gửi ${okOnes.length} email nhưng không ghi được nhật ký — DỪNG gửi tiếp; lần sau những người này có thể nhận trùng. ${journalError}`);
      }
    }
    sentNow += okOnes.length;
    failed += group.length - okOnes.length;
    for (const r of results) {
      if (!r.ok && r.error && errorsSeen.length < 3 && !errorsSeen.includes(r.error)) errorsSeen.push(r.error);
    }
  }
  if (journalError) errorsSeen.unshift('không ghi được nhật ký meal_alerts, đã dừng gửi');

  const status = finalAlertStatus({ missingCount: plan.candidates.length, failed });
  const notes = [];
  if (failed) notes.push(`${failed} email chưa gửi được (${errorsSeen.join('; ')}). Lần chạy sau sẽ gửi nốt.`);
  if (journalError) notes.push(`Lỗi ghi nhật ký: ${journalError}.`);
  if (unreachable) notes.push(`${unreachable} người không có email của trường trong tài khoản, không gửi được.`);
  if (plan.skipped.duplicate.length) notes.push(`${plan.skipped.duplicate.length} mã NV trùng giữa nhiều đơn, bỏ qua.`);

  await writeStatus(alertEntry(status, new Date().toISOString(), {
    sent: alreadySent.size + sentNow,
    failed,
    stats,
    reason: notes.join(' ') || null,
  }));

  log(`  Đã gửi ${sentNow} email${failed ? `, ${failed} lỗi: ${errorsSeen.join('; ')}` : ''}. Trạng thái: ${status}.`);
  return failed ? 2 : 0;
}

// --------------------------------------------------------------------------

// Lưới cuối cho khoá "đang chạy": tiến trình thoát kiểu gì (kể cả bị ép thoát
// bên dưới) cũng xoá khoá của mình, lần chạy sau không phải chờ.
process.on('exit', () => releaseLock());

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  const text = err instanceof FatalError ? err.message : (err?.stack || String(err));
  console.error(`\n  LỖI: ${redact(text, ALERTS?.cfg.secret)}\n`);
  exitCode = 1;
}
releaseLock();

// Mã thoát cho Task Scheduler: 0 = ổn, 1 = có máy lỗi (hoặc lỗi chung),
// 2 = đồng bộ ổn nhưng pha cảnh báo lỗi.
//
// KHÔNG gọi process.exit() ngay: trên Windows (đã thấy với Node 24), gọi
// process.exit() khi fetch vừa đóng kết nối thì tiến trình đổ vỡ vì một lỗi
// của libuv (mã 0xC0000409) và mất mã thoát thật. Đặt exitCode, đóng
// firebase-admin (nó giữ kết nối gRPC mở), rồi để tiến trình tự kết thúc.
process.exitCode = exitCode;
// Lưới an toàn: còn thứ gì giữ tiến trình sống sau 20 giây thì thoát cưỡng bức.
// Treo mãi thì Task Scheduler (đặt "Do not start a new instance") sẽ bỏ qua
// mọi lần chạy sau. Phải hẹn TRƯỚC khi đóng firebase-admin: chính bước đóng
// (dừng gRPC của Firestore) là chỗ dễ treo nhất — hẹn sau thì treo ở đó là
// không bao giờ tới được dòng hẹn giờ. Hẹn giờ unref nên không tự giữ tiến trình.
setTimeout(() => process.exit(exitCode), 20_000).unref();
try {
  await Promise.all((firebaseAdmin?.apps || []).map(app => app?.delete()));
} catch { /* đang thoát; lỗi khi đóng kết nối không còn quan trọng */ }
