/* ============================================================
   Campus Market — reusable app factory
   Exports a createServer() function so the app can be started
   directly by the entrypoint and smoke-tested in-process.
   ============================================================ */
'use strict';

const http = require('http');
const path = require('path');

const db = require('./lib/db');
const { seedIfEmpty } = require('./lib/seed');
const { Router, sendJson, serveStatic } = require('./lib/http-helpers');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const messageRoutes = require('./routes/messages');
const notificationRoutes = require('./routes/notifications');
const favoriteRoutes = require('./routes/favorites');

function createServer() {
  seedIfEmpty(db);

  const router = new Router();
  router.get('/api/health', (req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      service: 'campus-market',
      database: 'sqlite',
      timestamp: new Date().toISOString(),
    });
  });

  authRoutes.register(router);
  adminRoutes.register(router);
  productRoutes.register(router);
  cartRoutes.register(router);
  orderRoutes.register(router);
  messageRoutes.register(router);
  notificationRoutes.register(router);
  favoriteRoutes.register(router);

  const PROJECT_ROOT = path.join(__dirname, '..');
  const UPLOADS_DIR = path.join(__dirname, 'uploads');
  const serveFrontend = serveStatic(PROJECT_ROOT);
  const serveUploads = serveStatic(UPLOADS_DIR);

  return http.createServer(async (req, res) => {
    try {
      const url = req.url || '/';

      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      if (url.startsWith('/api/')) {
        const handled = await router.handle(req, res);
        if (!handled) sendJson(res, 404, { error: 'Not found' });
        return;
      }

      if (url.startsWith('/uploads/')) {
        const rel = url.slice('/uploads'.length);
        const fakeReq = Object.assign(Object.create(Object.getPrototypeOf(req)), req, { url: rel });
        const handled = await serveUploads(fakeReq, res);
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
        return;
      }

      const handled = await serveFrontend(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch (err) {
      console.error('Server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
      }
    }
  });
}

module.exports = { createServer };
