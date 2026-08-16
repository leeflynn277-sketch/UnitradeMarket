/* ============================================================
   Campus Market — favorites ("Saved Items") routes
   GET    /api/favorites           my favorited product ids
   POST   /api/favorites/:id       favorite a product
   DELETE /api/favorites/:id       unfavorite a product
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');

function register(router) {
  router.get('/api/favorites', async (req, res) => {
    const auth = requireAuth(req);
    const rows = db.prepare('SELECT product_id FROM favorites WHERE user_id = ?').all(auth.uid);
    sendJson(res, 200, { productIds: rows.map((r) => r.product_id) });
  });

  router.post('/api/favorites/:id', async (req, res) => {
    const auth = requireAuth(req);
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!product) throw new HttpError(404, 'That listing could not be found.');
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, product_id) VALUES (?, ?)').run(auth.uid, product.id);
    sendJson(res, 200, { favorited: true });
  });

  router.delete('/api/favorites/:id', async (req, res) => {
    const auth = requireAuth(req);
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?').run(auth.uid, req.params.id);
    sendJson(res, 200, { favorited: false });
  });
}

module.exports = { register };
