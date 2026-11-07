// Chạy sync-checkins.mjs THẬT (bản chép tạm trong os.tmpdir()) với:
//   - Firestore/Auth giả trong bộ nhớ (fake-firebase-admin.mjs, nạp qua
//     node_modules/firebase-admin của bản chép — không bao giờ gọi Firebase);
//   - hai máy nhận diện giả (ISAPI AcsEvent) và API email giả (/api/meal-alerts)
//     chạy trên 127.0.0.1, cổng ngẫu nhiên;
//   - đồng hồ bắt đầu ở giờ test chọn (freeze-clock.mjs).
// Chỉ chép mã của agent (sync-checkins.mjs, lib/): không đọc config.json,
// firebase-key.json hay .env thật — config.json của bản chép do file này viết.
// Dùng cho alert-wiring.test.mjs. File này chỉ export, nạp vào không làm gì
// (`npm test` trong thư mục agent sẽ chạy nó như một file test, hiện một dòng "pass").
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const FAKE_ADMIN_URL = new URL('./fake-firebase-admin.mjs', import.meta.url).href;
const FREEZE_CLOCK_URL = new URL('./freeze-clock.mjs', import.meta.url).href;

export const DEVICES = Object.freeze(['CA_TrH', 'CA_TIH']);
export const ADMIN_EMAIL = 'quan-tri.test@hoangmaistarschool.edu.vn';
/** Lịch chạy của task "DKAN 2 - Canh bao 13h45" trong Task Scheduler. */
export const TASK_ARGS = Object.freeze(['--quiet', '--days', '1', '--send-alerts']);

export const email = uid => `${uid.toLowerCase()}@hoangmaistarschool.edu.vn`;
/** Giờ chấm như máy Hikvision trả về (giờ địa phương kèm múi giờ). */
export const vnIso = (date, hhmm) => `${date}T${hhmm}:00+07:00`;
/** Mốc ISO (UTC) của một giờ Việt Nam. */
export const utc = (date, hhmm) => new Date(vnIso(date, hhmm)).toISOString();

/** Đơn đăng ký tháng `registrations/{uid}_{month}` như trang đăng ký ghi. */
export const registration = (uid, employeeId, month, more = {}) => ({
  userId: uid, month, employeeId, fullName: `Người ${uid}`, email: email(uid), breakfastCount: 20, lunchCount: 20,
  firstMealDate: `${month}-01`, timestamp: `${month}-01T01:00:00.000Z`, ...more,
});

/**
 * Document `checkins/{date}` như agent ghi, từ lượt chấm theo máy:
 * { CA_TrH: { '100001': ['07:05', '11:35'] }, CA_TIH: {...} }.
 */
export function checkinsDoc(date, tapsByDevice, syncedAt = utc(date, '22:00')) {
  const byDevice = {};
  const people = {};
  for (const [device, codes] of Object.entries(tapsByDevice)) {
    byDevice[device] = {};
    for (const [code, times] of Object.entries(codes)) {
      byDevice[device][code] = { name: '', times: [...times].sort() };
      people[code] = { name: '', times: [...new Set([...(people[code]?.times || []), ...times])].sort() };
    }
  }
  return { date, month: date.slice(0, 7), people, byDevice, complete: true, source: 'hikvision-agent', syncedAt };
}

// ----------------------------------------------------------- API email giả

const MEAL_WINDOWS = { breakfast: ['05:00', '08:00'], lunch: ['10:00', '13:30'] };
const EXTRA_REASONS = new Set(['no_registration', 'meal_not_registered', 'before_start', 'registered_late', 'canceled']);
const SCHOOL_EMAIL_RE = /^[^@\s]+@hoangmaistarschool\.edu\.vn$/i;
// Bản cũ (trước 2026-11-06.1) chưa biết 'staff-extra' — câu báo lỗi đúng như bản đó trả.
const API_KINDS = {
  new: { kinds: ['staff-missing', 'staff-extra', 'admin-notice'], error: "kind phải là 'staff-missing', 'staff-extra', 'admin-notice' hoặc 'survey-invite'." },
  old: { kinds: ['staff-missing', 'admin-notice'], error: "kind phải là 'staff-missing', 'admin-notice' hoặc 'survey-invite'." },
};

/** Những kiểm tra chính của api/meal-alerts.ts (parseRequest): trả câu lỗi 400, hoặc null nếu hợp lệ. */
function requestProblem(body, api) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Nội dung yêu cầu phải là một JSON object.';
  if (!API_KINDS[api].kinds.includes(body.kind)) return API_KINDS[api].error;
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return 'date phải có dạng YYYY-MM-DD.';
  if (typeof body.dateLabel !== 'string' || !body.dateLabel.trim()) return 'dateLabel không được để trống.';
  let emails;
  if (body.kind === 'admin-notice') {
    if (!Array.isArray(body.to) || body.to.length < 1 || body.to.length > 5) return 'to phải có từ 1 đến 5 phần tử.';
    if (typeof body.reason !== 'string' || !body.reason.trim()) return 'reason không được để trống.';
    emails = body.to;
  } else {
    if (!Array.isArray(body.alerts)) return 'alerts phải là mảng.';
    if (body.alerts.length < 1 || body.alerts.length > 20) return 'alerts phải có từ 1 đến 20 phần tử.';
    for (const [i, a] of body.alerts.entries()) {
      if (!Array.isArray(a?.meals) || a.meals.length < 1 || a.meals.length > 2) return `alerts[${i}].meals phải có từ 1 đến 2 phần tử.`;
      for (const [j, m] of a.meals.entries()) {
        const w = MEAL_WINDOWS[m?.meal];
        if (!w) return `alerts[${i}].meals[${j}].meal phải là 'breakfast' hoặc 'lunch'.`;
        if (m.window !== `${w[0]}\u2013${w[1]}`) return `alerts[${i}].meals[${j}].window phải có dạng HH:MM–HH:MM.`;
        if (body.kind !== 'staff-extra') continue;
        if (!EXTRA_REASONS.has(m.reason)) return `alerts[${i}].meals[${j}].reason không hợp lệ.`;
        if (typeof m.time !== 'string' || !/^\d{2}:\d{2}$/.test(m.time) || m.time < w[0] || m.time > w[1]) {
          return `alerts[${i}].meals[${j}].time hoặc window nằm ngoài khung giờ ăn.`;
        }
      }
    }
    emails = body.alerts.map(a => a.to);
  }
  for (const [i, e] of emails.entries()) {
    if (typeof e !== 'string' || !SCHOOL_EMAIL_RE.test(e)) return `địa chỉ thứ ${i} phải là địa chỉ @hoangmaistarschool.edu.vn.`;
  }
  if (new Set(emails.map(e => e.toLowerCase())).size !== emails.length) return 'có địa chỉ bị lặp.';
  return null;
}

// ----------------------------------------------------------- tiện ích

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', c => { raw += c; });
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});
const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

/** Lượt đọc của pha cảnh báo: từ lượt đọc settings/mealOffDays (việc đầu tiên của pha) trở đi. */
export function alertPhaseReads(reads) {
  const i = reads.findIndex(r => r.what === 'get settings/mealOffDays');
  return i < 0 ? [] : reads.slice(i);
}
/** Danh sách lượt đọc đã sắp xếp; truy vấn trả nhiều tài liệu ghi kèm số lượt tính tiền: "... [2]". */
export const readList = reads => reads.map(r => (r.n === 1 ? r.what : `${r.what} [${r.n}]`)).sort();
/**
 * Thư gửi cho CBNV (endpoint nhận, trả 200), dạng gọn đã sắp xếp:
 *   staff-missing: "2026-11-09 um lunch"    staff-extra: "2026-11-06 ux lunch@11:50:no_registration"
 */
export const staffMails = (posts, kind) => posts
  .filter(p => p.kind === kind && p.status === 200)
  .flatMap(p => p.body.alerts.map(a => `${p.body.date} ${a.to.split('@')[0]} ${a.meals
    .map(m => (kind === 'staff-extra' ? `${m.meal}@${m.time}:${m.reason}` : m.meal)).join('+')}`))
  .sort();
/** Các biên nhận meal_alerts/... đang có. */
export const journal = db => Object.keys(db.docs).filter(k => k.startsWith('meal_alerts/')).sort();

// ----------------------------------------------------------- sandbox

/**
 * @returns {Promise<{
 *   taps: Record<string, Record<string, Record<string, string[]>>>,  // ngày -> máy -> mã NV -> giờ chấm (bộ nhớ của máy)
 *   api: 'new' | 'old',
 *   extraResponse: null | ((body: any) => unknown),
 *   posts: { kind: unknown, body: any, status: number, response: any }[],
 *   seed(world: { docs: Record<string, any>, users: Record<string, any>, taps?: any }): void,
 *   db(): { docs: Record<string, any>, users: Record<string, any> },
 *   run(opts: { at: string, args?: string[], failReads?: string[], failWrites?: string[], timeoutMs?: number }): Promise<{
 *     code: number | null, out: string, db: any, reads: { what: string, n: number }[], writes: { path: string, merge: boolean }[], posts: any[],
 *   }>,
 *   close(): Promise<void>,
 * }>}
 */
export async function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dkan-alert-wiring-'));
  const agentDir = join(root, 'agent');
  const dbFile = join(root, 'db.json');
  const statsFile = `${dbFile}.stats.json`;
  const secret = randomBytes(24).toString('hex');
  /** @type {import('node:http').Server[]} */
  const servers = [];

  const sb = {
    taps: {},
    api: 'new',
    extraResponse: null,
    posts: [],
    seed({ docs, users, taps }) {
      writeFileSync(dbFile, JSON.stringify({ docs, users }, null, 1));
      if (taps) sb.taps = structuredClone(taps);
    },
    db: () => JSON.parse(readFileSync(dbFile, 'utf8')),
    run,
    close,
  };

  // Máy nhận diện giả: trả lượt chấm trong khoảng thời gian agent hỏi, có chia trang như ISAPI.
  const deviceServer = name => createServer(async (req, res) => {
    let cond = {};
    try { cond = JSON.parse(await readBody(req)).AcsEventCond || {}; } catch { /* trả trang rỗng */ }
    const from = Date.parse(cond.startTime);
    const to = Date.parse(cond.endTime);
    const events = [];
    for (const [date, byDevice] of Object.entries(sb.taps)) {
      for (const [code, times] of Object.entries(byDevice?.[name] || {})) {
        for (const t of times) events.push({ major: 5, minor: 75, employeeNoString: code, name: '', time: vnIso(date, t) });
      }
    }
    const inRange = events
      .filter(e => !(Date.parse(e.time) < from) && !(Date.parse(e.time) > to))
      .sort((a, b) => a.time.localeCompare(b.time));
    const position = Number(cond.searchResultPosition) || 0;
    const page = inRange.slice(position, position + (Number(cond.maxResults) || 30));
    sendJson(res, 200, { AcsEvent: {
      searchID: cond.searchID, responseStatusStrg: position + page.length < inRange.length ? 'MORE' : 'OK',
      numOfMatches: page.length, totalMatches: inRange.length, InfoList: page,
    } });
  });

  // API email giả: kiểm tra như bản thật, ghi lại mọi yêu cầu; gửi "được" cho mọi người nhận.
  const endpointServer = () => createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    try { body = JSON.parse(raw); } catch { /* báo lỗi bên dưới */ }
    const reply = (status, response) => {
      sb.posts.push({ kind: body?.kind, body, status, response });
      sendJson(res, status, response);
    };
    if (req.method !== 'POST' || req.url !== '/api/meal-alerts') return reply(404, { error: 'Không có trang này.' });
    if (req.headers.authorization !== `Bearer ${secret}`) return reply(401, { error: 'Sai hoặc thiếu khoá xác thực.' });
    if (body === null) return reply(400, { error: 'Nội dung yêu cầu không phải JSON hợp lệ.' });
    const problem = requestProblem(body, sb.api);
    if (problem) return reply(400, { error: problem });
    const to = body.kind === 'admin-notice' ? body.to : body.alerts.map(a => a.to);
    if (body.kind === 'staff-extra' && sb.extraResponse) return reply(200, sb.extraResponse(body));
    return reply(200, { results: to.map(address => ({ to: address, ok: true })) });
  });

  async function close() {
    await Promise.all(servers.map(s => new Promise(resolve => {
      s.closeAllConnections?.();
      s.close(() => resolve());
    })));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  try {
    mkdirSync(join(agentDir, 'node_modules', 'firebase-admin'), { recursive: true });
    cpSync(join(AGENT_DIR, 'sync-checkins.mjs'), join(agentDir, 'sync-checkins.mjs'));
    cpSync(join(AGENT_DIR, 'lib'), join(agentDir, 'lib'), { recursive: true });
    writeFileSync(join(agentDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(agentDir, 'node_modules', 'firebase-admin', 'package.json'),
      JSON.stringify({ name: 'firebase-admin', type: 'module', main: 'index.js' }));
    writeFileSync(join(agentDir, 'node_modules', 'firebase-admin', 'index.js'), `export { default } from ${JSON.stringify(FAKE_ADMIN_URL)};\n`);
    writeFileSync(join(agentDir, 'firebase-key.json'), '{}');

    const devicePorts = [];
    for (const name of DEVICES) {
      const s = deviceServer(name);
      servers.push(s);
      devicePorts.push(await listen(s));
    }
    const endpoint = endpointServer();
    servers.push(endpoint);
    const endpointPort = await listen(endpoint);

    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      devices: DEVICES.map((name, i) => ({ name, ip: '127.0.0.1', port: devicePorts[i], protocol: 'http', username: 'admin', password: 'test' })),
      daysToSync: 7,
      pageDelayMs: 0,
      deviceTimeoutMs: 10_000,
      alerts: {
        enabled: true,
        endpoint: `http://127.0.0.1:${endpointPort}/api/meal-alerts`,
        secret,
        adminEmails: [ADMIN_EMAIL],
        notBefore: '13:40',
        minExpected: 20,
        maxMissingRatio: 0.4,
      },
    }, null, 2));
  } catch (err) {
    await close();
    throw err;
  }

  /** Một lần chạy agent, như Task Scheduler gọi, lúc `at` (ISO). */
  async function run({ at, args = TASK_ARGS, failReads = [], failWrites = [], timeoutMs = 45_000 }) {
    const firstPost = sb.posts.length;
    rmSync(statsFile, { force: true });
    const env = {
      ...process.env,
      FAKE_DB: dbFile,
      FAKE_NOW: at,
      FAKE_FAIL_READS: JSON.stringify(failReads),
      FAKE_FAIL_WRITES: JSON.stringify(failWrites),
    };
    // Không để tham số của tiến trình test (inspector, proxy, node:test) lọt sang agent.
    for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'NODE_USE_ENV_PROXY']) delete env[k];
    const child = spawn(process.execPath, ['--import', FREEZE_CLOCK_URL, 'sync-checkins.mjs', ...args], {
      cwd: agentDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const code = await new Promise((resolve, reject) => {
      let timedOut = false;
      // Hết giờ thì dừng agent và chờ nó thoát hẳn (Windows không cho xoá thư mục tạm
      // khi tiến trình còn giữ file) rồi mới báo lỗi.
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', c => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`agent chạy quá ${timeoutMs / 1000} giây:\n${out}`));
        else resolve(c);
      });
    });
    const stats = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, 'utf8')) : { reads: [], writes: [] };
    return { code, out, db: sb.db(), reads: stats.reads, writes: stats.writes, posts: sb.posts.slice(firstPost) };
  }

  return sb;
}
