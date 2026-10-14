// Test cho phần thuần của việc gửi lời mời khảo sát (lib/survey-plan.mjs):
// cổng giờ 15:00 thứ 6 + gửi bù, tuần nghỉ, không gửi trùng, giữ giờ quản trị
// đã đặt, chia lô, gửi nốt sau lỗi, trạng thái cuối.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SURVEY_BATCH_SIZE, SURVEY_FLAGS, NO_MEALS_REASON, MIN_CATCH_UP_MS, SEND_LEASE_MS, parseSurveyArgs, readSurveyConfig,
  defaultSurveyWeekId, timeGate, decideWeek, openWeekPatch, skippedWeekDoc, buildEmailStatus, buildInvitees, pendingInvitees,
  emailList, inviteBatches, mergeInvitedRecipients, inviteOutcome, inviteRequest, leaseState, buildLease, batchGate, sendInvitations,
  finalSurveyStatus, runReasons, scheduledSurveyRuns, autoSendRuns, inviteeNotes, maskEmail, scrubEmails, shorten,
} from '../lib/survey-plan.mjs';
import { SURVEY_VERSION, surveyClosesAt } from '../lib/survey.mjs';
import { formatVnDateTime } from '../lib/meal-rules.mjs';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEEK = '2026-10-05';                       // thứ 2; thứ 6 là 09/10
const vn = (/** @type {string} */ s) => new Date(`${s}+07:00`); // giờ Việt Nam -> Date
const GOOD_SECRET = 'k'.repeat(40);
const OFF_WEEK = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];

// ------------------------------------------------------------- cổng giờ

test('cổng giờ: thứ 6 14:59 chưa gửi, 15:00 gửi', () => {
  assert.equal(timeGate({ weekId: WEEK, now: vn('2026-10-09T14:59:59') }).verdict, 'early');
  assert.equal(timeGate({ weekId: WEEK, now: vn('2026-10-09T15:00:00') }).verdict, 'on_time');
  assert.equal(timeGate({ weekId: WEEK, now: vn('2026-10-09T23:59:00') }).verdict, 'on_time');
  // Đầu tuần cũng là "chưa tới giờ" (không phải lỗi).
  assert.equal(timeGate({ weekId: WEEK, now: vn('2026-10-06T09:00:00') }).verdict, 'early');

  const d1 = decideWeek({ weekId: WEEK, now: vn('2026-10-09T14:59:00') });
  assert.equal(d1.action, 'wait');
  assert.match(d1.message, /15:00 09\/10\/2026/);
  const d2 = decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:00:00') });
  assert.equal(d2.action, 'send');
  assert.equal(d2.catchUp, false);
});

test('cổng giờ: thứ 7 / sáng thứ 2 chưa gửi thì gửi bù; quá hạn đóng thì không', () => {
  const sat = decideWeek({ weekId: WEEK, now: vn('2026-10-10T08:30:00') });
  assert.equal(sat.action, 'send');
  assert.equal(sat.catchUp, true);
  assert.match(sat.message, /GỬI BÙ/);

  const monMorning = decideWeek({ weekId: WEEK, now: vn('2026-10-12T10:59:00') });
  assert.equal(monMorning.action, 'send');
  assert.equal(monMorning.catchUp, true);

  // Còn chưa tới 1 giờ là đóng: không gửi bù (không ai kịp trả lời).
  assert.equal(MIN_CATCH_UP_MS, 60 * 60_000);
  const monLate = decideWeek({ weekId: WEEK, now: vn('2026-10-12T11:01:00') });
  assert.equal(monLate.action, 'too_late');
  assert.match(monLate.message, /chỉ còn 59 phút.*12:00 12\/10\/2026.*--week 2026-10-05.*--force/);
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-12T11:55:00') }).action, 'too_late');
  // --force (người vận hành chủ động) và gửi đúng giờ thứ 6 thì không xét điều này.
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-12T11:55:00'), force: true }).action, 'send');
  const closesFri1530 = { closesAt: new Date(vn('2026-10-09T15:30:00')) };
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:00:00'), existing: closesFri1530 }).action, 'send');
  // Hạn gia hạn tới thứ 3: 11:55 thứ 2 vẫn còn lâu -> gửi bù được.
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-12T11:55:00'), existing: { closesAt: new Date(vn('2026-10-13T17:00:00')) } }).action, 'send');

  const monNoon = decideWeek({ weekId: WEEK, now: vn('2026-10-12T12:00:00') });
  assert.equal(monNoon.action, 'closed');
  assert.match(monNoon.message, /--week 2026-10-05/);

  // Quản trị đã gia hạn tới thứ 3: thứ 2 chiều vẫn gửi bù được.
  const extended = { opensAt: vn('2026-10-09T15:00:00'), closesAt: { seconds: vn('2026-10-13T17:00:00').getTime() / 1000, nanoseconds: 0 } };
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-12T13:00:00'), existing: extended }).action, 'send');
  // Quản trị đã đóng sớm: không gửi, kể cả --force.
  const closedEarly = { closesAt: { toMillis: () => vn('2026-10-09T10:00:00').getTime() } };
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:05:00'), existing: closedEarly }).action, 'closed');
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:05:00'), existing: closedEarly, force: true }).action, 'closed');
});

test('cổng giờ: --force bỏ qua giờ (gửi sớm / gửi bù), nhưng vẫn tôn trọng "đã gửi" và tuần nghỉ', () => {
  const wed = vn('2026-10-07T10:00:00');
  assert.equal(timeGate({ weekId: WEEK, now: wed, force: true }).verdict, 'forced');
  const d = decideWeek({ weekId: WEEK, now: wed, force: true });
  assert.equal(d.action, 'send');
  assert.equal(d.catchUp, false);
  assert.match(d.message, /--force/);
  assert.equal(decideWeek({ weekId: WEEK, now: wed, force: true, existing: { email: { status: 'sent' } } }).action, 'already_sent');
  assert.equal(decideWeek({ weekId: WEEK, now: wed, force: true, offDays: OFF_WEEK }).action, 'skip_no_meals');
});

test('tuần mặc định: tuần chứa hôm nay; chủ nhật thuộc tuần vừa qua; sáng thứ 2 trước 12:00 vẫn là tuần trước', () => {
  assert.equal(defaultSurveyWeekId(vn('2026-10-09T15:00:00')), WEEK);
  assert.equal(defaultSurveyWeekId(vn('2026-10-10T09:00:00')), WEEK);
  assert.equal(defaultSurveyWeekId(vn('2026-10-11T22:00:00')), WEEK);
  assert.equal(defaultSurveyWeekId(vn('2026-10-12T00:30:00')), WEEK);
  assert.equal(defaultSurveyWeekId(vn('2026-10-12T11:59:59')), WEEK);
  assert.equal(defaultSurveyWeekId(vn('2026-10-12T12:00:00')), '2026-10-12');
  assert.equal(defaultSurveyWeekId(vn('2026-10-13T08:00:00')), '2026-10-12');
  // Lúc 06:30 sáng thứ 2 giờ VN vẫn là CN theo UTC — phải tính theo giờ VN.
  assert.equal(defaultSurveyWeekId(vn('2026-10-12T06:30:00')), WEEK);
});

// ------------------------------------------------------------- tuần nghỉ, đã gửi

test('tuần nghỉ cả tuần -> skipped, không mở khảo sát; đã ghi rồi thì không ghi lại', () => {
  const now = vn('2026-10-09T15:00:00');
  const d = decideWeek({ weekId: WEEK, now, offDays: OFF_WEEK });
  assert.equal(d.action, 'skip_no_meals');
  assert.equal(d.recorded, false);
  assert.equal(d.reason, NO_MEALS_REASON);
  // Nghỉ 4/5 ngày vẫn có bữa -> vẫn gửi.
  assert.equal(decideWeek({ weekId: WEEK, now, offDays: OFF_WEEK.slice(0, 4) }).action, 'send');

  const doc = skippedWeekDoc({ weekId: WEEK, now, reason: d.reason });
  assert.equal('opensAt' in doc, false, 'không mở khảo sát');
  assert.equal('closesAt' in doc, false);
  assert.equal(doc.email.status, 'skipped');
  assert.equal(doc.email.reason, NO_MEALS_REASON);
  assert.deepEqual(Object.keys(doc).sort(), ['createdAt', 'email', 'version', 'weekEnd', 'weekId', 'weekStart']);
  assert.equal(doc.weekEnd, '2026-10-09');

  const again = decideWeek({ weekId: WEEK, now, offDays: OFF_WEEK, existing: doc });
  assert.equal(again.recorded, true);
});

test('đã gửi xong -> không làm gì (chạy lặp 15 phút không gửi trùng), xét trước cả tuần nghỉ', () => {
  const sent = { email: { status: 'sent', sentAt: '2026-10-09T08:01:00.000Z' } };
  const d = decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:15:00'), existing: sent });
  assert.equal(d.action, 'already_sent');
  assert.match(d.message, /15:01 09\/10\/2026/);
  assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:15:00'), existing: sent, offDays: OFF_WEEK }).action, 'already_sent');
  // partial / error / skipped thì làm tiếp.
  for (const status of ['partial', 'error', 'skipped']) {
    assert.equal(decideWeek({ weekId: WEEK, now: vn('2026-10-09T15:15:00'), existing: { email: { status } } }).action, 'send', status);
  }
});

// ------------------------------------------------------------- document tuần

test('mở khảo sát: chưa có document -> mở từ giờ MÁY CHỦ, đóng 12:00 thứ 2 (Date -> Timestamp)', () => {
  const now = vn('2026-10-09T15:00:20');
  const SERVER_TS = Object.freeze({ serverTimestamp: true }); // như FieldValue.serverTimestamp()
  const p = openWeekPatch({ weekId: WEEK, now, serverTime: SERVER_TS });
  assert.equal(p.keptOpens, false);
  assert.equal(p.keptCloses, false);
  assert.equal(p.opensMs, null);
  assert.equal(p.data.opensAt, SERVER_TS, 'rules so request.time với opensAt: dùng giờ máy chủ, không dùng đồng hồ máy HAC');
  assert.ok(p.data.closesAt instanceof Date);
  assert.equal(p.data.closesAt.toISOString(), surveyClosesAt(WEEK));
  assert.equal(p.closesMs, Date.parse(surveyClosesAt(WEEK)));
  assert.deepEqual({ ...p.data, opensAt: 0, closesAt: 0 }, {
    weekId: WEEK, weekStart: WEEK, weekEnd: '2026-10-09', version: SURVEY_VERSION,
    opensAt: 0, closesAt: 0, openedBy: 'agent', createdAt: now.toISOString(),
  });
  // Không truyền serverTime (test, công cụ khác) thì dùng `now`.
  assert.equal(openWeekPatch({ weekId: WEEK, now }).data.opensAt.getTime(), now.getTime());
});

test('mở khảo sát: KHÔNG ghi lại opensAt/closesAt/openedBy/createdAt/version đã có (không đè "Đóng ngay"/"Gia hạn")', () => {
  const opened = vn('2026-10-07T09:12:00').getTime();
  const closes = vn('2026-10-13T17:00:00').getTime();
  const existing = {
    opensAt: { seconds: opened / 1000, nanoseconds: 0, toMillis: () => opened }, // Timestamp của firebase-admin
    closesAt: { toMillis: () => closes },
    openedBy: 'tuantm@hoangmaistarschool.edu.vn',
    createdAt: '2026-10-07T02:12:00.000Z',
    version: SURVEY_VERSION,
    email: { status: 'partial' },
  };
  const p = openWeekPatch({ weekId: WEEK, existing, now: vn('2026-10-09T15:00:00'), serverTime: 'SERVER' });
  assert.equal(p.keptOpens, true);
  assert.equal(p.keptCloses, true);
  assert.equal(p.opensMs, opened);
  assert.equal(p.closesMs, closes);
  // Chỉ còn các trường suy ra từ mã tuần: ghi lại không đè được thao tác nào của quản trị.
  assert.deepEqual(p.data, { weekId: WEEK, weekStart: WEEK, weekEnd: '2026-10-09' });

  // Một phần thiếu thì chỉ bù phần thiếu.
  const half = openWeekPatch({ weekId: WEEK, existing: { opensAt: existing.opensAt, openedBy: '  ' }, now: vn('2026-10-09T15:00:00'), serverTime: 'SERVER' });
  assert.deepEqual(Object.keys(half.data).sort(), ['closesAt', 'createdAt', 'openedBy', 'version', 'weekEnd', 'weekId', 'weekStart']);
  assert.equal(half.data.openedBy, 'agent');

  // Lỡ có bản ghi kiểu chuỗi (rules không so được với request.time): ghi lại
  // thành Date đúng thời điểm đó — cùng lần đọc trong giao dịch nên an toàn.
  const s = openWeekPatch({ weekId: WEEK, existing: { opensAt: '2026-10-09T08:00:00.000Z', closesAt: '2026-10-12T05:00:00.000Z' }, now: vn('2026-10-10T09:00:00'), serverTime: 'SERVER' });
  assert.ok(s.data.opensAt instanceof Date && s.data.closesAt instanceof Date);
  assert.equal(s.data.opensAt.toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(s.data.closesAt.toISOString(), '2026-10-12T05:00:00.000Z');
  // createdAt kiểu Timestamp -> ISO theo hợp đồng.
  const created = Date.parse('2026-10-07T02:12:00.000Z');
  assert.equal(openWeekPatch({ weekId: WEEK, existing: { ...existing, createdAt: { toMillis: () => created } }, now: vn('2026-10-09T15:00:00') }).data.createdAt, '2026-10-07T02:12:00.000Z');
});

test('trạng thái email: chỉ số đếm và lý do — che email và khoá, đúng các khoá hợp đồng', () => {
  const e = buildEmailStatus({
    status: 'partial', at: 'A', sentAt: null, recipients: 450, sent: 400, failed: 50.7,
    reason: `Endpoint trả HTTP 400: Bcc trùng nguyenvana@hoangmaistarschool.edu.vn, Bearer ${GOOD_SECRET}`, secret: GOOD_SECRET,
  });
  assert.deepEqual(Object.keys(e).sort(), ['at', 'failed', 'reason', 'recipients', 'sent', 'sentAt', 'status']);
  assert.equal(e.failed, 50);
  assert.equal(e.sentAt, null);
  assert.equal(e.reason.includes('nguyenvana'), false);
  assert.equal(e.reason.includes(GOOD_SECRET), false);
  assert.equal(e.reason.includes('@'), false, 'document tuần ai cũng đọc được: xoá hẳn địa chỉ, không chỉ che');
  assert.match(e.reason, /Bcc trùng \(địa chỉ email\), Bearer \*\*\*/);
  // Địa chỉ đã che kiểu log (n***@...) chép vào lý do cũng bị xoá hẳn.
  assert.equal(buildEmailStatus({ status: 'error', at: 'A', reason: 'lỗi n***@hoangmaistarschool.edu.vn' }).reason, 'lỗi (địa chỉ email)');
  // Nhắc tên miền (không phải địa chỉ của ai) thì giữ cho dễ hiểu.
  assert.match(buildEmailStatus({ status: 'sent', at: 'A', reason: '2 người không có email @hoangmaistarschool.edu.vn' }).reason, /email @hoangmaistarschool/);
  assert.equal(buildEmailStatus({ status: 'sent', at: 'A', recipients: -3, sent: NaN }).recipients, 0);
  assert.equal(buildEmailStatus({ status: 'sent', at: 'A', reason: '' }).reason, null);
  assert.equal(buildEmailStatus({ status: 'sent', at: 'A', reason: 'x'.repeat(900) }).reason.length, 500);
});

// ------------------------------------------------------------- người nhận, lô

const reg = (/** @type {string} */ uid, extra = {}) => ({ uid, month: '2026-10', fullName: `Cô ${uid}`, department: 'Tổ Toán', ...extra });

test('người nhận: chỉ email trường từ tài khoản, bỏ trùng địa chỉ, họ tên theo đơn tháng sau', () => {
  const emails = new Map([
    ['a', 'a@hoangmaistarschool.edu.vn'], ['b', 'b@gmail.com'], ['c', ''], ['d', 'A@HoangMaiStarSchool.edu.vn'],
    ['e', 'e@hoangmaistarschool.edu.vn'], ['f', 'có dấu@hoangmaistarschool.edu.vn'],
  ]);
  const regs = [
    reg('a'), reg('b'), reg('c'), reg('d'), reg('f'),
    reg('e', { month: '2026-09', fullName: 'Cũ', department: 'Cũ' }), reg('e', { month: '2026-10', fullName: 'Thầy\tE\n mới', department: 'Tổ Văn' }),
  ];
  const { invitees, skipped } = buildInvitees({ uids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], registrations: regs, emails });
  assert.deepEqual(invitees.map(r => r.uid), ['a', 'e']);
  assert.deepEqual(invitees[1], { uid: 'e', fullName: 'Thầy E mới', department: 'Tổ Văn', email: 'e@hoangmaistarschool.edu.vn' });
  assert.deepEqual(skipped, { noEmail: ['c', 'g'], outsideDomain: ['b', 'f'], duplicateEmail: ['d'] });
  const notes = inviteeNotes(skipped);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^4 người không có email/);
  assert.equal(JSON.stringify(notes).includes('@gmail'), false, 'ghi chú không chứa địa chỉ');
});

const people = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({
  uid: `u${i}`, fullName: `Người ${i}`, department: 'Tổ', email: `gv${String(i).padStart(3, '0')}@hoangmaistarschool.edu.vn`,
}));

test('chia lô: 401 người -> 2 thư (400 + 1); không bao giờ quá 400 Bcc', () => {
  assert.equal(SURVEY_BATCH_SIZE, 400);
  const b = inviteBatches(people(401));
  assert.deepEqual(b.map(x => x.length), [400, 1]);
  assert.deepEqual(inviteBatches(people(400)).map(x => x.length), [400]);
  assert.deepEqual(inviteBatches([]), []);
  assert.deepEqual(inviteBatches(people(5), 1000).map(x => x.length), [5], 'cỡ lô bị chặn ở 400');
  assert.deepEqual(inviteBatches(people(801), 1000).map(x => x.length), [400, 400, 1]);
});

test('gửi nốt sau lỗi: chỉ người chưa có trong sentEmails (không phân biệt hoa thường)', () => {
  const all = people(450);
  const sent = all.slice(0, 400).map(r => r.email);
  sent[0] = sent[0].toUpperCase();
  const pending = pendingInvitees(all, [...sent, 42, null]);
  assert.equal(pending.length, 50);
  assert.equal(pending[0].uid, 'u400');
  assert.deepEqual(pendingInvitees(all, undefined).length, 450);
  assert.deepEqual(pendingInvitees(all, all.map(r => r.email)), []);
  // Người "không rõ đã nhận" cũng không tự gửi lại (chỉ khi --force: hold rỗng).
  const held = pendingInvitees(all, sent, [all[400].email.toUpperCase(), all[401].email, 7]);
  assert.equal(held.length, 48);
  assert.equal(held.some(r => r.uid === 'u400' || r.uid === 'u401'), false);
  assert.deepEqual(emailList(['a@x', '', '  ', 3, null, 'b@x']), ['a@x', 'b@x']);
  assert.deepEqual(emailList('a@x'), []);
});

// ------------------------------------------------------------- vòng gửi (sendInvitations)

/**
 * Môi trường giả cho vòng gửi: endpoint (post) theo kịch bản từng thư, sổ ghi
 * (journal) như private/invited, đồng hồ cố định. Ghi lại thứ tự mọi việc để
 * kiểm "ghi ngay sau mỗi thư", "dừng khi ghi lỗi"...
 */
function fakeRun({ outcomes = [], journalFailAt = null, gate = () => null, gateThrowsAt = null, store = { sentEmails: [], uncertainEmails: [] } } = {}) {
  const events = [];
  let posts = 0;
  let journals = 0;
  return {
    store,
    events,
    deps: {
      sentEmails: store.sentEmails,
      uncertainEmails: store.uncertainEmails,
      beforeBatch: async i => {
        events.push(`gate${i}`);
        if (gateThrowsAt === i) throw new Error('14 UNAVAILABLE gửi tới ab@x.vn');
        return gate(i);
      },
      post: async batch => {
        const o = outcomes[posts++] ?? 'sent';
        events.push(`post${posts}:${batch.length}:${o}`);
        if (o === 'throw') throw new Error('lỗi lạ');
        return o === 'sent' ? { delivery: 'sent', count: batch.length, error: null }
          : { delivery: o, count: null, error: `${o} khi gửi tới ${batch[0].email}` };
      },
      journal: async state => {
        journals++;
        events.push(`journal${journals}:${state.sentEmails.length}/${state.uncertainEmails.length}`);
        if (journalFailAt === journals) throw new Error('14 UNAVAILABLE: mất kết nối');
        store.sentEmails = state.sentEmails;
        store.uncertainEmails = state.uncertainEmails;
        store.updatedAt = state.at;
      },
      clock: () => new Date('2026-10-09T08:05:00.000Z'),
    },
  };
}

test('vòng gửi: ghi sentEmails NGAY sau mỗi thư; thư 2 lỗi chắc chắn -> partial; lần sau chỉ gửi nốt 50 người', async () => {
  const all = people(450);
  const run1 = fakeRun({ outcomes: ['sent', 'not_sent'] });
  const r1 = await sendInvitations({ batches: inviteBatches(pendingInvitees(all, run1.store.sentEmails)), ...run1.deps });
  assert.deepEqual(run1.events, ['gate0', 'post1:400:sent', 'journal1:400/0', 'gate1', 'post2:50:not_sent'], 'ghi ngay sau thư 1, trước khi gửi thư 2');
  assert.equal(r1.sentNow, 400);
  assert.equal(r1.failed, 50);
  assert.equal(r1.lastSentAt, '2026-10-09T08:05:00.000Z');
  assert.equal(run1.store.sentEmails.length, 400);
  assert.match(r1.errors[0], /not_sent khi gửi tới g\*\*\*@hoangmaistarschool/, 'địa chỉ trong lỗi bị che');
  assert.equal(finalSurveyStatus({ sentTotal: r1.sentEmails.length, failed: r1.failed, uncertain: r1.uncertainEmails.length }), 'partial');

  // Lần 2: đọc lại sổ ghi -> chỉ còn 50 người, không ai nhận hai lần.
  const run2 = fakeRun({ store: run1.store });
  const pending = pendingInvitees(all, run2.store.sentEmails, run2.store.uncertainEmails);
  assert.deepEqual(inviteBatches(pending).map(b => b.length), [50]);
  const r2 = await sendInvitations({ batches: inviteBatches(pending), ...run2.deps });
  assert.equal(r2.sentNow, 50);
  assert.equal(new Set(run2.store.sentEmails.map(e => e.toLowerCase())).size, 450);
  assert.equal(finalSurveyStatus({ sentTotal: r2.sentEmails.length, failed: r2.failed, uncertain: r2.uncertainEmails.length }), 'sent');
  // Lần 3: không còn ai -> không gửi gì, vẫn 'sent'.
  assert.deepEqual(inviteBatches(pendingInvitees(all, run2.store.sentEmails)), []);
  const r3 = await sendInvitations({ batches: [], ...fakeRun({ store: run2.store }).deps });
  assert.equal(r3.sentNow, 0);
  assert.equal(finalSurveyStatus({ sentTotal: r3.sentEmails.length, failed: 0 }), 'sent');
});

test('vòng gửi: không ghi được sổ sau thư 1 -> DỪNG, không gửi thư 2 (thư không được ghi nhớ sẽ bị gửi lại)', async () => {
  const all = people(801);
  const run = fakeRun({ journalFailAt: 1 });
  const lines = [];
  const r = await sendInvitations({ batches: inviteBatches(all), ...run.deps, log: l => lines.push(l) });
  assert.deepEqual(run.events, ['gate0', 'post1:400:sent', 'journal1:400/0'], 'không có post2/post3');
  assert.equal(r.sentNow, 400);
  assert.equal(r.failed, 401);
  assert.match(r.journalError, /UNAVAILABLE/);
  assert.ok(lines.some(l => /không ghi được danh sách đã nhận — DỪNG gửi tiếp/.test(l)));
  assert.equal(finalSurveyStatus({ sentTotal: r.sentEmails.length, failed: r.failed }), 'partial');
  assert.match(runReasons({ weekId: WEEK, failed: r.failed, errors: r.errors, journalError: r.journalError }).join(' '), /Lỗi ghi danh sách đã nhận/);
});

test('vòng gửi: thư KHÔNG RÕ đã đi -> ghi uncertainEmails, không tự gửi lại; --force mới gửi lại', async () => {
  const all = people(300);
  const run1 = fakeRun({ outcomes: ['unknown'] });
  const r1 = await sendInvitations({ batches: inviteBatches(all), ...run1.deps });
  assert.deepEqual(run1.events, ['gate0', 'post1:300:unknown', 'journal1:0/300'], 'ghi ngay cả khi không rõ');
  assert.equal(r1.sentNow, 0);
  assert.equal(r1.failed, 0, 'không tính là lỗi để gửi lại');
  assert.equal(r1.uncertainNow, 300);
  const status = finalSurveyStatus({ sentTotal: 0, failed: 0, uncertain: run1.store.uncertainEmails.length });
  assert.equal(status, 'partial', 'không phải error ("chưa ai nhận") — có thể cả trường đã nhận');
  const reason = runReasons({ weekId: WEEK, uncertain: 300, unknownErrors: r1.unknownErrors }).join(' ');
  assert.match(reason, /300 người KHÔNG RÕ đã nhận.*không tự gửi lại.*--force --week 2026-10-05/);

  // Lần lặp sau (không --force): không ai phải gửi -> không có thư nào.
  assert.deepEqual(pendingInvitees(all, run1.store.sentEmails, run1.store.uncertainEmails), []);
  // Trạng thái vẫn là partial cho tới khi người vận hành xử lý.
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: 0, uncertain: run1.store.uncertainEmails.length }), 'partial');

  // --force: gửi lại cho họ; gửi được thì rời khỏi uncertainEmails -> sent.
  const run2 = fakeRun({ store: run1.store });
  const r2 = await sendInvitations({ batches: inviteBatches(pendingInvitees(all, run2.store.sentEmails, [])), ...run2.deps });
  assert.equal(r2.sentNow, 300);
  assert.deepEqual(run2.store.uncertainEmails, []);
  assert.equal(finalSurveyStatus({ sentTotal: r2.sentEmails.length, failed: 0, uncertain: r2.uncertainEmails.length }), 'sent');

  // post ném lỗi lạ (không phân loại được) -> cũng là "không rõ".
  const run3 = fakeRun({ outcomes: ['throw'] });
  const r3 = await sendInvitations({ batches: inviteBatches(people(2)), ...run3.deps });
  assert.equal(r3.uncertainNow, 2);
});

test('vòng gửi: quản trị đóng khảo sát / mất quyền gửi giữa chừng -> dừng trước thư kế tiếp', async () => {
  const all = people(801);
  const run = fakeRun({ gate: i => (i === 1 ? 'khảo sát đã đóng lúc 15:06 09/10/2026 (quản trị vừa bấm "Đóng ngay")' : null) });
  const r = await sendInvitations({ batches: inviteBatches(all), ...run.deps });
  assert.deepEqual(run.events, ['gate0', 'post1:400:sent', 'journal1:400/0', 'gate1'], 'không gửi thư 2, không hỏi lại thư 3');
  assert.equal(r.failed, 401);
  assert.match(r.stopReason, /Đóng ngay/);
  const reason = runReasons({ weekId: WEEK, failed: r.failed, errors: r.errors, stopReason: r.stopReason }).join(' ');
  assert.match(reason, /^401 người chưa được gửi: khảo sát đã đóng/);
  assert.doesNotMatch(reason, /gửi nốt/, 'đã đóng thì lần sau không gửi nốt — không hứa điều đó');

  // Kiểm tra trước thư lỗi (mất mạng) -> không gửi gì cả.
  const run2 = fakeRun({ gateThrowsAt: 0 });
  const r2 = await sendInvitations({ batches: inviteBatches(people(10)), ...run2.deps });
  assert.deepEqual(run2.events, ['gate0']);
  assert.equal(r2.failed, 10);
  assert.match(r2.stopReason, /không kiểm tra được.*a\*\*\*@x\.vn/);
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: r2.failed }), 'error');
  // Lỗi tạm: lý do dừng không tự hứa "lần chạy sau gửi tiếp" — runReasons nói
  // lần theo lịch nào gửi nốt (nếu có), giống thư lỗi chắc chắn.
  assert.equal(r2.stopRetryable, true);
  assert.equal(r.stopRetryable, false, 'đã đóng: không phải lỗi tạm');
  assert.doesNotMatch(r2.stopReason, /lần chạy sau/i);
  const stopArgs = { weekId: WEEK, failed: r2.failed, errors: r2.errors, stopReason: r2.stopReason, stopRetryable: r2.stopRetryable };
  const friStop = runReasons({ ...stopArgs, ranAt: vn('2026-10-09T15:00:00').toISOString() }).join(' ');
  assert.match(friStop, /^10 người chưa được gửi: không kiểm tra được.*— dừng gửi các thư còn lại\. Lần chạy sau sẽ gửi nốt \(lần theo lịch kế tiếp 15:15 09\/10\/2026, /);
  const monStop = runReasons({ ...stopArgs, ranAt: vn('2026-10-12T10:30:00').toISOString() }).join(' ');
  assert.doesNotMatch(monStop, /Lần chạy sau sẽ gửi nốt|gửi tiếp/);
  assert.match(monStop, /Không còn lần chạy tự động nào gửi nốt: chạy tay node survey-invite\.mjs --week 2026-10-05/);
});

test('trạng thái cuối: sent / partial / error', () => {
  assert.equal(finalSurveyStatus({ sentTotal: 300, failed: 0 }), 'sent');
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: 0 }), 'sent');
  assert.equal(finalSurveyStatus({ sentTotal: 400, failed: 50 }), 'partial');
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: 300 }), 'error');
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: 0, uncertain: 300 }), 'partial');
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: 50, uncertain: 250 }), 'partial');
  assert.equal(finalSurveyStatus({ sentTotal: 300, failed: 0, uncertain: 0 }), 'sent');
});

test('kết quả một thư: chỉ "chắc chắn chưa gửi" mới được gửi lại tự động', () => {
  assert.deepEqual(inviteOutcome({ response: { results: [{ ok: true, count: 12 }] } }), { delivery: 'sent', count: 12, error: null });
  assert.deepEqual(inviteOutcome({ response: { results: [{ ok: true }] } }), { delivery: 'sent', count: null, error: null });
  assert.equal(inviteOutcome({ response: { results: [{ ok: false, error: 'x'.repeat(500) }] } }).error.length, 200);
  assert.equal(inviteOutcome({ response: { results: [{ ok: false }] } }).delivery, 'not_sent');
  // ok:false "trơn" = endpoint chắc chắn chưa gửi (đúng các chữ endpoint dùng cho trường hợp này).
  for (const error of [
    'Hết thời gian xử lý của lần gọi này nên chưa gửi thư này',
    'Microsoft Graph báo quá tải (429), không còn đủ thời gian để thử lại',
    'Gửi email thất bại: HTTP 429 — TooManyRequests: x',
    'Gửi email thất bại: HTTP 400 — ErrorInvalidRecipients: Recipient [địa chỉ] is not valid',
  ]) {
    assert.deepEqual(inviteOutcome({ response: { results: [{ ok: false, count: 3, error }] } }), { delivery: 'not_sent', count: null, error }, error);
  }
  // Endpoint báo Graph CÓ THỂ đã nhận thư (hết giờ chờ, 5xx, đứt kết nối sau khi gửi) -> không rõ, không tự gửi lại.
  const maybe = inviteOutcome({ response: { results: [{ ok: false, count: 300, maybeSent: true, error: 'The operation was aborted due to timeout' }] } });
  assert.equal(maybe.delivery, 'unknown');
  assert.match(maybe.error, /có thể đã nhận thư: The operation was aborted due to timeout/);
  assert.equal(inviteOutcome({ response: { results: [{ ok: false, count: 3, maybeSent: true }] } }).delivery, 'unknown');
  // Giá trị maybeSent lạ: nghiêng về "không rõ".
  for (const maybeSent of ['true', 1, null, {}]) {
    assert.equal(inviteOutcome({ response: { results: [{ ok: false, maybeSent, error: 'x' }] } }).delivery, 'unknown', JSON.stringify(maybeSent));
  }
  assert.equal(inviteOutcome({ response: { results: [{ ok: false, maybeSent: false, error: 'HTTP 400' }] } }).delivery, 'not_sent');
  // Bản web cũ hơn (không có maybeSent) mà lỗi rõ là xảy ra sau khi gửi: vẫn coi là không rõ.
  for (const error of [
    'Gửi email thất bại: HTTP 503 — ServiceUnavailable', 'Gửi email thất bại: HTTP 504', 'The operation was aborted due to timeout',
    'fetch failed', 'read ECONNRESET', 'This operation was aborted', 'Request timed out', 'socket hang up', 'other side closed',
  ]) {
    assert.equal(inviteOutcome({ response: { results: [{ ok: false, count: 3, error }] } }).delivery, 'unknown', error);
  }
  // HTTP 2xx mà thân lạ: hàm đã chạy, không biết đã gửi chưa.
  for (const response of [{ results: [{ ok: 'true' }] }, { results: [] }, null, 'ok']) {
    assert.equal(inviteOutcome({ response }).delivery, 'unknown', JSON.stringify(response));
  }
  // Lỗi từ postAlerts: lib/endpoint.mjs gắn delivery.
  assert.equal(inviteOutcome({ error: Object.assign(new Error('Endpoint trả HTTP 401'), { delivery: 'not_sent' }) }).delivery, 'not_sent');
  assert.equal(inviteOutcome({ error: Object.assign(new Error('không trả lời trong 90 giây'), { delivery: 'unknown' }) }).delivery, 'unknown');
  assert.equal(inviteOutcome({ error: new Error('lỗi không gắn nhãn') }).delivery, 'unknown', 'không biết thì coi là không rõ');
  assert.equal(inviteOutcome({ error: 'chuỗi' }).error, 'chuỗi');
});

test('Graph hết giờ chờ sau khi đã nhận thư (maybeSent) -> không rõ; lần lặp sau KHÔNG gửi lại cả trường', async () => {
  const all = people(300);
  const store = { sentEmails: [], uncertainEmails: [] };
  let posts = 0;
  const deps = () => ({
    sentEmails: store.sentEmails,
    uncertainEmails: store.uncertainEmails,
    // Thân phản hồi THẬT của endpoint khi Graph quá 10 giây (xem api/meal-alerts.ts SurveyResult).
    post: async batch => {
      posts++;
      return inviteOutcome({ response: { results: [{ ok: false, count: batch.length, maybeSent: true, error: 'The operation was aborted due to timeout' }] } });
    },
    journal: async s => { store.sentEmails = s.sentEmails; store.uncertainEmails = s.uncertainEmails; },
  });
  const r1 = await sendInvitations({ batches: inviteBatches(pendingInvitees(all, store.sentEmails, store.uncertainEmails)), ...deps() });
  assert.equal(posts, 1);
  assert.equal(r1.failed, 0);
  assert.equal(r1.uncertainNow, 300);
  assert.equal(store.uncertainEmails.length, 300);
  assert.equal(finalSurveyStatus({ sentTotal: 0, failed: r1.failed, uncertain: store.uncertainEmails.length }), 'partial');
  assert.match(runReasons({ weekId: WEEK, uncertain: 300, unknownErrors: r1.unknownErrors }).join(' '), /300 người KHÔNG RÕ.*aborted due to timeout.*--force --week 2026-10-05/);
  // Lần lặp 15 phút sau (không --force): không còn ai phải gửi -> không có thư nào.
  const pending = pendingInvitees(all, store.sentEmails, store.uncertainEmails);
  assert.deepEqual(pending, []);
  await sendInvitations({ batches: inviteBatches(pending), ...deps() });
  assert.equal(posts, 1, 'không gửi lần hai');
});

test('thân yêu cầu: kèm hạn trả lời THẬT (ISO) để thư ghi đúng hạn; hạn hỏng thì bỏ trường, không ném lỗi', () => {
  const closes = vn('2026-10-13T17:30:00').getTime();
  const body = inviteRequest({ weekId: WEEK, closesMs: closes, emails: ['a@hoangmaistarschool.edu.vn', 'b@hoangmaistarschool.edu.vn'] });
  assert.deepEqual(body, { kind: 'survey-invite', weekId: WEEK, closesAt: '2026-10-13T10:30:00.000Z', bcc: ['a@hoangmaistarschool.edu.vn', 'b@hoangmaistarschool.edu.vn'] });
  assert.deepEqual(Object.keys(body), ['kind', 'weekId', 'closesAt', 'bcc']);
  for (const closesMs of [null, undefined, NaN, Infinity, 1e20, '2026-10-13T10:30:00.000Z']) {
    assert.deepEqual(inviteRequest({ weekId: WEEK, closesMs: /** @type {any} */ (closesMs), emails: ['a@x'] }), { kind: 'survey-invite', weekId: WEEK, bcc: ['a@x'] }, String(closesMs));
  }
  assert.deepEqual(inviteRequest({ weekId: WEEK, closesMs: closes, emails: body.bcc, menu: null }), body);
});

test('thân yêu cầu: kèm nguyên bảng thực đơn đúng tuần trong thư, giữ hạn thật và danh sách Bcc', () => {
  const menu = {
    weekId: WEEK, version: /** @type {const} */ (1), note: '',
    days: OFF_WEEK.map(date => ({ date, breakfast: 'Phở bò', main: 'Vịt chiên riềng', side: '', vegetable: '', soup: '', rice: 'Cơm trắng', dessert: '' })),
  };
  const emails = ['a@hoangmaistarschool.edu.vn'];
  const r = inviteRequest({ weekId: WEEK, closesMs: vn('2026-10-13T17:30:00').getTime(), emails, menu });
  assert.deepEqual(r, { kind: 'survey-invite', weekId: WEEK, closesAt: '2026-10-13T10:30:00.000Z', bcc: emails, menu });
  assert.notEqual(r.bcc, emails, 'sao chép danh sách Bcc để vòng gửi không làm đổi đầu vào');
});

test('lịch tự động: đúng 29 giờ chạy từ thứ 6 tới thứ 2 (① 15:00→16:00 mỗi 15 phút; ② 07:30→12:30 mỗi giờ)', () => {
  const runs = scheduledSurveyRuns(WEEK);
  assert.equal(runs.length, 29);
  assert.deepEqual([...runs].sort((a, b) => a - b), runs, 'tăng dần');
  const fmt = (/** @type {number} */ ms) => new Date(ms + 7 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
  assert.deepEqual(runs.filter(ms => fmt(ms).startsWith('10-09')).map(ms => fmt(ms).slice(6)),
    ['07:30', '08:30', '09:30', '10:30', '11:30', '12:30', '15:00', '15:15', '15:30', '15:45', '16:00']);
  for (const day of ['10-10', '10-11', '10-12']) {
    assert.deepEqual(runs.filter(ms => fmt(ms).startsWith(day)).map(ms => fmt(ms).slice(6)), ['07:30', '08:30', '09:30', '10:30', '11:30', '12:30'], day);
  }
});

test('lần tự động còn gửi nốt: khớp quy tắc README (thứ 6 từ 15:00 tới hạn; sau thứ 6 tới trước 12:00 thứ 2 và còn ≥ 1 giờ)', () => {
  const at = (/** @type {number[]} */ list) => list.map(ms => formatVnDateTime(new Date(ms).toISOString()));
  // Hạn mặc định: thứ 7 và CN gửi cả 11:30 và 12:30; thứ 2 chỉ tới 10:30 (11:30 còn 30 phút).
  const def = autoSendRuns({ weekId: WEEK, afterMs: vn('2026-10-09T14:00:00').getTime() });
  assert.deepEqual(at(def), [
    '15:00 09/10/2026', '15:15 09/10/2026', '15:30 09/10/2026', '15:45 09/10/2026', '16:00 09/10/2026',
    '07:30 10/10/2026', '08:30 10/10/2026', '09:30 10/10/2026', '10:30 10/10/2026', '11:30 10/10/2026', '12:30 10/10/2026',
    '07:30 11/10/2026', '08:30 11/10/2026', '09:30 11/10/2026', '10:30 11/10/2026', '11:30 11/10/2026', '12:30 11/10/2026',
    '07:30 12/10/2026', '08:30 12/10/2026', '09:30 12/10/2026', '10:30 12/10/2026',
  ]);
  // Gia hạn tới thứ 3: thêm 11:30 thứ 2; 12:30 thứ 2 đã là tuần mới.
  assert.deepEqual(at(autoSendRuns({ weekId: WEEK, afterMs: vn('2026-10-12T10:00:00').getTime(), closesMs: vn('2026-10-13T17:00:00').getTime() })),
    ['10:30 12/10/2026', '11:30 12/10/2026']);
  // Rút hạn về 15:40 thứ 6: thứ 6 không xét quy tắc 1 giờ -> 15:00, 15:15, 15:30.
  assert.deepEqual(at(autoSendRuns({ weekId: WEEK, afterMs: 0, closesMs: vn('2026-10-09T15:40:00').getTime() })),
    ['15:00 09/10/2026', '15:15 09/10/2026', '15:30 09/10/2026']);
  // closesMs hỏng -> hạn mặc định (không ném lỗi).
  for (const bad of [NaN, Infinity, 1e20]) assert.deepEqual(autoSendRuns({ weekId: WEEK, afterMs: 0, closesMs: bad }), autoSendRuns({ weekId: WEEK, afterMs: 0 }), String(bad));

  // Đối chiếu với quy tắc viết độc lập (README mục "Gửi bù") cho nhiều hạn khác nhau.
  const opens = vn('2026-10-09T15:00:00').getTime();
  const switchMs = vn('2026-10-12T12:00:00').getTime();
  const fridayEnds = vn('2026-10-10T00:00:00').getTime();
  const closesList = ['2026-10-09T15:40:00', '2026-10-09T23:00:00', '2026-10-10T08:00:00', '2026-10-11T20:00:00', '2026-10-12T11:00:00',
    '2026-10-12T12:00:00', '2026-10-12T12:20:00', '2026-10-13T17:00:00', '2026-11-13T12:00:00'].map(s => vn(s).getTime());
  for (const closes of closesList) {
    const want = scheduledSurveyRuns(WEEK).filter(t => t >= opens && t < switchMs && t < closes && (t < fridayEnds || closes - t >= MIN_CATCH_UP_MS));
    assert.deepEqual(autoSendRuns({ weekId: WEEK, afterMs: 0, closesMs: closes }), want, formatVnDateTime(new Date(closes).toISOString()));
  }
});

test('lý do khi còn người chưa gửi được: chỉ hứa gửi nốt khi một lần chạy THEO LỊCH thật sự còn gửi', () => {
  const args = { weekId: WEEK, failed: 300, errors: ['HTTP 400'] };
  const reason = (/** @type {string} */ ran, extra = {}) => runReasons({ ...args, ranAt: vn(ran).toISOString(), ...extra }).join(' ');
  const NONE = /^300 người chưa gửi được \(HTTP 400\)\. Không còn lần chạy tự động nào gửi nốt: chạy tay node survey-invite\.mjs --week 2026-10-05 \(còn dưới 1 giờ tới hạn thì thêm --force\)\.$/;

  // Hạn mặc định, lỗi lúc 10:30 thứ 2: lần 11:30 còn 30 phút (too_late), 12:30 là tuần mới -> không hứa.
  const mon = reason('2026-10-12T10:30:00');
  assert.doesNotMatch(mon, /Lần chạy sau sẽ gửi nốt/);
  assert.match(mon, NONE);
  // Hạn rút về 20:00 CN, lỗi lúc 12:30 CN: không còn giờ chạy nào trước 19:00 CN, 07:30 thứ 2 đã đóng.
  assert.match(reason('2026-10-11T12:30:00', { closesMs: vn('2026-10-11T20:00:00').getTime() }), NONE);
  // Giờ cuối trước hạn (11:20 thứ 2), và chạy tay thứ 3 sau khi gia hạn tới thứ 4: không còn lần tự động nào.
  assert.match(reason('2026-10-12T11:20:00'), NONE);
  assert.match(reason('2026-10-13T09:00:00', { closesMs: vn('2026-10-14T17:00:00').getTime() }), NONE);
  // Lần chạy kết thúc khi khảo sát đã đóng: chạy tay (kể cả --force) cũng không gửi -> nói phải gia hạn trước.
  const closed = reason('2026-10-12T11:59:00', { endedAt: vn('2026-10-12T12:00:30').toISOString() });
  assert.match(closed, /Không còn lần chạy tự động nào gửi nốt: khảo sát đã đóng, muốn mời thì quản trị Gia hạn rồi chạy tay node survey-invite\.mjs --week 2026-10-05 \(thư ghi hạn mới\)\.$/);
  assert.doesNotMatch(closed, /--force/);

  // Lỗi lúc 15:05 thứ 6: lần 15:15 gửi nốt; lần tự động cuối là 10:30 thứ 2.
  assert.equal(reason('2026-10-09T15:05:00'), '300 người chưa gửi được (HTTP 400). Lần chạy sau sẽ gửi nốt (lần theo lịch kế tiếp ' +
    '15:15 09/10/2026, lần tự động cuối cùng 10:30 12/10/2026; sau đó phải chạy tay --week 2026-10-05).');
  // Lần 15:00 chạy tới 15:16: giờ lặp 15:15 bị bỏ ("Do not start a new instance") -> kế tiếp là 15:30.
  assert.match(reason('2026-10-09T15:00:00', { endedAt: vn('2026-10-09T15:16:00').toISOString() }), /lần theo lịch kế tiếp 15:30 09\/10\/2026,/);
  // Thứ 7 10:30: lần 11:30 cùng ngày vẫn gửi.
  assert.match(reason('2026-10-10T10:30:00'), /lần theo lịch kế tiếp 11:30 10\/10\/2026,/);
  // 09:30 thứ 2: 10:30 là lần cuối.
  assert.match(reason('2026-10-12T09:30:00'), /lần theo lịch kế tiếp 10:30 12\/10\/2026, cũng là lần tự động cuối cùng; sau đó phải chạy tay --week 2026-10-05\)\.$/);
  // Gia hạn tới thứ 3, lỗi 10:30 thứ 2: lần 11:30 còn gửi (hạn thật còn xa).
  assert.match(reason('2026-10-12T10:30:00', { closesMs: vn('2026-10-13T17:00:00').getTime() }), /lần theo lịch kế tiếp 11:30 12\/10\/2026, cũng là lần tự động cuối cùng/);
  // --force thứ 5 lỗi: 15:00 thứ 6 gửi nốt.
  assert.match(reason('2026-10-08T10:00:00'), /lần theo lịch kế tiếp 15:00 09\/10\/2026,/);
  // Không biết giờ chạy: chỉ nêu điều kiện, không nêu giờ nào.
  const unknown = runReasons({ weekId: WEEK, failed: 3 }).join(' ');
  assert.equal(unknown, '3 người chưa gửi được (dừng giữa chừng). Lần chạy sau sẽ gửi nốt (nếu còn lần chạy tự động theo lịch trước ' +
    '12:00 thứ 2 và còn ít nhất 1 giờ tới hạn; không thì chạy tay --week 2026-10-05).');
});

test('lý do: câu "việc tiếp theo" đúng dạng mà tab quản trị (agentNote) bỏ trọn, không để lại mẩu', async () => {
  // Bản sao các biểu thức agentNote trong src/components/SurveyResults.tsx: thẻ tự
  // tính việc tiếp theo theo giờ hiện tại nên bỏ câu agent viết lúc chạy. Agent
  // đổi dạng câu thì sửa cả hai nơi.
  const adminNote = (/** @type {string} */ s) => s
    .replace(/\s*Lần chạy sau sẽ gửi nốt(?:\s*\([^)]*\))?\.?/g, '')
    .replace(/\s*Không còn lần chạy tự động nào gửi nốt:[^()]*?(?:\([^)]*\))?\.(?=\s|$)/g, '')
    .replace(/,\s*lần chạy sau gửi tiếp(?=\.)/g, '')
    .trim();
  const SHAPE = /(?:Lần chạy sau sẽ gửi nốt \([^()]*\)|Không còn lần chạy tự động nào gửi nốt: [^()]*\([^()]*\))\.$/;
  const errors = ['Endpoint trả HTTP 400: Khảo sát tuần này đã đóng lúc 12h00 thứ 2, ngày 12/10/2026 (closesAt đã qua) — không gửi lời mời.'];
  const stop = 'không kiểm tra được trạng thái khảo sát trước khi gửi (14 UNAVAILABLE) — dừng gửi các thư còn lại.';
  for (const ran of ['2026-10-08T10:00:00', '2026-10-09T15:00:00', '2026-10-10T12:30:00', '2026-10-12T09:30:00', '2026-10-12T10:30:00', '2026-10-13T09:00:00', '']) {
    const ranAt = ran ? vn(ran).toISOString() : '';
    const failedReason = runReasons({ weekId: WEEK, ranAt, failed: 300, errors }).join(' ');
    assert.match(failedReason, SHAPE, ran);
    assert.equal(adminNote(failedReason), `300 người chưa gửi được (${errors[0]}).`, ran);
    const stopReason = runReasons({ weekId: WEEK, ranAt, failed: 10, stopReason: stop, stopRetryable: true }).join(' ');
    assert.match(stopReason, SHAPE, ran);
    assert.equal(adminNote(stopReason), `10 người chưa được gửi: ${stop}`, ran);
  }

  // email.reason bị cắt ở 500 ký tự: lỗi dài (3 lỗi khác nhau, mỗi lỗi 200 ký tự
  // — mức inviteOutcome cho phép) + ghi chú gửi bù + ghi chú người nhận vẫn để
  // câu "việc tiếp theo" nguyên vẹn, không còn mẩu nào trên thẻ quản trị.
  const long = (/** @type {string} */ c) => `Gửi email thất bại: HTTP 400 — ${c.repeat(200)}`.slice(0, 200);
  const sat = vn('2026-10-10T07:30:00').toISOString();
  const notes = ['1 người không có email @hoangmaistarschool.edu.vn trong tài khoản, không gửi được.'];
  const big = runReasons({ weekId: WEEK, catchUp: true, ranAt: sat, failed: 300, errors: [long('a'), long('b'), long('c')], notes }).join(' ');
  const stored = buildEmailStatus({ status: 'error', at: sat, failed: 300, reason: big, secret: GOOD_SECRET }).reason;
  assert.ok(stored.length <= 500);
  assert.match(stored, /Lần chạy sau sẽ gửi nốt \(lần theo lịch kế tiếp 08:30 10\/10\/2026, lần tự động cuối cùng 10:30 12\/10\/2026; sau đó phải chạy tay --week 2026-10-05\)\./);
  assert.doesNotMatch(adminNote(stored), /lần theo lịch|tự động cuối|--week/);
  assert.match(stored, /aaa…\)\. Lần chạy sau/, 'phần lỗi được rút gọn, có dấu …');
  // Lỗi Firestore dài khi kiểm tra trước thư: cũng rút gọn, câu sau còn nguyên.
  const r = await sendInvitations({
    batches: inviteBatches(people(10)),
    beforeBatch: async () => { throw new Error(`13 INTERNAL: ${'y'.repeat(600)}`); },
    post: async () => { throw new Error('không được gọi'); },
    journal: async () => {},
  });
  assert.equal(r.stopRetryable, true);
  const stopStored = buildEmailStatus({ status: 'error', at: sat, failed: 10, secret: GOOD_SECRET,
    reason: runReasons({ weekId: WEEK, catchUp: true, ranAt: sat, failed: r.failed, stopReason: r.stopReason, stopRetryable: r.stopRetryable, notes }).join(' ') }).reason;
  assert.ok(stopStored.length <= 500);
  assert.match(stopStored, /\(13 INTERNAL: y+…\) — dừng gửi các thư còn lại\. Lần chạy sau sẽ gửi nốt \(lần theo lịch kế tiếp 08:30 10\/10\/2026, [^()]*\)\./);
  assert.equal(shorten('x'.repeat(150), 100).length, 100);
  assert.equal(shorten('  ngắn  ', 100), 'ngắn');
});

// ------------------------------------------------------------- quyền gửi (lease)

test('quyền gửi: của mình / máy khác đang giữ / hết hạn / đã trả', () => {
  const now = Date.parse('2026-10-09T08:05:00.000Z');
  const lease = buildLease({ token: 'A', host: 'HAC-PC\n', pid: 4242, nowMs: now, startedAt: '2026-10-09T08:05:00.000Z' });
  assert.deepEqual({ ...lease, until: lease.until.getTime() }, {
    token: 'A', host: 'HAC-PC', pid: 4242, startedAt: '2026-10-09T08:05:00.000Z', until: now + SEND_LEASE_MS, released: false,
  });
  assert.ok(lease.until instanceof Date, 'Date -> Timestamp');
  assert.equal(SEND_LEASE_MS, 10 * 60_000);
  assert.equal(leaseState({ lease: null, token: 'B', nowMs: now }), 'free');
  assert.equal(leaseState({ lease, token: 'A', nowMs: now }), 'mine');
  assert.equal(leaseState({ lease, token: 'B', nowMs: now + 60_000 }), 'busy');
  assert.equal(leaseState({ lease, token: 'B', nowMs: now + SEND_LEASE_MS }), 'free', 'hết hạn (lần chạy chết giữa chừng)');
  assert.equal(leaseState({ lease: { ...lease, released: true }, token: 'B', nowMs: now }), 'free');
  assert.equal(leaseState({ lease: { ...lease, released: true }, token: 'A', nowMs: now }), 'free');
  // Của mình mà quá hạn nhưng chưa ai lấy (vẫn token mình) -> vẫn của mình.
  assert.equal(leaseState({ lease, token: 'A', nowMs: now + SEND_LEASE_MS * 3 }), 'mine');
  // Timestamp của firebase-admin.
  assert.equal(leaseState({ lease: { token: 'A', until: { toMillis: () => now + 1000 } }, token: 'B', nowMs: now }), 'busy');
  assert.equal(leaseState({ lease: { token: 'A', until: 'rác' }, token: 'B', nowMs: now }), 'free');
});

test('kiểm tra trước mỗi thư: còn quyền gửi và khảo sát chưa đóng theo hạn MỚI NHẤT', () => {
  const now = vn('2026-10-09T15:06:00');
  const lease = buildLease({ token: 'A', nowMs: now.getTime(), startedAt: '' });
  const week = { closesAt: { toMillis: () => Date.parse(surveyClosesAt(WEEK)) } };
  assert.equal(batchGate({ week, lease, token: 'A', now }), null);
  assert.match(batchGate({ week, lease, token: 'B', now }), /lần chạy khác.*dừng để không gửi trùng/);
  assert.match(batchGate({ week, lease: null, token: 'A', now }), /lần chạy khác/);
  // Quản trị bấm "Đóng ngay" lúc 15:05:30.
  const closedNow = { closesAt: { toMillis: () => vn('2026-10-09T15:05:30').getTime() } };
  assert.match(batchGate({ week: closedNow, lease, token: 'A', now }), /đã đóng lúc 15:05 09\/10\/2026.*Đóng ngay/);
  assert.match(batchGate({ week: {}, lease, token: 'A', now }), /không còn hạn đóng/);
  assert.match(batchGate({ week: null, lease, token: 'A', now }), /không còn hạn đóng/);
});

test('danh sách được mời: người đang mời + người lần trước đã nhận thư', () => {
  const cur = people(3);
  const previous = [
    { uid: 'old-sent', fullName: 'A', department: 'B', email: 'Old@hoangmaistarschool.edu.vn' },
    { uid: 'old-unsent', fullName: 'C', department: 'D', email: 'x@hoangmaistarschool.edu.vn' },
    { uid: 'u0', fullName: 'tên cũ', department: '', email: cur[0].email },
    'rác', null,
  ];
  const merged = mergeInvitedRecipients({ previous, current: cur, sentEmails: ['old@hoangmaistarschool.edu.vn'] });
  assert.deepEqual(merged.map(r => r.uid), ['u0', 'u1', 'u2', 'old-sent']);
  assert.equal(merged[0].fullName, 'Người 0', 'thông tin mới nhất thắng');
  assert.deepEqual(mergeInvitedRecipients({ previous: undefined, current: [], sentEmails: undefined }), []);
});

// ------------------------------------------------------------- tham số, cấu hình

test('tham số: tham số lạ bị từ chối; --week phải là thứ 2, không ở tương lai', () => {
  const today = '2026-10-09';
  assert.deepEqual(parseSurveyArgs(['--quiet'], { today }), { dryRun: false, force: false, quiet: true, week: null, errors: [] });
  const ok = parseSurveyArgs(['--dry-run', '--force', '--week', '2026-09-28'], { today });
  assert.deepEqual(ok, { dryRun: true, force: true, quiet: false, week: '2026-09-28', errors: [] });
  assert.equal(parseSurveyArgs(['--week', '2026-10-05'], { today }).week, '2026-10-05', 'tuần hiện tại được');

  for (const argv of [['--dryrun'], ['--send-alerts'], ['-f'], ['--week=2026-10-05'], ['--help']]) {
    const a = parseSurveyArgs(argv, { today });
    assert.match(a.errors[0], /Tham số không hợp lệ/, argv.join(' '));
    assert.ok(SURVEY_FLAGS.every(f => a.errors[0].includes(f)));
  }
  assert.match(parseSurveyArgs(['--week', '2026-10-07'], { today }).errors[0], /không phải thứ 2.*2026-10-05/);
  assert.match(parseSurveyArgs(['--week', '2026-10-12'], { today }).errors[0], /tương lai/);
  assert.match(parseSurveyArgs(['--week'], { today }).errors[0], /--week cần/);
  assert.match(parseSurveyArgs(['--week', '2026-02-30'], { today }).errors[0], /--week cần/);
  assert.equal(parseSurveyArgs(['--week', '--dry-run'], { today }).dryRun, true);
});

test('cấu hình: bản mẫu đang tắt; dùng chung alerts.endpoint/secret; không lộ khoá', () => {
  const example = JSON.parse(readFileSync(join(AGENT, 'config.example.json'), 'utf8'));
  assert.deepEqual(example.survey, { enabled: false }, 'config.example.json có khối survey, để tắt');
  const ex = readSurveyConfig(example);
  assert.equal(ex.enabled, false);
  assert.match(ex.disabledReason, /survey\.enabled đang tắt/);
  assert.deepEqual(ex.problems, ['alerts.secret vẫn là chữ mẫu, chưa điền khoá thật.']);

  const good = readSurveyConfig({ ...example, survey: { enabled: true }, alerts: { ...example.alerts, secret: GOOD_SECRET } });
  assert.equal(good.enabled, true);
  assert.equal(good.disabledReason, null);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.cfg, { endpoint: 'https://dkan.nshm.vn/api/meal-alerts', secret: GOOD_SECRET });
  // alerts.notBefore sai là chuyện của email cảnh báo, không chặn lời mời khảo sát.
  assert.deepEqual(readSurveyConfig({ survey: { enabled: true }, alerts: { endpoint: example.alerts.endpoint, secret: GOOD_SECRET, notBefore: 'x' } }).problems, []);

  assert.equal(readSurveyConfig({ survey: { enabled: 'true' } }).enabled, false, '"true" dạng chuỗi không phải là bật');
  assert.match(readSurveyConfig({}).disabledReason, /chưa có khối "survey"/);
  assert.match(readSurveyConfig({ survey: { enabled: true } }).problems[0], /chưa có khối "alerts"/);
  assert.deepEqual(readSurveyConfig({ survey: { enabled: true }, alerts: { secret: GOOD_SECRET } }).problems, ['alerts.endpoint đang trống.']);
  assert.match(readSurveyConfig({ alerts: { endpoint: 'http://dkan.nshm.vn/api/meal-alerts', secret: GOOD_SECRET } }).problems[0], /https/);
  assert.deepEqual(readSurveyConfig({ alerts: { endpoint: 'http://127.0.0.1:3000/api/meal-alerts', secret: GOOD_SECRET } }).problems, []);

  const leaky = readSurveyConfig({ alerts: { endpoint: 'x', secret: 'bi-mat-ngan-qua' } });
  assert.equal(leaky.problems.length, 2);
  assert.equal(JSON.stringify(leaky.problems).includes('bi-mat-ngan-qua'), false);
});

test('che email trong log', () => {
  assert.equal(maskEmail('nguyenvana@hoangmaistarschool.edu.vn'), 'n***@hoangmaistarschool.edu.vn');
  assert.equal(maskEmail('khong-phai-email'), '***');
  assert.equal(scrubEmails('Lỗi gửi tới <ab@x.vn>, cd@y.vn; xong'), 'Lỗi gửi tới <a***@x.vn>, c***@y.vn; xong');
  assert.equal(scrubEmails(scrubEmails('ab@x.vn')), 'a***@x.vn');
  assert.equal(scrubEmails('gửi ab@x.vn lỗi', () => '?'), 'gửi ? lỗi');
  assert.equal(scrubEmails(undefined), '');
});

test('script gửi lời mời: firebase-admin nạp muộn, hẹn giờ thoát trước khi đóng kết nối, không exit sau fetch', () => {
  const src = readFileSync(join(AGENT, 'survey-invite.mjs'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s[^;]*['"]firebase-admin['"]/m);
  assert.match(src, /await import\('firebase-admin'\)/);
  const timer = src.indexOf('setTimeout(() => process.exit(exitCode), 20_000).unref();');
  const close = src.indexOf('map(app => app?.delete())');
  assert.ok(timer > 0 && close > timer);
  // process.exit chỉ ở hàm fail (lỗi cấu hình, trước mọi request) và hẹn giờ cưỡng bức.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.match(/process\.exit\(/g).length, 2);
  // Cổng giờ xét trước khi nạp Firebase: trước 15:00 thứ 6 không đọc gì.
  assert.ok(src.indexOf("early.action === 'wait'") < src.indexOf("await import('firebase-admin')"));
  // Mở khảo sát + giành quyền gửi trong MỘT giao dịch (đọc lại document tuần,
  // quyết định lại), trước vòng gửi; vòng gửi là sendInvitations (có test ở trên).
  const tx = src.indexOf('tx.getAll(weekRef, lockRef, invitedRef)');
  assert.ok(tx > 0);
  assert.ok(tx < src.indexOf('decideWeek({ weekId, now: at'), 'quyết định lại bằng lần đọc trong giao dịch');
  assert.ok(src.indexOf('decideWeek({ weekId, now: at') < src.indexOf('openWeekPatch({'));
  assert.ok(src.indexOf('openWeekPatch({') < src.indexOf('sendInvitations({'));
  assert.match(src, /serverTime: admin\.firestore\.FieldValue\.serverTimestamp\(\)/);
  assert.doesNotMatch(src, /mergeWeekDoc/);
  // Trạng thái cuối chỉ ghi khối email (không ghi lại opensAt/closesAt).
  assert.match(src, /setWithRetry\(weekRef, \{ email \}, \{ merge: true \}\)/);
  // Thư gửi kèm hạn THẬT, đọc lại trong giao dịch kiểm tra ngay trước mỗi thư.
  assert.match(src, /postAlerts\(SURVEY\.cfg, inviteRequest\(\{ weekId, closesMs, emails: batch\.map\(r => r\.email\), menu \}\)\)/);
  assert.match(src, /closesMs = toMillis\(week\?\.closesAt\) \?\? closesMs;/);
  // Thực đơn được đọc đúng tuần, một lần, trước cả chạy thử lẫn mở khảo sát.
  const menuRead = src.indexOf("db.collection('weekly_menus').doc(weekId).get()");
  assert.ok(menuRead > 0 && menuRead < src.indexOf('const noOne = invitees.length === 0;'));
  assert.equal(src.split("db.collection('weekly_menus').doc(weekId).get()").length - 1, 1);
  assert.match(src, /normalizeWeeklyMenu\(menuSnap\.data\(\), weekId\)/);
  assert.match(src, /if \(!hasMenuContent\(menu\)\) throw new Error/);
  assert.match(src, /throw new FatalError\(`Không đọc được thực đơn/);
  assert.match(src, /throw new FatalError\(`Thực đơn weekly_menus/);
  // Người nhận tính cả ngày nghỉ (không mời người cả tuần chưa có bữa nào).
  assert.match(src, /surveyRecipientUids\(\{ registrations: kept, weekId, excludedIds, offDays \}\)/);
  // Lý do tính lần chạy theo lịch kế tiếp từ lúc lần này KẾT THÚC, và biết vòng
  // gửi dừng vì lỗi tạm (khi đó mới nói lần nào gửi nốt).
  assert.match(src, /runReasons\(\{[^}]*endedAt: at\(\)[^}]*stopRetryable: result\.stopRetryable[^}]*\}\)/);
  const pkg = JSON.parse(readFileSync(join(AGENT, 'package.json'), 'utf8'));
  assert.ok(Object.values(pkg.scripts).some(s => s.includes('survey-invite.mjs')));
});
