// Tab Đối soát với danh sách miễn chấm: không bao giờ chặn đối soát, báo rõ khi
// đọc lỗi/bản ghi lỗi/agent cũ, mẫu số "Chưa chấm" trừ suất được miễn, dòng thư
// "chấm chưa đăng ký" của ngày ăn trước. Firestore là bản giả, không đọc/ghi thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { buildFromCheckins } from '../agent/lib/meal-rules.mjs';
import { parseCheckinExemptionDocs } from '../agent/lib/checkin-exemptions.mjs';

const require = createRequire(import.meta.url);
const xlsx = require('xlsx');
const source = fileURLToPath(new URL('../src/components/MealReconciliation.tsx', import.meta.url));
const fixture = globalThis.__reconciliationFirestore = { calls: [], collections: {}, error: null };

let ui;
test.before(async () => {
  const compiled = await build({
    entryPoints: [source],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'fake-firebase', setup(builder) {
      builder.onResolve({ filter: /lib\/firebase$/ }, () => ({ path: 'firebase', namespace: 'fake' }));
      builder.onResolve({ filter: /^firebase\/firestore$/ }, () => ({ path: 'firestore', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: args.path === 'firebase' ? 'export const db = {};' : `
        const fixture = () => globalThis.__reconciliationFirestore;
        export const collection = (_db, ...segments) => ({ path: segments.join('/') });
        export const doc = (_db, ...segments) => ({ path: segments.join('/') });
        export const where = (field, op, value) => ({ field, op, value });
        export const query = (ref, ...filters) => ({ ...ref, filters });
        export async function getDoc(ref) {
          fixture().calls.push(ref.path);
          return { exists: () => false, data: () => undefined };
        }
        export async function getDocs(ref) {
          const f = fixture();
          f.calls.push(ref.path);
          if (f.error) throw Object.assign(new Error('fixture rejected'), { code: f.error });
          return { docs: (f.collections[ref.path] || []).map(row => ({ id: row.id, data: () => row.data })) };
        }
        export async function setDoc() { throw new Error('tests never write'); }
        export async function runTransaction() { throw new Error('tests never write'); }
      ` }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  ui = module.exports;
});

const date = '2026-11-05'; // Thứ 5
const mailOf = id => `nv${id}@hoangmaistarschool.edu.vn`;
const reg = (employeeId, overrides = {}) => ({ userId: `uid-${employeeId}`, employeeId, email: mailOf(employeeId),
  fullName: `Nhân viên ${employeeId}`, department: 'Khối Tiểu học', month: '2026-11',
  breakfastCount: 20, lunchCount: 20, firstMealDate: '2026-11-02', ...overrides });
const policy = (employeeId, overrides = {}) => ({ employeeId, email: mailOf(employeeId), fullName: `Nhân viên ${employeeId}`,
  periods: [{ from: '2026-11-02', to: null, meals: ['lunch'] }], ...overrides });
const input = {
  byDate: buildFromCheckins([{ date, people: { 100004: { name: 'Nhân viên 100004', times: ['07:10', '11:40'] } } }]).byDate,
  dates: [date],
  registrations: [reg('100001'), reg('100002'), reg('100003'), reg('100004'),
    reg('100005', { email: 'bi.danh@hoangmaistarschool.edu.vn' })],
  cancelations: [], excludedIds: [], offDays: [],
};
const namedDocs = [
  { id: '100001', data: policy('100001') },                                                   // hợp lệ: miễn trưa
  { id: '100002', data: policy('100002', { periods: [{ from: '2026-11-31', to: null }] }) },   // lỗi: giữ mã 100002
  { id: '100005', data: policy('100005') },                                                   // hợp lệ nhưng đơn mang email khác
];
const docs = [...namedDocs, { id: 'TaiLieuLa', data: { email: 'x' } }];                       // thêm một bản ghi lỗi không rõ mã
const ready = (list = docs) => ({ status: 'ready', ...parseCheckinExemptionDocs(list), loadedAt: Date.parse('2026-11-06T06:47:00Z') });
const notesOf = rows => Object.fromEntries(rows.map(row => [`${row.employeeId}|${row.meal}`, row.note ?? null]));
const html = node => renderToStaticMarkup(createElement(MemoryRouter, null, node));

test('đọc miễn chấm lỗi hoặc chưa xong: vẫn đối soát đủ, như không ai được miễn', () => {
  for (const state of [{ status: 'error', code: 'permission-denied' }, { status: 'error', code: '' }, { status: 'loading' }]) {
    const result = ui.reconcileWithExemptions(input, state);
    assert.equal(result.registered.length, 10, 'mọi suất đã đăng ký vẫn được tính');
    assert.equal(result.exempt.length, 0);
    assert.equal(result.tapped.length, 2);
    assert.ok(result.missing.some(row => row.employeeId === '100001' && row.meal === 'lunch'));
    if (state.status === 'error') {
      // Tệp Excel không mang theo cảnh báo trên màn hình: từng dòng thiếu chấm tự ghi rõ.
      assert.ok(result.missing.every(row => row.note === ui.UNAVAILABLE_EXEMPTION_NOTE), 'dòng thiếu chấm ghi chưa tải được danh sách miễn chấm');
    } else {
      assert.ok(result.missing.every(row => !row.note), 'đang tải: chưa có chính sách nào để so email hay giữ mã');
    }
  }
});

test('bản ghi lỗi có mã: áp dụng bản ghi hợp lệ, ghi chú dòng thiếu chấm của mã lỗi, giữ ghi chú lệch email', () => {
  const result = ui.reconcileWithExemptions(input, ready(namedDocs));
  assert.deepEqual(result.exempt.map(row => `${row.employeeId}|${row.meal}`), ['100001|lunch']);
  const notes = notesOf(result.missing);
  assert.equal(notes['100001|breakfast'], null, 'bữa sáng không được miễn vẫn là thiếu chấm bình thường');
  assert.equal(notes['100002|breakfast'], ui.BROKEN_EXEMPTION_NOTE);
  assert.equal(notes['100002|lunch'], 'Bản ghi miễn chấm của mã này đang lỗi — chưa kết luận');
  assert.equal(notes['100003|lunch'], null);
  assert.match(notes['100005|lunch'], /email trên đơn khác email trong danh sách/);
  assert.equal(notes['100005|breakfast'], null);
  assert.ok(!('100004|lunch' in notes), 'người đã chấm không thiếu');
  assert.equal(result.registered.length, 10);
});

test('bản ghi lỗi không rõ mã: chưa biết ai được miễn nên mọi dòng thiếu chấm đều chưa kết luận', () => {
  const result = ui.reconcileWithExemptions(input, ready());
  assert.deepEqual(result.exempt.map(row => `${row.employeeId}|${row.meal}`), ['100001|lunch'], 'bản ghi hợp lệ vẫn áp dụng');
  const notes = notesOf(result.missing);
  assert.equal(notes['100002|lunch'], ui.BROKEN_EXEMPTION_NOTE, 'mã đã biết giữ ghi chú riêng');
  for (const key of ['100001|breakfast', '100003|breakfast', '100003|lunch', '100005|breakfast']) {
    assert.equal(notes[key], 'Có bản ghi miễn chấm lỗi không rõ mã — chưa kết luận', key);
  }
  assert.equal(notes['100005|lunch'], `Có trong danh sách miễn chấm nhưng email trên đơn khác email trong danh sách; ${ui.UNIDENTIFIED_EXEMPTION_NOTE}`);
});

test('ghi chú của dòng thiếu chấm có trong sheet Excel "DK khong cham"; sheet miễn chấm vẫn còn', () => {
  const result = ui.reconcileWithExemptions(input, ready(namedDocs));
  const wb = ui.buildReconciliationWorkbook({ result, missing: result.missing, pending: [] });
  assert.deepEqual(wb.SheetNames, ['DK khong cham', 'Cham khong DK', 'Cham ngoai gio', 'Suat da dang ky', 'Luot cham hop le', 'Mien cham theo bua']);
  const rows = xlsx.utils.sheet_to_json(wb.Sheets['DK khong cham'], { defval: '' });
  assert.ok(rows.length && rows.every(row => 'Ghi chú' in row));
  const note = (id, meal) => rows.find(row => row['Mã NV'] === id && row['Bữa'] === meal)['Ghi chú'];
  assert.equal(note('100002', 'Bữa trưa'), ui.BROKEN_EXEMPTION_NOTE);
  assert.match(note('100005', 'Bữa trưa'), /email trên đơn khác/);
  assert.equal(note('100003', 'Bữa trưa'), '');
  const exempt = xlsx.utils.sheet_to_json(wb.Sheets['Mien cham theo bua']);
  assert.deepEqual(exempt.map(row => [row['Mã NV'], row['Bữa']]), [['100001', 'Bữa trưa']]);
  const pendingBook = ui.buildReconciliationWorkbook({ result, missing: [], pending: result.missing });
  assert.ok(xlsx.utils.sheet_to_json(pendingBook.Sheets['Chua cham - so tam'], { defval: '' }).every(row => 'Ghi chú' in row));
});

test('cảnh báo đọc lỗi nêu đúng nguyên nhân: rules chưa cho đọc, hay lỗi khác thì thử lại', () => {
  const denied = html(createElement(ui.ExemptionNotices, { exemptions: { status: 'error', code: 'permission-denied' }, sync: null, today: '2026-11-06' }));
  assert.match(denied, /role="alert"/);
  assert.match(denied, /Firestore Rules chưa cho phép đọc danh sách miễn chấm — dán bản firestore\.rules mới rồi bấm Tải lại dữ liệu\./);
  assert.match(denied, /đang tính như không ai được miễn chấm/);
  const other = html(createElement(ui.ExemptionNotices, { exemptions: { status: 'error', code: 'unavailable' }, sync: null, today: '2026-11-06' }));
  assert.match(other, /Chưa tải được danh sách miễn chấm ăn \(mã lỗi: unavailable\) — bấm Tải lại dữ liệu để thử lại\./);
  assert.doesNotMatch(other, /Firestore Rules/);
});

test('bản ghi lỗi được liệt kê theo mã (quản trị được xem), kèm nơi sửa và lý do từng bản ghi', () => {
  const sync = { agentVersion: '2026-11-06.1', agentFeatures: ['checkinExemptions', 'extraAlerts'] };
  const out = html(createElement(ui.ExemptionNotices, { exemptions: ready(), sync, today: '2026-11-06' }));
  assert.match(out, /2 bản ghi miễn chấm bị lỗi \(mã: 100002; 1 bản ghi không rõ mã\) chưa được áp dụng/);
  assert.match(out, /sửa ở <a [^>]*href="\/quantri\?tab=exemptions"[^>]*>Miễn chấm theo bữa<\/a>/);
  assert.match(out, /Bản ghi miễn chấm của mã này đang lỗi — chưa kết luận/);
  assert.match(out, /không xác định được mã nhân viên nên chưa biết ai đang được miễn: mọi dòng “Đăng ký nhưng không\s+chấm” còn lại được ghi chú “Có bản ghi miễn chấm lỗi không rõ mã — chưa kết luận”/);
  const namedOnly = html(createElement(ui.ExemptionNotices, { exemptions: ready(namedDocs), sync, today: '2026-11-06' }));
  assert.match(namedOnly, /1 bản ghi miễn chấm bị lỗi \(mã: 100002\) chưa được áp dụng/);
  assert.doesNotMatch(namedOnly, /không rõ mã/);
  assert.match(out, /TaiLieuLa<\/span>: Mã nhân viên phải là chuỗi/);
  assert.doesNotMatch(out, /Agent trên máy HAC/, 'agent mới thì không cảnh báo phiên bản');
});

test('agent chưa hỗ trợ miễn chấm mà danh sách còn hiệu lực: cảnh báo người được miễn vẫn có thể nhận email', () => {
  const valid = { status: 'ready', policies: [policy('100001')], invalid: [], loadedAt: 0 };
  const render = (sync, exemptions = valid) => html(createElement(ui.ExemptionNotices, { exemptions, sync, today: '2026-11-06' }));
  const warning = /Agent trên máy HAC chưa hỗ trợ miễn chấm \(bản đang chạy: 2026-10-20\.1\): người trong danh sách vẫn có\s+thể nhận email cảnh báo thiếu chấm\./;
  assert.match(render({ agentVersion: '2026-10-20.1' }), warning);
  assert.match(render({ agentVersion: '2026-10-20.1', agentFeatures: ['extraAlerts'] }), warning, 'danh sách tính năng thắng số phiên bản');
  assert.match(render({}), /bản đang chạy: không rõ/);
  assert.equal(render({ agentVersion: '2026-11-06.1' }), '');
  assert.equal(render({ agentVersion: '2026-10-20.1', agentFeatures: ['checkinExemptions'] }), '');
  assert.equal(render(null), '', 'chưa đọc được tình trạng agent thì không đoán');
  const ended = { ...valid, policies: [policy('100001', { periods: [{ from: '2026-10-01', to: '2026-10-31', meals: ['lunch'] }] })] };
  assert.equal(render({ agentVersion: '2026-10-20.1' }, ended), '', 'chính sách đã hết hạn không còn ảnh hưởng email');
  const upcoming = { ...valid, policies: [policy('100001', { periods: [{ from: '2026-11-09', to: null, meals: ['lunch'] }] })] };
  assert.match(render({ agentVersion: '2026-10-20.1' }, upcoming), warning, 'chính sách sắp áp dụng cũng cần agent mới');
});

test('dải tình trạng: mẫu số "Chưa chấm" trừ suất được miễn và ghi rõ số miễn chấm', () => {
  const at = new Date('2026-11-06T14:10:00+07:00');
  const strip = alert => renderToStaticMarkup(createElement(ui.SyncHealthStrip, {
    sync: { agentVersion: '2026-11-06.1', agentFeatures: ['checkinExemptions', 'extraAlerts'], lastRunAt: '2026-11-06T13:47:00+07:00', alerts: { '2026-11-06': alert } },
    offDays: [], now: at,
  }));
  const counted = { status: 'sent', at: '2026-11-06T13:47:00+07:00', sent: 8,
    expected: { breakfast: 100, lunch: 110 }, missing: { breakfast: 3, lunch: 5 }, exempt: { lunch: 12 } };
  assert.match(strip(counted), /Chưa chấm: sáng 3\/100, trưa 5\/98 \(miễn chấm 12\)/);
  assert.match(strip(counted), /Cảnh báo thiếu chấm hôm nay \(Thứ 6, 06\/11\):/);
  assert.match(strip({ ...counted, exempt: undefined }), /Chưa chấm: sáng 3\/100, trưa 5\/110</, 'agent cũ không ghi exempt');
  assert.equal(ui.missingCountsText({ expected: { breakfast: 2, lunch: 4 }, missing: { lunch: 1 }, exempt: { breakfast: 1, lunch: 9 } }),
    'sáng 0/1 (miễn chấm 1), trưa 1/0 (miễn chấm 9)');
});

test('thư lỗi một phần: nêu lý do, chỉ hứa "gửi nốt" khi có thư lỗi và hôm nay còn lần chạy tự động', () => {
  const partial = { status: 'partial', sent: 30, failed: 2, reason: 'Graph trả lỗi 429' };
  assert.equal(ui.describeAlert(partial, true, '14:10').text, 'Gửi được 30, lỗi 2 email: Graph trả lỗi 429 — lần chạy sau sẽ gửi nốt.');
  assert.equal(ui.describeAlert(partial, true, '15:05').text,
    'Gửi được 30, lỗi 2 email: Graph trả lỗi 429 — hôm nay không còn lần chạy tự động nào để gửi nốt.');
  const noFailure = ui.describeAlert({ status: 'partial', sent: 30, failed: 0, reason: 'Dừng giữa chừng: không ghi được nhật ký' }, true, '14:10');
  assert.equal(noFailure.text, 'Gửi được 30 email: Dừng giữa chừng: không ghi được nhật ký.');
  assert.equal(noFailure.tone, 'warn');
  assert.doesNotMatch(ui.describeAlert({ status: 'sent', sent: 30 }, true, '14:10').text, /gửi nốt/);
});

test('agent bản 2026-11-06.1: dòng thư "chấm chưa đăng ký" nói về ngày ăn trước (gửi ở lần chạy của ngày ăn kế tiếp)', () => {
  const features = { agentVersion: '2026-11-06.1', agentFeatures: ['checkinExemptions', 'extraAlerts'] };
  const strip = (alerts, at, sync = features, offDays = []) => renderToStaticMarkup(createElement(ui.SyncHealthStrip, {
    sync: { ...sync, lastRunAt: '2026-11-06T13:47:00+07:00', alerts }, offDays, now: new Date(at),
  }));
  const extra = { status: 'partial', at: '2026-11-06T13:48:00+07:00', candidates: 4, sent: 3, failed: 1, unmapped: 2, eventSkipped: 1, reason: 'Graph trả lỗi 429' };

  const during = strip({ '2026-11-05': { extra } }, '2026-11-06T14:10:00+07:00');
  assert.match(during, /Cảnh báo chấm chưa đăng ký ngày Thứ 5, 05\/11:/);
  assert.match(during, /Gửi được 3\/4, lỗi 1 email: Graph trả lỗi 429 — lần chạy sau sẽ gửi nốt · 2 mã chưa gắn được với đúng một tài khoản, không gửi — cần đối chiếu · 1 người có đăng ký ăn sự kiện, không gửi\./);
  assert.match(during, /13:48 06\/11\/2026/);
  assert.match(strip({ '2026-11-05': { extra } }, '2026-11-06T15:10:00+07:00'), /hôm nay không còn lần chạy tự động nào để gửi nốt/);

  const sent = ui.describeExtraAlert({ status: 'sent', candidates: 4, sent: 4 }, { supported: true, agentVersion: 'x', today: '2026-11-06', alertRunToday: true, nowTime: '15:00' });
  assert.deepEqual(sent, { tone: 'ok', text: 'Đã gửi 4/4 email.' });
  const unmapped = ui.describeExtraAlert({ status: 'sent', candidates: 2, sent: 2, unmapped: 1 }, { supported: true, agentVersion: 'x', today: '2026-11-06', alertRunToday: true, nowTime: '15:00' });
  assert.equal(unmapped.tone, 'warn', 'mã chưa gắn tài khoản cần quản trị đối chiếu');

  assert.match(strip({}, '2026-11-06T10:00:00+07:00'), /Đang chờ — gửi trong lần chạy cảnh báo hôm nay \(từ 13:45 tới khoảng 14:45\)\./);
  assert.match(strip({}, '2026-11-06T15:30:00+07:00'), /Chưa có kết quả: agent chưa chạy pha cảnh báo hôm nay, hoặc chức năng gửi cảnh báo đang tắt\./);
  // Thứ 7: ngày ăn gần nhất là Thứ 6, sẽ được gửi vào Thứ 2.
  const saturday = strip({}, '2026-11-07T09:00:00+07:00');
  assert.match(saturday, /Cảnh báo chấm chưa đăng ký ngày Thứ 6, 06\/11:/);
  assert.match(saturday, /Đang chờ — gửi vào lần chạy cảnh báo của ngày làm việc kế tiếp \(thứ 2–6, từ 13:45\)\./);
  // Thứ 2 nói về Thứ 6; ngày nghỉ đã khai bị bỏ qua.
  assert.match(strip({}, '2026-11-09T09:00:00+07:00'), /ngày Thứ 6, 06\/11:/);
  assert.match(strip({}, '2026-11-06T09:00:00+07:00', features, ['2026-11-05']), /ngày Thứ 4, 04\/11:/);
  // Agent cũ không bao giờ gửi loại thư này: không được báo "Đang chờ".
  const old = strip({}, '2026-11-06T10:00:00+07:00', { agentVersion: '2026-10-20.1' });
  assert.match(old, /Agent trên máy HAC chưa hỗ trợ gửi loại thư này \(bản đang chạy: 2026-10-20\.1\)\./);
  assert.doesNotMatch(old, /Đang chờ/);
});

test('agent gửi trong ngày (sameDayExtraAlerts): dòng thư "chấm chưa đăng ký" nói về hôm nay', () => {
  const features = { agentVersion: '2026-11-09.1', agentFeatures: ['checkinExemptions', 'extraAlerts', 'sameDayExtraAlerts'] };
  const strip = (alerts, at, sync = features, offDays = []) => renderToStaticMarkup(createElement(ui.SyncHealthStrip, {
    sync: { ...sync, lastRunAt: '2026-11-09T13:47:00+07:00', alerts }, offDays, now: new Date(at),
  }));
  const extra = { status: 'sent', at: '2026-11-09T13:48:00+07:00', candidates: 1, sent: 1, failed: 0, unmapped: 0, eventSkipped: 0, reason: null };

  const done = strip({ '2026-11-09': { status: 'sent', at: '2026-11-09T13:47:00+07:00', extra } }, '2026-11-09T14:10:00+07:00');
  assert.match(done, /Cảnh báo chấm chưa đăng ký ngày Thứ 2, 09\/11:/);
  assert.match(done, /Đã gửi 1\/1 email\./);
  // Kết quả của Thứ 6 (agent bản cũ ghi) không còn là dòng đang xem.
  assert.doesNotMatch(strip({ '2026-11-06': { extra } }, '2026-11-09T14:10:00+07:00'), /Thứ 6, 06\/11/);

  assert.match(strip({}, '2026-11-09T10:00:00+07:00'), /ngày Thứ 2, 09\/11:.*Đang chờ — gửi trong lần chạy cảnh báo hôm nay \(từ 13:45 tới khoảng 14:45\)\./s);
  // Cuối tuần, ngày nghỉ đã khai: không có thư nào để chờ.
  assert.doesNotMatch(strip({}, '2026-11-07T09:00:00+07:00'), /Cảnh báo chấm chưa đăng ký/);
  assert.doesNotMatch(strip({}, '2026-11-09T09:00:00+07:00', features, ['2026-11-09']), /Cảnh báo chấm chưa đăng ký/);
  // Bản ghi chưa có agentFeatures thì theo phiên bản.
  assert.match(strip({}, '2026-11-09T10:00:00+07:00', { agentVersion: '2026-11-09.1' }), /ngày Thứ 2, 09\/11:/);
  assert.match(strip({}, '2026-11-09T10:00:00+07:00', { agentVersion: '2026-11-06.1' }), /ngày Thứ 6, 06\/11:/);
});

test('email extra chưa rõ: không tính là đã gửi và không hứa tự gửi lại', () => {
  const info = ui.describeExtraAlert({ status: 'partial', candidates: 3, sent: 1, failed: 0, uncertain: 2,
    at: '2026-11-06T13:48:00+07:00' }, {
    supported: true, agentVersion: '2026-11-06.1', today: '2026-11-06', alertRunToday: true, nowTime: '14:00',
  });
  assert.equal(info.tone, 'warn');
  assert.match(info.text, /Gửi được 1\/3 email, 2 email chưa rõ đã gửi hay chưa/);
  assert.match(info.text, /Không tự gửi lại.*kiểm tra hộp thư/);
  assert.doesNotMatch(info.text, /lần chạy sau sẽ gửi nốt/);
});

test('danh sách miễn chấm được nhớ trong phiên: đổi tháng, chuyển tab không đọc lại; lỗi không được nhớ', async () => {
  fixture.calls = [];
  fixture.error = null;
  fixture.collections = { meal_checkin_exemptions: docs };
  ui.invalidateCheckinExemptionCache();
  const reads = () => fixture.calls.filter(path => path === 'meal_checkin_exemptions').length;

  const first = await ui.loadCheckinExemptionList();
  assert.deepEqual(first.policies.map(item => item.employeeId), ['100001', '100005']);
  assert.deepEqual(first.invalid.map(item => item.docId), ['100002', 'TaiLieuLa']);
  await ui.loadCheckinExemptionList();
  await ui.loadCheckinExemptionList();
  assert.equal(reads(), 1);

  // Mở lại tab trong thời hạn: trạng thái đầu tiên đã có danh sách (kể cả bản ghi lỗi), không nháy "đang tải".
  const reopened = html(createElement(ui.MealReconciliation, {
    registrations: [], cancelations: [], selectedMonth: '2026-11', onMonthChange() {},
    registrationDataReady: false, registrationDataError: null, onReloadRegistrations() {},
  }));
  assert.match(reopened, /2 bản ghi miễn chấm bị lỗi/);
  assert.doesNotMatch(reopened, /Đang tải danh sách miễn chấm/);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60_000;
    await ui.loadCheckinExemptionList();
    assert.equal(reads(), 2, 'quá ~10 phút thì đọc lại');
  } finally {
    Date.now = realNow;
  }

  ui.invalidateCheckinExemptionCache();
  fixture.error = 'permission-denied';
  await assert.rejects(ui.loadCheckinExemptionList(), error => error.code === 'permission-denied');
  fixture.error = null;
  await ui.loadCheckinExemptionList();
  assert.equal(reads(), 4, 'lần đọc lỗi không bị nhớ, lần sau đọc lại');
  assert.ok(fixture.calls.every(path => path === 'meal_checkin_exemptions'));
});

test('tab đối soát không còn đọc cả collection staff (tốn lượt đọc, hồ sơ do CBNV tự sửa)', () => {
  const code = readFileSync(source, 'utf8');
  assert.doesNotMatch(code, /collection\(\s*db\s*,\s*['"]staff['"]/);
  assert.doesNotMatch(code, /legacyStaffProfiles/);
});

test('lý do do agent ghi không bị lặp câu "gửi nốt" hay câu đếm người bỏ qua; "3/4" có giải thích', () => {
  const agentReason = '2 email chưa gửi được (Endpoint trả HTTP 429). Lần chạy sau sẽ gửi nốt. 1 mã có lượt chấm chưa gắn được với đúng một tài khoản, không gửi. 1 người có đăng ký suất ăn sự kiện gần ngày này, không gửi.';
  assert.equal(ui.agentReasonText(agentReason), ': 2 email chưa gửi được (Endpoint trả HTTP 429)');
  const late = ui.describeAlert({ status: 'partial', sent: 28, failed: 2, reason: agentReason }, true, '15:05').text;
  assert.equal((late.match(/gửi nốt/g) || []).length, 1, late);
  assert.doesNotMatch(late, /Lần chạy sau sẽ gửi nốt/);
  const options = { supported: true, agentVersion: 'x', today: '2026-11-06', alertRunToday: true, nowTime: '15:00' };
  const short = ui.describeExtraAlert({ status: 'sent', candidates: 4, sent: 3, reason: '1 người không có tài khoản đang hoạt động với email của trường, không gửi được.' }, options);
  assert.equal(short.tone, 'warn');
  assert.match(short.text, /Đã gửi 3\/4 email: 1 người không có tài khoản/);
  // Ngày nghỉ giữa tuần: DKAN 2 vẫn chạy và gửi nhóm thư của ngày ăn trước đó.
  const waiting = ui.describeExtraAlert(undefined, { ...options, alertRunToday: true, nowTime: '10:00' });
  assert.match(waiting.text, /gửi trong lần chạy cảnh báo hôm nay/);
  const weekend = ui.describeExtraAlert(undefined, { ...options, alertRunToday: false, nowTime: '10:00' });
  assert.match(weekend.text, /ngày làm việc kế tiếp/);
});
