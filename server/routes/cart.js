/* ============================================================
   Campus Market — cart routes (persisted per-account, not localStorage)
   GET    /api/cart
   POST   /api/cart                add/increment an item
   PATCH  /api/cart/:itemId        set quantity
   DELETE /api/cart/:itemId
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');
const { serializeProduct } = require('../lib/format');

const PRODUCT_SELECT = `
  SELECT products.*, users.name AS seller_name
  FROM products JOIN users ON users.id = products.seller_id
  WHERE products.id = ?
`;

function getCartLines(userId) {
  const items = db
    .prepare('SELECT * FROM cart_items WHERE user_id = ? ORDER BY id ASC')
    .all(userId);

  return items
    .map((item) => {
      const productRow = db.prepare(PRODUCT_SELECT).get(item.product_id);
      if (!productRow) return null;
      const product = serializeProduct(productRow, { viewerId: userId });
      return {
        itemId: item.id,
        productId: item.product_id,
        qty: item.qty,
        size: item.size,
        color: item.color,
        product,
        lineTotal: Math.round(product.price * item.qty * 100) / 100,
      };
    })
    .filter(Boolean);
}

function register(router) {
  router.get('/api/cart', async (req, res) => {
    const auth = requireAuth(req);
    const lines = getCartLines(auth.uid);
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    sendJson(res, 200, { lines, subtotal: Math.round(subtotal * 100) / 100 });
  });

  router.post('/api/cart', async (req, res) => {
    const auth = requireAuth(req);
    const body = req.body || {};
    const productId = Number(body.productId);
    const qty = Math.max(1, parseInt(body.qty, 10) || 1);
    const size = body.size || null;
    const color = body.color || null;

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) throw new HttpError(404, 'That listing could not be found.');
    if (product.status !== 'active') throw new HttpError(409, 'This item is no longer available.');
    if (product.seller_id === auth.uid) throw new HttpError(403, 'You cannot buy or claim your own listing.');

    const existing = db
      .prepare("SELECT * FROM cart_items WHERE user_id = ? AND product_id = ? AND IFNULL(size,'')=IFNULL(?,'') AND IFNULL(color,'')=IFNULL(?,'')")
      .get(auth.uid, productId, size, color);

    if (existing) {
      db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(existing.qty + qty, existing.id);
    } else {
      db.prepare('INSERT INTO cart_items (user_id, product_id, qty, size, color) VALUES (?, ?, ?, ?, ?)').run(
        auth.uid, productId, qty, size, color
      );
    }

    const lines = getCartLines(auth.uid);
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    sendJson(res, 201, { lines, subtotal: Math.round(subtotal * 100) / 100 });
  });

  router.patch('/api/cart/:itemId', async (req, res) => {
    const auth = requireAuth(req);
    const item = db.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?').get(req.params.itemId, auth.uid);
    if (!item) throw new HttpError(404, 'Cart item not found.');
    const qty = Math.max(1, parseInt((req.body || {}).qty, 10) || 1);
    db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(qty, item.id);
    const lines = getCartLines(auth.uid);
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    sendJson(res, 200, { lines, subtotal: Math.round(subtotal * 100) / 100 });
  });

  router.delete('/api/cart/:itemId', async (req, res) => {
    const auth = requireAuth(req);
    const item = db.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?').get(req.params.itemId, auth.uid);
    if (!item) throw new HttpError(404, 'Cart item not found.');
    db.prepare('DELETE FROM cart_items WHERE id = ?').run(item.id);
    const lines = getCartLines(auth.uid);
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    sendJson(res, 200, { lines, subtotal: Math.round(subtotal * 100) / 100 });
  });
}

module.exports = { register, getCartLines };
