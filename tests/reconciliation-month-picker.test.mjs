// Pure month controls: no Firestore, auth, device or email access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vnParts } from '../agent/lib/meal-rules.mjs';

const require = createRequire(import.meta.url);
let ReconciliationMonthPicker, reconciliationMonthOptions;
test.before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/ReconciliationMonthPicker.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    jsx: 'automatic', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  ({ ReconciliationMonthPicker, reconciliationMonthOptions } = module.exports);
});

const render = (selectedMonth, today = '2026-11-02') => renderToStaticMarkup(createElement(ReconciliationMonthPicker,
  { selectedMonth, today, onMonthChange() {} }));

test('November offers October and September directly, including a selected past month', () => {
  assert.deepEqual(reconciliationMonthOptions('2026-11-02', '2026-10'), ['2026-11', '2026-10', '2026-09']);
  const html = render('2026-10');
  assert.match(html, /for="reconciliation-month"[^>]*>Tháng đối soát/);
  assert.match(html, /value="2026-10" selected=""/);
  assert.match(html, /Tháng 11\/2026 · Tháng hiện tại/);
  assert.match(html, /Tháng 10\/2026 · Tháng trước/);
  assert.match(html, /Tháng 09\/2026 · Hai tháng trước/);
  assert.match(html, /aria-describedby="reconciliation-month-hint"/);
  assert.match(html, /báo cáo Excel dùng tháng đã chọn/);
});

test('calendar arithmetic crosses year and leap-month boundaries without losing the last two months', () => {
  assert.deepEqual(reconciliationMonthOptions('2027-01-01'), ['2027-01', '2026-12', '2026-11']);
  assert.deepEqual(reconciliationMonthOptions('2028-03-31'), ['2028-03', '2028-02', '2028-01']);
  assert.match(render('2026-12', '2027-01-01'), /value="2026-12" selected=""/);
});

test('Vietnam midnight chooses the new month even while the same instant is still the previous UTC month', () => {
  const date = vnParts(new Date('2026-10-31T17:01:00Z')).date;
  assert.equal(date, '2026-11-01');
  assert.deepEqual(reconciliationMonthOptions(date), ['2026-11', '2026-10', '2026-09']);
});

test('preserves a valid out-of-window selection without duplicating options or accepting malformed months', () => {
  assert.deepEqual(reconciliationMonthOptions('2026-11-02', '2026-07'), ['2026-11', '2026-10', '2026-09', '2026-07']);
  assert.match(render('2026-07'), /value="2026-07" selected=""/);
  assert.deepEqual(reconciliationMonthOptions('2026-11-02', '2027-01'), ['2026-11', '2026-10', '2026-09', '2027-01']);
  for (const invalid of ['2026-00', '2026-13', '2026-9', '2026-10-01', 'not-a-month', '<script>']) {
    assert.deepEqual(reconciliationMonthOptions('2026-11-02', invalid), ['2026-11', '2026-10', '2026-09']);
  }
  for (const invalid of ['2026-02-30', '2026-13-01', 'not-a-date']) assert.deepEqual(reconciliationMonthOptions(invalid), []);
});

function findElement(node, type) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === type) return node;
  return [node.props?.children].flat(Infinity).map(child => findElement(child, type)).find(Boolean);
}

test('selection and current-month action call the parent with valid month keys and do not depend on loading state', () => {
  const changes = [];
  const tree = ReconciliationMonthPicker({ selectedMonth: '2026-10', today: '2026-11-02', onMonthChange: month => changes.push(month) });
  const select = findElement(tree, 'select');
  const button = findElement(tree, 'button');
  assert.equal(select.props.disabled, undefined);
  select.props.onChange({ target: { value: '2026-09' } });
  select.props.onChange({ target: { value: '2026-13' } });
  button.props.onClick();
  assert.deepEqual(changes, ['2026-09', '2026-11']);
  assert.equal(button.props.disabled, false);
  const current = ReconciliationMonthPicker({ selectedMonth: '2026-11', today: '2026-11-02', onMonthChange() {} });
  assert.equal(findElement(current, 'button').props.disabled, true);
});
