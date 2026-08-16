/* ============================================================
   Campus Market — order routes
   POST /api/orders        checkout the current cart
   GET  /api/orders        list my past orders (as buyer)
   GET  /api/orders/:id    single order detail
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');
const { timeAgo } = require('../lib/format');
const { getCartLines } = require('./cart');

function serializeOrder(orderRow) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderRow.id);
  return {
    id: orderRow.id,
    status: orderRow.status,
    subtotal: orderRow.subtotal,
    meetupTime: orderRow.meetup_time,
    zone: { name: orderRow.zone_name, sub: orderRow.zone_sub, icon: orderRow.zone_icon },
    createdAt: orderRow.created_at,
    postedAt: timeAgo(orderRow.created_at),
    items: items.map((it) => ({
      productId: it.product_id,
      title: it.title_snapshot,
      image: it.image_snapshot,
      qty: it.qty,
      size: it.size,
      color: it.color,
      unitPrice: it.unit_price,
      lineTotal: it.line_total,
    })),
  };
}

function register(router) {
  router.post('/api/orders', async (req, res) => {
    const auth = requireAuth(req);
    const lines = getCartLines(auth.uid);
    if (!lines.length) throw new HttpError(400, 'Your cart is empty.');

    const body = req.body || {};
    const zone = body.zone || {};
    const meetupTime = body.meetupTime || null;

    // Defense-in-depth: re-validate every line against the live product row at
    // checkout time (not just when it was added to cart) — status may have
    // changed, and ownership must never be trusted from anything cached client-side.
    for (const line of lines) {
      const live = db.prepare('SELECT status, seller_id, title FROM products WHERE id = ?').get(line.productId);
      if (!live) throw new HttpError(404, `"${line.product.title}" is no longer available.`);
      if (live.seller_id === auth.uid) throw new HttpError(403, 'You cannot buy or claim your own listing.');
      if (live.status !== 'active') throw new HttpError(409, `"${live.title}" was already claimed by someone else.`);
    }

    const subtotal = Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100;

    // A buyer whose account hasn't been approved by an admin yet can still
    // claim/buy — the item is reserved right away so nobody else can grab it
    // in the meantime — but the order sits in "pending_verification" instead
    // of going straight to "confirmed". It only proceeds once an admin
    // approves the buyer's account (see admin.js), or is cancelled and the
    // item returned to the marketplace if the admin rejects them instead.
    const buyer = db.prepare('SELECT name, account_status, role FROM users WHERE id = ?').get(auth.uid);
    const needsVerification = buyer.role !== 'admin' && buyer.account_status !== 'approved';
    const orderStatus = needsVerification ? 'pending_verification' : 'confirmed';

    const orderInfo = db
      .prepare(`
        INSERT INTO orders (buyer_id, zone_name, zone_sub, zone_icon, meetup_time, subtotal, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(auth.uid, zone.name || null, zone.sub || null, zone.icon || null, meetupTime, subtotal, orderStatus);

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, seller_id, title_snapshot, image_snapshot, qty, size, color, unit_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const notify = db.prepare(`
      INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const markSold = db.prepare(`UPDATE products SET status = ? WHERE id = ?`);

    for (const line of lines) {
      insertItem.run(
        orderInfo.lastInsertRowid,
        line.productId,
        line.product.seller.id,
        line.product.title,
        line.product.image,
        line.qty,
        line.size,
        line.color,
        line.product.price,
        line.lineTotal
      );

      markSold.run(line.product.price > 0 ? 'sold' : 'claimed', line.productId);

      if (line.product.seller.id !== auth.uid) {
        const verb = line.product.price > 0 ? 'purchased' : 'claimed';
        notify.run(
          line.product.seller.id,
          'order',
          '',
          `${buyer.name} ${verb} "${line.product.title}"`,
          needsVerification
            ? `Their account is awaiting admin verification — the handover will be confirmed once that clears.`
            : `Meet at ${zone.name || 'the agreed safe zone'} to complete the handover.`,
          `order-confirmation.html?id=${orderInfo.lastInsertRowid}`
        );
      }
    }

    if (needsVerification) {
      notify.run(
        auth.uid,
        'order',
        '',
        'Order is pending verification',
        'Your account needs admin approval before this order can be confirmed. We\u2019ll notify you as soon as it clears.',
        `order-confirmation.html?id=${orderInfo.lastInsertRowid}`
      );
    }

    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(auth.uid);

    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderInfo.lastInsertRowid);
    sendJson(res, 201, { order: serializeOrder(orderRow) });
  });

  router.get('/api/orders', async (req, res) => {
    const auth = requireAuth(req);
    const rows = db.prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY created_at DESC').all(auth.uid);
    sendJson(res, 200, { orders: rows.map(serializeOrder) });
  });

  router.get('/api/orders/:id', async (req, res) => {
    const auth = requireAuth(req);
    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!orderRow) throw new HttpError(404, 'Order not found.');

    const isBuyer = orderRow.buyer_id === auth.uid;
    const isSeller = db
      .prepare('SELECT 1 FROM order_items WHERE order_id = ? AND seller_id = ?')
      .get(orderRow.id, auth.uid);
    if (!isBuyer && !isSeller) throw new HttpError(403, 'You do not have access to this order.');

    sendJson(res, 200, { order: serializeOrder(orderRow) });
  });
}

module.exports = { register };
