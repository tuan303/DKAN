import { isIsoDate } from '../../agent/lib/common.mjs';
import { mealDaysOfMonth } from '../../agent/lib/meal-rules.mjs';

/** Ngày ăn thường và các ngày thực sự có lượt chấm; ngày nghỉ chỉ để tra cứu. */
export function personalHistoryDates(
  month: string,
  offDays: string[],
  taps: Record<string, string[]>,
  until: string,
): string[] {
  const observed = Object.entries(taps)
    .filter(([date, times]) => isIsoDate(date) && date.startsWith(`${month}-`) && date <= until
      && times.some(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)))
    .map(([date]) => date);
  return [...new Set([...mealDaysOfMonth(month, offDays, until), ...observed])].sort().reverse();
}
