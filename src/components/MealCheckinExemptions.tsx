import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { collection, doc, getDoc, onSnapshot, runTransaction, type Transaction } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { addDays } from '../../agent/lib/common.mjs';
import { formatDate, vnParts, vnToday } from '../../agent/lib/meal-rules.mjs';
import { exemptionCovers, exemptionQuarantine, validateStoredCheckinExemption } from '../../agent/lib/checkin-exemptions.mjs';
import { agentSupports, EXEMPTION_AGENT_VERSION } from '../lib/agentFeatures';
import { invalidateCheckinExemptionCache } from './MealReconciliation';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import {
  changeExemptionEmail, createExemptionHints, createExemptionTemplate, describeExemptionPeriod, describeIgnoredRows,
  describeIssueRemoval, endDateMinimum, EXEMPTION_MEAL_NAME, EXEMPTION_MEALS, exemptionDraft, exemptionErrorMessage,
  exemptionState, formatMonthLabel, MAX_EXEMPTION_FILE_SIZE, MAX_EXEMPTION_IMPORT, MAX_TRANSACTION_WRITES, mealsLabel,
  mealStarted, openEndedMeals, parseExemptionWorkbook, planExemptionRow, planExemptionSave, planExemptionStop,
  prepareExemptionAutoFix, readExemptionWorkbook, readStoredExemptions, sameExemptionRecord, setExemptionEndDate,
  stopExemptionToday, stoppableMeals, validateExemptionPeriod,
  type ExemptionClock, type ExemptionHint, type ExemptionHintKind, type ExemptionMeal, type ExemptionPeriod,
  type ExemptionPlan, type ExemptionPlanRow, type ExemptionPreview, type ExemptionRecord, type ExemptionSaveMode,
  type ExemptionStopPlan, type RegistrationIdentity, type StoredExemptionIssue, type StoredExemptions,
} from '../lib/checkinExemptionImport';

const COLLECTION = 'meal_checkin_exemptions';
const INPUT = 'w-full min-h-11 rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50';
const BUTTON = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-outline-variant px-4 py-2 text-label-lg text-primary hover:bg-primary-container/40 disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-primary bg-primary px-4 py-2 text-label-lg text-on-primary hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50';
const DANGER = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-error/30 px-4 py-2 text-label-lg text-error hover:bg-error-container/40 disabled:cursor-not-allowed disabled:opacity-50';
const CHIP = 'rounded-full px-2 py-1 text-label-sm';
const WARNING_NOTE = 'rounded-lg bg-warning-container/60 px-2 py-1 text-on-warning-container';
const STATE_LABEL = { active: 'Đang miễn chấm', future: 'Sắp có hiệu lực', ended: 'Đã kết thúc' };
const STATE_STYLE = {
  active: 'bg-green-50 text-green-800',
  future: 'bg-primary-container/50 text-primary',
  ended: 'bg-surface-container text-on-surface-variant',
};
const MEAL_SELECTIONS: Record<string, ExemptionMeal[]> = {
  lunch: ['lunch'],
  breakfast: ['breakfast'],
  both: ['breakfast', 'lunch'],
};
const SHORT_MEAL: Record<ExemptionMeal, string> = { breakfast: 'sáng', lunch: 'trưa' };
const SAVE_MODES: { value: ExemptionSaveMode; label: string; hint: string }[] = [
  { value: 'merge', label: 'Gộp thêm thời hạn', hint: 'Giữ các khoảng đã có và nối thêm khoảng mới.' },
  { value: 'replace', label: 'Thay thời hạn từ ngày bắt đầu',
    hint: 'Giữ các ngày trước ngày bắt đầu; từ ngày bắt đầu trở đi chỉ còn đúng khoảng mới.' },
];
const PLAN_STYLE: Record<ExemptionPlanRow['status'], string> = {
  new: 'bg-primary-container text-on-primary-container',
  changed: 'bg-tertiary-container text-on-tertiary-container',
  unchanged: 'bg-surface-container text-on-surface-variant',
  error: 'bg-error-container text-error',
};
const HINT_STYLE: Record<ExemptionHintKind, string> = {
  matched: 'bg-green-50 text-green-800',
  noRegistration: 'bg-surface-container text-on-surface-variant',
  registrationEmail: 'bg-warning-container text-on-warning-container',
  emailTaken: 'bg-warning-container text-on-warning-container',
};
const BLOCKED_BY_ISSUE = 'Mã này đang có bản ghi cần kiểm tra. Xử lý ở mục “Bản ghi cần kiểm tra” rồi lưu lại.';
const SESSION_ENDED = 'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const displayName = (record: ExemptionRecord) => record.fullName || record.employeeId;
const modeLabel = (mode: ExemptionSaveMode) => SAVE_MODES.find(item => item.value === mode)?.label ?? '';
const describeDraftPeriod = (meals: ExemptionMeal[], from: string, to: string | null) =>
  `${capitalize(mealsLabel(meals))} · từ ${formatDate(from)}${to ? ` đến hết ${formatDate(to)}` : ', chưa có ngày kết thúc'}`;
/** So khớp tìm kiếm theo dạng dựng sẵn (NFC) và không phân biệt hoa thường. */
const searchText = (text: string) => text.normalize('NFC').toLowerCase();
const unidentifiedAlert = (count: number) => `Có ${count} bản ghi lỗi không rõ mã nhân viên: agent đang tạm dừng toàn bộ `
  + 'email cảnh báo thiếu chấm và tab Đối soát chưa kết luận được ai thiếu chấm cho tới khi xóa hoặc sửa '
  + `${count === 1 ? 'bản ghi này' : 'các bản ghi này'}.`;

/** "khoảng miễn bữa trưa từ 01/12/2026" / "2 khoảng miễn bữa trưa sắp tới (từ 01/12/2026)" */
function upcomingLabel(periods: ExemptionPeriod[], mealName: string) {
  const [first] = periods;
  if (periods.length > 1) return `${periods.length} khoảng miễn ${mealName} sắp tới (từ ${formatDate(first.from)})`;
  return `khoảng miễn ${mealName} từ ${formatDate(first.from)}${first.to ? ` đến hết ${formatDate(first.to)}` : ''}`;
}

/** Câu hỏi lại trước khi ngừng miễn một bữa, theo đúng tác dụng của thao tác. */
function stopQuestion(stop: ExemptionStopPlan, mealName: string, name: string) {
  const head = stop.upcoming
    ? [`Hủy ${upcomingLabel(stop.upcoming, mealName)} của ${name}?`,
      `Từ ngày ${formatDate(stop.upcoming[0].from)}, nhân viên vẫn phải chấm ${mealName} như bình thường.`]
    : [`Ngừng miễn chấm ${mealName} cho ${name}?`, `Từ ngày ${formatDate(stop.effective)}, nhân viên phải chấm ${mealName}.`];
  return [
    ...head,
    stop.keepsToday
      ? stop.upcoming ? `Hôm nay vẫn được miễn ${mealName}.` : `${capitalize(mealName)} hôm nay đã bắt đầu nên hôm nay vẫn được miễn.`
      : '',
    stop.keepsPast ? 'Các ngày đã miễn trước đó vẫn được giữ.' : '',
  ].filter(Boolean).join('\n');
}

const stopDone = (stop: ExemptionStopPlan, mealName: string, name: string) => stop.upcoming
  ? `Đã hủy ${upcomingLabel(stop.upcoming, mealName)} của ${name}.`
  : `Đã ngừng miễn chấm ${mealName} cho ${name}. Từ ngày ${formatDate(stop.effective)}, nhân viên phải chấm ${mealName}.`;

/** Giờ Việt Nam lúc thao tác — đọc lại ngay trong transaction, không dùng giá trị lúc vẽ trang. */
const readClock = (): ExemptionClock => {
  const parts = vnParts();
  return { today: parts?.date ?? vnToday(), now: parts?.time ?? '00:00' };
};

function messageOf(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  switch (code) {
    case '': return exemptionErrorMessage(error, 'Không xử lý được yêu cầu. Vui lòng thử lại.');
    case 'permission-denied':
      return 'Tài khoản chưa có quyền quản lý danh sách miễn chấm ăn. Vui lòng kiểm tra quyền quản trị và Firestore Rules.';
    case 'resource-exhausted':
      return 'Hệ thống đã dùng hết hạn mức đọc/ghi dữ liệu miễn phí trong hôm nay nên chưa lưu được. Vui lòng thử lại sau.';
    case 'unavailable': case 'deadline-exceeded': return 'Chưa kết nối được với hệ thống. Vui lòng thử lại.';
    case 'aborted': case 'failed-precondition': return 'Dữ liệu vừa thay đổi trong lúc lưu. Vui lòng thử lại.';
    case 'unauthenticated': return SESSION_ENDED;
    default: return `Không xử lý được yêu cầu (mã lỗi ${code}). Vui lòng thử lại.`;
  }
}

const isStoredValid = (docId: string, data: unknown) => {
  try { validateStoredCheckinExemption(docId, data); return true; } catch { return false; }
};

/** Bản ghi đang lưu, phải hợp lệ ở dạng chuẩn trước khi sửa. */
async function readValidRecord(transaction: Transaction, employeeId: string) {
  const ref = doc(db, COLLECTION, employeeId);
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists()) throw new Error(`Bản ghi mã ${employeeId} không còn trong danh sách (có thể vừa được xóa).`);
  try {
    return { ref, record: validateStoredCheckinExemption(employeeId, snapshot.data()) as ExemptionRecord };
  } catch (error) {
    throw new Error(`Bản ghi mã ${employeeId} vừa thay đổi và cần kiểm tra lại: ${exemptionErrorMessage(error)}`);
  }
}

const stamp = (uid: string) => ({ updatedAt: new Date().toISOString(), updatedBy: uid });

export type AgentStatus =
  | { state: 'checking' } | { state: 'ok' } | { state: 'unknown' } | { state: 'outdated'; version: string };
/** Kết quả của form sửa trong danh sách: lưu xong (đóng form), bỏ ngang (giữ form) hoặc lỗi (hiện ngay trong form). */
export type ExemptionFormResult = { ok: true } | { ok: false; error?: string };
export interface ExemptionPreviewState extends ExemptionPreview {
  source: string;
  kind: 'manual' | 'file';
  meals: ExemptionMeal[];
  from: string;
  to: string | null;
}
type HintsFor = ((record: { employeeId: string; email: string }) => ExemptionHint[]) | null;

function describeAgentVersion(sync: Record<string, unknown> | null) {
  if (!sync) return 'chưa ghi nhận lần đồng bộ nào';
  const version = typeof sync.agentVersion === 'string' ? sync.agentVersion.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return version ? version.slice(0, 40) : 'chưa rõ';
}

/** Cảnh báo khi agent trên máy HAC chưa hiểu danh sách miễn chấm (web và agent triển khai lệch nhau). */
export function ExemptionAgentNotice({ status }: { status: AgentStatus }) {
  if (status.state === 'outdated') {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-container p-md text-on-warning-container">
        <span className="material-symbols-outlined shrink-0" aria-hidden="true">warning</span>
        <p className="text-body-md">
          <strong>Agent trên máy HAC chưa được cập nhật (bản đang chạy: {status.version}).</strong>{' '}
          Email cảnh báo thiếu chấm vẫn gửi cho người trong danh sách cho tới khi cập nhật agent.
        </p>
      </div>
    );
  }
  if (status.state === 'unknown') {
    // Không đọc được settings/checkinSync thì không biết agent đã cập nhật chưa: vẫn phải cảnh báo.
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-container p-md text-on-warning-container">
        <span className="material-symbols-outlined shrink-0" aria-hidden="true">warning</span>
        <p className="text-body-md">
          {`Chưa kiểm tra được phiên bản agent trên máy HAC — nếu agent chưa cập nhật lên ${EXEMPTION_AGENT_VERSION}, `
            + 'email cảnh báo thiếu chấm vẫn gửi cho người trong danh sách.'}
        </p>
      </div>
    );
  }
  return null;
}

function hintLabel(kind: ExemptionHintKind, monthLabel: string) {
  switch (kind) {
    case 'matched': return `Khớp đơn ${monthLabel}`;
    case 'noRegistration': return `Chưa có đơn ${monthLabel}`;
    case 'registrationEmail': return 'Email khác đơn';
    default: return 'Email trùng mã khác';
  }
}

function HintChips({ hints, monthLabel }: { hints: ExemptionHint[]; monthLabel: string }) {
  return (
    <>
      {hints.map(hint => (
        <span key={hint.kind} title={hint.message} className={`${CHIP} ${HINT_STYLE[hint.kind]}`}>
          {hintLabel(hint.kind, monthLabel)}
        </span>
      ))}
    </>
  );
}

function HintDetails({ hints }: { hints: ExemptionHint[] }) {
  const shown = hints.filter(hint => hint.level !== 'ok');
  if (!shown.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-body-sm">
      {shown.map(hint => (
        <li key={hint.kind} className={hint.level === 'warning' ? `${WARNING_NOTE} break-words` : 'text-on-surface-variant break-words'}>
          {hint.message}
        </li>
      ))}
    </ul>
  );
}

function PeriodLines({ title, periods, muted = false }: { title: string; periods: ExemptionRecord['periods']; muted?: boolean }) {
  return (
    <div className={`mt-1 ${muted ? 'text-on-surface-variant/80' : 'text-on-surface-variant'}`}>
      <span className="font-semibold">{title}:</span>
      <ul className="mt-0.5 space-y-0.5 pl-4 list-disc">
        {periods.map(period => <li key={`${period.from}-${period.to}-${period.meals.join('-')}`}>{describeExemptionPeriod(period)}</li>)}
      </ul>
    </div>
  );
}

/** Hộp "Bản ghi cần kiểm tra": tài liệu sai định dạng, kèm lý do và cách xử lý. */
export function ExemptionIssuesPanel({ issues, disabled, onDelete, onFix }: {
  issues: StoredExemptionIssue[];
  disabled: boolean;
  onDelete: (issue: StoredExemptionIssue) => void;
  onFix: (issue: StoredExemptionIssue) => void;
}) {
  if (!issues.length) return null;
  // Cùng quy tắc với agent và tab Đối soát: bản ghi lỗi không nêu được mã nào thì không ai biết chắc được miễn.
  const { unidentified } = exemptionQuarantine(issues);
  return (
    <section aria-labelledby="exemption-issues-title" className="rounded-xl border border-error/25 bg-error-container/20 p-md space-y-3">
      {unidentified > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-error/40 bg-error-container p-md text-on-error-container">
          <span className="material-symbols-outlined shrink-0 text-error" aria-hidden="true">block</span>
          <p className="text-body-md font-semibold">{unidentifiedAlert(unidentified)}</p>
        </div>
      )}
      <div>
        <h3 id="exemption-issues-title" className="flex items-center gap-2 text-title-md font-semibold text-error">
          <span className="material-symbols-outlined" aria-hidden="true">report</span>Bản ghi cần kiểm tra ({issues.length})
        </h3>
        <p className="mt-1 text-body-sm text-on-surface-variant">
          Các bản ghi này sai định dạng nên không được áp dụng; trạng thái miễn chấm của mã liên quan chưa xác định cho tới khi sửa hoặc xóa.
          {unidentified === 0 && ' Các bản ghi hợp lệ khác vẫn dùng bình thường.'}
        </p>
      </div>
      <ul className="divide-y divide-error/15 rounded-xl border border-error/20 bg-surface-container-lowest">
        {issues.map(issue => (
          <li key={issue.docId} className="p-md flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 text-body-sm">
              <p className="font-semibold text-on-surface break-all">
                Tài liệu “{issue.docId}”{issue.employeeId && issue.employeeId !== issue.docId ? ` · mã ${issue.employeeId}` : ''}
              </p>
              <p className="mt-1 text-error break-words">{issue.reason}</p>
              {!issue.codes.length && (
                <p className="mt-1 text-on-surface-variant">Không đọc được mã nhân viên nên chưa biết bản ghi này thuộc về ai.</p>
              )}
              {issue.fix && (
                <p className="mt-1 text-on-surface-variant break-words">
                  Sửa tự động sẽ lưu: mã {issue.fix.employeeId} · {issue.fix.email} · {issue.fix.periods.map(describeExemptionPeriod).join('; ')}
                </p>
              )}
              {issue.fixNote && <p className="mt-1 text-on-surface-variant break-words">{issue.fixNote}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {issue.fix && (
                <button type="button" className={BUTTON} disabled={disabled} onClick={() => onFix(issue)}>Sửa tự động</button>
              )}
              <button type="button" className={DANGER} disabled={disabled} onClick={() => onDelete(issue)}>Xóa bản ghi lỗi</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function planLabel(row: ExemptionPlanRow) {
  if (row.status === 'new') return 'Mới';
  if (row.status === 'unchanged') return 'Không thay đổi';
  if (row.status === 'error') return 'Lỗi';
  return row.periodsChanged ? 'Đổi thời hạn' : 'Đổi họ tên';
}

function PreviewRow({ row, hints, monthLabel, fromFile }: {
  row: ExemptionPlanRow; hints: ExemptionHint[] | null; monthLabel: string; fromFile: boolean;
}) {
  const { draft } = row;
  const shown = row.status === 'unchanged' ? row.before : row.after;
  return (
    <li className="p-md text-body-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-on-surface">{draft.fullName} · {draft.employeeId}</p>
        <span className={`${CHIP} ${PLAN_STYLE[row.status]}`}>{planLabel(row)}</span>
        {hints && <HintChips hints={hints} monthLabel={monthLabel} />}
      </div>
      <p className="mt-1 break-all text-on-surface-variant">{row.row ? `Dòng ${row.row} · ` : ''}{draft.email}</p>
      {row.status === 'error' && <p className="mt-1 text-error break-words">{row.error}</p>}
      {row.status === 'changed' && row.periodsChanged && row.before && <PeriodLines title="Hiện tại" periods={row.before.periods} muted />}
      {shown && (
        <PeriodLines title={row.status === 'unchanged' ? 'Giữ nguyên' : row.before ? 'Sau khi lưu' : 'Sẽ lưu'} periods={shown.periods} />
      )}
      {row.absorbedEnd && (
        <p className={`mt-2 ${WARNING_NOTE}`}>
          Đang miễn không thời hạn — ngày kết thúc {fromFile ? 'trong tệp' : 'vừa chọn'} không được áp dụng; chọn “Thay thời hạn” để đặt lại.
        </p>
      )}
      {row.dropsStartedToday.length > 0 && (
        <p className={`mt-2 ${WARNING_NOTE}`}>
          {capitalize(mealsLabel(row.dropsStartedToday))} hôm nay đã bắt đầu nhưng sẽ hết miễn sau khi lưu — nhân viên có thể nhận email cảnh báo thiếu chấm của hôm nay.
        </p>
      )}
      {hints && <HintDetails hints={hints} />}
    </li>
  );
}

/** Bản xem trước khi lưu: thời hạn SAU KHI LƯU của từng người, tính trên bản ghi đang có. */
export function ExemptionPreviewPanel({ preview, plan, mode, hintsFor, monthLabel, disabled, saving, onSave, onDiscard }: {
  preview: ExemptionPreviewState;
  plan: ExemptionPlan;
  mode: ExemptionSaveMode;
  hintsFor: HintsFor;
  monthLabel: string;
  disabled: boolean;
  saving: boolean;
  onSave: (skipErrors: boolean) => void;
  onDiscard: () => void;
}) {
  const errorCount = preview.errors.length + plan.counts.error;
  const validCount = plan.rows.length - plan.counts.error;
  const fromFile = preview.kind === 'file';
  const ignored = describeIgnoredRows(preview.ignored).trim();
  const skipped = preview.skippedSheets ?? [];
  const hiddenNote = preview.sheetHidden || skipped.some(sheet => sheet.hidden)
    ? ' Sheet ẩn chỉ được thử sau các sheet đang hiện.' : '';
  return (
    <div className="rounded-xl border border-primary/25 overflow-hidden">
      <div className="p-md bg-primary-container/30 space-y-1">
        <h3 className="font-bold text-on-surface break-all">
          Xem trước · {preview.source}
          {preview.sheetName ? ` · sheet “${preview.sheetName}”${preview.sheetHidden ? ' (sheet ẩn)' : ''}` : ''}
        </h3>
        <p className="text-body-sm text-on-surface-variant">
          {describeDraftPeriod(preview.meals, preview.from, preview.to)} · Cách lưu: {modeLabel(mode)}
        </p>
        {preview.headers && (
          <p className="text-body-sm text-on-surface-variant break-words">
            Cột đã nhận: “{preview.headers.employeeId}” → Mã nhân viên · “{preview.headers.email}” → Email · “{preview.headers.fullName}” → Họ tên
          </p>
        )}
        <p className="text-body-sm text-on-surface">
          {plan.counts.new} mới · {plan.counts.changed} thay đổi · {plan.counts.unchanged} không thay đổi · {errorCount} lỗi
          {preview.ignored.length > 0 && ` · ${preview.ignored.length} dòng bỏ qua`}
        </p>
      </div>
      {skipped.length > 0 && (
        <p className="px-md pt-md text-body-sm text-on-surface-variant break-words">
          {`Sheet bỏ qua: ${skipped.map(sheet => `“${sheet.name}” (${sheet.hidden ? 'sheet ẩn — ' : ''}${sheet.reason})`).join('; ')}`
            + hiddenNote}
        </p>
      )}
      {ignored && <p className="px-md pt-md text-body-sm text-on-surface-variant">{ignored}</p>}
      {preview.errors.length > 0 && (
        <div role="alert" className="m-md rounded-xl bg-error-container/30 p-md text-error text-body-sm">
          <p className="font-semibold">{preview.errors.length} dòng lỗi trong tệp. Sửa tệp rồi nhập lại, hoặc chỉ lưu các dòng hợp lệ.</p>
          <ul className="mt-2 list-disc pl-5">
            {preview.errors.slice(0, 10).map((message, index) => <li key={index} className="break-words">{message}</li>)}
          </ul>
          {preview.errors.length > 10 && <p className="mt-2">Còn {preview.errors.length - 10} lỗi khác.</p>}
        </div>
      )}
      {plan.rows.length > 0 && (
        <ol className="max-h-[28rem] overflow-y-auto divide-y divide-outline-variant">
          {plan.rows.map(row => (
            <PreviewRow key={row.draft.employeeId} row={row} monthLabel={monthLabel} fromFile={fromFile}
              hints={hintsFor ? hintsFor(row.draft) : null} />
          ))}
        </ol>
      )}
      <div className="p-md border-t border-outline-variant flex flex-wrap items-center gap-3">
        <button type="button" disabled={disabled || errorCount > 0 || plan.writes === 0} onClick={() => onSave(false)} className={PRIMARY}>
          {saving ? 'Đang lưu…' : `Xác nhận lưu ${validCount} nhân viên`}
        </button>
        {errorCount > 0 && validCount > 0 && (
          <button type="button" disabled={disabled || plan.writes === 0} onClick={() => onSave(true)} className={BUTTON}>
            Lưu {validCount} dòng hợp lệ, bỏ qua {errorCount} dòng lỗi
          </button>
        )}
        <button type="button" disabled={saving} onClick={onDiscard} className={BUTTON}>Bỏ bản xem trước</button>
        {validCount > 0 && plan.writes === 0 && (
          <p className="text-body-sm text-on-surface-variant">Không có thay đổi nào cần lưu.</p>
        )}
      </div>
    </div>
  );
}

function endDateNote(record: ExemptionRecord, meal: ExemptionMeal, minimum: string, clock: ExemptionClock) {
  if (minimum === clock.today && mealStarted(meal, clock.now)) return ` vì ${EXEMPTION_MEAL_NAME[meal]} hôm nay đã bắt đầu`;
  if (minimum === addDays(clock.today, -1)) return ' — chọn ngày này nghĩa là phải chấm lại ngay từ hôm nay';
  return record.periods.some(period => period.to === null && period.from === minimum) ? ' (ngày bắt đầu của khoảng miễn)' : '';
}

export type ExemptionRecordAction = 'stop-breakfast' | 'stop-lunch' | 'end' | 'email' | 'remove';

/**
 * Các mục trong menu "⋯" của một người, theo giờ bữa ăn: chỉ bữa còn ngừng được mới
 * có "Ngừng miễn", chỉ khi còn khoảng chưa có ngày kết thúc mới có "Đặt ngày kết thúc".
 */
export function exemptionRecordActions(record: ExemptionRecord, clock: ExemptionClock) {
  const actions: { key: ExemptionRecordAction; label: string; icon: string; danger?: boolean }[] = [
    ...stoppableMeals(record, clock.today, clock.now).map(meal => ({
      key: `stop-${meal}` as ExemptionRecordAction, label: `Ngừng miễn ${SHORT_MEAL[meal]}`, icon: 'do_not_disturb_on',
    })),
    ...(openEndedMeals(record).length ? [{ key: 'end' as const, label: 'Đặt ngày kết thúc', icon: 'event' }] : []),
    { key: 'email', label: 'Sửa email', icon: 'alternate_email' },
    { key: 'remove', label: 'Xóa khỏi danh sách', icon: 'delete', danger: true },
  ];
  return actions;
}

/** Một người trong danh sách đã lưu, kèm các thao tác sửa. */
export function ExemptionRecordItem({ record, clock, held, hints, monthLabel, disabled, onStop, onSetEnd, onChangeEmail, onRemove }: {
  record: ExemptionRecord;
  clock: ExemptionClock;
  held: boolean;
  hints: ExemptionHint[] | null;
  monthLabel: string;
  disabled: boolean;
  onStop: (record: ExemptionRecord, meal: ExemptionMeal) => void;
  onSetEnd: (record: ExemptionRecord, meal: ExemptionMeal, endDate: string) => Promise<ExemptionFormResult>;
  onChangeEmail: (record: ExemptionRecord, email: string) => Promise<ExemptionFormResult>;
  onRemove: (record: ExemptionRecord) => void;
}) {
  const [editing, setEditing] = useState<null | 'email' | 'end'>(null);
  const [emailDraft, setEmailDraft] = useState(record.email);
  const [endMealChoice, setEndMealChoice] = useState<ExemptionMeal>('lunch');
  const [endDate, setEndDate] = useState('');
  // Lỗi của form đang mở, hiện ngay trong form (không phải ở đầu trang, có thể đang khuất).
  const [formError, setFormError] = useState<string | null>(null);
  const toggle = (form: 'email' | 'end') => { setFormError(null); setEditing(editing === form ? null : form); };
  const close = () => { setFormError(null); setEditing(null); };
  const settle = (result: ExemptionFormResult) => {
    if (result.ok) close();
    else setFormError(result.error ?? null);
  };
  const errorBox = formError && (
    <p role="alert" className="rounded-lg bg-error-container/60 px-3 py-2 text-body-sm text-error break-words">{formError}</p>
  );
  const state = exemptionState(record, clock.today);
  const openMeals = openEndedMeals(record);
  const endMeal = openMeals.includes(endMealChoice) ? endMealChoice : openMeals[0];
  const minimum = endMeal ? endDateMinimum(record, endMeal, clock.today, clock.now) : null;
  const registrationEmails = hints?.find(hint => hint.kind === 'registrationEmail')?.emails ?? [];
  const id = `exemption-${record.employeeId}`;
  const run: Record<ExemptionRecordAction, () => void> = {
    'stop-breakfast': () => onStop(record, 'breakfast'),
    'stop-lunch': () => onStop(record, 'lunch'),
    end: () => toggle('end'),
    email: () => { setEmailDraft(record.email); toggle('email'); },
    remove: () => onRemove(record),
  };
  const actions: ActionMenuItem[] = exemptionRecordActions(record, clock).map(action => ({ ...action, onSelect: run[action.key] }));
  return (
    <li className="p-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-body-md text-on-surface">{displayName(record)}</strong>
            {held
              ? <span className={`${CHIP} bg-error-container text-error`}>Chưa xác định · cần kiểm tra</span>
              : <span className={`${CHIP} ${STATE_STYLE[state]}`}>{STATE_LABEL[state]}</span>}
            {hints && <HintChips hints={hints} monthLabel={monthLabel} />}
          </div>
          <p className="mt-1 text-body-sm text-on-surface-variant break-all">{record.employeeId} · {record.email}</p>
          <ul className="mt-2 space-y-1 text-body-sm text-on-surface-variant">
            {record.periods.map(period => (
              <li key={`${period.from}-${period.to}-${period.meals.join('-')}`}>{describeExemptionPeriod(period)}</li>
            ))}
          </ul>
          {held && (
            <p className="mt-2 text-body-sm text-error">
              Miễn chấm của mã này đang tạm ngưng cho tới khi xóa hoặc sửa bản ghi lỗi cùng mã ở mục “Bản ghi cần kiểm tra”.
              {' '}Trong lúc đó agent chưa gửi email cảnh báo thiếu chấm cho mã này và tab Đối soát ghi “chưa kết luận”.
            </p>
          )}
          {hints && <HintDetails hints={hints} />}
        </div>
        <ActionMenu label={`Thao tác với ${displayName(record)}`} disabled={disabled} items={actions} />
      </div>
      {editing === 'end' && endMeal && (
        <form id={`${id}-end`} className="mt-3 rounded-xl border border-outline-variant bg-surface-container-low/50 p-md space-y-3"
          onSubmit={event => {
            event.preventDefault();
            setFormError(null);
            void onSetEnd(record, endMeal, endDate).then(settle);
          }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {openMeals.length > 1 ? (
              <label className="text-label-md text-on-surface-variant">
                Bữa
                <select value={endMeal} disabled={disabled}
                  onChange={event => { setFormError(null); setEndMealChoice(event.target.value as ExemptionMeal); }}
                  className={`${INPUT} mt-1`}>
                  {openMeals.map(meal => <option key={meal} value={meal}>{capitalize(EXEMPTION_MEAL_NAME[meal])}</option>)}
                </select>
              </label>
            ) : (
              <p className="text-body-sm text-on-surface-variant self-center">
                {capitalize(EXEMPTION_MEAL_NAME[endMeal])} hiện chưa có ngày kết thúc.
              </p>
            )}
            <label className="text-label-md text-on-surface-variant">
              Miễn đến hết ngày
              <input type="date" required value={endDate} min={minimum ?? undefined} disabled={disabled}
                onChange={event => { setFormError(null); setEndDate(event.target.value); }} className={`${INPUT} mt-1`} />
            </label>
          </div>
          {minimum && (
            <p className="text-body-sm text-on-surface-variant">
              Sớm nhất {formatDate(minimum)}{endDateNote(record, endMeal, minimum, clock)}.
            </p>
          )}
          {errorBox}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={disabled || !endDate} className={PRIMARY}>Lưu ngày kết thúc</button>
            <button type="button" onClick={close} className={BUTTON}>Hủy</button>
          </div>
        </form>
      )}
      {editing === 'email' && (
        <form id={`${id}-email`} className="mt-3 rounded-xl border border-outline-variant bg-surface-container-low/50 p-md space-y-3"
          onSubmit={event => {
            event.preventDefault();
            setFormError(null);
            void onChangeEmail(record, emailDraft).then(settle);
          }}>
          <label className="block text-label-md text-on-surface-variant">
            Email nhà trường mới
            <input type="email" required maxLength={254} value={emailDraft} disabled={disabled}
              onChange={event => { setFormError(null); setEmailDraft(event.target.value); }} className={`${INPUT} mt-1`} />
          </label>
          <p className="text-body-sm text-on-surface-variant">
            Các khoảng thời gian giữ nguyên. Miễn chấm chỉ áp dụng khi đơn đăng ký mang đúng mã và email này.
          </p>
          {errorBox}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={disabled} className={PRIMARY}>Lưu email</button>
            {registrationEmails.length === 1 && registrationEmails[0] !== emailDraft.trim().toLowerCase() && (
              <button type="button" onClick={() => { setFormError(null); setEmailDraft(registrationEmails[0]); }}
                className={`${BUTTON} break-all`}>
                Điền email trên đơn: {registrationEmails[0]}
              </button>
            )}
            <button type="button" onClick={close} className={BUTTON}>Hủy</button>
          </div>
        </form>
      )}
    </li>
  );
}

const EMPTY_STORED: StoredExemptions = { records: [], held: new Set(), unidentified: 0, issues: [] };

export default function MealCheckinExemptions({ showToast, registrations, selectedMonth, registrationsReady, registrationsError }: {
  showToast?: (message: string, type: 'success' | 'error') => void;
  /** Đơn đăng ký của tháng đang chọn ở trang quản trị (đã tải sẵn — không đọc thêm Firestore). */
  registrations?: readonly RegistrationIdentity[];
  selectedMonth?: string;
  registrationsReady?: boolean;
  /** Lỗi tải đơn đăng ký của tháng đang chọn: không chờ mãi một danh sách sẽ không tới. */
  registrationsError?: string | null;
}) {
  const month = selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : vnToday().slice(0, 7);
  const monthLabel = formatMonthLabel(month);
  const hintsReady = registrationsReady ?? registrations !== undefined;
  const [stored, setStored] = useState<StoredExemptions>(EMPTY_STORED);
  const [loading, setLoading] = useState(true);
  const [listenError, setListenError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [employeeId, setEmployeeId] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [from, setFrom] = useState(vnToday);
  const [to, setTo] = useState('');
  const [mealSelection, setMealSelection] = useState('lunch');
  const [mode, setMode] = useState<ExemptionSaveMode>('merge');
  const [preview, setPreview] = useState<ExemptionPreviewState | null>(null);
  const [search, setSearch] = useState('');
  const [agent, setAgent] = useState<AgentStatus>({ state: 'checking' });
  const [clock, setClock] = useState(readClock);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const fileRequest = useRef(0);
  // Chỉ lỗi của listener (quyền, mạng) mới khóa thao tác; bản ghi lỗi thì không.
  const loadFailed = listenError !== null;
  // Đã có danh sách để hiện: chưa tải xong hay tải lỗi thì không hiện số đếm "0" hay "chưa có ai".
  const listReady = !loading && !loadFailed;
  const busy = loading || reading || saving;
  const locked = busy || loadFailed;
  const selectedMeals = MEAL_SELECTIONS[mealSelection];

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; fileRequest.current++; };
  }, []);

  // Nhãn "Ngừng miễn", ngày kết thúc sớm nhất... phụ thuộc giờ bữa ăn.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(readClock()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setLoading(true);
    setListenError(null);
    return onSnapshot(collection(db, COLLECTION), snapshot => {
      // Danh sách vừa tải hoặc vừa đổi (kể cả do người khác sửa): tab Đối soát phải đọc lại, không dùng bản đã nhớ.
      invalidateCheckinExemptionCache();
      try {
        // Kiểm tra TỪNG tài liệu: một bản ghi lỗi chỉ vào hộp "Bản ghi cần kiểm tra".
        setStored(readStoredExemptions(snapshot.docs.map(item => ({ id: item.id, data: item.data() }))));
        setListenError(null);
      } catch (failure) {
        setListenError(`Không đọc được danh sách miễn chấm. ${messageOf(failure)}`);
      }
      setLoading(false);
    }, failure => {
      setLoading(false);
      setListenError(messageOf(failure));
    });
  }, [retry]);

  // Một lần đọc settings/checkinSync: agent cũ vẫn gửi cảnh báo thiếu chấm cho người được miễn.
  useEffect(() => {
    let active = true;
    getDoc(doc(db, 'settings', 'checkinSync')).then(snapshot => {
      if (!active) return;
      const sync = snapshot.exists() ? snapshot.data() as Record<string, unknown> : null;
      setAgent(agentSupports(sync, 'checkinExemptions') ? { state: 'ok' } : { state: 'outdated', version: describeAgentVersion(sync) });
    }, () => { if (active) setAgent({ state: 'unknown' }); });
    return () => { active = false; };
  }, []);

  const recordsById = useMemo(() => new Map(stored.records.map(record => [record.employeeId, record])), [stored]);
  // Mọi mã mà bản ghi lỗi nhắc tới (mã tài liệu và mã trong dữ liệu), như agent và tab Đối soát.
  const blocked = useMemo(() => new Map(stored.issues.flatMap(issue =>
    issue.codes.map(code => [code, BLOCKED_BY_ISSUE] as const))), [stored]);
  const plan = useMemo(() => preview
    ? planExemptionSave(preview.records, recordsById, mode, { clock, blocked, rowNumbers: preview.rowNumbers })
    : null, [preview, recordsById, mode, clock, blocked]);
  const hintsFor = useMemo<HintsFor>(() => hintsReady ? createExemptionHints(registrations ?? [], stored.records, month) : null,
    [hintsReady, registrations, stored, month]);

  const clearPreview = () => { setPreview(null); setError(null); setNotice(null); };

  /**
   * Chạy một thao tác ghi: khóa nút, báo kết quả. `inline`: lỗi được trả về để
   * hiện ngay trong form đang mở (kèm thông báo nổi) thay vì ở đầu khung.
   */
  const perform = async (work: (uid: string) => Promise<string>, { inline = false } = {}): Promise<ExemptionFormResult> => {
    const fail = (message: string): ExemptionFormResult => {
      if (mounted.current) { if (!inline) setError(message); showToast?.(message, 'error'); }
      return { ok: false, error: message };
    };
    const user = auth.currentUser;
    if (!user) return fail(SESSION_ENDED);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const message = await work(user.uid);
      invalidateCheckinExemptionCache();
      if (mounted.current) { setNotice(message); showToast?.(message, 'success'); }
      return { ok: true };
    } catch (failure) {
      return fail(messageOf(failure));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  /** Lỗi kiểm tra dữ liệu của form sửa trong danh sách: hiện trong form và báo nổi. */
  const formFailure = (failure: unknown): ExemptionFormResult => {
    const message = messageOf(failure);
    showToast?.(message, 'error');
    return { ok: false, error: message };
  };

  const previewManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked) return;
    try {
      const draft = exemptionDraft(employeeId, email, fullName, from, to || null, selectedMeals);
      setPreview({ records: [draft], errors: [], ignored: [], headers: null, rowNumbers: {}, source: 'Thêm một nhân viên',
        kind: 'manual', meals: selectedMeals, from, to: to || null });
      setError(null);
      setNotice(null);
    } catch (failure) {
      setPreview(null);
      setError(messageOf(failure));
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || locked) return;
    const request = ++fileRequest.current;
    const period = { from, to: to || null, meals: selectedMeals };
    setReading(true);
    setPreview(null);
    setError(null);
    setNotice(null);
    try {
      validateExemptionPeriod(period.from, period.to);
      if (file.size > MAX_EXEMPTION_FILE_SIZE) throw new Error('Chọn tệp Excel hoặc CSV dưới 5 MB.');
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('Tệp cần có định dạng .xlsx, .xls hoặc .csv.');
      const xlsx = await import('xlsx');
      const workbook = readExemptionWorkbook(xlsx, new Uint8Array(await file.arrayBuffer()), file.name);
      const parsed = parseExemptionWorkbook(xlsx, workbook, period.from, period.to, period.meals);
      if (mounted.current && request === fileRequest.current) {
        setPreview({ ...parsed, source: file.name, kind: 'file', ...period });
      }
    } catch (failure) {
      if (mounted.current && request === fileRequest.current) setError(messageOf(failure));
    } finally {
      if (mounted.current && request === fileRequest.current) setReading(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const xlsx = await import('xlsx');
      const url = URL.createObjectURL(new Blob([createExemptionTemplate(xlsx) as BlobPart], { type: XLSX_TYPE }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'Mau-danh-sach-mien-cham-an.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError(messageOf(failure)); }
  };

  const savePreview = async (skipErrors: boolean) => {
    if (locked || !preview || !plan) return;
    const errorCount = preview.errors.length + plan.counts.error;
    if (errorCount > 0 && !skipErrors) return;
    const validCount = plan.rows.length - plan.counts.error;
    const targets = plan.rows.filter(row => row.status === 'new' || row.status === 'changed');
    if (!targets.length) {
      setError(null);
      setNotice('Không có thay đổi nào cần lưu: các nhân viên trong bản xem trước đã có đúng thời hạn này.');
      return;
    }
    if (targets.length > MAX_TRANSACTION_WRITES) { setError(`Mỗi lần lưu tối đa ${MAX_TRANSACTION_WRITES} nhân viên.`); return; }
    const drops = targets.filter(row => row.dropsStartedToday.length > 0).length;
    const question = skipErrors
      ? `Lưu ${validCount} dòng hợp lệ, bỏ qua ${errorCount} dòng lỗi?`
      : `Lưu danh sách miễn chấm cho ${validCount} nhân viên?`;
    const lines = [
      question,
      `${describeDraftPeriod(preview.meals, preview.from, preview.to)} · ${modeLabel(mode)}`,
      `• ${plan.counts.new} người mới`,
      `• ${plan.counts.changed} người thay đổi`,
      `• ${plan.counts.unchanged} người không thay đổi (bỏ qua)`,
      skipErrors ? `• Bỏ qua ${errorCount} dòng lỗi` : '',
      drops ? `• ${drops} người hết miễn bữa đã bắt đầu hôm nay — có thể nhận email cảnh báo thiếu chấm của hôm nay` : '',
    ];
    if (!window.confirm(lines.filter(Boolean).join('\n'))) return;
    const saveMode = mode;
    const saved = preview;
    const result = await perform(async uid => {
      let written = 0;
      await runTransaction(db, async transaction => {
        written = 0;
        const refs = targets.map(row => doc(db, COLLECTION, row.draft.employeeId));
        const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
        const now = readClock();
        const writes = snapshots.flatMap((snapshot, index) => {
          const { draft } = targets[index];
          let before: ExemptionRecord | null = null;
          if (snapshot.exists()) {
            try { before = validateStoredCheckinExemption(draft.employeeId, snapshot.data()) as ExemptionRecord; } catch (failure) {
              throw new Error(`Mã ${draft.employeeId}: bản ghi đã lưu cần kiểm tra (${exemptionErrorMessage(failure)}). `
                + 'Xử lý ở mục “Bản ghi cần kiểm tra” rồi lưu lại.');
            }
          }
          // Tính lại trên dữ liệu mới nhất: người khác có thể vừa sửa bản ghi này.
          const fresh = planExemptionRow(before, draft, saveMode, now);
          if (fresh.status === 'error' || !fresh.after) throw new Error(`Mã ${draft.employeeId}: ${fresh.error}`);
          return fresh.status === 'unchanged' ? [] : [{ ref: refs[index], record: fresh.after }];
        });
        const value = stamp(uid);
        for (const write of writes) transaction.set(write.ref, { ...write.record, ...value });
        written = writes.length;
      });
      const unchanged = plan.rows.length - plan.counts.error - written;
      return `Đã lưu miễn chấm ${mealsLabel(saved.meals)} cho ${written} nhân viên.`
        + (unchanged > 0 ? ` ${unchanged} người không thay đổi.` : '')
        + (skipErrors ? ` Bỏ qua ${errorCount} dòng lỗi.` : '');
    });
    if (result.ok && mounted.current) {
      setPreview(null);
      if (saved.kind === 'manual') { setEmployeeId(''); setEmail(''); setFullName(''); }
    }
  };

  const stopMeal = async (record: ExemptionRecord, meal: ExemptionMeal) => {
    if (locked) return;
    const at = readClock();
    const mealName = EXEMPTION_MEAL_NAME[meal];
    const name = displayName(record);
    if (!window.confirm(stopQuestion(planExemptionStop(record, at.today, meal, at.now), mealName, name))) return;
    await perform(async uid => {
      const applied = await runTransaction(db, async transaction => {
        const { ref, record: current } = await readValidRecord(transaction, record.employeeId);
        // Tính lại trên bản ghi mới nhất và giờ lúc ghi: bữa có thể vừa mở trong lúc hỏi lại.
        const fresh = readClock();
        const next = stopExemptionToday(current, fresh.today, meal, fresh.now);
        if (next && sameExemptionRecord(current, next)) return null;
        if (next) transaction.set(ref, { ...next, ...stamp(uid) });
        else transaction.delete(ref);
        return planExemptionStop(current, fresh.today, meal, fresh.now);
      });
      return applied ? stopDone(applied, mealName, name) : `${name} không còn khoảng miễn ${mealName} nào cần ngừng.`;
    });
  };

  const setEndDate = async (record: ExemptionRecord, meal: ExemptionMeal, endDate: string): Promise<ExemptionFormResult> => {
    if (locked) return { ok: false };
    const at = readClock();
    try { setExemptionEndDate(record, meal, endDate, at.today, at.now); } catch (failure) { return formFailure(failure); }
    const mealName = EXEMPTION_MEAL_NAME[meal];
    const name = displayName(record);
    const effective = formatDate(addDays(endDate, 1));
    if (!window.confirm(`Đặt ngày kết thúc miễn chấm ${mealName} của ${name} là ${formatDate(endDate)}?\n`
      + `Từ ngày ${effective}, nhân viên phải chấm ${mealName}.`)) return { ok: false };
    return perform(async uid => {
      await runTransaction(db, async transaction => {
        const { ref, record: current } = await readValidRecord(transaction, record.employeeId);
        const fresh = readClock();
        transaction.set(ref, { ...setExemptionEndDate(current, meal, endDate, fresh.today, fresh.now), ...stamp(uid) });
      });
      return `Đã đặt ngày kết thúc miễn chấm ${mealName} của ${name} là ${formatDate(endDate)}. Từ ngày ${effective}, nhân viên phải chấm ${mealName}.`;
    }, { inline: true });
  };

  const changeEmail = async (record: ExemptionRecord, nextEmail: string): Promise<ExemptionFormResult> => {
    if (locked) return { ok: false };
    let next: ExemptionRecord;
    try { next = changeExemptionEmail(record, nextEmail); } catch (failure) { return formFailure(failure); }
    if (next.email === record.email) { setError(null); setNotice('Email không thay đổi.'); return { ok: true }; }
    const name = displayName(record);
    const others = stored.records.filter(item => item.email === next.email && item.employeeId !== record.employeeId)
      .map(item => item.employeeId);
    if (!window.confirm([
      `Đổi email miễn chấm của ${name} (${record.employeeId})?`,
      `${record.email} → ${next.email}`,
      others.length ? `Lưu ý: email này đã gắn với mã ${others.join(', ')} trong danh sách.` : '',
      'Các khoảng thời gian miễn chấm giữ nguyên.',
    ].filter(Boolean).join('\n'))) return { ok: false };
    return perform(async uid => {
      await runTransaction(db, async transaction => {
        const { ref, record: current } = await readValidRecord(transaction, record.employeeId);
        transaction.set(ref, { ...changeExemptionEmail(current, nextEmail), ...stamp(uid) });
      });
      return `Đã đổi email miễn chấm của ${name} thành ${next.email}.`;
    }, { inline: true });
  };

  const removeRecord = async (record: ExemptionRecord) => {
    if (locked) return;
    const at = readClock();
    const name = displayName(record);
    const startedToday = EXEMPTION_MEALS.filter(meal => mealStarted(meal, at.now) && exemptionCovers(record, at.today, meal));
    if (!window.confirm([
      `Xóa ${name} (${record.employeeId}) khỏi danh sách miễn chấm?`,
      record.periods.some(period => period.from < at.today)
        ? 'Đối soát và trang cá nhân sẽ không còn ghi nhận miễn chấm cho những ngày đã qua của người này.' : '',
      startedToday.length
        ? `${capitalize(mealsLabel(startedToday))} hôm nay đã bắt đầu: nếu xóa bây giờ, nhân viên có thể nhận email cảnh báo thiếu chấm của hôm nay. Muốn giữ hôm nay, hãy dùng “Ngừng miễn”.`
        : '',
      'Không hoàn tác được.',
    ].filter(Boolean).join('\n'))) return;
    await perform(async () => {
      let existed = true;
      await runTransaction(db, async transaction => {
        const ref = doc(db, COLLECTION, record.employeeId);
        existed = (await transaction.get(ref)).exists();
        if (existed) transaction.delete(ref);
      });
      return existed ? `Đã xóa ${name} khỏi danh sách miễn chấm.` : `${name} đã không còn trong danh sách.`;
    });
  };

  const deleteIssue = async (issue: StoredExemptionIssue) => {
    if (locked) return;
    if (!window.confirm([
      `Xóa bản ghi lỗi “${issue.docId}”${issue.codes.length ? ` (mã ${issue.codes.join(', ')})` : ' (không rõ mã nhân viên)'}?`,
      ...describeIssueRemoval(issue, stored),
      'Không hoàn tác được.',
    ].join('\n'))) return;
    await perform(async () => {
      let existed = true;
      await runTransaction(db, async transaction => {
        const ref = doc(db, COLLECTION, issue.docId);
        const snapshot = await transaction.get(ref);
        existed = snapshot.exists();
        if (!existed) return;
        if (isStoredValid(issue.docId, snapshot.data())) {
          throw new Error(`Bản ghi “${issue.docId}” vừa được sửa và đã hợp lệ nên không xóa. Kiểm tra lại danh sách.`);
        }
        transaction.delete(ref);
      });
      return existed ? `Đã xóa bản ghi lỗi “${issue.docId}”.` : `Bản ghi “${issue.docId}” đã được xóa trước đó.`;
    });
  };

  const autoFix = async (issue: StoredExemptionIssue) => {
    const fix = issue.fix;
    if (locked || !fix) return;
    const moves = fix.employeeId !== issue.docId;
    if (!window.confirm([
      `Sửa tự động bản ghi “${issue.docId}”?`,
      `Sẽ lưu bản ghi chuẩn: mã ${fix.employeeId} · ${fix.email}${fix.fullName ? ` · ${fix.fullName}` : ''}.`,
      moves ? `Bản ghi cũ “${issue.docId}” sẽ được xóa sau khi lưu bản ghi mã ${fix.employeeId}.` : '',
      'Các khoảng thời gian miễn chấm giữ nguyên.',
    ].filter(Boolean).join('\n'))) return;
    await perform(async uid => {
      let savedId: string | null = null;
      await runTransaction(db, async transaction => {
        savedId = null;
        const sourceRef = doc(db, COLLECTION, issue.docId);
        const source = await transaction.get(sourceRef);
        if (!source.exists()) throw new Error(`Bản ghi “${issue.docId}” không còn tồn tại.`);
        if (isStoredValid(issue.docId, source.data())) return;
        const record = prepareExemptionAutoFix(issue.docId, source.data());
        const targetRef = doc(db, COLLECTION, record.employeeId);
        if (record.employeeId !== issue.docId && (await transaction.get(targetRef)).exists()) {
          throw new Error(`Đã có bản ghi mã ${record.employeeId}. Xử lý bản ghi đó trước rồi sửa tự động.`);
        }
        transaction.set(targetRef, { ...record, ...stamp(uid) });
        if (record.employeeId !== issue.docId) transaction.delete(sourceRef);
        savedId = record.employeeId;
      });
      return savedId
        ? `Đã sửa bản ghi “${issue.docId}” thành bản ghi chuẩn mã ${savedId}.`
        : `Bản ghi “${issue.docId}” đã hợp lệ, không cần sửa.`;
    });
  };

  const query = searchText(search.trim());
  const visible = stored.records.filter(record =>
    searchText(`${record.employeeId} ${record.fullName} ${record.email}`).includes(query));
  const activeCount = stored.records.filter(record => !stored.held.has(record.employeeId)
    && exemptionState(record, clock.today) === 'active').length;
  const emptyMessage = query
    ? 'Không có nhân viên khớp với nội dung tìm kiếm.'
    : 'Chưa có nhân viên trong danh sách miễn chấm ăn.';
  const registrationsFailed = !hintsReady && !!registrationsError;

  return (
    <section id="meal-checkin-exemptions" aria-labelledby="meal-checkin-exemption-title" className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
      <div className="p-md sm:p-lg border-b border-outline-variant flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="meal-checkin-exemption-title" className="text-headline-sm text-on-surface font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary" aria-hidden="true">verified_user</span>Miễn chấm ăn theo bữa
          </h2>
          <p className="text-body-sm text-on-surface-variant mt-2">
            Chọn nhân viên, bữa ăn và thời hạn được miễn chấm máy. Mặc định là bữa trưa; bữa sáng vẫn phải chấm.
          </p>
          <p className="text-body-sm text-on-surface-variant mt-1">
            Người trong danh sách vẫn đăng ký suất ăn như thường và không nhận email cảnh báo thiếu chấm cho bữa được miễn.
          </p>
        </div>
        {listReady && (
          <span className="self-start shrink-0 rounded-full bg-primary-container px-3 py-1 text-label-lg text-on-primary-container">
            {activeCount} đang được miễn
          </span>
        )}
      </div>
      <div className="p-md sm:p-lg space-y-5">
        <ExemptionAgentNotice status={agent} />
        {error && (
          <div role="alert" className="rounded-xl border border-error/25 bg-error-container/40 p-3 text-body-sm text-error break-words">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="rounded-xl border border-green-200 bg-green-50 p-3 text-body-sm text-green-800 break-words">
            {notice}
          </div>
        )}
        {loadFailed && (
          <div role="alert" className="flex flex-col gap-3 rounded-xl border border-error/25 bg-error-container/40 p-3 text-body-sm text-error sm:flex-row sm:items-center sm:justify-between">
            <p>{listenError}</p>
            <button type="button" className={`${BUTTON} shrink-0`} onClick={() => setRetry(value => value + 1)}>
              Tải lại danh sách
            </button>
          </div>
        )}
        {!loadFailed && (
          <ExemptionIssuesPanel issues={stored.issues} disabled={locked}
            onDelete={issue => { void deleteIssue(issue); }} onFix={issue => { void autoFix(issue); }} />
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-label-lg text-on-surface">
            Bữa được miễn chấm
            <select
              aria-label="Bữa được miễn chấm ăn"
              value={mealSelection}
              disabled={locked}
              onChange={event => {
                clearPreview();
                setMealSelection(event.target.value);
              }}
              className={`${INPUT} mt-2`}
            >
              <option value="lunch">Bữa trưa</option>
              <option value="breakfast">Bữa sáng</option>
              <option value="both">Cả bữa sáng và bữa trưa</option>
            </select>
          </label>
          <label className="text-label-lg text-on-surface">
            Miễn từ ngày
            <input
              aria-label="Ngày bắt đầu miễn chấm ăn"
              type="date"
              value={from}
              disabled={locked}
              onChange={event => {
                clearPreview();
                setFrom(event.target.value);
              }}
              className={`${INPUT} mt-2`}
            />
          </label>
          <label className="text-label-lg text-on-surface">
            Đến hết ngày <span className="font-normal text-on-surface-variant">· để trống nếu chưa có hạn</span>
            <input
              aria-label="Ngày kết thúc miễn chấm ăn"
              type="date"
              min={from}
              value={to}
              disabled={locked}
              onChange={event => {
                clearPreview();
                setTo(event.target.value);
              }}
              className={`${INPUT} mt-2`}
            />
          </label>
        </div>
        <fieldset className="rounded-xl border border-outline-variant p-md">
          <legend className="px-1 text-label-lg text-on-surface">Khi nhân viên đã có trong danh sách</legend>
          <div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2">
            {SAVE_MODES.map(option => (
              <label key={option.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-surface-container-low">
                <input type="radio" name="exemption-save-mode" value={option.value} checked={mode === option.value}
                  disabled={locked} onChange={() => setMode(option.value)} className="mt-1 h-5 w-5 shrink-0 accent-primary" />
                <span>
                  <span className="block text-body-md text-on-surface">{option.label}</span>
                  <span className="block text-body-sm text-on-surface-variant">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-body-sm text-on-surface-variant">
          Ngày bắt đầu mặc định là hôm nay. Chọn ngày phù hợp để giữ đúng kết quả đối soát những tháng trước.
        </p>
        <form onSubmit={previewManual} className="rounded-xl border border-outline-variant bg-surface-container-low/50 p-md space-y-4">
          <h3 className="text-title-md font-semibold text-on-surface">Thêm một nhân viên</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="text-label-md text-on-surface-variant">
              Mã nhân viên
              <input
                value={employeeId}
                onChange={event => {
                  clearPreview();
                  setEmployeeId(event.target.value);
                }}
                disabled={locked}
                inputMode="numeric"
                maxLength={40}
                required
                className={`${INPUT} mt-1`}
                placeholder="100001"
              />
            </label>
            <label className="text-label-md text-on-surface-variant">
              Email nhà trường
              <input
                type="email"
                value={email}
                onChange={event => {
                  clearPreview();
                  setEmail(event.target.value);
                }}
                disabled={locked}
                maxLength={254}
                required
                className={`${INPUT} mt-1`}
                placeholder="Email @hoangmaistarschool.edu.vn"
              />
            </label>
            <label className="text-label-md text-on-surface-variant">
              Họ tên
              <input
                value={fullName}
                onChange={event => {
                  clearPreview();
                  setFullName(event.target.value);
                }}
                disabled={locked}
                maxLength={160}
                required
                className={`${INPUT} mt-1`}
              />
            </label>
          </div>
          <button type="submit" disabled={locked} className={BUTTON}>
            Xem trước nhân viên
          </button>
        </form>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-title-md font-semibold text-on-surface">Nhập danh sách từ Excel</h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Các cột Mã nhân viên, Email, Họ tên. Tối đa {MAX_EXEMPTION_IMPORT} người/lần.
              {' '}Hỗ trợ .xlsx, .xls và CSV UTF-8 (Excel: Lưu dưới dạng › CSV UTF-8). Dòng không có mã và email (ký tên, ghi chú) được bỏ qua.
            </p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="sr-only"
            aria-label="Chọn danh sách nhân viên miễn chấm ăn"
            disabled={locked}
            onChange={event => { void importFile(event); }}
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={() => { void downloadTemplate(); }} className={BUTTON}>
              <span className="material-symbols-outlined" aria-hidden="true">download</span>
              Tải tệp mẫu
            </button>
            <button type="button" disabled={locked} onClick={() => fileInput.current?.click()} className={BUTTON}>
              <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
              {reading ? 'Đang đọc tệp…' : 'Chọn tệp Excel / CSV'}
            </button>
          </div>
        </div>
        {preview && plan && (
          <ExemptionPreviewPanel preview={preview} plan={plan} mode={mode} hintsFor={hintsFor} monthLabel={monthLabel}
            disabled={locked} saving={saving} onSave={skipErrors => { void savePreview(skipErrors); }} onDiscard={clearPreview} />
        )}
        <div className="border-t border-outline-variant pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-title-md font-semibold text-on-surface">
              Danh sách đã lưu
              {listReady && <span className="font-normal text-on-surface-variant"> ({stored.records.length})</span>}
            </h3>
            <label className="sm:max-w-sm sm:w-full">
              <span className="sr-only">Tìm nhân viên miễn chấm ăn</span>
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                className={INPUT}
                placeholder="Tìm họ tên, mã nhân viên hoặc email…"
              />
            </label>
          </div>
          <p className={`mt-2 text-body-sm ${registrationsFailed ? WARNING_NOTE : 'text-on-surface-variant'}`}>
            {hintsReady
              ? `Đối chiếu đơn đăng ký tháng ${monthLabel}: miễn chấm chỉ áp dụng khi đơn mang đúng mã và email trong danh sách.`
              : registrationsFailed
                ? `Chưa tải được đơn đăng ký tháng ${monthLabel} nên chưa đối chiếu được mã và email.`
                : `Đang tải đơn đăng ký tháng ${monthLabel} để đối chiếu mã và email…`}
          </p>
          {loading && <p className="py-6 text-body-md text-on-surface-variant">Đang tải danh sách…</p>}
          {!loading && loadFailed && <p className="py-6 text-body-md text-error">Chưa tải được danh sách.</p>}
          {listReady && visible.length === 0 && (
            <p className="py-6 text-body-md text-on-surface-variant">{emptyMessage}</p>
          )}
          {listReady && visible.length > 0 && (
            <ol className="mt-4 max-h-[640px] overflow-y-auto divide-y divide-outline-variant rounded-xl border border-outline-variant">
              {visible.map(record => (
                <ExemptionRecordItem
                  key={record.employeeId}
                  record={record}
                  clock={clock}
                  held={stored.held.has(record.employeeId)}
                  hints={hintsFor ? hintsFor(record) : null}
                  monthLabel={monthLabel}
                  disabled={locked}
                  onStop={(item, meal) => { void stopMeal(item, meal); }}
                  onSetEnd={setEndDate}
                  onChangeEmail={changeEmail}
                  onRemove={item => { void removeRecord(item); }}
                />
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
