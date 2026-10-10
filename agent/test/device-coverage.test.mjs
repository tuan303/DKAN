// Máy "thành công" nhưng chỉ trả dữ liệu cho MỘT PHẦN khoảng ngày: bộ nhớ sự
// kiện bị xoá giữa tuần, lệch giờ, hay lấy bù quá bộ nhớ của máy. Những ngày máy
// không trả gì không được hiểu là "không ai chấm ở máy này" — hiểu vậy là thay
// phần cũ của máy bằng rỗng, mất lượt chấm vĩnh viễn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByDateDevice, unionPeople, mergeDayDoc, findSuspectDevices, buildSyncSettings, deviceSpans, coversDate,
} from '../lib/sync-merge.mjs';

const DEVICES = ['CA_TrH', 'CA_TIH'];
const AT = '2026-10-09T06:45:00.000Z';
const D = '2026-10-09';

const tapsOf = people => Object.entries(people || {}).flatMap(([id, p]) => p.times.map(t => `${id}@${t}`)).sort();
const ev = (device, id, date, hhmm) => ({ employeeId: id, name: '', time: `${date}T${hhmm}:00+07:00`, device });
const twoDevDoc = (a, b) => ({ people: unionPeople([a, b]), byDevice: { CA_TrH: a, CA_TIH: b } });

/** Chạy trọn bước gộp đúng như sync-checkins.mjs cho mọi ngày trong khoảng. */
function runMerge({ rangeDates, existingDocs, events, okDevices = DEVICES, configDevices = DEVICES }) {
  const { byDate } = groupByDateDevice(events, { from: rangeDates[0], to: rangeDates.at(-1) });
  const suspects = findSuspectDevices({ okDevices, freshByDate: byDate, existingDocs }).map(s => s.name);
  const ok = okDevices.filter(d => !suspects.includes(d));
  const spans = deviceSpans(byDate, ok);
  const coveredDates = rangeDates.filter(d => configDevices.every(dev => coversDate(spans[dev], d)));
  const out = {};
  for (const date of rangeDates) {
    const merged = mergeDayDoc({
      date, existing: existingDocs[date] ?? null, fresh: byDate[date] || {}, okDevices: ok,
      coveringDevices: ok.filter(d => coversDate(spans[d], date)), configDevices, syncedAt: AT,
    });
    out[date] = { merged, final: merged || existingDocs[date] || null };
  }
  return { out, spans, suspects, coveredDates };
}

test('deviceSpans / coversDate: khoảng từ ngày sớm nhất tới muộn nhất máy có lượt chấm', () => {
  const { byDate } = groupByDateDevice([
    ev('CA_TrH', '1', '2026-10-05', '07:00'), ev('CA_TrH', '1', '2026-10-08', '07:00'),
    ev('CA_TIH', '2', '2026-10-07', '11:00'),
  ]);
  const spans = deviceSpans(byDate, [...DEVICES, 'CA_KHAC']);
  assert.deepEqual(spans, {
    CA_TrH: { from: '2026-10-05', to: '2026-10-08' },
    CA_TIH: { from: '2026-10-07', to: '2026-10-07' },
    CA_KHAC: null,
  });
  assert.equal(coversDate(spans.CA_TrH, '2026-10-06'), true, 'ngày trống ở giữa là trống thật');
  assert.equal(coversDate(spans.CA_TrH, '2026-10-09'), false);
  assert.equal(coversDate(spans.CA_KHAC, '2026-10-07'), false);
  assert.equal(coversDate(undefined, '2026-10-07'), false);
});

test('bộ nhớ một máy bị xoá giữa tuần: các ngày trước đó GIỮ phần cũ của máy, không chốt', () => {
  // Đúng kịch bản người duyệt dựng (merge-probe.mjs): CA_TIH chỉ còn sự kiện từ
  // thứ 4. Trước đây thứ 2, thứ 3 mất hết lượt chấm của CA_TIH.
  const mon = '2026-10-05'; const tue = '2026-10-06'; const wed = '2026-10-07';
  const existingDocs = {
    [mon]: twoDevDoc({ 1: { name: 'x', times: ['07:00'] } }, { 2: { name: 'y', times: ['11:00'] } }),
    [tue]: twoDevDoc({ 1: { name: 'x', times: ['07:00'] } }, { 2: { name: 'y', times: ['11:00'] } }),
    [wed]: null,
  };
  const { out, coveredDates, suspects } = runMerge({
    rangeDates: [mon, tue, wed], existingDocs,
    events: [ev('CA_TrH', '1', mon, '07:00'), ev('CA_TrH', '1', tue, '07:00'), ev('CA_TrH', '1', wed, '07:00'), ev('CA_TIH', '2', wed, '11:00')],
  });
  assert.deepEqual(suspects, []);
  for (const d of [mon, tue]) {
    assert.deepEqual(tapsOf(out[d].final.people), ['1@07:00', '2@11:00'], `mất lượt chấm ngày ${d}`);
    assert.deepEqual(out[d].final.byDevice.CA_TIH, existingDocs[d].byDevice.CA_TIH);
    assert.equal(out[d].merged.complete, false, 'chưa đủ máy phủ ngày này thì không ghi complete: true');
  }
  assert.deepEqual(coveredDates, [wed], 'chỉ chốt ngày mọi máy đều trả dữ liệu');
  assert.equal(out[wed].merged.complete, true);
});

test('máy lệch giờ mất các ngày gần nhất: không xoá phần đã có của máy ở những ngày đó', () => {
  const d1 = '2026-10-07'; const d2 = '2026-10-08';
  const existingDocs = {
    [d1]: twoDevDoc({ 1: { name: '', times: ['07:00'] } }, { 2: { name: '', times: ['11:00'] } }),
    [d2]: twoDevDoc({ 1: { name: '', times: ['07:00'] } }, { 2: { name: '', times: ['11:00'] } }),
  };
  const { out, coveredDates } = runMerge({
    rangeDates: [d1, d2], existingDocs,
    events: [ev('CA_TrH', '1', d1, '07:00'), ev('CA_TrH', '1', d2, '07:00'), ev('CA_TIH', '2', d1, '11:00')],
  });
  assert.deepEqual(out[d2].final.byDevice.CA_TIH, { 2: { name: '', times: ['11:00'] } });
  assert.deepEqual(coveredDates, [d1]);
});

test('document dạng cũ + máy trả 0 lượt cả khoảng (lần chạy đầu sau nâng cấp): không mất, máy bị nghi', () => {
  // Kịch bản người duyệt: mọi document trong khoảng là dạng cũ, CA_TIH lệch giờ
  // trả 0 lượt. Trước đây nhánh "dạng cũ + đủ máy" ghi đè bằng phần của CA_TrH.
  const d1 = '2026-10-07'; const d2 = '2026-10-08';
  const legacy = { people: { 1: { name: 'An', times: ['07:00'] }, 2: { name: 'Bình', times: ['11:30'] } } };
  const existingDocs = { [d1]: legacy, [d2]: legacy };
  const events = [ev('CA_TrH', '1', d1, '07:00'), ev('CA_TrH', '1', d2, '07:00')];
  const fresh = groupByDateDevice(events).byDate;
  assert.deepEqual(findSuspectDevices({ okDevices: DEVICES, freshByDate: fresh, existingDocs }), [{ name: 'CA_TIH', knownPeople: 2 }]);
  // Ngày không có máy nào khác trả dữ liệu thì không đủ căn cứ để nghi.
  assert.deepEqual(findSuspectDevices({ okDevices: ['CA_TIH'], freshByDate: {}, existingDocs }), []);

  const { out, suspects } = runMerge({ rangeDates: [d1, d2], existingDocs, events });
  assert.deepEqual(suspects, ['CA_TIH']);
  for (const d of [d1, d2]) {
    assert.ok(tapsOf(out[d].final.people).includes('2@11:30'), `mất lượt chấm của máy lệch giờ ngày ${d}`);
    assert.equal(out[d].final.byDevice, undefined, 'chưa đủ máy thì giữ dạng cũ');
  }
  // Kể cả khi máy không bị loại: máy 0 lượt không phủ ngày nào nên vẫn không mất.
  for (const d of [d1, d2]) {
    const m = mergeDayDoc({ date: d, existing: legacy, fresh: fresh[d], okDevices: DEVICES, coveringDevices: ['CA_TrH'], configDevices: DEVICES, syncedAt: AT });
    assert.equal(m, null, 'không thêm được gì thì không ghi');
  }
});

test('document dạng cũ ngoài bộ nhớ của mọi máy (lấy bù --days 30): giữ nguyên, không ghi people rỗng', () => {
  const legacy = { people: { 1: { name: 'x', times: ['07:00'] } } };
  // Đúng lời gọi người duyệt dùng: đủ máy, không máy nào có dữ liệu ngày đó.
  assert.equal(mergeDayDoc({ date: '2026-09-10', existing: legacy, fresh: {}, okDevices: DEVICES, coveringDevices: [], configDevices: DEVICES, syncedAt: AT }), null);
  const { out, coveredDates } = runMerge({
    rangeDates: ['2026-09-10', '2026-09-11'],
    existingDocs: { '2026-09-10': legacy },
    events: [ev('CA_TrH', '1', '2026-09-11', '07:00'), ev('CA_TIH', '2', '2026-09-11', '11:00')],
  });
  assert.equal(out['2026-09-10'].merged, null);
  assert.deepEqual(out['2026-09-10'].final, legacy);
  assert.deepEqual(coveredDates, ['2026-09-11']);
});

test('máy trả lời được nhưng 0 lượt trong ngày (chạy --days 1): ngày đó không được chốt, phần cũ còn nguyên', () => {
  // Lần 08:15 đã ghi phần của CA_TIH; lúc 13:45 máy này lệch ngày nên trả 0 lượt.
  const existing = twoDevDoc({ 1: { name: '', times: ['07:00'] } }, { 2: { name: '', times: ['07:05'] } });
  const { out, coveredDates } = runMerge({ rangeDates: [D], existingDocs: { [D]: existing }, events: [ev('CA_TrH', '1', D, '11:30')] });
  assert.deepEqual(coveredDates, [], 'không có mốc chốt => pha cảnh báo dừng ở bước "không đủ máy"');
  assert.deepEqual(out[D].final.byDevice.CA_TIH, existing.byDevice.CA_TIH);
  assert.deepEqual(out[D].final.byDevice.CA_TrH, { 1: { name: '', times: ['11:30'] } }, 'máy trả dữ liệu thì vẫn thay phần của nó');
  assert.equal(out[D].final.complete, false);
});

test('merge: máy có lượt chấm trong ngày mà nơi gọi quên khai là phủ => vẫn nhận dữ liệu mới', () => {
  const doc = mergeDayDoc({
    date: D, existing: null, fresh: { CA_TrH: { 1: { name: '', times: ['07:00'] } } },
    okDevices: DEVICES, coveringDevices: [], configDevices: DEVICES, syncedAt: AT,
  });
  assert.deepEqual(doc.people, { 1: { name: '', times: ['07:00'] } });
  assert.equal(doc.complete, false);
});

test('buildSyncSettings: đủ máy nhưng chỉ đóng dấu các ngày mọi máy cùng phủ; ngày khác giữ dấu cũ', () => {
  const DEL = Symbol('del');
  const run = buildSyncSettings({
    agentVersion: 'v', runEndAt: AT, complete: true,
    existing: { coverage: { '2026-10-05': 'cũ', '2026-10-06': 'cũ' } },
    deviceResults: DEVICES.map(name => ({ name, ok: true, at: AT, events: 1, error: null })),
    configDevices: DEVICES, coveredDates: ['2026-10-07', D], today: D, del: DEL,
  });
  assert.deepEqual(run.coverage, { '2026-10-07': AT, [D]: AT });
  assert.equal(run.lastRunComplete, true);

  // Đủ máy mà không ngày nào được phủ: KHÔNG được có `coverage: {}` — ghi
  // set-merge một map rỗng là xoá sạch mọi mốc chốt đang có trên Firestore.
  const none = buildSyncSettings({
    agentVersion: 'v', runEndAt: AT, complete: true,
    existing: { coverage: { '2026-10-07': 'cũ', [D]: 'cũ' } },
    deviceResults: DEVICES.map(name => ({ name, ok: true, at: AT, events: 0, error: null })),
    configDevices: DEVICES, coveredDates: [], today: D, del: DEL,
  });
  assert.equal('coverage' in none, false);
  assert.equal(none.lastRunComplete, true);
});
