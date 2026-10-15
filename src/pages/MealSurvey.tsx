import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  where,
  type DocumentReference,
  type DocumentSnapshot,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { Footer } from '../components/Footer';
import {
  COUNTDOWN_CHIP,
  isRealWeekId,
  surveyCountdownText,
  surveyCountdownTone,
  surveyDeadlineText,
  surveyMomentText,
} from '../components/SurveyBanner';
import {
  SURVEY_ANSWER_KEYS,
  SURVEY_QUESTIONS,
  SURVEY_TITLE,
  SURVEY_VERSION,
  isSurveyOpen,
  shiftDate,
  surveyClosesAt,
  surveyDefaultOpensAt,
  surveyWeekLabel,
  toMillis,
  validateSurveyAnswers,
  weekStartOf,
} from '../../agent/lib/survey.mjs';
import { formatVnDateTime, vnParts, vnToday } from '../../agent/lib/meal-rules.mjs';

// Kiểu câu hỏi lấy thẳng từ survey.mjs (JSDoc): thêm loại câu hỏi mới ở đó thì
// TypeScript báo ngay trang này chưa biết vẽ, thay vì lặng lẽ bỏ qua câu đó.
type SurveyQuestion = (typeof SURVEY_QUESTIONS)[number];
type ChoiceQuestion = Extract<SurveyQuestion, { kind: 'choice' }>;
type TextQuestion = Extract<SurveyQuestion, { kind: 'text' }>;

export type SurveyAnswers = Record<string, string>;

const NUTRITION_EMAIL = 'dinhduong@hoangmaistarschool.edu.vn';
const REQUIRED = SURVEY_QUESTIONS.filter(q => q.required);

const CARD =
  'min-w-0 bg-surface-container-lowest rounded-2xl border border-outline-variant';

// ====================================================================
// Phần trình bày thuần: chỉ nhận props, không đọc Firestore, không gọi đồng
// hồ (giờ hiện tại là prop `now`). Tách riêng để xem trước đủ mọi trạng thái
// bằng dữ liệu giả — chờ dữ liệu thật thì phải đợi đúng 15:00 thứ 6.
// ====================================================================

export interface ViewError {
  title: string;
  detail: string;
}

/** Khung giờ nhận trả lời của tuần (mili giây). */
export interface SurveyWindow {
  opensAt: number;
  closesAt: number;
}

export interface SavedResponse {
  answers: SurveyAnswers;
  /** ISO, lần gửi đầu tiên. */
  submittedAt: string | null;
  /** ISO, lần sửa gần nhất. */
  updatedAt: string | null;
}

export interface SurveyProfile {
  fullName: string;
  employeeId: string;
  department: string;
}

export interface SurveyViewProps {
  loading: boolean;
  error: ViewError | null;
  onRetry?: () => void;
  /** Giờ hiện tại (mili giây) — mọi trạng thái mở/đóng, đếm ngược tính theo nó. */
  now: number;
  /** Tuần đang hiển thị (thứ 2, YYYY-MM-DD); null khi không có khảo sát nào để hiện. */
  weekId: string | null;
  /** null: tuần này chưa có document khảo sát (chưa mở / tuần nghỉ). */
  survey: SurveyWindow | null;
  /** Agent đã bỏ qua tuần này vì cả tuần không có suất ăn. */
  skipped?: boolean;
  saved: SavedResponse | null;
  profile: SurveyProfile | null;
  /** Khi khảo sát đang mở và đã có câu trả lời: true = đang sửa (form), false = màn cảm ơn. */
  editing: boolean;
  answers: SurveyAnswers;
  /** Lỗi theo mã câu hỏi (validateSurveyAnswers), rỗng khi chưa bấm gửi. */
  errors: Record<string, string>;
  /** Tăng 1 mỗi lần gửi mà còn lỗi: trang cuộn tới câu lỗi đầu tiên. */
  focusRequest: number;
  onAnswer: (id: string, value: string) => void;
  onSubmit: () => void;
  onEdit: () => void;
  /** Chỉ có khi đang sửa câu trả lời đã gửi trong phiên này (để quay lại màn cảm ơn). */
  onCancelEdit?: () => void;
  sending: boolean;
  /** Gửi lâu bất thường (mạng yếu) — vẫn đang chờ, chỉ để báo cho Thầy/Cô biết. */
  slow?: boolean;
  submitError: ViewError | null;
  /** Lần mở mặc định kế tiếp mà trang có thể báo trước (15:00 thứ 6). */
  upcoming: { weekId: string; opensAt: number } | null;
  /** Một tuần KHÁC đang mở (vd Thầy/Cô bấm link email tuần cũ). */
  otherOpen: { weekId: string; closesAt: number } | null;
  /**
   * `answers` khác bản đã lưu mà chưa gửi được. Khi khảo sát đóng giữa chừng,
   * trang vẫn hiện các câu này (chỉ đọc) để Thầy/Cô biết là CHƯA được ghi nhận
   * và còn sao chép được.
   */
  unsentEdits?: boolean;
  /** ISO: lúc sửa cuối của bản nháp chưa gửi vừa được khôi phục (null nếu không có). */
  restoredDraftAt?: string | null;
  onDiscardDraft?: () => void;
  /** Tăng 1 mỗi khi trang đổi màn (gửi xong, sửa, huỷ sửa, vừa đóng): đưa con trỏ tới tiêu đề màn mới. */
  viewFocus?: number;
  /**
   * Đồng hồ trang đã qua hạn nhưng lịch tuần đang giữ được đọc TRƯỚC hạn, và
   * trang đang hỏi lại máy chủ. Trong lúc đó vẫn hiện như đang mở (giữ nguyên
   * form và các câu đang điền): quản trị có thể vừa gia hạn, chưa được nói
   * "đã đóng" khi chưa biết chắc.
   */
  checkingDeadline?: boolean;
  /** Hạn cũ (mili giây) khi Nhóm Dinh dưỡng gia hạn trong lúc trang đang mở; null nếu không đổi. */
  extendedFrom?: number | null;
}

type Phase = 'none' | 'not-open' | 'open' | 'closed';

/**
 * Khảo sát có đang nhận trả lời lúc `now`. Vẫn đi qua isSurveyOpen của
 * survey.mjs (nguồn duy nhất của quy tắc [mở, đóng)), nhưng phải đổi mili giây
 * sang Date: toMillis chỉ nhận ISO/Date/Timestamp, đưa số vào là luôn "đóng".
 */
function windowOpen(w: SurveyWindow, now: number) {
  return isSurveyOpen({ opensAt: new Date(w.opensAt), closesAt: new Date(w.closesAt) }, new Date(now));
}

function phaseOf(survey: SurveyWindow | null, now: number): Phase {
  if (!survey) return 'none';
  if (windowOpen(survey, now)) return 'open';
  return now < survey.opensAt ? 'not-open' : 'closed';
}

const vnDateTime = (iso: string | null | undefined) => formatVnDateTime(iso);

/**
 * Đánh dấu tiêu đề chính của mỗi màn. Đổi màn (gửi xong, sửa, đóng) thì nút
 * đang giữ con trỏ biến mất cùng màn cũ, con trỏ rơi về <body> và trình đọc màn
 * hình im lặng — SurveyView đưa con trỏ tới tiêu đề này thay vào đó.
 */
const VIEW_HEADING = { 'data-view-heading': '', tabIndex: -1 } as const;

function Banner({ tone, icon, children }: { tone: 'warning' | 'error' | 'info' | 'success'; icon: string; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'p-sm md:p-md rounded-lg border text-body-md flex items-start gap-2',
        tone === 'warning' && 'bg-warning-container text-on-warning-container border-warning/30',
        tone === 'error' && 'bg-error-container text-on-error-container border-error/25',
        tone === 'info' && 'bg-primary-container/40 text-on-primary-container border-primary/15',
        tone === 'success' && 'bg-tertiary-container/70 text-on-tertiary-container border-tertiary/25',
      )}
    >
      <span className="material-symbols-outlined text-[20px] shrink-0 mt-px" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

/** Lỗi khi gửi. role=alert: chèn vào trang lúc có lỗi vẫn được trình đọc màn hình đọc ngay. */
function SubmitAlert({ error }: { error: ViewError | null }) {
  if (!error) return null;
  return (
    <div role="alert">
      <Banner tone="error" icon="error">
        <p className="font-semibold">{error.title}</p>
        <p className="text-body-sm">{error.detail}</p>
      </Banner>
    </div>
  );
}

function CountdownChip({ msLeft, checking = false }: { msLeft: number; checking?: boolean }) {
  // Đang hỏi lại máy chủ sau khi tới hạn: chưa nói "đã hết hạn" (có thể vừa được gia hạn).
  if (checking) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-label-md whitespace-nowrap w-fit bg-surface-container-high text-on-surface-variant border-outline-variant">
        <span className="material-symbols-outlined text-[15px] animate-spin" aria-hidden="true">progress_activity</span>
        đang kiểm tra hạn…
      </span>
    );
  }
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-label-md tabular whitespace-nowrap w-fit',
        COUNTDOWN_CHIP[surveyCountdownTone(msLeft)],
      )}
    >
      <span className="material-symbols-outlined text-[15px]" aria-hidden="true">timer</span>
      {surveyCountdownText(msLeft)}
    </span>
  );
}

/** Thẻ mở đầu: tiêu đề, tuần, hạn + đếm ngược, ghi chú về họ tên. */
function IntroCard({
  weekId,
  survey,
  now,
  profile,
  checking = false,
  extendedFrom = null,
}: {
  weekId: string;
  survey: SurveyWindow;
  now: number;
  profile: SurveyProfile | null;
  checking?: boolean;
  extendedFrom?: number | null;
}) {
  const left = survey.closesAt - now;
  return (
    <section aria-labelledby="sv-title" className={clsx(CARD, 'overflow-hidden')}>
      <div className="border-b border-outline-variant px-md md:px-lg py-md md:py-lg">
        <p className="text-label-sm text-on-surface-variant">
          Nhóm Dinh dưỡng<span className="hidden sm:inline"> · Trường Ngôi Sao Hoàng Mai</span>
        </p>
        <h3 id="sv-title" {...VIEW_HEADING} className="text-headline-sm md:text-headline-md text-on-surface mt-2 focus:outline-none">
          {SURVEY_TITLE}
        </h3>
        <p className="text-body-md mt-2 flex items-center gap-1.5 text-on-surface-variant">
          <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden="true">date_range</span>
          Tuần <strong className="tabular">{surveyWeekLabel(weekId)}</strong>
        </p>
      </div>
      <div className="p-md md:p-lg flex flex-col gap-sm md:gap-md">
        <p className="text-body-md text-on-surface">
          Nhằm không ngừng nâng cao chất lượng phục vụ suất ăn dành cho CBGV-NV, Nhóm Dinh dưỡng kính mong nhận được những ý
          kiến đóng góp khách quan, chân thực và sát với thực tế từ Thầy/Cô.
        </p>
        {/* Một ô hạn trả lời gọn: trên điện thoại thẻ mở đầu không được chiếm
            hết màn hình đầu tiên, Thầy/Cô phải thấy ngay câu hỏi bên dưới. */}
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-sm md:p-md flex flex-wrap items-center gap-x-md gap-y-1.5">
          {/* min-w: hẹp quá thì ô đếm ngược xuống dòng, không bóp chữ ngày giờ. */}
          <div className="flex items-start gap-sm min-w-[14rem] flex-1">
            <span className="material-symbols-outlined text-[22px] text-primary shrink-0" aria-hidden="true">event_available</span>
            <div className="min-w-0 flex flex-col">
              <span className="text-label-sm uppercase text-on-surface-variant">Hạn trả lời</span>
              <span className="text-label-lg text-on-surface tabular">{surveyDeadlineText(survey.closesAt)}</span>
            </div>
          </div>
          <div className="pl-[30px] sm:pl-0">
            <CountdownChip msLeft={left} checking={checking} />
          </div>
          {/* Hạn đổi ngay trên màn hình (quản trị gia hạn khi Thầy/Cô đang điền):
              nói rõ để Thầy/Cô không tưởng đồng hồ trang bị sai. */}
          {extendedFrom !== null && (
            <p role="status" className="basis-full pl-[30px] text-body-sm text-on-surface-variant flex items-start gap-1">
              <span className="material-symbols-outlined text-[16px] text-tertiary-dark shrink-0 mt-px" aria-hidden="true">update</span>
              <span>
                Nhóm Dinh dưỡng đã gia hạn khảo sát (hạn cũ: <span className="tabular">{surveyDeadlineText(extendedFrom)}</span>).
              </span>
            </p>
          )}
        </div>
        <p className="text-body-sm text-on-surface-variant flex items-start gap-1.5">
          <span className="material-symbols-outlined text-[16px] shrink-0 mt-px" aria-hidden="true">checklist</span>
          <span>
            Khoảng 1 phút · {SURVEY_QUESTIONS.length} câu hỏi, {REQUIRED.length} câu bắt buộc (đánh dấu <span className="text-secondary font-semibold">*</span>)
          </span>
        </p>
        <p className="text-body-sm text-on-surface-variant flex items-start gap-1.5">
          <span className="material-symbols-outlined text-[16px] shrink-0 mt-px" aria-hidden="true">badge</span>
          <span>
            Phản hồi ghi kèm họ tên{profile?.fullName ? <> (<strong className="text-on-surface">{profile.fullName}</strong>)</> : ''} để
            Nhóm Dinh dưỡng liên hệ khi cần. Chỉ Thầy/Cô và quản trị viên phần mềm xem được câu trả lời này.
          </span>
        </p>
      </div>
    </section>
  );
}

/** Thanh tiến độ dính dưới đầu trang khi cuộn — điện thoại không nhìn thấy cả form một lúc. */
function ProgressBar({ answered }: { answered: number }) {
  const total = REQUIRED.length;
  const done = answered >= total;
  return (
    <div className="sticky top-16 md:top-0 z-30 -mx-md px-md md:mx-0 md:px-0 py-3 bg-background/95 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label="Số câu bắt buộc đã trả lời"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={answered}
          aria-valuetext={`${answered}/${total} câu bắt buộc`}
          className="flex-1 h-2 rounded-full bg-surface-container-highest overflow-hidden"
        >
          <div
            className={clsx('h-full rounded-full transition-[width] duration-300', done ? 'bg-tertiary' : 'bg-primary')}
            style={{ width: `${(answered / total) * 100}%` }}
          />
        </div>
        <span className={clsx('text-label-md tabular whitespace-nowrap flex items-center gap-1', done ? 'text-tertiary-dark' : 'text-on-surface-variant')}>
          {done && (
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true" style={{ fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
          )}
          {answered}/{total} câu bắt buộc
        </span>
      </div>
    </div>
  );
}

function QuestionHeading({ q, index, labelId }: { q: SurveyQuestion; index: number; labelId: string }) {
  return (
    <div className="flex items-start gap-sm">
      <span className="w-7 h-7 rounded-full bg-primary/10 text-primary text-label-md tabular flex items-center justify-center shrink-0" aria-hidden="true">
        {index + 1}
      </span>
      <h4 id={labelId} className="text-label-lg md:text-[15px] md:leading-[22px] text-on-surface pt-0.5">
        {q.label}
        {q.required ? (
          <>
            <span className="text-secondary ml-0.5" aria-hidden="true">*</span>
            <span className="sr-only"> (bắt buộc)</span>
          </>
        ) : (
          <span className="ml-1.5 text-body-sm text-on-surface-variant font-normal">(không bắt buộc)</span>
        )}
      </h4>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="text-body-sm text-error flex items-center gap-1 font-medium">
      <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden="true">error</span>
      {message}
    </p>
  );
}

/**
 * Câu chọn: thẻ lớn dễ bấm trên điện thoại, hành xử như nhóm radio chuẩn —
 * Tab vào nhóm rơi đúng đáp án đang chọn, phím mũi tên đổi đáp án.
 */
function ChoiceField({
  q,
  index,
  value,
  error,
  onChange,
}: {
  q: ChoiceQuestion;
  index: number;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = q.options.findIndex(o => o.value === value);
  const labelId = `sv-${q.id}-label`;
  const errorId = `sv-${q.id}-error`;
  // Đáp án dài (câu thực đơn) xếp tối đa 2 cột; đáp án ngắn xếp thành hàng khi thẻ đủ rộng.
  const long = q.options.some(o => o.label.length > 18);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = q.options.length;
    let next: number;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % n;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    onChange(q.options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-sm">
      <QuestionHeading q={q} index={index} labelId={labelId} />
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-required={q.required}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={clsx(
          'grid grid-cols-1 gap-2',
          long ? '@xl:grid-cols-2' : q.options.length >= 3 ? '@md:grid-cols-3' : '@md:grid-cols-2',
        )}
      >
        {q.options.map((o, i) => {
          const checked = i === selected;
          return (
            <button
              key={o.value}
              ref={el => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              // Chỉ một nút trong nhóm nhận Tab: đáp án đang chọn, hoặc nút đầu.
              tabIndex={checked || (selected < 0 && i === 0) ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={e => onKeyDown(e, i)}
              className={clsx(
                'group w-full min-h-[52px] px-md py-3 rounded-lg border-2 text-left flex items-center gap-3 transition-colors disabled:cursor-not-allowed disabled:opacity-70',
                checked
                  ? 'border-primary bg-primary-container/35 text-on-surface'
                  : error
                    ? 'border-error/40 bg-surface-container-lowest hover:border-primary/50 hover:bg-surface-container-low'
                    : 'border-outline-variant bg-surface-container-lowest hover:border-primary/50 hover:bg-surface-container-low',
              )}
            >
              <span
                className={clsx(
                  'w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                  checked ? 'border-primary' : 'border-outline group-hover:border-primary/70',
                )}
                aria-hidden="true"
              >
                <span className={clsx('w-2.5 h-2.5 rounded-full bg-primary transition-transform', checked ? 'scale-100' : 'scale-0')} />
              </span>
              <span className={clsx('text-body-lg leading-snug', checked ? 'font-semibold text-primary' : 'text-on-surface')}>{o.label}</span>
            </button>
          );
        })}
      </div>
      {error && <FieldError id={errorId} message={error} />}
    </div>
  );
}

function TextField({
  q,
  index,
  value,
  error,
  onChange,
}: {
  q: TextQuestion;
  index: number;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const labelId = `sv-${q.id}-label`;
  const errorId = `sv-${q.id}-error`;
  const counterId = `sv-${q.id}-count`;
  const len = value.length;
  const near = len >= q.maxLength * 0.9;
  return (
    <div className="flex flex-col gap-sm">
      <QuestionHeading q={q} index={index} labelId={labelId} />
      <textarea
        id={`sv-${q.id}-input`}
        aria-labelledby={labelId}
        aria-required={q.required}
        aria-invalid={!!error}
        aria-describedby={clsx(error && errorId, counterId)}
        value={value}
        onChange={e => onChange(e.target.value)}
        // Chặn cứng độ dài ngay tại ô nhập (dán đoạn dài thì trình duyệt cắt):
        // Thầy/Cô thấy bộ đếm chạm trần, khỏi gặp lỗi "quá dài" lúc bấm gửi.
        maxLength={q.maxLength}
        rows={q.maxLength > 500 ? 4 : 3}
        placeholder={q.placeholder}
        // Chữ 16px: Safari trên iPhone tự phóng to trang khi chạm vào ô chữ nhỏ hơn.
        className={clsx(
          'w-full rounded-lg border-2 bg-surface-container-lowest px-md py-3 text-body-lg text-on-surface placeholder:text-on-surface-variant/70 resize-y min-h-[96px] transition-colors focus:outline-none focus-visible:outline-none focus:border-primary focus:ring-4 focus:ring-primary/10 disabled:opacity-70',
          error ? 'border-error/60' : 'border-outline-variant hover:border-primary/40',
        )}
      />
      <div className="flex items-start justify-between gap-sm">
        <div className="min-w-0">{error && <FieldError id={errorId} message={error} />}</div>
        <span
          id={counterId}
          aria-live={near ? 'polite' : 'off'}
          className={clsx('text-body-sm tabular shrink-0', len >= q.maxLength ? 'text-error font-semibold' : near ? 'text-on-warning-container font-semibold' : 'text-on-surface-variant')}
        >
          <span className="sr-only">Đã nhập </span>
          {len}/{q.maxLength}
          <span className="sr-only"> ký tự</span>
        </span>
      </div>
    </div>
  );
}

function SurveyForm(props: SurveyViewProps & { weekId: string; survey: SurveyWindow }) {
  const {
    answers,
    errors,
    onAnswer,
    onSubmit,
    sending,
    slow,
    submitError,
    saved,
    focusRequest,
    onCancelEdit,
    restoredDraftAt,
    onDiscardDraft,
    checkingDeadline,
  } = props;
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Đếm câu bắt buộc đã trả lời bằng chính hàm kiểm tra dùng lúc gửi, để thanh
  // tiến độ không bao giờ báo "đủ" trong khi bấm gửi vẫn bị lỗi.
  const check = useMemo(() => validateSurveyAnswers(answers), [answers]);
  const answered = REQUIRED.filter(q => !check.errors[q.id]).length;
  const missing = REQUIRED.length - answered;

  // Gửi mà còn lỗi: cuộn tới câu lỗi đầu tiên (theo thứ tự câu hỏi) và đặt
  // con trỏ vào đó, để Thầy/Cô trên điện thoại không phải tự dò.
  useEffect(() => {
    if (!focusRequest) return;
    const first = SURVEY_QUESTIONS.find(q => errors[q.id]);
    const el = first ? sectionRefs.current[first.id] : null;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    el.querySelector<HTMLElement>('[role="radio"][tabindex="0"], textarea')?.focus({ preventScroll: true });
    // Chỉ chạy khi có yêu cầu mới; lỗi lúc đó đã là lỗi mới nhất.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  return (
    <form
      noValidate
      onSubmit={e => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-md"
      aria-labelledby="sv-title"
    >
      <ProgressBar answered={answered} />
      {saved && (
        <Banner tone="info" icon="history">
          <p>
            Thầy/Cô đã gửi câu trả lời lúc <strong className="tabular">{vnDateTime(saved.updatedAt || saved.submittedAt)}</strong>. Có thể
            sửa rồi bấm “Cập nhật câu trả lời” trước hạn.
          </p>
        </Banner>
      )}
      {restoredDraftAt && (
        <Banner tone="warning" icon="edit_note">
          <p>
            Đã khôi phục các câu Thầy/Cô điền dở lúc <strong className="tabular">{vnDateTime(restoredDraftAt)}</strong>.{' '}
            <strong>Các câu này chưa được gửi</strong> — Thầy/Cô kiểm tra lại rồi bấm “{saved ? 'Cập nhật câu trả lời' : 'Gửi khảo sát'}”.
          </p>
          {onDiscardDraft && (
            <button
              type="button"
              onClick={onDiscardDraft}
              disabled={sending}
              className="inline-flex items-start gap-1 text-left font-semibold text-primary disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[16px] mt-0.5" aria-hidden="true">undo</span>
              <span className="underline underline-offset-2">
                {saved ? 'Bỏ bản nháp, dùng lại câu trả lời đã gửi' : 'Bỏ bản nháp, điền lại từ đầu'}
              </span>
            </button>
          )}
        </Banner>
      )}
      {/* fieldset disabled: khoá toàn bộ ô nhập trong lúc đang gửi. */}
      <fieldset disabled={sending} className="flex flex-col gap-md min-w-0">
        <legend className="sr-only">Câu hỏi khảo sát</legend>
        {SURVEY_QUESTIONS.map((q, i) => (
          <section
            key={q.id}
            id={`sv-${q.id}`}
            ref={el => {
              sectionRefs.current[q.id] = el;
            }}
            className={clsx(
              CARD,
              '@container p-md md:p-lg scroll-mt-28 transition-colors',
              errors[q.id] && '!border-error/50 ring-2 ring-error/10',
            )}
          >
            {q.kind === 'choice' ? (
              <ChoiceField q={q} index={i} value={answers[q.id] || ''} error={errors[q.id]} onChange={v => onAnswer(q.id, v)} />
            ) : (
              <TextField q={q} index={i} value={answers[q.id] || ''} error={errors[q.id]} onChange={v => onAnswer(q.id, v)} />
            )}
          </section>
        ))}
      </fieldset>

      <div className={clsx(CARD, 'p-md md:p-lg flex flex-col gap-sm')}>
        <SubmitAlert error={submitError} />
        {/* Đặt cạnh nút gửi: lúc tới hạn Thầy/Cô thường đang ở cuối form, không thấy thẻ đầu trang. */}
        {checkingDeadline && (
          <p role="status" className="text-body-sm text-on-surface-variant flex items-start gap-1.5">
            <span className="material-symbols-outlined text-[16px] shrink-0 mt-px animate-spin" aria-hidden="true">progress_activity</span>
            <span>Đã tới hạn trả lời theo đồng hồ của thiết bị. Hệ thống đang kiểm tra lại với máy chủ; các câu đã điền vẫn được giữ nguyên.</span>
          </p>
        )}
        <p className={clsx('text-body-sm flex items-center gap-1.5', missing ? 'text-on-surface-variant' : 'text-tertiary-dark font-semibold')}>
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{missing ? 'info' : 'task_alt'}</span>
          {missing
            ? `Còn ${missing} câu bắt buộc chưa trả lời.`
            : 'Đã trả lời đủ các câu bắt buộc.'}
        </p>
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-sm">
          {onCancelEdit && (
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={sending}
              className="inline-flex items-center justify-center gap-2 px-lg py-3 rounded-lg border border-outline-variant bg-surface-container-lowest text-label-lg text-on-surface hover:bg-surface-container transition-colors disabled:opacity-60"
            >
              Huỷ sửa
            </button>
          )}
          <button
            type="submit"
            disabled={sending}
            aria-busy={sending}
            className="inline-flex items-center justify-center gap-2 px-xl py-3 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary-dark transition-colors shadow-sm disabled:opacity-75 disabled:cursor-wait sm:min-w-[220px]"
          >
            <span className={clsx('material-symbols-outlined text-[20px]', sending && 'animate-spin')} aria-hidden="true">
              {sending ? 'progress_activity' : 'send'}
            </span>
            {sending ? 'Đang gửi...' : saved ? 'Cập nhật câu trả lời' : 'Gửi khảo sát'}
          </button>
        </div>
        {slow && sending && (
          <p role="status" className="text-body-sm text-on-warning-container text-center sm:text-right">
            Mạng đang chậm, hệ thống vẫn đang gửi. Thầy/Cô vui lòng giữ trang này mở.
          </p>
        )}
      </div>
    </form>
  );
}

function displayAnswer(q: SurveyQuestion, value: string | undefined, draft = false): ReactNode {
  // Bản nháp chưa gửi có thể còn thiếu câu bắt buộc: nói "chưa chọn" chứ không phải "không có".
  const empty = (text: string) => <span className="italic text-on-surface-variant font-normal">{text}</span>;
  if (q.kind === 'choice') {
    const o = q.options.find(x => x.value === value);
    return o ? o.label : empty(draft ? 'Chưa chọn' : 'Không có');
  }
  return value ? value : empty(draft ? 'Chưa điền' : 'Không trả lời');
}

/**
 * Câu trả lời chỉ đọc: bản đã gửi (màn cảm ơn, khảo sát đã đóng) hoặc bản chưa
 * gửi kịp khi khảo sát đóng (`unsent`, viền vàng).
 */
function AnswerSummary({
  answers,
  title = 'Câu trả lời của Thầy/Cô',
  unsent = false,
}: {
  answers: SurveyAnswers;
  title?: string;
  unsent?: boolean;
}) {
  // Màn "đã đóng" có thể hiện hai bảng cùng lúc (chưa gửi + đã ghi nhận).
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={clsx(CARD, '@container overflow-hidden', unsent && '!border-warning/60')}>
      <h3
        id={titleId}
        className={clsx(
          'px-md md:px-lg py-3 border-b text-label-lg flex items-center gap-2',
          unsent
            ? 'bg-warning-container text-on-warning-container border-warning/40'
            : 'bg-surface-container-low text-on-surface border-outline-variant',
        )}
      >
        <span className={clsx('material-symbols-outlined text-[20px]', !unsent && 'text-primary')} aria-hidden="true">
          {unsent ? 'unpublished' : 'assignment'}
        </span>
        {title}
      </h3>
      <dl className="divide-y divide-outline-variant">
        {SURVEY_QUESTIONS.map((q, i) => (
          <div key={q.id} className="px-md md:px-lg py-3 grid grid-cols-1 @xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] gap-x-md gap-y-1">
            <dt className="text-body-sm text-on-surface-variant">
              <span className="tabular">{i + 1}.</span> {q.label}
            </dt>
            <dd className="text-label-lg text-on-surface whitespace-pre-line break-words">{displayAnswer(q, answers[q.id], unsent)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StateCard({
  icon,
  tone,
  title,
  children,
}: {
  icon: string;
  tone: 'neutral' | 'success' | 'info' | 'error' | 'warning';
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={clsx(CARD, 'p-lg md:p-xl flex flex-col items-center text-center gap-sm')}>
      <div
        className={clsx(
          'w-16 h-16 rounded-full flex items-center justify-center mb-1',
          tone === 'success' && 'bg-tertiary-container text-on-tertiary-container',
          tone === 'info' && 'bg-primary-container/60 text-primary',
          tone === 'neutral' && 'bg-surface-container-high text-on-surface-variant',
          tone === 'error' && 'bg-error-container text-on-error-container',
          tone === 'warning' && 'bg-warning-container text-on-warning-container',
        )}
      >
        <span className="material-symbols-outlined text-[34px]" aria-hidden="true" style={{ fontVariationSettings: "'FILL' 1" }}>
          {icon}
        </span>
      </div>
      <h3 {...VIEW_HEADING} className="text-headline-sm text-on-surface focus:outline-none">
        {title}
      </h3>
      <div className="text-body-md text-on-surface-variant max-w-[540px] flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

const thisWeekOf = (now: number) => weekStartOf(vnParts(now)?.date ?? vnToday());

/** "Khảo sát tuần này mở lúc 15:00 thứ 6, 16/10." */
function upcomingText(upcoming: SurveyViewProps['upcoming'], now: number): string | null {
  if (!upcoming) return null;
  const thisWeek = thisWeekOf(now);
  const which = upcoming.weekId === thisWeek ? 'tuần này' : upcoming.weekId === shiftDate(thisWeek, 7) ? 'tuần tới' : `tuần ${surveyWeekLabel(upcoming.weekId)}`;
  if (upcoming.opensAt > now) return `Khảo sát ${which} mở lúc ${surveyMomentText(upcoming.opensAt)}.`;
  // Đã quá 15:00 thứ 6 mà chưa có document tuần: máy gửi email đang chạy (lặp
  // mỗi 15 phút) hoặc sẽ gửi bù — đừng báo nhầm sang tuần sau.
  return `Khảo sát ${which} sắp được mở; Nhóm Dinh dưỡng sẽ gửi email mời khi khảo sát bắt đầu.`;
}

function OtherOpenNote({ otherOpen, now }: { otherOpen: SurveyViewProps['otherOpen']; now: number }) {
  if (!otherOpen) return null;
  return (
    <Banner tone="info" icon="rate_review">
      <p>
        Khảo sát tuần <strong className="tabular">{surveyWeekLabel(otherOpen.weekId)}</strong> đang mở, hạn trả lời{' '}
        <span className="tabular">{surveyDeadlineText(otherOpen.closesAt)}</span> ({surveyCountdownText(otherOpen.closesAt - now)}).
      </p>
      <Link
        to={`/khao-sat?tuan=${otherOpen.weekId}`}
        className="inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-2"
      >
        Làm khảo sát ngay
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_forward</span>
      </Link>
    </Banner>
  );
}

function BackLinks() {
  return (
    <div className="w-full sm:w-auto flex flex-col sm:flex-row gap-sm justify-center">
      <Link
        to="/cham-an"
        className="inline-flex items-center justify-center gap-2 px-lg py-2.5 rounded-lg border border-outline-variant bg-surface-container-lowest text-label-lg text-primary hover:bg-surface-container transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">fact_check</span>
        Chấm ăn của tôi
      </Link>
      <Link
        to="/schedule"
        className="inline-flex items-center justify-center gap-2 px-lg py-2.5 rounded-lg border border-outline-variant bg-surface-container-lowest text-label-lg text-primary hover:bg-surface-container transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">calendar_month</span>
        Đăng ký ăn hàng tháng
      </Link>
    </div>
  );
}

function NoSurveyState({ weekId, skipped, upcoming, now }: Pick<SurveyViewProps, 'weekId' | 'skipped' | 'upcoming' | 'now'>) {
  const lines: string[] = [];
  let next = upcomingText(upcoming, now);
  if (weekId) {
    const label = surveyWeekLabel(weekId);
    const defaultOpen = Date.parse(surveyDefaultOpensAt(weekId));
    if (skipped) {
      lines.push(`Tuần ${label} là tuần nghỉ (không có suất ăn) nên không có khảo sát.`);
    } else if (defaultOpen > now) {
      lines.push(`Khảo sát tuần ${label} mở lúc ${surveyMomentText(defaultOpen)}.`);
      next = null;
    } else if (Date.parse(surveyClosesAt(weekId)) > now) {
      lines.push(`Khảo sát tuần ${label} chưa được mở. Nhóm Dinh dưỡng sẽ gửi email mời khi khảo sát bắt đầu.`);
      next = null;
    } else {
      lines.push(`Tuần ${label} không có khảo sát suất ăn.`);
    }
  } else {
    lines.push('Hiện chưa có khảo sát nào đang mở.');
  }
  return (
    <StateCard icon="rate_review" tone="info" title="Chưa có khảo sát">
      {lines.map(l => (
        <p key={l}>{l}</p>
      ))}
      {next && <p className="font-semibold text-on-surface">{next}</p>}
      <p className="text-body-sm">Khảo sát chất lượng suất ăn được gửi tới CBGV-NV có đăng ký ăn vào 15:00 thứ 6 hằng tuần.</p>
    </StateCard>
  );
}

export function SurveyView(props: SurveyViewProps) {
  const { loading, error, onRetry, now, weekId, survey, saved, profile, editing, submitError, otherOpen, viewFocus } = props;
  const rawPhase = phaseOf(survey, now);
  // Tới hạn theo đồng hồ nhưng chưa hỏi lại máy chủ: vẫn hiện như đang mở.
  const checking = !!props.checkingDeadline && rawPhase === 'closed';
  const phase: Phase = checking ? 'open' : rawPhase;
  const mainRef = useRef<HTMLElement>(null);

  // Đổi màn xong (effect chạy sau khi màn mới đã vẽ): đặt con trỏ vào tiêu đề
  // màn mới để người dùng bàn phím/trình đọc màn hình biết chuyện gì vừa xảy ra
  // và Tab tiếp theo đi từ đó, không phải từ đầu trang. Cuộn trang do bên gọi lo.
  useEffect(() => {
    if (!viewFocus) return;
    mainRef.current?.querySelector<HTMLElement>('[data-view-heading]')?.focus({ preventScroll: true });
  }, [viewFocus]);

  let body: ReactNode;
  if (loading) {
    body = (
      <div role="status" className={clsx(CARD, 'p-xl flex flex-col items-center gap-sm text-on-surface-variant')}>
        <span className="material-symbols-outlined animate-spin text-[32px] text-primary" aria-hidden="true">progress_activity</span>
        <p className="text-body-md">Đang tải khảo sát...</p>
      </div>
    );
  } else if (error) {
    body = (
      <div role="alert" className={clsx(CARD, 'p-lg flex flex-col items-center text-center gap-sm')}>
        <div className="w-14 h-14 rounded-full bg-error-container text-on-error-container flex items-center justify-center">
          <span className="material-symbols-outlined text-[30px]" aria-hidden="true">error</span>
        </div>
        <h3 className="text-headline-sm text-on-surface">{error.title}</h3>
        <p className="text-body-md text-on-surface-variant max-w-[520px]">{error.detail}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-sm inline-flex items-center gap-2 px-lg py-2.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary-dark transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">refresh</span>
            Thử lại
          </button>
        )}
      </div>
    );
  } else if (phase === 'none' || !weekId || !survey) {
    body = (
      <>
        <OtherOpenNote otherOpen={otherOpen} now={now} />
        <NoSurveyState weekId={weekId} skipped={props.skipped} upcoming={props.upcoming} now={now} />
      </>
    );
  } else if (phase === 'not-open') {
    body = (
      <>
        <SubmitAlert error={submitError} />
        <OtherOpenNote otherOpen={otherOpen} now={now} />
        <StateCard icon="schedule" tone="info" title="Khảo sát chưa mở">
          <p>
            Khảo sát tuần <strong className="text-on-surface tabular">{surveyWeekLabel(weekId)}</strong> sẽ mở lúc{' '}
            <strong className="text-on-surface tabular">{surveyMomentText(survey.opensAt, true)}</strong>.
          </p>
          <p>Nhóm Dinh dưỡng sẽ gửi email mời khi khảo sát bắt đầu.</p>
        </StateCard>
      </>
    );
  } else if (phase === 'closed') {
    const next = upcomingText(props.upcoming, now);
    // Đóng trong lúc Thầy/Cô đang điền / đang sửa: không được lặng lẽ thay bằng
    // bản cũ kèm lời cảm ơn — người dùng sẽ tưởng phần sửa đã được tính.
    const unsent = !!props.unsentEdits;
    const savedAt = saved ? vnDateTime(saved.updatedAt || saved.submittedAt) : '';
    body = (
      <>
        {/* Lời báo gửi bị từ chối trùng ý với thẻ "chưa gửi" bên dưới: chỉ hiện khi không có thẻ đó. */}
        {!unsent && <SubmitAlert error={submitError} />}
        <OtherOpenNote otherOpen={otherOpen} now={now} />
        <StateCard icon="lock_clock" tone={unsent ? 'warning' : saved ? 'success' : 'neutral'} title="Khảo sát đã đóng">
          <p>
            Khảo sát tuần <strong className="text-on-surface tabular">{surveyWeekLabel(weekId)}</strong> đã kết thúc lúc{' '}
            <span className="tabular">{surveyDeadlineText(survey.closesAt)}</span>.
          </p>
          {unsent ? (
            <>
              <p className="font-semibold text-on-warning-container">
                Các câu trả lời Thầy/Cô vừa điền (bên dưới) CHƯA được gửi nên không được ghi nhận.
              </p>
              {saved && (
                <p>
                  Bản Thầy/Cô gửi lúc <strong className="text-on-surface tabular">{savedAt}</strong> vẫn được giữ nguyên.
                </p>
              )}
              <p>Nếu cần góp ý thêm, Thầy/Cô có thể sao chép nội dung bên dưới và gửi email cho Nhóm Dinh dưỡng.</p>
            </>
          ) : saved ? (
            <p>
              Thầy/Cô đã gửi câu trả lời lúc <strong className="text-on-surface tabular">{savedAt}</strong>. Cảm ơn Thầy/Cô đã đóng góp ý
              kiến!
            </p>
          ) : (
            <p className="font-semibold text-on-surface">Thầy/Cô không gửi câu trả lời cho tuần này.</p>
          )}
          {next && !otherOpen && <p>{next}</p>}
        </StateCard>
        {unsent && <AnswerSummary answers={props.answers} title="Câu trả lời chưa gửi (không được ghi nhận)" unsent />}
        {saved && <AnswerSummary answers={saved.answers} title={unsent ? 'Câu trả lời đã ghi nhận' : undefined} />}
      </>
    );
  } else if (saved && !editing) {
    const left = survey.closesAt - now;
    body = (
      <>
        {/* Không đặt role=status cho cả thẻ: trong thẻ có ô đếm ngược đổi chữ
            mỗi phút, trình đọc màn hình sẽ đọc lại liên tục. Con trỏ được đưa
            tới tiêu đề cảm ơn (viewFocus) — đó là lời xác nhận gửi thành công. */}
        <section className={clsx(CARD, 'p-lg md:p-xl flex flex-col items-center text-center gap-sm animate-in')}>
          <div className="w-16 h-16 rounded-full bg-tertiary-container text-on-tertiary-container flex items-center justify-center mb-1">
            <span className="material-symbols-outlined text-[36px]" aria-hidden="true" style={{ fontVariationSettings: "'FILL' 1" }}>
              task_alt
            </span>
          </div>
          <h3 {...VIEW_HEADING} className="text-headline-sm md:text-headline-md text-on-surface focus:outline-none">
            Cảm ơn Thầy/Cô đã tham gia khảo sát!
          </h3>
          <p className="text-body-md text-on-surface-variant max-w-[540px]">
            Câu trả lời cho tuần <strong className="text-on-surface tabular">{surveyWeekLabel(weekId)}</strong> đã được ghi nhận lúc{' '}
            <strong className="text-on-surface tabular">{vnDateTime(saved.updatedAt || saved.submittedAt)}</strong>. Ý kiến của Thầy/Cô là
            cơ sở quan trọng để Nhóm Dinh dưỡng điều chỉnh và nâng cao chất lượng bữa ăn.
          </p>
          <p className="text-body-sm text-on-surface-variant flex flex-wrap items-center justify-center gap-1.5">
            Thầy/Cô có thể sửa câu trả lời trước <span className="tabular">{surveyDeadlineText(survey.closesAt)}</span>
            <CountdownChip msLeft={left} checking={checking} />
          </p>
          <button
            type="button"
            onClick={props.onEdit}
            className="mt-sm inline-flex items-center justify-center gap-2 px-lg py-2.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary-dark transition-colors w-full sm:w-auto"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">edit</span>
            Sửa câu trả lời
          </button>
          <BackLinks />
        </section>
        <AnswerSummary answers={saved.answers} />
      </>
    );
  } else {
    body = (
      <>
        <IntroCard weekId={weekId} survey={survey} now={now} profile={profile} checking={checking} extendedFrom={props.extendedFrom ?? null} />
        <SurveyForm {...props} weekId={weekId} survey={survey} checkingDeadline={checking} />
      </>
    );
  }

  return (
    <main ref={mainRef} className="flex-1 w-full max-w-[1440px] mx-auto py-md md:py-lg px-md md:px-margin lg:px-xl">
      {/* Cột giữa hẹp như một tờ phiếu: câu hỏi dài đọc dễ hơn, nút gửi không
          bị đẩy ra xa trên màn hình rộng. */}
      <div className="w-full max-w-[760px] mx-auto flex flex-col gap-md">
        {/* Họ tên luôn nằm dưới tiêu đề: cột chỉ rộng 760px, đặt cạnh nhau thì
            tên bộ phận dài bị gãy dòng lủng củng. */}
        <div className="flex flex-col gap-xs">
          <div>
            <p className="text-body-sm text-on-surface-variant mb-2">Suất ăn / Dinh dưỡng</p>
            <h2 className="text-headline-md md:text-headline-lg text-on-surface">Khảo sát suất ăn</h2>
            <p className="text-body-md text-on-surface-variant mt-xs text-[13px] md:text-[14px]">
              Ý kiến của Thầy/Cô giúp Nhóm Dinh dưỡng nâng cao chất lượng bữa ăn
            </p>
          </div>
          {profile?.fullName && (
            <p className="text-body-md text-on-surface-variant">
              <span className="text-label-lg text-on-surface">{profile.fullName}</span>
              {profile.department && <> · {profile.department}</>}
            </p>
          )}
        </div>
        {body}
        <p className="text-body-sm text-on-surface-variant text-center">
          Cần hỗ trợ? Liên hệ Nhóm Dinh dưỡng:{' '}
          <a href={`mailto:${NUTRITION_EMAIL}`} className="font-semibold text-primary underline underline-offset-2 break-all">
            {NUTRITION_EMAIL}
          </a>
        </p>
      </div>
    </main>
  );
}

// ====================================================================
// Phần tải dữ liệu
// ====================================================================

interface WeekInfo {
  survey: SurveyWindow | null;
  skipped: boolean;
}

interface Loaded {
  weekId: string | null;
  survey: SurveyWindow | null;
  skipped: boolean;
  saved: SavedResponse | null;
  profile: SurveyProfile | null;
  upcoming: { weekId: string; opensAt: number } | null;
  otherOpen: { weekId: string; closesAt: number } | null;
}

interface PageData extends Loaded {
  /**
   * Giờ máy (Date.now, CHƯA bù độ lệch) lúc bắt đầu lần đọc gần nhất từ máy
   * chủ đã cho ra `survey`: lịch tuần chắc chắn đúng tới thời điểm này. Giữ giờ
   * máy thô để các lần đọc so thứ tự được với nhau dù độ lệch đổi giữa chừng;
   * so với hạn thì cộng độ lệch hiện tại.
   */
  checkedAt: number;
  /** closesAt lúc mở trang — để biết hạn đã được gia hạn trong lúc Thầy/Cô đang ở trang. */
  firstClosesAt: number | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Document tuần -> khung giờ. Tuần agent bỏ qua (cả tuần nghỉ) không có opensAt/closesAt. */
function parseWeek(data: Record<string, unknown> | undefined): WeekInfo {
  const opensAt = toMillis(data?.opensAt);
  const closesAt = toMillis(data?.closesAt);
  if (opensAt !== null && closesAt !== null) return { survey: { opensAt, closesAt }, skipped: false };
  const email = data?.email as { status?: unknown } | undefined;
  return { survey: null, skipped: email?.status === 'skipped' };
}

function parseResponse(data: Record<string, unknown> | undefined): SavedResponse | null {
  if (!data) return null;
  const raw = (data.answers && typeof data.answers === 'object' ? data.answers : {}) as Record<string, unknown>;
  const answers: SurveyAnswers = {};
  for (const k of SURVEY_ANSWER_KEYS) if (typeof raw[k] === 'string') answers[k] = raw[k] as string;
  return { answers, submittedAt: str(data.submittedAt) || null, updatedAt: str(data.updatedAt) || null };
}

const answersFrom = (saved: SavedResponse | null): SurveyAnswers => ({ ...(saved?.answers ?? {}) });
// So theo nội dung từng câu (bỏ thứ tự khoá, coi ô trống = chưa trả lời) để
// biết Thầy/Cô có sửa gì chưa gửi không.
const signature = (a: SurveyAnswers) => JSON.stringify(SURVEY_ANSWER_KEYS.map(k => a[k] || ''));

// ---------------------------------------------------------------- bản nháp
// Router của app là BrowserRouter (không có useBlocker), và `beforeunload` chỉ
// chạy khi đóng tab / tải lại — bấm thanh menu dưới đáy hay logo đầu trang là
// chuyển trang trong app, form điền dở mất trắng không một lời hỏi. Vì vậy câu
// trả lời chưa gửi được lưu nháp theo tuần + tài khoản và khôi phục khi quay
// lại. sessionStorage: chỉ sống trong tab này, đóng tab là hết — không để lại
// góp ý của người này trên máy dùng chung ở phòng giáo viên.

interface Draft {
  answers: SurveyAnswers;
  /** ISO (giờ đã bù độ lệch), lần sửa cuối. */
  at: string;
}

const draftKey = (uid: string, weekId: string) => `dkan:khao-sat:nhap:${uid}:${weekId}`;

function readDraft(key: string): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as { answers?: unknown; at?: unknown };
    if (!v || typeof v.at !== 'string' || !v.answers || typeof v.answers !== 'object') return null;
    const src = v.answers as Record<string, unknown>;
    const answers: SurveyAnswers = {};
    // Chỉ nhận đúng các mã câu hỏi, chuỗi, độ dài hợp lý — bản nháp là dữ liệu
    // trên máy, lúc gửi vẫn qua validateSurveyAnswers như thường.
    for (const k of SURVEY_ANSWER_KEYS) if (typeof src[k] === 'string') answers[k] = (src[k] as string).slice(0, 2000);
    return { answers, at: v.at };
  } catch {
    return null;
  }
}

function writeDraft(key: string, answers: SurveyAnswers, atMs: number) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ answers, at: new Date(atMs).toISOString() }));
  } catch {
    // Trình duyệt chặn lưu (chế độ riêng tư, hết chỗ): bỏ qua, chỉ mất tiện ích nháp.
  }
}

function clearDraft(key: string | null) {
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // như trên
  }
}

// ------------------------------------------------------- giờ máy chủ
/**
 * Độ lệch (mili giây) giữa giờ máy chủ Google và đồng hồ máy này, hoặc null nếu
 * không hỏi được. Lấy từ `iat` của ID token vừa cấp lại: không tốn lượt đọc
 * Firestore, không ghi gì. `iat` làm tròn xuống tới giây nên sai số khoảng 1 giây
 * — đủ để biết khảo sát đã đóng theo giờ máy chủ hay chưa.
 */
async function serverClockOffset(user: User): Promise<number | null> {
  try {
    const t0 = Date.now();
    const r = await user.getIdTokenResult(true);
    const t1 = Date.now();
    const iat = Date.parse(r.issuedAtTime);
    if (Number.isNaN(iat)) return null;
    return iat + 500 - Math.round((t0 + t1) / 2);
  } catch (e) {
    console.warn('Không lấy được giờ máy chủ:', e);
    return null;
  }
}

// ------------------------------------------------------- đọc thẳng máy chủ
/**
 * Đọc một document thẳng từ máy chủ, KHÔNG qua bản theo dõi trực tiếp
 * (onSnapshot) mà trang đang giữ trên chính document đó.
 *
 * Vì sao không dùng getDoc: khi document đang có onSnapshot, SDK web trả getDoc
 * (và cả getDocFromServer) bằng bản trong bộ nhớ của listener đó, không hỏi
 * máy chủ. Kênh theo dõi chết âm thầm mà SDK chưa nhận ra (điện thoại ngủ dậy
 * sau hạn, mạng chập chờn) thì getDoc trả lại đúng lịch cũ — hỏi lại cũng như
 * không: gia hạn thành "đã đóng", đóng sớm thành "vẫn đang mở". Đọc trong
 * transaction là một yêu cầu BatchGetDocuments riêng, không đi qua kênh theo
 * dõi, nên luôn là bản đang có trên máy chủ (rules cho mọi người đã đăng nhập
 * đọc meal_surveys).
 *
 * Trả kết quả ngay khi đọc xong, không chờ bước commit của transaction (transaction
 * chỉ đọc nên commit chỉ kiểm phiên bản, không ghi gì): commit lỗi hay SDK chạy
 * lại hàm thì kết quả đã đọc vẫn đúng. Lỗi mạng thì SDK tự thử lại vài lần rồi
 * mới báo lỗi, nên người gọi tự giới hạn thời gian chờ (settleWithin).
 */
function readFromServer(ref: DocumentReference): Promise<DocumentSnapshot> {
  return new Promise((resolve, reject) => {
    runTransaction(db, async tx => {
      resolve(await tx.get(ref));
    }).catch(reject);
  });
}

async function loadSurveyPage(uid: string, requested: string | null, now: number): Promise<Loaded> {
  const at = new Date(now);
  const surveys = collection(db, 'meal_surveys');
  const [activeSnap, staffSnap] = await Promise.all([
    // Các tuần chưa hết hạn (đang mở hoặc sắp mở): lọc một trường, không cần chỉ mục ghép.
    getDocs(query(surveys, where('closesAt', '>', at))),
    // Hồ sơ chỉ để ghi kèm họ tên; đọc lỗi thì vẫn cho làm khảo sát.
    getDoc(doc(db, 'staff', uid)).catch(e => {
      console.warn('Không đọc được hồ sơ nhân viên:', e);
      return null;
    }),
  ]);

  const active = activeSnap.docs
    .filter(d => isRealWeekId(d.id))
    .map(d => ({ weekId: d.id, ...parseWeek(d.data()) }))
    .filter((x): x is { weekId: string; survey: SurveyWindow; skipped: boolean } => !!x.survey);
  const open = active.filter(x => windowOpen(x.survey, now)).sort((a, b) => b.weekId.localeCompare(a.weekId));
  const soon = active.filter(x => x.survey.opensAt > now).sort((a, b) => a.survey.opensAt - b.survey.opensAt);

  let weekId: string | null = requested;
  let info: WeekInfo | null = null;
  if (weekId) {
    const hit = active.find(x => x.weekId === weekId);
    if (hit) info = hit;
    else {
      const s = await getDoc(doc(db, 'meal_surveys', weekId));
      info = s.exists() ? parseWeek(s.data()) : { survey: null, skipped: false };
    }
  } else {
    // Không chỉ định tuần: khảo sát đang mở -> sắp mở -> tuần gần nhất đã đóng.
    const pick = open[0] ?? soon[0];
    if (pick) {
      weekId = pick.weekId;
      info = pick;
    } else {
      const closed = await getDocs(query(surveys, where('closesAt', '<=', at), orderBy('closesAt', 'desc'), limit(1)));
      const d = closed.docs.find(x => isRealWeekId(x.id));
      if (d) {
        weekId = d.id;
        info = parseWeek(d.data());
      }
    }
  }

  // Lần mở mặc định kế tiếp (15:00 thứ 6) để báo trước: tuần này nếu tuần này
  // chưa có document, ngược lại tuần sau.
  const thisWeek = weekStartOf(vnParts(at)?.date ?? vnToday());
  const respWeek = weekId && info?.survey ? weekId : null;
  // Hai lần đọc độc lập, chạy song song cho trang mở nhanh trên mạng điện thoại.
  const [thisWeekExists, saved] = await Promise.all([
    weekId === thisWeek
      ? Promise.resolve(!!info && (!!info.survey || info.skipped))
      : active.some(x => x.weekId === thisWeek)
        ? Promise.resolve(true)
        : getDoc(doc(db, 'meal_surveys', thisWeek)).then(s => s.exists()),
    respWeek
      ? getDoc(doc(db, 'meal_surveys', respWeek, 'responses', uid)).then(s => parseResponse(s.data()))
      : Promise.resolve(null),
  ]);
  const upcomingWeek = thisWeekExists ? shiftDate(thisWeek, 7) : thisWeek;

  const staff = staffSnap?.exists() ? staffSnap.data() : null;
  const other = open.find(x => x.weekId !== weekId);
  return {
    weekId,
    survey: info?.survey ?? null,
    skipped: info?.skipped ?? false,
    saved,
    profile: staff ? { fullName: str(staff.fullName), employeeId: str(staff.employeeId), department: str(staff.department) } : null,
    upcoming: { weekId: upcomingWeek, opensAt: Date.parse(surveyDefaultOpensAt(upcomingWeek)) },
    otherOpen: other ? { weekId: other.weekId, closesAt: other.survey.closesAt } : null,
  };
}

const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : '';
};

function toLoadError(e: unknown): ViewError {
  const code = codeOf(e);
  if (code === 'permission-denied') {
    return {
      title: 'Chưa xem được khảo sát',
      detail: 'Tài khoản chưa đọc được dữ liệu khảo sát. Thầy/Cô thử đăng xuất rồi đăng nhập lại; nếu vẫn lỗi, xin báo Nhóm Dinh dưỡng.',
    };
  }
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return { title: 'Không kết nối được máy chủ', detail: 'Vui lòng kiểm tra kết nối mạng rồi bấm Thử lại.' };
  }
  return { title: 'Chưa tải được khảo sát', detail: `Vui lòng thử lại sau ít phút.${code ? ` (Mã lỗi: ${code})` : ''}` };
}

const OFFLINE_ERROR: ViewError = {
  title: 'Thiết bị đang mất kết nối mạng',
  detail: 'Câu trả lời chưa được gửi. Thầy/Cô kiểm tra Wi-Fi hoặc dữ liệu di động rồi bấm gửi lại — các câu đã điền vẫn được giữ nguyên.',
};

/**
 * Hỏi lại máy chủ (lúc tới hạn, hay khi gửi bị từ chối) chờ tối đa chừng này.
 * Mất mạng thì SDK thử lại nhiều lần hoặc treo yêu cầu tới khi có mạng: quá
 * thời gian này thì lúc tới hạn tin đồng hồ máy (hiện "đã đóng"; nếu sau đó máy
 * chủ báo đã gia hạn, form tự mở lại), còn khi gửi bị từ chối thì báo "chưa xác
 * định được" để nút gửi không quay mãi.
 */
const DEADLINE_RECHECK_MS = 10_000;

/** Kết quả của `p`, hoặc undefined nếu `p` lỗi hay quá `ms` (khi đó `p` vẫn chạy tiếp). */
function settleWithin<T>(p: Promise<T>, ms: number) {
  return new Promise<T | undefined>(resolve => {
    const timer = window.setTimeout(() => resolve(undefined), ms);
    p.then(
      v => {
        window.clearTimeout(timer);
        resolve(v);
      },
      () => {
        window.clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export default function MealSurvey() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const rawWeek = searchParams.get('tuan');
  const requestedWeek = isRealWeekId(rawWeek) ? rawWeek : null;
  const selfPath = location.pathname + location.search;

  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<PageData | null>(null);
  const [loadError, setLoadError] = useState<ViewError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [baseline, setBaseline] = useState(() => signature({}));
  const [validated, setValidated] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [viewFocus, setViewFocus] = useState(0);
  const [editing, setEditing] = useState(true);
  const [canCancelEdit, setCanCancelEdit] = useState(false);
  const [sending, setSending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [submitError, setSubmitError] = useState<ViewError | null>(null);
  const [restoredDraftAt, setRestoredDraftAt] = useState<string | null>(null);
  // `${weekId}|${closesAt}` của hạn mà lần hỏi lại máy chủ lúc tới hạn KHÔNG
  // cho được câu trả lời (lỗi, quá lâu): đành tin đồng hồ máy cho hạn đó.
  const [deadlineSettled, setDeadlineSettled] = useState<string | null>(null);
  // Tăng 1 sau mỗi lần hỏi lại xong, để effect xét lại (xem effect bên dưới).
  const [deadlineRound, setDeadlineRound] = useState(0);
  const deadlineInFlight = useRef(false);
  const generation = useRef(0);
  // Độ lệch đồng hồ máy so với máy chủ. Chỉ đo khi cần biết giờ thật: rules từ
  // chối ghi (xem submit) hoặc đồng hồ trang vừa qua hạn (recheckWeek). Mọi
  // "bây giờ" của trang đi qua clock().
  const skew = useRef(0);
  const clock = useCallback(() => Date.now() + skew.current, []);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(u => {
      if (u) setUser(u);
      // Link trong email mời trỏ thẳng tới đây kèm ?tuan=: đăng nhập xong phải
      // quay lại đúng tuần đó (Login và trang khai báo đều giữ nguyên `next`).
      else navigate(`/login?next=${encodeURIComponent(selfPath)}`, { replace: true });
    });
    return () => unsubscribe();
  }, [navigate, selfPath]);

  const load = useCallback(async () => {
    if (!user) return;
    const gen = ++generation.current;
    setLoadError(null);
    setData(null);
    setSubmitError(null);
    try {
      const startedAt = Date.now();
      const d = await loadSurveyPage(user.uid, requestedWeek, clock());
      if (gen !== generation.current) return;
      const initial = answersFrom(d.saved);
      // Bản nháp chưa gửi của tuần này (lỡ bấm sang trang khác rồi quay lại,
      // tải lại trang): điền lại vào form. Bản đã lưu mới hơn nháp (đã gửi từ
      // máy khác, hoặc nháp trùng bản đã gửi) thì nháp hết giá trị.
      let start = initial;
      let draftAt: string | null = null;
      if (d.weekId && d.survey) {
        const key = draftKey(user.uid, d.weekId);
        const draft = readDraft(key);
        const useful =
          !!draft &&
          signature(draft.answers) !== signature(initial) &&
          !(d.saved?.updatedAt && d.saved.updatedAt >= draft.at);
        if (draft && useful) {
          start = draft.answers;
          draftAt = draft.at;
        } else clearDraft(key);
      }
      setNow(clock());
      setData({ ...d, checkedAt: startedAt, firstClosesAt: d.survey?.closesAt ?? null });
      setAnswers(start);
      setBaseline(signature(initial));
      setRestoredDraftAt(draftAt);
      setValidated(false);
      // Đã trả lời rồi mà mở lại khi còn hạn: hiện ngay form điền sẵn để sửa.
      setEditing(true);
      setCanCancelEdit(false);
    } catch (e) {
      if (gen !== generation.current) return;
      console.error('Không tải được khảo sát:', e);
      setLoadError(toLoadError(e));
    }
  }, [user, requestedWeek, clock]);

  useEffect(() => {
    void load();
  }, [load]);

  // Đồng hồ cho đếm ngược và để trang tự chuyển "chưa mở" -> "đang mở" ->
  // "đã đóng" khi để mở lâu. Nhịp đồng hồ chỉ so giờ, không đọc Firestore; lúc
  // qua hạn thì effect hỏi lại máy chủ bên dưới lo.
  useEffect(() => {
    const tick = () => setNow(clock());
    const timer = window.setInterval(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [clock]);

  /**
   * Ghi lịch tuần vừa đọc từ máy chủ. `readAt` (giờ máy thô) là lúc bắt đầu
   * đọc; kết quả của lần đọc bắt đầu sớm hơn lần đã ghi thì bỏ — hai đường đọc
   * (theo dõi trực tiếp, hỏi lại lúc tới hạn) có thể trả về lệch thứ tự.
   */
  const applyWeek = useCallback((weekId: string, survey: SurveyWindow, readAt: number) => {
    setData(d => (d && d.weekId === weekId && readAt >= d.checkedAt ? { ...d, survey, checkedAt: readAt } : d));
  }, []);

  /**
   * Hỏi lại máy chủ, song song: lịch tuần mới nhất (quản trị có thể vừa gia hạn
   * hay đóng sớm) và giờ máy chủ (đồng hồ điện thoại có thể sai vài phút tới vài
   * giờ). Giờ máy chủ đo được thì giữ lại làm độ lệch cho mọi "bây giờ" của
   * trang. `fresh` null: không đọc được lịch; `offset` null: không hỏi được giờ.
   * Lịch đọc bằng readFromServer, không bằng getDoc: getDoc sẽ được trả từ bản
   * của chính listener theo dõi tuần này (xem readFromServer), mà lần hỏi lại
   * này chính là để phòng listener đó đã chết âm thầm.
   */
  const recheckWeek = useCallback(
    async (u: User, weekId: string) => {
      const startedAt = Date.now();
      const [fresh, offset] = await Promise.all([
        readFromServer(doc(db, 'meal_surveys', weekId))
          .then((s): WeekInfo => (s.exists() ? parseWeek(s.data()) : { survey: null, skipped: false }))
          .catch(err => {
            console.warn('Không đọc lại được lịch khảo sát:', err);
            return null;
          }),
        serverClockOffset(u),
      ]);
      if (offset !== null) skew.current = offset;
      if (fresh?.survey) applyWeek(weekId, fresh.survey, startedAt);
      setNow(clock());
      return { fresh, offset };
    },
    [applyWeek, clock],
  );

  // Theo dõi trực tiếp document của tuần đang hiện (một document, chỉ tốn một
  // lượt đọc lúc mở trang và một lượt mỗi khi document đổi — vài lần mỗi tuần).
  // Nhờ vậy "Gia hạn" / "Đóng ngay" của quản trị tới trang đang mở ngay lập
  // tức: gia hạn thì hạn và đếm ngược đổi luôn, không phải chờ tới hạn cũ mới
  // biết; đóng sớm thì trang chuyển "đã đóng" thay vì để Thầy/Cô điền xong mới
  // bị từ chối; mở lại sau khi đã đóng thì form quay lại cùng các câu đang điền.
  // Mất mạng rồi có lại, SDK tự nối lại và gửi bản mới. Nhưng kênh theo dõi có
  // thể chết âm thầm một lúc trước khi SDK nhận ra (máy ngủ dậy, mạng chập
  // chờn) và trong lúc đó không báo gì — nên lúc tới hạn và khi gửi bị từ chối,
  // trang vẫn hỏi lại máy chủ bằng đường đọc riêng (recheckWeek), không tin
  // riêng listener này.
  const watchedWeek = data?.weekId && data.survey ? data.weekId : null;
  useEffect(() => {
    if (!watchedWeek) return;
    return onSnapshot(
      doc(db, 'meal_surveys', watchedWeek),
      { includeMetadataChanges: true },
      snap => {
        // Bản trong bộ nhớ đệm (đang mất mạng) chưa chắc là lịch mới nhất: chờ
        // bản từ máy chủ (includeMetadataChanges để vẫn nhận được bản đó khi
        // nối lại mạng mà nội dung không đổi).
        if (snap.metadata.fromCache) return;
        const w = snap.exists() ? parseWeek(snap.data()).survey : null;
        // Document mất khung giờ (bị xoá): không phải thao tác của quản trị; để
        // rules và lời giải thích khi gửi bị từ chối lo, đừng làm mất form.
        if (!w) return;
        applyWeek(watchedWeek, w, Date.now());
        setNow(clock());
      },
      err => console.warn('Không theo dõi được lịch khảo sát:', err),
    );
  }, [watchedWeek, applyWeek, clock]);

  const survey = data?.survey ?? null;
  const localPhase = phaseOf(survey, now);
  const deadlineKey = data?.weekId && survey ? `${data.weekId}|${survey.closesAt}` : null;
  // Đồng hồ trang đã qua hạn, nhưng lịch đang giữ là bản đọc từ trước hạn và
  // chưa hỏi lại máy chủ cho hạn này: chưa được nói "đã đóng". Listener ở trên
  // có thể đã chết âm thầm (máy ngủ, mạng chập chờn) nên bản đó có thể đã cũ;
  // recheckWeek đọc thẳng máy chủ (readFromServer), không qua listener.
  const deadlineUnverified =
    localPhase === 'closed' && !!data && !!survey && data.checkedAt + skew.current < survey.closesAt && deadlineSettled !== deadlineKey;
  const phase: Phase = deadlineUnverified ? 'open' : localPhase;

  useEffect(() => {
    if (!deadlineUnverified || !user || !data?.weekId || !deadlineKey || deadlineInFlight.current) return;
    deadlineInFlight.current = true;
    const key = deadlineKey;
    void settleWithin(recheckWeek(user, data.weekId), DEADLINE_RECHECK_MS).then(res => {
      deadlineInFlight.current = false;
      // Hỏi được lịch thì lịch mới (và lúc đọc) đã nằm trong data: vẫn hết hạn
      // thì checkedAt đã qua hạn -> "đã đóng"; gia hạn, hay đồng hồ máy chạy
      // nhanh (độ lệch vừa đo kéo giờ trang lùi lại) thì form ở lại, và tới hạn
      // thật sẽ hỏi lại lần nữa — KHÔNG chốt hạn này chỉ vì đã hỏi một lần.
      // Không hỏi được (lỗi, quá lâu, tuần mất khung giờ): tin đồng hồ máy cho
      // hạn này; theo dõi trực tiếp vẫn mở lại form nếu sau đó máy chủ báo gia hạn.
      if (!res?.fresh?.survey) setDeadlineSettled(key);
      // Xét lại sau mỗi lần hỏi: hạn rơi đúng vào lúc đang hỏi thì vẫn "chưa
      // kiểm" — lần sau bắt đầu sau hạn nên kết luận được.
      setDeadlineRound(n => n + 1);
    });
  }, [deadlineUnverified, user, data?.weekId, deadlineKey, deadlineRound, recheckWeek]);

  // Có câu đã sửa mà chưa gửi được (so với bản đang lưu, hoặc form trống).
  const unsentEdits = editing && signature(answers) !== baseline;
  const weekDraftKey = user && data?.weekId && data.survey ? draftKey(user.uid, data.weekId) : null;
  // Hạn đã được dời muộn hơn lúc mở trang: báo trên thẻ đầu form.
  const extendedFrom =
    survey && data?.firstClosesAt != null && survey.closesAt > data.firstClosesAt ? data.firstClosesAt : null;

  // Lưu nháp sau mỗi lần sửa khi khảo sát đang mở; sửa về đúng bản đã lưu thì
  // xoá nháp. Khi đã đóng thì giữ nguyên nháp: tải lại trang vẫn thấy các câu
  // chưa gửi được (màn "đã đóng" hiện chúng, chỉ đọc), và nếu quản trị gia hạn
  // thì form mở lại với đúng các câu đó.
  useEffect(() => {
    if (!weekDraftKey || phase !== 'open' || !editing) return;
    if (unsentEdits) writeDraft(weekDraftKey, answers, clock());
    else clearDraft(weekDraftKey);
  }, [weekDraftKey, phase, editing, unsentEdits, answers, clock]);

  // Đóng tab / tải lại khi còn câu chưa gửi: trình duyệt hỏi lại. Chỉ có tác
  // dụng với hai thao tác đó — chuyển trang trong app (thanh menu, logo) không
  // qua đây; trường hợp ấy do bản nháp ở trên lo.
  const dirty = phase === 'open' && unsentEdits;
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Khảo sát đóng ngay trên màn hình (tới hạn khi đang điền và máy chủ xác
  // nhận, hoặc gửi bị từ chối vì đã đóng): form biến mất cùng ô đang giữ con
  // trỏ — đưa con trỏ và màn hình về thẻ "đã đóng" để Thầy/Cô thấy ngay chuyện
  // gì xảy ra. Ngược lại, quản trị gia hạn khi Thầy/Cô đang xem màn "đã đóng":
  // form quay lại, đưa về tiêu đề form (có dòng "đã gia hạn") và bỏ lời báo
  // "đã đóng" của lần gửi bị từ chối trước đó.
  const prevPhase = useRef(phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = phase;
    const closedNow = was === 'open' && phase === 'closed';
    const reopened = was === 'closed' && phase === 'open';
    if (reopened) setSubmitError(null);
    if (closedNow || reopened) {
      setViewFocus(n => n + 1);
      window.scrollTo({ top: 0 });
    }
  }, [phase]);

  // Lỗi chỉ hiện sau lần bấm gửi đầu tiên; từ đó cập nhật ngay khi Thầy/Cô sửa.
  const errors = useMemo(() => (validated ? validateSurveyAnswers(answers).errors : {}), [validated, answers]);

  const submit = async () => {
    if (!user || !data?.weekId || !data.survey || sending) return;
    const v = validateSurveyAnswers(answers);
    setValidated(true);
    if (!v.ok) {
      setFocusRequest(n => n + 1);
      return;
    }
    if (navigator.onLine === false) {
      setSubmitError(OFFLINE_ERROR);
      return;
    }
    const weekId = data.weekId;
    const ref = doc(db, 'meal_surveys', weekId, 'responses', user.uid);
    setSending(true);
    setSlow(false);
    setSubmitError(null);
    // Firestore giữ yêu cầu ghi chờ mạng chứ không báo lỗi ngay: quá 12 giây
    // thì báo "mạng chậm" để Thầy/Cô không tưởng trang bị treo.
    const slowTimer = window.setTimeout(() => setSlow(true), 12_000);
    try {
      // submittedAt giữ lần gửi ĐẦU: đọc lại bản đang lưu, phòng khi Thầy/Cô
      // đã gửi từ thiết bị khác sau lúc mở trang này.
      let firstAt = data.saved?.submittedAt ?? null;
      try {
        const prev = await getDoc(ref);
        if (prev.exists()) firstAt = str(prev.data().submittedAt) || firstAt;
      } catch (e) {
        console.warn('Không đọc lại được câu trả lời cũ:', e);
      }
      const at = new Date(clock()).toISOString();
      // Đúng các khoá rules cho phép; answers là bản đã làm sạch (câu không bắt
      // buộc để trống thì không có khoá). setDoc ghi đè cả document để câu đã
      // xoá trắng khi sửa cũng mất khỏi bản lưu.
      await setDoc(ref, {
        uid: user.uid,
        weekId,
        version: SURVEY_VERSION,
        answers: v.clean,
        fullName: data.profile?.fullName || user.displayName || '',
        employeeId: data.profile?.employeeId || '',
        department: data.profile?.department || '',
        email: user.email || '',
        submittedAt: firstAt || at,
        updatedAt: at,
      });
      const saved: SavedResponse = { answers: v.clean, submittedAt: firstAt || at, updatedAt: at };
      clearDraft(draftKey(user.uid, weekId));
      setRestoredDraftAt(null);
      setData(d => (d && d.weekId === weekId ? { ...d, saved } : d));
      const fresh = answersFrom(saved);
      setAnswers(fresh);
      setBaseline(signature(fresh));
      setValidated(false);
      setEditing(false);
      setCanCancelEdit(false);
      setNow(clock());
      setViewFocus(n => n + 1);
      window.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (e) {
      console.error('Không gửi được khảo sát:', e);
      const code = codeOf(e);
      if (code === 'permission-denied') {
        setSubmitError(await explainDenied(user, weekId));
      } else if (code === 'unavailable' || code === 'deadline-exceeded') {
        setSubmitError(OFFLINE_ERROR);
      } else {
        setSubmitError({
          title: 'Chưa gửi được câu trả lời',
          detail: `Vui lòng bấm gửi lại sau ít phút — các câu đã điền vẫn được giữ nguyên.${code ? ` (Mã lỗi: ${code})` : ''}`,
        });
      }
    } finally {
      window.clearTimeout(slowTimer);
      setSending(false);
      setSlow(false);
    }
  };

  /**
   * Rules chỉ nhận trả lời trong [opensAt, closesAt) theo giờ MÁY CHỦ. Bị từ
   * chối thì hỏi lại song song lịch tuần mới nhất (quản trị có thể vừa đóng sớm
   * hay gia hạn) và giờ máy chủ (đồng hồ điện thoại có thể sai vài phút tới vài
   * giờ), rồi mới kết luận — không đoán theo đồng hồ máy. Giờ máy chủ đo được
   * thì giữ lại làm độ lệch, để trang chuyển hẳn sang "đã đóng" cho đúng, không
   * quay lại form ở nhịp đồng hồ sau rồi lại bị từ chối. Lịch mới (kể cả hạn
   * vừa được gia hạn) được ghi vào trang qua recheckWeek — đọc thẳng máy chủ,
   * không lấy bản của listener (listener chết âm thầm thì bản đó còn hạn cũ và
   * trang sẽ nói nhầm "vẫn đang mở" sau khi quản trị đã "Đóng ngay").
   */
  const explainDenied = async (u: User, weekId: string): Promise<ViewError> => {
    const unknown: ViewError = {
      title: 'Chưa xác định được trạng thái khảo sát',
      detail:
        'Câu trả lời chưa được ghi nhận và hệ thống chưa kiểm tra được khảo sát còn mở hay không. Thầy/Cô kiểm tra kết nối mạng rồi bấm gửi lại; nếu vẫn lỗi, tải lại trang — các câu đã điền vẫn được giữ nguyên.',
    };
    // Cùng giới hạn chờ như lúc tới hạn: mạng treo thì nút gửi không quay mãi.
    // Lần hỏi vẫn chạy tiếp; trả lời muộn vẫn được ghi vào trang qua recheckWeek.
    const res = await settleWithin(recheckWeek(u, weekId), DEADLINE_RECHECK_MS);
    if (!res) return unknown;
    const { fresh, offset } = res;
    const w = fresh?.survey ?? null;
    const c = clock();
    const label = surveyWeekLabel(weekId);
    // Không đọc lại được lịch tuần: chưa biết vì sao bị từ chối, đừng nói "đã đóng".
    if (!fresh) return unknown;
    if (!w || c >= w.closesAt) {
      return {
        title: 'Khảo sát đã đóng, câu trả lời chưa được ghi nhận',
        detail: w
          ? `Khảo sát tuần ${label} đã kết thúc lúc ${surveyDeadlineText(w.closesAt)}. Nếu cần góp ý thêm, Thầy/Cô vui lòng liên hệ Nhóm Dinh dưỡng.`
          : `Khảo sát tuần ${label} không còn nhận trả lời. Nếu cần góp ý thêm, Thầy/Cô vui lòng liên hệ Nhóm Dinh dưỡng.`,
      };
    }
    if (c < w.opensAt) {
      return {
        title: 'Khảo sát chưa mở, câu trả lời chưa được ghi nhận',
        detail: `Khảo sát tuần ${label} mở lúc ${surveyMomentText(w.opensAt, true)}. Các câu đã điền vẫn được giữ; Thầy/Cô gửi lại sau giờ mở.`,
      };
    }
    // Theo đồng hồ máy thì vẫn đang mở, nhưng không hỏi được giờ máy chủ: có
    // thể đồng hồ máy sai, cũng có thể lỗi khác — không kết luận.
    if (offset === null) return unknown;
    // Giờ máy chủ xác nhận khảo sát đang mở mà vẫn bị từ chối: lỗi quyền thật.
    return {
      title: 'Chưa gửi được câu trả lời',
      detail:
        'Khảo sát vẫn đang mở nhưng hệ thống chưa cho phép tài khoản ghi câu trả lời. Thầy/Cô thử đăng xuất rồi đăng nhập lại; nếu vẫn lỗi, xin báo Nhóm Dinh dưỡng.',
    };
  };

  const startEdit = () => {
    setEditing(true);
    setCanCancelEdit(true);
    setSubmitError(null);
    setViewFocus(n => n + 1);
    window.scrollTo({ top: 0 });
  };

  const cancelEdit = () => {
    const restored = answersFrom(data?.saved ?? null);
    if (user && data?.weekId) clearDraft(draftKey(user.uid, data.weekId));
    setRestoredDraftAt(null);
    setAnswers(restored);
    setBaseline(signature(restored));
    setValidated(false);
    setEditing(false);
    setCanCancelEdit(false);
    setSubmitError(null);
    setViewFocus(n => n + 1);
    window.scrollTo({ top: 0 });
  };

  // Bỏ bản nháp vừa khôi phục, quay về bản đã gửi (hoặc form trống). Nút bấm
  // biến mất cùng thông báo nháp nên đưa con trỏ về tiêu đề form.
  const discardDraft = () => {
    if (user && data?.weekId) clearDraft(draftKey(user.uid, data.weekId));
    setRestoredDraftAt(null);
    setAnswers(answersFrom(data?.saved ?? null));
    setValidated(false);
    setSubmitError(null);
    setViewFocus(n => n + 1);
  };

  return (
    <div className="font-body-lg flex min-h-screen min-w-0 flex-col pt-16 pb-24 md:pt-0 md:pb-0 md:pl-64">
      <Header />
      <Navigation />
      <SurveyView
        loading={!loadError && !data}
        error={loadError}
        onRetry={() => void load()}
        now={now}
        weekId={data?.weekId ?? null}
        survey={data?.survey ?? null}
        skipped={data?.skipped}
        saved={data?.saved ?? null}
        profile={data?.profile ?? null}
        editing={editing}
        answers={answers}
        errors={errors}
        focusRequest={focusRequest}
        onAnswer={(id, value) => setAnswers(a => ({ ...a, [id]: value }))}
        onSubmit={() => void submit()}
        onEdit={startEdit}
        onCancelEdit={canCancelEdit ? cancelEdit : undefined}
        sending={sending}
        slow={slow}
        submitError={submitError}
        upcoming={data?.upcoming ?? null}
        otherOpen={data?.otherOpen ?? null}
        unsentEdits={unsentEdits}
        restoredDraftAt={restoredDraftAt}
        onDiscardDraft={discardDraft}
        viewFocus={viewFocus}
        checkingDeadline={deadlineUnverified}
        extendedFrom={extendedFrom}
      />
      <Footer />
    </div>
  );
}
