export type AdminFunctionKey = 'monthly' | 'daily_stats' | 'cancelations' | 'events' | 'blocked' | 'reconcile' | 'settings' | 'menu' | 'survey' | 'logs' | 'admins';
export type AdminTabKey = 'overview' | AdminFunctionKey;

export const ADMIN_MENU_GROUPS = [
  { key: 'operations', label: 'Vận hành hằng ngày', description: 'Theo dõi số suất, báo hủy và đối chiếu lượt chấm.' },
  { key: 'registration', label: 'Đăng ký suất ăn', description: 'Quản lý đăng ký tháng, sự kiện và hạn chế đăng ký.' },
  { key: 'nutrition', label: 'Dinh dưỡng', description: 'Cập nhật thực đơn và theo dõi ý kiến về bữa ăn.' },
  { key: 'system', label: 'Hệ thống', description: 'Cấu hình, quyền quản trị và lịch sử truy cập.' },
] as const;

export const ADMIN_TABS: {
  key: AdminFunctionKey;
  label: string;
  description: string;
  icon: string;
  group: typeof ADMIN_MENU_GROUPS[number]['key'];
  tone: string;
}[] = [
  { key: 'daily_stats', label: 'Suất ăn theo ngày', description: 'Xem danh sách và số suất ăn theo ngày.', icon: 'list_alt', group: 'operations', tone: 'bg-[#16a2b8] text-white' },
  { key: 'reconcile', label: 'Đối soát chấm ăn', description: 'Đối chiếu đăng ký với lượt chấm từ máy.', icon: 'fact_check', group: 'operations', tone: 'bg-[#6554d9] text-white' },
  { key: 'cancelations', label: 'Danh sách hủy ăn', description: 'Tra cứu yêu cầu hủy theo ngày và bữa ăn.', icon: 'event_busy', group: 'operations', tone: 'bg-[#ed675d] text-white' },
  { key: 'monthly', label: 'Đăng ký tháng', description: 'Tra cứu đăng ký và tổng số suất theo tháng.', icon: 'calendar_month', group: 'registration', tone: 'bg-[#ff4050] text-white' },
  { key: 'events', label: 'Suất ăn sự kiện', description: 'Tạo sự kiện và quản lý danh sách đăng ký.', icon: 'celebration', group: 'registration', tone: 'bg-[#f39a00] text-white' },
  { key: 'blocked', label: 'Hạn chế đăng ký', description: 'Quản lý tài khoản bị hạn chế đăng ký suất ăn.', icon: 'gavel', group: 'registration', tone: 'bg-[#ce7650] text-white' },
  { key: 'menu', label: 'Thực đơn tuần', description: 'Tải mẫu Excel, nhập và cập nhật thực đơn tuần.', icon: 'restaurant_menu', group: 'nutrition', tone: 'bg-[#16a2b8] text-white' },
  { key: 'survey', label: 'Khảo sát bữa ăn', description: 'Quản lý khảo sát và xem phản hồi chất lượng.', icon: 'rate_review', group: 'nutrition', tone: 'bg-[#249e59] text-white' },
  { key: 'settings', label: 'Cấu hình hệ thống', description: 'Thiết lập lịch, thời hạn và quy định đăng ký.', icon: 'settings', group: 'system', tone: 'bg-[#778393] text-white' },
  { key: 'logs', label: 'Nhật ký đăng nhập', description: 'Tra cứu lịch sử truy cập và kết quả đăng nhập.', icon: 'history', group: 'system', tone: 'bg-[#9e58d7] text-white' },
  { key: 'admins', label: 'Tài khoản quản trị', description: 'Thêm, xóa và quản lý quyền quản trị.', icon: 'admin_panel_settings', group: 'system', tone: 'bg-[#d21235] text-white' },
];

export function resolveAdminTab(value: string | null): AdminTabKey {
  return ADMIN_TABS.some(tab => tab.key === value) ? value as AdminFunctionKey : 'overview';
}

/** Match Vietnamese menu names without requiring accents or word order. */
export function matchesMenuSearch(query: string, ...values: string[]): boolean {
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const haystack = normalize(values.join(' '));
  return normalize(query).trim().split(/\s+/).every(word => haystack.includes(word));
}
