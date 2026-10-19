import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildFromCheckins, reconcile } from '../agent/lib/meal-rules.mjs';

const require = createRequire(import.meta.url);
let helpers, OffDayCheckinsReference;
const compile = async (entry, plugins = []) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent', plugins,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
};

test.before(async () => {
  helpers = await compile('../src/lib/mealReference.ts');
  ({ OffDayCheckinsReference } = await compile('../src/components/MealReconciliation.tsx', [{
    name: 'no-live-firebase', setup(builder) {
      builder.onResolve({ filter: /lib\/firebase$/ }, () => ({ path: 'firebase', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const db = {};' }));
    },
  }]));
});

const date = '2026-10-19';
const record = (employeeId, times = ['07:05', '12:23'], name = 'Nhân viên mẫu') =>
  buildFromCheckins([{ date, people: { [employeeId]: { name, times } } }]).byDate[date][employeeId];

test('ngày tham khảo chỉ gồm ngày nghỉ/cuối tuần có giờ chấm thực tế, không gồm ngày tương lai', () => {
  const byDate = {
    '2026-10-16': { '123456': record('123456') },
    '2026-10-17': { '123456': record('123456', ['16:05']) },
    '2026-10-18': { '123456': record('123456', []) },
    [date]: { '123456': record('123456') },
    '2026-10-20': { '123456': record('123456') },
  };
  assert.deepEqual(helpers.referenceCheckinDates(byDate, [date, '2026-10-20'], date), [date, '2026-10-17']);
});

test('bảng tham khảo giữ giờ theo bữa, loại Bếp Vina, bảo vệ mã có đăng ký và hỗ trợ tìm kiếm', () => {
  const data = {
    '123456': record('123456', ['07:05', '12:23', '16:05'], 'Nguyễn Văn A'),
    '234567': record('234567', ['12:25'], 'Trần Thị B'),
    '9': record('9'),
    'ABC1': record('ABC1'),
    '345678': record('345678'),
  };
  const { rows, excludedCount } = helpers.referenceCheckinRows(data, [{ employeeId: 'ABC1' }], ['345678']);
  assert.equal(excludedCount, 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(row => row.employeeId === '123456').unrecognized, ['16:05']);
  assert.equal(rows.find(row => row.employeeId === '123456').lunch, '12:23');
  assert.equal(helpers.filterReferenceCheckins(rows, '  nguyễn ')[0].employeeId, '123456');
  assert.equal(helpers.filterReferenceCheckins(rows, '234567')[0].name, 'Trần Thị B');
  assert.equal(helpers.filterReferenceCheckins(rows, 'không tồn tại').length, 0);
});

test('xem lượt chấm ngày nghỉ không sinh suất đăng ký, chưa chấm, vi phạm hay lượt hợp lệ tháng', () => {
  const data = buildFromCheckins([{ date, people: { '123456': { name: 'Mẫu', times: ['07:05', '12:23'] } } }]);
  const registration = { employeeId: '123456', breakfastCount: 20, lunchCount: 20 };
  const observed = helpers.referenceCheckinRows(data.byDate[date], [registration], []);
  assert.equal(observed.rows.length, 1);
  const result = reconcile({ byDate: data.byDate, dates: [date], registrations: [registration], cancelations: [], offDays: [date] });
  for (const key of ['registered', 'tapped', 'missing', 'extra', 'unrecognized', 'invalidRegs']) assert.deepEqual(result[key], [], key);
});

test('thẻ tham khảo hiển thị 19/10 và giờ 12:23 kèm phạm vi chỉ xem, không xuất hiện khi không có ngày nghỉ có lượt', () => {
  const props = { byDate: { [date]: { '123456': record('123456', ['12:23'], '<Nhân viên>') } }, offDays: [date], registrations: [], excludedIds: [], today: date };
  const html = renderToStaticMarkup(createElement(OffDayCheckinsReference, props));
  assert.match(html, /Lượt chấm ngày nghỉ \/ ăn sự kiện/);
  assert.match(html, /Thứ 2, 19\/10/);
  assert.match(html, /12:23/);
  assert.match(html, /Chỉ tham khảo, không tính vào suất ăn tháng hoặc vi phạm/);
  assert.match(html, /&lt;Nhân viên&gt;/);
  assert.doesNotMatch(html, /<Nhân viên>/);
  assert.equal(renderToStaticMarkup(createElement(OffDayCheckinsReference, { ...props, offDays: [] })), '');
});

test('bảng tham khảo giới hạn 50 người mỗi trang và có điều hướng khi nhiều người', () => {
  const records = Object.fromEntries(Array.from({ length: 51 }, (_, index) => {
    const employeeId = String(100000 + index);
    return [employeeId, record(employeeId, ['12:23'], `Người ${String(index).padStart(2, '0')}`)];
  }));
  const html = renderToStaticMarkup(createElement(OffDayCheckinsReference, { byDate: { [date]: records }, offDays: [date], registrations: [], excludedIds: [], today: date }));
  assert.equal((html.match(/<li /g) || []).length, 50);
  assert.match(html, /1–50 \/ 51 người/);
  assert.match(html, /Trang tham khảo sau/);
  assert.doesNotMatch(html, /Người 50</);
});
