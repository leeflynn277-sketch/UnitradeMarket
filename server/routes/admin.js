/* ============================================================
   Campus Market — admin routes
   GET    /api/admin/users
   POST   /api/admin/users/:id/approve
   POST   /api/admin/users/:id/reject
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');
const { getNumberSetting, setSetting } = require('../lib/settings');

function requireAdmin(req) {
  const auth = requireAuth(req);
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.uid);
  if (!userRow) throw new HttpError(401, 'Session is no longer valid.');
  if (userRow.role !== 'admin') throw new HttpError(403, 'Only admins can manage accounts.');
  return userRow;
}

// When a buyer's account gets approved, any order they placed while
// unverified can now proceed. Confirm it and let both sides know.
function confirmPendingOrdersForBuyer(buyerId) {
  const orders = db.prepare("SELECT * FROM orders WHERE buyer_id = ? AND status = 'pending_verification'").all(buyerId);
  if (!orders.length) return;

  const notify = db.prepare(`INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, ?, ?, ?, ?, ?)`);

  for (const order of orders) {
    db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(order.id);

    notify.run(
      buyerId, 'order', '', 'Order confirmed',
      `Your account is verified — meet at ${order.zone_name || 'the agreed safe zone'} to complete the handover.`,
      `order-confirmation.html?id=${order.id}`
    );

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    for (const item of items) {
      if (item.seller_id) {
        notify.run(
          item.seller_id, 'order', '', 'Buyer verified — order confirmed',
          `The order for "${item.title_snapshot}" is now confirmed. Meet at ${order.zone_name || 'the agreed safe zone'} to complete the handover.`,
          `order-confirmation.html?id=${order.id}`
        );
      }
    }
  }
}

// When a buyer's account instead gets rejected, any order they placed while
// unverified must be cancelled, and every item in it returned to the
// marketplace (status back to 'active') so someone else can buy/claim it.
function cancelPendingOrdersForBuyer(buyerId) {
  const orders = db.prepare("SELECT * FROM orders WHERE buyer_id = ? AND status = 'pending_verification'").all(buyerId);
  if (!orders.length) return;

  const notify = db.prepare(`INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, ?, ?, ?, ?, ?)`);

  for (const order of orders) {
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
    for (const item of items) {
      if (item.product_id) {
        db.prepare("UPDATE products SET status = 'active' WHERE id = ?").run(item.product_id);
      }
      if (item.seller_id) {
        notify.run(
          item.seller_id, 'order', '', 'Order cancelled — listing relisted',
          `"${item.title_snapshot}" is back on the marketplace after the buyer's account could not be verified.`,
          `dashboard.html`
        );
      }
    }

    notify.run(
      buyerId, 'order', '', 'Order cancelled',
      'Your account could not be verified, so this order was cancelled. Contact an administrator if you think this is a mistake.',
      `order-confirmation.html?id=${order.id}`
    );
  }
}

function register(router) {
  router.get('/api/admin/stats', async (req, res) => {
    requireAdmin(req);

    const users = db.prepare('SELECT role, account_status FROM users').all();
    const products = db.prepare('SELECT status FROM products').all();
    const orders = db.prepare('SELECT id FROM orders').all();
    const notifications = db.prepare('SELECT id FROM notifications WHERE read_at IS NULL').all();
    const openReports = db.prepare("SELECT id FROM reports WHERE status = 'open'").all();
    const recentUsers = db
      .prepare('SELECT id, name, email, account_status, created_at FROM users ORDER BY created_at DESC LIMIT 5')
      .all();
    const recentListings = db
      .prepare(`
        SELECT products.id, products.title, products.status, products.price, products.created_at, users.name AS seller_name
        FROM products
        JOIN users ON users.id = products.seller_id
        ORDER BY products.created_at DESC
        LIMIT 5
      `)
      .all();

    const stats = {
      totalUsers: users.length,
      pendingApprovals: users.filter((u) => u.account_status === 'pending').length,
      approvedSellers: users.filter((u) => u.account_status === 'approved').length,
      suspendedUsers: users.filter((u) => u.account_status === 'suspended').length,
      activeListings: products.filter((p) => p.status === 'active').length,
      soldListings: products.filter((p) => p.status === 'sold' || p.status === 'claimed').length,
      totalOrders: orders.length,
      unreadNotifications: notifications.length,
      openReports: openReports.length,
    };

    sendJson(res, 200, { stats, recentUsers, recentListings });
  });

  router.get('/api/admin/users', async (req, res) => {
    requireAdmin(req);

    const rows = db
      .prepare(`
        SELECT id, name, email, student_id, role, account_status, can_sell, verified_at, admin_note, verification_photo, created_at
        FROM users
        ORDER BY CASE WHEN account_status = 'pending' THEN 0 ELSE 1 END, created_at DESC
      `)
      .all();

    sendJson(res, 200, { users: rows });
  });

  // Full detail for one account — used when an admin taps into a row for a
  // closer look, rather than bloating the list payload for everyone.
  router.get('/api/admin/users/:id', async (req, res) => {
    requireAdmin(req);
    const targetId = Number(req.params.id);
    const user = db.prepare(`
      SELECT id, name, email, student_id, role, account_status, can_sell, verified_at, admin_note, verification_photo, avatar_url, created_at
      FROM users WHERE id = ?
    `).get(targetId);
    if (!user) throw new HttpError(404, 'That account could not be found.');

    const listingsCount = db.prepare('SELECT COUNT(*) AS n FROM products WHERE seller_id = ?').get(targetId).n;
    const activeListingsCount = db.prepare("SELECT COUNT(*) AS n FROM products WHERE seller_id = ? AND status = 'active'").get(targetId).n;
    const ordersPlacedCount = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ?').get(targetId).n;
    const listings = db.prepare(`
      SELECT id, title, price, status, created_at FROM products WHERE seller_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(targetId);

    sendJson(res, 200, {
      user,
      stats: { listingsCount, activeListingsCount, ordersPlacedCount },
      listings,
    });
  });

  router.post('/api/admin/users/:id/approve', async (req, res) => {
    requireAdmin(req);
    const targetId = Number(req.params.id);
    const note = (req.body && req.body.note ? String(req.body.note).trim() : '').slice(0, 240);

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'That account could not be found.');

    db.prepare(`
      UPDATE users
      SET account_status = 'approved', can_sell = 1, verified_at = datetime('now'), admin_note = ?
      WHERE id = ?
    `).run(note, targetId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, icon, title, body, link)
      VALUES (?, 'admin', '', 'Account approved', ?, 'profile.html')
    `).run(targetId, note ? `Your account has been approved. ${note}` : 'Your account has been approved and you can now list items.');

    confirmPendingOrdersForBuyer(targetId);

    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/users/:id/reject', async (req, res) => {
    requireAdmin(req);
    const targetId = Number(req.params.id);
    const note = (req.body && req.body.note ? String(req.body.note).trim() : '').slice(0, 240);

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'That account could not be found.');

    db.prepare(`
      UPDATE users
      SET account_status = 'rejected', can_sell = 0, verified_at = NULL, admin_note = ?
      WHERE id = ?
    `).run(note, targetId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, icon, title, body, link)
      VALUES (?, 'admin', '', 'Account update', ?, 'profile.html')
    `).run(targetId, note ? `Your account needs attention. ${note}` : 'Your account needs attention before you can list items.');

    cancelPendingOrdersForBuyer(targetId);

    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/users/:id/suspend', async (req, res) => {
    const admin = requireAdmin(req);
    const targetId = Number(req.params.id);
    const note = (req.body && req.body.note ? String(req.body.note).trim() : '').slice(0, 240);

    if (targetId === admin.id) throw new HttpError(400, 'You cannot suspend your own account.');

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'That account could not be found.');
    if (target.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be suspended.');

    db.prepare(`
      UPDATE users
      SET account_status = 'suspended', can_sell = 0, admin_note = ?
      WHERE id = ?
    `).run(note, targetId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, icon, title, body, link)
      VALUES (?, 'admin', '', 'Account suspended', ?, 'profile.html')
    `).run(targetId, note ? `Your account has been suspended. ${note}` : 'Your account has been suspended. Contact an administrator for help.');

    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/users/:id/reinstate', async (req, res) => {
    requireAdmin(req);
    const targetId = Number(req.params.id);
    const note = (req.body && req.body.note ? String(req.body.note).trim() : '').slice(0, 240);

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'That account could not be found.');

    db.prepare(`
      UPDATE users
      SET account_status = 'approved', can_sell = 1, verified_at = datetime('now'), admin_note = ?
      WHERE id = ?
    `).run(note, targetId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, icon, title, body, link)
      VALUES (?, 'admin', '', 'Account reinstated', ?, 'profile.html')
    `).run(targetId, note ? `Your account has been reinstated. ${note}` : 'Your account has been reinstated and you can sign in again.');

    sendJson(res, 200, { ok: true });
  });

  router.get('/api/admin/reports', async (req, res) => {
    requireAdmin(req);
    const rows = db
      .prepare(`
        SELECT reports.*, products.title AS product_title, products.status AS product_status,
               reporter.name AS reporter_name, seller.name AS seller_name, seller.id AS seller_id
        FROM reports
        JOIN products ON products.id = reports.product_id
        JOIN users reporter ON reporter.id = reports.reporter_id
        JOIN users seller ON seller.id = products.seller_id
        ORDER BY CASE WHEN reports.status = 'open' THEN 0 ELSE 1 END, reports.created_at DESC
      `)
      .all();
    sendJson(res, 200, { reports: rows });
  });

  router.post('/api/admin/reports/:id/resolve', async (req, res) => {
    requireAdmin(req);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!report) throw new HttpError(404, 'That report could not be found.');

    const body = req.body || {};
    const action = body.action === 'remove-listing' ? 'remove-listing' : 'dismiss';
    const note = (body.note ? String(body.note).trim() : '').slice(0, 240);

    if (action === 'remove-listing') {
      db.prepare("UPDATE products SET status = 'rejected' WHERE id = ?").run(report.product_id);
    }

    db.prepare(`
      UPDATE reports SET status = 'resolved', admin_note = ?, resolved_at = datetime('now') WHERE id = ?
    `).run(note || null, report.id);

    sendJson(res, 200, { ok: true });
  });

  // Full listings oversight: admins can see and moderate every listing on
  // the marketplace, not just ones that were reported.
  router.get('/api/admin/products', async (req, res) => {
    requireAdmin(req);
    const rows = db
      .prepare(`
        SELECT products.id, products.title, products.price, products.status, products.category,
               products.created_at, products.views_count,
               users.id AS seller_id, users.name AS seller_name
        FROM products
        JOIN users ON users.id = products.seller_id
        ORDER BY CASE WHEN products.status = 'active' THEN 0 ELSE 1 END, products.created_at DESC
        LIMIT 100
      `)
      .all();
    sendJson(res, 200, { products: rows });
  });

  router.post('/api/admin/products/:id/remove', async (req, res) => {
    requireAdmin(req);
    const targetId = Number(req.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(targetId);
    if (!product) throw new HttpError(404, 'That listing could not be found.');

    db.prepare("UPDATE products SET status = 'removed' WHERE id = ?").run(targetId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, icon, title, body, link)
      VALUES (?, 'admin', '', 'Listing removed', ?, 'dashboard.html')
    `).run(product.seller_id, `Your listing "${product.title}" was removed by an admin for not meeting marketplace guidelines.`);

    sendJson(res, 200, { ok: true });
  });

  router.post('/api/admin/products/:id/restore', async (req, res) => {
    requireAdmin(req);
    const targetId = Number(req.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(targetId);
    if (!product) throw new HttpError(404, 'That listing could not be found.');

    db.prepare("UPDATE products SET status = 'active' WHERE id = ?").run(targetId);

    sendJson(res, 200, { ok: true });
  });

  router.get('/api/admin/settings', async (req, res) => {
    requireAdmin(req);
    sendJson(res, 200, { settings: { minSalePercent: getNumberSetting('min_sale_percent') } });
  });

  router.post('/api/admin/settings', async (req, res) => {
    requireAdmin(req);
    const body = req.body || {};
    const value = Number(body.minSalePercent);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      throw new HttpError(400, 'Minimum sale percent must be a number between 1 and 100.');
    }
    setSetting('min_sale_percent', Math.round(value));
    sendJson(res, 200, { settings: { minSalePercent: getNumberSetting('min_sale_percent') } });
  });
}

module.exports = { register };
