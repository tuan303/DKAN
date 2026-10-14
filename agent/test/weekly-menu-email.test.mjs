// Integration test for the actual API handler with Graph fully mocked. The
// standalone HAC agent has no esbuild dependency; run this test from a checkout
// with the web app's development dependencies to exercise the TypeScript API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

let build;
try {
  ({ build } = await import('esbuild'));
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

const WEEK = '2026-10-05';
const menuFixture = () => ({
  version: 1,
  weekId: WEEK,
  days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((date, i) => ({
    date, breakfast: i === 0 ? 'Phở bò' : 'Bún bung', main: 'Vịt chiên riềng', side: 'Đậu thịt sốt cà chua',
    vegetable: 'Cải thảo chần sốt dầu hào', soup: 'Canh rau dền nấu thịt bằm', rice: 'Cơm trắng', dessert: 'Quýt',
  })),
});

test('API survey-invite: thực đơn đúng tuần trong thân email và tương thích agent cũ', {
  skip: !build && 'Cần npm install ở gốc dự án để có esbuild kiểm tra API TypeScript.',
}, async t => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../../api/meal-alerts.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  });
  const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

  const fixtureEnv = {
    MEAL_ALERT_SECRET: 'test-only-secret-'.repeat(3), MS_GRAPH_TENANT_ID: 'test-only-tenant',
    MS_GRAPH_CLIENT_ID: 'test-only-client', MS_GRAPH_CLIENT_SECRET: 'test-only-value',
    MS_GRAPH_SENDER: 'dinhduong@hoangmaistarschool.edu.vn', MEAL_ALERT_CC: 'dinhduong@hoangmaistarschool.edu.vn',
    PUBLIC_APP_URL: 'https://test.invalid',
  };
  const previousEnv = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  Object.assign(process.env, fixtureEnv);
  Date.now = () => Date.parse('2026-10-09T08:00:00.000Z');
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith('https://login.microsoftonline.com/test-only-tenant/')) {
      requests.push({ type: 'token' });
      return new Response(JSON.stringify({ access_token: 'test-only-token' }), { status: 200 });
    }
    assert.equal(requestUrl, 'https://graph.microsoft.com/v1.0/users/dinhduong@hoangmaistarschool.edu.vn/sendMail');
    requests.push({ type: 'mail', body: JSON.parse(String(options.body)) });
    return new Response('', { status: 202 });
  };
  const invoke = async extra => {
    requests.length = 0;
    const res = {
      code: 0, body: null,
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; },
    };
    await handler({
      method: 'POST', headers: { authorization: `Bearer ${fixtureEnv.MEAL_ALERT_SECRET}` },
      body: { kind: 'survey-invite', weekId: WEEK, closesAt: '2026-10-12T05:00:00.000Z', bcc: ['test-only@hoangmaistarschool.edu.vn'], ...extra },
    }, res);
    return res;
  };

  try {
    await t.test('bảng năm ngày sau hạn trả lời; email giữ Bcc và liên kết xem thực đơn', async () => {
      const res = await invoke({ menu: menuFixture() });
      assert.equal(res.code, 200);
      assert.deepEqual(res.body, { results: [{ ok: true, count: 1 }] });
      assert.deepEqual(requests.map(r => r.type), ['token', 'mail']);
      const mail = requests[1].body.message;
      assert.deepEqual(mail.toRecipients, [{ emailAddress: { address: fixtureEnv.MS_GRAPH_SENDER } }]);
      assert.deepEqual(mail.bccRecipients, [{ emailAddress: { address: 'test-only@hoangmaistarschool.edu.vn' } }]);
      const html = mail.body.content;
      assert.match(html, /Phở bò/);
      assert.match(html, /Vịt chiên riềng/);
      assert.match(html, /05\/10\/2026/);
      assert.match(html, /09\/10\/2026/);
      assert.ok(html.indexOf('Thời hạn hoàn thành khảo sát') < html.indexOf('Dưới đây là thực đơn tuần'));
      assert.ok(html.indexOf('Dưới đây là thực đơn tuần') < html.lastIndexOf('Trân trọng,'));
      assert.match(html, /https:\/\/test\.invalid\/thuc-don\?tuan=2026-10-05/);
    });

    await t.test('escape HTML trong món ăn/ghi chú và bỏ metadata của tài liệu Firestore', async () => {
      const menu = menuFixture();
      menu.days[0].breakfast = '<img src=x onerror="alert(1)"> & Phở';
      menu.note = '<script>alert(2)</script> https://evil.invalid www.evil.invalid';
      menu.updatedBy = { email: 'ignored@outside.invalid' };
      const res = await invoke({ menu });
      assert.equal(res.code, 200);
      const html = requests[1].body.message.body.content;
      assert.match(html, /&lt;img/);
      assert.match(html, /&amp; Phở/);
      assert.match(html, /&lt;script&gt;/);
      assert.doesNotMatch(html, /<img src=x|<script>|ignored@outside/);
      assert.doesNotMatch(html, /https:\/\/evil\.invalid|www\.evil\.invalid/);
    });

    await t.test('agent cũ thiếu menu vẫn gửi một thư với liên kết thực đơn của đúng tuần', async () => {
      const res = await invoke({});
      assert.equal(res.code, 200);
      const html = requests[1].body.message.body.content;
      assert.match(html, /https:\/\/test\.invalid\/thuc-don\?tuan=2026-10-05/);
      assert.doesNotMatch(html, /Dưới đây là thực đơn tuần/);
      assert.equal(requests.filter(r => r.type === 'mail').length, 1);
    });

    await t.test('menu sai tuần/cấu trúc/nội dung/giới hạn bị từ chối trước mọi request Graph', async () => {
      const wrongWeek = menuFixture();
      wrongWeek.weekId = '2026-10-12';
      const wrongDate = menuFixture();
      wrongDate.days[4].date = '2026-10-10';
      const longDish = menuFixture();
      longDish.days[0].main = 'x'.repeat(5000);
      const empty = menuFixture();
      for (const day of empty.days) {
        for (const key of ['breakfast', 'main', 'side', 'vegetable', 'soup', 'rice', 'dessert']) day[key] = '';
      }
      for (const menu of [null, 'not-an-object', wrongWeek, wrongDate, longDish, empty, { ...menuFixture(), version: 2 }]) {
        const res = await invoke({ menu });
        assert.equal(res.code, 400, JSON.stringify(menu));
        assert.match(res.body.error, /menu/);
        assert.deepEqual(requests, [], 'không gọi Graph với thực đơn hỏng');
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
