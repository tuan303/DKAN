/**
 * Gửi email mời CBGV-NV có đăng ký ăn làm khảo sát chất lượng phục vụ suất ăn
 * của tuần — 15:00 thứ 6 hằng tuần, qua endpoint /api/meal-alerts (hộp thư
 * Nhóm Dinh dưỡng trên Microsoft Graph), cùng khoá với email cảnh báo.
 *
 * Mỗi lần chạy:
 *   1. kiểm tra cấu hình (survey.enabled, alerts.endpoint, alerts.secret);
 *   2. chọn tuần và kiểm tra giờ (từ 15:00 thứ 6; thứ 7 tới sáng thứ 2 thì gửi
 *      bù nếu tuần đó chưa gửi xong, khảo sát chưa đóng và còn ít nhất 1 giờ);
 *   3. tuần nghỉ cả tuần -> ghi 'skipped', không mở khảo sát;
 *   4. đã gửi xong -> thôi (Task Scheduler chạy lặp nhiều lần);
 *   5. tính người nhận;
 *   6. trong MỘT giao dịch Firestore: đọc lại document tuần, quyết định lại
 *      (quản trị có thể vừa đóng khảo sát), giành quyền gửi
 *      (private/lock — chặn cả lần chạy từ máy khác) và mở khảo sát (chỉ ghi
 *      phần còn thiếu, giữ giờ quản trị đã đặt);
 *   7. gửi theo lô Bcc ≤ 400 người; trước mỗi thư kiểm tra lại quyền gửi và hạn
 *      đóng (hạn mới nhất gửi kèm để thư ghi đúng hạn thật), sau mỗi thư ghi
 *      ngay ai đã nhận (private/invited) để thư sau lỗi không gửi trùng; thư
 *      "không rõ đã đi chưa" (kể cả khi endpoint báo maybeSent) thì không tự
 *      gửi lại;
 *   8. ghi trạng thái email vào document tuần (chỉ số đếm, không email/uid).
 *
 * Cách chạy:
 *   node survey-invite.mjs                     chạy thật (Task Scheduler gọi qua khao-sat-bua-an.bat)
 *   node survey-invite.mjs --dry-run           chỉ đọc và in kế hoạch, không ghi, không gửi
 *   node survey-invite.mjs --week 2026-10-05   tuần cụ thể (ngày thứ 2)
 *   node survey-invite.mjs --force             bỏ kiểm tra giờ 15:00 thứ 6 (gửi bù / gửi sớm),
 *                                              và gửi lại cho người "không rõ đã nhận thư"
 *
 * Quy tắc (chọn tuần, cổng giờ, người nhận, chia lô, vòng gửi, quyền gửi,
 * trạng thái) nằm trong lib/survey-plan.mjs và lib/survey.mjs (thuần, có
 * test). File này chỉ lo nói chuyện với Firestore, Firebase Auth và endpoint.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vnToday, formatVnDateTime } from './lib/meal-rules.mjs';
import { chunk, redact } from './lib/common.mjs';
import { cleanRegistrations, dropGhosts } from './lib/registrations.mjs';
import { acquireLock } from './lib/run-lock.mjs';
import { postAlerts } from './lib/endpoint.mjs';
import { surveyWeek, surveyWeekLabel, surveyDeadlineLabel, surveyRecipientUids, toMillis } from './lib/survey.mjs';
import {
  parseSurveyArgs, readSurveyConfig, defaultSurveyWeekId, decideWeek, openWeekPatch, skippedWeekDoc,
  buildEmailStatus, buildInvitees, pendingInvitees, emailList, inviteBatches, mergeInvitedRecipients, inviteOutcome,
  inviteRequest, leaseState, buildLease, batchGate, SEND_LEASE_MS, sendInvitations, finalSurveyStatus, runReasons,
  inviteeNotes, maskEmail, scrubEmails,
} from './lib/survey-plan.mjs';
// firebase-admin nạp muộn, ngay trước lúc cần Firestore: lần chạy trước 15:00
// thứ 6 (hay khi tính năng đang tắt) thoát ngay mà không cần tới nó.

// In ra mỗi lần chạy để biết chắc máy đang dùng bản nào.
const SURVEY_AGENT_VERSION = '2026-10-13.4';

const HERE = dirname(fileURLToPath(import.meta.url));

const log = (...a) => console.log(...a);
// Chỉ dùng cho lỗi cấu hình, TRƯỚC khi có request mạng nào (xem cuối file vì
// sao không được gọi process.exit() sau khi đã dùng fetch).
const fail = msg => { console.error('\n  LỖI: ' + msg + '\n'); process.exit(1); };
/** Lỗi dừng hẳn, đã có thông báo dễ hiểu — in ra không kèm stack. */
class FatalError extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** ms -> "15:05 09/10/2026" (giờ VN). */
const vnTime = (/** @type {number} */ ms) => formatVnDateTime(new Date(ms).toISOString());
/** Giờ máy chủ Firestore của một lần đọc (ms), nếu SDK cho biết. */
const readTimeMs = (/** @type {any} */ snap) => {
  const t = snap?.readTime;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
};

// Ghi Firestore lỗi thì thử lại vài lần (lỗi mạng thoáng qua) trước khi bỏ.
const WRITE_ATTEMPTS = 3;
// Số người nhận in thử (đã che địa chỉ) khi chạy --dry-run.
const PREVIEW_COUNT = 5;

// Mã thoát (Task Scheduler "Last Run Result") — xem cuối file và README.
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_SEND_FAILED = 2;
const EXIT_SENT_BUT_UNRECORDED = 3;

// ---------------------------------------------------------------- cấu hình

const args = parseSurveyArgs(process.argv.slice(2), { today: vnToday() });
if (args.errors.length) fail(args.errors.join('\n  '));
const DRY_RUN = args.dryRun;

let config;
try {
  config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
} catch (err) {
  fail(
    'Không đọc được config.json. Hãy chép config.example.json thành config.json ' +
    'rồi điền thông tin.\n  Chi tiết: ' + err.message
  );
}

const SURVEY = readSurveyConfig(config);
const SECRET = SURVEY.cfg.secret;

// firebase-admin sau khi nạp — giữ lại để đóng kết nối lúc kết thúc.
let firebaseAdmin = null;
// Giải phóng khoá "đang chạy" (xem lib/run-lock.mjs) lúc kết thúc.
let releaseLock = () => {};
// Số người lần này đã được gửi thư (hoặc không rõ đã được gửi chưa). Lỗi bất
// ngờ xảy ra SAU khi đã gửi thì mã thoát phải nói rõ là đã gửi (mã 3), không
// được báo "chưa gửi gì" (mã 1).
let touchedThisRun = 0;

/** set() có thử lại — dùng cho mọi lần ghi ngoài giao dịch của script. */
async function setWithRetry(ref, data, opts) {
  let lastErr;
  for (let i = 0; i < WRITE_ATTEMPTS; i++) {
    try {
      await ref.set(data, opts);
      return;
    } catch (err) {
      lastErr = err;
      if (i < WRITE_ATTEMPTS - 1) await sleep(1000 * (i + 1) * 2);
    }
  }
  throw lastErr;
}

/** In số người nhận / đã nhận / sẽ gửi (dùng chung cho chạy thử và chạy thật). */
function logPlan({ kept, months, uids, invitees, prevSent, prevUncertain, pending, batches, notes }) {
  const sentSet = new Set(prevSent.map(s => s.toLowerCase()));
  const unsureSet = new Set(prevUncertain.map(s => s.toLowerCase()));
  const received = invitees.filter(r => sentSet.has(r.email.toLowerCase())).length;
  const unsure = invitees.filter(r => !sentSet.has(r.email.toLowerCase()) && unsureSet.has(r.email.toLowerCase())).length;
  log('');
  log(`  Đơn đăng ký: ${kept.length} đơn (tháng ${months.join(', ')}), ${uids.length} người cần mời`);
  log(`  Người nhận : ${invitees.length} người — đã nhận trước đó ${received}, sẽ gửi ${pending.length}${batches.length ? ` trong ${batches.length} thư (Bcc)` : ''}`);
  if (unsure) {
    log(args.force
      ? `  --force    : gửi lại cho ${unsure} người KHÔNG RÕ đã nhận thư ở lần trước.`
      : `  Không rõ   : ${unsure} người không rõ đã nhận thư ở lần trước — KHÔNG tự gửi lại (chạy --force để gửi lại cho họ).`);
  }
  for (const n of notes) log(`  Lưu ý: ${n}`);
}

// ------------------------------------------------------------------- chạy

async function main() {
  const startedAt = new Date();
  const weekId = args.week || defaultSurveyWeekId(startedAt);
  const week = surveyWeek(weekId);
  const label = surveyWeekLabel(weekId);

  log('');
  log(`  GỬI LỜI MỜI KHẢO SÁT SUẤT ĂN HẰNG TUẦN   (bản ${SURVEY_AGENT_VERSION})`);
  log('  ' + '─'.repeat(50));
  log(`  Lúc chạy   : ${formatVnDateTime(startedAt.toISOString())} (giờ Việt Nam)`);
  log(`  Tuần       : ${label} (mã ${weekId})${args.week ? '' : ' — tuần mặc định'}`);
  log(`  Hạn trả lời: ${surveyDeadlineLabel(weekId)} (nếu quản trị chưa đổi)`);
  if (DRY_RUN) log('  Chế độ     : CHẠY THỬ, không ghi lên hệ thống, không gửi email');
  if (args.force) log('  --force    : bỏ qua kiểm tra giờ 15:00 thứ 6');
  log('');

  // ---------------------------------------------- 1. cấu hình

  // Chạy thử thì vẫn đi tiếp dù đang tắt hay chưa điền khoá: để xem trước danh
  // sách người nhận khi còn đang chuẩn bị bật.
  if (!SURVEY.enabled) {
    if (!DRY_RUN) {
      log(`  ${SURVEY.disabledReason} — bỏ qua, không gửi gì.`);
      return EXIT_OK;
    }
    log(`  (${SURVEY.disabledReason}: lần chạy thật sẽ bỏ qua. Chạy thử vẫn tính để Thầy/Cô xem.)`);
  }
  if (SURVEY.problems.length) {
    for (const p of SURVEY.problems) log(`  ${DRY_RUN ? 'Lưu ý' : 'LỖI'}: ${p}`);
    if (!DRY_RUN) {
      log('  Sửa config.json (xem mục "Khảo sát bữa ăn hằng tuần" trong README) rồi chạy lại.');
      return EXIT_ERROR;
    }
  }

  // ---------------------------------------------- 2. giờ gửi (chưa cần Firestore)

  // Trước 15:00 thứ 6 không làm gì, kể cả không đọc Firestore (cổng giờ chỉ
  // cần tuần và đồng hồ — decideWeek xét nó đầu tiên). Task Scheduler gọi cả
  // những ngày khác (lần chạy hằng ngày, lúc bật máy) nên đường này phải rẻ.
  // Chạy thử thì đi tiếp để xem kế hoạch.
  const early = decideWeek({ weekId, now: startedAt, force: args.force });
  if (early.action === 'wait') {
    log(`  ${early.message}`);
    if (!DRY_RUN) return EXIT_OK;
    log('  (Chạy thử: vẫn đọc hệ thống để Thầy/Cô xem kế hoạch.)');
  }

  // ---------------------------------------------- 3. chỉ một lần chạy thật trên máy này

  if (!DRY_RUN) {
    const lock = await acquireLock({
      path: join(HERE, 'khao-sat.lock'),
      info: { pid: process.pid, token: randomBytes(8).toString('hex'), startedAt: startedAt.toISOString(), args: process.argv.slice(2).join(' ') },
      deps: {
        tryCreate: (p, text) => {
          try { writeFileSync(p, text, { flag: 'wx' }); return true; } catch (err) {
            if (err?.code === 'EEXIST') return false;
            throw err;
          }
        },
        read: p => {
          try { return { text: readFileSync(p, 'utf8'), mtimeMs: statSync(p).mtimeMs }; } catch (err) {
            if (err?.code === 'ENOENT') return null;
            throw err;
          }
        },
        remove: p => { try { unlinkSync(p); } catch (err) { if (err?.code !== 'ENOENT') throw err; } },
        now: () => Date.now(),
        isAlive: pid => {
          try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
        },
        sleep,
      },
      onWait: holder => log(
        `  Đang có một lần gửi khác${holder ? ` (PID ${holder.pid}, bắt đầu lúc ${formatVnDateTime(holder.startedAt) || '?'})` : ''} — chờ nó xong (tối đa 10 phút)...`
      ),
    });
    if (!lock.ok) {
      throw new FatalError(
        'Vẫn đang có một lần gửi lời mời khác sau 10 phút chờ — bỏ qua lần này để không gửi trùng. ' +
        'Nếu chắc chắn không có lần chạy nào (vd. vừa tắt ngang), xoá file khao-sat.lock cạnh script.'
      );
    }
    releaseLock = lock.release;
  }

  // ---------------------------------------------- 4. kết nối Firestore

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(readFileSync(join(HERE, config.firebaseKeyFile || 'firebase-key.json'), 'utf8'));
  } catch (err) {
    throw new FatalError('Không đọc được file khóa Firebase. ' + err.message);
  }
  let admin;
  try {
    ({ default: admin } = await import('firebase-admin'));
  } catch (err) {
    throw new FatalError('Chưa cài thư viện firebase-admin. Mở Command Prompt tại thư mục agent rồi chạy: npm install\n  Chi tiết: ' + err.message);
  }
  firebaseAdmin = admin;
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const weekRef = db.collection('meal_surveys').doc(weekId);
  const invitedRef = weekRef.collection('private').doc('invited');
  // Quyền gửi lời mời của tuần (xem SEND_LEASE_MS): chỉ agent đọc/ghi.
  const lockRef = weekRef.collection('private').doc('lock');
  const existing = (await weekRef.get()).data() || null;
  const offSnap = await db.collection('settings').doc('mealOffDays').get();
  const offDays = Array.isArray(offSnap.data()?.dates) ? offSnap.data().dates.filter(d => typeof d === 'string') : [];

  // ---------------------------------------------- 5. quyết định (sơ bộ)

  // Đọc lại đồng hồ: có thể vừa chờ khoá tới 10 phút. Quyết định này chỉ để
  // khỏi tra danh sách vô ích; quyết định thật nằm trong giao dịch ở bước 7.
  const decision = decideWeek({ weekId, now: new Date(), force: args.force, existing, offDays });
  if (decision.action !== 'wait') log(`  ${decision.message}`);

  if (decision.action === 'already_sent') return EXIT_OK;

  if (decision.action === 'skip_no_meals') {
    if (DRY_RUN) {
      log(`  Chạy thử: lần chạy thật sẽ ghi trạng thái "skipped" cho tuần này (không mở khảo sát).`);
    } else if (decision.recorded) {
      log('  Đã ghi trạng thái "skipped" từ lần trước — không ghi lại.');
    } else {
      await setWithRetry(weekRef, skippedWeekDoc({ weekId, existing, now: new Date(), reason: decision.reason }), { merge: true });
      log('  Đã ghi trạng thái "skipped" cho tuần này.');
    }
    return EXIT_OK;
  }

  if ((decision.action === 'closed' || decision.action === 'too_late') && !DRY_RUN) return EXIT_OK;

  // ---------------------------------------------- 6. người nhận

  // Đơn của các tháng mà tuần chạm tới (tuần vắt tháng thì cả hai).
  const months = [...new Set([week.weekStart.slice(0, 7), week.weekEnd.slice(0, 7)])];
  const registrations = [];
  for (const month of months) {
    const snap = await db.collection('registrations').where('month', '==', month).get();
    // Đơn hỏng (uid không dùng làm đường dẫn được, id không khớp) bị bỏ ở đây,
    // như sync-checkins — một đơn hỏng không được làm hỏng cả lần gửi.
    const { registrations: clean, rejected } = cleanRegistrations({ docs: snap.docs.map(d => ({ id: d.id, data: d.data() })), month });
    if (rejected.length) {
      log(`  Bỏ qua ${rejected.length} đơn đăng ký tháng ${month} không hợp lệ (quản trị nên kiểm tra và xoá):`);
      for (const r of rejected.slice(0, 10)) log(`      - registrations/${String(r.id).slice(0, 80)}: ${r.why}`);
    }
    registrations.push(...clean);
  }

  // Email lấy từ Firebase Auth (không lấy trên đơn). Tra lỗi thì dừng cả lần
  // chạy (mã 1) — chưa ghi, chưa gửi gì; lần chạy sau thử lại.
  /** @type {Map<string, string>} */
  const emails = new Map();
  /** @type {Set<string>} */
  const known = new Set();
  for (const group of chunk([...new Set(registrations.map(r => r.uid))], 100)) {
    const res = await admin.auth().getUsers(group.map(uid => ({ uid })));
    for (const u of res.users) { known.add(u.uid); emails.set(u.uid, u.email || ''); }
  }
  // Đơn của tài khoản không còn tồn tại: không ai nhận được thư của nó.
  const { kept, ghosts } = dropGhosts(registrations, uid => known.has(uid));
  if (ghosts.length) log(`  Bỏ qua ${ghosts.length} đơn của tài khoản không còn tồn tại.`);

  const exSnap = await db.collection('settings').doc('reconcileExcludes').get();
  const excludedIds = Array.isArray(exSnap.data()?.employeeIds) ? exSnap.data().employeeIds.filter(v => typeof v === 'string') : [];

  // offDays: người mà mọi ngày đơn của họ phủ trong tuần đều là ngày nghỉ (vd.
  // đơn tháng sau bắt đầu đúng thứ 6 nghỉ lễ) thì tuần này chưa ăn bữa nào —
  // không mời, để không nằm trong Bcc lẫn danh sách "chưa trả lời".
  const uids = surveyRecipientUids({ registrations: kept, weekId, excludedIds, offDays });
  const { invitees, skipped } = buildInvitees({ uids, registrations: kept, emails });
  const notes = inviteeNotes(skipped);

  // Không có ai để mời (đầu năm học chưa ai đăng ký, hay mọi tài khoản thiếu
  // email trường): không mở khảo sát, ghi lý do để quản trị thấy.
  const noOne = invitees.length === 0;
  const noOneReason = `Không có CBGV-NV nào để mời: ${uids.length} người có đơn đăng ký ăn tuần này${notes.length ? `; ${notes.join(' ')}` : '.'}`;

  if (DRY_RUN) {
    const invitedDoc = (await invitedRef.get()).data() || {};
    const prevSent = emailList(invitedDoc.sentEmails);
    const prevUncertain = emailList(invitedDoc.uncertainEmails);
    const pending = pendingInvitees(invitees, prevSent, args.force ? [] : prevUncertain);
    const batches = inviteBatches(pending);
    logPlan({ kept, months, uids, invitees, prevSent, prevUncertain, pending, batches, notes });
    if (pending.length) {
      log('');
      log(`  Vài người sẽ nhận (chạy thử, KHÔNG gửi; đã che địa chỉ):`);
      for (const r of pending.slice(0, PREVIEW_COUNT)) log(`    - ${maskEmail(r.email)}${r.department ? ` (${r.department})` : ''}`);
      if (pending.length > PREVIEW_COUNT) log(`    ... và ${pending.length - PREVIEW_COUNT} người khác`);
    }
    log('');
    const verdict = early.action === 'wait' ? 'KHÔNG gửi (chưa tới 15:00 thứ 6)'
      : decision.action === 'closed' ? 'KHÔNG gửi (khảo sát đã đóng)'
      : decision.action === 'too_late' ? 'KHÔNG gửi bù (còn chưa tới 1 giờ là hết hạn trả lời)'
      : noOne ? 'ghi trạng thái "skipped" (không có ai để mời), không mở khảo sát'
      : !SURVEY.enabled || SURVEY.problems.length ? 'KHÔNG gửi (tính năng đang tắt hoặc cấu hình chưa đúng — xem phía trên)'
      : `mở khảo sát và gửi ${pending.length} lời mời, rồi ghi trạng thái "sent" nếu mọi thư đều đi`;
    log(`  Kết luận: lần chạy thật lúc này sẽ ${verdict}.`);
    log('\n  Chạy thử xong: không ghi gì, không gửi email nào.\n');
    return EXIT_OK;
  }

  if (noOne) {
    await setWithRetry(weekRef, skippedWeekDoc({ weekId, existing, now: new Date(), reason: noOneReason }), { merge: true });
    log(`  ${noOneReason} Đã ghi trạng thái "skipped".`);
    return EXIT_OK;
  }

  // ---------------------------------------------- 7. giành quyền gửi + mở khảo sát

  // MỘT giao dịch: đọc lại document tuần, quyền gửi và danh sách đã nhận, quyết
  // định lại bằng chính lần đọc đó, rồi mới ghi. Lần đọc ở bước 4 đã cũ vài giây
  // (tra đơn, tra Auth): quản trị có thể vừa bấm "Đóng ngay" / "Gia hạn", hay
  // một lần chạy khác (máy khác) vừa gửi xong — ghi theo lần đọc cũ là đè mất.
  const token = randomBytes(8).toString('hex');
  let opened;
  try {
    opened = await db.runTransaction(async tx => {
      const [wSnap, lSnap, iSnap] = await tx.getAll(weekRef, lockRef, invitedRef);
      const at = new Date();
      // Hạn quyền gửi tính theo giờ máy chủ: hai máy lệch đồng hồ vẫn so cùng thước.
      const serverMs = readTimeMs(wSnap) ?? at.getTime();
      const cur = wSnap.data() || null;
      const d = decideWeek({ weekId, now: at, force: args.force, existing: cur, offDays });
      if (d.action !== 'send') return { stop: d };
      const lease = lSnap.data() || null;
      if (leaseState({ lease, token, nowMs: serverMs }) === 'busy') return { busy: lease };
      // Chưa có giờ mở: dùng giờ MÁY CHỦ (rules so request.time với opensAt).
      const patch = openWeekPatch({ weekId, existing: cur, now: at, serverTime: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(lockRef, buildLease({ token, host: hostname(), pid: process.pid, nowMs: serverMs, startedAt: at.toISOString() }));
      tx.set(weekRef, patch.data, { merge: true });
      return { decision: d, patch, at, cur, invitedDoc: iSnap.data() || {} };
    });
  } catch (err) {
    throw new FatalError(`Không mở được khảo sát (giao dịch trên meal_surveys/${weekId} lỗi: ${err?.message || err}) — chưa gửi lời mời nào. Lần chạy sau thử lại.`);
  }
  if (opened.stop) {
    log(`  Kiểm tra lại ngay trước khi gửi: ${opened.stop.message}`);
    return EXIT_OK;
  }
  if (opened.busy) {
    const b = opened.busy;
    log(`  Một lần chạy khác${b.host ? ` (máy ${b.host})` : ''} đang gửi lời mời tuần này` +
      `${b.startedAt ? `, bắt đầu lúc ${formatVnDateTime(b.startedAt) || '?'}` : ''} — bỏ qua lần này để không gửi trùng.`);
    return EXIT_OK;
  }

  try {
    return await sendAll({ db, weekId, weekRef, invitedRef, lockRef, token, opened, invitees, kept, months, uids, notes });
  } finally {
    // Trả quyền gửi (chỉ khi còn là của mình). Không trả được thì quyền tự hết
    // sau SEND_LEASE_MS — lần chạy sau vẫn làm tiếp được.
    try {
      await db.runTransaction(async tx => {
        const [lSnap] = await tx.getAll(lockRef);
        const nowMs = readTimeMs(lSnap) ?? Date.now();
        if (leaseState({ lease: lSnap.data() || null, token, nowMs }) !== 'mine') return;
        tx.set(lockRef, { released: true, until: new Date(nowMs), releasedAt: new Date().toISOString() }, { merge: true });
      });
    } catch (err) {
      log(`  Lưu ý: không trả được quyền gửi (${err?.message || err}) — tự hết sau ${SEND_LEASE_MS / 60_000} phút.`);
    }
  }
}

/** Bước 7 (sau khi đã mở khảo sát và giữ quyền gửi) -> 8: gửi, ghi trạng thái. */
async function sendAll({ db, weekId, weekRef, invitedRef, lockRef, token, opened, invitees, kept, months, uids, notes }) {
  const { patch, decision, cur, invitedDoc } = opened;
  log('');
  log(`  Đã mở khảo sát: từ ${patch.opensMs === null ? `lúc này (${formatVnDateTime(opened.at.toISOString())})` : `${vnTime(patch.opensMs)} (giữ giờ đã đặt)`}` +
    ` tới ${vnTime(patch.closesMs)}${patch.keptCloses ? ' (giữ hạn đã đặt)' : ''}.`);

  // Danh sách đã nhận đọc TRONG giao dịch giữ quyền gửi: lần chạy trước (kể cả
  // ở máy khác) đã gửi ai thì chắc chắn thấy ở đây.
  const prevSent = emailList(invitedDoc.sentEmails);
  const prevUncertain = emailList(invitedDoc.uncertainEmails);
  const pending = pendingInvitees(invitees, prevSent, args.force ? [] : prevUncertain);
  const batches = inviteBatches(pending);
  logPlan({ kept, months, uids, invitees, prevSent, prevUncertain, pending, batches, notes });

  const at = () => new Date().toISOString();
  const prevEmail = cur?.email && typeof cur.email === 'object' ? cur.email : {};

  // Danh sách người được mời cho tab quản trị (ai chưa trả lời) — ghi trước khi
  // gửi để có ngay cả khi lần chạy hỏng giữa chừng. Người lần trước đã (hoặc có
  // thể đã) nhận thư vẫn giữ trong danh sách.
  const recipients = mergeInvitedRecipients({ previous: invitedDoc.recipients, current: invitees, sentEmails: [...prevSent, ...prevUncertain] });
  await setWithRetry(invitedRef, { recipients, sentEmails: prevSent, updatedAt: at() }, { merge: true });

  // ---------------------------------------------- 8. gửi

  // Hạn trả lời mới nhất (ms), đọc lại ngay trước mỗi thư và gửi kèm cho
  // endpoint để thư ghi ĐÚNG hạn thật — quản trị có thể đã gia hạn (gửi bù sau
  // 12:00 thứ 2) hay đóng sớm; endpoint chỉ biết mã tuần thì ghi 12h00 thứ 2.
  let closesMs = patch.closesMs;

  const result = await sendInvitations({
    batches,
    sentEmails: prevSent,
    uncertainEmails: prevUncertain,
    // Ngay trước mỗi thư: còn giữ quyền gửi? khảo sát còn mở theo hạn MỚI NHẤT?
    // Gia hạn quyền gửi trong cùng giao dịch.
    beforeBatch: () => db.runTransaction(async tx => {
      const [wSnap, lSnap] = await tx.getAll(weekRef, lockRef);
      const now = new Date();
      const week = wSnap.data() || null;
      const stop = batchGate({ week, lease: lSnap.data() || null, token, now });
      if (!stop) {
        // batchGate vừa kiểm: closesAt có và còn ở tương lai.
        closesMs = toMillis(week?.closesAt) ?? closesMs;
        tx.set(lockRef, { until: new Date((readTimeMs(lSnap) ?? now.getTime()) + SEND_LEASE_MS) }, { merge: true });
      }
      return stop;
    }),
    post: async batch => {
      let outcome;
      try {
        outcome = inviteOutcome({ response: await postAlerts(SURVEY.cfg, inviteRequest({ weekId, closesMs, emails: batch.map(r => r.email) })) });
      } catch (err) {
        outcome = inviteOutcome({ error: err });
      }
      if (outcome.error) outcome.error = redact(outcome.error, SECRET);
      if (outcome.delivery !== 'not_sent') touchedThisRun += batch.length;
      return outcome;
    },
    // Ghi ngay sau mỗi thư (vòng gửi tự DỪNG nếu ghi lỗi).
    journal: async ({ sentEmails, uncertainEmails, at: when }) => {
      /** @type {Record<string, unknown>} */
      const data = { sentEmails, updatedAt: when };
      if (uncertainEmails.length || prevUncertain.length) data.uncertainEmails = uncertainEmails;
      await setWithRetry(invitedRef, data, { merge: true });
    },
    log,
  });

  // ---------------------------------------------- 9. trạng thái

  const uncertain = result.uncertainEmails.length;
  const status = finalSurveyStatus({ sentTotal: result.sentEmails.length, failed: result.failed, uncertain });
  // endedAt: lần chạy theo lịch kế tiếp tính từ lúc lần này KẾT THÚC — task đặt
  // "Do not start a new instance", giờ lặp rơi vào lúc lần này còn chạy bị bỏ.
  const reasons = runReasons({
    weekId, catchUp: decision.catchUp, ranAt: opened.at.toISOString(), endedAt: at(), closesMs, failed: result.failed,
    errors: result.errors, stopReason: result.stopReason, stopRetryable: result.stopRetryable, journalError: result.journalError,
    uncertain, unknownErrors: result.unknownErrors, notes,
  });
  const email = buildEmailStatus({
    status,
    at: at(),
    // Lúc thư cuối cùng đi. Lần này không gửi thêm ai (lần trước đã gửi hết
    // nhưng chưa kịp ghi trạng thái) thì giữ mốc cũ.
    sentAt: result.lastSentAt ?? prevEmail.sentAt ?? (prevSent.length ? invitedDoc.updatedAt ?? null : null),
    recipients: recipients.length,
    sent: result.sentEmails.length,
    failed: result.failed,
    reason: reasons.join(' ') || null,
    secret: SECRET,
  });
  try {
    // Chỉ ghi khối `email` (merge): không đụng opensAt/closesAt quản trị có thể
    // vừa đổi trong lúc gửi.
    await setWithRetry(weekRef, { email }, { merge: true });
  } catch (err) {
    const why = scrubEmails(redact(String(err?.message || err), SECRET));
    if (touchedThisRun > 0) {
      // Danh sách đã nhận (private/invited) đã ghi sau từng thư nên lần sau
      // không gửi trùng; chỉ thiếu dòng trạng thái cho tab quản trị.
      console.error(`\n  LỖI: ĐÃ GỬI ${result.sentNow} lời mời${result.uncertainNow ? ` (và ${result.uncertainNow} không rõ đã đi chưa)` : ''} nhưng không ghi được trạng thái email vào meal_surveys/${weekId}: ${why}.` +
        `\n  Tab Khảo sát bữa ăn sẽ hiện trạng thái cũ. Lần chạy sau tự ghi lại, không gửi trùng.\n`);
      return EXIT_SENT_BUT_UNRECORDED;
    }
    throw new FatalError(`Không ghi được trạng thái email vào meal_surveys/${weekId}: ${why}. Lần này chưa gửi thêm lời mời nào; lần chạy sau ghi lại.`);
  }

  log('');
  log(`  Đã gửi ${result.sentNow} lời mời` +
    `${result.failed ? `, ${result.failed} người chưa gửi được${result.errors.length ? `: ${result.errors.join('; ')}` : ''}` : ''}` +
    `${uncertain ? `, ${uncertain} người KHÔNG RÕ đã nhận chưa (không tự gửi lại)` : ''}` +
    `. Tổng đã nhận: ${result.sentEmails.length}/${recipients.length}. Trạng thái: ${status}.`);
  if (result.stopReason) log(`  Dừng: ${result.stopReason}`);
  log(`\n  XONG. Mở trang Quản trị → tab Khảo sát bữa ăn để xem kết quả.\n`);
  return status === 'sent' ? EXIT_OK : EXIT_SEND_FAILED;
}

// --------------------------------------------------------------------------

// Lưới cuối cho khoá "đang chạy": tiến trình thoát kiểu gì (kể cả bị ép thoát
// bên dưới) cũng xoá khoá của mình.
process.on('exit', () => releaseLock());

let exitCode = EXIT_ERROR;
try {
  exitCode = await main();
} catch (err) {
  const text = err instanceof FatalError ? err.message : (err?.stack || String(err));
  console.error(`\n  LỖI: ${scrubEmails(redact(text, SECRET))}\n`);
  if (touchedThisRun > 0) {
    console.error(`  Lưu ý: lần này ĐÃ gửi (hoặc có thể đã gửi) lời mời tới ${touchedThisRun} người trước khi lỗi — danh sách đã nhận đã ghi sau từng thư, lần sau không gửi trùng.\n`);
    exitCode = EXIT_SENT_BUT_UNRECORDED;
  } else {
    exitCode = EXIT_ERROR;
  }
}
releaseLock();

// Mã thoát cho Task Scheduler (README "Last Run Result"):
//   0 = ổn (hoặc không có gì phải làm);
//   1 = lỗi cấu hình / lỗi chung — CHƯA gửi lời mời nào lần này;
//   2 = có thư gửi lỗi hoặc không rõ đã đi ('partial'/'error');
//   3 = ĐÃ gửi lời mời nhưng sau đó lỗi (vd. không ghi được trạng thái).
//
// KHÔNG gọi process.exit() ngay: trên Windows (đã thấy với Node 24), gọi
// process.exit() khi fetch vừa đóng kết nối thì tiến trình đổ vỡ (mã
// 0xC0000409) và mất mã thoát thật. Đặt exitCode, đóng firebase-admin, rồi để
// tiến trình tự kết thúc; hẹn giờ thoát cưỡng bức đặt TRƯỚC bước đóng (bước dễ
// treo nhất) — xem sync-checkins.mjs.
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 20_000).unref();
try {
  await Promise.all((firebaseAdmin?.apps || []).map(app => app?.delete()));
} catch { /* đang thoát; lỗi khi đóng kết nối không còn quan trọng */ }
