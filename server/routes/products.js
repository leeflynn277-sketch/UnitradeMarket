/* ============================================================
   Campus Market — product (listing) routes
   GET    /api/products            list + filter (q, category, type, mine, saved)
   GET    /api/products/:id        single listing
   POST   /api/products            create listing (auth required)
   PUT    /api/products/:id        edit own listing (auth required)
   DELETE /api/products/:id        remove own listing (auth required)
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');
const { serializeProduct } = require('../lib/format');
const { persistImages } = require('../lib/uploads');
const { getNumberSetting } = require('../lib/settings');

const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=80';
const VALID_CATEGORIES = new Set(['books', 'electronics', 'fashion', 'sports', 'lab', 'misc']);

// A seller can mark an item as discounted from an "original price", but an
// admin-configured floor stops discounts from going too deep (e.g. sale
// price can't drop below 70% of the original price by default).
function validateDiscount(price, originalPrice) {
  if (originalPrice === null || originalPrice === undefined || originalPrice === '') return null;
  const original = Number(originalPrice);
  if (!Number.isFinite(original) || original <= 0) {
    throw new HttpError(400, 'Original price must be a positive number.');
  }
  if (price > original) {
    throw new HttpError(400, 'Sale price cannot be higher than the original price.');
  }
  const minPercent = getNumberSetting('min_sale_percent');
  const floor = Math.round(original * (minPercent / 100) * 100) / 100;
  if (price < floor) {
    throw new HttpError(400, `The sale price can't be discounted below ${minPercent}% of the original price (minimum GH₵${floor.toFixed(2)}).`);
  }
  return original;
}

const BASE_SELECT = `
  SELECT products.*, users.name AS seller_name
  FROM products
  JOIN users ON users.id = products.seller_id
`;

function favoriteIdSetForUser(userId) {
  if (!userId) return new Set();
  const rows = db.prepare('SELECT product_id FROM favorites WHERE user_id = ?').all(userId);
  return new Set(rows.map((r) => r.product_id));
}

// Seller-dashboard stats (real numbers, no fabricated metrics):
//   views = detail-page visits by people other than the seller
//   saves = how many buyers favorited the listing
//   chats = distinct conversations started about the listing
function statsForProduct(productId) {
  const views = db.prepare('SELECT views_count AS n FROM products WHERE id = ?').get(productId);
  const saves = db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE product_id = ?').get(productId);
  const chats = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE product_id = ?').get(productId);
  return {
    views: (views && views.n) || 0,
    saves: (saves && saves.n) || 0,
    chats: (chats && chats.n) || 0,
  };
}

function register(router) {
  router.get('/api/settings/discount-cap', async (req, res) => {
    sendJson(res, 200, { minSalePercent: getNumberSetting('min_sale_percent') });
  });

  router.get('/api/products', async (req, res) => {
    const { q, category, type, mine, saved, sort, limit, minPrice, maxPrice, location, status } = req.query;
    const where = [];
    const params = [];
    let isMineQuery = false;

    if (mine === '1' || mine === 'true') {
      isMineQuery = true;
      const auth = requireAuth(req);
      where.push('products.seller_id = ?');
      params.push(auth.uid);
      if (status) {
        where.push('products.status = ?');
        params.push(status);
      }
    } else {
      where.push("products.status = 'active'");
    }

    if (saved === '1' || saved === 'true') {
      const auth = requireAuth(req);
      where.push('products.id IN (SELECT product_id FROM favorites WHERE user_id = ?)');
      params.push(auth.uid);
    }

    if (category) {
      where.push('products.category = ?');
      params.push(category);
    }

    if (type === 'free') where.push('products.price <= 0');
    if (type === 'trade') where.push('products.price > 0');

    if (minPrice !== undefined && minPrice !== '') {
      where.push('products.price >= ?');
      params.push(Math.max(0, Number(minPrice) || 0));
    }
    if (maxPrice !== undefined && maxPrice !== '') {
      where.push('products.price <= ?');
      params.push(Math.max(0, Number(maxPrice) || 0));
    }
    if (location) {
      where.push('lower(products.location) LIKE ?');
      params.push(`%${String(location).toLowerCase()}%`);
    }

    if (q) {
      where.push('(lower(products.title) LIKE ? OR lower(products.sub) LIKE ? OR lower(products.description) LIKE ?)');
      const term = `%${String(q).toLowerCase()}%`;
      params.push(term, term, term);
    }

    let sql = BASE_SELECT;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');

    const sortMap = {
      newest: 'products.created_at DESC',
      oldest: 'products.created_at ASC',
      price_low: 'products.price ASC',
      price_high: 'products.price DESC',
    };
    sql += ' ORDER BY ' + (sortMap[sort] || sortMap.newest);

    const lim = Math.min(parseInt(limit, 10) || 200, 200);
    sql += ' LIMIT ?';
    params.push(lim);

    const rows = db.prepare(sql).all(...params);
    const favoriteIds = favoriteIdSetForUser(req.auth && req.auth.uid);

    const products = rows.map((row) =>
      serializeProduct(row, {
        isFavorited: favoriteIds.has(row.id),
        viewerId: req.auth && req.auth.uid,
        stats: isMineQuery ? statsForProduct(row.id) : undefined,
      })
    );

    sendJson(res, 200, { products, count: products.length });
  });

  router.get('/api/products/:id', async (req, res) => {
    let row = db.prepare(`${BASE_SELECT} WHERE products.id = ?`).get(req.params.id);
    if (!row) throw new HttpError(404, 'That listing could not be found.');

    const viewerId = req.auth && req.auth.uid;
    const isOwner = viewerId != null && Number(viewerId) === Number(row.seller_id);
    if (!isOwner) {
      db.prepare('UPDATE products SET views_count = views_count + 1 WHERE id = ?').run(row.id);
      row = db.prepare(`${BASE_SELECT} WHERE products.id = ?`).get(req.params.id);
    }

    const favoriteIds = favoriteIdSetForUser(viewerId);
    sendJson(res, 200, {
      product: serializeProduct(row, {
        isFavorited: favoriteIds.has(row.id),
        viewerId,
        stats: isOwner ? statsForProduct(row.id) : undefined,
      }),
    });
  });

  router.post('/api/products', async (req, res) => {
    const auth = requireAuth(req);
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.uid);
    if (!userRow) throw new HttpError(401, 'Session is no longer valid.');
    if (userRow.role !== 'admin' && userRow.can_sell !== 1) {
      const message = userRow.account_status === 'rejected'
        ? 'Your account needs attention. Please contact the admin for help before listing items.'
        : 'Your account is awaiting admin approval before you can list items.';
      throw new HttpError(403, message);
    }

    const body = req.body || {};

    const title = (body.title || '').trim();
    const category = VALID_CATEGORIES.has(body.category) ? body.category : 'misc';
    const isFree = !!body.isFree;
    const price = isFree ? 0 : Math.max(0, Number(body.price) || 0);
    const description = (body.description || '').trim() || 'No description provided.';
    const sub = (body.condition || body.sub || '').trim();
    const location = (body.location || '').trim() || 'UENR Library';

    if (!title) throw new HttpError(400, 'Please give your item a title.');

    const originalPrice = isFree ? null : validateDiscount(price, body.originalPrice);

    const verification = body.verification || null;
    const verificationMethod = verification && (verification.method === 'Student ID' || verification.method === 'Ghana Card')
      ? verification.method
      : null;
    const verificationValue = verification && verification.value ? String(verification.value).trim() : null;

    const images = persistImages(body.images || []);
    const verificationPhotos = persistImages(body.verificationPhoto ? [body.verificationPhoto] : []);
    const verificationPhotoUrl = verificationPhotos[0] || null;
    const gallery = images.length ? images : [PLACEHOLDER_IMAGE];

    if (verificationPhotoUrl) {
      db.prepare('UPDATE users SET verification_photo = ? WHERE id = ?').run(verificationPhotoUrl, auth.uid);
    }

    const sellerContact = (body.sellerContact || '').trim() || null;
    const info = db
      .prepare(`
        INSERT INTO products
          (seller_id, title, sub, category, price, original_price, description, location, seller_contact, image, gallery_json, sizes_json, colors_json, default_size, default_color, status, verification_method, verification_value, verification_photo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `)
      .run(
        auth.uid,
        title,
        sub,
        category,
        price,
        originalPrice,
        description,
        location,
        sellerContact,
        gallery[0],
        JSON.stringify(gallery),
        body.sizes ? JSON.stringify(body.sizes) : null,
        body.colors ? JSON.stringify(body.colors) : null,
        body.defaultSize || null,
        body.defaultColor || null,
        verificationMethod,
        verificationValue,
        verificationPhotoUrl
      );

    const row = db.prepare(`${BASE_SELECT} WHERE products.id = ?`).get(info.lastInsertRowid);
    sendJson(res, 201, { product: serializeProduct(row, { viewerId: auth.uid }) });
  });

  router.put('/api/products/:id', async (req, res) => {
    const auth = requireAuth(req);
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) throw new HttpError(404, 'That listing could not be found.');
    if (existing.seller_id !== auth.uid) throw new HttpError(403, "You can only edit your own listings.");

    const body = req.body || {};
    const nextPrice = body.price !== undefined ? Math.max(0, Number(body.price) || 0) : existing.price;
    const nextOriginalPrice = body.originalPrice !== undefined
      ? validateDiscount(nextPrice, body.originalPrice)
      : existing.original_price;

    const fields = {
      title: body.title !== undefined ? String(body.title).trim() : existing.title,
      sub: body.sub !== undefined ? String(body.sub).trim() : existing.sub,
      category: VALID_CATEGORIES.has(body.category) ? body.category : existing.category,
      price: nextPrice,
      original_price: nextPrice > 0 ? nextOriginalPrice : null,
      description: body.description !== undefined ? String(body.description).trim() : existing.description,
      location: body.location !== undefined ? String(body.location).trim() : existing.location,
      seller_contact: body.sellerContact !== undefined ? String(body.sellerContact).trim() : existing.seller_contact,
      status: body.status !== undefined ? String(body.status) : existing.status,
    };

    db.prepare(`
      UPDATE products SET title=?, sub=?, category=?, price=?, original_price=?, description=?, location=?, seller_contact=?, status=? WHERE id=?
    `).run(fields.title, fields.sub, fields.category, fields.price, fields.original_price, fields.description, fields.location, fields.seller_contact, fields.status, existing.id);

    const row = db.prepare(`${BASE_SELECT} WHERE products.id = ?`).get(existing.id);
    sendJson(res, 200, { product: serializeProduct(row, { viewerId: auth.uid, stats: statsForProduct(row.id) }) });
  });

  router.delete('/api/products/:id', async (req, res) => {
    const auth = requireAuth(req);
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) throw new HttpError(404, 'That listing could not be found.');
    if (existing.seller_id !== auth.uid) throw new HttpError(403, 'You can only delete your own listings.');

    db.prepare('DELETE FROM products WHERE id = ?').run(existing.id);
    sendJson(res, 200, { ok: true });
  });

  const VALID_REPORT_REASONS = new Set([
    'scam', 'fake', 'wrong-category', 'offensive', 'duplicate', 'suspicious-seller', 'prohibited', 'other',
  ]);

  router.post('/api/products/:id/report', async (req, res) => {
    const auth = requireAuth(req);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) throw new HttpError(404, 'That listing could not be found.');
    if (product.seller_id === auth.uid) throw new HttpError(400, 'You cannot report your own listing.');

    const body = req.body || {};
    const reason = VALID_REPORT_REASONS.has(body.reason) ? body.reason : 'other';
    const details = (body.details || '').trim().slice(0, 500) || null;

    const existingOpen = db
      .prepare("SELECT id FROM reports WHERE product_id = ? AND reporter_id = ? AND status = 'open'")
      .get(product.id, auth.uid);
    if (existingOpen) throw new HttpError(409, "You've already reported this listing — our team is reviewing it.");

    db.prepare(`
      INSERT INTO reports (product_id, reporter_id, reason, details)
      VALUES (?, ?, ?, ?)
    `).run(product.id, auth.uid, reason, details);

    sendJson(res, 201, { ok: true });
  });
}

module.exports = { register };
