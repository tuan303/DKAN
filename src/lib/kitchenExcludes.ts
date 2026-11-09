import { normalizeExemptionEmployeeId as normId } from '../../agent/lib/checkin-exemptions.mjs';

/**
 * Danh sách mã nhân sự Bếp Vina không đưa vào đối soát (settings/reconcileExcludes).
 *
 * Bếp Vina chấm công trên cùng máy nhận diện với CBNV. Mã không đủ 6 chữ số tự
 * bị loại (meal-rules.mjs); người của bếp mang mã 6 chữ số như CBNV thì chỉ
 * nhận ra được qua danh sách này. Doc có ba trường:
 *   - employeeIds: danh sách MỌI nơi đọc (agent, web, máy chủ) — luôn là hợp
 *     của hai trường dưới, chỉ ghi qua các hàm ở đây;
 *   - fileIds: mã thuộc bộ phận Bếp Vina trong file HAC tải lên gần nhất;
 *   - manualIds: mã quản trị thêm tay, giữ nguyên khi tải file HAC mới.
 * Doc bản cũ chỉ có employeeIds (đều lấy từ file HAC): coi như fileIds.
 */

export const MAX_KITCHEN_ID_LENGTH = 40;
export const MAX_MANUAL_KITCHEN_IDS = 500;

export interface KitchenExcludes {
  employeeIds: string[];
  fileIds: string[];
  manualIds: string[];
}

const ID_RE = /^[A-Z0-9]{1,40}$/;

/** Mã đã chuẩn hoá; chuỗi rỗng nếu không phải mã dùng được. */
export function cleanKitchenId(value: unknown): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return '';
  const id = normId(value);
  return ID_RE.test(id) && id !== 'NA' ? id : '';
}

/** Lọc, chuẩn hoá, bỏ trùng và sắp xếp để so sánh/ghi ổn định. */
export function cleanKitchenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanKitchenId).filter(Boolean))].sort();
}

const union = (...lists: string[][]) => [...new Set(lists.flat())].sort();

export function readKitchenExcludes(data: unknown): KitchenExcludes {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const employeeIds = cleanKitchenIds(raw.employeeIds);
  const manualIds = cleanKitchenIds(raw.manualIds);
  const manual = new Set(manualIds);
  const fileIds = Array.isArray(raw.fileIds)
    ? cleanKitchenIds(raw.fileIds)
    : employeeIds.filter(id => !manual.has(id));
  return { employeeIds: union(fileIds, manualIds), fileIds, manualIds };
}

const build = (fileIds: string[], manualIds: string[]): KitchenExcludes => ({
  employeeIds: union(fileIds, manualIds),
  fileIds,
  manualIds,
});

export const sameKitchenExcludes = (a: KitchenExcludes, b: KitchenExcludes) =>
  (['employeeIds', 'fileIds', 'manualIds'] as const).every(k => a[k].join('\n') === b[k].join('\n'));

/** Tải file HAC: thay phần lấy từ file, giữ nguyên mã thêm tay. */
export function withFileKitchenIds(current: KitchenExcludes, ids: unknown[]): KitchenExcludes {
  return build(cleanKitchenIds(ids), current.manualIds);
}

export function addManualKitchenIds(current: KitchenExcludes, ids: string[]) {
  const wanted = cleanKitchenIds(ids);
  const have = new Set(current.manualIds);
  const added = wanted.filter(id => !have.has(id));
  const already = wanted.filter(id => have.has(id));
  const manualIds = union(current.manualIds, added);
  if (manualIds.length > MAX_MANUAL_KITCHEN_IDS) {
    throw new Error(`Danh sách thêm tay tối đa ${MAX_MANUAL_KITCHEN_IDS} mã.`);
  }
  return { next: build(current.fileIds, manualIds), added, already };
}

/**
 * Gỡ một mã thêm tay. Mã vẫn có trong file HAC thì vẫn bị loại (`stillFromFile`)
 * cho tới khi file HAC tải lên sau không còn xếp mã đó vào Bếp Vina.
 */
export function removeManualKitchenId(current: KitchenExcludes, id: string) {
  const target = cleanKitchenId(id);
  const next = build(current.fileIds, current.manualIds.filter(x => x !== target));
  return { next, removed: current.manualIds.includes(target), stillFromFile: current.fileIds.includes(target) };
}

/**
 * Đọc danh sách dán vào ô nhập, mỗi dòng một người, ví dụ "101163: Đỗ Thị Quy",
 * "101163 - Đỗ Thị Quy", dòng dán từ Excel (mã, Tab, tên) hoặc "101163, 101740".
 * Lấy từ đầu mỗi đoạn một mã gồm chữ/số có ít nhất một chữ số; tên phía sau chỉ
 * để người dán dễ đọc, không lưu.
 */
export function parseKitchenCodes(text: string) {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const piece of String(text ?? '').split(/[\r\n,;]+/)) {
    const line = piece.trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9]+)(?=$|[\s:.\-–—|(])/.exec(line);
    const id = m && /\d/.test(m[1]) ? cleanKitchenId(m[1]) : '';
    if (id) ids.push(id);
    else invalid.push(line.slice(0, 60));
  }
  return { ids: [...new Set(ids)], invalid };
}

/** Mã đang đứng trên đơn đăng ký ăn: thêm vào danh sách bếp thì người đó không còn được đối soát. */
export function kitchenRegistrationConflicts(
  ids: string[],
  registrations: { employeeId?: unknown; fullName?: unknown }[],
) {
  const wanted = new Set(ids.map(cleanKitchenId).filter(Boolean));
  const found = new Map<string, string>();
  for (const reg of registrations) {
    const id = cleanKitchenId(reg.employeeId);
    if (id && wanted.has(id) && !found.has(id)) found.set(id, typeof reg.fullName === 'string' ? reg.fullName : '');
  }
  return [...found].map(([employeeId, fullName]) => ({ employeeId, fullName }));
}
