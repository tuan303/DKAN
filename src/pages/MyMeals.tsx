import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { Header } from '../components/Header';
import { Navigation } from '../components/Navigation';
import { Footer } from '../components/Footer';
import { SurveyBanner } from '../components/SurveyBanner';
import {
  MEALS,
  MEAL_LABEL,
  MEAL_WINDOWS,
  describeNotExpected,
  evaluatePersonDay,
  formatDate,
  formatDayLabel,
  formatVnDateTime,
  isUsableId,
  isWeekday,
  mealDaysOfMonth,
  normId,
  toMinutes,
  vnParts,
  vnToday,
} from '../../agent/lib/meal-rules.mjs';

// Mọi kiểu dưới đây lấy thẳng từ meal-rules.mjs (JSDoc) chứ không khai lại: khi
// file quy tắc thêm một mã trạng thái mới, TypeScript sẽ báo ngay bảng STATUS ở
// trang này thiếu nhãn, thay vì lặng lẽ hiện ô trống cho người dùng.
type EvalInput = Parameters<typeof evaluatePersonDay>[0];
export type DayResult = ReturnType<typeof evaluatePersonDay>;
export type Registration = NonNullable<EvalInput['registration']>;
type Cancelation = NonNullable<EvalInput['cancelations']>[number];
type Meal = (typeof MEALS)[number];
type MealStatus = DayResult['meals'][Meal];
type MealCode = MealStatus['code'];

const NUTRITION_EMAIL = 'dinhduong@hoangmaistarschool.edu.vn';
const SELF_PATH = '/cham-an';

// ====================================================================
// Phần trình bày thuần: chỉ nhận props, không đọc Firestore, không gọi
// đồng hồ. Tách riêng để xem trước được bằng dữ liệu giả cho đủ mọi trạng
// thái — chờ dữ liệu thật thì phải đợi đúng ngày có người quên chấm.
// ====================================================================

export interface SyncDevice {
  name: string;
  ok: boolean;
  error: string | null;
  lastOkAt: string | null;
}

export interface SyncInfo {
  lastRunAt: string | null;
  lastCompleteAt: string | null;
  lastRunComplete: boolean | null;
  devices: SyncDevice[];
}

export interface ViewError {
  title: string;
  detail: string;
}

/**
 * Vì sao một bữa "Chưa có dữ liệu" sẽ KHÔNG tự được chốt ở lần đồng bộ sau —
 * để trang không hứa suông "trạng thái được chốt sau giờ ăn":
 *  - conflict: mã NV đang trùng giữa nhiều tài khoản, agent ngừng gán lượt chấm;
 *  - guarded: chốt an toàn của agent đã dừng gửi cảnh báo ngày này vì dữ liệu máy
 *    nhận diện bất thường (alerts[ngày].held) — chưa thể kết luận ai chưa chấm;
 *  - expired: ngày cũ hơn mốc đồng bộ còn lưu (coverage trong settings/checkinSync
 *    bị cắt bớt), không còn căn cứ để kết luận "chưa chấm".
 */
export type DayHold = 'conflict' | 'expired' | 'guarded';

export interface DayView {
  result: DayResult;
  hold: DayHold | null;
}

export interface ConflictInfo {
  ids: string[];
  /** Ngày (YYYY-MM-DD) hệ thống bắt đầu thấy trùng; null nếu không rõ. */
  from: string | null;
}

export interface MyMealsViewProps {
  /** Đang tải lần đầu (chưa có gì để hiện). */
  loading: boolean;
  /** Đang tải lại ngầm, dữ liệu cũ vẫn hiện trên màn hình. */
  refreshing?: boolean;
  error: ViewError | null;
  onRetry?: () => void;
  onReload?: () => void;
  /** Hồ sơ staff/{uid}; null nghĩa là Thầy/Cô chưa khai báo thông tin nhân viên. */
  profile: { fullName: string; employeeId: string } | null;
  /** Hôm nay theo giờ Việt Nam, YYYY-MM-DD. */
  todayIso: string;
  /** `registration` là đơn của tháng hiện tại. */
  today: (DayView & { registration: Registration | null }) | null;
  sync: SyncInfo | null;
  /** Mốc lịch đồng bộ (ISO) mà máy HAC đã lỡ, null nếu vẫn chạy đúng lịch. */
  missedSyncAt: string | null;
  /** Trùng mã NV trong THÁNG HIỆN TẠI (ảnh hưởng cả thẻ Hôm nay). */
  conflict: ConflictInfo | null;
  month: string;
  monthOptions: string[];
  onMonthChange: (month: string) => void;
  /**
   * null khi tháng đang chọn còn đang tải. `days` xếp mới nhất trước.
   * `closedFrom`: ngày cũ nhất còn mốc đồng bộ (trước ngày này không kết luận lại được).
   */
  monthData: {
    registration: Registration | null;
    days: DayView[];
    conflict: ConflictInfo | null;
    closedFrom: string | null;
    /** Tháng chưa từng được đối chiếu tự động (trước khi triển khai): không có
     *  mốc đồng bộ nào trong tháng và agent chưa tách lượt chấm cho Thầy/Cô. */
    noData?: boolean;
    /** Các ngày bị treo vì chốt an toàn (YYYY-MM-DD, mới nhất trước), để giải thích. */
    heldDates?: string[];
  } | null;
}

const STATUS: Record<MealCode, { icon: string; tone: string; text: (time: string | null) => string }> = {
  ok: {
    icon: 'check_circle',
    tone: 'bg-tertiary-container text-on-tertiary-container border-tertiary/30',
    text: t => (t ? `Đã chấm ${t}` : 'Đã chấm'),
  },
  missing: {
    icon: 'cancel',
    tone: 'bg-error-container text-on-error-container border-error/30',
    text: () => 'Chưa chấm',
  },
  pending: {
    icon: 'hourglass_empty',
    tone: 'bg-surface-container text-on-surface-variant border-outline-variant',
    text: () => 'Chưa có dữ liệu',
  },
  not_registered: {
    icon: 'do_not_disturb_on',
    tone: 'bg-surface-container-lowest text-on-surface-variant border-outline-variant border-dashed',
    text: () => 'Không đăng ký',
  },
  extra: {
    icon: 'error',
    tone: 'bg-warning-container text-on-warning-container border-warning/40',
    // Khoảng trắng không ngắt (\u00a0) trong ngoặc: ô hẹp trên điện thoại thì
    // xuống dòng trọn cụm "(không đăng ký)" thay vì để chữ "ký)" lẻ loi một
    // dòng. Viết bằng mã thoát cho dễ thấy, kẻo ai sửa nhầm thành dấu cách thường.
    text: t => `Có chấm${t ? ` ${t}` : ''} (không\u00a0đăng\u00a0ký)`,
  },
  off_day: {
    icon: 'event_busy',
    tone: 'bg-surface-container text-on-surface-variant border-outline-variant',
    text: () => 'Ngày nghỉ',
  },
  excluded: {
    icon: 'block',
    tone: 'bg-surface-container text-on-surface-variant border-outline-variant',
    text: () => 'Không áp dụng',
  },
  invalid_id: {
    icon: 'badge',
    tone: 'bg-warning-container text-on-warning-container border-warning/40',
    text: () => 'Thiếu mã NV',
  },
};

// "pending" của ngày đã quá mốc đồng bộ còn lưu: hiện khác hẳn "Chưa có dữ
// liệu" (vốn nghĩa là sẽ còn được chốt). Không cho là "Chưa chấm" vì trang
// không còn căn cứ, cũng không để là "chưa kết luận" vì sẽ không bao giờ kết
// luận nữa — kết luận lúc đó (nếu có) đã nằm trong email cảnh báo.
const EXPIRED_CHIP: (typeof STATUS)[MealCode] = {
  icon: 'history',
  tone: 'bg-surface-container-high text-on-surface-variant border-outline-variant border-dashed',
  //  : ô hẹp trên điện thoại thì xuống dòng thành "Không còn / dữ liệu
  // chốt" thay vì cắt giữa cụm "dữ liệu".
  text: () => 'Không còn dữ liệu chốt',
};

const chipOf = (code: MealCode, hold: DayHold | null | undefined) =>
  code === 'pending' && hold === 'expired' ? EXPIRED_CHIP : STATUS[code];

// Giải thích ngắn cho các trạng thái hay gặp. Ba trạng thái còn lại (ngày nghỉ,
// không áp dụng, thiếu mã) và "Không còn dữ liệu chốt" đã có thông báo riêng
// ngay chỗ xuất hiện.
const LEGEND: { code: MealCode; text: string }[] = [
  { code: 'ok', text: 'Đã đăng ký và máy có ghi nhận lượt chấm trong khung giờ.' },
  { code: 'missing', text: 'Đã đăng ký, máy đã đồng bộ đủ sau giờ ăn nhưng không có lượt chấm.' },
  { code: 'pending', text: 'Bữa chưa kết thúc, máy chưa đồng bộ đủ, dữ liệu máy bất thường hoặc mã NV đang bị trùng — chưa kết luận.' },
  { code: 'extra', text: 'Có lượt chấm nhưng Thầy/Cô không đăng ký hoặc đã báo hủy bữa này.' },
  { code: 'not_registered', text: 'Không đăng ký bữa này và cũng không chấm.' },
];

const MEAL_ICON: Record<Meal, string> = { breakfast: 'bakery_dining', lunch: 'lunch_dining' };

// Bố cục bên trong thẻ đổi theo BỀ RỘNG THẺ (container query @lg/@xl/@2xl),
// không theo bề rộng màn hình: cùng một màn 1024px, thẻ chỉ còn ~450px vì có
// thanh bên và cột trợ giúp, trong khi ở màn 768px không có cột trợ giúp. Theo
// màn hình thì ô trạng thái bị bóp, chữ "Đã chấm HH:MM" gãy dòng.
const CARD =
  'min-w-0 bg-surface-container-lowest rounded-2xl border border-outline-variant';

const windowText = (meal: Meal) => `${MEAL_WINDOWS[meal].from}–${MEAL_WINDOWS[meal].to}`;
const monthLabel = (month: string) => `Tháng ${month.slice(5, 7)}/${month.slice(0, 4)}`;

// "13:46 09/10" — bỏ năm khi là năm nay cho gọn trên điện thoại.
function shortVnDateTime(iso: string | null | undefined, todayIso: string) {
  const s = formatVnDateTime(iso);
  const suffix = `/${todayIso.slice(0, 4)}`;
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/** Ghi chú dưới nhãn trạng thái: vì sao không tính bữa này, hoặc giờ chấm không được dùng tới. */
function mealNote(status: MealStatus, registration: Registration | null, meal: Meal): string | null {
  // Không đăng ký cả tháng thì đã có thông báo chung, khỏi lặp lại ở từng ô.
  if ((status.code === 'not_registered' || status.code === 'extra') && status.reason && status.reason !== 'no_registration') {
    return describeNotExpected(status.reason, registration, meal);
  }
  if (status.time && (status.code === 'off_day' || status.code === 'excluded' || status.code === 'invalid_id')) {
    return `Máy ghi nhận lượt chấm lúc ${status.time}`;
  }
  return null;
}

/** "08/10" */
const dayMonth = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Mã trên đơn đăng ký khác mã trên hồ sơ staff. Agent gán lượt chấm theo mã
 * CHỤP trên đơn (đơn ưu tiên), còn đầu trang hiện mã hồ sơ — lệch nhau mà không
 * nói ra thì Thầy/Cô thấy "Chưa chấm" cả tháng (và nhận email) mà không hiểu vì sao.
 */
function idMismatch(profile: MyMealsViewProps['profile'], registration: Registration | null) {
  if (!profile || !registration) return null;
  const regId = normId(registration.employeeId);
  const profileId = normId(profile.employeeId);
  if (!isUsableId(regId) || !isUsableId(profileId) || regId === profileId) return null;
  return { regId, profileId };
}

function summarize(days: DayView[]) {
  const c = { ok: 0, missing: 0, pending: 0, conflictHeld: 0, expired: 0, extra: 0, unrecognized: 0 };
  for (const { result: d, hold } of days) {
    for (const meal of MEALS) {
      const code = d.meals[meal].code;
      if (code === 'pending' && hold === 'expired') {
        c.expired++;
      } else if (code === 'ok' || code === 'missing' || code === 'pending' || code === 'extra') {
        c[code]++;
        if (code === 'pending' && hold === 'conflict') c.conflictHeld++;
      }
    }
    c.unrecognized += d.unrecognized.length;
  }
  // "Bữa đã đăng ký" = những bữa đáng lẽ phải ăn, đúng định nghĩa expected của agent.
  return { ...c, registered: c.ok + c.missing + c.pending + c.expired };
}

function StatusChip({
  status,
  hold,
  size = 'md',
}: {
  status: Pick<MealStatus, 'code' | 'time'>;
  hold?: DayHold | null;
  size?: 'md' | 'lg';
}) {
  const s = chipOf(status.code, hold);
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border max-w-full w-fit',
        // Cỡ nhỏ dùng trong lưới 2 cột trên điện thoại 375px: mỗi ô chỉ ~150px,
        // nên phần đệm phải gọn để "Đã chấm HH:MM" nằm trọn một dòng.
        size === 'lg' ? 'gap-1.5 px-3 py-1.5 text-label-lg' : 'gap-1 px-2 py-1 text-label-md',
        s.tone,
      )}
    >
      <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden="true" style={{ fontVariationSettings: "'FILL' 1" }}>
        {s.icon}
      </span>
      <span className="leading-tight tabular">{s.text(status.time)}</span>
    </span>
  );
}

function Banner({ tone, icon, children }: { tone: 'warning' | 'error' | 'info'; icon: string; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'p-sm md:p-md rounded-lg border text-body-md flex items-start gap-2',
        tone === 'warning' && 'bg-warning-container text-on-warning-container border-warning/30',
        tone === 'error' && 'bg-error-container text-on-error-container border-error/25',
        tone === 'info' && 'bg-primary-container/40 text-on-primary-container border-primary/15',
      )}
    >
      <span className="material-symbols-outlined text-[20px] shrink-0 mt-px" aria-hidden="true">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

function UnrecognizedNote({ times }: { times: string[] }) {
  if (times.length === 0) return null;
  return (
    <p className="text-body-sm text-on-warning-container bg-warning-container/60 rounded-md px-2 py-1 flex items-start gap-1.5">
      <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden="true">schedule</span>
      <span>
        Có lượt chấm lúc <strong className="tabular">{times.join(', ')}</strong>, nằm ngoài khung giờ nên không được tính.
      </span>
    </p>
  );
}

function IdMismatchBanner({ month, regId, profileId }: { month: string; regId: string; profileId: string }) {
  return (
    <Banner tone="warning" icon="badge">
      <p>
        Đơn đăng ký {monthLabel(month).toLowerCase()} ghi mã NV <strong className="tabular">{regId}</strong>, khác mã trên hồ sơ
        của Thầy/Cô (<strong className="tabular">{profileId}</strong>). Máy nhận diện đối chiếu lượt chấm theo mã trên đơn
        đăng ký; nếu mã trên đơn chưa đúng, vui lòng liên hệ Bộ phận Dinh dưỡng để được điều chỉnh.
      </p>
    </Banner>
  );
}

function TodayCard({
  todayIso,
  today,
  sync,
  onReload,
  refreshing,
}: Pick<MyMealsViewProps, 'todayIso' | 'today' | 'sync' | 'onReload' | 'refreshing'>) {
  const updatedAt = sync ? sync.lastCompleteAt || sync.lastRunAt : null;
  return (
    <section aria-labelledby="mm-today-title" className={clsx(CARD, 'overflow-hidden')}>
      <div className="px-md md:px-lg py-md border-b border-outline-variant flex flex-wrap items-center justify-between gap-2">
        <h3 id="mm-today-title" className="text-headline-sm text-on-surface flex items-center gap-2">
          <span className="material-symbols-outlined text-[22px] text-primary" aria-hidden="true">today</span>
          Hôm nay
        </h3>
        <span className="text-body-md text-on-surface-variant tabular">{formatDayLabel(todayIso)}</span>
      </div>

      <div className="@container p-md md:p-lg flex flex-col gap-sm">
        {!today ? (
          <p className="text-body-md text-on-surface-variant">Chưa có dữ liệu hôm nay.</p>
        ) : today.result.offDay ? (
          <div className="rounded-lg border border-outline-variant bg-surface-container-low p-md flex items-start gap-md">
            <div className="w-11 h-11 rounded-full bg-surface-container-high text-on-surface-variant flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined" aria-hidden="true">event_busy</span>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <StatusChip status={today.result.meals.lunch} size="lg" />
              <p className="text-body-md text-on-surface-variant">
                Hôm nay không có suất ăn (thứ 7, Chủ nhật hoặc ngày nghỉ của trường).
              </p>
              {/* Ngày nghỉ mà máy vẫn ghi nhận lượt chấm trong khung (vd. đi làm
                  bù): vẫn cho Thầy/Cô thấy, chỉ là không tính suất. */}
              {MEALS.map(meal => {
                const note = mealNote(today.result.meals[meal], today.registration, meal);
                return note ? (
                  <p key={meal} className="text-body-sm text-on-surface-variant">
                    {MEAL_LABEL[meal]}: {note.charAt(0).toLowerCase() + note.slice(1)}
                  </p>
                ) : null;
              })}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 @lg:grid-cols-2 gap-sm">
            {MEALS.map(meal => {
              const status = today.result.meals[meal];
              const note = mealNote(status, today.registration, meal);
              return (
                // Bản gọn (@[17rem]) cho máy 320px: ô hẹp quá thì chữ "Đã chấm
                // 06:58" trong chip bị gãy làm hai dòng.
                <div key={meal} className="rounded-lg border border-outline-variant bg-surface-container-low p-sm @[17rem]:p-md flex items-start gap-sm @[17rem]:gap-md">
                  <div
                    className={clsx(
                      'w-9 h-9 @[17rem]:w-11 @[17rem]:h-11 rounded-full flex items-center justify-center shrink-0',
                      meal === 'breakfast' ? 'bg-primary/10 text-primary' : 'bg-secondary-container text-on-secondary-container',
                    )}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">{MEAL_ICON[meal]}</span>
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                    <div className="flex flex-col">
                      <span className="text-label-lg text-on-surface">{MEAL_LABEL[meal]}</span>
                      <span className="text-body-sm text-on-surface-variant tabular">Khung giờ {windowText(meal)}</span>
                    </div>
                    <StatusChip status={status} hold={today.hold} size="lg" />
                    {note && <p className="text-body-sm text-on-surface-variant">{note}</p>}
                    {/* Đang trùng mã thì đồng bộ thêm bao nhiêu lần cũng không chốt
                        được: đừng hứa "sẽ chốt sau giờ ăn". */}
                    {status.code === 'pending' && (
                      <p className="text-body-sm text-on-surface-variant">
                        {today.hold === 'conflict'
                          ? 'Chưa xác định được vì mã NV đang bị trùng — xem thông báo phía trên.'
                          : today.hold === 'guarded'
                            ? 'Dữ liệu máy nhận diện hôm nay bất thường nên hệ thống chưa kết luận và không gửi cảnh báo. Bộ phận Dinh dưỡng sẽ kiểm tra.'
                            : 'Trạng thái được chốt sau giờ ăn, khi máy đã đồng bộ đủ.'}
                      </p>
                    )}
                    {/* Khiếu nại phải làm TRONG NGÀY, mà thẻ hướng dẫn nằm cuối trang
                        (dưới cả danh sách tháng trên điện thoại): đưa lối tắt lên đây. */}
                    {status.code === 'missing' && (
                      <p className="text-body-sm text-on-surface-variant">
                        Đã ăn nhưng máy không ghi nhận? Vui lòng báo{' '}
                        <a href={`mailto:${NUTRITION_EMAIL}`} className="font-semibold text-primary underline underline-offset-2">
                          Bộ phận Dinh dưỡng
                        </a>{' '}
                        trong ngày.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* Mỗi ô đã ghi "Không đăng ký" nhưng không nói vì sao (để khỏi lặp ở
            từng ngày trong lịch sử); thẻ Hôm nay nói rõ một lần. */}
        {today && !today.result.offDay && !today.registration && (
          <p className="text-body-sm text-on-surface-variant flex items-start gap-1.5">
            <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden="true">info</span>
            <span>Thầy/Cô không đăng ký suất ăn tháng này.</span>
          </p>
        )}
        {today && <UnrecognizedNote times={today.result.unrecognized} />}
      </div>

      <div className="border-t border-outline-variant px-md md:px-lg py-3 bg-surface-container-low flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body-md text-on-surface flex items-start gap-1.5">
            <span className="material-symbols-outlined text-[18px] text-primary mt-px shrink-0" aria-hidden="true">sync</span>
            {updatedAt ? (
              <span>
                Dữ liệu máy nhận diện cập nhật lúc <strong className="tabular">{shortVnDateTime(updatedAt, todayIso)}</strong>
              </span>
            ) : (
              <span>Chưa có thông tin đồng bộ từ máy nhận diện.</span>
            )}
          </p>
          <p className="text-body-sm text-on-surface-variant mt-0.5 sm:pl-6">
            Lịch cập nhật: khoảng 08:15 và 13:45 (thứ 2–6), 22:00 hằng ngày.
          </p>
        </div>
        {onReload && (
          <button
            type="button"
            onClick={onReload}
            disabled={refreshing}
            aria-busy={refreshing}
            className="self-start sm:self-center shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest text-label-md text-primary hover:bg-surface-container transition-colors disabled:opacity-60 disabled:cursor-wait"
          >
            <span className={clsx('material-symbols-outlined text-[18px]', refreshing && 'animate-spin')} aria-hidden="true">
              {refreshing ? 'progress_activity' : 'refresh'}
            </span>
            {refreshing ? 'Đang tải...' : 'Tải lại'}
          </button>
        )}
      </div>
    </section>
  );
}

function DayRow({ day: { result: day, hold }, registration, isToday }: { day: DayView; registration: Registration | null; isToday: boolean }) {
  return (
    <li className="px-md md:px-lg py-3 grid grid-cols-2 @xl:grid-cols-[170px_1fr_1fr] gap-x-3 gap-y-2 items-start">
      <div className="col-span-2 @xl:col-span-1 flex items-center gap-2 @xl:pt-1">
        <span className="text-label-lg text-on-surface tabular">{formatDayLabel(day.date)}</span>
        {isToday && <span className="px-2 py-0.5 rounded-full bg-primary text-on-primary text-label-sm">Hôm nay</span>}
      </div>
      {MEALS.map(meal => {
        const status = day.meals[meal];
        const note = mealNote(status, registration, meal);
        return (
          <div key={meal} className="flex flex-col gap-1 min-w-0">
            {/* Trên máy tính đã có tiêu đề cột; vẫn giữ nhãn cho trình đọc màn hình. */}
            <span className="text-label-sm text-on-surface-variant uppercase @xl:sr-only">{MEAL_LABEL[meal]}</span>
            <StatusChip status={status} hold={hold} />
            {note && <span className="text-body-sm text-on-surface-variant">{note}</span>}
          </div>
        );
      })}
      {day.unrecognized.length > 0 && (
        <div className="col-span-2 @xl:col-start-2">
          <UnrecognizedNote times={day.unrecognized} />
        </div>
      )}
    </li>
  );
}

function SummaryTiles({ days, isCurrentMonth, showTiles }: { days: DayView[]; isCurrentMonth: boolean; showTiles: boolean }) {
  const s = summarize(days);
  const tiles = [
    { label: 'Đã chấm', value: s.ok, icon: 'check_circle', tone: 'bg-tertiary-container/60 border-tertiary/25 text-on-tertiary-container' },
    { label: 'Chưa chấm', value: s.missing, icon: 'cancel', tone: 'bg-error-container/70 border-error/25 text-on-error-container' },
    { label: 'Chưa có dữ liệu', value: s.pending, icon: 'hourglass_empty', tone: 'bg-surface-container border-outline-variant text-on-surface-variant' },
  ];
  const extras = (
    <>
      {s.extra > 0 && <> Có <strong className="tabular">{s.extra}</strong> bữa có chấm nhưng không đăng ký.</>}
      {s.unrecognized > 0 && <> <strong className="tabular">{s.unrecognized}</strong> lượt chấm ngoài khung giờ không được tính.</>}
    </>
  );
  // Tháng không đăng ký / không đối soát được (thiếu mã, không áp dụng): ba ô
  // toàn số 0 chỉ gây rối và đã có thông báo riêng; chỉ nói về lượt chấm (nếu có).
  if (!showTiles) {
    return s.extra > 0 || s.unrecognized > 0 ? <p className="text-body-sm text-on-surface-variant">{extras}</p> : null;
  }
  return (
    <div className="flex flex-col gap-sm">
      <dl className="grid grid-cols-3 gap-sm">
        {tiles.map(t => (
          // justify-between: nhãn "Chưa có dữ liệu" xuống 2 dòng trên điện thoại,
          // đẩy con số xuống đáy ô để ba con số vẫn thẳng hàng.
          <div key={t.label} className={clsx('rounded-lg border p-sm md:p-md flex flex-col justify-between gap-0.5', t.tone)}>
            <dt className="text-label-sm md:text-label-md flex items-center gap-1">
              {/* Bọc ngoài vì CSS của font icon (không nằm trong layer) đè mất
                  lớp `hidden` nếu đặt thẳng lên icon. Điện thoại hẹp nên bỏ icon. */}
              <span className="hidden sm:inline-flex" aria-hidden="true">
                <span className="material-symbols-outlined text-[16px]">{t.icon}</span>
              </span>
              {t.label}
            </dt>
            <dd className="text-headline-md tabular">
              {t.value} <span className="text-body-sm">bữa</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-body-sm text-on-surface-variant">
        Tính trên <strong className="tabular">{s.registered}</strong> bữa Thầy/Cô đã đăng ký
        {isCurrentMonth ? ' từ đầu tháng đến hôm nay' : ' trong tháng'}.
        {s.conflictHeld > 0 && (
          <>
            {' '}Trong đó <strong className="tabular">{s.conflictHeld}</strong> bữa chưa xác định được vì mã NV bị trùng.
          </>
        )}
        {s.expired > 0 && (
          <>
            {' '}<strong className="tabular">{s.expired}</strong> bữa không còn dữ liệu chốt.
          </>
        )}
        {extras}
      </p>
    </div>
  );
}

function HistoryCard({
  todayIso,
  profile,
  month,
  monthOptions,
  onMonthChange,
  monthData,
}: Pick<MyMealsViewProps, 'todayIso' | 'profile' | 'month' | 'monthOptions' | 'onMonthChange' | 'monthData'>) {
  const isCurrentMonth = month === todayIso.slice(0, 7);
  const days = monthData?.days ?? [];
  const has = (code: MealCode) => days.some(d => MEALS.some(m => d.result.meals[m].code === code));
  const hasExpired = days.some(d => d.hold === 'expired' && MEALS.some(m => d.result.meals[m].code === 'pending'));
  const regId = monthData?.registration ? normId(monthData.registration.employeeId) : '';
  // Tháng hiện tại đã có thông báo (thì hiện tại) ở đầu trang vì ảnh hưởng cả
  // thẻ Hôm nay; ở đây chỉ nói về tháng cũ đang xem.
  const pastMismatch = !isCurrentMonth && monthData ? idMismatch(profile, monthData.registration) : null;
  const pastConflict = !isCurrentMonth ? monthData?.conflict ?? null : null;
  const pastConflictFrom = pastConflict?.from && pastConflict.from.slice(0, 7) === month ? pastConflict.from : null;

  return (
    <section aria-labelledby="mm-history-title" className={clsx(CARD, '@container overflow-hidden')}>
      <div className="p-md md:p-lg border-b border-outline-variant flex flex-col @2xl:flex-row @2xl:items-center justify-between gap-md">
        <div>
          <h3 id="mm-history-title" className="text-headline-sm text-on-surface">Lịch sử chấm ăn</h3>
          <p className="text-body-sm text-on-surface-variant mt-0.5">Các ngày có suất ăn trong tháng, mới nhất ở trên.</p>
        </div>
        <div role="group" aria-label="Chọn tháng" className="grid grid-cols-3 gap-1 p-1 bg-surface-container rounded-lg w-full @2xl:w-auto">
          {monthOptions.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onMonthChange(m)}
              aria-pressed={m === month}
              aria-label={monthLabel(m)}
              className={clsx(
                'px-2 md:px-3 py-2 rounded-md text-label-md whitespace-nowrap transition-colors tabular',
                m === month ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high',
              )}
            >
              {/* Điện thoại 375px không đủ chỗ cho 3 nút "Tháng 10/2026": viết tắt "T10/2026". */}
              <span className="sm:hidden">T{m.slice(5, 7)}/{m.slice(0, 4)}</span>
              <span className="hidden sm:inline">{monthLabel(m)}</span>
            </button>
          ))}
        </div>
      </div>

      {!monthData ? (
        <div role="status" className="p-lg flex items-center justify-center gap-2 text-on-surface-variant text-body-md">
          <span className="material-symbols-outlined animate-spin" aria-hidden="true">progress_activity</span>
          Đang tải {monthLabel(month).toLowerCase()}...
        </div>
      ) : (
        <>
          <div className="p-md md:p-lg flex flex-col gap-sm border-b border-outline-variant">
            <h4 className="text-label-lg text-on-surface">Tổng kết {monthLabel(month).toLowerCase()}</h4>
            {/* Nói rõ mã nào đang được dùng để đối chiếu: là mã trên đơn, không
                phải mã trên hồ sơ ở đầu trang. */}
            {isUsableId(regId) && (
              <p className="text-body-sm text-on-surface-variant flex items-start gap-1.5">
                <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden="true">badge</span>
                <span>
                  Máy nhận diện đối chiếu theo mã NV <strong className="tabular text-on-surface">{regId}</strong> trên đơn đăng
                  ký {monthLabel(month).toLowerCase()}.
                </span>
              </p>
            )}
            {!monthData.registration && (
              <Banner tone="info" icon="info">
                <p>
                  Thầy/Cô không đăng ký suất ăn {monthLabel(month).toLowerCase()}. Các ngày bên dưới chỉ hiển thị lượt chấm (nếu có).
                </p>
              </Banner>
            )}
            {pastMismatch && <IdMismatchBanner month={month} {...pastMismatch} />}
            {pastConflict && (
              <Banner tone="error" icon="group">
                <p>
                  {monthLabel(month)}: mã nhân viên <strong className="tabular">{pastConflict.ids.join(', ')}</strong> bị khai báo
                  cho nhiều tài khoản{pastConflictFrom ? <> (từ ngày <span className="tabular">{dayMonth(pastConflictFrom)}</span>)</> : ''},
                  nên hệ thống không xác định được lượt chấm của Thầy/Cô trong thời gian đó. Nếu cần kiểm tra lại, vui lòng liên hệ
                  Bộ phận Dinh dưỡng.
                </p>
              </Banner>
            )}
            {has('invalid_id') && (
              <Banner tone="warning" icon="badge">
                <p>
                  Đơn đăng ký {monthLabel(month).toLowerCase()} chưa có mã nhân viên nên chưa đối chiếu được với máy nhận diện.
                  Thầy/Cô vui lòng liên hệ Bộ phận Dinh dưỡng để được bổ sung.
                </p>
              </Banner>
            )}
            {has('excluded') && (
              <Banner tone="info" icon="block">
                <p>Bộ phận của Thầy/Cô không thuộc diện đối soát chấm ăn, nên các bữa hiển thị “Không áp dụng”.</p>
              </Banner>
            )}
            {monthData.noData && (
              <Banner tone="info" icon="history">
                <p>
                  Tháng này chưa được hệ thống đối chiếu tự động với máy nhận diện (chức năng mới triển khai), nên trang không
                  có số liệu chấm ăn để hiển thị. Cần tra cứu, Thầy/Cô vui lòng liên hệ Bộ phận Dinh dưỡng.
                </p>
              </Banner>
            )}
            {!!monthData.heldDates?.length && (
              <Banner tone="warning" icon="pause_circle">
                <p>
                  Ngày{' '}
                  <span className="tabular">{monthData.heldDates.map(d => `${d.slice(8, 10)}/${d.slice(5, 7)}`).join(', ')}</span>: dữ
                  liệu máy nhận diện bất thường nên hệ thống chưa kết luận và không gửi cảnh báo; các bữa chưa thấy lượt chấm
                  hiển thị “Chưa có dữ liệu”. Bộ phận Dinh dưỡng sẽ kiểm tra.
                </p>
              </Banner>
            )}
            {hasExpired && !monthData.noData && monthData.closedFrom && (
              <Banner tone="info" icon="history">
                <p>
                  Hệ thống chỉ còn lưu mốc đồng bộ của máy nhận diện từ ngày{' '}
                  <span className="tabular">{formatDate(monthData.closedFrom)}</span>. Với các ngày trước đó, bữa đã đăng ký mà
                  không thấy lượt chấm hiển thị “Không còn dữ liệu chốt” vì trang không kết luận lại được. Nếu hôm đó Thầy/Cô
                  đã nhận email cảnh báo thì email là kết luận chính thức.
                </p>
              </Banner>
            )}
            <SummaryTiles
              days={days}
              isCurrentMonth={isCurrentMonth}
              showTiles={!!monthData.registration && !monthData.noData && !has('excluded') && !has('invalid_id')}
            />
          </div>

          {days.length === 0 ? (
            <p className="p-md md:p-lg text-body-md text-on-surface-variant">
              {monthLabel(month)} chưa có ngày nào có suất ăn{isCurrentMonth ? ' tính đến hôm nay' : ''}.
            </p>
          ) : (
            <>
              <div className="hidden @xl:grid grid-cols-[170px_1fr_1fr] gap-x-3 px-lg py-2 bg-surface-container-low border-b border-outline-variant text-label-md text-on-surface-variant uppercase" aria-hidden="true">
                <span>Ngày</span>
                <span>{MEAL_LABEL.breakfast} · {windowText('breakfast')}</span>
                <span>{MEAL_LABEL.lunch} · {windowText('lunch')}</span>
              </div>
              <ol className="divide-y divide-outline-variant">
                {days.map(d => (
                  <DayRow key={d.result.date} day={d} registration={monthData.registration} isToday={d.result.date === todayIso} />
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}

function HelpCard() {
  return (
    <section aria-labelledby="mm-help-title" className={clsx(CARD, 'p-md md:p-lg flex flex-col gap-sm')}>
      <h3 id="mm-help-title" className="text-headline-sm text-on-surface flex items-center gap-2">
        <span className="material-symbols-outlined text-[22px]" aria-hidden="true">support_agent</span>
        Thấy chưa đúng?
      </h3>
      <p className="text-body-md text-on-surface">
        Nếu Thầy/Cô đã ăn nhưng máy không ghi nhận, vui lòng trả lời email cảnh báo hoặc liên hệ Bộ phận Dinh dưỡng
        <strong> trong ngày</strong> để được kiểm tra.
      </p>
      <a
        href={`mailto:${NUTRITION_EMAIL}`}
        className="inline-flex items-center justify-center gap-2 w-full px-md py-2.5 rounded-lg bg-primary text-on-primary text-label-lg hover:bg-primary-dark transition-colors"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">mail</span>
        Gửi email Bộ phận Dinh dưỡng
      </a>
      <p className="text-body-sm text-on-surface-variant text-center break-all">{NUTRITION_EMAIL}</p>
      <div className="mt-1 p-sm rounded-lg bg-surface-container-low border border-outline-variant text-body-sm text-on-surface-variant space-y-1.5">
        <p>
          Chỉ lượt chấm trong khung giờ mới được tính: {MEAL_LABEL.breakfast.toLowerCase()} {windowText('breakfast')},{' '}
          {MEAL_LABEL.lunch.toLowerCase()} {windowText('lunch')}.
        </p>
        <p>
          Theo quy định của Nhà trường, đăng ký suất ăn nhưng không chấm ăn là vi phạm quy định chấm ăn; Thầy/Cô có thể bị tạm
          dừng đăng ký suất ăn tháng tiếp theo.
        </p>
      </div>
    </section>
  );
}

function LegendCard() {
  return (
    <section aria-labelledby="mm-legend-title" className={clsx(CARD, 'p-md md:p-lg flex flex-col gap-sm')}>
      <h3 id="mm-legend-title" className="text-label-lg text-on-surface">Ý nghĩa trạng thái</h3>
      <ul className="flex flex-col gap-2.5">
        {LEGEND.map(l => (
          <li key={l.code} className="flex flex-col gap-1">
            <StatusChip status={{ code: l.code, time: null }} />
            <span className="text-body-sm text-on-surface-variant">{l.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MyMealsView(props: MyMealsViewProps) {
  const { loading, error, onRetry, profile, todayIso, sync, conflict, missedSyncAt } = props;
  const failedDevices = sync ? sync.devices.filter(d => !d.ok) : [];
  const syncBroken = !!sync && (sync.lastRunComplete === false || failedDevices.length > 0);
  const currentMonth = todayIso.slice(0, 7);
  const currentReg = props.today?.registration ?? null;
  const currentMismatch = idMismatch(profile, currentReg);
  const conflictFrom = conflict?.from && conflict.from.slice(0, 7) === currentMonth ? conflict.from : null;
  // Không có hồ sơ mà đơn tháng này có mã dùng được: agent vẫn gán lượt chấm
  // theo mã trên đơn, nên không được nói là "chưa gắn được".
  const currentRegId = currentReg ? normId(currentReg.employeeId) : '';
  const showMissed = !!missedSyncAt && !!sync?.lastRunAt;

  return (
    <main className="flex-1 max-w-[1440px] w-full mx-auto py-md md:py-lg px-md md:px-margin lg:px-xl flex flex-col gap-md md:gap-lg">
      {/* Chỉ xếp ngang từ lg: ở md đã mất 256px cho thanh bên, đặt cạnh nhau
          thì họ tên bị gãy dòng lủng củng. */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-xs lg:gap-md">
        <div>
          <p className="text-body-sm text-on-surface-variant mb-2">Suất ăn / Cá nhân</p>
          <h2 className="text-headline-md md:text-headline-lg text-on-surface">Chấm ăn của tôi</h2>
          <p className="text-body-md text-on-surface-variant mt-xs text-[13px] md:text-[14px]">
            Đối chiếu suất ăn Thầy/Cô đã đăng ký với lượt chấm trên máy nhận diện
          </p>
        </div>
        {profile && (
          <p className="text-body-md text-on-surface-variant">
            <span className="text-label-lg text-on-surface">{profile.fullName}</span>
            {profile.employeeId && (
              <>
                {' · '}Mã NV <span className="text-label-lg text-on-surface tabular">{profile.employeeId}</span>
              </>
            )}
          </p>
        )}
      </div>

      {loading ? (
        <div role="status" className={clsx(CARD, 'p-xl flex flex-col items-center gap-sm text-on-surface-variant')}>
          <span className="material-symbols-outlined animate-spin text-[32px] text-primary" aria-hidden="true">progress_activity</span>
          <p className="text-body-md">Đang tải dữ liệu chấm ăn...</p>
        </div>
      ) : error ? (
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
      ) : (
        <>
          {(showMissed || syncBroken || conflict || currentMismatch || !profile) && (
            <div className="flex flex-col gap-sm">
              {/* Máy HAC tắt hoặc tác vụ hẹn giờ hỏng thì không có lần chạy nào
                  để báo lỗi: chỉ nhận ra được bằng cách so với lịch. */}
              {missedSyncAt && sync?.lastRunAt && (
                <Banner tone="warning" icon="cloud_off">
                  <p>
                    Máy nhận diện chưa đồng bộ dữ liệu từ{' '}
                    <strong className="tabular">{shortVnDateTime(sync.lastRunAt, todayIso)}</strong> (lần đồng bộ theo lịch lúc{' '}
                    <span className="tabular">{shortVnDateTime(missedSyncAt, todayIso)}</span> chưa diễn ra). Lượt chấm gần đây có thể
                    chưa hiển thị và các bữa chưa được chốt; Thầy/Cô vui lòng xem lại sau.
                  </p>
                </Banner>
              )}
              {syncBroken && (
                <Banner tone="warning" icon="sync_problem">
                  <p>
                    Lần đồng bộ gần nhất
                    {sync?.lastRunAt && <> (<span className="tabular">{shortVnDateTime(sync.lastRunAt, todayIso)}</span>)</>} chưa lấy
                    được dữ liệu từ{' '}
                    {failedDevices.length > 0 ? (
                      <>
                        máy <strong>{failedDevices.map(d => d.name).join(', ')}</strong>
                      </>
                    ) : (
                      'một số máy'
                    )}
                    . Lượt chấm tại {failedDevices.length === 1 ? 'máy này' : 'các máy này'} có thể chưa hiển thị; hệ thống sẽ
                    tự cập nhật ở lần đồng bộ sau.
                  </p>
                  {failedDevices.some(d => d.lastOkAt) && (
                    <p className="text-body-sm">
                      {failedDevices
                        .filter(d => d.lastOkAt)
                        .map(d => `${d.name}: lần cuối lấy được dữ liệu lúc ${shortVnDateTime(d.lastOkAt, todayIso)}`)
                        .join(' · ')}
                    </p>
                  )}
                </Banner>
              )}
              {conflict && (
                <Banner tone="error" icon="group">
                  <p>
                    Mã nhân viên <strong className="tabular">{conflict.ids.join(', ')}</strong> đang được khai báo cho nhiều tài
                    khoản, nên{conflictFrom ? <> từ ngày <span className="tabular">{dayMonth(conflictFrom)}</span></> : ''} hệ thống
                    chưa xác định được lượt chấm nào là của Thầy/Cô. Vui lòng liên hệ Bộ phận Dinh dưỡng để được kiểm tra.
                  </p>
                </Banner>
              )}
              {currentMismatch && <IdMismatchBanner month={currentMonth} {...currentMismatch} />}
              {!profile && (
                <Banner tone="info" icon="badge">
                  <p>
                    {isUsableId(currentRegId)
                      ? 'Thầy/Cô chưa khai báo hồ sơ nhân viên.'
                      : 'Thầy/Cô chưa khai báo mã nhân viên nên máy nhận diện chưa gắn được lượt chấm với tài khoản này.'}{' '}
                    <Link to={`/register?next=${encodeURIComponent(SELF_PATH)}`} className="font-semibold underline underline-offset-2">
                      Khai báo ngay
                    </Link>
                  </p>
                </Banner>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-md md:gap-gutter items-start">
            <div className="lg:col-span-2 flex flex-col gap-md md:gap-gutter min-w-0">
              <TodayCard todayIso={todayIso} today={props.today} sync={sync} onReload={props.onReload} refreshing={props.refreshing} />
              <HistoryCard
                todayIso={todayIso}
                profile={profile}
                month={props.month}
                monthOptions={props.monthOptions}
                onMonthChange={props.onMonthChange}
                monthData={props.monthData}
              />
            </div>
            <aside className="flex flex-col gap-md md:gap-gutter lg:sticky lg:top-20 min-w-0">
              <HelpCard />
              <LegendCard />
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

// ====================================================================
// Lịch đồng bộ của máy HAC
// ====================================================================

// Lịch Task Scheduler trên máy HAC (agent/README.md, mục lịch chạy). Đổi lịch
// ở đó thì sửa cả ở đây, kẻo trang báo "chưa đồng bộ" sai giờ.
const SYNC_SCHEDULE: { time: string; weekdaysOnly: boolean; lastRepeat?: string }[] = [
  { time: '08:15', weekdaysOnly: true },
  // Lặp mỗi 15 phút tới 14:45 để gửi nốt cảnh báo; lần đầu đã đủ để chốt.
  { time: '13:45', weekdaysOnly: true, lastRepeat: '14:45' },
  { time: '22:00', weekdaysOnly: false },
];
// Một lần chạy xong trong vài phút; quá 30 phút sau giờ hẹn mà chưa thấy thì
// coi là lỡ lịch (máy tắt, tác vụ hẹn giờ hỏng).
const RUN_DONE_MIN = 10;
const RUN_GRACE_MIN = 30;
// Đồng hồ máy HAC có thể lệch vài phút: lần chạy ghi giờ sớm hơn giờ hẹn một
// chút vẫn tính là đúng lịch.
const CLOCK_SLACK_MIN = 15;
// Quay lại tab sau ngần này thì tải lại, dù chưa tới mốc đồng bộ nào.
const RETURN_STALE_MS = 5 * 60_000;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Cộng ngày trên ngày lịch YYYY-MM-DD (làm trên mốc UTC để không lệch múi giờ máy). */
function shiftDate(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

const plusMinutes = (hhmm: string, n: number) => {
  const t = toMinutes(hhmm) + n;
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
};

const slotsOn = (date: string) => SYNC_SCHEDULE.filter(s => !s.weekdaysOnly || isWeekday(date));

/**
 * Lần đồng bộ theo lịch gần nhất đáng lẽ đã chạy xong tính tới `at` mà máy HAC
 * không chạy (lastRunAt cũ hơn giờ hẹn). Trả ISO giờ hẹn đó, hoặc null nếu
 * vẫn đúng lịch / chưa có thông tin.
 *
 * Cần vì cảnh báo "máy lỗi" chỉ dựa vào kết quả lần chạy gần nhất: máy HAC tắt
 * hẳn thì lần chạy gần nhất vẫn trông như thành công, trong khi các bữa cứ
 * "Chưa có dữ liệu" mãi mà Thầy/Cô không biết là bất thường.
 */
function missedSyncRun(lastRunAt: string | null, at: Date): string | null {
  const last = lastRunAt ? vnParts(lastRunAt) : null;
  const p = vnParts(at);
  if (!last || !p) return null;
  // Lùi tối đa 3 ngày là chắc chắn gặp mốc 22:00 hằng ngày.
  for (let back = 0; back <= 3; back++) {
    const date = shiftDate(p.date, -back);
    const due = slotsOn(date)
      .map(s => s.time)
      .filter(t => back > 0 || toMinutes(t) + RUN_GRACE_MIN <= toMinutes(p.time));
    if (!due.length) continue;
    const slot = due[due.length - 1];
    const ran = last.date > date || (last.date === date && toMinutes(last.time) >= toMinutes(slot) - CLOCK_SLACK_MIN);
    // Giờ Việt Nam cố định UTC+7, không có giờ mùa hè.
    return ran ? null : new Date(`${date}T${slot}:00+07:00`).toISOString();
  }
  return null;
}

interface LoadStamp {
  /** Ngày và giờ (VN) của lần tải thành công gần nhất. */
  day: string;
  time: string;
  at: number;
}

/**
 * Trang đang mở có cần tự tải lại không. "Hôm nay" và "bây giờ" được chốt lúc
 * tải; để tab mở (điện thoại khôi phục tab cũ mà không tải lại) thì bữa trưa cứ
 * "Chưa có dữ liệu" dù 13:45 đã đồng bộ xong, qua đêm thì thẻ "Hôm nay" còn là
 * ngày hôm qua. Tải lại khi: sang ngày mới; vừa qua một mốc đồng bộ theo lịch
 * (đợi agent chạy xong, và thêm một lần sau hạn để kịp báo nếu máy lỡ lịch);
 * hoặc Thầy/Cô quay lại tab sau một lúc.
 */
function needsRefresh(l: LoadStamp, at: Date, trigger: 'visible' | 'tick') {
  const p = vnParts(at);
  if (!p) return false;
  if (p.date !== l.day) return true;
  if (trigger === 'visible' && at.getTime() - l.at > RETURN_STALE_MS) return true;
  return slotsOn(p.date)
    .flatMap(s => [
      plusMinutes(s.time, RUN_DONE_MIN),
      plusMinutes(s.time, RUN_GRACE_MIN),
      ...(s.lastRepeat ? [plusMinutes(s.lastRepeat, RUN_DONE_MIN)] : []),
    ])
    .some(c => l.time < c && c <= p.time);
}

// ====================================================================
// Phần tải dữ liệu
// ====================================================================

interface MonthData {
  registration: Registration | null;
  taps: Record<string, string[]>;
  conflict: boolean;
  conflictIds: string[];
  /**
   * Ngày (VN) bắt đầu trùng mã — agent tính từ ngày đơn trùng có hiệu lực
   * (conflictSince), khớp với email cảnh báo và tab quản trị. null = trùng cả
   * tháng. Các ngày trước đó vẫn là dữ liệu đúng của Thầy/Cô và có thể đã được
   * gửi email.
   */
  conflictFrom: string | null;
  /** Agent đã từng tách lượt chấm tháng này cho Thầy/Cô (có doc meal_taps). */
  hasTapsDoc: boolean;
}

interface BaseData {
  profile: { fullName: string; employeeId: string } | null;
  cancels: Cancelation[];
  sync: SyncInfo | null;
  coverage: Record<string, string>;
  /** Ngày cũ nhất còn mốc đồng bộ trong coverage (agent cắt bớt các ngày cũ). */
  closedFrom: string | null;
  /** Ngày chốt an toàn đã dừng gửi cảnh báo vì dữ liệu máy bất thường (alerts[ngày].held). */
  heldDates: Set<string>;
  offDays: string[];
  excludedIds: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// Gắn nhãn bước đang đọc vào lỗi để báo đúng nguyên nhân: meal_taps có rules
// riêng, triển khai tách khỏi bản web này, nên "permission-denied" ở đó nghĩa là
// rules chưa lên chứ không phải người dùng làm sai gì.
async function step<T>(name: 'taps' | 'data', p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    throw Object.assign(new Error(name), { step: name, code: typeof code === 'string' ? code : '', cause: e });
  }
}

function toViewError(e: unknown): ViewError {
  const { step: s, code } = (e ?? {}) as { step?: string; code?: string };
  if (s === 'taps' && code === 'permission-denied') {
    return {
      title: 'Chưa xem được lượt chấm ăn',
      detail:
        'Hệ thống đang cập nhật quyền xem dữ liệu chấm ăn. Thầy/Cô vui lòng thử lại sau ít phút; nếu vẫn chưa được, xin báo Bộ phận Dinh dưỡng.',
    };
  }
  if (code === 'permission-denied') {
    return {
      title: 'Chưa có quyền xem dữ liệu',
      detail: 'Tài khoản chưa đọc được dữ liệu này. Thầy/Cô thử đăng xuất rồi đăng nhập lại; nếu vẫn lỗi, xin báo Bộ phận Dinh dưỡng.',
    };
  }
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return { title: 'Không kết nối được máy chủ', detail: 'Vui lòng kiểm tra kết nối mạng rồi bấm Thử lại.' };
  }
  return {
    title: 'Chưa tải được dữ liệu chấm ăn',
    detail: `Vui lòng thử lại sau ít phút.${code ? ` (Mã lỗi: ${code})` : ''}`,
  };
}

async function loadBase(uid: string): Promise<BaseData> {
  const [staffSnap, cancelSnap, syncSnap, offSnap, exclSnap] = await Promise.all([
    step('data', getDoc(doc(db, 'staff', uid))),
    // Chỉ lọc theo userId: rules chỉ cho đọc đơn hủy của chính mình, và một
    // điều kiện đơn thì không cần tạo chỉ mục ghép.
    step('data', getDocs(query(collection(db, 'cancel_registrations'), where('userId', '==', uid)))),
    step('data', getDoc(doc(db, 'settings', 'checkinSync'))),
    step('data', getDoc(doc(db, 'settings', 'mealOffDays'))),
    step('data', getDoc(doc(db, 'settings', 'reconcileExcludes'))),
  ]);

  const staff = staffSnap.exists() ? staffSnap.data() : null;
  const s = syncSnap.exists() ? syncSnap.data() : null;
  const rawDevices = (s?.devices && typeof s.devices === 'object' ? s.devices : {}) as Record<string, Record<string, unknown>>;
  const rawCoverage = (s?.coverage && typeof s.coverage === 'object' ? s.coverage : {}) as Record<string, unknown>;
  const coverage: Record<string, string> = {};
  for (const [date, at] of Object.entries(rawCoverage)) {
    const v = str(at);
    if (ISO_DATE.test(date) && v) coverage[date] = v;
  }
  const rawAlerts = (s?.alerts && typeof s.alerts === 'object' ? s.alerts : {}) as Record<string, Record<string, unknown> | null>;
  const heldDates = new Set(
    Object.entries(rawAlerts)
      .filter(([date, a]) => ISO_DATE.test(date) && a?.held === true)
      .map(([date]) => date),
  );

  return {
    profile: staff ? { fullName: str(staff.fullName) || '', employeeId: str(staff.employeeId) || '' } : null,
    cancels: cancelSnap.docs.map(d => d.data() as Cancelation),
    sync: s
      ? {
          lastRunAt: str(s.lastRunAt),
          lastCompleteAt: str(s.lastCompleteAt),
          lastRunComplete: typeof s.lastRunComplete === 'boolean' ? s.lastRunComplete : null,
          devices: Object.entries(rawDevices)
            .map(([name, d]) => ({ name, ok: d?.ok !== false, error: str(d?.error), lastOkAt: str(d?.lastOkAt) }))
            .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
        }
      : null,
    coverage,
    closedFrom: Object.keys(coverage).sort()[0] ?? null,
    heldDates,
    offDays: strings(offSnap.exists() ? offSnap.data().dates : []),
    excludedIds: strings(exclSnap.exists() ? exclSnap.data().employeeIds : []),
  };
}

async function loadMonth(uid: string, month: string): Promise<MonthData> {
  const [regSnap, tapsSnap] = await Promise.all([
    step('data', getDoc(doc(db, 'registrations', `${uid}_${month}`))),
    step('taps', getDoc(doc(db, 'meal_taps', uid, 'months', month))),
  ]);
  // Không có doc meal_taps = agent chưa thấy lượt chấm nào của Thầy/Cô trong tháng.
  const t = tapsSnap.exists() ? tapsSnap.data() : null;
  const rawDays = (t?.days && typeof t.days === 'object' ? t.days : {}) as Record<string, unknown>;
  const taps: Record<string, string[]> = {};
  for (const [date, times] of Object.entries(rawDays)) taps[date] = strings(times);
  const conflict = t?.conflict === true;
  const updatedAt = str(t?.updatedAt);
  const since = str(t?.conflictSince);
  return {
    registration: regSnap.exists() ? (regSnap.data() as Registration) : null,
    taps,
    conflict,
    conflictIds: conflict ? strings(t?.conflictIds) : [],
    // Mốc trùng do agent ghi (conflictSince; null = trùng cả tháng). Doc ghi
    // bởi bản agent trước, chưa có trường này, thì tạm lấy updatedAt.
    conflictFrom: !conflict
      ? null
      : t && 'conflictSince' in t
        ? (since && ISO_DATE.test(since) ? since : null)
        : updatedAt ? (vnParts(updatedAt)?.date ?? null) : null,
    hasTapsDoc: tapsSnap.exists(),
  };
}

function recentMonths(todayIso: string, count = 3) {
  let y = Number(todayIso.slice(0, 4));
  let m = Number(todayIso.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

type LoadMode = 'initial' | 'manual' | 'auto';

export default function MyMeals() {
  const navigate = useNavigate();
  const [uid, setUid] = useState<string | null>(null);
  const [base, setBase] = useState<BaseData | null>(null);
  const [months, setMonths] = useState<Record<string, MonthData>>({});
  const [error, setError] = useState<ViewError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // "Hôm nay" và "bây giờ" chốt tại lúc tải để cả trang dùng cùng một mốc;
  // mỗi lần tải lại (bấm nút hoặc tự động) thì lấy mốc mới.
  const [todayIso, setTodayIso] = useState(() => vnToday());
  const [now, setNow] = useState(() => new Date());
  const [month, setMonth] = useState(() => vnToday().slice(0, 7));

  // Mỗi lượt tải mang một số thứ tự; kết quả của lượt cũ hơn (tải lại chồng
  // lên nhau, đổi tháng giữa chừng) bị bỏ để không đè dữ liệu mới.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const loadedAt = useRef<LoadStamp | null>(null);
  const monthRef = useRef(month);
  useEffect(() => {
    monthRef.current = month;
  }, [month]);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(user => {
      if (user) {
        setUid(user.uid);
      } else {
        // Link trong email cảnh báo trỏ thẳng tới đây: đăng nhập xong phải quay
        // lại đúng trang này chứ không rơi về trang đăng ký ăn.
        navigate(`/login?next=${SELF_PATH}`, { replace: true });
      }
    });
    return () => unsubscribe();
  }, [navigate]);

  // Dữ liệu chung + tháng hiện tại (thẻ Hôm nay luôn cần tháng này) + tháng
  // đang xem. Lần đầu (và Thử lại sau lỗi) thì xoá trắng, hiện vòng tải; tải
  // lại thì giữ dữ liệu cũ trên màn hình tới khi có dữ liệu mới.
  const load = useCallback(
    async (mode: LoadMode) => {
      if (!uid) return;
      const gen = ++generation.current;
      inFlight.current = true;
      const n = new Date();
      const p = vnParts(n) ?? { date: vnToday(), time: '00:00' };
      const t = p.date;
      const current = t.slice(0, 7);
      // Để trang mở qua đêm sang tháng mới: tháng đang chọn có thể đã rơi khỏi
      // danh sách 3 tháng, đưa về tháng hiện tại.
      const sel = recentMonths(t).includes(monthRef.current) ? monthRef.current : current;
      if (mode === 'initial') {
        setError(null);
        setBase(null);
        setMonths({});
      } else {
        setRefreshing(true);
      }
      try {
        const [b, cur, other] = await Promise.all([
          loadBase(uid),
          loadMonth(uid, current),
          sel === current ? null : loadMonth(uid, sel),
        ]);
        if (gen !== generation.current) return;
        loadedAt.current = { day: t, time: p.time, at: n.getTime() };
        setTodayIso(t);
        setNow(n);
        // Không ép về `sel`: Thầy/Cô có thể vừa bấm sang tháng khác trong lúc
        // đang tải; tháng đó (nếu chưa có) sẽ được tải riêng ở effect bên dưới.
        setMonth(prev => (recentMonths(t).includes(prev) ? prev : current));
        setBase(b);
        setMonths(other ? { [current]: cur, [sel]: other } : { [current]: cur });
        setError(null);
      } catch (e) {
        if (gen !== generation.current) return;
        console.error('Không tải được dữ liệu chấm ăn:', e);
        // Tự tải lại mà lỗi (vd mạng điện thoại chưa kịp bật lại khi mở lại
        // tab): giữ dữ liệu đang hiện, lần kiểm tra sau thử lại — trừ khi đã
        // sang ngày mới, vì khi đó thẻ "Hôm nay" đang hiện ngày hôm qua.
        if (mode !== 'auto' || loadedAt.current?.day !== t) setError(toViewError(e));
      } finally {
        if (gen === generation.current) {
          inFlight.current = false;
          setRefreshing(false);
        }
      }
    },
    [uid],
  );

  useEffect(() => {
    if (uid) void load('initial');
  }, [uid, load]);

  // Tự tải lại khi trang để mở lâu (xem needsRefresh). Kiểm tra mỗi phút chỉ
  // là so giờ, không đọc Firestore; chỉ khi cần mới tải.
  useEffect(() => {
    if (!uid) return;
    const check = (trigger: 'visible' | 'tick') => {
      if (document.visibilityState !== 'visible' || inFlight.current || !loadedAt.current) return;
      if (needsRefresh(loadedAt.current, new Date(), trigger)) void load('auto');
    };
    const onVisible = () => check('visible');
    const timer = window.setInterval(() => check('tick'), 60_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // Safari/Chrome trên điện thoại khôi phục trang từ bộ nhớ đệm khi bấm Quay lại.
    window.addEventListener('pageshow', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, [uid, load]);

  // Tháng cũ chỉ tải khi Thầy/Cô bấm chọn.
  useEffect(() => {
    if (!uid || !base || months[month]) return;
    const gen = generation.current;
    let cancelled = false;
    loadMonth(uid, month)
      .then(m => {
        if (!cancelled && gen === generation.current) setMonths(prev => ({ ...prev, [month]: m }));
      })
      .catch(e => {
        console.error('Không tải được dữ liệu tháng', month, e);
        if (!cancelled && gen === generation.current) setError(toViewError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [uid, base, month, months]);

  const currentMonth = todayIso.slice(0, 7);

  const computed = useMemo(() => {
    if (!base) return null;

    const holdOf = (date: string, md: MonthData): DayHold | null => {
      // Mã bị trùng thì agent không gán lượt chấm cho ai cả: thiếu lượt chấm
      // lúc đó là do chưa xác định được, không phải do Thầy/Cô không chấm. Chỉ
      // từ ngày bắt đầu trùng — trước đó là dữ liệu đúng, có thể đã gửi email.
      if (md.conflict && (!md.conflictFrom || date >= md.conflictFrom)) return 'conflict';
      // Chốt an toàn đã dừng gửi cảnh báo ngày này vì dữ liệu máy bất thường:
      // trang cũng không kết luận "Chưa chấm" — nếu không, chốt an toàn chỉ chặn
      // được email còn vi phạm oan vẫn hiện ở đây.
      if (base.heldDates.has(date)) return 'guarded';
      // Ngày cũ hơn mốc đồng bộ còn lưu: không còn căn cứ để kết luận lại.
      if (!base.coverage[date] && base.closedFrom && date < base.closedFrom) return 'expired';
      return null;
    };

    const viewDay = (date: string, md: MonthData): DayView => {
      const hold = holdOf(date, md);
      return {
        hold,
        result: evaluatePersonDay({
          date,
          registration: md.registration,
          cancelations: base.cancels,
          times: md.taps[date] || [],
          offDays: base.offDays,
          excludedIds: base.excludedIds,
          // Bỏ mốc đồng bộ để bữa đó hiện "Chưa có dữ liệu" thay vì "Chưa chấm" oan.
          coverageAt: hold === 'conflict' || hold === 'guarded' ? null : base.coverage[date] || null,
          now,
        }),
      };
    };

    const conflictOf = (md: MonthData | undefined): ConflictInfo | null =>
      md?.conflict
        ? {
            // conflict:true mà không kèm mã: vẫn phải báo, dùng mã trên hồ sơ cho dễ hiểu.
            ids: md.conflictIds.length ? md.conflictIds : [base.profile?.employeeId || '(không rõ)'],
            from: md.conflictFrom,
          }
        : null;

    const cur = months[currentMonth];
    const today = cur ? { ...viewDay(todayIso, cur), registration: cur.registration } : null;

    const sel = months[month];
    const monthData = sel
      ? {
          registration: sel.registration,
          days: mealDaysOfMonth(month, base.offDays, month === currentMonth ? todayIso : undefined)
            .reverse()
            .map(d => viewDay(d, sel)),
          conflict: conflictOf(sel),
          closedFrom: base.closedFrom,
          noData: !sel.hasTapsDoc && !Object.keys(base.coverage).some(d => d.startsWith(month)),
          heldDates: [...base.heldDates]
            .filter(d => d.startsWith(month) && (month !== currentMonth || d <= todayIso))
            .sort()
            .reverse(),
        }
      : null;

    return {
      today,
      monthData,
      conflict: conflictOf(cur),
      missedSyncAt: missedSyncRun(base.sync?.lastRunAt ?? null, now),
    };
  }, [base, months, month, currentMonth, todayIso, now]);

  return (
    <div className="font-body-lg flex min-h-screen min-w-0 flex-col pt-16 pb-24 md:pt-0 md:pb-0 md:pl-64">
      <Header />
      <Navigation />
      {/* Đặt ngoài MyMealsView để phần trình bày vẫn thuần props (xem trước bằng
          dữ liệu giả không đọc Firestore). Lề ngang khớp <main> của view. */}
      <SurveyBanner className="max-w-[1440px] w-full mx-auto px-md md:px-margin lg:px-xl pt-md md:pt-lg" />
      <MyMealsView
        loading={!error && !computed}
        refreshing={refreshing}
        error={error}
        onRetry={() => void load('initial')}
        onReload={() => void load('manual')}
        profile={base?.profile ?? null}
        todayIso={todayIso}
        today={computed?.today ?? null}
        sync={base?.sync ?? null}
        missedSyncAt={computed?.missedSyncAt ?? null}
        conflict={computed?.conflict ?? null}
        month={month}
        monthOptions={recentMonths(todayIso)}
        onMonthChange={setMonth}
        monthData={computed?.monthData ?? null}
      />
      <Footer />
    </div>
  );
}
