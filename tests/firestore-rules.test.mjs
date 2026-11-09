// Firestore rules của báo hủy và đăng ký sự kiện khớp với cách trang web ghi: nhân viên
// chỉ tạo được tài liệu của chính mình (mã {uid}_...), quản trị làm được cho mọi người.
// Không có trình giả lập rules trong dự án nên đối chiếu văn bản rules với mã nguồn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const rules = read('../firestore.rules');
const block = name => {
  const start = rules.indexOf(`match /${name}/`);
  assert.ok(start >= 0, `thiếu match /${name}/`);
  return rules.slice(start, rules.indexOf('\n    }', start));
};

test('báo hủy: nhân viên chỉ tạo báo hủy của chính mình; sửa, xóa chỉ quản trị', () => {
  const cancel = block('cancel_registrations');
  assert.match(cancel, /allow read: if isSignedIn\(\) && \(resource == null \|\| resource\.data\.userId == request\.auth\.uid \|\| isAdmin\(\)\);/);
  assert.match(cancel, /allow create: if isSignedIn\(\) && \(isAdmin\(\) \|\| \(\s*request\.resource\.data\.userId == request\.auth\.uid &&\s*cancelId == request\.auth\.uid \+ '_' \+ request\.resource\.data\.cancelDate\s*\)\);/);
  assert.match(cancel, /allow update, delete: if isAdmin\(\);/);
  assert.doesNotMatch(cancel, /allow (read, )?write/, 'không còn quyền ghi chung cho mọi người đã đăng nhập');

  // Trang báo hủy ghi đúng dạng rules cho phép, và chỉ tạo mới (đã kiểm tra trùng ngày trước).
  const page = read('../src/pages/ScheduleMonth.tsx');
  assert.match(page, /doc\(db, 'cancel_registrations', `\$\{user\.uid\}_\$\{dateStr\}`\)/);
  assert.match(page, /userId: user\.uid,/);
  assert.match(page, /cancelDate: dateStr,/);
  assert.doesNotMatch(page, /(updateDoc|deleteDoc)\([^)]*cancel_registrations/);
  // Hủy ăn người nghỉ việc (quản trị) cũng ghi {uid}_{ngày}.
  assert.match(read('../src/lib/resignationCancel.ts'), /const id = `\$\{registration\.userId\}_\$\{date\}`;/);
});

test('đăng ký sự kiện: nhân viên chỉ tạo/sửa đăng ký của chính mình', () => {
  const event = block('event_registrations');
  assert.match(event, /allow create, update: if isSignedIn\(\) && \(isAdmin\(\) \|\| \(\s*\(resource == null \|\| resource\.data\.userId == request\.auth\.uid\) &&\s*request\.resource\.data\.userId == request\.auth\.uid &&\s*eventRegId == request\.auth\.uid \+ '_' \+ request\.resource\.data\.eventId\s*\)\);/);
  assert.doesNotMatch(event, /allow (read, )?write/);
  const page = read('../src/pages/ScheduleEvent.tsx');
  assert.match(page, /doc\(db, 'event_registrations', `\$\{user\.uid\}_\$\{evt\.id\}`\), \{\s*userId: user\.uid,\s*eventId: evt\.id,/);
});

test('không còn collection nào cho mọi người đã đăng nhập ghi tài liệu của người khác', () => {
  assert.doesNotMatch(rules, /allow read, write: if isSignedIn\(\) && \(resource == null/);
});
