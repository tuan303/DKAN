// Bản giả trong bộ nhớ của phần firebase-admin mà sync-checkins.mjs dùng
// (Firestore + Auth getUsers), cho test alert-wiring.test.mjs. Agent nạp file
// này thay cho thư viện thật qua node_modules/firebase-admin của bản chép tạm
// (xem agent-sandbox.mjs) — không bao giờ nói chuyện với Firebase.
//
//   FAKE_DB            file JSON { docs: { 'đường/dẫn': dữ liệu }, users: { uid: { email, disabled } } };
//                      ghi lại sau mỗi lần ghi thành công.
//   FAKE_DB.stats.json lúc tiến trình thoát: { reads: [{ what, n }], writes: [{ path, merge }] }.
//                      Lượt đọc tính như Firestore tính tiền: một lượt mỗi tài liệu trả về,
//                      truy vấn rỗng vẫn tính một lượt, đọc tài liệu không có cũng tính một lượt.
//   FAKE_FAIL_READS    mảng JSON các chuỗi: lượt đọc nào có mô tả chứa một chuỗi trong đó thì ném lỗi
//                      (vd. ["query events"]).
//   FAKE_FAIL_WRITES   mảng JSON các tiền tố đường dẫn: ghi vào đó thì ném lỗi (cả lô hỏng, như Firestore).
//
// Giống Firestore ở những điểm agent dựa vào: set merge gộp sâu các map (map rỗng
// thay cả trường), FieldValue.delete() chỉ dùng được khi merge, không nhận giá trị
// undefined (agent không bật ignoreUndefinedProperties), batch tối đa 500 thao tác và
// ghi tất cả hoặc không gì, truy vấn 'in' tối đa 30 giá trị, kết quả xếp theo id.
//
// Nạp file mà không có FAKE_DB thì không làm gì: `npm test` trong thư mục agent
// (node --test không kèm tham số) coi mọi file .mjs trong test/ là file test và
// sẽ chạy cả file này — khi đó nó chỉ hiện là một dòng "pass".
import { readFileSync, writeFileSync } from 'node:fs';

const DELETE = Object.freeze({ fakeFieldValue: 'delete' });
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v) && v !== DELETE;
const clone = v => (v === undefined ? undefined : structuredClone(v));
const envList = name => {
  try {
    const v = JSON.parse(process.env[name] || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** @type {{ docs: Record<string, any>, users: Record<string, { email?: string, disabled?: boolean }> } | null} */
let state = null;
/** @type {{ what: string, n: number }[]} */
const reads = [];
/** @type {{ path: string, merge: boolean }[]} */
const writes = [];

function load() {
  if (state) return state;
  const file = process.env.FAKE_DB;
  if (!file) throw new Error('fake firebase-admin: chưa đặt FAKE_DB');
  state = JSON.parse(readFileSync(file, 'utf8'));
  state.docs ||= {};
  state.users ||= {};
  process.on('exit', () => writeFileSync(`${file}.stats.json`, JSON.stringify({ reads, writes })));
  return state;
}
const persist = () => writeFileSync(/** @type {string} */ (process.env.FAKE_DB), JSON.stringify(state, null, 1));

function countRead(what, n) {
  if (envList('FAKE_FAIL_READS').some(s => what.includes(s))) throw new Error(`FAKE read failure: ${what}`);
  reads.push({ what, n });
}

/** Firestore từ chối undefined, và FieldValue.delete() ngoài set merge hay trong mảng. */
function checkValue(v, field, { merge, inArray }) {
  if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${field}").`);
  if (v === DELETE) {
    if (!merge || inArray) throw new Error(`FieldValue.delete() cannot be used here (found in field "${field}").`);
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => checkValue(x, `${field}.${i}`, { merge, inArray: true }));
  else if (isMap(v)) for (const [k, x] of Object.entries(v)) checkValue(x, field ? `${field}.${k}` : k, { merge, inArray });
}

function mergeInto(target, patch) {
  const out = isMap(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE) delete out[k];
    else if (isMap(v) && Object.keys(v).length) out[k] = mergeInto(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

function prepareWrite(path, data, opts) {
  load();
  if (!isMap(data)) throw new Error(`fake firestore: dữ liệu ghi vào ${path} phải là object`);
  const merge = opts?.merge === true;
  checkValue(data, '', { merge, inArray: false });
  if (envList('FAKE_FAIL_WRITES').some(p => path.startsWith(p))) throw new Error(`FAKE write failure: ${path}`);
  return () => {
    state.docs[path] = merge ? mergeInto(state.docs[path], data) : mergeInto({}, data);
    writes.push({ path, merge });
  };
}

const snapshot = ref => {
  const data = state.docs[ref.path];
  return {
    id: ref.id,
    ref,
    exists: data !== undefined,
    data: () => clone(data),
    get: field => clone(String(field).split('.').reduce((o, k) => (isMap(o) ? o[k] : undefined), data)),
  };
};

class DocRef {
  constructor(parent, id) {
    if (typeof id !== 'string' || !id || id.includes('/') || id === '.' || id === '..' || /^__.*__$/.test(id)) {
      throw new Error(`fake firestore: id tài liệu không hợp lệ: ${JSON.stringify(id)}`);
    }
    this.parent = parent;
    this.id = id;
    this.path = `${parent.path}/${id}`;
  }
  collection(name) { return new CollectionRef(this, name); }
  async get() {
    load();
    countRead(`get ${this.path}`, 1);
    return snapshot(this);
  }
  async set(data, opts) {
    prepareWrite(this.path, data, opts)();
    persist();
  }
}

const describeFilter = f => `${f.field} ${f.op} ${JSON.stringify(f.value)}`;
const matches = (data, { field, op, value }) => {
  if (op === '==') return data?.[field] === value;
  if (op === 'in') return value.includes(data?.[field]);
  throw new Error(`fake firestore: chưa hỗ trợ toán tử ${op}`);
};

class Query {
  constructor(coll, filters = []) {
    this.coll = coll;
    this.filters = filters;
  }
  where(field, op, value) {
    if (op === 'in' && (!Array.isArray(value) || value.length < 1 || value.length > 30)) {
      throw new Error(`fake firestore: 'in' cần 1..30 giá trị, nhận ${Array.isArray(value) ? value.length : typeof value}`);
    }
    return new Query(this.coll, [...this.filters, { field, op, value }]);
  }
  async get() {
    load();
    const prefix = `${this.coll.path}/`;
    const docs = Object.keys(state.docs)
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .sort()
      .filter(path => this.filters.every(f => matches(state.docs[path], f)))
      .map(path => snapshot(this.coll.doc(path.slice(prefix.length))));
    const where = this.filters.length ? ` where ${this.filters.map(describeFilter).join(' and ')}` : '';
    countRead(`query ${this.coll.path}${where}`, Math.max(1, docs.length));
    return { docs, size: docs.length, empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
  }
}

class CollectionRef extends Query {
  constructor(parent, id) {
    super(null);
    this.coll = this;
    this.parent = parent;
    this.id = id;
    this.path = parent ? `${parent.path}/${id}` : id;
  }
  doc(id) { return new DocRef(this, id); }
}

const db = {
  collection: name => new CollectionRef(null, name),
  async getAll(...refs) {
    if (!refs.length) throw new Error('fake firestore: getAll() cần ít nhất một tài liệu');
    load();
    for (const r of refs) countRead(`getAll ${r.path}`, 1);
    return refs.map(snapshot);
  },
  batch() {
    const ops = [];
    let committed = false;
    const batch = {
      set(ref, data, opts) { ops.push([ref, data, opts]); return batch; },
      async commit() {
        if (committed) throw new Error('fake firestore: batch đã commit');
        committed = true;
        if (ops.length > 500) throw new Error(`fake firestore: batch ${ops.length} thao tác (tối đa 500)`);
        load();
        // Kiểm tra hết rồi mới ghi: một thao tác lỗi thì cả lô không ghi gì.
        const apply = ops.map(([ref, data, opts]) => prepareWrite(ref.path, data, opts));
        for (const run of apply) run();
        persist();
      },
    };
    return batch;
  },
};

const app = {
  name: '[DEFAULT]',
  async delete() {
    const i = admin.apps.indexOf(app);
    if (i >= 0) admin.apps.splice(i, 1);
  },
};

const admin = {
  /** @type {typeof app[]} */
  apps: [],
  initializeApp() {
    load();
    if (admin.apps.length) throw new Error('The default Firebase app already exists.');
    admin.apps.push(app);
    return app;
  },
  credential: { cert: () => ({ fake: true }) },
  firestore: Object.assign(() => { load(); return db; }, { FieldValue: { delete: () => DELETE } }),
  auth: () => ({
    async getUsers(identifiers) {
      load();
      if (identifiers.length > 100) throw new Error(`fake auth: getUsers ${identifiers.length} tài khoản (tối đa 100)`);
      const users = [];
      const notFound = [];
      for (const id of identifiers) {
        const u = state.users[id.uid];
        if (u) users.push({ uid: id.uid, email: u.email, disabled: u.disabled === true });
        else notFound.push(id);
      }
      return { users, notFound };
    },
  }),
};

export default admin;
