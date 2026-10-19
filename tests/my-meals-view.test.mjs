import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { evaluatePersonDay, mealDaysOfMonth } from '../agent/lib/meal-rules.mjs';

const require = createRequire(import.meta.url);
let MyMealsView, personalHistoryDates;

test.before(async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/pages/MyMeals.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    jsx: 'automatic', logLevel: 'silent',
    plugins: [{
      name: 'no-live-services',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/(lib\/firebase|components\/)/ }, args => ({ path: args.path, namespace: 'test-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: `
          export const auth = {}, db = {};
          export const Header = () => null, Navigation = () => null, Footer = () => null, SurveyBanner = () => null;
        ` }));
      },
    }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  ({ MyMealsView } = module.exports);
  const history = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/mealHistory.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  const historyModule = { exports: {} };
  new Function('module', 'exports', history.outputFiles[0].text)(historyModule, historyModule.exports);
  ({ personalHistoryDates } = historyModule.exports);
});

const todayIso = '2026-10-19';
const registration = { employeeId: 'TEST001', month: '2026-10', breakfastCount: 22, lunchCount: 22 };
const day = date => ({
  hold: null,
  result: evaluatePersonDay({ date, registration, times: [], coverageAt: null, now: new Date('2026-10-19T15:00:00+07:00') }),
});
const props = () => ({
  loading: false, error: null, profile: { fullName: 'Tài khoản kiểm thử', employeeId: 'TEST001' },
  todayIso, today: { ...day(todayIso), registration }, sync: null, missedSyncAt: null, conflict: null,
  month: '2026-10', monthOptions: ['2026-10', '2026-09', '2026-08'], onMonthChange() {},
  monthData: { registration, days: mealDaysOfMonth('2026-10', [], todayIso).reverse().map(day), conflict: null, closedFrom: null },
});
const render = overrides => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MyMealsView, { ...props(), ...overrides })));

test('ngày 19/10 vẫn hiện ở Hôm nay và đầu lịch sử khi chưa có dữ liệu máy', () => {
  const html = render({});
  assert.match(html, /id="mm-today-title"/);
  assert.match(html, /Thứ 2, 19\/10/);
  const list = html.slice(html.indexOf('<ol'));
  assert.match(list.slice(0, list.indexOf('</li>')), /Thứ 2, 19\/10/);
  assert.ok(list.indexOf('Thứ 2, 19/10') < list.indexOf('Thứ 6, 16/10'));
  const today = html.slice(html.indexOf('aria-labelledby="mm-today-title"'), html.indexOf('</section>'));
  assert.match(today, /Chưa có dữ liệu/);
  assert.doesNotMatch(today, />Chưa chấm</);
});

test('lỗi tải lại không che ngày hiện tại, lịch sử hoặc nút thử tải lại', () => {
  const html = render({ refreshError: { title: 'Không kết nối được máy chủ', detail: 'Vui lòng kiểm tra kết nối mạng.' }, onReload() {} });
  assert.match(html, /Chưa tải được dữ liệu mới/);
  assert.match(html, /Thứ 2, 19\/10/);
  assert.match(html, /id="mm-history-title"/);
  assert.match(html, />Tải lại</);
  assert.doesNotMatch(html, />Thử lại</);
});

test('lỗi lần tải đầu vẫn hiển thị lỗi và nút Thử lại', () => {
  const html = render({ error: { title: 'Không kết nối được máy chủ', detail: 'Vui lòng kiểm tra kết nối mạng.' }, onRetry() {} });
  assert.match(html, /role="alert"/);
  assert.match(html, /Không kết nối được máy chủ/);
  assert.match(html, />Thử lại</);
  assert.doesNotMatch(html, /id="mm-today-title"/);
});

test('lịch sử bao gồm ngày nghỉ và cuối tuần có lượt chấm, không thêm ngày trống hoặc tương lai', () => {
  const dates = personalHistoryDates('2026-10', ['2026-10-19', '2026-10-20'], {
    '2026-10-19': ['12:23'], '2026-10-18': ['15:00'], '2026-10-17': [],
    '2026-10-20': ['12:00'], '2026-09-30': ['12:00'], '2026-10-99': ['12:00'],
    '2026-10-19bad': ['12:00'],
  }, todayIso);
  assert.equal(dates[0], todayIso);
  assert.ok(dates.includes('2026-10-18'));
  for (const invalid of ['2026-10-17', '2026-10-20', '2026-09-30', '2026-10-99', '2026-10-19bad']) assert.ok(!dates.includes(invalid));
  assert.equal(dates.length, new Set(dates).size);
  assert.ok(dates.includes('2026-10-16'), 'ngày ăn thường chưa có lượt chấm vẫn xuất hiện');
});

test('ngày ăn sự kiện hiện giờ chấm để tham khảo nhưng không tăng tổng suất tháng hoặc vi phạm', () => {
  const reference = {
    hold: null,
    result: evaluatePersonDay({ date: todayIso, registration, offDays: [todayIso], times: ['12:23', '15:00'], now: new Date('2026-10-19T15:49:00+07:00') }),
  };
  const html = render({
    today: { ...reference, registration },
    monthData: { registration, days: [reference], conflict: null, closedFrom: null },
  });
  assert.match(html, /Thứ 2, 19\/10/);
  assert.match(html, /12:23/);
  assert.match(html, /Tham khảo · không tính suất tháng/);
  assert.match(html, /không tính vi phạm/);
  assert.match(html, /Tính trên <strong class="tabular">0<\/strong> bữa/);
  assert.doesNotMatch(html, /<strong class="tabular">1<\/strong> lượt chấm ngoài khung giờ/);
  assert.equal(reference.result.meals.lunch.code, 'off_day');
});
