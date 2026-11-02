// SSR executes no effects; Firestore is stubbed so no production reads/writes occur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
let MealReconciliation;
test.before(async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/MealReconciliation.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'no-live-firebase', setup(builder) {
      builder.onResolve({ filter: /lib\/firebase$/ }, () => ({ path: 'firebase', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const db = {};' }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  ({ MealReconciliation } = module.exports);
});
const render = overrides => renderToStaticMarkup(createElement(MealReconciliation, {
  registrations: [], cancelations: [], selectedMonth: '2026-10', onMonthChange() {},
  registrationDataReady: false, registrationDataError: null, onReloadRegistrations() {}, ...overrides,
}));

test('past month selector stays visible while registrations and checkins load; report/export is withheld', () => {
  const html = render({});
  assert.match(html, /id="reconciliation-month"/);
  assert.match(html, /value="2026-10" selected=""/);
  assert.match(html, /Đang tải đăng ký, hủy ăn và lượt chấm tháng 10\/2026/);
  assert.doesNotMatch(html, /Xuất Excel/);
  assert.doesNotMatch(html, /Suất đã đăng ký/);
});

test('registration read failure keeps month selection and retry control without publishing partial numbers', () => {
  const html = render({ registrationDataError: 'Chưa tải được đăng ký của tháng đã chọn.' });
  assert.match(html, /id="reconciliation-month"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Kết quả đối soát và xuất Excel tạm dừng/);
  assert.doesNotMatch(html, /Xuất Excel/);
  assert.doesNotMatch(html, /Đang tải đăng ký, hủy ăn và lượt chấm tháng/);
});
