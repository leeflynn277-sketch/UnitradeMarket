/* ============================================================
   Campus Market — notification routes
   GET  /api/notifications              my notifications, newest first
   POST /api/notifications/read-all     mark everything as read
   ============================================================ */
'use strict';

const db = require('../lib/db');
const { sendJson, requireAuth } = require('../lib/http-helpers');
const { timeAgo } = require('../lib/format');

function register(router) {
  router.get('/api/notifications', async (req, res) => {
    const auth = requireAuth(req);
    const rows = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .all(auth.uid);

    const notifications = rows.map((n) => ({
      id: n.id,
      type: n.type,
      icon: n.icon,
      title: n.title,
      body: n.body,
      link: n.link,
      read: !!n.read_at,
      postedAt: timeAgo(n.created_at),
    }));

    sendJson(res, 200, { notifications });
  });

  router.post('/api/notifications/read-all', async (req, res) => {
    const auth = requireAuth(req);
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(auth.uid);
    sendJson(res, 200, { ok: true });
  });
}

module.exports = { register };
