// "Chấm ăn của tôi" khi đọc danh sách miễn chấm của chính mình: bị từ chối, bản
// ghi lỗi, tài khoản không có email. Auth và Firestore là bản giả trong bộ nhớ:
// không đọc/ghi dữ liệu thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const require = createRequire(import.meta.url);
const auth = globalThis.__myMealsAuth = { currentUser: null };
const store = globalThis.__myMealsFirestore = { calls: [], docs: {}, collections: {}, errors: {} };

// Truy vấn được lọc giống Firestore (điều kiện ==), để kiểm tra trang hỏi đúng email của mình.
const FAKE_FIRESTORE = `
  const store = () => globalThis.__myMealsFirestore;
  const reject = path => {
    const code = store().errors[path];
    if (code) throw Object.assign(new Error('fake ' + code), { code });
  };
  export const doc = (_db, ...segments) => ({ path: segments.join('/') });
  export const collection = (_db, ...segments) => ({ path: segments.join('/') });
  export const where = (field, op, value) => ({ field, op, value });
  export const query = (ref, ...filters) => ({ ...ref, filters });
  export async function getDoc(ref) {
    store().calls.push(ref.path);
    reject(ref.path);
    const data = store().docs[ref.path];
    return { exists: () => data !== undefined, data: () => data };
  }
  export async function getDocs(ref) {
    store().calls.push(ref.path);
    reject(ref.path);
    const rows = (store().collections[ref.path] || [])
      .filter(row => (ref.filters || []).every(f => f.op === '==' && row.data && row.data[f.field] === f.value));
    return { docs: rows.map(row => ({ id: row.id, data: () => row.data })) };
  }
`;

let page;
test.before(async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/pages/MyMeals.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    jsx: 'automatic', logLevel: 'silent',
    plugins: [{
      name: 'fake-firebase',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/(lib\/firebase|components\/)/ }, args => ({ path: args.path, namespace: 'fake' }));
        builder.onResolve({ filter: /^firebase\/firestore$/ }, () => ({ path: 'firestore', namespace: 'fake' }));
        builder.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: args.path === 'firestore' ? FAKE_FIRESTORE : `
          export const auth = globalThis.__myMealsAuth, db = {};
          export const Header = () => null, Navigation = () => null, Footer = () => null, SurveyBanner = () => null;
        ` }));
      },
    }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  page = module.exports;
});

const uid = 'uid-mau';
const email = 'gv.mau@hoangmaistarschool.edu.vn';
const todayIso = '2026-11-06'; // Thứ 6
const now = new Date('2026-11-06T15:00:00+07:00');
const registration = { userId: uid, employeeId: '100001', email, fullName: 'Giáo viên mẫu', month: '2026-11',
  breakfastCount: 20, lunchCount: 20, firstMealDate: '2026-11-02' };
const policy = { employeeId: '100001', email, fullName: 'Giáo viên mẫu', periods: [{ from: '2026-11-02', to: null, meals: ['lunch'] }] };
// Mọi ngày từ 02/11 đều đã đồng bộ đủ máy sau giờ ăn trưa: không có lượt chấm là "Chưa chấm" thật.
const coverage = Object.fromEntries(['02', '03', '04', '05', '06'].map(d => [`2026-11-${d}`, `2026-11-${d}T13:47:00+07:00`]));

function reset({ user = { uid, email: ' GV.Mau@HoangMaiStarSchool.edu.vn ' }, exemptions = [], errors = {} } = {}) {
  auth.currentUser = user;
  store.calls = [];
  store.errors = errors;
  store.docs = {
    [`staff/${uid}`]: { fullName: 'Giáo viên mẫu', employeeId: '100001' },
    'settings/checkinSync': { lastRunAt: '2026-11-06T13:47:00+07:00', lastCompleteAt: '2026-11-06T13:47:00+07:00',
      lastRunComplete: true, devices: {}, coverage },
    'settings/mealOffDays': { dates: [] },
    'settings/reconcileExcludes': { employeeIds: [] },
  };
  store.collections = { cancel_registrations: [], meal_checkin_exemptions: exemptions };
}

// Lỗi đọc được ghi ra console để quản trị tra cứu; im lặng trong lúc chạy kiểm thử.
async function quietly(run) {
  const original = console.error;
  console.error = () => {};
  try { return await run(); } finally { console.error = original; }
}

const monthData = (reg = registration, taps = {}) => ({ registration: reg, taps, conflict: false, conflictIds: [], conflictFrom: null, hasTapsDoc: true });
const view = (base, months = { '2026-11': monthData() }) => page.buildMyMealsView({ base, months, month: '2026-11', todayIso, now });
const render = (computed, base) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(page.MyMealsView, {
  loading: false, error: null, profile: base.profile, todayIso, today: computed.today, sync: base.sync,
  missedSyncAt: computed.missedSyncAt, conflict: computed.conflict, exemptionNotice: computed.exemptionNotice,
  month: '2026-11', monthOptions: ['2026-11', '2026-10', '2026-09'], onMonthChange() {}, monthData: computed.monthData,
})));
const todayCard = html => html.slice(html.indexOf('aria-labelledby="mm-today-title"'), html.indexOf('</section>'));
const historyList = html => html.slice(html.indexOf('<ol'), html.indexOf('</ol>'));

test('bản ghi hợp lệ của chính mình được áp dụng: trưa "Miễn chấm ăn", sáng vẫn phải chấm, không có thông báo', async () => {
  reset({ exemptions: [
    { id: '100001', data: policy },
    { id: '100002', data: { ...policy, employeeId: '100002', email: 'nguoi.khac@hoangmaistarschool.edu.vn' } },
  ] });
  const base = await page.loadBase(uid);
  assert.equal(base.exemptionState, 'ok');
  assert.equal(base.email, email, 'email đăng nhập được chuẩn hoá trước khi truy vấn');
  assert.deepEqual(base.checkinExemptions.map(item => item.employeeId), ['100001'], 'chỉ bản ghi mang email của mình');
  const computed = view(base);
  assert.equal(computed.exemptionNotice, null);
  assert.equal(computed.today.result.meals.lunch.code, 'exempt');
  assert.equal(computed.today.result.meals.breakfast.code, 'missing');
  const html = render(computed, base);
  assert.match(todayCard(html), /Miễn chấm ăn/);
  assert.doesNotMatch(html, /Chưa tải được thông tin miễn chấm|Thông tin miễn chấm của Thầy\/Cô đang được kiểm tra/);
});

test('không đọc được miễn chấm (rules chưa cập nhật, mất mạng): trang vẫn tải đủ, chỉ thêm thông báo nhỏ', async () => {
  for (const code of ['permission-denied', 'unavailable', 'internal']) {
    reset({ exemptions: [{ id: '100001', data: policy }], errors: { meal_checkin_exemptions: code } });
    const base = await quietly(() => page.loadBase(uid));
    assert.equal(base.exemptionState, 'unavailable', code);
    assert.deepEqual(base.checkinExemptions, []);
    assert.equal(base.profile.employeeId, '100001', 'các phần khác của trang vẫn có dữ liệu');
    const computed = view(base);
    assert.equal(computed.exemptionNotice, 'unavailable');
    // Tính như không được miễn: bữa trưa đã chốt mà không chấm là "Chưa chấm", và trang nói rõ điều đó.
    assert.equal(computed.today.result.meals.lunch.code, 'missing');
    const html = render(computed, base);
    assert.match(html, /Chưa tải được thông tin miễn chấm ăn\. Nếu Thầy\/Cô thuộc diện miễn chấm, bữa được miễn có thể tạm hiển thị\s+“Chưa chấm”\./);
    assert.match(html, /id="mm-today-title"/);
    assert.match(html, /id="mm-history-title"/);
    assert.doesNotMatch(html, /role="alert"/, 'không thay cả trang bằng màn hình lỗi');
  }
});

test('bản ghi miễn chấm của chính mình đang lỗi: không áp dụng, báo đang kiểm tra, bữa chưa chấm không bị kết luận', async () => {
  reset({ exemptions: [{ id: '100001', data: { ...policy, periods: [{ from: '2026-11-31', to: null }] } }] });
  const base = await page.loadBase(uid);
  assert.equal(base.exemptionState, 'invalid');
  assert.deepEqual(base.checkinExemptions, []);

  const computed = view(base, { '2026-11': monthData(registration, { '2026-11-05': ['07:30', '11:45'] }) });
  assert.equal(computed.exemptionNotice, 'invalid');
  assert.equal(computed.today.hold, 'exemption');
  assert.deepEqual(['breakfast', 'lunch'].map(meal => computed.today.result.meals[meal].code), ['pending', 'pending']);
  const tapped = computed.monthData.days.find(day => day.result.date === '2026-11-05');
  assert.equal(tapped.result.meals.lunch.code, 'ok', 'lượt chấm thật vẫn hiện "Đã chấm"');
  assert.ok(computed.monthData.days.every(day => ['breakfast', 'lunch'].every(meal => day.result.meals[meal].code !== 'missing')));

  const html = render(computed, base);
  assert.match(html, /Thông tin miễn chấm của Thầy\/Cô đang được kiểm tra\. Vui lòng liên hệ/);
  assert.match(html, /mailto:dinhduong@hoangmaistarschool\.edu\.vn/);
  assert.doesNotMatch(todayCard(html), />Chưa chấm</);
  assert.match(todayCard(html), /Chưa có dữ liệu/);
  assert.match(todayCard(html), /thông tin miễn chấm của Thầy\/Cô đang được kiểm tra nên hệ thống chưa kết luận/i);
  assert.doesNotMatch(historyList(html), />Chưa chấm</);
  assert.match(html, /bữa chưa kết luận vì thông tin miễn chấm đang được kiểm tra/);

  // Cùng dữ liệu, không có bản ghi lỗi thì đúng là "Chưa chấm": chính bản ghi lỗi giữ kết luận lại.
  const control = view({ ...base, exemptionState: 'ok' });
  assert.equal(control.today.result.meals.lunch.code, 'missing');
  assert.equal(control.today.hold, null);
});

test('tài khoản không có email: bỏ qua truy vấn miễn chấm (không thể khớp) thay vì báo lỗi cả trang', async () => {
  for (const user of [{ uid, email: null }, { uid, email: '   ' }, { uid: 'tai-khoan-khac', email }]) {
    reset({ user, exemptions: [{ id: '100001', data: policy }] });
    const base = await page.loadBase(uid);
    assert.equal(base.exemptionState, 'ok');
    assert.deepEqual(base.checkinExemptions, []);
    assert.ok(!store.calls.includes('meal_checkin_exemptions'), 'không gửi truy vấn mà rules chắc chắn từ chối');
    assert.ok(store.calls.includes(`staff/${uid}`), 'phần còn lại của trang vẫn được tải');
    const computed = view(base);
    assert.equal(computed.exemptionNotice, null);
    assert.equal(computed.today.result.meals.lunch.code, 'missing');
    assert.doesNotMatch(render(computed, base), /miễn chấm của Thầy\/Cô|Chưa tải được thông tin miễn chấm/);
  }
});

test('chỉ phần miễn chấm nằm ngoài cổng tải trang: hồ sơ hay cấu hình đọc lỗi vẫn báo lỗi như trước', async () => {
  reset({ errors: { 'settings/checkinSync': 'permission-denied' } });
  await assert.rejects(page.loadBase(uid), error => error.step === 'data' && error.code === 'permission-denied');
});

test('tháng không đăng ký: nói rõ trang không hiện lượt chấm và chỉ cách đối chiếu khi nhận email chấm chưa đăng ký', async () => {
  reset();
  const base = await page.loadBase(uid);
  const computed = view(base, { '2026-11': monthData(null) });
  const html = render(computed, base);
  assert.match(html, /Thầy\/Cô không đăng ký suất ăn tháng 11\/2026, nên trang này không hiển thị lượt chấm của\s+tháng\./);
  assert.match(html, /Nếu Thầy\/Cô nhận được email cảnh báo chấm ăn khi chưa đăng ký, vui lòng liên hệ/);
  assert.match(html, /để được đối chiếu/);
  assert.match(todayCard(html), /không đăng ký suất ăn tháng này nên trang không hiển thị lượt chấm \(nếu có\)/);
  assert.doesNotMatch(html, /chỉ hiển thị lượt chấm \(nếu có\)/, 'không còn hứa hiện lượt chấm của tháng không đăng ký');
});

test('bản ghi lỗi mang email của mình nhưng nhắc mã NV khác: vẫn áp dụng chính sách hợp lệ của mã mình, như agent', async () => {
  reset({ exemptions: [
    { id: '100001', data: policy },
    { id: '100009', data: { ...policy, employeeId: '100009', periods: [] } },
  ] });
  const base = await page.loadBase(uid);
  assert.equal(base.exemptionState, 'invalid');
  assert.deepEqual(base.checkinExemptions.map(item => item.employeeId), ['100001']);
  assert.deepEqual(base.exemptionHeldIds, ['100009']);
  assert.equal(base.exemptionHeldAll, false);
  const computed = view(base);
  assert.equal(computed.today.hold, null, 'tháng đăng ký mã 100001 không bị giữ');
  assert.equal(computed.today.result.meals.lunch.code, 'exempt');
  assert.equal(computed.today.result.meals.breakfast.code, 'missing', 'bữa sáng không được miễn vẫn kết luận như agent');

  // Bản ghi lỗi không rõ mã: không mã nào chắc chắn, giữ kết luận cho mọi tháng.
  reset({ exemptions: [{ id: 'khong-ro-ma', data: { email } }] });
  const unknown = await page.loadBase(uid);
  assert.equal(unknown.exemptionHeldAll, true);
  assert.equal(view(unknown).today.hold, 'exemption');
});
