import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCheckinExemption, normalizeCheckinExemptions, isLunchCheckinExempt, createCheckinExemptionMatcher } from '../lib/checkin-exemptions.mjs';
import { evaluatePersonDay, reconcile, buildFromCheckins } from '../lib/meal-rules.mjs';

const email = 'sample@hoangmaistarschool.edu.vn';
const policy = { employeeId: '100001', email, fullName: 'Nhân viên kiểm thử',
  periods: [{ from: '2026-11-02', to: '2026-11-05' }, { from: '2026-11-09', to: null }] };
const registration = { userId: 'sample_uid', employeeId: '100001', email, fullName: policy.fullName,
  breakfastCount: 21, lunchCount: 21, firstMealDate: '2026-11-01' };
const final = { now: new Date('2026-11-30T09:00:00Z'), coverageAt: '2026-11-30T09:00:00Z' };

test('exemption policy normalizes staff identity and retains nonoverlapping historical periods', () => {
  const normalized = normalizeCheckinExemption({ ...policy, employeeId: ' 100 001 ', email: ` ${email.toUpperCase()} `,
    periods: [...policy.periods].reverse() });
  assert.deepEqual(normalized, { ...policy, periods: policy.periods.map(period => ({ ...period, meals: ['lunch'] })) });
  assert.deepEqual(normalizeCheckinExemptions(), []);
  for (const date of ['2026-11-02', '2026-11-05', '2026-11-09', '2026-12-31']) {
    assert.equal(isLunchCheckinExempt({ date, employeeId: registration.employeeId, email, checkinExemptions: [policy] }), true);
  }
  for (const date of ['2026-10-30', '2026-11-06']) {
    assert.equal(isLunchCheckinExempt({ date, employeeId: registration.employeeId, email, checkinExemptions: [policy] }), false);
  }
});

test('bad policy identity, dates, duplicate IDs and overlapping periods fail closed', () => {
  const malformed = [
    null, { ...policy, employeeId: 'N/A' }, { ...policy, email: 'outsider@example.com' },
    { ...policy, periods: [] }, { ...policy, periods: [{ from: '2026-02-30', to: null }] },
    { ...policy, periods: [{ from: '2026-11-05', to: '2026-11-04' }] },
    { ...policy, periods: [{ from: '2026-11-02', to: null }, { from: '2026-11-06', to: null }] },
  ];
  for (const value of malformed) assert.throws(() => normalizeCheckinExemption(value), TypeError);
  assert.throws(() => normalizeCheckinExemptions([policy, policy]), TypeError);
  assert.throws(() => normalizeCheckinExemptions(null), TypeError);
  assert.equal(isLunchCheckinExempt({ date: '2026-11-02', employeeId: '100001', email: 'other@hoangmaistarschool.edu.vn', checkinExemptions: [policy] }), false);
  assert.equal(isLunchCheckinExempt({ date: '2026-11-02', employeeId: '100002', email, checkinExemptions: [policy] }), false);
});

test('only absent registered lunch is exempt and breakfast remains a finalized missing meal', () => {
  const result = evaluatePersonDay({ date: '2026-11-02', registration, checkinExemptions: [policy], ...final });
  assert.deepEqual(result.meals.lunch, { code: 'exempt', time: null });
  assert.equal(result.meals.breakfast.code, 'missing');
  assert.equal(evaluatePersonDay({ date: '2026-11-06', registration, checkinExemptions: [policy], ...final }).meals.lunch.code, 'missing');
  assert.equal(evaluatePersonDay({ date: '2026-11-02', registration, email: 'other@hoangmaistarschool.edu.vn', checkinExemptions: [policy], ...final }).meals.lunch.code, 'missing');
});

test('exemption does not fabricate taps or registration and real lunch taps remain ok', () => {
  assert.deepEqual(evaluatePersonDay({ date: '2026-11-02', registration, times: ['12:01'], checkinExemptions: [policy], ...final }).meals.lunch,
    { code: 'ok', time: '12:01' });
  const noRegistration = evaluatePersonDay({ date: '2026-11-02', registration: null, email, times: ['12:01'], checkinExemptions: [policy], ...final });
  assert.equal(noRegistration.meals.lunch.code, 'extra');
  const canceled = evaluatePersonDay({ date: '2026-11-02', registration, times: ['12:01'], checkinExemptions: [policy],
    cancelations: [{ userId: registration.userId, cancelDate: '2026-11-02', cancelMeal: 'lunch' }], ...final });
  assert.equal(canceled.meals.lunch.code, 'extra');
});

test('whole-school reconciliation keeps registered totals while separating exempt lunch from missing', () => {
  const byDate = buildFromCheckins([{ date: '2026-11-02', people: {} }]).byDate;
  const result = reconcile({ byDate, dates: ['2026-11-02'], registrations: [registration], cancelations: [], checkinExemptions: [policy] });
  assert.equal(result.registered.length, 2);
  assert.deepEqual(result.missing.map(row => row.meal), ['breakfast']);
  assert.deepEqual(result.exempt.map(row => row.meal), ['lunch']);
  assert.equal(result.tapped.length, 0);
  assert.equal(result.extra.length, 0);
});

test('per-meal periods allow breakfast, lunch or both without applying the other meal implicitly', () => {
  for (const meals of [['breakfast'], ['lunch'], ['breakfast', 'lunch']]) {
    const checkinExemptions = [{ ...policy, periods: [{ from: '2026-11-02', to: null, meals }] }];
    const result = evaluatePersonDay({ date: '2026-11-02', registration, checkinExemptions, ...final });
    for (const meal of ['breakfast', 'lunch']) assert.equal(result.meals[meal].code, meals.includes(meal) ? 'exempt' : 'missing');
  }
});

test('overlapping dates are valid for separate meals while same-meal overlap is rejected', () => {
  const value = { ...policy, periods: [
    { from: '2026-11-02', to: '2026-11-05', meals: ['breakfast'] },
    { from: '2026-11-04', to: '2026-11-09', meals: ['lunch'] },
  ] };
  const match = createCheckinExemptionMatcher([value]);
  assert.equal(match({ date: '2026-11-02', employeeId: policy.employeeId, email, meal: 'breakfast' }), true);
  assert.equal(match({ date: '2026-11-02', employeeId: policy.employeeId, email, meal: 'lunch' }), false);
  assert.equal(match({ date: '2026-11-05', employeeId: policy.employeeId, email, meal: 'breakfast' }), true);
  assert.equal(match({ date: '2026-11-06', employeeId: policy.employeeId, email, meal: 'breakfast' }), false);
  assert.throws(() => normalizeCheckinExemption({ ...value, periods: [...value.periods,
    { from: '2026-11-05', to: null, meals: ['breakfast'] }] }), TypeError);
});

test('stored documents are validated one by one: a broken doc is reported with its id and reason, others still apply', async () => {
  const { parseCheckinExemptionDocs, exemptionQuarantine } = await import('../lib/checkin-exemptions.mjs');
  const good = { id: '100001', data: { ...policy, periods: [{ from: '2026-11-02', to: null, meals: ['lunch'] }], updatedAt: 'x', updatedBy: 'u' } };
  const legacy = { id: '100005', data: { employeeId: '100005', email: 'e5@hoangmaistarschool.edu.vn', fullName: 'Năm', periods: [{ from: '2026-11-02' }] } };
  const docs = [
    good,
    legacy,
    { id: '100002', data: { ...policy, employeeId: 100002 } },
    { id: '100003', data: { ...policy, employeeId: '100003', email: ' Up@HoangMaiStarSchool.edu.vn' } },
    { id: 'AutoId123', data: { ...policy, employeeId: '100004' } },
    { id: 'BrokenNoCode', data: { email: 'x' } },
  ];
  const { policies, invalid } = parseCheckinExemptionDocs(docs);
  assert.deepEqual(policies.map(item => item.employeeId), ['100001', '100005']);
  assert.deepEqual(policies[1].periods, [{ from: '2026-11-02', to: null, meals: ['lunch'] }], 'missing to/meals keep legacy meaning');
  assert.deepEqual(invalid.map(item => [item.docId, item.employeeId]), [
    ['100002', '100002'], ['100003', '100003'], ['AutoId123', '100004'], ['BrokenNoCode', null],
  ]);
  assert.match(invalid.find(item => item.docId === '100002').reason, /6 chữ số/);
  assert.match(invalid.find(item => item.docId === '100003').reason, /Email/);
  assert.match(invalid.find(item => item.docId === 'AutoId123').reason, /Mã tài liệu/);
  const quarantine = exemptionQuarantine(invalid);
  assert.deepEqual([...quarantine.ids].sort(), ['100002', '100003', '100004']);
  assert.equal(quarantine.unidentified, 1);
});

test('duplicate staff codes invalidate both documents and the valid twin of a broken doc is held', async () => {
  const { parseCheckinExemptionDocs } = await import('../lib/checkin-exemptions.mjs');
  const dup = parseCheckinExemptionDocs([{ id: '100001', data: policy }, { id: '100001', data: policy }]);
  assert.equal(dup.policies.length, 0);
  assert.equal(dup.invalid.length, 2);
  assert.match(dup.invalid[0].reason, /Trùng mã nhân viên/);
  const twin = parseCheckinExemptionDocs([{ id: '100001', data: policy }, { id: 'auto', data: { ...policy, email: 'bad' } }]);
  assert.deepEqual(twin.policies, [], 'a broken doc naming 100001 makes the 100001 policy unknown');
  assert.deepEqual(twin.invalid.map(item => item.employeeId), ['100001']);
});

test('field-specific messages replace the generic configuration error', () => {
  const cases = [
    [{ ...policy, employeeId: '12345' }, /Mã nhân viên phải gồm đúng 6 chữ số \(đang là "12345"\)/],
    [{ ...policy, email: 'a@gmail.com' }, /@hoangmaistarschool\.edu\.vn/],
    [{ ...policy, fullName: 'a\nb' }, /Họ tên/],
    [{ ...policy, periods: [] }, /từ 1 đến 100/],
    [{ ...policy, periods: [{ from: '2026-13-01', to: null }] }, /Ngày bắt đầu/],
    [{ ...policy, periods: [{ from: '2026-11-05', to: '2026-11-04' }] }, /Ngày kết thúc không được trước/],
    [{ ...policy, periods: [{ from: '2026-11-05', to: null, meals: ['Lunch'] }] }, /Bữa miễn chấm/],
    [{ ...policy, periods: [{ from: '2026-11-02', to: null }, { from: '2026-11-06', to: null }] }, /bữa trưa bị chồng nhau/],
  ];
  for (const [value, message] of cases) assert.throws(() => normalizeCheckinExemption(value), message);
});

test('emailMismatch flags a covering policy registered under another email, and reconcile notes it on the missing row', () => {
  const match = createCheckinExemptionMatcher([policy]);
  const identity = { date: '2026-11-02', employeeId: '100001', meal: 'lunch' };
  assert.equal(match({ ...identity, email }), true);
  assert.equal(match.emailMismatch({ ...identity, email }), false);
  assert.equal(match.emailMismatch({ ...identity, email: 'alias@hoangmaistarschool.edu.vn' }), true);
  assert.equal(match.emailMismatch({ ...identity, date: '2026-11-06', email: 'alias@hoangmaistarschool.edu.vn' }), false, 'outside every period');
  const byDate = buildFromCheckins([{ date: '2026-11-02', people: {} }]).byDate;
  const result = reconcile({ byDate, dates: ['2026-11-02'], registrations: [{ ...registration, email: 'alias@hoangmaistarschool.edu.vn' }],
    cancelations: [], checkinExemptions: [policy] });
  assert.equal(result.exempt.length, 0);
  const lunch = result.missing.find(row => row.meal === 'lunch');
  assert.match(lunch.note, /email trên đơn khác/);
  assert.equal(result.missing.find(row => row.meal === 'breakfast').note, undefined);
});

test('a broken document naming two codes (doc id and employeeId field) holds both codes', async () => {
  const { parseCheckinExemptionDocs, exemptionQuarantine } = await import('../lib/checkin-exemptions.mjs');
  const { policies, invalid } = parseCheckinExemptionDocs([
    { id: '100001', data: policy },
    { id: '100009', data: { ...policy, employeeId: '100001' } },
  ]);
  assert.deepEqual(invalid.map(item => [item.docId, item.employeeId, item.codes]), [['100009', '100009', ['100009', '100001']]]);
  assert.deepEqual(policies, [], '100001 is named by a broken document, so its valid policy is withheld');
  assert.deepEqual([...exemptionQuarantine(invalid).ids].sort(), ['100001', '100009']);
});
