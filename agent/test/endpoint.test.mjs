// Test cho lib/endpoint.mjs (gọi /api/meal-alerts) với một máy chủ HTTP giả
// trên máy: gửi đúng khoá, gợi ý lỗi dễ hiểu, và KHÔNG BAO GIỜ lộ khoá trong
// thông báo lỗi — kể cả khi máy chủ (hay chính fetch) chép khoá vào đó.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postAlerts } from '../lib/endpoint.mjs';

const SECRET = 'e2e-khoa-bi-mat-0123456789abcdefghijkl';

/** Máy chủ giả; `handler(req, body, res)`. Trả { url, close, seen }. */
async function server(handler) {
  /** @type {{ headers: http.IncomingHttpHeaders, body: string }[]} */
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ headers: req.headers, body });
    handler(req, body, res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
  return {
    url: `http://127.0.0.1:${port}/api/meal-alerts`,
    port,
    seen,
    close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }),
  };
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('gửi đúng: POST JSON, Bearer khoá, trả thân phản hồi', async () => {
  const s = await server((_req, _body, res) => json(res, 200, { results: [{ ok: true, count: 3 }] }));
  try {
    const data = await postAlerts({ endpoint: s.url, secret: SECRET }, { kind: 'survey-invite', weekId: '2026-10-05', bcc: ['a@x'] });
    assert.deepEqual(data, { results: [{ ok: true, count: 3 }] });
    assert.equal(s.seen[0].headers.authorization, `Bearer ${SECRET}`);
    assert.match(s.seen[0].headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(s.seen[0].body), { kind: 'survey-invite', weekId: '2026-10-05', bcc: ['a@x'] });
  } finally { await s.close(); }
});

test('lỗi HTTP: gợi ý theo mã, che khoá nếu máy chủ chép khoá vào thân lỗi', async () => {
  let mode = 401;
  const s = await server((_req, _body, res) => {
    if (mode === 401) return json(res, 401, { error: 'Sai khoá' });
    if (mode === 500) return json(res, 500, { error: `MEAL_ALERT_SECRET chưa cấu hình (nhận được ${SECRET})` });
    res.writeHead(404); res.end('Not found');
  });
  try {
    const cfg = { endpoint: s.url, secret: SECRET };
    await assert.rejects(postAlerts(cfg, {}), err => /HTTP 401: Sai khoá — alerts\.secret không khớp/.test(err.message));
    mode = 500;
    await assert.rejects(postAlerts(cfg, {}), err => {
      assert.equal(err.message.includes(SECRET), false, 'không lộ khoá');
      assert.match(err.message, /\*\*\*/);
      assert.match(err.message, /Redeploy/);
      return true;
    });
    mode = 404;
    await assert.rejects(postAlerts(cfg, {}), /HTTP 404: Not found — sai alerts\.endpoint/);
  } finally { await s.close(); }
});

test('không trả lời trong hạn chờ / không kết nối được: thông báo dễ hiểu', async () => {
  const s = await server(() => { /* treo: không bao giờ trả lời */ });
  try {
    await assert.rejects(postAlerts({ endpoint: s.url, secret: SECRET }, {}, { timeoutMs: 300 }), /Không gọi được 127\.0\.0\.1:\d+ — không trả lời trong 0\.3 giây/);
  } finally { await s.close(); }
  // Cổng vừa đóng: từ chối kết nối.
  await assert.rejects(postAlerts({ endpoint: s.url, secret: SECRET }, {}), /Không gọi được 127\.0\.0\.1:\d+ — ECONNREFUSED/);
});

test('khoá có ký tự xuống dòng: fetch từ chối trước khi gửi, thông báo không chép khoá', async () => {
  const bad = `${SECRET}\nX`;
  await assert.rejects(postAlerts({ endpoint: 'http://127.0.0.1:9/api/meal-alerts', secret: bad }, {}), err => {
    assert.equal(err.message.includes(SECRET), false);
    assert.match(err.message, /không tạo được yêu cầu gửi/);
    assert.equal(err.delivery, 'not_sent', 'chưa rời máy');
    return true;
  });
});

// Thư mời khảo sát là MỘT thư Bcc cho cả trường: chỉ lỗi "chắc chắn chưa gửi"
// mới được gửi lại tự động; lỗi "không rõ" mà gửi lại là cả trường nhận hai thư.
test('phân loại lỗi: chắc chắn chưa gửi / không rõ đã gửi chưa', async () => {
  let mode = '';
  const s = await server((req, _body, res) => {
    if (mode === '400') return json(res, 400, { error: 'Dữ liệu không hợp lệ' });
    if (mode === '429') { res.writeHead(429); return res.end('Too Many Requests'); }
    if (mode === '500-ours') return json(res, 500, { error: 'Máy chủ chưa cấu hình dịch vụ email (MS_GRAPH_*).' });
    if (mode === '502-ours') return json(res, 502, { error: 'token lỗi', results: [{ ok: false, count: 3, error: 'token lỗi' }] });
    if (mode === '504-vercel') { res.writeHead(504, { 'Content-Type': 'text/plain' }); return res.end('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT'); }
    if (mode === '502-json-other') return json(res, 502, { error: { code: '502', message: 'Bad gateway' } });
    if (mode === 'reset') return req.socket.destroy(); // đứt kết nối SAU khi máy chủ đã nhận yêu cầu
    // Hạn trả lời đã qua: hàm từ chối trước khi gọi Graph.
    if (mode === '400-closed') return json(res, 400, { error: 'Khảo sát tuần này đã đóng lúc 12h00 thứ 2, ngày 12/10/2026 (closesAt đã qua) — không gửi lời mời.' });
    // Graph quá 10 giây SAU khi nhận thư: hàm vẫn trả 200, báo maybeSent trong kết quả.
    if (mode === 'maybe-sent') return json(res, 200, { results: [{ ok: false, count: 3, maybeSent: true, error: 'The operation was aborted due to timeout' }] });
    json(res, 200, { results: [{ ok: true, count: 1 }] });
  });
  const cfg = { endpoint: s.url, secret: SECRET };
  const outcome = async m => {
    mode = m;
    try { await postAlerts(cfg, {}); return 'ok'; } catch (err) {
      assert.equal(err.message.includes(SECRET), false);
      return `${err.delivery}${err.status ? `:${err.status}` : ''}`;
    }
  };
  try {
    assert.equal(await outcome('ok'), 'ok');
    assert.equal(await outcome('400'), 'not_sent:400');
    assert.equal(await outcome('429'), 'not_sent:429');
    assert.equal(await outcome('500-ours'), 'not_sent:500', 'lỗi JSON do chính hàm trả: chưa gửi');
    assert.equal(await outcome('502-ours'), 'not_sent:502');
    assert.equal(await outcome('504-vercel'), 'unknown:504', 'trang lỗi của Vercel: hàm có thể đã gửi');
    assert.equal(await outcome('502-json-other'), 'unknown:502');
    assert.equal(await outcome('reset'), 'unknown');
    assert.equal(await outcome('400-closed'), 'not_sent:400');
    // 200 kèm maybeSent: postAlerts trả nguyên thân để survey-plan.mjs inviteOutcome đọc (-> 'unknown').
    mode = 'maybe-sent';
    assert.deepEqual(await postAlerts(cfg, {}), { results: [{ ok: false, count: 3, maybeSent: true, error: 'The operation was aborted due to timeout' }] });
  } finally { await s.close(); }

  // Hết giờ chờ: máy chủ đã nhận yêu cầu, có thể đã gửi.
  const hang = await server(() => { /* treo */ });
  try {
    await assert.rejects(postAlerts({ endpoint: hang.url, secret: SECRET }, {}, { timeoutMs: 300 }), err => err.delivery === 'unknown' && err.status === null);
  } finally { await hang.close(); }
  // Không kết nối được (cổng đóng): yêu cầu chưa rời máy.
  await assert.rejects(postAlerts({ endpoint: hang.url, secret: SECRET }, {}), err => err.delivery === 'not_sent' && /ECONNREFUSED/.test(err.message));
});
