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
let MyMealsView;

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
