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
const DISH_KEYS = ['breakfast', 'main', 'side', 'vegetable', 'soup', 'rice', 'dessert'];
const DISH_ROWS = [
  ['Phở bò', 'Bún bung ✅', 'Bánh khúc', 'Mì chũ nấu thịt, rau cải', 'Miến măng sườn mọc viên'],
  ['Vịt chiên riềng', 'Thịt nướng xá xíu', 'Cá sốt cà chua thì là', 'Bánh Hamburger kẹp thịt bò\n+ khoai tây chiên', 'Gà chao mắm tỏi'],
  ['Đậu thịt sốt cà chua', 'Cá chỉ chi rim mặn ngọt', 'Nem rán', 'Trứng ốp la', 'Thịt om chuối đậu'],
  ['Cải thảo chần sốt dầu hào', 'Su su + cà rốt xào tỏi', 'Bắp cải luộc', 'Salad Rau xanh với sốt dầu dấm kiểu Pháp', 'Củ quả luộc + muối vừng'],
  ['Canh rau dền nấu thịt băm', 'Canh bầu nấu cua', 'Canh củ quả hầm xương', 'Canh chua', 'Canh rau ngót'],
  ['Cơm trắng', 'Cơm trắng', 'Cơm trắng', 'Cơm trắng', 'Cơm trắng'],
  ['Quýt', 'Dưa hấu', 'Caramen', 'Thanh long', 'Sữa chua Vinamilk'],
];
const menuFixture = () => ({
  version: 1,
  weekId: WEEK,
  days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((date, i) => ({
    date, ...Object.fromEntries(DISH_KEYS.map((key, row) => [key, DISH_ROWS[row][i]])),
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
    await t.test('năm thẻ ngày nằm sau CTA và hạn trả lời; email giữ Bcc, liên kết và hỗ trợ mobile/Outlook', async () => {
      const menu = menuFixture();
      const res = await invoke({ menu });
      assert.equal(res.code, 200);
      assert.deepEqual(res.body, { results: [{ ok: true, count: 1 }] });
      assert.deepEqual(requests.map(r => r.type), ['token', 'mail']);
      const mail = requests[1].body.message;
      assert.deepEqual(mail.toRecipients, [{ emailAddress: { address: fixtureEnv.MS_GRAPH_SENDER } }]);
      assert.deepEqual(mail.bccRecipients, [{ emailAddress: { address: 'test-only@hoangmaistarschool.edu.vn' } }]);
      const html = mail.body.content;
      const cards = html.split('<div class="weekly-menu-day"').slice(1);
      assert.equal(cards.length, 5);
      for (const [index, day] of menu.days.entries()) {
        const card = cards[index];
        assert.match(card, new RegExp(`<h3\\b[^>]*>Thứ ${index + 2}</h3>`));
        assert.ok(card.includes(`${day.date.slice(8)}/${day.date.slice(5, 7)}/${day.date.slice(0, 4)}`));
        for (const key of DISH_KEYS) assert.ok(card.includes(day[key].replace(/\n/g, '<br />')), `${day.date}: ${key}`);
      }
      const cta = html.indexOf('Tham gia khảo sát');
      const deadline = html.indexOf('Thời hạn hoàn thành khảo sát');
      const introduction = html.indexOf('Dưới đây là thực đơn tuần');
      const firstCard = html.indexOf('<div class="weekly-menu-day"');
      const signature = html.lastIndexOf('Trân trọng,');
      assert.ok(cta >= 0 && cta < deadline && deadline < introduction && introduction < firstCard && firstCard < signature);
      assert.match(html, /@media only screen and \(max-width: 640px\)\s*\{\s*\.weekly-menu-day\s*\{\s*max-width:\s*100% !important;?\s*\}/);
      assert.match(html, /<!--\[if mso\]><table role="presentation"/);
      assert.equal((html.match(/<td width="50%" valign="top">/g) || []).length, 6);
      assert.match(html, /https:\/\/test\.invalid\/khao-sat\?tuan=2026-10-05/);
      assert.match(html, /https:\/\/test\.invalid\/thuc-don\?tuan=2026-10-05/);
    });

    await t.test('toàn bộ thư với 35 món và ghi chú ở giới hạn escape vẫn dưới 100 KiB', async () => {
      const menu = menuFixture();
      for (const day of menu.days) for (const key of DISH_KEYS) day[key] = '"'.repeat(300);
      menu.note = '"'.repeat(1000);
      const res = await invoke({ menu });
      assert.equal(res.code, 200);
      const html = requests[1].body.message.body.content;
      const bytes = Buffer.byteLength(html, 'utf8');
      assert.ok(bytes < 100 * 1024, `HTML toàn bộ thư ${bytes} byte phải dưới 100 KiB`);
      assert.equal((html.match(/&quot;/g) || []).length, 35 * 300 + 1000);
      t.diagnostic(`HTML toàn bộ thư có dữ liệu tối đa: ${bytes} byte UTF-8.`);
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
