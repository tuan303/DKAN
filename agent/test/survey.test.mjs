// Test cho khảo sát hằng tuần (lib/survey.mjs). Có thêm phép đối chiếu với
// firestore.rules: rules không import được JS nên mã đáp án bị chép sang đó —
// lệch nhau là người dùng bấm gửi rồi nhận lỗi quyền truy cập khó hiểu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SURVEY_QUESTIONS, SURVEY_ANSWER_KEYS, weekStartOf, surveyWeek, isWeekId, surveyDefaultOpensAt, surveyClosesAt,
  surveyWeekLabel, surveyDeadlineLabel, weekHasMeals, isSurveyOpen, toMillis, validateSurveyAnswers, surveyRecipientUids,
} from '../lib/survey.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('weekStartOf / surveyWeek: tuần tính từ thứ 2, chủ nhật thuộc tuần trước', () => {
  assert.equal(weekStartOf('2026-10-05'), '2026-10-05'); // thứ 2
  assert.equal(weekStartOf('2026-10-09'), '2026-10-05'); // thứ 6
  assert.equal(weekStartOf('2026-10-10'), '2026-10-05'); // thứ 7
  assert.equal(weekStartOf('2026-10-11'), '2026-10-05'); // chủ nhật
  assert.equal(weekStartOf('2026-10-01'), '2026-09-28'); // tuần vắt qua hai tháng
  assert.deepEqual(surveyWeek('2026-10-09'), { weekId: '2026-10-05', weekStart: '2026-10-05', weekEnd: '2026-10-09', closesOn: '2026-10-12' });
  assert.equal(isWeekId('2026-10-05'), true);
  assert.equal(isWeekId('2026-10-06'), false);
  assert.equal(isWeekId('2026-10-5'), false);
  assert.equal(isWeekId(null), false);
  // Ngày không có thật bị Date cuộn sang thứ 2 của tháng sau; rác thì không được ném lỗi.
  for (const v of ['2026-02-30', '2027-02-29', '2026-13-02', '2026-00-05', '9999-99-99']) assert.equal(isWeekId(v), false, v);
});

test('mở 15:00 thứ 6, đóng 12:00 thứ 2 tuần sau (giờ Việt Nam), nhãn đúng mẫu email', () => {
  assert.equal(surveyDefaultOpensAt('2026-10-05'), '2026-10-09T08:00:00.000Z');
  assert.equal(surveyClosesAt('2026-10-05'), '2026-10-12T05:00:00.000Z');
  assert.equal(surveyWeekLabel('2026-10-05'), '05/10 – 09/10/2026');
  assert.equal(surveyWeekLabel('2026-12-28'), '28/12 – 01/01/2027');
  assert.equal(surveyDeadlineLabel('2026-10-05'), '12h00 thứ 2, ngày 12/10/2026');
});

test('weekHasMeals: cả tuần nghỉ thì không khảo sát', () => {
  assert.equal(weekHasMeals('2026-10-05', []), true);
  const all = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  assert.equal(weekHasMeals('2026-10-05', all), false);
  assert.equal(weekHasMeals('2026-10-05', all.slice(0, 4)), true);
});

test('isSurveyOpen / toMillis: ISO, Date, Timestamp; biên [mở, đóng)', () => {
  const s = { opensAt: '2026-10-09T08:00:00.000Z', closesAt: { seconds: Date.parse('2026-10-12T05:00:00.000Z') / 1000, nanoseconds: 0 } };
  assert.equal(isSurveyOpen(s, new Date('2026-10-09T07:59:59Z')), false);
  assert.equal(isSurveyOpen(s, new Date('2026-10-09T08:00:00Z')), true);
  assert.equal(isSurveyOpen(s, new Date('2026-10-12T04:59:59Z')), true);
  assert.equal(isSurveyOpen(s, new Date('2026-10-12T05:00:00Z')), false);
  assert.equal(isSurveyOpen(null), false);
  assert.equal(isSurveyOpen({ opensAt: 'rác', closesAt: s.closesAt }), false);
  assert.equal(toMillis({ toMillis: () => 42 }), 42);
  assert.equal(toMillis(new Date('x')), null);
});

const full = { taste: 'ngon', variety: 'da_dang', warmth: 'du_nong', portion: 'vua_du', hygiene: 'sach', liked: 'Cá kho' };

test('validateSurveyAnswers: bắt buộc, mã đáp án, độ dài, làm sạch chữ', () => {
  assert.deepEqual(validateSurveyAnswers(full), { ok: true, errors: {}, clean: full });

  const r = validateSurveyAnswers({ ...full, taste: 'tuyet', liked: '   ', disliked: 'x'.repeat(501) });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['disliked', 'liked', 'taste']);

  const c = validateSurveyAnswers({ ...full, liked: '  Bún\u0007  chả \t\t ngon \n\n\n\n quá ', suggestion: '' });
  assert.equal(c.clean.liked, 'Bún chả ngon \n\n quá');
  assert.equal('suggestion' in c.clean, false, 'câu không bắt buộc để trống thì không ghi');

  assert.equal(validateSurveyAnswers(null).ok, false);
});

test('surveyRecipientUids: có đơn còn hiệu lực trong tuần, bỏ bếp, bỏ đơn không ăn bữa nào', () => {
  const W = '2026-10-05';
  const regs = [
    { uid: 'a', month: '2026-10', employeeId: '101001', breakfastCount: 20, lunchCount: 20 },
    { uid: 'b', month: '2026-10', employeeId: '101002', breakfastCount: 0, lunchCount: 0 },
    { uid: 'c', month: '2026-10', employeeId: '100777', breakfastCount: 0, lunchCount: 20 },             // Bếp Vina
    { uid: 'd', month: '2026-10', employeeId: 'N/A', breakfastCount: 0, lunchCount: 20 },                // thiếu mã vẫn mời
    { uid: 'e', month: '2026-10', employeeId: '101005', firstMealDate: '2026-10-12', breakfastCount: 0, lunchCount: 10 }, // bắt đầu tuần sau
    { uid: 'f', month: '2026-10', employeeId: '101006', firstMealDate: '2026-10-09', timestamp: '2026-10-09T07:00:00.000Z', breakfastCount: 0, lunchCount: 10 }, // nộp 14:00 thứ 6
    { uid: 'g', month: '2026-09', employeeId: '101007', breakfastCount: 20, lunchCount: 20 },            // tháng khác
    { uid: 'a', month: '2026-10', employeeId: '101001', breakfastCount: 20, lunchCount: 20 },            // trùng
  ];
  assert.deepEqual(surveyRecipientUids({ registrations: regs, weekId: W, excludedIds: ['100777'] }), ['a', 'd']);

  // Tuần vắt qua hai tháng: đơn tháng 9 và tháng 10 đều tính.
  const cross = surveyRecipientUids({ registrations: [{ ...regs[6] }, { ...regs[0] }], weekId: '2026-09-28' });
  assert.deepEqual(cross, ['a', 'g']);
});

test('firestore.rules khớp SURVEY_QUESTIONS (mã đáp án, câu bắt buộc, độ dài)', () => {
  const rules = readFileSync(join(HERE, '..', '..', 'firestore.rules'), 'utf8');
  const fn = rules.slice(rules.indexOf('function validSurveyAnswers'), rules.indexOf('function surveyOpen'));
  assert.ok(fn.length > 0, 'không tìm thấy validSurveyAnswers trong firestore.rules');

  const keys = fn.match(/hasOnly\(\[([^\]]+)\]\)/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.deepEqual(keys, SURVEY_ANSWER_KEYS);

  for (const q of SURVEY_QUESTIONS) {
    if (q.kind === 'choice') {
      const m = fn.match(new RegExp(`a\\.${q.id} in \\[([^\\]]+)\\]`));
      assert.ok(m, `rules thiếu kiểm tra ${q.id}`);
      assert.deepEqual(m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1)), q.options.map(o => o.value), q.id);
    } else {
      assert.match(fn, new RegExp(`a\\.${q.id}\\.size\\(\\) <= ${q.maxLength}\\b`), `${q.id} tối đa ${q.maxLength}`);
      const required = new RegExp(`a\\.${q.id} is string && a\\.${q.id}\\.size\\(\\) > 0`).test(fn);
      assert.equal(required, q.required, `${q.id} bắt buộc: ${q.required}`);
    }
  }
});

test('surveyRecipientUids: chỉ mời khi còn ít nhất một ngày có suất ăn mà đơn phủ trong tuần', () => {
  const W = '2026-10-05';
  const regs = [
    // Bắt đầu đúng thứ 6, mà thứ 6 là ngày nghỉ: tuần này chưa ăn bữa nào.
    { uid: 'f', month: '2026-10', firstMealDate: '2026-10-09', timestamp: '2026-10-02T02:00:00.000Z', breakfastCount: 0, lunchCount: 10 },
    // Bắt đầu thứ 5: còn thứ 5 là ngày ăn.
    { uid: 't', month: '2026-10', firstMealDate: '2026-10-08', timestamp: '2026-10-02T02:00:00.000Z', breakfastCount: 0, lunchCount: 10 },
  ];
  assert.deepEqual(surveyRecipientUids({ registrations: regs, weekId: W, offDays: ['2026-10-09'] }), ['t']);
  assert.deepEqual(surveyRecipientUids({ registrations: regs, weekId: W }), ['f', 't']);

  // Tuần vắt hai tháng (28/09 – 02/10): đơn tháng 10 chỉ phủ 01–02/10; nếu cả hai ngày nghỉ thì không mời.
  const oct = { uid: 'o', month: '2026-10', breakfastCount: 0, lunchCount: 20 };
  assert.deepEqual(surveyRecipientUids({ registrations: [oct], weekId: '2026-09-28', offDays: ['2026-10-01', '2026-10-02'] }), []);
  assert.deepEqual(surveyRecipientUids({ registrations: [oct], weekId: '2026-09-28', offDays: ['2026-10-01'] }), ['o']);
});
