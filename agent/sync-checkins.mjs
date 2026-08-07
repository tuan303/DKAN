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
import admin from 'firebase-admin';

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

async function digestPost(device, uri, payload) {
  const url = `http://${device.ip}${uri}`;
  const body = JSON.stringify(payload);
  const init = { method: 'POST', body, headers: { 'Content-Type': 'application/json' } };

  let res = await fetch(url, init);
  if (res.status === 401) {
    const wwwAuth = res.headers.get('www-authenticate') || '';
    if (!/digest/i.test(wwwAuth)) throw new Error(`Thiết bị không dùng Digest: ${wwwAuth}`);
    const auth = buildDigestHeader(wwwAuth, {
      username: device.username, password: device.password, method: 'POST', uri, body,
    });
    res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: auth } });
  }

  if (res.status === 401) throw new Error('Sai tài khoản hoặc mật khẩu thiết bị.');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
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

async function fetchDeviceEvents(device, range) {
  const events = [];
  const seenCodes = new Map();
  let position = 0;
  const PAGE = 100;

  for (let guard = 0; guard < 1000; guard++) {
    const data = await digestPost(device, '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: {
        searchID: `dkan-${Date.now()}-${position}`,
        searchResultPosition: position,
        maxResults: PAGE,
        major: 5, // 5 = sự kiện kiểm soát ra vào
        ...range,
      },
    });

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
log('  ĐỒNG BỘ LƯỢT CHẤM ĂN TỪ MÁY NHẬN DIỆN');
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
    log(`      ${err.message}`);
    log('      Kiểm tra: IP đúng chưa, ISAPI đã bật chưa, tài khoản/mật khẩu trong config.json.');
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
