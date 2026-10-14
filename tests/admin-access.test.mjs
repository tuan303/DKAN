import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let adminAccess;

test.before(async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/adminAccess.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  adminAccess = module.exports;
});

test('nhận diện hai quản trị cao nhất với email hoa/thường và khoảng trắng', () => {
  for (const email of ['tuantm@hoangmaistarschool.edu.vn', 'tuyetkta@hoangmaistarschool.edu.vn']) {
    assert.equal(adminAccess.isSuperAdmin(email), true, email);
    assert.equal(adminAccess.isSuperAdmin(email.toUpperCase()), true, email);
    assert.equal(adminAccess.isSuperAdmin(` \t${email.toUpperCase()}\n`), true, email);
  }
  assert.equal(adminAccess.isSuperAdmin('tuan303@gmail.com'), true);
});

test('không nhận tài khoản thường hoặc email vắng mặt là quản trị cao nhất', () => {
  for (const email of [undefined, null, '', '   ', 'teacher@hoangmaistarschool.edu.vn', 'tuantm@hoangmaistarschool.edu.vn.example.com']) {
    assert.equal(adminAccess.isSuperAdmin(email), false, String(email));
  }
});

test('danh sách quản trị cao nhất dùng chung khớp Firestore rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const fn = rules.slice(rules.indexOf('function isAdmin()'), rules.indexOf('match /staff/'));
  const match = fn.match(/email\s+in\s+\[([^\]]+)\]/);
  assert.ok(match, 'không tìm thấy danh sách quản trị cao nhất trong isAdmin()');
  const emails = [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
  assert.deepEqual([...adminAccess.SUPER_ADMINS].sort(), emails.sort());
  assert.equal(Object.isFrozen(adminAccess.SUPER_ADMINS), true);
});
