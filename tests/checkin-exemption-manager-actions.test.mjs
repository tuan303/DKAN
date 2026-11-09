// Drives the real "Miễn chấm ăn theo bữa" manager (MealCheckinExemptions.tsx)
// against an in-memory Firestore and a tiny hook runtime — no DOM, Firebase,
// network or mail. Every write path must produce exactly the transaction
// operations asserted here. The clock is Date.now (vnParts() reads it), so each
// test pins Vietnam time explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const xlsx = require('xlsx');

// ------------------------------------------------------------ hook runtime
// Just enough of React for this component: state, refs, memo, effects and the
// automatic JSX runtime. Hook state lives per root, keyed by element path.
function createMini() {
  const Fragment = Symbol.for('mini.fragment');
  let current = null;
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const slot = init => {
    const index = current.index++;
    if (!(index in current.node.hooks)) current.node.hooks[index] = init();
    return current.node.hooks[index];
  };
  function useState(initial) {
    const { root } = current;
    const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    state.set ??= next => {
      const value = typeof next === 'function' ? next(state.value) : next;
      if (!Object.is(value, state.value)) { state.value = value; root.dirty = true; }
    };
    return [state.value, state.set];
  }
  const useRef = initial => slot(() => ({ current: initial }));
  function useMemo(compute, deps) {
    const memo = slot(() => ({ deps: null, value: undefined }));
    if (!sameDeps(memo.deps, deps)) { memo.value = compute(); memo.deps = deps; }
    return memo.value;
  }
  function useEffect(effect, deps) {
    const { root } = current;
    const hook = slot(() => ({ deps: null, cleanup: null }));
    if (deps && sameDeps(hook.deps, deps)) return;
    hook.deps = deps;
    root.effects.push(() => { if (typeof hook.cleanup === 'function') hook.cleanup(); hook.cleanup = effect(); });
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null });

  function createRoot(element) {
    const root = { nodes: new Map(), dirty: false, effects: [], tree: null };
    const renderEl = (el, path) => {
      if (el == null || typeof el === 'boolean') return null;
      if (typeof el === 'string' || typeof el === 'number') return String(el);
      if (Array.isArray(el)) return el.map((child, index) => renderEl(child, `${path}[${child?.key ?? index}]`));
      if (el.type === Fragment) return renderEl(el.props.children, `${path}/F`);
      const keyed = el.key != null ? `#${el.key}` : '';
      if (typeof el.type === 'function') {
        const key = `${path}/${el.type.name}${keyed}`;
        if (!root.nodes.has(key)) root.nodes.set(key, { hooks: [] });
        const previous = current;
        current = { node: root.nodes.get(key), index: 0, root };
        let output;
        try { output = el.type(el.props); } finally { current = previous; }
        return { type: el.type.name, component: true, props: el.props, children: [renderEl(output, key)].flat(Infinity).filter(x => x != null) };
      }
      const children = renderEl(el.props.children, `${path}/${el.type}${keyed}`);
      return { type: el.type, props: el.props, children: [children].flat(Infinity).filter(x => x != null) };
    };
    root.render = () => {
      for (let guard = 0; guard === 0 || root.dirty; guard++) {
        if (guard > 50) throw new Error('render loop');
        root.dirty = false;
        root.effects = [];
        root.tree = renderEl(element, 'root');
        const effects = root.effects;
        root.effects = [];
        for (const run of effects) run();
      }
      return root.tree;
    };
    // Mọi bước async của component chỉ là microtask: vài vòng setImmediate là đủ.
    root.settle = async () => {
      for (let round = 0; round < 20; round++) {
        await new Promise(resolve => setImmediate(resolve));
        if (root.dirty) root.render();
      }
      return root.tree;
    };
    return root;
  }
  return { Fragment, jsx, jsxs: jsx, useState, useRef, useMemo, useEffect, createRoot };
}

// ------------------------------------------------------------- Firestore giả
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function createFake({ docs = {}, settings = { agentFeatures: ['checkinExemptions', 'extraAlerts'] } } = {}) {
  const store = new Map(Object.entries(docs).map(([id, data]) => [id, clone(data)]));
  const listeners = new Set();
  const snap = id => ({ id, exists: () => store.has(id), data: () => clone(store.get(id)) });
  const fake = {
    store, settings, settingsError: null, snapshotError: null, user: { uid: 'admin-1' },
    answer: true, confirms: [], toasts: [], attempts: 0, transactions: [], invalidations: 0,
    confirm(message) { fake.confirms.push(message); return fake.answer; },
    doc(col, id) {
      if (typeof id !== 'string' || !id || id.includes('/')) throw new Error(`Mã tài liệu không hợp lệ: ${id}`);
      return { col, id };
    },
    async getDoc(ref) {
      if (ref.col !== 'settings') return snap(ref.id);
      if (fake.settingsError) throw fake.settingsError;
      return { exists: () => !!fake.settings, data: () => clone(fake.settings) };
    },
    notify() {
      const list = [...store.keys()].map(snap);
      for (const listener of listeners) listener.next({ docs: list });
    },
    onSnapshot(_ref, next, error) {
      const listener = { next, error };
      listeners.add(listener);
      queueMicrotask(() => {
        if (fake.snapshotError) { listeners.delete(listener); error(fake.snapshotError); return; }
        next({ docs: [...store.keys()].map(snap) });
      });
      return () => listeners.delete(listener);
    },
    async runTransaction(work) {
      fake.attempts++;
      const ops = [];
      const transaction = {
        get: async ref => snap(ref.id),
        set(ref, data) { ops.push(['set', ref.id, clone(data)]); return transaction; },
        delete(ref) { ops.push(['delete', ref.id]); return transaction; },
      };
      const result = await work(transaction);
      // Chỉ transaction chạy xong mới được ghi (giống Firestore: lỗi thì không ghi gì).
      fake.transactions.push(ops);
      for (const [op, id, data] of ops) { if (op === 'set') store.set(id, data); else store.delete(id); }
      if (ops.length) queueMicrotask(() => fake.notify());
      return result;
    },
  };
  return fake;
}

const STUBS = {
  react: 'module.exports = globalThis.__mini;',
  xlsx: 'module.exports = globalThis.__xlsx;',
  firebase: 'export const auth = { get currentUser() { return globalThis.__fake.user; } }; export const db = {};',
  reconciliation: 'export const invalidateCheckinExemptionCache = () => { globalThis.__fake.invalidations++; };',
  firestore: `
    const fake = () => globalThis.__fake;
    export const collection = (_db, name) => ({ name });
    export const doc = (_db, col, id) => fake().doc(col, id);
    export const getDoc = ref => fake().getDoc(ref);
    export const onSnapshot = (ref, next, error) => fake().onSnapshot(ref, next, error);
    export const runTransaction = (_db, work) => fake().runTransaction(work);`,
};

let ui;
test.before(async () => {
  globalThis.__mini = createMini();
  globalThis.__xlsx = xlsx;
  globalThis.window = { confirm: message => globalThis.__fake.confirm(message), setInterval: () => 0, clearInterval() {}, setTimeout: () => 0 };
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/MealCheckinExemptions.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent',
    plugins: [{
      name: 'fake-runtime',
      setup(builder) {
        const stub = path => () => ({ path, namespace: 'fake' });
        builder.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, stub('react'));
        builder.onResolve({ filter: /^xlsx$/ }, stub('xlsx'));
        builder.onResolve({ filter: /^\.\.\/lib\/firebase$/ }, stub('firebase'));
        builder.onResolve({ filter: /^firebase\/firestore$/ }, stub('firestore'));
        builder.onResolve({ filter: /^\.\/MealReconciliation$/ }, stub('reconciliation'));
        builder.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: STUBS[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  ui = module.exports;
});
test.after(() => { delete globalThis.window; });

const realNow = Date.now;
/** Giờ Việt Nam lúc thao tác (vnParts() đọc Date.now). */
const setClock = (date, time) => { Date.now = () => Date.parse(`${date}T${time}:00+07:00`); };
test.afterEach(() => { Date.now = realNow; });

// ------------------------------------------------------------------ tiện ích
const mail = name => `${name}@hoangmaistarschool.edu.vn`;
const period = (from, to = null, meals = ['lunch']) => ({ from, to, meals });
const person = (employeeId, fullName, periods, email = mail(employeeId)) => ({ employeeId, email, fullName, periods });

function* walk(node) {
  if (!node || typeof node === 'string') return;
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}
/** Chữ người dùng đọc được (bỏ biểu tượng aria-hidden như "warning", "block"). */
const text = node => typeof node === 'string' ? node
  : node?.props?.['aria-hidden'] === 'true' ? '' : (node?.children ?? []).map(text).join('');
const findAll = (tree, match) => [...walk(tree)].filter(match);
function button(tree, label) {
  const found = findAll(tree, node => node.type === 'button' && label.test(text(node)));
  assert.ok(found.length, `không thấy nút ${label}`);
  return found[0];
}
/** Mở menu "⋯" (Thao tác) của một người rồi trả về mục menu cần bấm. */
async function menuItem(root, getItem, label) {
  await act(root, button(getItem(), /^Thao tác với /).props.onClick);
  return button(getItem(), label);
}
const input = (tree, match) => findAll(tree, node => node.type === 'input' && match(node.props))[0];
const recordItem = (root, name) =>
  findAll(root.tree, node => node.component && node.type === 'ExemptionRecordItem' && node.props.record.fullName === name)[0];
const issueRow = (root, docId) => findAll(root.tree, node => node.type === 'li' && text(node).startsWith(`Tài liệu “${docId}”`))[0];
const alerts = tree => findAll(tree, node => node.props?.role === 'alert').map(text);
const topAlerts = tree => findAll(tree, node => node.type === 'div' && node.props?.role === 'alert').map(text);
const notice = tree => findAll(tree, node => node.props?.role === 'status' && /bg-green-50/.test(node.props.className ?? ''))
  .map(text)[0] ?? '';
/** Các thao tác ghi đã thực hiện, bỏ dấu thời gian (kiểm tra người ghi). */
const writes = fake => fake.transactions.flat().map(([op, id, data]) => {
  if (op !== 'set') return [op, id];
  const { updatedAt, updatedBy, ...record } = data;
  assert.equal(typeof updatedAt, 'string');
  assert.equal(updatedBy, 'admin-1');
  return [op, id, record];
});

async function mount(fake, props = {}) {
  globalThis.__fake = fake;
  const { createRoot, jsx } = globalThis.__mini;
  const root = createRoot(jsx(ui.default, { registrations: [], selectedMonth: '2026-11', registrationsReady: true,
    showToast: (message, type) => fake.toasts.push([type, message]), ...props }));
  root.render();
  await root.settle();
  return root;
}
/** Gọi một handler như người dùng bấm/gõ, chờ mọi cập nhật xong. */
async function act(root, handler, arg) {
  const result = handler(arg);
  await root.settle();
  await result;
  return root.settle();
}
async function importRows(root, rows, name = 'danh-sach.xlsx') {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), 'DS');
  const bytes = new Uint8Array(xlsx.write(workbook, { bookType: 'xlsx', type: 'array' }));
  const file = { name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  await act(root, input(root.tree, props => props.type === 'file').props.onChange, { target: { files: [file], value: name } });
}
async function fillManual(root, { employeeId, email, fullName }) {
  await act(root, input(root.tree, props => props.placeholder === '100001').props.onChange, { target: { value: employeeId } });
  await act(root, input(root.tree, props => props.type === 'email' && !!props.placeholder).props.onChange, { target: { value: email } });
  await act(root, input(root.tree, props => props.maxLength === 160).props.onChange, { target: { value: fullName } });
  const form = findAll(root.tree, node => node.type === 'form'
    && findAll(node, child => child.type === 'button' && text(child) === 'Xem trước nhân viên').length)[0];
  await act(root, form.props.onSubmit, { preventDefault() {} });
}

// ------------------------------------------------------------------- lưu
test('saving a preview writes only new and changed people, also when error rows are skipped', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: {
    100001: person('100001', 'Người A', [period('2026-11-01')]),
    100002: person('100002', 'Người B', [period('2026-11-01', '2026-11-05')]),
  } });
  const root = await mount(fake);
  await act(root, input(root.tree, props => props['aria-label'] === 'Ngày kết thúc miễn chấm ăn').props.onChange,
    { target: { value: '2026-11-20' } });
  await importRows(root, [['Mã NV', 'Email', 'Họ tên'], ['100001', mail('100001'), 'Người A'], ['100002', mail('100002'), 'Người B'],
    ['100003', mail('100003'), 'Người C'], ['12345', mail('sai'), 'Sai mã'], ['', '', 'Người lập biểu']]);
  assert.ok(text(root.tree).includes('1 mới · 1 thay đổi · 1 không thay đổi · 1 lỗi · 1 dòng bỏ qua'));
  assert.equal(button(root.tree, /^Xác nhận lưu 3 nhân viên$/).props.disabled, true, 'có dòng lỗi thì nút lưu chính bị khóa');

  await act(root, button(root.tree, /^Lưu 3 dòng hợp lệ, bỏ qua 1 dòng lỗi$/).props.onClick);
  const question = fake.confirms.at(-1);
  assert.match(question, /^Lưu 3 dòng hợp lệ, bỏ qua 1 dòng lỗi\?\n/);
  for (const line of ['• 1 người mới', '• 1 người thay đổi', '• 1 người không thay đổi (bỏ qua)', '• Bỏ qua 1 dòng lỗi']) {
    assert.ok(question.includes(line), line);
  }
  assert.deepEqual(writes(fake), [
    ['set', '100002', person('100002', 'Người B', [period('2026-11-01', '2026-11-05'), period('2026-11-06', '2026-11-20')])],
    ['set', '100003', person('100003', 'Người C', [period('2026-11-06', '2026-11-20')])],
  ], '100001 đã miễn không thời hạn: không ghi lại');
  const done = 'Đã lưu miễn chấm bữa trưa cho 2 nhân viên. 1 người không thay đổi. Bỏ qua 1 dòng lỗi.';
  assert.equal(notice(root.tree), done);
  assert.deepEqual(fake.toasts.at(-1), ['success', done]);
  assert.ok(!text(root.tree).includes('Xem trước ·'), 'lưu xong thì bỏ bản xem trước');
  assert.ok(text(root.tree).includes('Danh sách đã lưu (3)'));
});

test('nothing is written when a preview changes nothing; codes named by a broken document cannot be saved', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: {
    100001: person('100001', 'Người A', [period('2026-11-01')]),
    // Tài liệu lỗi: mã tài liệu 100008 nhưng mã trong dữ liệu 100009 — cả hai mã đều bị giữ.
    100008: person('100009', 'Người lỗi', [period('2026-11-01')]),
  } });
  const root = await mount(fake);
  await fillManual(root, { employeeId: '100001', email: '100001@HoangMaiStarSchool.edu.vn', fullName: 'Người A' });
  assert.ok(text(root.tree).includes('Không có thay đổi nào cần lưu.'));
  const save = button(root.tree, /^Xác nhận lưu 1 nhân viên$/);
  assert.equal(save.props.disabled, true);
  await act(root, save.props.onClick);
  assert.equal(fake.attempts, 0, 'không mở transaction khi không có gì để ghi');
  assert.match(notice(root.tree), /^Không có thay đổi nào cần lưu/);

  await fillManual(root, { employeeId: '100009', email: mail('100009'), fullName: 'Người lỗi' });
  assert.ok(text(root.tree).includes('Mã này đang có bản ghi cần kiểm tra. Xử lý ở mục “Bản ghi cần kiểm tra” rồi lưu lại.'));
  assert.equal(button(root.tree, /^Xác nhận lưu 0 nhân viên$/).props.disabled, true);

  await fillManual(root, { employeeId: '100010', email: mail('100010'), fullName: 'Người mới' });
  await act(root, button(root.tree, /^Xác nhận lưu 1 nhân viên$/).props.onClick);
  assert.match(fake.confirms.at(-1), /^Lưu danh sách miễn chấm cho 1 nhân viên\?\nBữa trưa · từ 06\/11\/2026, chưa có ngày kết thúc/);
  assert.deepEqual(writes(fake), [['set', '100010', person('100010', 'Người mới', [period('2026-11-06')])]]);
  assert.equal(input(root.tree, props => props.placeholder === '100001').props.value, '', 'thêm tay xong thì xóa ô nhập');
});

// ------------------------------------------------------------- ngừng miễn
test('stopping keeps today once the meal window has opened and ends yesterday before it', async () => {
  for (const { time, last, effective, keepsToday } of [
    { time: '11:00', last: '2026-11-06', effective: '07/11/2026', keepsToday: true },
    { time: '09:00', last: '2026-11-05', effective: '06/11/2026', keepsToday: false },
  ]) {
    setClock('2026-11-06', time);
    const fake = createFake({ docs: { 100001: person('100001', 'Người A', [period('2026-11-01')]) } });
    const root = await mount(fake);
    await act(root, (await menuItem(root, () => recordItem(root, 'Người A'), /^Ngừng miễn trưa$/)).props.onClick);
    assert.equal(fake.confirms.at(-1), ['Ngừng miễn chấm bữa trưa cho Người A?', `Từ ngày ${effective}, nhân viên phải chấm bữa trưa.`,
      ...keepsToday ? ['Bữa trưa hôm nay đã bắt đầu nên hôm nay vẫn được miễn.'] : [],
      'Các ngày đã miễn trước đó vẫn được giữ.'].join('\n'), time);
    assert.deepEqual(writes(fake), [['set', '100001', person('100001', 'Người A', [period('2026-11-01', last)])]], time);
    assert.equal(notice(root.tree), `Đã ngừng miễn chấm bữa trưa cho Người A. Từ ngày ${effective}, nhân viên phải chấm bữa trưa.`);
  }
});

test('row actions live in a "⋯" menu: hidden until opened, closed again after choosing', async () => {
  setClock('2026-11-06', '09:00');
  const fake = createFake({ docs: { 100001: person('100001', 'Người A', [period('2026-11-01')]) } });
  const root = await mount(fake);
  const item = () => recordItem(root, 'Người A');
  const menu = () => findAll(item(), node => node.props?.role === 'menu')[0];
  const trigger = () => button(item(), /^Thao tác với Người A$/);
  assert.equal(menu(), undefined);
  assert.equal(trigger().props['aria-expanded'], false);
  await act(root, trigger().props.onClick);
  assert.equal(trigger().props['aria-expanded'], true);
  assert.deepEqual(findAll(menu(), node => node.props?.role === 'menuitem').map(text),
    ['Ngừng miễn trưa', 'Đặt ngày kết thúc', 'Sửa email', 'Xóa khỏi danh sách']);
  await act(root, button(item(), /^Sửa email$/).props.onClick);
  assert.equal(menu(), undefined, 'chọn xong thì menu đóng');
  assert.ok(findAll(item(), node => node.type === 'form').length, 'form sửa email mở ngay dưới dòng');
});

test('stopping an exemption that has not started cancels it; a stale button writes nothing', async () => {
  setClock('2026-11-06', '09:00');
  const fake = createFake({ docs: {
    100005: person('100005', 'Tương Lai', [period('2026-12-01')]),
    100006: person('100006', 'Từ Hôm Nay', [period('2026-11-06')]),
    100007: person('100007', 'Có Lịch Sử', [period('2026-09-01', '2026-09-30'), period('2026-12-01', '2026-12-10')]),
    100008: person('100008', 'Đã Ngừng', [period('2026-11-01')]),
  } });
  const root = await mount(fake);
  const stop = async name => act(root, (await menuItem(root, () => recordItem(root, name), /^Ngừng miễn trưa$/)).props.onClick);

  await stop('Tương Lai');
  assert.equal(fake.confirms.at(-1), 'Hủy khoảng miễn bữa trưa từ 01/12/2026 của Tương Lai?\n'
    + 'Từ ngày 01/12/2026, nhân viên vẫn phải chấm bữa trưa như bình thường.');
  assert.deepEqual(writes(fake), [['delete', '100005']]);
  assert.equal(notice(root.tree), 'Đã hủy khoảng miễn bữa trưa từ 01/12/2026 của Tương Lai.');

  fake.transactions.length = 0;
  await stop('Từ Hôm Nay');
  assert.equal(fake.confirms.at(-1), 'Hủy khoảng miễn bữa trưa từ 06/11/2026 của Từ Hôm Nay?\n'
    + 'Từ ngày 06/11/2026, nhân viên vẫn phải chấm bữa trưa như bình thường.', 'chưa tới giờ ăn: không có “hôm nay vẫn được miễn”');
  assert.deepEqual(writes(fake), [['delete', '100006']]);

  fake.transactions.length = 0;
  await stop('Có Lịch Sử');
  assert.equal(fake.confirms.at(-1), 'Hủy khoảng miễn bữa trưa từ 01/12/2026 đến hết 10/12/2026 của Có Lịch Sử?\n'
    + 'Từ ngày 01/12/2026, nhân viên vẫn phải chấm bữa trưa như bình thường.\nCác ngày đã miễn trước đó vẫn được giữ.');
  assert.deepEqual(writes(fake), [['set', '100007', person('100007', 'Có Lịch Sử', [period('2026-09-01', '2026-09-30')])]]);

  // Người khác vừa ngừng (listener chưa kịp báo): tính lại trên bản mới nhất, không ghi gì.
  fake.store.set('100008', person('100008', 'Đã Ngừng', [period('2026-11-01', '2026-11-05')]));
  fake.transactions.length = 0;
  await stop('Đã Ngừng');
  assert.deepEqual(fake.transactions, [[]]);
  assert.equal(notice(root.tree), 'Đã Ngừng không còn khoảng miễn bữa trưa nào cần ngừng.');
});

// ------------------------------------------------ đặt ngày kết thúc, sửa email
test('end date and email edits write the record; invalid input is reported inside the open form and as a toast', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: { 100007: person('100007', 'Đang Mở', [period('2026-10-01')]) } });
  const root = await mount(fake, { registrations: [{ employeeId: '100007', email: mail('canhan') }] });
  const item = () => recordItem(root, 'Đang Mở');
  const form = () => findAll(item(), node => node.type === 'form')[0];
  const formAlerts = () => findAll(form(), node => node.props?.role === 'alert').map(text);
  const submit = () => act(root, form().props.onSubmit, { preventDefault() {} });

  await act(root, (await menuItem(root, item, /^Đặt ngày kết thúc$/)).props.onClick);
  const date = () => input(item(), props => props.type === 'date');
  assert.equal(date().props.min, '2026-11-06');
  await act(root, date().props.onChange, { target: { value: '2026-11-05' } });
  await submit();
  const tooEarly = 'Ngày kết thúc sớm nhất là 06/11/2026 vì bữa trưa hôm nay đã bắt đầu.';
  assert.equal(fake.attempts, 0);
  assert.deepEqual(formAlerts(), [tooEarly], 'lỗi hiện ngay trong form đang mở');
  assert.deepEqual(fake.toasts.at(-1), ['error', tooEarly]);
  assert.ok(!topAlerts(root.tree).includes(tooEarly), 'không đẩy lỗi lên đầu khung');
  await act(root, date().props.onChange, { target: { value: '2026-11-20' } });
  assert.deepEqual(formAlerts(), [], 'sửa lại thì lỗi cũ biến mất');
  await submit();
  assert.equal(fake.confirms.at(-1), 'Đặt ngày kết thúc miễn chấm bữa trưa của Đang Mở là 20/11/2026?\n'
    + 'Từ ngày 21/11/2026, nhân viên phải chấm bữa trưa.');
  assert.deepEqual(writes(fake), [['set', '100007', person('100007', 'Đang Mở', [period('2026-10-01', '2026-11-20')])]]);
  assert.equal(form(), undefined, 'lưu xong thì đóng form');

  fake.transactions.length = 0;
  await act(root, (await menuItem(root, item, /^Sửa email$/)).props.onClick);
  const email = () => input(item(), props => props.type === 'email');
  await act(root, email().props.onChange, { target: { value: 'someone@gmail.com' } });
  await submit();
  const [wrongEmail] = formAlerts();
  assert.match(wrongEmail, /^Email phải là địa chỉ @hoangmaistarschool\.edu\.vn/);
  assert.deepEqual(fake.toasts.at(-1), ['error', wrongEmail]);
  assert.equal(fake.attempts, 1, 'email sai thì không mở transaction');
  await act(root, button(item(), /^Điền email trên đơn: canhan@/).props.onClick);
  assert.equal(email().props.value, mail('canhan'));
  await submit();
  assert.equal(fake.confirms.at(-1), 'Đổi email miễn chấm của Đang Mở (100007)?\n'
    + '100007@hoangmaistarschool.edu.vn → canhan@hoangmaistarschool.edu.vn\nCác khoảng thời gian miễn chấm giữ nguyên.');
  assert.deepEqual(writes(fake), [['set', '100007', person('100007', 'Đang Mở', [period('2026-10-01', '2026-11-20')], mail('canhan'))]]);
  assert.equal(form(), undefined);

  await act(root, (await menuItem(root, item, /^Sửa email$/)).props.onClick);
  await submit();
  assert.equal(fake.attempts, 2, 'email không đổi thì không ghi');
  assert.equal(notice(root.tree), 'Email không thay đổi.');
});

test('a failed save of an inline form is shown inside that form', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: { 100007: person('100007', 'Đang Mở', [period('2026-10-01')]) } });
  const root = await mount(fake);
  const item = () => recordItem(root, 'Đang Mở');
  await act(root, (await menuItem(root, item, /^Sửa email$/)).props.onClick);
  await act(root, input(item(), props => props.type === 'email').props.onChange, { target: { value: mail('moi') } });
  fake.user = null;
  await act(root, findAll(item(), node => node.type === 'form')[0].props.onSubmit, { preventDefault() {} });
  const ended = 'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.';
  assert.deepEqual(findAll(item(), node => node.type === 'p' && node.props.role === 'alert').map(text), [ended]);
  assert.deepEqual(fake.toasts.at(-1), ['error', ended]);
  assert.equal(fake.attempts, 0);
});

// ------------------------------------------------------------------ xóa
test('removing a person deletes the document only after confirming the consequences', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: { 100001: person('100001', 'Người A', [period('2026-11-01')]) } });
  const root = await mount(fake);
  const remove = async () => act(root, (await menuItem(root, () => recordItem(root, 'Người A'), /^Xóa khỏi danh sách$/)).props.onClick);
  fake.answer = false;
  await remove();
  assert.equal(fake.attempts, 0, 'bấm Hủy ở hộp hỏi lại thì không ghi gì');
  fake.answer = true;
  await remove();
  assert.equal(fake.confirms.at(-1), ['Xóa Người A (100001) khỏi danh sách miễn chấm?',
    'Đối soát và trang cá nhân sẽ không còn ghi nhận miễn chấm cho những ngày đã qua của người này.',
    'Bữa trưa hôm nay đã bắt đầu: nếu xóa bây giờ, nhân viên có thể nhận email cảnh báo thiếu chấm của hôm nay. Muốn giữ hôm nay, hãy dùng “Ngừng miễn”.',
    'Không hoàn tác được.'].join('\n'));
  assert.deepEqual(writes(fake), [['delete', '100001']]);
  assert.ok(text(root.tree).includes('Chưa có nhân viên trong danh sách miễn chấm ăn.'));
});

test('deleting a broken document states its effect; a document repaired meanwhile is not deleted', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: {
    AutoId123: person('100004', 'D', [period('2026-11-01')]),
    Broken: { email: 'x' },
    100003: { ...person('100003', 'C', [period('2026-11-01')]), email: 'C@HoangMaiStarSchool.edu.vn' },
  } });
  const root = await mount(fake);
  assert.ok(alerts(root.tree).some(line => line.startsWith('Có 1 bản ghi lỗi không rõ mã nhân viên: agent đang tạm dừng toàn bộ')));
  const remove = docId => act(root, button(issueRow(root, docId), /^Xóa bản ghi lỗi$/).props.onClick);

  await remove('AutoId123');
  assert.equal(fake.confirms.at(-1), ['Xóa bản ghi lỗi “AutoId123” (mã 100004)?',
    'Mã 100004 sẽ không còn được miễn chấm (sẽ nhận email cảnh báo nếu thiếu chấm).',
    'Muốn giữ miễn chấm, dùng “Sửa tự động”.', 'Không hoàn tác được.'].join('\n'));
  assert.deepEqual(writes(fake), [['delete', 'AutoId123']]);

  fake.transactions.length = 0;
  await remove('Broken');
  assert.equal(fake.confirms.at(-1), ['Xóa bản ghi lỗi “Broken” (không rõ mã nhân viên)?',
    'Sau khi xóa, agent gửi lại email cảnh báo thiếu chấm như bình thường và tab Đối soát kết luận lại được.',
    'Không hoàn tác được.'].join('\n'));
  assert.deepEqual(writes(fake), [['delete', 'Broken']]);
  assert.ok(!alerts(root.tree).some(line => line.includes('không rõ mã nhân viên')), 'hết bản ghi không rõ mã thì hết cảnh báo');

  // Người khác vừa sửa đúng tài liệu này (listener chưa kịp báo): không xóa bản đã hợp lệ.
  fake.store.set('100003', person('100003', 'C', [period('2026-11-01')]));
  fake.transactions.length = 0;
  await remove('100003');
  assert.deepEqual(writes(fake), []);
  const refused = 'Bản ghi “100003” vừa được sửa và đã hợp lệ nên không xóa. Kiểm tra lại danh sách.';
  assert.ok(topAlerts(root.tree).includes(refused));
  assert.deepEqual(fake.toasts.at(-1), ['error', refused]);
  assert.ok(fake.store.has('100003'));
});

// ------------------------------------------------------------- sửa tự động
test('auto-fix moves the record to its staff code and refuses to overwrite an existing target', async () => {
  setClock('2026-11-06', '11:00');
  const data = person('100004', 'D', [period('2026-11-01')]);
  const fake = createFake({ docs: { AutoId123: data } });
  const root = await mount(fake);
  await act(root, button(issueRow(root, 'AutoId123'), /^Sửa tự động$/).props.onClick);
  assert.equal(fake.confirms.at(-1), ['Sửa tự động bản ghi “AutoId123”?',
    'Sẽ lưu bản ghi chuẩn: mã 100004 · 100004@hoangmaistarschool.edu.vn · D.',
    'Bản ghi cũ “AutoId123” sẽ được xóa sau khi lưu bản ghi mã 100004.', 'Các khoảng thời gian miễn chấm giữ nguyên.'].join('\n'));
  assert.deepEqual(writes(fake), [['set', '100004', data], ['delete', 'AutoId123']]);
  assert.deepEqual([...fake.store.keys()], ['100004']);
  assert.ok(recordItem(root, 'D'), 'bản ghi đã sửa hiện trong danh sách');
  assert.equal(notice(root.tree), 'Đã sửa bản ghi “AutoId123” thành bản ghi chuẩn mã 100004.');

  const taken = createFake({ docs: { AutoId123: data } });
  const again = await mount(taken);
  taken.store.set('100004', person('100004', 'D khác', [period('2026-10-01')])); // vừa được thêm, listener chưa báo
  await act(again, button(issueRow(again, 'AutoId123'), /^Sửa tự động$/).props.onClick);
  assert.equal(taken.attempts, 1);
  assert.deepEqual(writes(taken), []);
  const refused = 'Đã có bản ghi mã 100004. Xử lý bản ghi đó trước rồi sửa tự động.';
  assert.ok(topAlerts(again.tree).includes(refused));
  assert.deepEqual(taken.toasts.at(-1), ['error', refused]);
  assert.deepEqual([...taken.store.keys()].sort(), ['100004', 'AutoId123']);
});

test('twin broken documents for one code offer no auto-fix', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: {
    Auto1: person('100004', 'D', [period('2026-11-01')]),
    Auto2: person('100004', 'D', [period('2026-11-01')], mail('khac')),
  } });
  const root = await mount(fake);
  for (const docId of ['Auto1', 'Auto2']) {
    const row = issueRow(root, docId);
    assert.equal(findAll(row, node => node.type === 'button' && text(node) === 'Sửa tự động').length, 0, docId);
    assert.ok(text(row).includes('Có 2 bản ghi lỗi cùng mã 100004 với nội dung khác nhau — xóa bản sai rồi sửa tự động bản đúng.'));
  }
});

// ------------------------------------------------------- tải dữ liệu, bộ nhớ
test('a listener error never shows an empty list, and an unreadable agent version is a warning', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: { 100001: person('100001', 'Người A', [period('2026-11-01')]) } });
  fake.snapshotError = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  fake.settingsError = Object.assign(new Error('offline'), { code: 'unavailable' });
  const root = await mount(fake, { registrations: undefined, registrationsReady: false,
    registrationsError: 'Chưa tải được đăng ký hoặc danh sách hủy ăn của tháng đã chọn.' });
  const page = text(root.tree);
  assert.ok(page.includes('Chưa tải được danh sách.'));
  assert.ok(topAlerts(root.tree).some(line => line.startsWith('Tài khoản chưa có quyền quản lý danh sách miễn chấm ăn.')));
  assert.doesNotMatch(page, /Danh sách đã lưu \(|Chưa có nhân viên|đang được miễn|Đang tải danh sách|Đang tải đơn đăng ký/);
  assert.ok(page.includes('Chưa tải được đơn đăng ký tháng 11/2026 nên chưa đối chiếu được mã và email.'));
  const warning = findAll(root.tree, node => node.props?.role === 'status' && /bg-warning-container/.test(node.props.className ?? ''));
  assert.deepEqual(warning.map(text), ['Chưa kiểm tra được phiên bản agent trên máy HAC — nếu agent chưa cập nhật lên '
    + '2026-11-06.1, email cảnh báo thiếu chấm vẫn gửi cho người trong danh sách.']);

  fake.snapshotError = null;
  await act(root, button(root.tree, /^Tải lại danh sách$/).props.onClick);
  assert.ok(text(root.tree).includes('Danh sách đã lưu (1)'));
  assert.ok(text(root.tree).includes('1 đang được miễn'));
  assert.ok(!text(root.tree).includes('Chưa tải được danh sách.'));
});

test('every snapshot and every successful write drops the reconciliation tab cache', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: { 100001: person('100001', 'Người A', [period('2026-11-01')]) } });
  const root = await mount(fake);
  assert.equal(fake.invalidations, 1, 'lần tải đầu');
  fake.store.set('100002', person('100002', 'Người B', [period('2026-11-01')]));
  fake.notify(); // người khác vừa sửa danh sách
  await root.settle();
  assert.equal(fake.invalidations, 2);
  await act(root, (await menuItem(root, () => recordItem(root, 'Người B'), /^Xóa khỏi danh sách$/)).props.onClick);
  assert.equal(fake.invalidations, 4, 'sau khi ghi và khi danh sách mới về');
});

test('search matches names whatever form their accents were stored in', async () => {
  setClock('2026-11-06', '11:00');
  const fake = createFake({ docs: {
    100001: person('100001', 'Nguyễn Thị Hà'.normalize('NFD'), [period('2026-11-01')]),
    100002: person('100002', 'Trần Văn Bình', [period('2026-11-01')]),
  } });
  const root = await mount(fake);
  await act(root, input(root.tree, props => props.type === 'search').props.onChange, { target: { value: 'NGUYỄN'.normalize('NFC') } });
  const shown = findAll(root.tree, node => node.component && node.type === 'ExemptionRecordItem').map(node => node.props.record.employeeId);
  assert.deepEqual(shown, ['100001']);
});
