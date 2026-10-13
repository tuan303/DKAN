import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as xlsx from 'xlsx';
import {
  Timestamp,
  collection,
  doc,
  documentId,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
// Câu hỏi, mã đáp án, màu theo tone, cách tính tuần và hạn trả lời dùng chung
// với trang khảo sát của CBNV và agent gửi email mời. Không chép lại ở đây:
// lệch một chỗ là biểu đồ đếm sai đáp án hoặc nút "Mở khảo sát" đặt sai hạn.
import {
  SURVEY_QUESTIONS,
  SURVEY_TITLE,
  SURVEY_VERSION,
  isSurveyOpen,
  isWeekId,
  shiftDate,
  surveyClosesAt,
  surveyDefaultOpensAt,
  surveyWeek,
  surveyWeekLabel,
  toMillis,
  weekStartOf,
} from '../../agent/lib/survey.mjs';
import type { ChoiceQuestion, TextQuestion, Tone } from '../../agent/lib/survey.mjs';
// Cách agent trên máy HAC chọn tuần và quyết định gửi / không gửi. Tab này phải
// nói ĐÚNG lúc nào máy HAC tự gửi nốt, lúc nào phải chạy tay — tự viết lại quy
// tắc ở đây thì agent đổi một chỗ là giao diện hứa hẹn sai (file thuần, không
// import Node hay Firebase).
import { MIN_CATCH_UP_MS, decideWeek, defaultSurveyWeekId } from '../../agent/lib/survey-plan.mjs';
// Giờ Việt Nam: cùng hàm với các tab khác, không tự đổi múi giờ ở đây.
import { formatDayLabel, formatVnDateTime, vnParts, vnToday } from '../../agent/lib/meal-rules.mjs';

/**
 * Tab "Khảo sát bữa ăn" của trang quản trị: kết quả khảo sát chất lượng phục
 * vụ suất ăn CBGV-NV hằng tuần, cùng các nút mở / gia hạn / đóng khảo sát.
 *
 * Tách hai phần:
 *  - SurveyResults: đọc/ghi Firestore. Admin.tsx chỉ dựng component này khi
 *    tab đang mở, nên các tab khác không tốn thêm lượt đọc nào.
 *  - SurveyResultsView: chỉ hiển thị theo props, không gọi Firestore — để xem
 *    thử giao diện bằng dữ liệu mẫu được.
 */

// ------------------------------------------------------------------ dữ liệu

/** meal_surveys/{weekId}.email — do agent trên máy HAC ghi, mọi trường tuỳ chọn. */
export interface SurveyEmailInfo {
  status?: string;
  at?: string;
  sentAt?: string | null;
  recipients?: number;
  sent?: number;
  failed?: number;
  reason?: string | null;
}

/** meal_surveys/{weekId}. opensAt/closesAt là Timestamp (hoặc ISO/Date ở dữ liệu mẫu). */
export interface SurveyWeekDoc {
  id: string;
  weekId?: string;
  weekStart?: string;
  weekEnd?: string;
  version?: number;
  opensAt?: unknown;
  closesAt?: unknown;
  openedBy?: string;
  createdAt?: string;
  email?: SurveyEmailInfo | null;
}

/** meal_surveys/{weekId}/responses/{uid} */
export interface SurveyResponseDoc {
  id: string;
  uid?: string;
  weekId?: string;
  version?: number;
  answers?: Record<string, unknown>;
  fullName?: string;
  employeeId?: string;
  department?: string;
  email?: string;
  submittedAt?: string;
  updatedAt?: string;
}

/**
 * Thư mời đã tới một người chưa, theo private/invited:
 *  - 'received'  — địa chỉ có trong sentEmails (endpoint báo đã gửi);
 *  - 'uncertain' — có trong uncertainEmails: lần gửi lỗi giữa chừng (hết 90
 *    giây chờ, Vercel trả 502/504...), máy HAC không biết thư đã đi hay chưa.
 *    Agent KHÔNG BAO GIỜ tự gửi lại cho họ (gửi lại mà thư đã đi thì cả trường
 *    nhận hai thư) — chỉ gửi lại khi người vận hành chạy --force;
 *  - 'failed'    — không có ở cả hai: chắc chắn chưa gửi được (lỗi rõ ràng)
 *    hoặc chưa tới lượt (agent ghi danh sách TRƯỚC khi gửi). Agent tự gửi nốt
 *    cho những người này, nhưng chỉ trong các lần chạy theo lịch còn hiệu lực.
 */
export type InviteReceipt = 'received' | 'uncertain' | 'failed';

/** Một dòng trong meal_surveys/{weekId}/private/invited.recipients */
export interface SurveyInvitee {
  uid: string;
  fullName?: string;
  department?: string;
  email?: string;
  receipt: InviteReceipt;
}

export type SurveyDetail =
  | { status: 'idle' }
  | { status: 'loading'; weekId: string }
  | { status: 'error'; weekId: string; message: string }
  | {
      status: 'ready';
      weekId: string;
      responses: SurveyResponseDoc[];
      /** null = chưa có danh sách mời (mở tay, máy HAC chưa gửi email). */
      invited: SurveyInvitee[] | null;
      /**
       * Danh sách mời có sentEmails (mảng) để biết ai đã nhận thư. false = dữ
       * liệu lạ: mọi người được coi là đã nhận, và thẻ "Email mời" dùng số đếm
       * trong document tuần thay cho danh sách này.
       */
      receiptKnown?: boolean;
      /** Đọc danh sách mời bị lỗi (khác với "chưa có"). */
      invitedError: boolean;
      loadedAt: Date;
    };

export interface SurveyTrendRow {
  weekId: string;
  responses: number;
  /** khoá chỉ số (TREND_METRICS[].key) -> số phiếu chọn đáp án đó */
  counts: Record<string, number>;
}

export interface SurveyTrend {
  status: 'loading' | 'ready' | 'error';
  rows: SurveyTrendRow[];
  message?: string;
}

export type SurveyBusy = null | 'open' | 'extend' | 'close';

// ----------------------------------------------------------------- hằng số

// Danh sách tuần trong ô chọn: ~40 tuần là trọn một năm học. Collection này mỗi
// tuần thêm một doc nhỏ, giới hạn để vài năm sau mở tab vẫn chỉ tốn vài chục
// lượt đọc.
const WEEK_LIST_LIMIT = 40;

// Bảng xu hướng: 8 tuần gần nhất đã mở.
const TREND_WEEKS = 8;

// Ba cột của bảng xu hướng theo yêu cầu Nhóm Dinh dưỡng: % "Ngon", % "Đủ độ
// nóng", % "Sạch". Chỉ giữ mã câu + mã đáp án; nhãn lấy từ SURVEY_QUESTIONS để
// đổi chữ ở survey.mjs là bảng đổi theo. Đáp án nào không còn trong bộ câu hỏi
// thì cột đó tự biến mất, không đếm một mã không tồn tại.
const TREND_METRICS = ([
  ['taste', 'ngon'],
  ['warmth', 'du_nong'],
  ['hygiene', 'sach'],
] as const).flatMap(([questionId, value]) => {
  const q = SURVEY_QUESTIONS.find(x => x.id === questionId);
  const opt = q && q.kind === 'choice' ? q.options.find(o => o.value === value) : undefined;
  return opt ? [{ key: `${questionId}:${value}`, questionId, value, label: opt.label }] : [];
});

// Danh sách ý kiến dài tới vài trăm dòng (câu "món yêu thích" là bắt buộc):
// hiện từng đợt để trang không dựng cả trăm thẻ một lúc.
const TEXT_PAGE_SIZE = 30;

// Gia hạn tối đa 31 ngày kể từ bây giờ. Ô ngày giờ cho gõ tay năm, lỡ gõ nhầm
// năm 2062 là khảo sát tuần đó mở mãi, CBNV còn thấy nhắc khảo sát cũ.
const MAX_EXTEND_DAYS = 31;

// Lịch của task "DKAN 4 - Khao sat 15h thu 6" trên máy HAC (agent/README.md):
// ① thứ 6 15:00, lặp 15 phút một lần trong 1 giờ (15:00 → 16:00); ② hằng ngày
// 07:30, lặp mỗi giờ trong 5 giờ (07:30 → 12:30); ③ lúc bật máy. Lần chạy nào
// THẬT SỰ gửi cho một tuần thì tính bằng chính hàm của agent (autoSendRuns):
// agent không chạy "tới hạn trả lời" — từ 12:00 thứ 2 nó chỉ lo tuần mới (kể
// cả khi tuần cũ đã gia hạn), và không gửi bù khi còn chưa tới 1 giờ là hết hạn.
const SCHEDULE_WINDOW_MS = 60 * 60_000;
const FRIDAY_RUN_TIMES = ['15:00', '15:15', '15:30', '15:45', '16:00'];
const DAILY_RUN_TIMES = ['07:30', '08:30', '09:30', '10:30', '11:30', '12:30'];
// Lần chạy tự động kế tiếp còn trong khoảng này thì khỏi đưa lệnh chạy tay
// (lặp 15 phút một lần chiều thứ 6).
const SOON_MS = 20 * 60_000;

const CHOICE_QUESTIONS = SURVEY_QUESTIONS.filter((q): q is ChoiceQuestion => q.kind === 'choice');
const TEXT_QUESTIONS = SURVEY_QUESTIONS.filter((q): q is TextQuestion => q.kind === 'text');

// Màu theo tone đáp án: tốt = xanh lá, trung tính = xám, lưu ý = vàng, chưa
// tốt = đỏ. Màu chỉ để nhìn nhanh; số và % luôn ghi bằng chữ bên cạnh.
const TONE_BAR: Record<Tone, string> = {
  good: 'bg-tertiary',
  neutral: 'bg-outline',
  warn: 'bg-warning',
  bad: 'bg-error',
};

const TONE_CLASS = {
  ok: 'bg-tertiary-container text-on-tertiary-container',
  warn: 'bg-warning-container text-on-warning-container',
  error: 'bg-error-container text-on-error-container',
  neutral: 'bg-surface-container text-on-surface-variant',
} as const;

type Phase = 'open' | 'scheduled' | 'closed' | 'none';

const PHASE_UI: Record<Phase, { label: string; icon: string; cls: string }> = {
  open: { label: 'Đang mở', icon: 'radio_button_checked', cls: TONE_CLASS.ok },
  scheduled: { label: 'Chưa mở', icon: 'schedule', cls: TONE_CLASS.warn },
  closed: { label: 'Đã đóng', icon: 'lock', cls: TONE_CLASS.neutral },
  none: { label: 'Không mở khảo sát', icon: 'block', cls: TONE_CLASS.neutral },
};

// ---------------------------------------------------------------- tiện ích

const PCT0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const PCT1 = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Tỉ lệ để hiển thị. Làm tròn số nguyên là đủ, TRỪ hai đầu: 1/249 phiếu "Chưa
 * ngon" mà ghi "0%" thì Bếp tưởng không ai chê, 249/250 người trả lời mà ghi
 * "100%" ngay cạnh "Chưa trả lời: 1" thì tự mâu thuẫn. Dưới 1% và trên 99% ghi
 * một chữ số thập phân; số khác 0 không bao giờ thành 0%, chưa đủ thì không
 * bao giờ thành 100%.
 */
function pctText(v: number): string {
  if (!(v > 0)) return '0%';
  if (v >= 100) return '100%';
  if (v >= 1 && v <= 99) return `${PCT0.format(v)}%`;
  const r = Math.round(v * 10) / 10;
  if (r <= 0) return `<${PCT1.format(0.1)}%`;
  if (r >= 100) return `>${PCT1.format(99.9)}%`;
  return `${PCT1.format(r)}%`;
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const VI = new Intl.Collator('vi');

/** "15:00 · Thứ 6, 09/10/2026" theo giờ Việt Nam, hoặc '' nếu không có. */
function fmtVn(v: unknown): string {
  // toMillis của survey.mjs không nhận số mili giây trần; ở đây có chỗ truyền số.
  const ms = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : toMillis(v);
  const p = ms === null ? null : vnParts(new Date(ms));
  return p ? `${p.time} · ${formatDayLabel(p.date)}/${p.date.slice(0, 4)}` : '';
}

/** Giá trị cho ô datetime-local, hiểu là giờ Việt Nam dù máy đặt múi giờ nào. */
function toVnInput(ms: number): string {
  const p = vnParts(new Date(ms));
  return p ? `${p.date}T${p.time}` : '';
}

function parseVnInput(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(`${v}:00+07:00`);
  return isNaN(d.getTime()) ? null : d;
}

/** "2 ngày 3 giờ", "3 giờ 15 phút", "12 phút" */
function spanLabel(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d} ngày${h ? ` ${h} giờ` : ''}`;
  if (h > 0) return `${h} giờ${m ? ` ${m} phút` : ''}`;
  return `${m} phút`;
}

/** Tìm không phân biệt dấu: gõ "ca kho" vẫn ra "cá kho". */
const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const countOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const deptOf = (d: unknown) => str(d).trim() || 'Chưa khai bộ phận';
const uidOf = (r: SurveyResponseDoc) => r.uid || r.id;
const answeredAt = (r: SurveyResponseDoc) => toMillis(r.updatedAt) ?? toMillis(r.submittedAt);

function phaseOf(week: SurveyWeekDoc, now: Date): Phase {
  const open = toMillis(week.opensAt);
  const close = toMillis(week.closesAt);
  if (open === null || close === null) return 'none';
  if (isSurveyOpen(week, now)) return 'open';
  // Đóng tay trước giờ mở dự kiến thì closesAt <= opensAt: coi là đã đóng,
  // đừng hiện "chưa mở" như thể lát nữa sẽ tự mở.
  if (close <= open) return 'closed';
  return now.getTime() < open ? 'scheduled' : 'closed';
}

/** Mã đáp án -> nhãn, cho file Excel. Mã lạ (bộ câu hỏi cũ) thì giữ nguyên mã. */
function answerLabel(q: ChoiceQuestion | TextQuestion, v: unknown): string {
  if (q.kind === 'choice') return q.options.find(o => o.value === v)?.label ?? str(v);
  return str(v);
}

interface OptionStat {
  value: string;
  label: string;
  tone: Tone;
  count: number;
  pct: number;
}

interface ChoiceStat {
  question: ChoiceQuestion;
  answered: number;
  options: OptionStat[];
}

function summarizeChoices(responses: SurveyResponseDoc[]): ChoiceStat[] {
  return CHOICE_QUESTIONS.map(question => {
    const counts = new Map(question.options.map(o => [o.value, 0]));
    let answered = 0;
    for (const r of responses) {
      const v = r.answers?.[question.id];
      if (typeof v === 'string' && counts.has(v)) {
        counts.set(v, (counts.get(v) || 0) + 1);
        answered++;
      }
    }
    const options = question.options.map(o => {
      const count = counts.get(o.value) || 0;
      return { value: o.value, label: o.label, tone: o.tone, count, pct: answered ? (count / answered) * 100 : 0 };
    });
    return { question, answered, options };
  });
}

const emailKeySet = (v: unknown) =>
  new Set((Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string').map(s => s.trim().toLowerCase()));

/**
 * Danh sách mời agent ghi. Bỏ dòng hỏng (thiếu uid) thay vì làm vỡ giao diện.
 *
 * Agent ghi `recipients` (mọi người SẼ mời) trước khi gửi, rồi sau mỗi thư thêm
 * địa chỉ vào `sentEmails` (đã gửi) hoặc `uncertainEmails` (không rõ đã đi
 * chưa). Ai không có ở cả hai thì chưa hề nhận thư (gửi lỗi / chưa tới lượt).
 * Gộp "không rõ" vào "gửi lỗi" là nói sai với quản trị: họ có thể đã nhận, và
 * máy HAC không tự gửi lại cho họ như với người gửi lỗi.
 *
 * Không có sentEmails (dữ liệu lạ) thì không coi ai là gửi lỗi, thà thiếu cảnh
 * báo còn hơn báo động nhầm cả trường.
 */
function cleanInvitees(v: unknown, sentEmails?: unknown, uncertainEmails?: unknown): SurveyInvitee[] {
  if (!Array.isArray(v)) return [];
  const sent = Array.isArray(sentEmails) ? emailKeySet(sentEmails) : null;
  const unsure = emailKeySet(uncertainEmails);
  const seen = new Set<string>();
  const out: SurveyInvitee[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const uid = str(o.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const email = str(o.email);
    const key = email.trim().toLowerCase();
    // Có trong sentEmails thì đã nhận, kể cả lỡ còn sót trong uncertainEmails
    // (agent bỏ khỏi danh sách "không rõ" khi gửi lại được).
    const receipt: InviteReceipt =
      sent?.has(key) ? 'received' : unsure.has(key) ? 'uncertain' : sent ? 'failed' : 'received';
    out.push({ uid, fullName: str(o.fullName), department: str(o.department), email, receipt });
  }
  return out;
}

/** Số người theo tình trạng thư mời. */
export interface DeliveryCounts {
  /** Số người trong danh sách mời. */
  total: number;
  received: number;
  uncertain: number;
  /** Chắc chắn chưa nhận: gửi lỗi hoặc chưa tới lượt. */
  failed: number;
}

function deliveryCounts(invited: SurveyInvitee[]): DeliveryCounts {
  const n = (r: InviteReceipt) => invited.filter(i => i.receipt === r).length;
  return { total: invited.length, received: n('received'), uncertain: n('uncertain'), failed: n('failed') };
}

interface ResponseRateInfo {
  /** Số người trong danh sách mời (kể cả người thư chưa tới được). */
  invitedCount: number | null;
  /** Chia theo tình trạng thư mời (0 hết khi chưa có danh sách). */
  receivedCount: number;
  uncertainCount: number;
  /** Trong danh sách mời, số người thư CHẮC CHẮN chưa tới (gửi lỗi / chưa tới lượt). */
  failedCount: number;
  /**
   * Mẫu số của tỉ lệ trả lời: người đã nhận + người KHÔNG RÕ đã nhận. Bỏ người
   * "không rõ" ra thì một lần gửi cả trường bị hết giờ chờ cho tỉ lệ "—" dù
   * hàng trăm người đã trả lời; tính họ vào thì tỉ lệ chỉ có thể thấp hơn thật.
   */
  deliveredCount: number | null;
  deliveredAnswered: number;
  /** Người "không rõ đã nhận" mà đã trả lời — dấu hiệu thư đã tới. */
  uncertainAnswered: number;
  /** Trả lời mà không có trong danh sách mời: mở tay, đăng ký ăn sau giờ gửi email... */
  outside: number;
  /** Người trong danh sách mời chưa trả lời (kèm tình trạng thư mời của từng người). */
  pending: SurveyInvitee[] | null;
  /** Tỉ lệ trả lời trên deliveredCount: hỏi người chắc chắn chưa nhận được thư là vô lý. */
  rate: number | null;
}

function responseRate(responses: SurveyResponseDoc[], invited: SurveyInvitee[] | null): ResponseRateInfo {
  const responded = new Set(responses.map(uidOf));
  if (!invited) {
    return {
      invitedCount: null, receivedCount: 0, uncertainCount: 0, failedCount: 0, deliveredCount: null,
      deliveredAnswered: 0, uncertainAnswered: 0, outside: 0, pending: null, rate: null,
    };
  }
  const invitedUids = new Set(invited.map(i => i.uid));
  const counts = deliveryCounts(invited);
  const delivered = invited.filter(i => i.receipt !== 'failed');
  const deliveredAnswered = delivered.filter(i => responded.has(i.uid)).length;
  const uncertainAnswered = invited.filter(i => i.receipt === 'uncertain' && responded.has(i.uid)).length;
  const outside = [...responded].filter(u => !invitedUids.has(u)).length;
  const pending = invited
    .filter(i => !responded.has(i.uid))
    .sort((a, b) => VI.compare(deptOf(a.department), deptOf(b.department)) || VI.compare(str(a.fullName), str(b.fullName)));
  return {
    invitedCount: invited.length,
    receivedCount: counts.received,
    uncertainCount: counts.uncertain,
    failedCount: counts.failed,
    deliveredCount: delivered.length,
    deliveredAnswered,
    uncertainAnswered,
    outside,
    pending,
    rate: delivered.length ? (deliveredAnswered / delivered.length) * 100 : null,
  };
}

/** Nhãn tình trạng thư mời, dùng chung cho danh sách và file Excel. */
const RECEIPT_LABEL: Record<InviteReceipt, string> = {
  received: 'Đã nhận',
  uncertain: 'Không rõ đã nhận',
  failed: 'Chưa nhận (gửi lỗi)',
};

function groupByDepartment(people: SurveyInvitee[]): [string, SurveyInvitee[]][] {
  const groups = new Map<string, SurveyInvitee[]>();
  for (const p of people) {
    const key = deptOf(p.department);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  return [...groups.entries()].sort(([a], [b]) => VI.compare(a, b));
}

/** Giờ gửi theo lịch (15:00 thứ 6) và lần chạy lặp cuối cùng (16:00) của tuần. */
function inviteSchedule(weekId: string) {
  const sendAt = Date.parse(surveyDefaultOpensAt(weekId));
  return { sendAt, lastRunAt: sendAt + SCHEDULE_WINDOW_MS };
}

/**
 * Lệnh gửi bù bằng tay trên máy HAC (agent/README.md, mục "Gửi bù"). Luôn kèm
 * --week: sang tuần mới (hoặc sau 12:00 thứ 2) thì lệnh không --week chọn tuần
 * khác. Chạy lại an toàn — agent bỏ người đã nhận VÀ người "không rõ đã nhận".
 */
const manualSendCommand = (weekId: string) => `khao-sat-bua-an.bat --week ${weekId}`;

/**
 * Thêm --force: gửi lại cả cho người "không rõ đã nhận" (đồng thời bỏ qua giờ
 * 15:00 thứ 6 và quy tắc "còn chưa tới 1 giờ"). Ai thật ra đã nhận thì nhận
 * thêm một thư — chỉ đưa ra kèm cảnh báo đó, không bao giờ là lệnh mặc định.
 */
const forceSendCommand = (weekId: string) => `khao-sat-bua-an.bat --force --week ${weekId}`;

/**
 * email.reason do máy HAC ghi, để hiện nguyên văn kèm một dấu chấm cuối. Bỏ mọi
 * đoạn agent nói về VIỆC TIẾP THEO, vì nó viết LÚC CHẠY, theo hạn trả lời LÚC
 * ĐÓ, mà thẻ thì xem về sau — quản trị có thể đã gia hạn hay rút ngắn hạn, và
 * giờ đã trôi qua:
 *   - "Lần chạy sau sẽ gửi nốt (tự động tới trước HH:MM …; sau đó phải chạy tay
 *     --week W)." — sau khi gia hạn qua 12:00 thứ 2 thì sai mốc; rút hạn về tối
 *     thứ 6 thì hứa một lần tự gửi không bao giờ xảy ra;
 *   - "Không còn lần chạy tự động nào gửi nốt: chạy tay node survey-invite.mjs
 *     --week W (… thêm --force)." — lệnh khác lệnh thẻ đưa (khao-sat-bua-an.bat),
 *     thành hai lời dặn cạnh tranh nhau;
 *   - ", lần chạy sau gửi tiếp" (vòng gửi dừng vì không đọc được Firestore) —
 *     cũng là lời hứa không nói khi nào;
 *   - lời dặn chạy --force cho người "không rõ đã nhận" (thẻ tự đưa lệnh kèm
 *     cảnh báo nhận trùng).
 * Việc tiếp theo do resendSteps nói theo giờ HIỆN TẠI và hạn đang lưu. Agent đổi
 * câu chữ thì câu đó chỉ hiện lại (trùng ý), không làm mất phần lỗi.
 */
function agentNote(reason: unknown): string {
  const s = str(reason)
    .replace(/\s*Lần chạy sau sẽ gửi nốt(?:\s*\([^)]*\))?\.?/g, '')
    // Câu có "survey-invite.mjs" (dấu chấm giữa chữ) nên chỉ dừng ở dấu chấm
    // CUỐI câu (theo sau là khoảng trắng hay hết chuỗi).
    .replace(/\s*Không còn lần chạy tự động nào gửi nốt:[^()]*?(?:\([^)]*\))?\.(?=\s|$)/g, '')
    .replace(/,\s*lần chạy sau gửi tiếp(?=\.)/g, '')
    .replace(/:\s*không tự gửi lại để tránh[\s\S]*?trên máy HAC\./g, '.')
    .trim()
    .replace(/[.\s]+$/, '');
  if (!s) return '';
  return /[!?…]$/.test(s) ? s : `${s}.`;
}

/** Một việc trong mục "Email mời": lời giải thích, có thể kèm lệnh để chép. */
interface EmailStep {
  text: string;
  /** Lệnh chạy tay trên máy HAC, hiện dạng mã để chép. */
  command?: string;
}

interface EmailView {
  tone: keyof typeof TONE_CLASS;
  /** Dòng chính: đã gửi bao nhiêu, lúc nào. */
  text: string;
  /** Ghi chú của máy HAC (email.reason đã làm sạch). */
  note?: string;
  /** Lưu ý rút từ ghi chú (vd. có người không gửi được vì thiếu email trường). */
  notice?: string;
  /** Việc sẽ xảy ra tiếp theo, hoặc việc quản trị cần làm. */
  steps?: EmailStep[];
}

/**
 * Các lần chạy theo lịch (ms) có thể còn xử lý tuần `weekId`: từ thứ 6 tuần đó
 * tới thứ 2 tuần sau. Sau 12:00 thứ 2 lần chạy theo lịch (không có --week) đã
 * chọn tuần mới, nên không cần xét xa hơn.
 */
function scheduledRuns(weekId: string): number[] {
  const out: number[] = [];
  for (let d = 4; d <= 7; d++) {
    const date = shiftDate(weekId, d);
    for (const hhmm of d === 4 ? [...DAILY_RUN_TIMES, ...FRIDAY_RUN_TIMES] : DAILY_RUN_TIMES) {
      out.push(Date.parse(`${date}T${hhmm}:00+07:00`));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Các lần chạy theo lịch, SAU `now`, mà agent thật sự gửi lời mời cho tuần này.
 * Chạy đúng hai hàm của agent: chọn tuần mặc định (task không truyền --week) và
 * quyết định gửi (giờ 15:00 thứ 6, hạn trả lời đang lưu, không gửi bù khi còn
 * chưa tới 1 giờ). Rỗng = không còn lần tự động nào — phải chạy tay.
 */
function autoSendRuns(week: SurveyWeekDoc, now: Date): number[] {
  return scheduledRuns(week.id).filter(ms => {
    if (ms <= now.getTime()) return false;
    const at = new Date(ms);
    return defaultSurveyWeekId(at) === week.id && decideWeek({ weekId: week.id, now: at, existing: week }).action === 'send';
  });
}

/** Máy HAC còn tự gửi cho tuần này không, và chạy tay NGAY BÂY GIỜ (không --force) thì sao. */
interface SendOutlook {
  /** Lần chạy theo lịch còn gửi được (ms, tăng dần). */
  runs: number[];
  /** Kết quả nếu chạy tay `khao-sat-bua-an.bat --week <tuần>` lúc này (decideWeek). */
  manual: string;
  /**
   * Lệnh chạy tay (không --force) còn gửi được tới TRƯỚC lúc này (ms) — chỉ có
   * khi chạy ngay bây giờ thì gửi (manual === 'send'); xem manualSendUntil.
   */
  manualUntil: number | null;
  closeMs: number;
  /** Vì sao không còn lần chạy tự động nào (chỉ có khi runs rỗng). */
  why: string;
}

/**
 * Lệnh chạy tay không --force, chạy NGAY BÂY GIỜ thì gửi (verdict `verdict`),
 * còn gửi được tới trước mốc nào. Cùng quy tắc với decideWeek của agent:
 *   - gửi bù (thứ 7 trở đi): tới hạn − MIN_CATCH_UP_MS (còn dưới 1 giờ là thôi);
 *   - đúng ngày (thứ 6 từ 15:00): không xét quy tắc 1 giờ, nên hạn còn trong thứ
 *     6 thì gửi được tới đúng hạn; hạn sau thứ 6 thì từ 0:00 thứ 7 đã là gửi bù,
 *     nên tới hạn − 1 giờ — nhưng không sớm hơn hết thứ 6 (lúc đó vẫn đúng ngày).
 * Luôn có mốc, để lời dặn chạy tay không bao giờ thiếu "trước HH:MM".
 */
function manualSendUntil(weekId: string, verdict: string, closeMs: number): number {
  const catchUpUntil = closeMs - MIN_CATCH_UP_MS;
  if (verdict !== 'on_time') return catchUpUntil;
  const fridayEnds = Date.parse(`${shiftDate(weekId, 5)}T00:00:00+07:00`);
  return closeMs <= fridayEnds ? closeMs : Math.max(fridayEnds, catchUpUntil);
}

function sendOutlook(week: SurveyWeekDoc, now: Date): SendOutlook {
  const t = now.getTime();
  const runs = autoSendRuns(week, now);
  const d = decideWeek({ weekId: week.id, now, existing: week });
  const closeMs = toMillis(week.closesAt) ?? Date.parse(surveyClosesAt(week.id));
  // Giờ agent chuyển sang tuần mới: 12:00 thứ 2 tuần sau (hạn MẶC ĐỊNH, không
  // phải hạn đã gia hạn — defaultSurveyWeekId không đọc document tuần).
  const switchMs = Date.parse(surveyClosesAt(week.id));
  const nextRun = scheduledRuns(week.id).find(ms => ms > t);
  // Không còn lần tự động nào: nêu đúng điều chặn lần chạy theo lịch KẾ TIẾP —
  // khảo sát đóng trước lần đó (vd. hạn rút về tối thứ 6), hay lần đó agent đã
  // chọn tuần mới, hay lần đó còn chưa tới 1 giờ là hết hạn.
  const why =
    d.action === 'too_late'
      ? `chỉ còn ${spanLabel(closeMs - t)} là hết hạn trả lời (${fmtVn(closeMs)}) — máy HAC không gửi bù khi còn chưa tới 1 giờ ` +
        '(Thầy/Cô không kịp trả lời), kể cả khi chạy tay không có --force'
      : d.action === 'wait'
        ? `hạn trả lời (${fmtVn(closeMs)}) đang trước giờ gửi 15:00 thứ 6`
        : nextRun !== undefined && closeMs <= nextRun
          ? `khảo sát đóng lúc ${fmtVn(closeMs)}, trước lần chạy theo lịch kế tiếp (${fmtVn(nextRun)})`
          : nextRun === undefined || nextRun >= switchMs
            ? `từ 12:00 ${formatDayLabel(shiftDate(week.id, 7))} các lần chạy tự động của máy HAC chỉ lo tuần mới` +
              (closeMs > switchMs ? ', kể cả khi tuần này đã gia hạn' : '')
            : `các lần chạy theo lịch còn lại của máy HAC cho tuần này đều quá sát hạn trả lời ${fmtVn(closeMs)} (còn chưa tới 1 giờ)`;
  return {
    runs,
    manual: d.action,
    manualUntil: d.action === 'send' ? manualSendUntil(week.id, d.gate.verdict, closeMs) : null,
    closeMs,
    why,
  };
}

/**
 * Không còn lần chạy tự động nào gửi cho tuần này: nói rõ vì sao và việc phải
 * làm. `what` là việc máy HAC không làm ("gửi nốt cho 5 người gửi lỗi"),
 * `check` là việc cần kiểm tra trước khi chạy tay (nếu có).
 */
function manualStep(week: SurveyWeekDoc, o: SendOutlook, what: string, check = ''): EmailStep {
  const cmd = manualSendCommand(week.id);
  const run = `${check}trên máy HAC mở thư mục agent và chạy`;
  if (o.manual === 'send') {
    return {
      text: `Máy HAC sẽ KHÔNG tự ${what}: ${o.why}. Cần gửi thì ${run}${o.manualUntil !== null ? ` (trước ${fmtVn(o.manualUntil)})` : ''}:`,
      command: cmd,
    };
  }
  if (o.manual === 'too_late') {
    return {
      text: `Máy HAC không ${what} nữa: ${o.why}. Muốn vẫn mời: đặt hạn mới ở ô "Gia hạn đến" bên dưới, rồi ${run}:`,
      command: cmd,
    };
  }
  // 'wait': hạn trả lời trước 15:00 thứ 6 — chạy tay không --force cũng thôi.
  return { text: `Máy HAC sẽ không ${what}: ${o.why}. Muốn gửi: đặt hạn mới sau 15:00 thứ 6 ở ô "Gia hạn đến" bên dưới.` };
}

/** Người CHẮC CHẮN chưa nhận thư: máy HAC tự gửi nốt ở lần chạy nào, hay phải chạy tay. */
function failedStep(week: SurveyWeekDoc, now: Date, o: SendOutlook, failed: number): EmailStep {
  const who = `${failed} người gửi lỗi`;
  if (!o.runs.length) return manualStep(week, o, `gửi nốt cho ${who}`);
  const next = o.runs[0];
  const last = o.runs[o.runs.length - 1];
  const text =
    `Máy HAC tự gửi nốt cho ${who} ở lần chạy theo lịch kế tiếp (${fmtVn(next)})` +
    (last > next
      ? `; lỗi nữa thì thử lại ở các lần sau — lần tự động cuối cùng cho tuần này là ${fmtVn(last)}`
      : ' — đây là lần tự động cuối cùng cho tuần này') +
    ' (nếu task trên máy HAC đã đặt đủ 3 lịch như hướng dẫn).';
  // Chiều thứ 6 lần sau chỉ cách vài phút: khỏi bày lệnh chạy tay.
  if (next - now.getTime() <= SOON_MS || o.manual !== 'send') return { text };
  return { text: `${text} Muốn gửi ngay (không ai nhận trùng), trên máy HAC mở thư mục agent và chạy:`, command: manualSendCommand(week.id) };
}

/**
 * Người KHÔNG RÕ đã nhận thư: agent không bao giờ tự gửi lại (kể cả lệnh không
 * --force). Chỉ đưa lệnh --force, kèm cảnh báo ai đã nhận sẽ nhận thêm thư.
 */
function uncertainStep(week: SurveyWeekDoc, o: SendOutlook, uncertain: number, failed: number): EmailStep {
  return {
    text:
      `${uncertain} người KHÔNG RÕ đã nhận thư (lần gửi lỗi giữa chừng, không biết thư đã đi chưa). Máy HAC không bao giờ ` +
      'tự gửi lại cho họ — lịch chạy và lệnh không có --force đều bỏ qua họ, để không ai nhận hai thư. Hỏi vài Thầy/Cô có ' +
      'nhãn "Không rõ đã nhận" ở danh sách Chưa trả lời bên dưới; đã nhận thì thôi. ' +
      (o.manual === 'too_late' ? 'Còn chưa tới 1 giờ là hết hạn trả lời — muốn mời lại thì đặt hạn mới ở ô "Gia hạn đến" bên dưới trước. ' : '') +
      `Chỉ khi chắc chắn họ CHƯA nhận mới chạy lệnh dưới trên máy HAC${failed > 0 ? ' (gửi luôn cho người gửi lỗi)' : ''} — ` +
      'CẢNH BÁO: ai thật ra đã nhận sẽ nhận thêm một thư:',
    command: forceSendCommand(week.id),
  };
}

/**
 * Số người theo tình trạng thư mời cho thẻ "Email mời": ưu tiên danh sách mời
 * (private/invited — cùng số với các ô số liệu và danh sách bên dưới). Chưa đọc
 * được danh sách thì lấy số trong document tuần; agent không ghi số "không rõ"
 * vào đó nên đọc từ câu ghi chú, không có thì suy ra từ các số còn lại.
 */
function emailCounts(e: SurveyEmailInfo, delivery: DeliveryCounts | null): DeliveryCounts {
  if (delivery) return delivery;
  const total = countOf(e.recipients);
  const received = countOf(e.sent);
  const failed = countOf(e.failed);
  const m = /(\d+) người KHÔNG RÕ đã nhận/.exec(str(e.reason));
  const uncertain = m ? Number(m[1]) : e.status === 'partial' ? Math.max(0, total - received - failed) : 0;
  return { total, received, uncertain, failed };
}

/**
 * Còn người chưa nhận thư (partial / error): ai gửi nốt, khi nào, bằng lệnh nào.
 * Người gửi lỗi và người "không rõ đã nhận" được xử lý khác hẳn nhau nên tách
 * thành hai việc.
 */
function resendSteps(week: SurveyWeekDoc, now: Date, c: DeliveryCounts): EmailStep[] {
  const o = sendOutlook(week, now);
  if (phaseOf(week, now) === 'closed' || o.manual === 'closed') {
    return [{
      text:
        'Khảo sát đã đóng nên máy HAC không gửi nốt' +
        (c.uncertain > 0 ? ' và không gửi lại cho người không rõ đã nhận' : '') +
        ', kể cả khi chạy tay. Muốn mời tiếp: đặt hạn mới ở ô "Mở lại đến" bên dưới — mục này sẽ nói cách gửi.',
    }];
  }
  const steps: EmailStep[] = [];
  if (c.failed > 0) steps.push(failedStep(week, now, o, c.failed));
  if (c.uncertain > 0) steps.push(uncertainStep(week, o, c.uncertain, c.failed));
  return steps;
}

/**
 * Diễn giải trạng thái gửi email mời của một tuần. `delivery`: số người theo
 * tình trạng thư mời đọc từ danh sách mời (null = chưa đọc được).
 */
function describeEmail(week: SurveyWeekDoc, now: Date, delivery: DeliveryCounts | null = null): EmailView {
  const e = week.email;
  const note = agentNote(e?.reason) || undefined;
  const at = e?.sentAt || e?.at;
  const atText = at ? ` lúc ${formatVnDateTime(at)}` : '';
  const phase = phaseOf(week, now);
  // Ghi chú "N người không có email @hoangmaistarschool.edu.vn trong tài khoản,
  // không gửi được" (inviteeNotes của agent; khác câu "N người CHƯA gửi được" của
  // thư lỗi): agent bỏ hẳn những người này khỏi danh sách mời, nên họ không hiện
  // ở "Được mời" hay "Chưa trả lời" — không nói ra thì không ai biết họ bị sót.
  const notice = note && /không gửi được/i.test(note)
    ? 'Người không có email trường KHÔNG nằm trong số "Được mời" và danh sách "Chưa trả lời" bên dưới — cần thì báo họ qua kênh khác.'
    : undefined;
  switch (e?.status) {
    case 'sent':
      return {
        // 'sent' kèm người không gửi được hay lỗi ghi danh sách đã nhận thì cần
        // để ý; ghi chú gửi bù thì chỉ để biết.
        tone: note && /không gửi được|lỗi/i.test(note) ? 'warn' : 'ok',
        text: `Đã gửi email mời tới ${countOf(e.sent)} người${atText}.`,
        note,
        notice,
      };
    case 'partial':
    case 'error': {
      const c = emailCounts(e, delivery);
      // "Không rõ đã nhận" tách khỏi "gửi lỗi": một lần gửi cả trường bị hết giờ
      // chờ mà ghi "0 người gửi lỗi" là che mất chuyện cả trường có thể chưa nhận.
      const parts = [
        c.uncertain > 0 ? `${c.uncertain} người không rõ đã nhận` : '',
        c.failed > 0 ? `${c.failed} người gửi lỗi` : '',
      ].filter(Boolean);
      const tail = parts.length ? ` — ${parts.join(', ')}` : '';
      return {
        tone: e.status === 'error' ? 'error' : 'warn',
        text: e.status === 'error'
          ? c.received > 0
            ? `Đã gửi ${c.received} người, lần chạy gần nhất bị lỗi${tail}.`
            : `Chưa gửi được email mời${tail}.`
          : `Đã gửi ${c.received}/${c.total} người${atText}${tail}.`,
        note,
        notice,
        steps: resendSteps(week, now, c),
      };
    }
    case 'skipped':
      return note
        ? { tone: 'neutral', text: 'Không gửi email mời.', note }
        : { tone: 'neutral', text: 'Không gửi email mời: tuần nghỉ, không có suất ăn.' };
  }
  if (e?.status) return { tone: 'neutral', text: `Trạng thái email: ${e.status}.`, note };

  // Chưa có trạng thái: máy HAC chưa chạy cho tuần này, hoặc đã chạy mà bỏ qua.
  const t = now.getTime();
  const { sendAt, lastRunAt } = inviteSchedule(week.id);
  const friday = formatDayLabel(shiftDate(week.id, 4));
  const closeMs = toMillis(week.closesAt);
  // Hạn trả lời trước 15:00 thứ 6 (mở tay rồi "Đóng ngay", hay gia hạn nhầm về
  // trước) thì lúc 15:00 agent thấy khảo sát đã đóng và KHÔNG gửi gì, cũng
  // không ghi trạng thái — không nói ra thì tuần đó lặng lẽ mất email mời.
  const closedBeforeSend = closeMs !== null && closeMs <= sendAt;
  if (t < sendAt) {
    if (closedBeforeSend) {
      return {
        tone: 'warn',
        text: `Chưa gửi — và máy HAC sẽ KHÔNG gửi email mời: hạn trả lời đang trước 15:00 ${friday}.`,
        steps: [{ text: `Muốn gửi email mời, đặt hạn mới sau 15:00 thứ 6 ở ô "${phase === 'closed' ? 'Mở lại đến' : 'Gia hạn đến'}" bên dưới.` }],
      };
    }
    return { tone: 'neutral', text: `Chưa gửi — máy HAC tự gửi email mời lúc 15:00 ${friday}.` };
  }
  if (closedBeforeSend) {
    // Chỉ gợi ý gửi bù khi tuần còn trong hạn mặc định (tới 12:00 thứ 2 sau);
    // tuần cũ hơn thì mời làm khảo sát đã qua lâu là vô ích.
    const recent = t < Date.parse(surveyClosesAt(week.id));
    return {
      tone: recent ? 'warn' : 'neutral',
      text: 'Không có email mời nào được gửi: khảo sát đã đóng trước 15:00 thứ 6 nên máy HAC bỏ qua tuần này.',
      ...(!recent
        ? {}
        : t <= lastRunAt
          ? { steps: [{ text: 'Muốn gửi: đặt hạn mới ở ô "Mở lại đến" bên dưới — lần chạy theo lịch kế tiếp của máy HAC (tới 16:00 thứ 6) sẽ gửi.' }] }
          : {
              steps: [{
                text: 'Muốn gửi: đặt hạn mới ở ô "Mở lại đến" bên dưới, rồi trên máy HAC mở thư mục agent và chạy:',
                command: manualSendCommand(week.id),
              }],
            }),
    };
  }
  if (phase === 'open') {
    if (t <= lastRunAt) {
      return {
        tone: 'neutral',
        text: 'Đang trong giờ gửi (15:00–16:00 thứ 6) nhưng chưa có trạng thái — máy HAC có thể đang gửi.',
        steps: [{ text: 'Tới 16:00 vẫn chưa có thì kiểm tra máy HAC (survey.enabled trong config.json, file khao-sat.log).' }],
      };
    }
    const o = sendOutlook(week, now);
    const check = 'kiểm tra survey.enabled trong config.json và file khao-sat.log, rồi ';
    if (!o.runs.length) {
      return { tone: 'warn', text: 'Chưa có email mời nào được gửi.', steps: [manualStep(week, o, 'gửi email mời cho tuần này', check)] };
    }
    const last = o.runs[o.runs.length - 1];
    return {
      tone: 'warn',
      text: 'Chưa có email mời nào được gửi.',
      steps: [{
        // Lần bật máy trước lần chạy tự động cuối cùng chắc chắn còn trong giờ
        // agent gửi bù (giờ gửi bù là một khoảng liền, kết thúc sau lần đó).
        text:
          `Nếu máy HAC tắt lúc 15:00 thứ 6, lần chạy bù kế tiếp (${fmtVn(o.runs[0])}) — hoặc khi bật máy, nếu bật trước ` +
          `${fmtVn(last)} — sẽ tự gửi. Nếu máy vẫn bật thì lịch đã chạy mà không gửi: ${check}trên máy HAC mở thư mục agent và chạy:`,
        command: manualSendCommand(week.id),
      }],
    };
  }
  return { tone: 'neutral', text: 'Không có email mời nào được gửi cho tuần này.' };
}

// ------------------------------------------------------------- xuất Excel

/** Dựng file Excel 3 sheet: Tổng hợp, Phản hồi, Chưa trả lời. */
export function buildSurveyWorkbook({
  week,
  responses,
  invited,
  invitedError = false,
  now,
}: {
  week: SurveyWeekDoc;
  responses: SurveyResponseDoc[];
  invited: SurveyInvitee[] | null;
  /**
   * Đọc danh sách mời bị lỗi. Khác hẳn "chưa có danh sách": file Excel được
   * chuyền tay, ghi nhầm "khảo sát mở tay, chưa gửi email" cho một tuần máy
   * HAC đã gửi là ghi sai sự thật.
   */
  invitedError?: boolean;
  now: Date;
}): xlsx.WorkBook {
  const stats = summarizeChoices(responses);
  const rate = responseRate(responses, invitedError ? null : invited);
  const wb = xlsx.utils.book_new();
  const noListText = invitedError
    ? 'Không đọc được danh sách người được mời — bấm Tải lại rồi xuất lại'
    : 'Chưa có danh sách mời';

  const summary: (string | number)[][] = [
    [SURVEY_TITLE],
    ['Tuần', surveyWeekLabel(week.id)],
    ['Mở lúc', fmtVn(week.opensAt)],
    ['Đóng lúc', fmtVn(week.closesAt)],
    ['Số phản hồi', responses.length],
    ['Số được mời', rate.invitedCount ?? noListText],
    // File được chuyền tay: tách đủ ba nhóm, đừng để người "không rõ đã nhận"
    // (có thể đã nhận) bị đọc thành "gửi lỗi".
    ...(rate.failedCount > 0 || rate.uncertainCount > 0
      ? [
          ['Trong đó đã nhận thư mời', rate.receivedCount],
          ...(rate.uncertainCount > 0 ? [['Trong đó không rõ đã nhận thư mời', rate.uncertainCount]] : []),
          ...(rate.failedCount > 0 ? [['Trong đó chưa nhận được thư mời (gửi lỗi)', rate.failedCount]] : []),
        ] as (string | number)[][]
      : []),
    [
      rate.uncertainCount > 0 ? 'Người đã nhận (hoặc không rõ đã nhận) thư mời đã trả lời' : 'Người đã nhận thư mời đã trả lời',
      rate.deliveredCount === null ? '' : rate.deliveredAnswered,
    ],
    [
      rate.uncertainCount > 0
        ? 'Tỉ lệ trả lời (%) — trên số người đã nhận hoặc không rõ đã nhận thư'
        : 'Tỉ lệ trả lời (%) — trên số người đã nhận thư',
      rate.rate === null ? '' : round1(rate.rate),
    ],
    ['Xuất lúc', fmtVn(now)],
    [],
    ['Câu hỏi', 'Đáp án', 'Số phiếu', 'Tỉ lệ (%)'],
  ];
  for (const s of stats) {
    s.options.forEach((o, i) => summary.push([i === 0 ? s.question.label : '', o.label, o.count, round1(o.pct)]));
  }
  const wsSummary = xlsx.utils.aoa_to_sheet(summary);
  wsSummary['!cols'] = [{ wch: 68 }, { wch: 50 }, { wch: 10 }, { wch: 10 }];
  xlsx.utils.book_append_sheet(wb, wsSummary, 'Tổng hợp');

  const sorted = [...responses].sort(
    (a, b) => VI.compare(deptOf(a.department), deptOf(b.department)) || VI.compare(str(a.fullName), str(b.fullName))
  );
  const rows = sorted.map((r, i) => {
    const row: Record<string, string | number> = {
      'STT': i + 1,
      'Họ và tên': str(r.fullName),
      'Mã NV': str(r.employeeId),
      'Bộ phận': str(r.department),
      'Email': str(r.email),
    };
    for (const q of SURVEY_QUESTIONS) row[q.label] = answerLabel(q, r.answers?.[q.id]);
    row['Gửi lúc'] = fmtVn(r.submittedAt);
    row['Sửa lần cuối'] = r.updatedAt && r.updatedAt !== r.submittedAt ? fmtVn(r.updatedAt) : '';
    return row;
  });
  const wsResponses = rows.length
    ? xlsx.utils.json_to_sheet(rows)
    : xlsx.utils.aoa_to_sheet([['Chưa có phản hồi nào.']]);
  if (rows.length) {
    wsResponses['!cols'] = [
      { wch: 5 }, { wch: 26 }, { wch: 10 }, { wch: 24 }, { wch: 32 },
      ...SURVEY_QUESTIONS.map(q => ({ wch: q.kind === 'choice' ? 22 : 40 })),
      { wch: 26 }, { wch: 26 },
    ];
  }
  xlsx.utils.book_append_sheet(wb, wsResponses, 'Phản hồi');

  const wsPending = rate.pending === null
    ? xlsx.utils.aoa_to_sheet([[
        invitedError
          ? 'Không đọc được danh sách người được mời nên chưa xác định được ai chưa trả lời — bấm Tải lại trong tab Khảo sát bữa ăn rồi xuất lại.'
          : 'Chưa có danh sách người được mời (khảo sát mở tay, máy HAC chưa gửi email mời) nên chưa xác định được ai chưa trả lời.',
      ]])
    : xlsx.utils.json_to_sheet(
        rate.pending.length
          ? rate.pending.map((p, i) => ({
              'STT': i + 1,
              'Họ và tên': str(p.fullName),
              'Bộ phận': str(p.department),
              'Email': str(p.email),
              // Người chưa nhận (hay không rõ đã nhận) thư thì đừng nhắc như
              // người lơ là khảo sát.
              'Thư mời': RECEIPT_LABEL[p.receipt],
            }))
          : [{ 'STT': '', 'Họ và tên': 'Mọi người được mời đều đã trả lời.', 'Bộ phận': '', 'Email': '', 'Thư mời': '' }]
      );
  if (rate.pending !== null) wsPending['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 28 }, { wch: 34 }, { wch: 20 }];
  xlsx.utils.book_append_sheet(wb, wsPending, 'Chưa trả lời');

  return wb;
}

export function exportSurveyExcel(args: Parameters<typeof buildSurveyWorkbook>[0]) {
  xlsx.writeFile(buildSurveyWorkbook(args), `Khao_sat_bua_an_tuan_${args.week.id}.xlsx`);
}

// ------------------------------------------------------- phần đọc/ghi dữ liệu

/**
 * Phần có Firestore. Mọi lượt đọc chỉ bắt đầu khi component được dựng (tức là
 * khi quản trị mở tab), và dừng nghe ngay khi rời tab.
 */
export function SurveyResults({
  showToast,
  describeError,
}: {
  showToast: (message: string, type: 'success' | 'error') => void;
  describeError: (err: unknown) => string;
}) {
  // Đồng hồ của tab: trạng thái "đang mở / đã đóng" và đếm ngược tự cập nhật
  // khi trang quản trị để mở lâu.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const currentWeekId = weekStartOf(vnParts(now)?.date ?? vnToday());

  // describeError của trang quản trị nói về quyền GHI; lỗi khi ĐỌC mà báo
  // "chưa được cấp quyền ghi" thì quản trị đi sửa nhầm chỗ.
  const describeReadError = (err: unknown) =>
    String((err as { code?: unknown } | null)?.code ?? '').includes('permission-denied')
      ? 'Tài khoản chưa có quyền đọc dữ liệu khảo sát — kiểm tra Firestore Rules đã được cập nhật chưa.'
      : describeError(err);

  // Danh sách tuần: nghe trực tiếp. Doc nhỏ, ít khi đổi, mà quản trị cần thấy
  // ngay khi máy HAC vừa gửi email lúc 15:00 hay quản trị khác vừa gia hạn.
  const [weeks, setWeeks] = useState<SurveyWeekDoc[]>([]);
  const [weeksState, setWeeksState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const q = query(collection(db, 'meal_surveys'), orderBy(documentId(), 'desc'), limit(WEEK_LIST_LIMIT));
    return onSnapshot(
      q,
      snap => {
        setWeeks(
          snap.docs
            .filter(d => isWeekId(d.id))
            // 'estimate': vừa bấm "Đóng ngay" (serverTimestamp) thì giao diện
            // hiện ngay giờ ước tính, không phải chờ máy chủ xác nhận mới đổi.
            .map(d => ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<SurveyWeekDoc, 'id'>), id: d.id }))
        );
        setWeeksState('ready');
      },
      err => {
        console.error('Không đọc được danh sách khảo sát:', err);
        setWeeksState('error');
      }
    );
  }, []);

  // Tuần đang xem: mặc định tuần đang mở, không có thì tuần gần nhất đã mở.
  const [selectedWeekId, setSelectedWeekId] = useState<string | null>(null);
  useEffect(() => {
    // Chỉ tự chọn khi chưa chọn gì. Không chọn lại khi tuần đang chọn chưa có
    // trong danh sách: vừa bấm "Mở khảo sát tuần này" thì doc mới có thể về
    // sau một nhịp, chọn lại lúc đó sẽ nhảy mất tuần quản trị vừa mở.
    if (weeksState !== 'ready' || selectedWeekId) return;
    const open = weeks.find(w => isSurveyOpen(w, now));
    const past = weeks.find(w => w.id <= currentWeekId && toMillis(w.opensAt) !== null);
    setSelectedWeekId(open?.id ?? past?.id ?? weeks[0]?.id ?? null);
    // Chỉ chọn lại khi danh sách đổi; `now` đổi mỗi 30 giây, đưa vào phụ thuộc
    // thì không đổi kết quả mà chỉ tốn công.
  }, [weeks, weeksState, selectedWeekId]);

  const selectedWeek = weeks.find(w => w.id === selectedWeekId) || null;
  // Máy HAC ghi trạng thái email SAU khi đã ghi danh sách mời. Trạng thái đổi
  // (vd. 15:00 thứ 6 vừa gửi xong) thì đọc lại phản hồi + danh sách mời, kẻo
  // thẻ trạng thái (nghe trực tiếp) báo "đã gửi" mà phần kết quả bên dưới còn
  // nói "chưa có danh sách mời" cho tới khi quản trị tình cờ bấm Tải lại.
  const emailStamp = String(selectedWeek?.email?.at ?? '');

  // Phản hồi + danh sách mời của tuần đang xem: đọc một lần (không nghe trực
  // tiếp — tuần đông có vài trăm phản hồi), bấm "Tải lại" để cập nhật.
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<SurveyDetail>({ status: 'idle' });
  useEffect(() => {
    if (!selectedWeekId) {
      setDetail({ status: 'idle' });
      return;
    }
    const weekId = selectedWeekId;
    let cancelled = false;
    setDetail({ status: 'loading', weekId });
    (async () => {
      // allSettled: đọc danh sách mời lỗi vẫn phải hiện được kết quả.
      const [respRes, invRes] = await Promise.allSettled([
        getDocs(collection(db, 'meal_surveys', weekId, 'responses')),
        getDoc(doc(db, 'meal_surveys', weekId, 'private', 'invited')),
      ]);
      if (cancelled) return;
      if (respRes.status === 'rejected') {
        console.error('Không đọc được phản hồi khảo sát:', respRes.reason);
        setDetail({ status: 'error', weekId, message: describeReadError(respRes.reason) });
        return;
      }
      if (invRes.status === 'rejected') console.error('Không đọc được danh sách người được mời:', invRes.reason);
      setDetail({
        status: 'ready',
        weekId,
        responses: respRes.value.docs.map(d => ({ ...(d.data() as Omit<SurveyResponseDoc, 'id'>), id: d.id })),
        invited:
          invRes.status === 'fulfilled' && invRes.value.exists()
            ? cleanInvitees(invRes.value.data().recipients, invRes.value.data().sentEmails, invRes.value.data().uncertainEmails)
            : null,
        receiptKnown: invRes.status === 'fulfilled' && invRes.value.exists() && Array.isArray(invRes.value.data().sentEmails),
        invitedError: invRes.status === 'rejected',
        loadedAt: new Date(),
      });
    })();
    return () => { cancelled = true; };
  }, [selectedWeekId, reloadKey, emailStamp]);

  // Bảng xu hướng: ĐẾM trên máy chủ (getCountFromServer), không tải từng phản
  // hồi. Mỗi phép đếm tính 1 lượt đọc cho mỗi 1.000 phản hồi khớp, nên 8 tuần
  // × 4 phép đếm ≈ 32 lượt đọc — tải hết phản hồi 8 tuần thì tới vài nghìn.
  const trendWeekIds = useMemo(
    () =>
      weeks
        .filter(w => {
          const open = toMillis(w.opensAt);
          return open !== null && open <= now.getTime();
        })
        .slice(0, TREND_WEEKS)
        .map(w => w.id),
    [weeks, now]
  );
  const trendKey = trendWeekIds.join(',');
  const [trendReloadKey, setTrendReloadKey] = useState(0);
  const [trend, setTrend] = useState<SurveyTrend>({ status: 'loading', rows: [] });
  useEffect(() => {
    if (weeksState !== 'ready') return;
    if (!trendKey) {
      setTrend({ status: 'ready', rows: [] });
      return;
    }
    let cancelled = false;
    setTrend(t => ({ status: 'loading', rows: t.rows }));
    (async () => {
      try {
        const rows = await Promise.all(
          trendKey.split(',').map(async weekId => {
            const col = collection(db, 'meal_surveys', weekId, 'responses');
            const [total, ...metric] = await Promise.all([
              getCountFromServer(col),
              ...TREND_METRICS.map(m => getCountFromServer(query(col, where(`answers.${m.questionId}`, '==', m.value)))),
            ]);
            return {
              weekId,
              responses: total.data().count,
              counts: Object.fromEntries(TREND_METRICS.map((m, i) => [m.key, metric[i].data().count])),
            };
          })
        );
        if (!cancelled) setTrend({ status: 'ready', rows });
      } catch (err) {
        console.error('Không đếm được số liệu xu hướng khảo sát:', err);
        if (!cancelled) setTrend({ status: 'error', rows: [], message: describeReadError(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [trendKey, trendReloadKey, weeksState]);

  const [busy, setBusy] = useState<SurveyBusy>(null);

  // Mở khảo sát tuần hiện tại sớm hơn 15:00 thứ 6. Chỉ tạo lịch mở/đóng —
  // KHÔNG gửi email (việc đó của máy HAC) và không đụng tới trường email.
  // Dùng transaction: máy HAC có thể vừa tạo doc tuần này cùng lúc; ghi đè thì
  // mất trạng thái email và máy HAC sẽ gửi lại cả trường.
  const handleOpenThisWeek = async () => {
    const weekId = currentWeekId;
    const { weekStart, weekEnd } = surveyWeek(weekId);
    setBusy('open');
    try {
      const ref = doc(db, 'meal_surveys', weekId);
      const result = await runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        const cur = snap.exists() ? snap.data() : null;
        if (cur && toMillis(cur.opensAt) !== null) return 'exists' as const;
        tx.set(
          ref,
          {
            weekId,
            weekStart,
            weekEnd,
            version: SURVEY_VERSION,
            // Giờ máy chủ: rules so request.time với opensAt, lấy giờ máy quản
            // trị mà chạy nhanh vài phút thì người trả lời đầu tiên bị từ chối.
            opensAt: serverTimestamp(),
            closesAt: Timestamp.fromDate(new Date(surveyClosesAt(weekId))),
            openedBy: (auth.currentUser?.email || '').trim().toLowerCase() || 'quản trị',
            createdAt: typeof cur?.createdAt === 'string' ? cur.createdAt : new Date().toISOString(),
          },
          // merge: doc tuần nghỉ (máy HAC ghi email 'skipped') vẫn giữ nguyên trường email.
          { merge: true }
        );
        return 'opened' as const;
      });
      const opened = new Date();
      setNow(opened);
      setSelectedWeekId(weekId);
      // Chỉ hứa "máy HAC gửi lúc 15:00 thứ 6" khi điều đó còn đúng: mở tay sau
      // 15:00 thứ 6 hay mở tuần máy HAC đã bỏ qua thì không có lần gửi nào chờ
      // sẵn — mục "Email mời" của thẻ trạng thái nói cách gửi theo giờ hiện tại.
      const skipped = weeks.find(w => w.id === weekId)?.email?.status === 'skipped';
      const beforeSend = opened.getTime() < inviteSchedule(weekId).sendAt;
      showToast(
        result !== 'opened'
          ? `Khảo sát tuần ${surveyWeekLabel(weekId)} đã được mở trước đó (có thể máy HAC vừa mở) — không ghi đè.`
          : skipped
            ? `Đã mở khảo sát tuần ${surveyWeekLabel(weekId)}. Máy HAC đã bỏ qua tuần này nên không có email mời — xem mục "Email mời".`
            : beforeSend
              ? `Đã mở khảo sát tuần ${surveyWeekLabel(weekId)}. Email mời vẫn do máy HAC gửi lúc 15:00 thứ 6.`
              : `Đã mở khảo sát tuần ${surveyWeekLabel(weekId)}. Mở tay không gửi email mời — xem mục "Email mời" để biết cách gửi.`,
        'success'
      );
    } catch (err) {
      console.error('Lỗi khi mở khảo sát:', err);
      showToast(`Không mở được khảo sát. ${describeError(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  // Gia hạn / mở lại / đóng: chỉ ghi closesAt (Timestamp) — rules so với giờ
  // máy chủ, và không đụng opensAt hay trạng thái email của máy HAC.
  const handleExtend = async (weekId: string, until: Date) => {
    setBusy('extend');
    try {
      await updateDoc(doc(db, 'meal_surveys', weekId), { closesAt: Timestamp.fromDate(until) });
      setNow(new Date());
      showToast(`Đã đặt hạn trả lời tuần ${surveyWeekLabel(weekId)} đến ${fmtVn(until)}.`, 'success');
    } catch (err) {
      console.error('Lỗi khi gia hạn khảo sát:', err);
      showToast(`Không gia hạn được khảo sát. ${describeError(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleCloseNow = async (weekId: string) => {
    setBusy('close');
    try {
      // Giờ máy chủ, để "đóng ngay" đúng là ngay theo đồng hồ mà rules dùng.
      await updateDoc(doc(db, 'meal_surveys', weekId), { closesAt: serverTimestamp() });
      setNow(new Date());
      showToast(`Đã đóng khảo sát tuần ${surveyWeekLabel(weekId)}.`, 'success');
    } catch (err) {
      console.error('Lỗi khi đóng khảo sát:', err);
      showToast(`Không đóng được khảo sát. ${describeError(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SurveyResultsView
      now={now}
      currentWeekId={currentWeekId}
      weeks={weeks}
      weeksState={weeksState}
      selectedWeekId={selectedWeekId}
      onSelectWeek={setSelectedWeekId}
      detail={detail}
      trend={trend}
      busy={busy}
      onOpenThisWeek={handleOpenThisWeek}
      onExtend={handleExtend}
      onCloseNow={handleCloseNow}
      onReload={() => { setNow(new Date()); setReloadKey(k => k + 1); setTrendReloadKey(k => k + 1); }}
      onReloadTrend={() => setTrendReloadKey(k => k + 1)}
      onExport={() => {
        if (!selectedWeek || detail.status !== 'ready' || detail.weekId !== selectedWeek.id) return;
        exportSurveyExcel({
          week: selectedWeek,
          responses: detail.responses,
          invited: detail.invited,
          invitedError: detail.invitedError,
          now: new Date(),
        });
      }}
    />
  );
}

// -------------------------------------------------------- phần hiển thị

export interface SurveyResultsViewProps {
  now: Date;
  /** Thứ 2 của tuần hiện tại theo giờ Việt Nam. */
  currentWeekId: string;
  /** Mới nhất trước. */
  weeks: SurveyWeekDoc[];
  weeksState: 'loading' | 'ready' | 'error';
  selectedWeekId: string | null;
  onSelectWeek: (weekId: string) => void;
  detail: SurveyDetail;
  trend: SurveyTrend;
  busy: SurveyBusy;
  onOpenThisWeek: () => void;
  onExtend: (weekId: string, until: Date) => void;
  onCloseNow: (weekId: string) => void;
  onReload: () => void;
  onReloadTrend: () => void;
  onExport: () => void;
}

/** Giao diện tab, chỉ theo props — không đọc/ghi Firestore. */
export function SurveyResultsView(props: SurveyResultsViewProps) {
  const { now, currentWeekId, weeks, weeksState, selectedWeekId, onSelectWeek, detail, trend, busy } = props;
  const week = weeks.find(w => w.id === selectedWeekId) || null;
  const ready = detail.status === 'ready' && !!week && detail.weekId === week.id ? detail : null;
  const loadingDetail = !!week && !ready && !(detail.status === 'error' && detail.weekId === week.id);
  const currentWeek = weeks.find(w => w.id === currentWeekId) || null;
  const showOpenBanner = weeksState === 'ready' && (!currentWeek || toMillis(currentWeek.opensAt) === null);
  // Số người đã nhận / không rõ / gửi lỗi theo danh sách mời, cho thẻ "Email mời":
  // document tuần không có số "không rõ đã nhận" (chỉ có trong private/invited).
  const delivery = useMemo(
    () => (ready && ready.invited && ready.receiptKnown !== false && !ready.invitedError ? deliveryCounts(ready.invited) : null),
    [ready]
  );

  // Bảng xu hướng nằm cuối trang (dưới cả trăm thẻ ý kiến), còn nội dung tuần
  // nằm trên cùng: bấm một tuần trong bảng mà không cuộn lên thì chỉ thấy dòng
  // đổi màu, phần thay đổi thật ở ngoài màn hình.
  const topRef = useRef<HTMLElement>(null);
  const selectFromTrend = (weekId: string) => {
    onSelectWeek(weekId);
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    topRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div className="px-md md:px-0 flex flex-col gap-md lg:gap-lg">
      {/* scroll-mt-20: chừa thanh header cố định (h-16) khi cuộn tới đây. */}
      <section ref={topRef} className="scroll-mt-20 bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
        <div className="p-md border-b border-outline-variant bg-surface-container-low flex flex-col lg:flex-row lg:items-end gap-md">
          <div className="flex-1 min-w-0">
            <h2 className="text-headline-sm text-on-surface uppercase">Khảo sát bữa ăn</h2>
            <p className="text-on-surface-variant text-[13px] mt-1">
              {SURVEY_TITLE}. Email mời tự động gửi lúc 15:00 thứ 6 tới CBGV-NV có đăng ký ăn; hạn trả lời 12:00 thứ 2
              tuần sau. Phản hồi ghi kèm họ tên.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-end gap-2 w-full lg:w-auto">
            <label className="flex flex-col gap-1 min-w-0 sm:min-w-[260px]">
              <span className="text-label-sm text-on-surface-variant uppercase">Tuần</span>
              <select
                value={selectedWeekId ?? ''}
                onChange={e => onSelectWeek(e.target.value)}
                disabled={!weeks.length}
                className="bg-surface-container-lowest border border-outline-variant hover:border-primary/40 rounded-lg px-3 py-2 text-body-md text-primary font-bold outline-none cursor-pointer disabled:cursor-default disabled:opacity-60"
              >
                {!weeks.length && <option value="">Chưa có tuần nào</option>}
                {weeks.map(w => (
                  <option key={w.id} value={w.id}>
                    {surveyWeekLabel(w.id)}{w.id === currentWeekId ? ' (tuần này)' : ''} — {PHASE_UI[phaseOf(w, now)].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button
                onClick={props.onReload}
                disabled={detail.status === 'loading'}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface text-label-md hover:bg-surface-container disabled:opacity-50 transition-colors"
              >
                <span className={`material-symbols-outlined text-[18px] ${detail.status === 'loading' ? 'animate-spin' : ''}`}>
                  {detail.status === 'loading' ? 'progress_activity' : 'refresh'}
                </span>
                Tải lại
              </button>
              <button
                onClick={props.onExport}
                disabled={!ready}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-tertiary text-on-tertiary text-label-md hover:bg-tertiary-dark disabled:opacity-50 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">download</span>
                Xuất Excel
              </button>
            </div>
          </div>
        </div>

        <div className="p-md flex flex-col gap-md">
          {showOpenBanner && (
            <OpenThisWeekBanner
              weekId={currentWeekId}
              week={currentWeek}
              now={now}
              busy={busy}
              onOpen={props.onOpenThisWeek}
            />
          )}

          {weeksState === 'loading' && (
            <div className="p-md rounded-lg bg-surface-container text-on-surface-variant text-body-md flex items-center gap-2" aria-live="polite">
              <span className="material-symbols-outlined text-[20px] animate-spin">progress_activity</span>
              Đang tải danh sách khảo sát...
            </div>
          )}

          {weeksState === 'error' && (
            <div className="p-md rounded-lg bg-error-container text-on-error-container text-body-md flex items-start gap-2">
              <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
              <span>Không đọc được danh sách khảo sát. Nếu vừa cập nhật Firestore Rules, Thầy/Cô tải lại trang.</span>
            </div>
          )}

          {weeksState === 'ready' && !weeks.length && (
            <div className="p-md rounded-lg bg-surface-container text-on-surface-variant text-body-md flex items-start gap-2">
              <span className="material-symbols-outlined text-[20px] shrink-0">rate_review</span>
              <span>
                Chưa có khảo sát nào. Máy HAC tự mở khảo sát và gửi email mời lúc 15:00 thứ 6 hằng tuần (khi chức năng
                khảo sát đã bật trong cấu hình agent).
              </span>
            </div>
          )}

          {week && (
            <WeekStatusCard
              key={`${week.id}:${toMillis(week.closesAt) ?? ''}`}
              week={week}
              now={now}
              busy={busy}
              delivery={delivery}
              onExtend={props.onExtend}
              onCloseNow={props.onCloseNow}
            />
          )}
        </div>
      </section>

      {week && detail.status === 'error' && detail.weekId === week.id && (
        <div className="p-md rounded-lg bg-error-container text-on-error-container text-body-md flex items-start gap-2">
          <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
          <span>Không đọc được phản hồi của tuần này. {detail.message}</span>
        </div>
      )}

      {loadingDetail && (
        <div className="p-md rounded-lg bg-surface-container text-on-surface-variant text-body-md flex items-center gap-2" aria-live="polite">
          <span className="material-symbols-outlined text-[20px] animate-spin">progress_activity</span>
          Đang tải phản hồi...
        </div>
      )}

      {/* Tuần không mở khảo sát (tuần nghỉ máy HAC bỏ qua) thì không có gì để
          thống kê — thẻ trạng thái phía trên đã nói rõ. */}
      {week && ready && (toMillis(week.opensAt) !== null || ready.responses.length > 0) && (
        <WeekResults key={week.id} week={week} detail={ready} now={now} />
      )}

      {weeksState === 'ready' && weeks.length > 0 && (
        <TrendTable
          trend={trend}
          now={now}
          weeks={weeks}
          selectedWeekId={selectedWeekId}
          onSelectWeek={selectFromTrend}
          onReload={props.onReloadTrend}
        />
      )}
    </div>
  );
}

/** Tuần hiện tại chưa có khảo sát: nhắc lịch tự động và cho mở sớm. */
function OpenThisWeekBanner({
  weekId,
  week,
  now,
  busy,
  onOpen,
}: {
  weekId: string;
  week: SurveyWeekDoc | null;
  now: Date;
  busy: SurveyBusy;
  onOpen: () => void;
}) {
  const sendAt = Date.parse(surveyDefaultOpensAt(weekId));
  const friday = formatDayLabel(shiftDate(weekId, 4));
  const skipped = week?.email?.status === 'skipped';
  const late = !skipped && now.getTime() >= sendAt;
  return (
    <div
      className={`p-sm rounded-lg border flex flex-col sm:flex-row sm:items-center gap-3 ${
        late ? 'bg-warning-container border-warning/30 text-on-warning-container' : 'bg-primary-container/30 border-primary/20 text-on-surface'
      }`}
    >
      <span className="material-symbols-outlined text-[22px] shrink-0 hidden sm:block" aria-hidden="true">
        {late ? 'warning' : 'event_upcoming'}
      </span>
      <div className="flex-1 min-w-0 text-body-sm">
        <p className="text-label-lg">Tuần này ({surveyWeekLabel(weekId)}) chưa mở khảo sát.</p>
        <p className="mt-0.5">
          {skipped
            ? `Máy HAC đã bỏ qua tuần này${week?.email?.reason ? ` (${week.email.reason})` : ' vì không có suất ăn'}. Vẫn cần khảo sát thì Thầy/Cô có thể mở tay.`
            : late
              ? 'Đã quá 15:00 thứ 6 mà máy HAC chưa mở — kiểm tra máy HAC (survey.enabled trong config.json của agent), hoặc mở tay tại đây.'
              : `Máy HAC sẽ tự mở và gửi email mời lúc 15:00 ${friday}. Cần mở sớm hơn thì bấm nút bên cạnh.`}{' '}
          Mở tay <strong>không gửi email</strong>; hạn trả lời vẫn là 12:00 thứ 2 tuần sau.
        </p>
      </div>
      <button
        onClick={onOpen}
        disabled={busy !== null}
        className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary text-label-md hover:bg-primary-dark disabled:opacity-50 transition-colors"
      >
        <span className={`material-symbols-outlined text-[18px] ${busy === 'open' ? 'animate-spin' : ''}`}>
          {busy === 'open' ? 'progress_activity' : 'play_circle'}
        </span>
        {busy === 'open' ? 'Đang mở...' : 'Mở khảo sát tuần này'}
      </button>
    </div>
  );
}

/** Thẻ trạng thái tuần đang xem + gia hạn / đóng ngay. */
function WeekStatusCard({
  week,
  now,
  busy,
  delivery,
  onExtend,
  onCloseNow,
}: {
  week: SurveyWeekDoc;
  now: Date;
  busy: SurveyBusy;
  /** Số người theo tình trạng thư mời (danh sách mời); null = chưa đọc được. */
  delivery: DeliveryCounts | null;
  onExtend: (weekId: string, until: Date) => void;
  onCloseNow: (weekId: string) => void;
}) {
  const phase = phaseOf(week, now);
  const ui = PHASE_UI[phase];
  const openMs = toMillis(week.opensAt);
  const closeMs = toMillis(week.closesAt);
  const email = describeEmail(week, now, delivery);
  // Gợi ý sẵn: hạn hiện tại nếu còn ở tương lai — gợi ý hạn cũ trong quá khứ
  // thì bấm "Mở lại" chỉ ra lỗi. Tuần đã đóng thì gợi ý hạn mặc định (12:00 thứ
  // 2 sau) nếu còn kịp: hạn đó sau 15:00 thứ 6 nên mở lại vẫn được máy HAC gửi
  // email mời (gợi ý "24 giờ tới" vào thứ 5 lại rơi trước giờ gửi). Không thì
  // 24 giờ tới, tròn giờ.
  const [extendValue, setExtendValue] = useState(() => {
    const t = now.getTime();
    const base = closeMs ?? Date.parse(surveyClosesAt(week.id));
    if (base > t) return toVnInput(base);
    const def = Date.parse(surveyClosesAt(week.id));
    if (def > t) return toVnInput(def);
    return toVnInput(Math.ceil((t + 86_400_000) / 3_600_000) * 3_600_000);
  });
  const [hint, setHint] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Hạn mới đã hợp lệ nhưng có hệ quả cần xác nhận (rút ngắn hạn, mất email mời).
  const [pendingExtend, setPendingExtend] = useState<{ until: Date; warnings: string[] } | null>(null);

  // Agent kiểm hạn trả lời TRƯỚC khi gửi (decideWeek -> 'closed'): tuần đã đóng
  // thì không gửi email mời, cũng không gửi nốt cho người bị lỗi. "Đóng ngay"
  // hay hạn mới trước 15:00 thứ 6 vì thế lặng lẽ huỷ luôn email — phải nói ra.
  const emailStatus = week.email?.status;
  const { sendAt } = inviteSchedule(week.id);
  // Cảnh báo theo đúng nhóm còn thiếu: người gửi lỗi thì máy HAC hết gửi nốt;
  // người "không rõ đã nhận" thì hết đường gửi lại (lệnh --force cũng không gửi
  // cho khảo sát đã đóng).
  const closeWarning = (() => {
    if (!emailStatus) return 'Email mời tuần này chưa được gửi — sau khi đóng, máy HAC sẽ KHÔNG gửi nữa.';
    if (emailStatus !== 'partial' && emailStatus !== 'error') return null;
    const c = emailCounts(week.email!, delivery);
    const parts = [
      c.failed > 0 ? `Còn ${c.failed} người chưa nhận được email mời (gửi lỗi) — sau khi đóng, máy HAC không gửi nốt cho họ, chạy tay cũng không.` : '',
      c.uncertain > 0 ? `${c.uncertain} người không rõ đã nhận email mời — sau khi đóng, không gửi lại cho họ được nữa (kể cả lệnh --force).` : '',
    ].filter(Boolean);
    if (parts.length) return parts.join(' ');
    // Danh sách mời cho thấy mọi người đã nhận (trạng thái chưa kịp cập nhật).
    return delivery ? null : 'Còn người chưa nhận được email mời — sau khi đóng, máy HAC sẽ không gửi nốt.';
  })();

  const submitExtend = () => {
    setHint(null);
    setPendingExtend(null);
    const until = parseVnInput(extendValue);
    const t = now.getTime();
    if (!until) return setHint('Thầy/Cô chọn ngày và giờ của hạn mới.');
    if (until.getTime() <= t) return setHint('Hạn mới phải sau thời điểm hiện tại.');
    if (openMs !== null && until.getTime() <= openMs) return setHint('Hạn mới phải sau lúc mở khảo sát.');
    if (until.getTime() > t + MAX_EXTEND_DAYS * 86_400_000) {
      return setHint(`Chỉ đặt hạn trong vòng ${MAX_EXTEND_DAYS} ngày tới — Thầy/Cô kiểm tra lại ngày, tháng, năm đã chọn.`);
    }
    if (closeMs !== null && Math.abs(until.getTime() - closeMs) < 60_000) return setHint('Hạn mới đang trùng hạn hiện tại.');
    const warnings: string[] = [];
    // Nút tên "Gia hạn" mà chọn nhầm ngày sớm hơn là khảo sát đóng sớm — "Đóng
    // ngay" có xác nhận thì rút ngắn hạn cũng phải có.
    if (phase !== 'closed' && closeMs !== null && until.getTime() < closeMs) {
      warnings.push(`Hạn mới (${fmtVn(until)}) SỚM hơn hạn hiện tại (${fmtVn(closeMs)}) — khảo sát sẽ đóng sớm hơn.`);
    }
    if (!emailStatus && until.getTime() <= sendAt) {
      warnings.push('Hạn mới trước 15:00 thứ 6 nên máy HAC sẽ KHÔNG gửi email mời tuần này.');
    }
    if (warnings.length) return setPendingExtend({ until, warnings });
    onExtend(week.id, until);
  };

  const field = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-0.5 min-w-0">
      <dt className="text-label-sm text-on-surface-variant uppercase">{label}</dt>
      <dd className="text-body-md text-on-surface tabular break-words">{value}</dd>
    </div>
  );

  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-md flex flex-col gap-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label-lg text-on-surface">
          Tuần {formatDayLabel(week.id)} – {formatDayLabel(shiftDate(week.id, 4))}/{shiftDate(week.id, 4).slice(0, 4)}
        </span>
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-label-md ${ui.cls}`}>
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{ui.icon}</span>
          {ui.label}
        </span>
        {phase === 'open' && closeMs !== null && (
          <span className="text-body-sm text-on-surface-variant">· còn {spanLabel(closeMs - now.getTime())} để trả lời</span>
        )}
        {phase === 'scheduled' && openMs !== null && (
          <span className="text-body-sm text-on-surface-variant">· mở sau {spanLabel(openMs - now.getTime())}</span>
        )}
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-lg gap-y-sm">
        {field('Mở lúc', fmtVn(week.opensAt) || '—')}
        {field(phase === 'closed' ? 'Đã đóng lúc' : 'Hạn trả lời', fmtVn(week.closesAt) || '—')}
        {field('Người mở', !week.openedBy ? '—' : week.openedBy === 'agent' ? 'Máy HAC (tự động)' : week.openedBy)}
        {/* Dòng riêng, đủ rộng: lý do lỗi gửi thư có thể dài. */}
        <div className="sm:col-span-2 lg:col-span-3 flex flex-col gap-0.5 min-w-0">
          <dt className="text-label-sm text-on-surface-variant uppercase">Email mời</dt>
          <dd className="min-w-0">
            <div className={`w-fit max-w-full px-2.5 py-1.5 rounded-md text-body-sm break-words flex flex-col gap-1 ${TONE_CLASS[email.tone]}`}>
              <p>{email.text}</p>
              {email.note && (
                <p>
                  <span className="font-semibold">Ghi chú từ máy HAC:</span> {email.note}
                </p>
              )}
              {email.notice && <p>{email.notice}</p>}
              {email.steps?.map(step => (
                <p key={step.text}>
                  {step.text}
                  {step.command && (
                    <code className="block w-fit max-w-full mt-1 px-1.5 py-0.5 rounded bg-surface-container-lowest/80 text-on-surface font-mono text-[12px] break-all select-all">
                      {step.command}
                    </code>
                  )}
                </p>
              ))}
            </div>
          </dd>
        </div>
      </dl>

      {typeof week.version === 'number' && week.version !== SURVEY_VERSION && (
        <p className="text-body-sm text-on-warning-container bg-warning-container rounded-lg p-sm">
          Tuần này dùng bộ câu hỏi phiên bản {week.version}; kết quả bên dưới hiện theo bộ câu hỏi hiện tại (phiên bản{' '}
          {SURVEY_VERSION}). Đáp án không còn trong bộ hiện tại sẽ không được đếm.
        </p>
      )}

      {phase === 'none' ? (
        <p className="text-body-sm text-on-surface-variant">Tuần này không mở khảo sát nên không có phản hồi.</p>
      ) : (
        <div className="flex flex-col lg:flex-row lg:items-end gap-md border-t border-outline-variant pt-md">
          <div className="flex flex-col gap-1 min-w-0">
            <label htmlFor={`survey-extend-${week.id}`} className="text-label-sm text-on-surface-variant uppercase">
              {phase === 'closed' ? 'Mở lại đến' : 'Gia hạn đến'} (giờ Việt Nam)
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id={`survey-extend-${week.id}`}
                type="datetime-local"
                value={extendValue}
                onChange={e => { setExtendValue(e.target.value); setHint(null); setPendingExtend(null); }}
                className="bg-surface-container-lowest border border-outline-variant focus:border-primary focus:ring-1 focus:ring-primary rounded-lg px-3 py-2 text-body-md outline-none tabular"
              />
              <button
                onClick={submitExtend}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary text-label-md hover:bg-primary-dark disabled:opacity-50 transition-colors"
              >
                <span className={`material-symbols-outlined text-[18px] ${busy === 'extend' ? 'animate-spin' : ''}`}>
                  {busy === 'extend' ? 'progress_activity' : 'event_repeat'}
                </span>
                {phase === 'closed' ? 'Mở lại' : 'Gia hạn'}
              </button>
            </div>
            {hint && <p className="text-body-sm text-error" role="alert">{hint}</p>}
            {pendingExtend && (
              <div
                className="mt-1 flex flex-col gap-2 p-sm rounded-lg bg-warning-container text-on-warning-container max-w-[560px]"
                role="alertdialog"
                aria-label="Xác nhận đặt hạn trả lời mới"
              >
                <ul className="text-body-sm flex flex-col gap-1 list-disc pl-5">
                  {pendingExtend.warnings.map(w => <li key={w}>{w}</li>)}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => { const { until } = pendingExtend; setPendingExtend(null); onExtend(week.id, until); }}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-md hover:bg-primary-dark disabled:opacity-50 transition-colors"
                  >
                    Vẫn đặt hạn này
                  </button>
                  <button
                    onClick={() => setPendingExtend(null)}
                    className="px-3 py-1.5 rounded-lg bg-surface-container-lowest text-on-surface text-label-md hover:bg-surface-container transition-colors"
                  >
                    Hủy
                  </button>
                </div>
              </div>
            )}
          </div>

          {phase === 'open' && (
            <div className="lg:ml-auto">
              {confirmClose ? (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-sm rounded-lg bg-error-container text-on-error-container" role="alertdialog" aria-label="Xác nhận đóng khảo sát">
                  <span className="text-body-sm">
                    Đóng khảo sát ngay? Sau khi đóng, CBGV-NV không gửi hay sửa được câu trả lời nữa.
                    {closeWarning && <strong className="block mt-1">{closeWarning}</strong>}
                  </span>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => { setConfirmClose(false); onCloseNow(week.id); }}
                      disabled={busy !== null}
                      className="px-3 py-1.5 rounded-lg bg-error text-on-error text-label-md hover:bg-error-dark disabled:opacity-50 transition-colors"
                    >
                      Xác nhận đóng
                    </button>
                    <button
                      onClick={() => setConfirmClose(false)}
                      className="px-3 py-1.5 rounded-lg bg-surface-container-lowest text-on-surface text-label-md hover:bg-surface-container transition-colors"
                    >
                      Hủy
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClose(true)}
                  disabled={busy !== null}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-error/40 text-error text-label-md hover:bg-error-container disabled:opacity-50 transition-colors"
                >
                  <span className={`material-symbols-outlined text-[18px] ${busy === 'close' ? 'animate-spin' : ''}`}>
                    {busy === 'close' ? 'progress_activity' : 'lock'}
                  </span>
                  Đóng ngay
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Số liệu, biểu đồ, ý kiến và danh sách chưa trả lời của một tuần. */
function WeekResults({
  week,
  detail,
  now,
}: {
  week: SurveyWeekDoc;
  detail: Extract<SurveyDetail, { status: 'ready' }>;
  now: Date;
}) {
  const { responses, invited, invitedError } = detail;
  const stats = useMemo(() => summarizeChoices(responses), [responses]);
  const rate = useMemo(() => responseRate(responses, invited), [responses, invited]);
  const phase = phaseOf(week, now);

  const pendingFailed = rate.pending ? rate.pending.filter(p => p.receipt === 'failed').length : 0;
  const pendingUncertain = rate.pending ? rate.pending.filter(p => p.receipt === 'uncertain').length : 0;
  const mixed = rate.failedCount > 0 || rate.uncertainCount > 0;
  const tiles: { label: string; value: string; icon: string; tone: string; sub?: string[] }[] = [
    { label: 'Phản hồi', value: String(responses.length), icon: 'rate_review', tone: 'text-primary' },
    {
      label: 'Được mời',
      value: rate.invitedCount === null ? '—' : String(rate.invitedCount),
      icon: 'mail',
      tone: 'text-primary',
      // Ba nhóm tách riêng: "không rõ đã nhận" có thể đã nhận, "gửi lỗi" thì chắc chắn chưa.
      sub: mixed
        ? [
            `${rate.receivedCount} đã nhận thư`,
            ...(rate.uncertainCount > 0 ? [`${rate.uncertainCount} không rõ đã nhận`] : []),
            ...(rate.failedCount > 0 ? [`${rate.failedCount} chưa nhận (gửi lỗi)`] : []),
          ]
        : undefined,
    },
    {
      label: 'Tỉ lệ trả lời',
      value: rate.rate === null ? '—' : pctText(rate.rate),
      icon: 'percent',
      tone: 'text-tertiary',
      sub: rate.deliveredCount
        ? [
            `${rate.deliveredAnswered}/${rate.deliveredCount} người ${
              rate.uncertainCount > 0 ? 'đã nhận hoặc không rõ đã nhận thư' : rate.failedCount > 0 ? 'đã nhận thư' : 'được mời'
            }`,
          ]
        : rate.invitedCount
          ? ['Chưa ai nhận được thư mời']
          : undefined,
    },
    {
      label: 'Chưa trả lời',
      value: rate.pending === null ? '—' : String(rate.pending.length),
      icon: 'pending',
      tone: rate.pending && rate.pending.length > 0 ? 'text-secondary' : 'text-on-surface-variant',
      sub:
        pendingFailed > 0 || pendingUncertain > 0
          ? [
              ...(pendingFailed > 0 ? [`trong đó ${pendingFailed} chưa nhận thư`] : []),
              ...(pendingUncertain > 0 ? [`${pendingFailed > 0 ? '' : 'trong đó '}${pendingUncertain} không rõ đã nhận thư`] : []),
            ]
          : undefined,
    },
  ];

  return (
    <>
      <section className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
        <div className="p-md border-b border-outline-variant bg-surface-container-low flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-headline-sm text-on-surface uppercase">Kết quả tuần {surveyWeekLabel(week.id)}</h3>
          <span className="text-body-sm text-on-surface-variant tabular">Cập nhật lúc {fmtVn(detail.loadedAt)}</span>
        </div>

        <div className="p-md flex flex-col gap-md">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
            {tiles.map(t => (
              <div key={t.label} className="bg-surface-bright rounded-xl border border-outline-variant p-md flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-label-sm text-on-surface-variant uppercase">{t.label}</span>
                  <span className={`material-symbols-outlined text-[18px] ${t.tone}`} aria-hidden="true">{t.icon}</span>
                </div>
                <span className={`text-headline-md tabular ${t.tone}`}>{t.value}</span>
                {t.label === 'Tỉ lệ trả lời' && rate.rate !== null && (
                  <div className="h-1.5 rounded-full bg-surface-container overflow-hidden" aria-hidden="true">
                    <div className="h-full rounded-full bg-tertiary" style={{ width: `${Math.min(100, rate.rate)}%` }} />
                  </div>
                )}
                {t.sub?.map(line => <span key={line} className="text-body-sm text-on-surface-variant tabular">{line}</span>)}
              </div>
            ))}
          </div>

          {invitedError ? (
            <Note tone="error" icon="error">
              Không đọc được danh sách người được mời, nên chưa tính được tỉ lệ trả lời và danh sách chưa trả lời. Thầy/Cô
              bấm Tải lại; nếu vẫn lỗi, kiểm tra Firestore Rules.
            </Note>
          ) : invited === null ? (
            <Note tone="neutral" icon="info">
              Chưa có danh sách người được mời: khảo sát mở tay và máy HAC chưa gửi email mời (danh sách được ghi khi gửi
              email lúc 15:00 thứ 6). Tạm thời chỉ thống kê được những phản hồi đã có.
            </Note>
          ) : (
            <>
              {rate.failedCount > 0 && (
                <Note tone="warn" icon="mail_lock">
                  {rate.failedCount}/{rate.invitedCount} người trong danh sách mời chưa nhận được thư (gửi lỗi hoặc chưa tới
                  lượt) — xem mục Email mời phía trên. Họ không được tính vào tỉ lệ trả lời
                  {rate.deliveredCount ? ` (tính trên ${rate.deliveredCount} người còn lại)` : ''}; trong danh sách Chưa trả
                  lời, họ có nhãn &quot;Chưa nhận thư&quot;.
                </Note>
              )}
              {rate.uncertainCount > 0 && (
                <Note tone="warn" icon="help">
                  {rate.uncertainCount}/{rate.invitedCount} người KHÔNG RÕ đã nhận thư mời (lần gửi bị lỗi giữa chừng, máy
                  HAC không biết thư đã đi hay chưa) — xem mục Email mời phía trên. Họ vẫn được tính vào tỉ lệ trả lời;{' '}
                  {rate.uncertainAnswered > 0
                    ? `${rate.uncertainAnswered} người trong số này đã trả lời khảo sát (thường là dấu hiệu thư đã tới).`
                    : 'chưa ai trong số này trả lời khảo sát.'}{' '}
                  Nếu thư thật ra chưa tới họ thì tỉ lệ trả lời thật cao hơn số trên. Trong danh sách Chưa trả lời, họ có
                  nhãn &quot;Không rõ đã nhận&quot;.
                </Note>
              )}
              {rate.outside > 0 && (
                <Note tone="neutral" icon="info">
                  Có {rate.outside} phản hồi từ người không nằm trong danh sách mời (ví dụ trả lời khi khảo sát được mở tay
                  trước giờ gửi email, hoặc đăng ký ăn sau giờ gửi). Vẫn được tính vào biểu đồ, không tính vào tỉ lệ trả lời.
                </Note>
              )}
            </>
          )}

          {responses.length === 0 && (
            <Note tone="neutral" icon="hourglass_empty">
              {phase === 'scheduled'
                ? 'Khảo sát chưa mở nên chưa có phản hồi.'
                : 'Chưa có Thầy/Cô nào trả lời khảo sát tuần này.'}
            </Note>
          )}
        </div>
      </section>

      {responses.length > 0 && (
        <section className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
          <div className="p-md border-b border-outline-variant bg-surface-container-low">
            <h3 className="text-headline-sm text-on-surface uppercase">Đánh giá theo từng câu</h3>
            <p className="text-on-surface-variant text-[13px] mt-1">
              Số phiếu và tỉ lệ trên tổng số người trả lời câu đó. Màu: xanh = tốt, xám = bình thường, vàng = cần lưu ý,
              đỏ = chưa tốt.
            </p>
          </div>
          <div className="p-md grid grid-cols-1 md:grid-cols-2 gap-md">
            {stats.map(s => <ChoiceCard key={s.question.id} stat={s} />)}
          </div>
        </section>
      )}

      {responses.length > 0 && <TextAnswers responses={responses} />}

      {rate.pending !== null && <NonResponders pending={rate.pending} />}
    </>
  );
}

function Note({ tone, icon, children }: { tone: keyof typeof TONE_CLASS; icon: string; children: ReactNode }) {
  return (
    <div className={`p-sm rounded-lg text-body-sm flex items-start gap-2 ${TONE_CLASS[tone]}`}>
      <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/** Biểu đồ thanh ngang một câu chọn. Thanh chỉ để nhìn; số và % ghi bằng chữ. */
function ChoiceCard({ stat }: { stat: ChoiceStat }) {
  const headingId = `survey-q-${stat.question.id}`;
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-bright p-md flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h4 id={headingId} className="text-label-lg text-on-surface">{stat.question.label}</h4>
        <span className="text-body-sm text-on-surface-variant tabular shrink-0 whitespace-nowrap">{stat.answered} phiếu</span>
      </div>
      <ul className="flex flex-col gap-2.5" aria-labelledby={headingId}>
        {stat.options.map(o => (
          <li key={o.value} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-body-sm">
              <span className="text-on-surface min-w-0 break-words inline-flex items-baseline gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 self-center ${TONE_BAR[o.tone]}`} aria-hidden="true" />
                {o.label}
              </span>
              <span className="tabular shrink-0 whitespace-nowrap">
                <strong className="text-on-surface">{o.count}</strong>
                <span className="sr-only"> phiếu,</span>
                <span className="text-on-surface-variant"> · {pctText(o.pct)}</span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-surface-container overflow-hidden" aria-hidden="true">
              <div className={`h-full rounded-full ${TONE_BAR[o.tone]}`} style={{ width: `${o.pct}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ba câu trả lời bằng chữ: danh sách kèm họ tên, bộ phận, giờ gửi; có ô tìm. */
function TextAnswers({ responses }: { responses: SurveyResponseDoc[] }) {
  const [tab, setTab] = useState(TEXT_QUESTIONS[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(TEXT_PAGE_SIZE);

  const byQuestion = useMemo(() => {
    const out: Record<string, { key: string; text: string; r: SurveyResponseDoc; at: number | null }[]> = {};
    for (const q of TEXT_QUESTIONS) {
      out[q.id] = responses
        .map(r => ({ key: uidOf(r), text: str(r.answers?.[q.id]).trim(), r, at: answeredAt(r) }))
        .filter(e => e.text)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    }
    return out;
  }, [responses]);

  const entries = byQuestion[tab] || [];
  const needle = fold(search.trim());
  const visible = needle
    ? entries.filter(e => fold(`${e.text} ${str(e.r.fullName)} ${str(e.r.department)}`).includes(needle))
    : entries;

  return (
    <section className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
      <div className="p-md border-b border-outline-variant bg-surface-container-low">
        <h3 className="text-headline-sm text-on-surface uppercase">Ý kiến của Thầy/Cô</h3>
      </div>
      <div className="p-md flex flex-col gap-md">
        {/* Xuống dòng thay vì cuộn ngang: nhãn câu hỏi dài, cuộn ẩn thì trên
            máy tính bảng không ai biết còn tab thứ ba. */}
        <div role="tablist" aria-label="Câu hỏi" className="flex flex-wrap gap-1 p-1 rounded-lg bg-surface-container w-fit max-w-full">
          {TEXT_QUESTIONS.map(q => {
            const active = q.id === tab;
            return (
              <button
                key={q.id}
                role="tab"
                aria-selected={active}
                onClick={() => { setTab(q.id); setShown(TEXT_PAGE_SIZE); }}
                className={`max-w-full text-left px-3 py-1.5 rounded-md text-label-md transition-colors ${
                  active ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                {q.label.replace(/\?$/, '')} <span className="tabular opacity-80">({byQuestion[q.id]?.length || 0})</span>
              </button>
            );
          })}
        </div>

        <div className="relative max-w-[420px]">
          <span className="material-symbols-outlined text-[18px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true">search</span>
          <input
            type="search"
            value={search}
            onChange={e => { setSearch(e.target.value); setShown(TEXT_PAGE_SIZE); }}
            placeholder="Tìm theo nội dung, họ tên hoặc bộ phận..."
            aria-label="Tìm trong ý kiến"
            className="w-full bg-surface border border-outline-variant rounded-lg pl-10 pr-3 py-2 text-body-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>
        {needle && (
          <p className="text-body-sm text-on-surface-variant -mt-2">
            Tìm thấy {visible.length}/{entries.length} ý kiến khớp &quot;{search.trim()}&quot;.
          </p>
        )}

        {visible.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant italic">
            {needle ? 'Không có ý kiến nào khớp.' : 'Chưa có ý kiến nào cho câu này.'}
          </p>
        ) : (
          <ul className="grid grid-cols-1 lg:grid-cols-2 gap-sm">
            {visible.slice(0, shown).map(e => (
              <li key={e.key} className="rounded-lg border border-outline-variant bg-surface-bright p-sm flex flex-col gap-1.5">
                <p className="text-body-md text-on-surface whitespace-pre-line break-words">{e.text}</p>
                <p className="text-body-sm text-on-surface-variant break-words">
                  <span className="font-semibold text-on-surface">{str(e.r.fullName) || 'Chưa khai họ tên'}</span>
                  {' · '}{deptOf(e.r.department)}
                  {e.at !== null && <span className="tabular"> · {fmtVn(e.at)}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}

        {visible.length > shown && (
          <button
            onClick={() => setShown(n => n + TEXT_PAGE_SIZE)}
            className="self-start inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-outline-variant text-label-md text-on-surface hover:bg-surface-container transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">expand_more</span>
            Xem thêm ({visible.length - shown} ý kiến)
          </button>
        )}
      </div>
    </section>
  );
}

/** Người được mời mà chưa trả lời, nhóm theo bộ phận. */
function NonResponders({ pending }: { pending: SurveyInvitee[] }) {
  const groups = useMemo(() => groupByDepartment(pending), [pending]);
  const failed = pending.filter(p => p.receipt === 'failed').length;
  const uncertain = pending.filter(p => p.receipt === 'uncertain').length;
  // Ít người thì mở sẵn cả, nhiều thì thu gọn để trang không dài cả mét.
  const openAll = pending.length <= 40;
  const labels = [
    failed > 0 ? `${failed} người có nhãn "Chưa nhận thư" vì thư mời chưa tới được` : '',
    uncertain > 0 ? `${uncertain} người có nhãn "Không rõ đã nhận" vì không biết thư đã tới họ chưa` : '',
  ].filter(Boolean);
  return (
    <section className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
      <div className="p-md border-b border-outline-variant bg-surface-container-low flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-headline-sm text-on-surface uppercase">Chưa trả lời ({pending.length})</h3>
        <span className="text-body-sm text-on-surface-variant">
          {labels.length
            ? `Người trong danh sách mời mà chưa gửi khảo sát, theo bộ phận — ${labels.join('; ')}.`
            : 'Người đã nhận email mời mà chưa gửi khảo sát, theo bộ phận.'}
        </span>
      </div>
      <div className="p-md">
        {pending.length === 0 ? (
          <Note tone="ok" icon="task_alt">Mọi người được mời đều đã trả lời.</Note>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-sm items-start">
            {groups.map(([dept, people]) => (
              <details key={dept} open={openAll} className="group rounded-lg border border-outline-variant bg-surface-bright">
                <summary className="cursor-pointer list-none p-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-on-surface-variant transition-transform group-open:rotate-90" aria-hidden="true">
                    chevron_right
                  </span>
                  <span className="text-label-lg text-on-surface flex-1 min-w-0 break-words">{dept}</span>
                  <span className="text-label-md tabular px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container">
                    {people.length}
                  </span>
                </summary>
                <ul className="px-sm pb-sm flex flex-col divide-y divide-outline-variant">
                  {people.map(p => (
                    <li key={p.uid} className="py-1.5 flex flex-col min-w-0">
                      <span className="text-body-md text-on-surface flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {p.fullName || 'Chưa khai họ tên'}
                        {/* Người chưa nhận (hay không rõ đã nhận) thư thì đừng nhắc
                            như người lơ là khảo sát. Hai nhãn khác màu: "không rõ"
                            có thể đã nhận, "chưa nhận thư" thì chắc chắn chưa. */}
                        {p.receipt === 'failed' && (
                          <span className="px-1.5 py-0.5 rounded text-label-sm bg-warning-container text-on-warning-container whitespace-nowrap">
                            Chưa nhận thư
                          </span>
                        )}
                        {p.receipt === 'uncertain' && (
                          <span className="px-1.5 py-0.5 rounded text-label-sm bg-surface-container-high text-on-surface-variant border border-outline-variant whitespace-nowrap">
                            Không rõ đã nhận
                          </span>
                        )}
                      </span>
                      {p.email && <span className="text-body-sm text-on-surface-variant break-all">{p.email}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Bảng xu hướng các tuần gần nhất. */
function TrendTable({
  trend,
  now,
  weeks,
  selectedWeekId,
  onSelectWeek,
  onReload,
}: {
  trend: SurveyTrend;
  now: Date;
  weeks: SurveyWeekDoc[];
  selectedWeekId: string | null;
  onSelectWeek: (weekId: string) => void;
  onReload: () => void;
}) {
  const perWeek = 1 + TREND_METRICS.length;
  return (
    <section className="bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant overflow-hidden">
      <div className="p-md border-b border-outline-variant bg-surface-container-low flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-headline-sm text-on-surface uppercase">Xu hướng {TREND_WEEKS} tuần gần nhất</h3>
          <p className="text-on-surface-variant text-[13px] mt-1">
            Số liệu được <strong>đếm trực tiếp trên máy chủ</strong>, không tải từng phản hồi về máy: mỗi tuần {perWeek} phép
            đếm, mỗi phép tính 1 lượt đọc Firestore cho mỗi 1.000 phản hồi — cả bảng chỉ khoảng {TREND_WEEKS * perWeek} lượt
            đọc. Chỉ lấy {TREND_WEEKS} tuần gần nhất đã mở để giữ số lượt đọc nhỏ.
          </p>
        </div>
        <button
          onClick={onReload}
          disabled={trend.status === 'loading'}
          className="shrink-0 inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-outline-variant text-label-md text-on-surface hover:bg-surface-container disabled:opacity-50 transition-colors"
        >
          <span className={`material-symbols-outlined text-[18px] ${trend.status === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true">
            {trend.status === 'loading' ? 'progress_activity' : 'refresh'}
          </span>
          Đếm lại
        </button>
      </div>

      {trend.status === 'error' && (
        <div className="m-md">
          <Note tone="error" icon="error">Không đếm được số liệu xu hướng. {trend.message}</Note>
        </div>
      )}

      {trend.status === 'loading' && trend.rows.length === 0 && (
        <p className="p-md text-body-sm text-on-surface-variant flex items-center gap-2" aria-live="polite">
          <span className="material-symbols-outlined text-[18px] animate-spin" aria-hidden="true">progress_activity</span>
          Đang đếm...
        </p>
      )}

      {trend.status === 'ready' && trend.rows.length === 0 && (
        <p className="p-md text-body-sm text-on-surface-variant italic">Chưa có tuần nào đã mở khảo sát.</p>
      )}

      {trend.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-body-sm min-w-[560px]">
            <caption className="sr-only">Số phản hồi và tỉ lệ đánh giá tốt theo tuần</caption>
            <thead className="bg-surface-container-low text-on-surface-variant text-label-sm uppercase">
              <tr>
                <th scope="col" className="p-sm">Tuần</th>
                <th scope="col" className="p-sm text-right">Phản hồi</th>
                {TREND_METRICS.map(m => (
                  <th key={m.key} scope="col" className="p-sm">% {m.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {trend.rows.map(row => {
                const w = weeks.find(x => x.id === row.weekId);
                const isOpen = !!w && phaseOf(w, now) === 'open';
                const isSelected = row.weekId === selectedWeekId;
                return (
                  <tr key={row.weekId} className={isSelected ? 'bg-primary-container/20' : 'hover:bg-surface-container-low'}>
                    <th scope="row" className="p-sm font-normal">
                      <button
                        onClick={() => onSelectWeek(row.weekId)}
                        className="text-primary font-semibold hover:underline tabular text-left"
                        title="Xem chi tiết tuần này"
                      >
                        {surveyWeekLabel(row.weekId)}
                      </button>
                      {isOpen && (
                        <span className="ml-2 px-2 py-0.5 rounded-full text-label-sm bg-tertiary-container text-on-tertiary-container whitespace-nowrap">
                          đang mở
                        </span>
                      )}
                    </th>
                    <td className="p-sm text-right tabular font-semibold">{row.responses}</td>
                    {TREND_METRICS.map(m => {
                      const v = row.responses ? ((row.counts[m.key] || 0) / row.responses) * 100 : null;
                      return (
                        <td key={m.key} className="p-sm">
                          {v === null ? (
                            <span className="text-on-surface-variant">—</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              {/* w-12: đủ chỗ cho dạng có số lẻ như ">99,9%" của pctText. */}
                              <span className="tabular w-12 text-right shrink-0 whitespace-nowrap">{pctText(v)}</span>
                              <div className="h-1.5 flex-1 min-w-[48px] max-w-[120px] rounded-full bg-surface-container overflow-hidden" aria-hidden="true">
                                <div className="h-full rounded-full bg-tertiary" style={{ width: `${v}%` }} />
                              </div>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
