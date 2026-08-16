/* ============================================================
   Campus Market — shared serialization helpers
   ============================================================ */
'use strict';

// SQLite's datetime('now') returns UTC, formatted as "YYYY-MM-DD HH:MM:SS".
// Parse that explicitly as UTC so relative-time math is correct regardless
// of the server machine's local timezone.
function parseSqlDate(sqlDateStr) {
  if (!sqlDateStr) return new Date();
  return new Date(sqlDateStr.replace(' ', 'T') + 'Z');
}

function timeAgo(sqlDateStr) {
  const date = parseSqlDate(sqlDateStr);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    studentId: row.student_id,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url || null,
    role: row.role || 'user',
    accountStatus: row.account_status || 'approved',
    canSell: !!row.can_sell,
    isVerified: row.account_status === 'approved' || row.can_sell === 1,
    isAdmin: row.role === 'admin',
  };
}
function serializeProduct(row, opts = {}) {
  return {
    id: row.id,
    title: row.title,
    sub: row.sub,
    category: row.category,
    price: row.price,
    originalPrice: row.original_price || null,
    discountPercent: row.original_price && row.original_price > row.price
      ? Math.round((1 - row.price / row.original_price) * 100)
      : null,
    description: row.description,
    location: row.location,
    sellerContact: row.seller_contact || null,
    image: row.image,
    gallery: JSON.parse(row.gallery_json || '[]'),
    sizes: row.sizes_json ? JSON.parse(row.sizes_json) : null,
    colors: row.colors_json ? JSON.parse(row.colors_json) : null,
    defaultSize: row.default_size,
    defaultColor: row.default_color,
    status: row.status,
    postedAt: timeAgo(row.created_at),
    createdAt: row.created_at,
    seller: {
      id: row.seller_id,
      name: row.seller_name,
    },
    isFavorited: opts.isFavorited || false,
    isMine: opts.viewerId != null && Number(opts.viewerId) === Number(row.seller_id),
    stats: opts.stats || undefined,
  };
}

module.exports = { timeAgo, parseSqlDate, publicUser, serializeProduct };
