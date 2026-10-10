// Test cho phần gộp checkins: lỗi nghiêm trọng mà bản này sửa là "một máy lỗi
// thì lượt chấm của máy đó bị xoá tới 7 ngày". Mọi test ở đây xoay quanh một
// câu hỏi: lượt chấm đã có có bị mất không.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByDateDevice, unionPeople, mergeDayDoc, findSuspectDevices, pruneDateKeys, buildSyncSettings, KEEP_DAYS,
} from '../lib/sync-merge.mjs';

const DEVICES = ['CA_TrH', 'CA_TIH'];
const AT = '2026-10-09T06:45:00.000Z';
const D = '2026-10-09';

/** Mọi cặp (mã, giờ) của một People — để so "không mất lượt nào". */
const tapsOf = people => Object.entries(people || {}).flatMap(([id, p]) => p.times.map(t => `${id}@${t}`)).sort();

test('groupByDateDevice: tách theo ngày và máy, bỏ trùng, bỏ ngoài khoảng', () => {
  const { byDate, outside } = groupByDateDevice([
    { employeeId: '101001', name: 'An', time: '2026-10-09T07:10:00+07:00', device: 'CA_TrH' },
    { employeeId: '101001', name: '', time: '2026-10-09T07:10:40+07:00', device: 'CA_TrH' }, // cùng phút
    { employeeId: '101001', name: 'An', time: '2026-10-09T06:55:00+07:00', device: 'CA_TrH' },
    { employeeId: '101001', name: 'An', time: '2026-10-09T11:30:00+07:00', device: 'CA_TIH' },
    { employeeId: ' 101002 ', name: 'Bình', time: '2026-10-08T11:00:00+07:00', device: 'CA_TIH' },
    { employeeId: '101003', name: 'Chi', time: '2026-10-01T11:00:00+07:00', device: 'CA_TIH' }, // ngoài khoảng
    { employeeId: '', name: 'Không mã', time: '2026-10-09T11:00:00+07:00', device: 'CA_TIH' },
    { employeeId: '101004', name: 'Giờ hỏng', time: 'rác', device: 'CA_TIH' },
  ], { from: '2026-10-03', to: D });
  assert.equal(outside, 1);
  assert.deepEqual(byDate[D].CA_TrH['101001'], { name: 'An', times: ['06:55', '07:10'] });
  assert.deepEqual(byDate[D].CA_TIH['101001'], { name: 'An', times: ['11:30'] });
  assert.deepEqual(byDate['2026-10-08'].CA_TIH['101002'], { name: 'Bình', times: ['11:00'] });
  assert.equal(byDate['2026-10-01'], undefined);
});

test('unionPeople: hợp giờ, duy nhất, sắp xếp', () => {
  assert.deepEqual(
    unionPeople([{ a: { name: '', times: ['11:00', '07:00'] } }, null, { a: { name: 'A', times: ['07:00', '12:00'] } }]),
    { a: { name: 'A', times: ['07:00', '11:00', '12:00'] } },
  );
});

test('merge: ngày mới, đủ máy => có byDevice, people là hợp, complete', () => {
  const doc = mergeDayDoc({
    date: D,
    existing: null,
    fresh: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] } }, CA_TIH: { 101001: { name: 'An', times: ['11:30'] } } },
    okDevices: DEVICES, configDevices: DEVICES, syncedAt: AT,
  });
  assert.equal(doc.complete, true);
  assert.equal(doc.month, '2026-10');
  assert.equal(doc.source, 'hikvision-agent');
  assert.deepEqual(doc.people['101001'].times, ['07:00', '11:30']);
  assert.deepEqual(Object.keys(doc.byDevice).sort(), [...DEVICES].sort());
});

test('merge: ngày mới mà không ai chấm => không tạo document rỗng', () => {
  assert.equal(mergeDayDoc({ date: D, existing: null, fresh: {}, okDevices: DEVICES, configDevices: DEVICES, syncedAt: AT }), null);
  assert.equal(mergeDayDoc({ date: D, existing: null, fresh: {}, okDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT }), null);
});

test('merge: máy lỗi giữ nguyên phần cũ, máy thành công thay phần của nó', () => {
  const existing = {
    people: { 101001: { name: 'An', times: ['07:00', '11:30'] }, 101002: { name: 'Bình', times: ['11:45'] } },
    byDevice: {
      CA_TrH: { 101001: { name: 'An', times: ['07:00'] } },
      CA_TIH: { 101001: { name: 'An', times: ['11:30'] }, 101002: { name: 'Bình', times: ['11:45'] } },
    },
  };
  const doc = mergeDayDoc({
    date: D, existing,
    fresh: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] }, 101005: { name: 'Em', times: ['07:20'] } } },
    okDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT,
  });
  assert.equal(doc.complete, false);
  assert.deepEqual(doc.byDevice.CA_TIH, existing.byDevice.CA_TIH);
  // Không mất lượt nào của máy lỗi, có thêm lượt mới của máy chạy được.
  for (const t of tapsOf(existing.people)) assert.ok(tapsOf(doc.people).includes(t), `mất ${t}`);
  assert.ok(tapsOf(doc.people).includes('101005@07:20'));
});

test('merge: máy thành công mà 0 lượt trong ngày, máy kia lỗi => phần máy lỗi còn nguyên', () => {
  const existing = {
    people: { 101002: { name: 'Bình', times: ['11:45'] } },
    byDevice: { CA_TrH: {}, CA_TIH: { 101002: { name: 'Bình', times: ['11:45'] } } },
  };
  const doc = mergeDayDoc({ date: D, existing, fresh: {}, okDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT });
  assert.deepEqual(doc.byDevice.CA_TrH, {});
  assert.deepEqual(doc.people, existing.people);
  assert.equal(doc.complete, false);
});

test('merge: document cũ chưa có byDevice + có máy lỗi => HỢP, giữ dạng cũ, chạy lỗi nhiều lần vẫn không mất', () => {
  const legacy = {
    people: { 101001: { name: 'An', times: ['07:00', '11:30'] }, 101009: { name: 'Chỉ ở máy lỗi', times: ['12:10'] } },
  };
  const run1 = mergeDayDoc({
    date: D, existing: legacy,
    fresh: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] }, 101005: { name: 'Em', times: ['07:20'] } } },
    okDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT,
  });
  assert.equal(run1.byDevice, undefined, 'chưa đủ máy thì chưa dựng byDevice');
  assert.equal(run1.complete, false);
  for (const t of tapsOf(legacy.people)) assert.ok(tapsOf(run1.people).includes(t), `mất ${t}`);
  assert.ok(tapsOf(run1.people).includes('101005@07:20'));

  // Lần sau máy kia vẫn lỗi, máy chạy được không có gì mới: không cần ghi
  // (null = giữ nguyên document), lượt chỉ có ở máy lỗi vẫn còn.
  const run2 = mergeDayDoc({ date: D, existing: run1, fresh: {}, okDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT });
  assert.equal(run2, null);
  const after2 = run2 ?? run1;
  assert.ok(tapsOf(after2.people).includes('101009@12:10'));
  assert.ok(tapsOf(after2.people).includes('101005@07:20'));
  // Có lượt mới thì ghi, vẫn là HỢP.
  const run3 = mergeDayDoc({ date: D, existing: after2, fresh: { CA_TrH: { 101010: { name: 'Mười', times: ['07:40'] } } }, okDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT });
  for (const t of tapsOf(after2.people)) assert.ok(tapsOf(run3.people).includes(t), `mất ${t}`);
  assert.ok(tapsOf(run3.people).includes('101010@07:40'));
});

test('merge: document cũ chưa có byDevice + đủ máy => ghi mới hoàn toàn', () => {
  const legacy = { people: { 101001: { name: 'An', times: ['07:00', '11:30'] } } };
  const doc = mergeDayDoc({
    date: D, existing: legacy,
    fresh: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] } }, CA_TIH: { 101001: { name: 'An', times: ['11:31'] } } },
    okDevices: DEVICES, configDevices: DEVICES, syncedAt: AT,
  });
  assert.equal(doc.complete, true);
  assert.deepEqual(doc.people, { 101001: { name: 'An', times: ['07:00', '11:31'] } });
  assert.ok(doc.byDevice.CA_TrH && doc.byDevice.CA_TIH);
});

test('merge: đủ máy => phần mỗi máy được thay hẳn (kể cả thành rỗng)', () => {
  const existing = {
    people: { 101001: { name: 'An', times: ['07:00', '11:30'] } },
    byDevice: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] } }, CA_TIH: { 101001: { name: 'An', times: ['11:30'] } } },
  };
  const doc = mergeDayDoc({
    date: D, existing,
    fresh: { CA_TrH: { 101002: { name: 'Bình', times: ['07:05'] } } },
    okDevices: DEVICES, configDevices: DEVICES, syncedAt: AT,
  });
  assert.equal(doc.complete, true);
  assert.deepEqual(doc.byDevice, { CA_TrH: { 101002: { name: 'Bình', times: ['07:05'] } }, CA_TIH: {} });
  assert.deepEqual(doc.people, { 101002: { name: 'Bình', times: ['07:05'] } });
});

test('merge: phần của máy đã bỏ khỏi config vẫn được giữ', () => {
  const existing = { people: {}, byDevice: { CA_CU: { 101007: { name: 'Cũ', times: ['11:00'] } } } };
  const doc = mergeDayDoc({ date: D, existing, fresh: {}, okDevices: DEVICES, configDevices: DEVICES, syncedAt: AT });
  assert.deepEqual(doc.people['101007'].times, ['11:00']);
});

test('findSuspectDevices: máy trả 0 lượt cả khoảng mà đã có dữ liệu của nó', () => {
  const existingDocs = {
    '2026-10-08': { byDevice: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] } }, CA_TIH: {} } },
    [D]: null,
    '2026-10-07': { people: { 101003: { times: ['11:00'] } } }, // dạng cũ: không biết của máy nào
  };
  const fresh = { [D]: { CA_TIH: { 101002: { name: 'Bình', times: ['11:00'] } } } };
  assert.deepEqual(findSuspectDevices({ okDevices: DEVICES, freshByDate: fresh, existingDocs }), [{ name: 'CA_TrH', knownPeople: 1 }]);
  // Máy có lượt mới thì không nghi.
  const fresh2 = { [D]: { CA_TrH: { 101001: { name: 'An', times: ['07:00'] } } } };
  assert.deepEqual(findSuspectDevices({ okDevices: DEVICES, freshByDate: fresh2, existingDocs }), []);
  // Hệ thống chưa có gì của máy (vd. cả tuần nghỉ) thì 0 lượt là bình thường.
  assert.deepEqual(findSuspectDevices({ okDevices: ['CA_TIH'], freshByDate: {}, existingDocs }), []);
});

test('pruneDateKeys: giữ đúng 100 ngày gần nhất', () => {
  assert.equal(KEEP_DAYS, 100);
  // 09/10 lùi 99 ngày là 02/07: 02/07 còn giữ, 01/07 bị xoá.
  const map = { '2026-07-01': 1, '2026-07-02': 1, '2026-10-09': 1, rac: 1 };
  assert.deepEqual(pruneDateKeys(map, D).sort(), ['2026-07-01', 'rac']);
  // Đủ phủ trường hợp xa nhất của trang cá nhân: ngày 31 xem ngày 01 của hai tháng trước.
  assert.deepEqual(pruneDateKeys({ '2026-08-01': 1 }, '2026-10-31'), []);
  assert.deepEqual(pruneDateKeys(null, D), []);
});

test('buildSyncSettings: coverage chỉ khi đủ máy, phủ cả ngày không ai chấm, cắt 100 ngày', () => {
  const DEL = Symbol('del');
  const rangeDates = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', D];
  const existing = {
    lastCompleteAt: '2026-10-08T15:00:00.000Z',
    devices: { CA_TrH: { lastOkAt: '2026-10-08T15:00:00.000Z' }, CA_TIH: { lastOkAt: '2026-10-08T15:00:00.000Z' }, CA_CU: { ok: true } },
    coverage: { '2026-07-01': 'x', '2026-07-02': 'y', '2026-10-08': 'z' },
  };
  const okRun = buildSyncSettings({
    agentVersion: 'v', runEndAt: AT, complete: true, existing,
    deviceResults: [
      { name: 'CA_TrH', ok: true, at: AT, events: 10, error: null },
      { name: 'CA_TIH', ok: true, at: AT, events: 0, error: null },
    ],
    configDevices: DEVICES, coveredDates: rangeDates, today: D, del: DEL,
  });
  assert.equal(okRun.lastRunComplete, true);
  assert.equal(okRun.lastCompleteAt, AT);
  for (const d of rangeDates) assert.equal(okRun.coverage[d], AT, `thiếu coverage ${d}`);
  assert.equal(okRun.coverage['2026-07-01'], DEL);
  assert.equal(okRun.coverage['2026-07-02'], undefined, 'còn trong 100 ngày thì giữ nguyên');
  assert.equal(okRun.devices.CA_CU, DEL);
  assert.deepEqual(okRun.devices.CA_TIH, { ok: true, at: AT, events: 0, error: null, lastOkAt: AT });

  const badRun = buildSyncSettings({
    agentVersion: 'v', runEndAt: AT, complete: false, existing,
    deviceResults: [
      { name: 'CA_TrH', ok: true, at: AT, events: 10, error: null },
      { name: 'CA_TIH', ok: false, at: AT, events: 0, error: 'Không kết nối được\n  - chi tiết' },
    ],
    configDevices: DEVICES, coveredDates: [], today: D, del: DEL,
  });
  assert.equal('coverage' in badRun, false, 'không đủ máy thì không đụng tới coverage');
  assert.equal(badRun.lastRunComplete, false);
  assert.equal(badRun.lastCompleteAt, existing.lastCompleteAt);
  assert.equal(badRun.devices.CA_TIH.ok, false);
  assert.equal(badRun.devices.CA_TIH.lastOkAt, existing.devices.CA_TIH.lastOkAt);
  assert.equal(badRun.devices.CA_TIH.error, 'Không kết nối được | - chi tiết');

  // Lần đầu chạy, không đủ máy: lastCompleteAt là null chứ không thiếu trường.
  const first = buildSyncSettings({
    agentVersion: 'v', runEndAt: AT, complete: false, existing: null,
    deviceResults: [{ name: 'CA_TrH', ok: false, at: AT, events: 0, error: 'x' }],
    configDevices: DEVICES, coveredDates: [], today: D, del: DEL,
  });
  assert.equal(first.lastCompleteAt, null);
  assert.equal(first.devices.CA_TrH.lastOkAt, null);
});
