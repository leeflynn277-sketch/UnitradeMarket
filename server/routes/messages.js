/* ============================================================
   Campus Market — messaging routes
   GET  /api/conversations                 my conversation list
   POST /api/conversations                 start/find a conversation { otherUserId, productId? }
   GET  /api/conversations/:id             thread + messages (marks incoming as read)
   POST /api/conversations/:id/messages    send a message { body }
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');
const { timeAgo } = require('../lib/format');

function otherUserId(conv, myId) {
  return conv.user_a === myId ? conv.user_b : conv.user_a;
}

function productSummary(productId) {
  if (!productId) return null;
  const row = db.prepare('SELECT id, title, image, price, status FROM products WHERE id = ?').get(productId);
  if (!row) return null;
  return { id: row.id, title: row.title, image: row.image, price: row.price, status: row.status };
}

function findOrCreateConversation(myId, otherId, productId) {
  const a = Math.min(myId, otherId);
  const b = Math.max(myId, otherId);
  let conv = db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b);
  if (!conv) {
    const info = db
      .prepare('INSERT INTO conversations (user_a, user_b, product_id) VALUES (?, ?, ?)')
      .run(a, b, productId || null);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  } else if (productId && !conv.product_id) {
    db.prepare('UPDATE conversations SET product_id = ? WHERE id = ?').run(productId, conv.id);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
  }
  return conv;
}

function register(router) {
  router.get('/api/conversations', async (req, res) => {
    const auth = requireAuth(req);
    const convs = db
      .prepare('SELECT * FROM conversations WHERE user_a = ? OR user_b = ? ORDER BY id DESC')
      .all(auth.uid, auth.uid);

    const result = convs.map((conv) => {
      const otherId = otherUserId(conv, auth.uid);
      const other = db.prepare('SELECT id, name FROM users WHERE id = ?').get(otherId);
      const lastMsg = db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
        .get(conv.id);
      const unreadCount = db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL')
        .get(conv.id, auth.uid).n;

      return {
        id: conv.id,
        productId: conv.product_id,
        product: productSummary(conv.product_id),
        otherUser: other || { id: otherId, name: 'Deleted user' },
        lastMessage: lastMsg ? lastMsg.body : 'Say hello',
        lastMessageAt: lastMsg ? timeAgo(lastMsg.created_at) : timeAgo(conv.created_at),
        lastMessageAtRaw: lastMsg ? lastMsg.created_at : conv.created_at,
        unreadCount,
      };
    });

    sendJson(res, 200, { conversations: result });
  });

  router.post('/api/conversations', async (req, res) => {
    const auth = requireAuth(req);
    const body = req.body || {};
    const otherUserId_ = Number(body.otherUserId);
    if (!otherUserId_ || otherUserId_ === auth.uid) {
      throw new HttpError(400, 'A valid otherUserId is required.');
    }
    const other = db.prepare('SELECT id, name FROM users WHERE id = ?').get(otherUserId_);
    if (!other) throw new HttpError(404, 'That user could not be found.');

    const conv = findOrCreateConversation(auth.uid, otherUserId_, body.productId ? Number(body.productId) : null);
    sendJson(res, 201, { conversationId: conv.id, otherUser: other });
  });

  router.get('/api/conversations/:id', async (req, res) => {
    const auth = requireAuth(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv || (conv.user_a !== auth.uid && conv.user_b !== auth.uid)) {
      throw new HttpError(404, 'Conversation not found.');
    }

    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL")
      .run(conv.id, auth.uid);

    const otherId = otherUserId(conv, auth.uid);
    const other = db.prepare('SELECT id, name FROM users WHERE id = ?').get(otherId);
    const messages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC')
      .all(conv.id)
      .map((m) => ({
        id: m.id,
        body: m.body,
        mine: m.sender_id === auth.uid,
        createdAt: m.created_at,
        postedAt: timeAgo(m.created_at),
      }));

    sendJson(res, 200, {
      conversation: {
        id: conv.id,
        productId: conv.product_id,
        product: productSummary(conv.product_id),
        otherUser: other || { id: otherId, name: 'Deleted user' },
      },
      messages,
    });
  });

  router.post('/api/conversations/:id/messages', async (req, res) => {
    const auth = requireAuth(req);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv || (conv.user_a !== auth.uid && conv.user_b !== auth.uid)) {
      throw new HttpError(404, 'Conversation not found.');
    }

    const text = ((req.body || {}).body || '').trim();
    if (!text) throw new HttpError(400, 'Message cannot be empty.');

    const info = db
      .prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
      .run(conv.id, auth.uid, text);

    const otherId = otherUserId(conv, auth.uid);
    const sender = db.prepare('SELECT name FROM users WHERE id = ?').get(auth.uid);
    db.prepare(
      `INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, 'message', '', ?, ?, ?)`
    ).run(otherId, `New message from ${sender.name}`, text.slice(0, 120), `messages.html?id=${conv.id}`);

    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
    sendJson(res, 201, {
      message: { id: m.id, body: m.body, mine: true, createdAt: m.created_at, postedAt: timeAgo(m.created_at) },
    });
  });
}

module.exports = { register };
