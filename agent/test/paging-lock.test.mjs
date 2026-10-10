// Hai chốt chặn mất dữ liệu / gửi trùng ở tầng vận hành:
//  - lấy sự kiện từ máy mà bị cắt (chạm giới hạn trang) thì máy phải bị coi là
//    LỖI, không được "thành công" với dữ liệu thiếu;
//  - hai lần chạy thật không được chồng lên nhau (gửi trùng email cảnh báo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAcsPage, pagingProblem, MAX_PAGES } from '../lib/isapi-paging.mjs';
import { acquireLock, inspectLock, LOCK_STALE_MS } from '../lib/run-lock.mjs';

// ------------------------------------------------------------ phân trang

test('readAcsPage: đọc trang ISAPI, chịu được trường thiếu/sai kiểu', () => {
  assert.deepEqual(
    readAcsPage({ AcsEvent: { responseStatusStrg: 'MORE', numOfMatches: 30, totalMatches: 95, InfoList: [{}, {}] } }),
    { list: [{}, {}], matched: 30, more: true, total: 95 },
  );
  assert.deepEqual(readAcsPage({ AcsEvent: { responseStatusStrg: 'OK', InfoList: [{}] } }), { list: [{}], matched: 1, more: false, total: null });
  assert.deepEqual(readAcsPage({ AcsEvent: { responseStatusStrg: 'NO MATCH', numOfMatches: 0, totalMatches: '12' } }), { list: [], matched: 0, more: false, total: 12 });
  assert.deepEqual(readAcsPage(null), { list: [], matched: 0, more: false, total: null });
  assert.equal(readAcsPage({ AcsEvent: { totalMatches: 'abc' } }).total, null);
});

/** Mô phỏng vòng phân trang của sync-checkins.mjs trên một thiết bị giả. */
function page(device, maxPages) {
  let position = 0; let pages = 0; let finished = false; let stalled = false; let total = null;
  while (pages < maxPages) {
    const p = readAcsPage(device(position));
    pages++;
    position += p.matched;
    if (p.total !== null) total = p.total;
    if (!p.more) { finished = true; break; }
    if (p.matched === 0) { stalled = true; break; }
  }
  return pagingProblem({ finished, stalled, position, total, pages, maxPages });
}
const fakeDevice = ({ count, size = 10, reportTotal = true, lie = 0 }) => position => {
  const n = Math.max(0, Math.min(size, count - position));
  return { AcsEvent: {
    responseStatusStrg: position + n < count ? 'MORE' : (n ? 'OK' : 'NO MATCH'),
    numOfMatches: n, ...(reportTotal ? { totalMatches: count + lie } : {}), InfoList: Array(n).fill({}),
  } };
};

test('pagingProblem: lấy trọn thì ổn; chạm giới hạn trang hay thiếu so với tổng thì coi là lỗi', () => {
  assert.equal(MAX_PAGES >= 1000, true);
  assert.equal(page(fakeDevice({ count: 95 }), 100), null);
  assert.equal(page(fakeDevice({ count: 0 }), 100), null, 'không có sự kiện nào cũng là trọn');
  // Kịch bản người duyệt: thiết bị chỉ nhận kiểu 10 dòng, khoảng ngày dài —
  // trước đây dừng lặng lẽ và máy vẫn "thành công".
  const capped = page(fakeDevice({ count: 1000 }), 50);
  assert.match(capped, /quá nhiều sự kiện/);
  assert.match(capped, /giảm --days/);
  // Thiết bị báo hết (OK) nhưng tổng nói còn thiếu.
  assert.match(page(fakeDevice({ count: 40, lie: 5 }), 100), /báo có 45 sự kiện nhưng chỉ lấy được 40/);
  // Báo MORE mà trả trang rỗng, không báo tổng: giữ cách hiểu cũ (đã hết).
  const stall = position => ({ AcsEvent: { responseStatusStrg: 'MORE', numOfMatches: position < 20 ? 10 : 0, InfoList: [] } });
  assert.equal(page(stall, 100), null);
  // ...nhưng có báo tổng mà chưa đủ thì là bị cắt.
  const stallWithTotal = position => ({ AcsEvent: { responseStatusStrg: 'MORE', numOfMatches: position < 20 ? 10 : 0, totalMatches: 50, InfoList: [] } });
  assert.match(page(stallWithTotal, 100), /chỉ lấy được 20/);
});

// ------------------------------------------------------------ khoá chạy

/** Ổ đĩa và đồng hồ giả cho run-lock. */
function fakeEnv({ alive = new Set([1, 2]) } = {}) {
  const files = new Map();
  let clock = Date.parse('2026-10-09T06:45:00Z');
  const deps = {
    tryCreate: (p, text) => { if (files.has(p)) return false; files.set(p, { text, mtimeMs: clock }); return true; },
    read: p => files.get(p) ?? null,
    remove: p => { files.delete(p); },
    now: () => clock,
    isAlive: pid => alive.has(pid),
    sleep: async ms => { clock += ms; },
  };
  return { files, deps, advance: ms => { clock += ms; }, alive };
}
const info = (pid, startedAt = '2026-10-09T06:45:00.000Z') => ({ pid, token: `t${pid}`, startedAt, args: '--quiet --days 1 --send-alerts' });

test('acquireLock: lấy được khi chưa ai giữ, nhả ra thì người sau lấy được', async () => {
  const env = fakeEnv();
  const a = await acquireLock({ path: 'L', info: info(1), deps: env.deps });
  assert.equal(a.ok, true);
  a.release();
  assert.equal(env.files.size, 0);
  const b = await acquireLock({ path: 'L', info: info(2), deps: env.deps });
  assert.equal(b.ok, true);
});

test('acquireLock: đang có lần chạy khác thì chờ, quá hạn thì bỏ (không chạy chồng)', async () => {
  const env = fakeEnv();
  const a = await acquireLock({ path: 'L', info: info(1), deps: env.deps });
  let waited = null;
  const b = await acquireLock({ path: 'L', info: info(2), deps: env.deps, waitMs: 60_000, pollMs: 5000, onWait: h => { waited = h; } });
  assert.equal(b.ok, false);
  assert.equal(b.holder.pid, 1);
  assert.equal(waited.pid, 1, 'báo cho người chạy biết đang chờ ai');
  a.release();
});

test('acquireLock: lần chạy kia xong trong lúc chờ thì lấy được khoá', async () => {
  const env = fakeEnv();
  const a = await acquireLock({ path: 'L', info: info(1), deps: env.deps });
  let n = 0;
  const deps = { ...env.deps, sleep: async ms => { env.advance(ms); if (++n === 3) a.release(); } };
  const b = await acquireLock({ path: 'L', info: info(2), deps, waitMs: 600_000 });
  assert.equal(b.ok, true);
});

test('acquireLock: khoá kẹt (tiến trình đã chết, hoặc quá cũ, hoặc file hỏng đã lâu) được thay', async () => {
  // Tiến trình giữ khoá không còn chạy (máy tắt ngang).
  let env = fakeEnv({ alive: new Set([2]) });
  env.files.set('L', { text: JSON.stringify(info(1)), mtimeMs: env.deps.now() });
  assert.equal((await acquireLock({ path: 'L', info: info(2), deps: env.deps, waitMs: 0 })).ok, true);

  // Còn chạy nhưng quá cũ (Task Scheduler đã dừng nó sau 1 giờ).
  env = fakeEnv();
  const old = new Date(env.deps.now() - LOCK_STALE_MS - 1000).toISOString();
  env.files.set('L', { text: JSON.stringify(info(1, old)), mtimeMs: env.deps.now() });
  assert.equal((await acquireLock({ path: 'L', info: info(2), deps: env.deps, waitMs: 0 })).ok, true);

  // File hỏng/rỗng: mới tạo thì chờ (bên kia đang ghi dở), cũ thì coi là kẹt.
  env = fakeEnv();
  env.files.set('L', { text: '', mtimeMs: env.deps.now() });
  assert.equal(inspectLock(env.files.get('L'), { now: env.deps.now(), isAlive: () => true }).stale, false);
  assert.equal(inspectLock(env.files.get('L'), { now: env.deps.now() + 120_000, isAlive: () => true }).stale, true);
});

test('release chỉ xoá đúng khoá của mình', async () => {
  const env = fakeEnv();
  const a = await acquireLock({ path: 'L', info: info(1), deps: env.deps });
  // Khoá của a bị coi là kẹt và bị lần chạy khác thay.
  env.files.set('L', { text: JSON.stringify(info(2)), mtimeMs: env.deps.now() });
  a.release();
  assert.equal(JSON.parse(env.files.get('L').text).pid, 2);
});
