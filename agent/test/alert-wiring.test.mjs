// Pha cảnh báo chạy THẬT, đầu–cuối: bản chép tạm của sync-checkins.mjs chạy như
// task "DKAN 2 - Canh bao 13h45" (--quiet --days 1 --send-alerts) trên Firestore/Auth
// giả trong bộ nhớ, với hai máy nhận diện giả và API email giả trên 127.0.0.1 (xem
// fixtures/agent-sandbox.mjs). Các test của lib/ kiểm từng hàm; ở đây kiểm cách
// sync-checkins.mjs nối chúng lại: ngày xét của từng loại thư, loại đã xong thì không
// đọc thêm, lỗi của loại này không chặn loại kia, API email bản cũ, cờ held, miễn chấm.
// Mỗi kịch bản một thư mục tạm riêng trong os.tmpdir() (xoá khi xong), chạy song song.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OLD_API_EXTRA_REASON } from '../lib/alert-plan.mjs';
import { addDays, datesFromTo } from '../lib/common.mjs';
import {
  createSandbox, registration, checkinsDoc, email, utc, alertPhaseReads, readList, staffMails, journal,
} from './fixtures/agent-sandbox.mjs';

const D = '2026-11-09'; // thứ 2 — hôm nay
const P = '2026-11-06'; // thứ 6 — ngày có suất ăn trước hôm nay
const NOV = '2026-11';
const OCT = '2026-10';

/**
 * Một tuần bình thường, tất cả qua hai máy CA_TrH và CA_TIH.
 *   Thứ 6 (P): uX ăn trưa 11:50 mà chỉ có đơn tháng 10 (mã gắn với tài khoản qua đơn
 *   các tháng trước — "chưa có đơn tháng"); uY ăn trưa 11:45 rồi 15:00 mới nộp đơn tháng
 *   11 bắt đầu từ chính hôm đó (ăn trước, nộp sau trong ngày: tính là đã đăng ký).
 *   Thứ 2 (D, hôm nay): uM chỉ chấm bữa sáng; uX (11:55) và uW (11:50, chỉ có đơn tháng
 *   10) chấm bữa trưa mà chưa đăng ký — hôm nay chưa phải ngày xét loại thư đó.
 */
function baseWorld() {
  const tapsP = {
    CA_TrH: { 100001: ['07:05', '11:35'], 100003: ['11:50'], 100005: ['07:20', '11:30'] },
    CA_TIH: { 100002: ['07:10', '11:40'], 100004: ['11:45'] },
  };
  const tapsD = {
    CA_TrH: { 100001: ['07:05', '11:35'], 100003: ['11:55'], 100005: ['07:20'] },
    CA_TIH: { 100002: ['07:10', '11:40'], 100004: ['07:15', '11:45'], 100007: ['11:50'] },
  };
  return {
    users: Object.fromEntries(['uA', 'uB', 'uM', 'uX', 'uY', 'uW'].map(uid => [uid, { email: email(uid) }])),
    taps: { [P]: tapsP, [D]: tapsD },
    docs: {
      'registrations/uA_2026-11': registration('uA', '100001', NOV),
      'registrations/uB_2026-11': registration('uB', '100002', NOV),
      'registrations/uM_2026-11': registration('uM', '100005', NOV),
      'registrations/uY_2026-11': registration('uY', '100004', NOV, { firstMealDate: P, timestamp: utc(P, '15:00') }),
      'registrations/uX_2026-10': registration('uX', '100003', OCT),
      'registrations/uW_2026-10': registration('uW', '100007', OCT),
      // Thứ 6 đã được task 22:00 hôm đó đồng bộ đủ hai máy (chốt cả hai bữa).
      [`checkins/${P}`]: checkinsDoc(P, tapsP),
      'settings/checkinSync': { agentVersion: '2026-11-05.1', coverage: { [P]: utc(P, '22:00') }, alerts: {} },
      'settings/mealOffDays': { dates: [] },
      'settings/reconcileExcludes': { employeeIds: [] },
    },
  };
}

// Thư gửi đúng của thế giới trên.
const EXTRA_P = `${P} ux lunch@11:50:no_registration`;
const MISSING_D = `${D} um lunch`;

// Lượt đọc (tính tiền) của pha cảnh báo — hạn mức đọc của gói Spark. Lượt đọc đầu
// tiên của pha, chung cho hai loại thư: danh sách ngày nghỉ.
const OFF_DAYS_READ = 'get settings/mealOffDays';
/**
 * Thư thiếu chấm cho `date` (đơn tháng đã đọc ở bước tách lượt chấm cá nhân): báo hủy,
 * danh sách miễn chấm (tối đa 1 tài liệu ở đây), nhật ký đã gửi, 10 ngày trước để so từng máy.
 */
const missingReads = date => [
  `query cancel_registrations where cancelDate == "${date}"`,
  'query meal_checkin_exemptions',
  `query meal_alerts where date == "${date}"`,
  ...datesFromTo(addDays(date, -10), addDays(date, -1)).map(d => `getAll checkins/${d}`),
];
/**
 * Thư chấm chưa đăng ký cho thứ 6 của baseWorld(): document checkins của ngày đó (ngoài
 * khoảng --days 1), báo hủy, đơn 3 tháng trước (mã của uX không đứng trên đơn tháng 11;
 * tháng 10 có 2 đơn), sự kiện (có người cần báo), nhật ký đã gửi.
 */
const EXTRA_READS_P = [
  `get checkins/${P}`,
  `query cancel_registrations where cancelDate == "${P}"`,
  'query registrations where month == "2026-10" [2]',
  'query registrations where month == "2026-09"',
  'query registrations where month == "2026-08"',
  'query events',
  `query meal_alerts where date == "${P}"`,
];

const noAt = ({ at, ...rest }) => rest;
const sync = r => r.db.docs['settings/checkinSync'];
const posted = r => r.posts.map(p => [p.kind, p.status, p.body?.alerts?.length ?? null]);

/** Mốc `at` do chính lần chạy ghi (đồng hồ agent bắt đầu ở `runAt`). */
function assertWrittenBy(at, runAt) {
  const ms = Date.parse(at) - Date.parse(runAt);
  assert.ok(ms >= 0 && ms < 60_000, `${at} không phải giờ của lần chạy ${runAt}`);
}

/** settings/checkinSync mọi người đã đăng nhập đều đọc được: không có mã NV, email, họ tên. */
function assertNoPersonalData(r) {
  const text = JSON.stringify(sync(r));
  assert.doesNotMatch(text, /(?<!\d)\d{6}(?!\d)/, 'không có mã NV');
  assert.doesNotMatch(text, /@/, 'không có email');
  assert.doesNotMatch(text, /Người /, 'không có họ tên');
}

async function sandboxFor(t, world) {
  const sb = await createSandbox();
  t.after(() => sb.close());
  sb.seed(world);
  return sb;
}

describe('pha cảnh báo chạy thật (sync-checkins.mjs + Firestore giả + máy và API email giả trên 127.0.0.1)', { concurrency: true, timeout: 120_000 }, () => {
  test('extra HTTP200 chưa rõ: ghi biên nhận riêng, lần chạy sau không gửi lại và không đếm thành đã gửi', async t => {
    const sb = await sandboxFor(t, baseWorld());
    sb.extraResponse = body => ({ results: body.alerts.map(a => ({ to: a.to, ok: false, maybeSent: true, error: 'OFFLINE network interruption' })) });
    const first = await sb.run({ at: utc(D, '13:50') });
    assert.equal(first.code, 2, first.out);
    const entry = sync(first).alerts[P].extra;
    assert.deepEqual([entry.status, entry.sent, entry.failed, entry.uncertain], ['partial', 0, 0, 1]);
    assert.match(entry.reason, /Không tự gửi lại.*kiểm tra hộp thư/);
    const receipt = first.db.docs[`meal_alerts/${P}:extra:uX`];
    assert.equal(receipt.delivery, 'uncertain');
    assert.equal(Object.hasOwn(receipt, 'sentAt'), false);
    assert.equal(first.db.docs[`meal_alerts/${D}_uM`].kind, 'missing');
    sb.extraResponse = null;
    const retry = await sb.run({ at: utc(D, '14:05') });
    assert.equal(retry.code, 2, retry.out);
    assert.deepEqual(retry.posts, [], 'cả thư đã gửi và thư chưa rõ đều không tự gửi lại');
    const later = sync(retry).alerts[P].extra;
    assert.deepEqual([later.status, later.sent, later.failed, later.uncertain], ['partial', 0, 0, 1]);
    assert.match(later.reason, /Không tự gửi lại/);
    assertNoPersonalData(retry);
  });

  test('extra chắc chưa gửi: không ghi biên nhận, lần chạy sau gửi nốt đúng một lần', async t => {
    const sb = await sandboxFor(t, baseWorld());
    sb.extraResponse = body => ({ results: body.alerts.map(a => ({ to: a.to, ok: false, error: 'Graph 400: OFFLINE rejected' })) });
    const first = await sb.run({ at: utc(D, '13:50') });
    assert.equal(first.code, 2, first.out);
    assert.equal(first.db.docs[`meal_alerts/${P}:extra:uX`], undefined);
    assert.deepEqual([sync(first).alerts[P].extra.status, sync(first).alerts[P].extra.failed], ['partial', 1]);
    sb.extraResponse = null;
    const retry = await sb.run({ at: utc(D, '14:05') });
    assert.equal(retry.code, 0, retry.out);
    assert.deepEqual(staffMails(retry.posts, 'staff-extra'), [EXTRA_P]);
    assert.deepEqual([sync(retry).alerts[P].extra.status, sync(retry).alerts[P].extra.sent], ['sent', 1]);
  });

  test('thư chấm chưa đăng ký xét ngày có suất ăn TRƯỚC (thứ 6), không xét hôm nay; lần chạy sau thấy cả hai loại đã xong thì không đọc thêm gì', async t => {
    const sb = await sandboxFor(t, baseWorld());
    const at = utc(D, '13:50');
    const r = await sb.run({ at });
    assert.equal(r.code, 0, r.out);

    // Một thư chấm chưa đăng ký, của thứ 6, cho uX. uY (ăn trước, nộp đơn chiều cùng
    // ngày) không có thư; lượt chấm hôm nay của uX, uW không được xét.
    assert.deepEqual(staffMails(r.posts, 'staff-extra'), [EXTRA_P]);
    assert.deepEqual(staffMails(r.posts, 'staff-missing'), [MISSING_D], 'thư thiếu chấm vẫn là của hôm nay');
    assert.deepEqual(posted(r), [['staff-missing', 200, 1], ['staff-extra', 200, 1]], 'không thư báo quản trị, không yêu cầu bị từ chối');
    const extraBody = r.posts.find(p => p.kind === 'staff-extra').body;
    assert.deepEqual([extraBody.date, extraBody.dateLabel, extraBody.alerts[0].employeeId], [P, 'Thứ 6, 06/11/2026', '100003']);

    const s = sync(r);
    assert.deepEqual(noAt(s.alerts[P].extra), { status: 'sent', candidates: 1, sent: 1, failed: 0, unmapped: 0, eventSkipped: 0, reason: null });
    assertWrittenBy(s.alerts[P].extra.at, at);
    assert.deepEqual(Object.keys(s.alerts[P]), ['extra'], 'mục thư thiếu chấm của thứ 6 không bị đụng tới');
    assert.equal(s.alerts[D].extra, undefined, 'hôm nay chưa xét thư chấm chưa đăng ký');
    assert.deepEqual(noAt(s.alerts[D]), {
      status: 'sent', held: false, sent: 1, failed: 0, expected: { breakfast: 4, lunch: 4 }, missing: { breakfast: 0, lunch: 1 },
      exempt: { breakfast: 0, lunch: 0 }, invalidExemptions: 0, reason: null,
    });
    assert.deepEqual(journal(r.db), [`meal_alerts/${P}:extra:uX`, `meal_alerts/${D}_uM`]);
    const { sentAt, ...receipt } = r.db.docs[`meal_alerts/${P}:extra:uX`];
    assert.deepEqual(receipt, { uid: 'uX', date: P, kind: 'extra', to: email('uX'), employeeId: '100003', meals: ['lunch'] });
    assertWrittenBy(sentAt, at);
    assert.equal(r.db.docs[`meal_alerts/${D}_uM`].kind, 'missing');
    assert.deepEqual(s.agentFeatures, ['checkinExemptions', 'extraAlerts']);
    assertNoPersonalData(r);

    // Số lượt đọc của pha cảnh báo (hạn mức Spark): mỗi loại chỉ đọc dữ liệu ngày của nó.
    assert.deepEqual(readList(alertPhaseReads(r.reads)), [OFF_DAYS_READ, ...missingReads(D), ...EXTRA_READS_P].sort());

    // Lần lặp 15 phút sau: hôm nay đã 'sent', thứ 6 đã 'sent' — dừng ở hai cửa chặn,
    // không đọc thêm lượt nào, không gửi, không ghi đè.
    const again = await sb.run({ at: utc(D, '14:05') });
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(again.posts, []);
    assert.deepEqual(readList(alertPhaseReads(again.reads)), [OFF_DAYS_READ]);
    assert.deepEqual(sync(again).alerts, s.alerts);
    assert.deepEqual(journal(again.db), journal(r.db));
  });

  test("thư thiếu chấm đã 'sent' là xong: không ghi đè, không gửi thêm, không đọc gì sau cửa chặn — thư chấm chưa đăng ký của thứ 6 vẫn chạy", async t => {
    const world = baseWorld();
    // Lần chạy 13:46 đã gửi cho uM. Sau đó có thêm uR đăng ký mà không chấm: lần lặp sau
    // vẫn không tính lại hôm nay.
    const sentAt1346 = {
      status: 'sent', at: utc(D, '13:46'), held: false, sent: 1, failed: 0, expected: { breakfast: 4, lunch: 4 },
      missing: { breakfast: 0, lunch: 1 }, exempt: { breakfast: 0, lunch: 0 }, invalidExemptions: 0, reason: null,
    };
    world.docs['settings/checkinSync'].alerts[D] = sentAt1346;
    world.docs[`meal_alerts/${D}_uM`] = { uid: 'uM', date: D, kind: 'missing', to: email('uM'), employeeId: '100005', meals: ['lunch'], sentAt: utc(D, '13:46') };
    world.users.uR = { email: email('uR') };
    world.docs['registrations/uR_2026-11'] = registration('uR', '100012', NOV);
    const sb = await sandboxFor(t, world);

    const r = await sb.run({ at: utc(D, '14:00') });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(staffMails(r.posts, 'staff-missing'), [], 'không gửi thêm thư thiếu chấm nào (kể cả uR)');
    assert.deepEqual(staffMails(r.posts, 'staff-extra'), [EXTRA_P]);
    assert.deepEqual(sync(r).alerts[D], sentAt1346, "mục 'sent' giữ nguyên từng trường");
    assert.equal(sync(r).alerts[P].extra.status, 'sent');
    assert.deepEqual(journal(r.db), [`meal_alerts/${P}:extra:uX`, `meal_alerts/${D}_uM`]);
    // Không lượt đọc nào của thư thiếu chấm: chỉ ngày nghỉ (chung) và dữ liệu của thứ 6.
    assert.deepEqual(readList(alertPhaseReads(r.reads)), [OFF_DAYS_READ, ...EXTRA_READS_P].sort());
  });

  test('thư chấm chưa đăng ký lỗi giữa chừng (đọc báo hủy thất bại): thư thiếu chấm vẫn gửi; ngày đó để error, lần sau gửi bù', async t => {
    const sb = await sandboxFor(t, baseWorld());
    const r = await sb.run({ at: utc(D, '13:50'), failReads: [`query cancel_registrations where cancelDate == "${P}"`] });
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(staffMails(r.posts, 'staff-missing'), [MISSING_D]);
    assert.deepEqual(staffMails(r.posts, 'staff-extra'), []);
    assert.equal(sync(r).alerts[D].status, 'sent');
    assert.deepEqual(noAt(sync(r).alerts[P].extra), {
      status: 'error', candidates: 0, sent: 0, failed: 0, unmapped: 0, eventSkipped: 0,
      reason: `Pha cảnh báo chấm chưa đăng ký gặp lỗi: FAKE read failure: query cancel_registrations where cancelDate == "${P}". Sẽ thử lại ở lần chạy sau.`,
    });
    assert.deepEqual(journal(r.db), [`meal_alerts/${D}_uM`]);

    // 'error' không phải trạng thái xong: lần lặp sau gửi bù, thư thiếu chấm không gửi lại.
    const retry = await sb.run({ at: utc(D, '14:05') });
    assert.equal(retry.code, 0, retry.out);
    assert.deepEqual(staffMails(retry.posts, 'staff-extra'), [EXTRA_P]);
    assert.deepEqual(staffMails(retry.posts, 'staff-missing'), []);
    assert.equal(sync(retry).alerts[P].extra.status, 'sent');
    assert.deepEqual(readList(alertPhaseReads(retry.reads)), [OFF_DAYS_READ, ...EXTRA_READS_P].sort());
  });

  test('thư thiếu chấm lỗi giữa chừng (đọc danh sách miễn chấm thất bại): thư chấm chưa đăng ký vẫn gửi; hôm nay để error, lần sau gửi', async t => {
    const sb = await sandboxFor(t, baseWorld());
    const at = utc(D, '13:50');
    const r = await sb.run({ at, failReads: ['query meal_checkin_exemptions'] });
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(staffMails(r.posts, 'staff-missing'), []);
    assert.deepEqual(staffMails(r.posts, 'staff-extra'), [EXTRA_P]);
    const entry = sync(r).alerts[D];
    assert.deepEqual(noAt(entry), {
      status: 'error', held: false, sent: 0, failed: 0, expected: { breakfast: 0, lunch: 0 }, missing: { breakfast: 0, lunch: 0 },
      reason: 'Pha cảnh báo gặp lỗi: FAKE read failure: query meal_checkin_exemptions. Sẽ thử lại ở lần chạy sau.',
    });
    assertWrittenBy(entry.at, at);
    assert.equal(sync(r).alerts[P].extra.status, 'sent');

    const retry = await sb.run({ at: utc(D, '14:05') });
    assert.equal(retry.code, 0, retry.out);
    assert.deepEqual(staffMails(retry.posts, 'staff-missing'), [MISSING_D]);
    assert.deepEqual(staffMails(retry.posts, 'staff-extra'), [], 'thứ 6 đã xong');
    assert.equal(sync(retry).alerts[D].status, 'sent');
  });

  test('API email bản cũ trả 400 về kind: thư chấm chưa đăng ký để error (OLD_API), thư thiếu chấm không ảnh hưởng; lần sau hỏi thử bằng yêu cầu rỗng trước khi đọc', async t => {
    const sb = await sandboxFor(t, baseWorld());
    sb.api = 'old';
    const r = await sb.run({ at: utc(D, '13:50') });
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(posted(r), [['staff-missing', 200, 1], ['staff-extra', 400, 1]], 'dừng sau lô đầu tiên bị từ chối');
    assert.deepEqual(staffMails(r.posts, 'staff-missing'), [MISSING_D]);
    assert.equal(sync(r).alerts[D].status, 'sent');
    const oldApi = sync(r).alerts[P].extra;
    assert.deepEqual(noAt(oldApi), { status: 'error', candidates: 1, sent: 0, failed: 1, unmapped: 0, eventSkipped: 0, reason: OLD_API_EXTRA_REASON });
    assert.deepEqual(journal(r.db), [`meal_alerts/${D}_uM`], 'thư bị từ chối không được ghi nhật ký');

    // Web vẫn là bản cũ: chỉ một yêu cầu rỗng để hỏi, không đọc dữ liệu thứ 6, không ghi đè trạng thái.
    const still = await sb.run({ at: utc(D, '14:05') });
    assert.equal(still.code, 2, still.out);
    assert.deepEqual(posted(still), [['staff-extra', 400, 0]]);
    assert.equal(still.posts[0].response.error, "kind phải là 'staff-missing', 'admin-notice' hoặc 'survey-invite'.");
    assert.deepEqual(readList(alertPhaseReads(still.reads)), [OFF_DAYS_READ]);
    assert.deepEqual(sync(still).alerts[P].extra, oldApi);

    // Web đã triển khai bản mới: yêu cầu rỗng bị từ chối vì danh sách rỗng (không nhắc
    // tới kind) nên agent đọc dữ liệu và gửi thật.
    sb.api = 'new';
    const deployed = await sb.run({ at: utc(D, '14:20') });
    assert.equal(deployed.code, 0, deployed.out);
    assert.deepEqual(posted(deployed), [['staff-extra', 400, 0], ['staff-extra', 200, 1]]);
    assert.equal(deployed.posts[0].response.error, 'alerts phải có từ 1 đến 20 phần tử.');
    assert.deepEqual(staffMails(deployed.posts, 'staff-extra'), [EXTRA_P]);
    assert.deepEqual(noAt(sync(deployed).alerts[P].extra), { status: 'sent', candidates: 1, sent: 1, failed: 0, unmapped: 0, eventSkipped: 0, reason: null });
    assert.deepEqual(journal(deployed.db), [`meal_alerts/${P}:extra:uX`, `meal_alerts/${D}_uM`]);
    assert.deepEqual(readList(alertPhaseReads(deployed.reads)), [OFF_DAYS_READ, ...EXTRA_READS_P].sort());
  });

  // ------------------------------------------------ cờ held còn sót của chốt an toàn

  const D0 = '2026-11-05'; // thứ 5 — chốt an toàn dừng lúc 13:46
  const D1 = '2026-11-06'; // thứ 6 — ngày có suất ăn kế tiếp
  const P0 = '2026-11-04'; // thứ 4 — ngày xét thư chấm chưa đăng ký của các lần chạy thứ 5
  const HOLD_RE = /1 tài liệu hỏng không xác định được mã nhân viên/;

  /**
   * Thứ 5 lúc 13:46: máy CA_TIH chưa có lượt bữa trưa nào → chốt an toàn dừng, đã báo
   * quản trị (guarded, held). Danh sách miễn chấm có một tài liệu hỏng không nêu được mã
   * NV. uX ăn trưa thứ 5 mà chỉ có đơn tháng 10; uM chỉ chấm bữa sáng thứ 5.
   */
  function heldWorld({ synced2200 = false } = {}) {
    const tapsD0 = {
      CA_TrH: { 100001: ['07:05', '11:35'], 100003: ['11:50'], 100005: ['07:20'] },
      CA_TIH: { 100002: ['07:10', '11:40'] },
    };
    const tapsD1 = { CA_TrH: { 100001: ['07:05', '11:35'], 100005: ['07:20', '11:30'] }, CA_TIH: { 100002: ['07:10', '11:40'] } };
    const guarded = {
      status: 'guarded', at: utc(D0, '13:46'), held: true, sent: 0, failed: 0, expected: { breakfast: 3, lunch: 3 },
      missing: { breakfast: 0, lunch: 2 }, exempt: { breakfast: 0, lunch: 0 }, invalidExemptions: 1,
      reason: 'Dữ liệu một máy nhận diện bất thường — máy CA_TIH không có lượt chấm nào trong khung Bữa trưa (10:00–13:30).',
    };
    return {
      users: Object.fromEntries(['uA', 'uB', 'uM', 'uX'].map(uid => [uid, { email: email(uid) }])),
      taps: { [D0]: tapsD0, [D1]: tapsD1 },
      docs: {
        'registrations/uA_2026-11': registration('uA', '100001', NOV),
        'registrations/uB_2026-11': registration('uB', '100002', NOV),
        'registrations/uM_2026-11': registration('uM', '100005', NOV),
        'registrations/uX_2026-10': registration('uX', '100003', OCT),
        // Lần đồng bộ 13:46 (CA_TIH chưa có bữa trưa), hoặc lần 22:00 đã đủ.
        [`checkins/${D0}`]: synced2200
          ? checkinsDoc(D0, tapsD0)
          : checkinsDoc(D0, { CA_TrH: tapsD0.CA_TrH, CA_TIH: { 100002: ['07:10'] } }, utc(D0, '13:46')),
        'meal_checkin_exemptions/khong-ro-ma': { email: 'x' },
        'settings/checkinSync': {
          agentVersion: '2026-11-05.1',
          coverage: { [P0]: utc(P0, '22:00'), [D0]: utc(D0, synced2200 ? '22:00' : '13:46') },
          alerts: {
            [P0]: { extra: { status: 'nothing', at: utc(D0, '13:46'), candidates: 0, sent: 0, failed: 0, unmapped: 0, eventSkipped: 0, reason: null } },
            [D0]: guarded,
          },
        },
        'settings/mealOffDays': { dates: [] },
        'settings/reconcileExcludes': { employeeIds: [] },
      },
    };
  }

  test('ngày bị chốt an toàn treo (guarded, held) + tài liệu miễn chấm hỏng không nêu mã: lần chạy sau dữ liệu ổn gỡ held, ngày có suất ăn kế tiếp gửi thư chấm chưa đăng ký của ngày đó', async t => {
    const world = heldWorld();
    const sb = await sandboxFor(t, world);
    const at = utc(D0, '14:00');
    const r = await sb.run({ at });
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(r.posts, [], 'tài liệu hỏng giữ cả loại thư thiếu chấm; đã báo quản trị lúc 13:46 nên không báo lại');
    const entry = sync(r).alerts[D0];
    const { at: heldAt, reason, ...counts } = entry;
    // Giữ 'guarded' (dấu đã báo quản trị trong ngày) nhưng bỏ cờ held: lần chạy này chốt
    // an toàn đã qua, dữ liệu máy bình thường.
    assert.deepEqual(counts, {
      status: 'guarded', held: false, sent: 0, failed: 0, expected: { breakfast: 3, lunch: 3 }, missing: { breakfast: 0, lunch: 1 },
      exempt: { breakfast: 0, lunch: 0 }, invalidExemptions: 1,
    });
    assert.match(reason, HOLD_RE);
    assertWrittenBy(heldAt, at);
    // Thư chấm chưa đăng ký của thứ 4 đã xong ('nothing'): không đọc gì cho thứ 4.
    assert.deepEqual(sync(r).alerts[P0], world.docs['settings/checkinSync'].alerts[P0]);
    assert.deepEqual(readList(alertPhaseReads(r.reads)), [OFF_DAYS_READ, ...missingReads(D0)].sort());

    // Thứ 6: thứ 5 không còn bị treo → gửi thư chấm chưa đăng ký của thứ 5. Thư thiếu chấm
    // của thứ 6 vẫn bị giữ vì tài liệu hỏng (error — chưa báo quản trị gì cho thứ 6).
    const next = await sb.run({ at: utc(D1, '13:50') });
    assert.equal(next.code, 2, next.out);
    assert.deepEqual(posted(next), [['staff-extra', 200, 1]]);
    assert.deepEqual(staffMails(next.posts, 'staff-extra'), [`${D0} ux lunch@11:50:no_registration`]);
    const s = sync(next);
    assert.deepEqual(noAt(s.alerts[D0].extra), { status: 'sent', candidates: 1, sent: 1, failed: 0, unmapped: 0, eventSkipped: 0, reason: null });
    assert.deepEqual([s.alerts[D0].status, s.alerts[D0].held, s.alerts[D0].at], ['guarded', false, heldAt], 'mục thư thiếu chấm của thứ 5 giữ nguyên');
    assert.deepEqual([s.alerts[D1].status, s.alerts[D1].held], ['error', false]);
    assert.match(s.alerts[D1].reason, HOLD_RE);
    assert.deepEqual(journal(next.db), [`meal_alerts/${D0}:extra:uX`]);
    assertNoPersonalData(next);
  });

  test('đối chứng: không có lần chạy nào sau 13:46 của ngày bị treo thì held còn nguyên và ngày đó không có thư chấm chưa đăng ký (guarded, không báo quản trị)', async t => {
    const sb = await sandboxFor(t, heldWorld({ synced2200: true }));
    const r = await sb.run({ at: utc(D1, '13:50') });
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(r.posts, []);
    const s = sync(r);
    assert.equal(s.alerts[D0].held, true);
    assert.equal(s.alerts[D0].extra.status, 'guarded');
    assert.match(s.alerts[D0].extra.reason, /đang bị chốt an toàn treo lại/);
    assert.deepEqual(journal(r.db), []);
  });

  test('miễn chấm: bữa trưa được miễn thì chỉ báo bữa sáng; tài liệu hỏng nêu mã chỉ giữ lại người đó, người khác vẫn nhận', async t => {
    const world = baseWorld();
    for (const uid of ['uE', 'uQ', 'uR']) world.users[uid] = { email: email(uid) };
    world.docs['registrations/uE_2026-11'] = registration('uE', '100010', NOV);
    world.docs['registrations/uQ_2026-11'] = registration('uQ', '100011', NOV);
    world.docs['registrations/uR_2026-11'] = registration('uR', '100012', NOV);
    // uE được miễn chấm bữa trưa (đúng mã và email tài khoản); tài liệu của uQ hỏng (email sai).
    world.docs['meal_checkin_exemptions/100010'] = {
      employeeId: '100010', email: email('uE'), fullName: 'Người uE', periods: [{ from: '2026-11-01', to: null, meals: ['lunch'] }],
    };
    world.docs['meal_checkin_exemptions/100011'] = {
      employeeId: '100011', email: 'KHONG-HOP-LE', fullName: 'Người uQ', periods: [{ from: '2026-11-01', to: null }],
    };
    const sb = await sandboxFor(t, world);
    const r = await sb.run({ at: utc(D, '13:50') });
    assert.equal(r.code, 0, r.out);
    // uE, uQ, uR đều không chấm gì hôm nay.
    assert.deepEqual(staffMails(r.posts, 'staff-missing'), [`${D} ue breakfast`, MISSING_D, `${D} ur breakfast+lunch`]);
    assert.doesNotMatch(JSON.stringify(r.posts), /uq@|100011/i, 'người có tài liệu miễn chấm hỏng không nhận thư nào');
    assert.deepEqual(noAt(sync(r).alerts[D]), {
      status: 'sent', held: false, sent: 3, failed: 0, expected: { breakfast: 6, lunch: 6 }, missing: { breakfast: 2, lunch: 2 },
      exempt: { breakfast: 0, lunch: 1 }, invalidExemptions: 1,
      reason: '1 mã NV có tài liệu miễn chấm hỏng, tạm chưa gửi cho các mã này.',
    });
    assert.deepEqual(staffMails(r.posts, 'staff-extra'), [EXTRA_P], 'danh sách miễn chấm không chặn thư chấm chưa đăng ký');
    assertNoPersonalData(r);
  });
});
