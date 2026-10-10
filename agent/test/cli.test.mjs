// Test cho tham số dòng lệnh, cấu hình alerts, và vài ràng buộc của chính
// script đồng bộ (bản, không nạp firebase-admin sớm) — gõ sai tham số mà vẫn
// chạy được thì có thể gửi email thật cho cả trường.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, readAlertsConfig, ALERT_DEFAULTS, KNOWN_FLAGS } from '../lib/cli.mjs';
import { redact } from '../lib/common.mjs';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-10-09';
const GOOD_SECRET = 'k9Qw2LmZ7xR4tY8uI1oP5aS3dF6gH0jK';

test('parseArgs: các cờ cũ vẫn nhận như trước', () => {
  const a = parseArgs(['--days', '30', '--dry-run', '--debug', '--quiet'], { today: TODAY });
  assert.deepEqual(a, { days: 30, dryRun: true, debug: true, quiet: true, sendAlerts: false, alertsDate: null, errors: [] });
  assert.equal(parseArgs([], { today: TODAY }).days, null, 'không có --days thì theo config');
  assert.equal(parseArgs(['--days'], { today: TODAY }).days, null, '--days không kèm số thì theo config');
  assert.equal(parseArgs(['--days', 'abc'], { today: TODAY }).errors.length, 1);
  assert.equal(parseArgs(['--days', '0'], { today: TODAY }).errors.length, 1);
  assert.equal(parseArgs(['--days', '1.5'], { today: TODAY }).errors.length, 1);
});

test('parseArgs: --send-alerts và --alerts-date chỉ để xem thử', () => {
  assert.equal(parseArgs(['--send-alerts'], { today: TODAY }).sendAlerts, true);

  const ok = parseArgs(['--dry-run', '--send-alerts', '--alerts-date', '2026-10-08'], { today: TODAY });
  assert.deepEqual([ok.alertsDate, ok.errors], ['2026-10-08', []]);
  assert.equal(parseArgs(['--dry-run', '--send-alerts', '--alerts-date', TODAY], { today: TODAY }).alertsDate, TODAY);

  // Thiếu --dry-run: không bao giờ được gửi thật cho ngày cũ.
  const real = parseArgs(['--send-alerts', '--alerts-date', '2026-10-08'], { today: TODAY });
  assert.equal(real.alertsDate, null);
  assert.equal(real.errors.length, 1);
  assert.equal(parseArgs(['--dry-run', '--alerts-date', '2026-10-08'], { today: TODAY }).errors.length, 1);
  assert.equal(parseArgs(['--dry-run', '--send-alerts', '--alerts-date', '2026-02-30'], { today: TODAY }).errors.length, 1);
  assert.equal(parseArgs(['--dry-run', '--send-alerts', '--alerts-date', '08/10/2026'], { today: TODAY }).errors.length, 1);
  assert.equal(parseArgs(['--dry-run', '--send-alerts', '--alerts-date'], { today: TODAY }).errors.length, 1);
  assert.equal(parseArgs(['--dry-run', '--send-alerts', '--alerts-date', '2026-10-10'], { today: TODAY }).errors.length, 1, 'ngày tương lai');
});

test('readAlertsConfig: mặc định, khoá mẫu, khoá ngắn, khoá tốt', () => {
  const none = readAlertsConfig(undefined);
  assert.equal(none.cfg.enabled, false);
  assert.equal(none.cfg.endpoint, ALERT_DEFAULTS.endpoint);
  assert.equal(none.cfg.notBefore, '13:40');
  assert.equal(none.cfg.minExpected, 20);
  assert.equal(none.cfg.maxMissingRatio, 0.4);
  assert.equal(none.secretOk, false);

  const example = JSON.parse(readFileSync(join(AGENT, 'config.example.json'), 'utf8')).alerts;
  const ex = readAlertsConfig(example);
  assert.equal(ex.cfg.enabled, false, 'bản mẫu phải để tắt');
  assert.equal(ex.secretOk, false, 'khoá mẫu không được coi là khoá thật');
  assert.deepEqual(ex.errors, []);
  assert.deepEqual(ex.cfg.adminEmails, ['dinhduong@hoangmaistarschool.edu.vn', 'tuantm@hoangmaistarschool.edu.vn']);

  assert.equal(readAlertsConfig({ secret: 'ngan' }).secretOk, false);
  const good = readAlertsConfig({ ...example, enabled: true, secret: GOOD_SECRET });
  assert.equal(good.secretOk, true);
  assert.equal(good.cfg.enabled, true);
  // "true" dạng chuỗi không phải là bật
  assert.equal(readAlertsConfig({ enabled: 'true' }).cfg.enabled, false);
});

test('readAlertsConfig: kiểm tra endpoint, ngưỡng, email quản trị; không lộ khoá', () => {
  const secret = GOOD_SECRET;
  assert.equal(readAlertsConfig({ secret, endpoint: 'http://dkan.nshm.vn/api/meal-alerts' }).errors.length, 1, 'khoá không được đi qua http');
  assert.equal(readAlertsConfig({ secret, endpoint: 'http://localhost:3000/api/meal-alerts' }).errors.length, 0);
  assert.equal(readAlertsConfig({ secret, endpoint: 'không phải url' }).errors.length, 1);
  assert.equal(readAlertsConfig({ secret, notBefore: '1:40' }).errors.length, 1);
  assert.equal(readAlertsConfig({ secret, maxMissingRatio: 0 }).errors.length, 1);
  assert.equal(readAlertsConfig({ secret, maxMissingRatio: 40 }).errors.length, 1);
  assert.equal(readAlertsConfig({ secret, minExpected: -1 }).errors.length, 1);

  const r = readAlertsConfig({ secret, adminEmails: ['x@gmail.com', 'a@hoangmaistarschool.edu.vn'] });
  assert.deepEqual(r.cfg.adminEmails, ['a@hoangmaistarschool.edu.vn']);
  assert.equal(r.warnings.length, 1);

  const bad = readAlertsConfig({ secret: 'abc123-bi-mat', endpoint: 'x', notBefore: 'y' });
  const text = JSON.stringify([bad.errors, bad.warnings, bad.secretProblem]);
  assert.equal(text.includes('abc123-bi-mat'), false, 'thông báo lỗi không được chứa khoá');
});

test('script đồng bộ: đúng bản, firebase-admin chỉ nạp muộn, lib không đụng tới Firebase', () => {
  const src = readFileSync(join(AGENT, 'sync-checkins.mjs'), 'utf8');
  assert.match(src, /const AGENT_VERSION = '2026-10-09\.1';/);
  assert.doesNotMatch(src, /^\s*import\s[^;]*['"]firebase-admin['"]/m, 'không import tĩnh firebase-admin');
  assert.match(src, /await import\('firebase-admin'\)/);
  // Pha cảnh báo chỉ chạy sau khi xong mọi việc với thiết bị.
  const deviceLoop = src.indexOf('await fetchDeviceEvents(device, range)');
  const runEnd = src.indexOf('const runEndAt = new Date().toISOString();');
  assert.ok(deviceLoop > 0 && runEnd > deviceLoop);
  assert.ok(src.indexOf('await runAlerts(') > runEnd);
  assert.ok(src.includes('AbortSignal.timeout(DEVICE_TIMEOUT_MS)'));

  for (const f of readdirSync(join(AGENT, 'lib'))) {
    const lib = readFileSync(join(AGENT, 'lib', f), 'utf8');
    assert.doesNotMatch(lib, /from\s+['"](firebase|node:)/, `lib/${f} phải thuần`);
  }

  const pkg = JSON.parse(readFileSync(join(AGENT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.startsWith('node --test'));
});

test('parseArgs: tham số lạ bị từ chối (gõ nhầm --dry-run không được thành chạy thật)', () => {
  for (const argv of [['--dryrun', '--send-alerts'], ['--dry_run'], ['-n'], ['--days=30'], ['dry-run'], ['--send-alert'], ['--help']]) {
    const a = parseArgs(argv, { today: TODAY });
    assert.equal(a.errors.length >= 1, true, argv.join(' '));
    assert.match(a.errors[0], /Tham số không hợp lệ/);
    assert.ok(KNOWN_FLAGS.every(f => a.errors[0].includes(f)), 'thông báo liệt kê đủ các tham số hợp lệ');
  }
  // Giá trị của --days / --alerts-date không bị coi là tham số lạ.
  const neg = parseArgs(['--days', '-5'], { today: TODAY });
  assert.equal(neg.errors.length, 1);
  assert.match(neg.errors[0], /Số ngày/);
  assert.deepEqual(parseArgs(['--quiet', '--days', '1', '--send-alerts'], { today: TODAY }).errors, [], 'đúng tham số của Task Scheduler');
  assert.deepEqual(parseArgs(['--dry-run', '--send-alerts', '--alerts-date', '2026-10-08'], { today: TODAY }).errors, []);
  assert.deepEqual(parseArgs(['--days', '--dry-run'], { today: TODAY }).errors, [], '--days không kèm số vẫn được như cũ');
});

test('readAlertsConfig: khoá có ký tự điều khiển / dấu cách / chữ có dấu bị từ chối, không lộ khoá', () => {
  for (const bad of [`${GOOD_SECRET}\nabc`, `${GOOD_SECRET}\u0000`, `${GOOD_SECRET} abc`, `${GOOD_SECRET}đ`, `${GOOD_SECRET}\tx`]) {
    const r = readAlertsConfig({ secret: bad });
    assert.equal(r.secretOk, false, JSON.stringify(bad));
    assert.match(r.secretProblem, /ký tự không dùng được/);
    assert.equal(JSON.stringify(r.secretProblem).includes(GOOD_SECRET), false);
  }
  // Khoá do lệnh PowerShell trong README sinh ra (64 ký tự hex) là hợp lệ.
  assert.equal(readAlertsConfig({ secret: 'a1'.repeat(32) }).secretOk, true);
});

test('redact: che khoá trong thông báo lỗi', () => {
  assert.equal(redact(`Headers.append: "Bearer ${GOOD_SECRET}" is an invalid header value.`, GOOD_SECRET), 'Headers.append: "Bearer ***" is an invalid header value.');
  assert.equal(redact('không có khoá', GOOD_SECRET), 'không có khoá');
  assert.equal(redact('x', ''), 'x');
  assert.equal(redact(undefined, GOOD_SECRET), '');
});

test('script đồng bộ: khoá chạy trước khi hỏi thiết bị; hẹn giờ thoát cưỡng bức trước khi đóng firebase-admin', () => {
  const src = readFileSync(join(AGENT, 'sync-checkins.mjs'), 'utf8');
  const lock = src.indexOf('await acquireLock(');
  assert.ok(lock > 0 && lock < src.indexOf('await fetchDeviceEvents(device, range)'));
  const timer = src.indexOf('setTimeout(() => process.exit(exitCode), 20_000).unref();');
  const close = src.indexOf('map(app => app?.delete())');
  assert.ok(timer > 0 && close > 0 && timer < close, 'treo ở bước đóng kết nối thì hẹn giờ vẫn phải có hiệu lực');
  // Vòng phân trang dùng giới hạn chung và kiểm tra dữ liệu bị cắt.
  assert.ok(src.includes('while (pages < MAX_PAGES)'));
  assert.ok(src.includes('pagingProblem({'));
  // Mọi thông báo lỗi pha cảnh báo đi qua redact trước khi in/ghi.
  assert.ok(src.includes('redact(err.message, ALERTS?.cfg.secret)'));
});
