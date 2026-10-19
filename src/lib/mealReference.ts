import { isMealDay, isSchoolStaffId, isUsableId, normId } from '../../agent/lib/meal-rules.mjs';
import { isIsoDate } from '../../agent/lib/common.mjs';
import type { Registration, TapRecord } from '../../agent/lib/meal-rules.mjs';

type DayTaps = Record<string, Record<string, TapRecord>>;

/** Chỉ liệt kê ngày không tính suất tháng nhưng thực tế có giờ chấm từ máy. */
export function referenceCheckinDates(byDate: DayTaps, offDays: string[], until: string) {
  return Object.keys(byDate)
    .filter(date => isIsoDate(date) && date <= until && !isMealDay(date, offDays)
      && Object.values(byDate[date]).some(hasRecordedTime))
    .sort().reverse();
}

const hasRecordedTime = (record: TapRecord) => !!(record.breakfast || record.lunch || record.unrecognized?.length);

/** Dữ liệu tham khảo riêng, không đi qua đối soát, tính suất hoặc gửi cảnh báo. */
export function referenceCheckinRows(records: Record<string, TapRecord>, registrations: Registration[], excludedIds: string[]) {
  const registered = new Set(registrations.map(r => normId(r.employeeId)).filter(isUsableId));
  const excluded = new Set(excludedIds.map(normId));
  const rows: TapRecord[] = [];
  let excludedCount = 0;
  for (const [rawId, record] of Object.entries(records)) {
    if (!hasRecordedTime(record)) continue;
    const employeeId = normId(rawId);
    // Cùng chính sách loại lượt chấm công của Bếp Vina với đối soát thông
    // thường. Người đã đăng ký ăn không bị loại chỉ vì mã có dạng đặc biệt.
    if (!registered.has(employeeId) && (excluded.has(employeeId) || !isSchoolStaffId(employeeId))) {
      excludedCount++;
      continue;
    }
    rows.push({ ...record, employeeId, unrecognized: record.unrecognized || [] });
  }
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'vi') || a.employeeId.localeCompare(b.employeeId));
  return { rows, excludedCount };
}

export function filterReferenceCheckins(rows: TapRecord[], search: string) {
  const query = search.trim().toLocaleLowerCase('vi');
  if (!query) return rows;
  return rows.filter(row => row.employeeId.toLocaleLowerCase('vi').includes(query)
    || (row.name || '').toLocaleLowerCase('vi').includes(query));
}
