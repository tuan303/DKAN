import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { isSurveyOpen, isWeekId, shiftDate, surveyRecipientUids, surveyWeekLabel, toMillis } from '../../agent/lib/survey.mjs';
import { formatDate, formatDayLabel, vnParts } from '../../agent/lib/meal-rules.mjs';

// ====================================================================
// Cách viết mốc giờ của khảo sát — dùng chung cho thanh nhắc này và trang
// /khao-sat, để hai nơi (và email mời) nói cùng một kiểu.
// ====================================================================

/**
 * Mã tuần dùng được: isWeekId của survey.mjs, thêm điều kiện ngày có thật.
 * `new Date('2026-02-30')` tự lăn sang 02/03 (đúng thứ 2) nên isWeekId vẫn nhận;
 * link gõ tay `?tuan=2026-02-30` sẽ mở một "tuần 30/02" không tồn tại.
 */
export const isRealWeekId = (v: unknown): v is string => isWeekId(v) && shiftDate(v as string, 0) === v;

/** "thứ 6" / "chủ nhật" — lấy từ formatDayLabel để không khai lại tên thứ. */
function weekdayOf(iso: string) {
  const label = formatDayLabel(iso);
  const name = label.slice(0, label.indexOf(','));
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * "12h00 thứ 2, ngày 12/10/2026" — đúng cách viết của mẫu email Nhóm Dinh dưỡng
 * (surveyDeadlineLabel). Tính từ closesAt THẬT của document tuần chứ không từ
 * mã tuần: quản trị có thể gia hạn hoặc đóng sớm.
 */
export function surveyDeadlineText(ms: number) {
  const p = vnParts(ms);
  return p ? `${p.time.replace(':', 'h')} ${weekdayOf(p.date)}, ngày ${formatDate(p.date)}` : '';
}

/** "15:00 thứ 6, 09/10" (kèm "/2026" nếu withYear). */
export function surveyMomentText(ms: number, withYear = false) {
  const p = vnParts(ms);
  if (!p) return '';
  return `${p.time} ${weekdayOf(p.date)}, ${p.date.slice(8, 10)}/${p.date.slice(5, 7)}${withYear ? `/${p.date.slice(0, 4)}` : ''}`;
}

/** "còn 2 ngày 3 giờ" — làm tròn xuống theo phút, không bao giờ hứa dư thời gian. */
export function surveyCountdownText(msLeft: number) {
  if (msLeft <= 0) return 'đã hết hạn';
  const totalMin = Math.floor(msLeft / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `còn ${d} ngày ${h} giờ` : `còn ${d} ngày`;
  if (h > 0) return m > 0 ? `còn ${h} giờ ${m} phút` : `còn ${h} giờ`;
  if (m > 0) return `còn ${m} phút`;
  return 'còn chưa đầy 1 phút';
}

/** Màu nhắc hạn: còn dưới 1 ngày thì vàng, dưới 2 giờ thì đỏ. */
export function surveyCountdownTone(msLeft: number): 'normal' | 'soon' | 'urgent' {
  if (msLeft < 2 * 3_600_000) return 'urgent';
  if (msLeft < 24 * 3_600_000) return 'soon';
  return 'normal';
}

export const COUNTDOWN_CHIP: Record<ReturnType<typeof surveyCountdownTone>, string> = {
  normal: 'bg-tertiary-container text-on-tertiary-container border-tertiary/25',
  soon: 'bg-warning-container text-on-warning-container border-warning/40',
  urgent: 'bg-error-container text-on-error-container border-error/30',
};

// ====================================================================
// Phần trình bày thuần (props), để xem trước được bằng dữ liệu giả.
// ====================================================================

export interface PendingSurvey {
  weekId: string;
  /** Hạn trả lời (mili giây). */
  closesAt: number;
}

export interface SurveyBannerViewProps extends PendingSurvey {
  now: number;
  /**
   * Các khảo sát KHÁC đang mở mà Thầy/Cô cũng chưa trả lời (hạn muộn hơn tuần
   * chính). Thanh nhắc chỉ có một nút lớn cho tuần sắp hết hạn nhất; các tuần
   * còn lại được nhắc một dòng kèm link để Thầy/Cô không tưởng làm xong một
   * tuần là hết việc.
   */
  others?: PendingSurvey[];
}

export function SurveyBannerView({ weekId, closesAt, now, others = [] }: SurveyBannerViewProps) {
  const left = closesAt - now;
  const tone = surveyCountdownTone(left);
  return (
    <section
      aria-labelledby="survey-banner-title"
      className="animate-in rounded-xl border border-primary/15 border-l-4 border-l-secondary bg-surface-container-lowest shadow-sm p-sm md:p-md flex flex-col sm:flex-row sm:items-center gap-sm md:gap-md"
    >
      <div className="flex items-start gap-sm md:gap-md min-w-0 flex-1">
        <div className="w-10 h-10 md:w-11 md:h-11 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-[22px]" aria-hidden="true">rate_review</span>
        </div>
        <div className="min-w-0">
          <p id="survey-banner-title" className="text-label-lg text-on-surface">
            Mời Thầy/Cô tham gia khảo sát suất ăn tuần{' '}
            <span className="tabular whitespace-nowrap">{surveyWeekLabel(weekId)}</span>
          </p>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            Chỉ mất khoảng 1 phút. Hạn trả lời:{' '}
            <strong className="text-on-surface tabular whitespace-nowrap">{surveyDeadlineText(closesAt)}</strong>{' '}
            <span className={clsx('inline-block px-1.5 py-px rounded-full border text-label-sm align-middle whitespace-nowrap', COUNTDOWN_CHIP[tone])}>
              {surveyCountdownText(left)}
            </span>
          </p>
          {others.length > 0 && (
            <p className="text-body-sm text-on-surface-variant mt-1">
              {others.length === 1 ? 'Ngoài ra còn khảo sát ' : `Ngoài ra còn ${others.length} khảo sát chưa trả lời: `}
              {others.map((o, i) => (
                <Fragment key={o.weekId}>
                  {i > 0 && ', '}
                  <Link
                    to={`/khao-sat?tuan=${o.weekId}`}
                    className="font-semibold text-primary underline underline-offset-2 hover:text-primary-dark"
                  >
                    tuần <span className="tabular whitespace-nowrap">{surveyWeekLabel(o.weekId)}</span>
                  </Link>{' '}
                  <span className="tabular whitespace-nowrap">(hạn {surveyMomentText(o.closesAt)})</span>
                </Fragment>
              ))}
              {others.length === 1 ? ' chưa trả lời.' : '.'}
            </p>
          )}
        </div>
      </div>
      <Link
        to={`/khao-sat?tuan=${weekId}`}
        className="shrink-0 inline-flex items-center justify-center gap-1.5 w-full sm:w-auto px-md py-2.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary-dark transition-colors"
      >
        Làm khảo sát
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">arrow_forward</span>
      </Link>
    </section>
  );
}

// ====================================================================
// Phần tải dữ liệu
// ====================================================================

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Các tháng mà tuần chạm tới — tuần vắt qua hai tháng thì xét đơn của cả hai, như máy gửi thư. */
const monthsOfWeek = (weekId: string) => [...new Set([weekId.slice(0, 7), shiftDate(weekId, 4).slice(0, 7)])];

/**
 * Các khảo sát đang mở mà Thầy/Cô được mời nhưng chưa trả lời, hạn sớm nhất
 * trước (rỗng nếu không có).
 *
 * Xét MỌI tuần đang mở chứ không chỉ tuần mới nhất: sáng thứ 2 quản trị có thể
 * bấm "Mở khảo sát tuần này" khi tuần trước còn nhận trả lời tới 12:00 (hoặc
 * vừa gia hạn tuần trước). Chỉ nhìn tuần mới nhất thì thanh nhắc giấu đúng tuần
 * sắp hết hạn, trả lời xong tuần mới là thanh nhắc biến mất dù tuần cũ vẫn chưa
 * trả lời, và người chỉ được mời tuần cũ thì không được nhắc gì.
 *
 * Một truy vấn các tuần chưa hết hạn (lọc một trường, không cần chỉ mục ghép);
 * chỉ khi có tuần đang mở mới đọc thêm câu trả lời (mỗi tuần một), đơn đăng ký,
 * danh sách loại trừ và ngày nghỉ (đọc chung một lần cho mọi tuần) — thanh nhắc
 * nằm trên trang ai cũng mở hằng ngày, đừng tốn đọc.
 *
 * Chỉ nhắc đúng người email mời (surveyRecipientUids, cùng quy tắc với máy gửi
 * thư, kể cả ngày nghỉ): người không ăn ở trường mở trang đăng ký thì không bị
 * mời khảo sát bữa ăn họ không ăn, và câu trả lời của họ không làm lệch kết quả.
 *
 * `now` chỉ để thử với giờ giả; trang thật dùng giờ máy.
 */
export async function findPendingSurveys(uid: string, now = new Date()): Promise<PendingSurvey[]> {
  const snap = await getDocs(query(collection(db, 'meal_surveys'), where('closesAt', '>', now)));
  const open: PendingSurvey[] = [];
  for (const d of snap.docs) {
    if (!isRealWeekId(d.id) || !isSurveyOpen(d.data(), now)) continue;
    const closesAt = toMillis(d.data().closesAt);
    if (closesAt !== null) open.push({ weekId: d.id, closesAt });
  }
  if (!open.length) return [];

  const months = [...new Set(open.flatMap(w => monthsOfWeek(w.weekId)))];
  const [answered, regSnaps, excludes, offDaysSnap] = await Promise.all([
    Promise.all(open.map(w => getDoc(doc(db, 'meal_surveys', w.weekId, 'responses', uid)))),
    Promise.all(months.map(m => getDoc(doc(db, 'registrations', `${uid}_${m}`)))),
    // Không đọc được danh sách loại trừ thì coi như không loại ai: nhắc thừa
    // một người bếp còn hơn làm mất thanh nhắc của mọi người.
    getDoc(doc(db, 'settings', 'reconcileExcludes')).catch(() => null),
    // Ngày nghỉ quản trị khai (ai đăng nhập cũng đọc được): người chỉ có đơn
    // phủ đúng những ngày nghỉ trong tuần thì máy gửi thư không mời, thanh nhắc
    // cũng không được nhắc. Đọc lỗi thì coi như không có ngày nghỉ — cùng lý do
    // như danh sách loại trừ ở trên.
    getDoc(doc(db, 'settings', 'mealOffDays')).catch(() => null),
  ]);
  const regOfMonth = new Map(months.map((m, i) => [m, regSnaps[i].data()]));
  const excludedIds = strings(excludes?.data()?.employeeIds);
  const offDays = strings(offDaysSnap?.data()?.dates);

  return open
    .filter((w, i) => {
      if (answered[i].exists()) return false;
      const weekMonths = monthsOfWeek(w.weekId);
      const registrations = weekMonths.flatMap(m => {
        const r = regOfMonth.get(m);
        if (!r) return [];
        // Đơn nằm nhầm id (của tài khoản khác / tháng khác): máy gửi thư cũng bỏ.
        if ((r.userId !== undefined && r.userId !== uid) || (r.month !== undefined && !weekMonths.includes(r.month))) return [];
        return [{ ...r, uid }];
      });
      return surveyRecipientUids({ registrations, weekId: w.weekId, excludedIds, offDays }).includes(uid);
    })
    .sort((a, b) => a.closesAt - b.closesAt || a.weekId.localeCompare(b.weekId));
}

/** Quay lại tab thì đọc lại, nhưng không dày hơn mức này. */
const RECHECK_ON_VISIBLE_MS = 60_000;

/**
 * Thanh nhắc làm khảo sát, đặt ở đầu trang của CBNV. Chỉ hiện khi có khảo sát
 * đang mở, Thầy/Cô có đăng ký ăn trong tuần đó và chưa trả lời; có nhiều tuần
 * như vậy thì nhắc tuần hết hạn sớm nhất và ghi thêm các tuần còn lại. Không bao
 * giờ chặn trang chủ: chưa tải xong, không có khảo sát hay lỗi đọc (vd rules
 * chưa triển khai) thì đơn giản là không hiện gì. `className` bọc bên ngoài (lề,
 * khoảng cách) cũng biến mất theo.
 */
export function SurveyBanner({ className }: { className?: string }) {
  const [uid, setUid] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSurvey[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // Tăng 1 để đọc lại danh sách (một tuần vừa tới hạn, quay lại tab).
  const [reload, setReload] = useState(0);
  const lastLoad = useRef(0);

  useEffect(() => auth.onAuthStateChanged(user => setUid(user?.uid ?? null)), []);

  useEffect(() => {
    if (!uid) {
      setPending([]);
      return;
    }
    let cancelled = false;
    lastLoad.current = Date.now();
    findPendingSurveys(uid)
      .then(p => {
        if (!cancelled) {
          setNow(Date.now());
          setPending(p);
        }
      })
      // Lỗi đọc: giữ danh sách đang có (vẫn tự ẩn tuần hết hạn), không chặn trang.
      .catch(e => console.warn('Không kiểm tra được khảo sát suất ăn:', e));
    return () => {
      cancelled = true;
    };
  }, [uid, reload]);

  // Tuần đã tới hạn theo đồng hồ máy thì không nhắc nữa; tuần kế (nếu có) lên thay.
  const live = pending.filter(p => p.closesAt > now);
  const expired = pending.length - live.length;
  const showing = live.length > 0;

  // Cập nhật số "còn … giờ" và tự ẩn / chuyển tuần khi hết hạn nếu trang để mở lâu.
  useEffect(() => {
    if (!showing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [showing]);

  // Một tuần vừa tới hạn theo đồng hồ máy: đọc lại một lần. Quản trị có thể đã
  // gia hạn tuần đó (đồng hồ máy cũng có thể sai) — đọc lại thì thanh nhắc theo
  // lịch thật thay vì tự giấu. Không lặp: truy vấn chỉ trả về tuần chưa hết hạn
  // nên sau lần đọc này `expired` về 0; đọc lỗi thì `expired` giữ nguyên, effect
  // không chạy lại.
  useEffect(() => {
    if (expired > 0) setReload(n => n + 1);
  }, [expired]);

  // Quay lại tab khi đang có nhắc: đọc lại (tối đa mỗi phút một lần). Thầy/Cô
  // có thể vừa trả lời ở tab khác (bấm link trong email) — thanh nhắc phải
  // chuyển sang tuần còn lại hoặc biến mất, không nhắc tuần đã trả lời.
  useEffect(() => {
    if (!showing) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      if (Date.now() - lastLoad.current >= RECHECK_ON_VISIBLE_MS) setReload(n => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [showing]);

  if (!showing) return null;
  const [first, ...others] = live;
  return (
    <div className={className}>
      <SurveyBannerView weekId={first.weekId} closesAt={first.closesAt} now={now} others={others} />
    </div>
  );
}
