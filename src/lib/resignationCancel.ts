import { addDays, isIsoDate } from '../../agent/lib/common.mjs';
import { formatDate, isMealDay } from '../../agent/lib/meal-rules.mjs';

/**
 * Quản trị hủy ăn phần còn lại của tháng cho nhân viên nghỉ việc giữa tháng.
 *
 * Dùng đúng cơ chế báo hủy sẵn có (`cancel_registrations/{uid}_{ngày}`, mỗi ngày
 * một tài liệu) nên agent gửi cảnh báo, tab Đối soát, trang "Chấm ăn của tôi" và
 * số suất hủy hôm nay/ngày mai đều tự hiểu — không phải sửa chỗ nào khác. Chỉ tạo
 * cho ngày có suất ăn (thứ 2–6, không phải ngày nghỉ đã khai), từ ngày bắt đầu ăn
 * trên đơn trở đi, và chỉ cho các bữa có trong đơn.
 */

export type Meal = 'breakfast' | 'lunch';
export type CancelMeal = Meal | 'both';

export const RESIGNATION_REASON = 'Nghỉ việc';
export const RESIGNATION_SOURCE = 'admin-resignation';
export const MAX_REASON_LENGTH = 200;
export const CANTEENS = { tieuhoc: 'Nhà ăn Tiểu học', trunghoc: 'Nhà ăn Trung học' } as const;
export type Canteen = keyof typeof CANTEENS;

export interface ResignationRegistration {
  userId: string;
  month: string;
  employeeId?: string;
  fullName?: string;
  department?: string;
  email?: string;
  breakfastCount?: number;
  lunchCount?: number;
  firstMealDate?: string;
}

/** Báo hủy đã có của người đó (kèm mã tài liệu). */
export interface ExistingCancel {
  id: string;
  cancelDate?: unknown;
  cancelMeal?: unknown;
  [field: string]: unknown;
}

export interface ResignationWrite {
  id: string;
  date: string;
  cancelMeal: CancelMeal;
  /** Tài liệu cùng mã đang có (bị ghi đè), để hoàn tác; null nếu tạo mới. */
  previous: Record<string, unknown> | null;
}

const MEAL_ORDER: Meal[] = ['breakfast', 'lunch'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const MEAL_NAMES: Record<CancelMeal, string> = {
  breakfast: 'bữa sáng',
  lunch: 'bữa trưa',
  both: 'bữa sáng và bữa trưa',
};

/** Các bữa có trong đơn (đơn cũ ghi breakfastCount mà lunchCount = 0 vẫn là cả hai bữa — xem trang Quản trị). */
export function registeredMeals(reg: Pick<ResignationRegistration, 'breakfastCount' | 'lunchCount'>): Meal[] {
  const breakfast = Number(reg.breakfastCount) > 0;
  const lunch = Number(reg.lunchCount) > 0 || breakfast;
  return MEAL_ORDER.filter(meal => (meal === 'breakfast' ? breakfast : lunch));
}

const mealsOf = (value: unknown): Meal[] =>
  value === 'both' ? [...MEAL_ORDER] : value === 'breakfast' || value === 'lunch' ? [value] : [];

export const cancelMealOf = (meals: Iterable<Meal>): CancelMeal => {
  const set = new Set(meals);
  return set.has('breakfast') && set.has('lunch') ? 'both' : set.has('breakfast') ? 'breakfast' : 'lunch';
};

/** Ngày cuối tháng, YYYY-MM-DD. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Ngày sớm nhất được hủy: ngày bắt đầu ăn trên đơn (nếu thuộc tháng), không thì ngày 1. */
export function firstCancelableDate(reg: Pick<ResignationRegistration, 'month' | 'firstMealDate'>): string {
  const first = `${reg.month}-01`;
  const start = typeof reg.firstMealDate === 'string' && reg.firstMealDate.startsWith(`${reg.month}-`) && isIsoDate(reg.firstMealDate)
    ? reg.firstMealDate : first;
  return start > first ? start : first;
}

/** Ngày mặc định của ô "Hủy từ ngày": hôm nay nếu thuộc tháng của đơn, không thì ngày sớm nhất được hủy. */
export function defaultCancelFrom(reg: Pick<ResignationRegistration, 'month' | 'firstMealDate'>, today: string): string {
  const first = firstCancelableDate(reg);
  const end = monthEnd(reg.month);
  if (today > end) return first;
  return today > first ? today : first;
}

export type ResignationPlan =
  | { ok: false; error: string }
  | {
    ok: true;
    meals: Meal[];
    cancelMeal: CancelMeal;
    start: string;
    end: string;
    writes: ResignationWrite[];
    /** Ngày đã có báo hủy đủ các bữa của đơn: không ghi gì. */
    skipped: string[];
    /** Ngày đã qua (trước hôm nay) trong các ngày sẽ ghi. */
    pastDates: string[];
  };

export function planResignationCancel({ registration, fromDate, offDays = [], existing = [], today }: {
  registration: ResignationRegistration;
  fromDate: string;
  offDays?: Iterable<string>;
  existing?: ExistingCancel[];
  today: string;
}): ResignationPlan {
  if (!registration.userId || registration.userId.includes('/')) return { ok: false, error: 'Đơn đăng ký không có tài khoản hợp lệ.' };
  if (!MONTH_RE.test(registration.month)) return { ok: false, error: 'Tháng của đơn đăng ký không hợp lệ.' };
  const meals = registeredMeals(registration);
  if (!meals.length) return { ok: false, error: 'Đơn tháng này không đăng ký bữa nào.' };
  const first = firstCancelableDate(registration);
  const end = monthEnd(registration.month);
  if (!isIsoDate(fromDate) || !fromDate.startsWith(`${registration.month}-`)) {
    return { ok: false, error: `Ngày bắt đầu hủy phải thuộc tháng ${registration.month.slice(5)}/${registration.month.slice(0, 4)}.` };
  }
  const start = fromDate < first ? first : fromDate;
  const off = [...offDays];

  const writes: ResignationWrite[] = [];
  const skipped: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (!isMealDay(date, off)) continue;
    const sameDay = existing.filter(c => c.cancelDate === date);
    const covered = new Set(sameDay.flatMap(c => mealsOf(c.cancelMeal)));
    if (meals.every(meal => covered.has(meal))) {
      skipped.push(date);
      continue;
    }
    const id = `${registration.userId}_${date}`;
    const current = sameDay.find(c => c.id === id);
    let previous: Record<string, unknown> | null = null;
    if (current) {
      const { id: _id, ...data } = current;
      previous = data;
    }
    // Giữ cả bữa người đó đã tự báo hủy (kể cả bữa ngoài đơn) — chỉ thêm, không bớt.
    writes.push({ id, date, cancelMeal: cancelMealOf([...covered, ...meals]), previous });
  }
  return {
    ok: true,
    meals,
    cancelMeal: cancelMealOf(meals),
    start,
    end,
    writes,
    skipped,
    pastDates: writes.filter(w => w.date < today).map(w => w.date),
  };
}

export function validateResignationInput({ canteen, reason }: { canteen: string; reason: string }): string | null {
  if (!Object.hasOwn(CANTEENS, canteen)) return 'Chọn nhà ăn của nhân viên.';
  const text = reason.trim();
  if (!text) return 'Nhập lý do hủy ăn.';
  if (text.length > MAX_REASON_LENGTH) return `Lý do tối đa ${MAX_REASON_LENGTH} ký tự.`;
  return null;
}

/** Nội dung tài liệu báo hủy — cùng các trường như khi nhân viên tự báo hủy, thêm dấu vết quản trị. */
export function resignationCancelDoc(write: ResignationWrite, { registration, reason, canteen, adminEmail, batchId, at }: {
  registration: ResignationRegistration;
  reason: string;
  canteen: Canteen;
  adminEmail: string;
  batchId: string;
  at: string;
}) {
  return {
    userId: registration.userId,
    fullName: registration.fullName ?? '',
    employeeId: registration.employeeId ?? '',
    department: registration.department ?? '',
    email: registration.email ?? '',
    cancelDate: write.date,
    formattedDate: formatDate(write.date),
    cancelMeal: write.cancelMeal,
    cancelReason: reason.trim(),
    cancelCanteen: canteen,
    timestamp: at,
    source: RESIGNATION_SOURCE,
    createdBy: adminEmail,
    adminBatch: batchId,
  };
}

/** Hoàn tác một lần hủy: tài liệu tạo mới thì xóa, tài liệu bị ghi đè thì ghi lại bản cũ. */
export function undoOperations(writes: ResignationWrite[]) {
  return writes.map(w => (w.previous ? { op: 'set' as const, id: w.id, data: w.previous } : { op: 'delete' as const, id: w.id }));
}

/** "06/11 – 30/11/2026 · 17 ngày" để hiện trong bản xem trước. */
export function describeRange(dates: string[]): string {
  if (!dates.length) return 'không có ngày nào';
  const first = dates[0];
  const last = dates[dates.length - 1];
  const range = first === last ? formatDate(first) : `${first.slice(8, 10)}/${first.slice(5, 7)} – ${formatDate(last)}`;
  return `${range} · ${dates.length} ngày`;
}
