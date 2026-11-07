// Trang web được Vercel triển khai ngay khi push, còn agent trên máy HAC được
// chép tay. Hai bên có thể lệch phiên bản: web đã có danh sách miễn chấm nhưng
// agent cũ vẫn gửi cảnh báo thiếu chấm cho người được miễn. Agent ghi phiên bản
// và các tính năng nó hỗ trợ vào settings/checkinSync; trang quản trị dùng các
// hàm dưới đây để cảnh báo khi agent chưa được cập nhật.

/** Bản agent đầu tiên áp dụng miễn chấm theo bữa và gửi thư "chấm chưa đăng ký". */
export const EXEMPTION_AGENT_VERSION = '2026-11-06.1';

export type AgentFeature = 'checkinExemptions' | 'extraAlerts';

/** Phiên bản agent dạng YYYY-MM-DD.N. */
function parseVersion(value: unknown): [string, number] | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})\.(\d{1,4})$/);
  return match ? [match[1], Number(match[2])] : null;
}

/** So sánh phiên bản theo ngày rồi theo số thứ tự (2026-11-06.10 mới hơn 2026-11-06.9). */
export function agentVersionAtLeast(version: unknown, minimum: string): boolean {
  const current = parseVersion(version);
  const required = parseVersion(minimum);
  if (!current || !required) return false;
  return current[0] > required[0] || (current[0] === required[0] && current[1] >= required[1]);
}

/** Agent đang chạy (theo lần đồng bộ gần nhất) có hỗ trợ tính năng này chưa. */
export function agentSupports(
  sync: { agentVersion?: unknown; agentFeatures?: unknown } | null | undefined,
  feature: AgentFeature,
): boolean {
  if (!sync) return false;
  if (Array.isArray(sync.agentFeatures)) return sync.agentFeatures.includes(feature);
  return agentVersionAtLeast(sync.agentVersion, EXEMPTION_AGENT_VERSION);
}
