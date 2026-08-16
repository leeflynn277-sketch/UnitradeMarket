/* ============================================================
   Campus Market — tiny HTTP toolkit
   A minimal but complete router + static file server built only
   on Node's built-in `http` module. No Express, no dependencies.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { verifyToken } = require('./auth');
const db = require('./db');

const MAX_BODY_BYTES = 30 * 1024 * 1024; // 30MB (generous, to allow base64 image uploads)

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------- Router ---------- */
class Router {
  constructor() {
    this.routes = []; // { method, segments, handler }
  }

  add(method, routePath, handler) {
    const segments = routePath.split('/').filter(Boolean);
    this.routes.push({ method, segments, handler });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    const segments = pathname.split('/').filter(Boolean);
    let pathMatch = null;

    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i];
        const actualSeg = decodeURIComponent(segments[i]);
        if (routeSeg.startsWith(':')) {
          params[routeSeg.slice(1)] = actualSeg;
        } else if (routeSeg !== actualSeg) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (route.method === method) {
        return { handler: route.handler, params, methodMismatch: false };
      }
      if (!pathMatch) pathMatch = { params, methodMismatch: true };
    }

    return pathMatch || null;
  }

  async handle(req, res) {
    const baseUrl = req.headers.host ? `http://${req.headers.host}` : 'http://localhost';
    const url = new URL(req.url, baseUrl);
    const match = this.match(req.method, url.pathname);
    if (!match) return null;
    if (match.methodMismatch) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    req.params = match.params;
    req.query = Object.fromEntries(url.searchParams.entries());

    // attach authenticated user (if a valid bearer token is present)
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    req.auth = token ? verifyToken(token) : null;

    try {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        req.body = await readBody(req);
      } else {
        req.body = null;
      }
      await match.handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error('Unhandled route error:', err);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
    return true;
  }
}

function requireAuth(req) {
  if (!req.auth || !req.auth.uid) {
    throw new HttpError(401, 'You must be signed in to do that.');
  }
  // Special-purpose tokens (e.g. the short-lived password-reset token) must
  // never double as a general session token, even within their short
  // lifetime — reject anything that isn't a plain login session here.
  if (req.auth.purpose) {
    throw new HttpError(401, 'You must be signed in to do that.');
  }
  // Re-check the account on every authenticated request (not just at login),
  // so a suspension takes effect immediately even for someone who is
  // already holding a valid session token.
  const userRow = db.prepare('SELECT account_status FROM users WHERE id = ?').get(req.auth.uid);
  if (!userRow) {
    throw new HttpError(401, 'Session is no longer valid.');
  }
  if (userRow.account_status === 'suspended') {
    throw new HttpError(403, 'This account has been suspended. Contact an administrator for help.');
  }
  return req.auth;
}

/* ---------- Static file serving ---------- */
function safeJoin(root, requestPath) {
  const target = path.normalize(path.join(root, requestPath));
  if (!target.startsWith(path.normalize(root))) return null; // path traversal guard
  return target;
}

function serveStatic(root) {
  return async function (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const baseUrl = req.headers.host ? `http://${req.headers.host}` : 'http://localhost';
    const url = new URL(req.url, baseUrl);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    const filePath = safeJoin(root, pathname);
    if (!filePath) return false;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return false;
    }
    if (stat.isDirectory()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  };
}

module.exports = { Router, HttpError, sendJson, requireAuth, serveStatic, MIME_TYPES };
