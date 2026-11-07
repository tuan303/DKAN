// Handler TypeScript thật (api/meal-alerts.ts), thư 'staff-extra' — "chấm ăn chưa
// đăng ký". Graph được thay bằng fetch giả trước mọi request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

let build;
try { ({ build } = await import('esbuild')); }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('staff-extra: kiểm tra lượt chấm thật, nội dung cố định, escape, phân biệt lỗi chắc chưa gửi và chưa rõ', {
  skip: !build && 'Requires root development dependencies.',
}, async t => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../../api/meal-alerts.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const fixture = { MEAL_ALERT_SECRET: 'OFFLINE_EXTRA_ALERT_SECRET_20261106_LONG',
    MS_GRAPH_TENANT_ID: 'offline-tenant', MS_GRAPH_CLIENT_ID: 'offline-client', MS_GRAPH_CLIENT_SECRET: 'offline-secret',
    MS_GRAPH_SENDER: 'dinhduong@hoangmaistarschool.edu.vn', MEAL_ALERT_CC: 'dinhduong@hoangmaistarschool.edu.vn',
    PUBLIC_APP_URL: 'https://test.invalid' };
  const saved = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests = [];
  let mailFailure = false;
  let mailStatus = 202;
  Object.assign(process.env, fixture);
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://login.microsoftonline.com/offline-tenant/'))
      return new Response(JSON.stringify({ access_token: 'offline-token' }), { status: 200 });
    assert.equal(String(url), 'https://graph.microsoft.com/v1.0/users/dinhduong@hoangmaistarschool.edu.vn/sendMail');
    requests.push(JSON.parse(options.body));
    if (mailFailure) throw new TypeError('OFFLINE simulated network interruption');
    return new Response('', { status: mailStatus });
  };
  const alert = () => ({ to: 'a@hoangmaistarschool.edu.vn', fullName: '<script>A & B</script>', employeeId: '100001',
    meals: [{ meal: 'lunch', label: 'Bữa trưa', window: '10:00–13:30', time: '11:45', reason: 'no_registration' }], outOfWindow: [] });
  const invoke = async payload => {
    const response = { code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${fixture.MEAL_ALERT_SECRET}` },
      body: { kind: 'staff-extra', date: '2026-11-06', dateLabel: 'Thứ 6, 06/11/2026', alerts: [alert()], ...payload } }, response);
    return response;
  };
  try {
    await t.test('một thư riêng: tiêu đề "Cảnh báo", bữa, giờ chấm, lý do cố định; tên được escape', async () => {
      const response = await invoke({ subject: 'UNTRUSTED_SUBJECT', html: '<script>UNTRUSTED_HTML</script>' });
      assert.equal(response.code, 200);
      assert.deepEqual(response.body.results, [{ to: 'a@hoangmaistarschool.edu.vn', ok: true }]);
      const mail = requests.at(-1).message;
      assert.equal(mail.subject, '[DKAN] Cảnh báo: chấm ăn chưa đăng ký ngày 06/11/2026');
      assert.deepEqual(mail.toRecipients, [{ emailAddress: { address: 'a@hoangmaistarschool.edu.vn' } }]);
      assert.deepEqual(mail.ccRecipients, [{ emailAddress: { address: fixture.MEAL_ALERT_CC } }]);
      const html = mail.body.content;
      assert.ok(html.includes('Cảnh báo chấm ăn chưa đăng ký'), 'tiêu đề trong thư');
      assert.ok(html.includes('Bữa trưa'));
      assert.ok(html.includes('chấm lúc <strong>11:45</strong>'));
      assert.ok(html.includes('Chưa có đăng ký suất ăn tháng 11/2026.'), 'lý do nêu đúng tháng của ngày chấm');
      assert.ok(html.includes('không hiển thị trên trang “Chấm ăn của tôi”'));
      assert.ok(html.includes('liên hệ Bộ phận Dinh dưỡng'));
      assert.ok(html.includes('&lt;script&gt;A &amp; B&lt;/script&gt;'));
      assert.ok(html.includes('https://test.invalid/schedule'));
      assert.ok(!mail.subject.includes('UNTRUSTED_SUBJECT'));
      assert.ok(!html.includes('UNTRUSTED_HTML'));
      // Chỉ nêu sự việc: không có hình thức xử lý nào trong thư này.
      assert.ok(!html.includes('tạm dừng đăng ký'));
      assert.ok(!html.includes('vi phạm'));
    });
    await t.test('mỗi mã lý do ra đúng một câu cố định', async () => {
      const texts = {
        meal_not_registered: 'Đơn đăng ký suất ăn của tháng không gồm bữa này.',
        before_start: 'Ngày này trước ngày bắt đầu ăn ghi trên đơn đăng ký.',
        registered_late: 'Đơn đăng ký được nộp sau khi bữa ăn này đã kết thúc.',
        canceled: 'Đã báo hủy bữa này nhưng vẫn có lượt chấm.',
      };
      for (const [reason, text] of Object.entries(texts)) {
        const item = alert();
        item.meals = [{ meal: 'breakfast', label: 'Bữa sáng', window: '05:00–08:00', time: '07:05', reason }];
        const response = await invoke({ alerts: [item] });
        assert.equal(response.code, 200, reason);
        const html = requests.at(-1).message.body.content;
        assert.ok(html.includes(text), reason);
        assert.ok(html.includes('chấm lúc <strong>07:05</strong>'), reason);
      }
    });
    await t.test('người nhận, mã lý do và giờ chấm sai không bao giờ tới Graph', async () => {
      for (const modify of [
        item => { item.to = 'a@example.com'; },
        item => { item.meals[0].reason = 'ARBITRARY_REASON'; },
        item => { item.meals[0].reason = 'toString'; },
        item => { delete item.meals[0].time; },
        item => { item.meals[0].time = '14:00'; },
        item => { item.meals[0].time = '14:00'; item.meals[0].window = '14:00–15:00'; },
      ]) {
        const item = alert(); modify(item);
        const before = requests.length;
        const response = await invoke({ alerts: [item] });
        assert.equal(response.code, 400);
        assert.equal(requests.length, before);
      }
    });
    await t.test('Graph lỗi giữa chừng: trả maybeSent để agent không tự gửi lại', async () => {
      mailFailure = true;
      const response = await invoke({});
      assert.equal(response.code, 200);
      assert.equal(response.body.results[0].ok, false);
      assert.equal(response.body.results[0].maybeSent, true);
      mailFailure = false;
    });
    await t.test('Graph 5xx chưa rõ có gửi: không tự thử lại; Graph 4xx chắc từ chối: được thử lại', async () => {
      for (const [status, maybeSent] of [[503, true], [400, false], [401, false]]) {
        mailStatus = status;
        const response = await invoke({});
        assert.equal(response.code, 200);
        assert.equal(response.body.results[0].ok, false);
        assert.equal(response.body.results[0].maybeSent === true, maybeSent, `Graph ${status}`);
      }
      mailStatus = 202;
    });
    await t.test('thư thiếu chấm giữ hợp đồng cũ khi Graph lỗi giữa chừng', async () => {
      mailFailure = true;
      const item = alert();
      item.meals = [{ meal: 'lunch', label: 'Bữa trưa', window: '10:00–13:30' }];
      const response = await invoke({ kind: 'staff-missing', alerts: [item] });
      assert.equal(response.code, 200);
      assert.equal(response.body.results[0].ok, false);
      assert.equal(Object.hasOwn(response.body.results[0], 'maybeSent'), false);
      mailFailure = false;
    });
    await t.test('API bản mới không trả lỗi về `kind` cho staff-extra (agent dựa vào đó nhận ra API cũ)', async () => {
      const response = await invoke({ alerts: [] });
      assert.equal(response.code, 400);
      assert.doesNotMatch(response.body.error, /\bkind\b/);
      const wrong = await invoke({ kind: 'staff-unknown' });
      assert.equal(wrong.code, 400);
      assert.match(wrong.body.error, /staff-extra/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
