// Phải khớp với danh sách email trong isAdmin() của firestore.rules.
export const SUPER_ADMINS: readonly string[] = Object.freeze([
  'tuantm@hoangmaistarschool.edu.vn',
  'tuyetkta@hoangmaistarschool.edu.vn',
  'tuan303@gmail.com',
]);

export function isSuperAdmin(email?: string | null): boolean {
  return typeof email === 'string' && SUPER_ADMINS.includes(email.trim().toLowerCase());
}
