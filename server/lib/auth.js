/* ============================================================
   Campus Market — auth helpers
   Password hashing: scrypt (built into node:crypto), random salt per user.
   Sessions: hand-rolled signed tokens (header.payload.signature, base64url),
   conceptually identical to a JWT but with zero dependencies.
   ============================================================ */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_PATH = process.env.CAMPUS_MARKET_SECRET_PATH || path.join(process.env.CAMPUS_MARKET_DATA_DIR || path.join(__dirname, '..', 'data'), 'secret.key');

function getSecret() {
  try {
    return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  } catch (e) {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
    return secret;
  }
}

const SECRET = getSecret();
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/* ---------- Password hashing (scrypt) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------- Base64url helpers ---------- */
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/* ---------- Signed session tokens ---------- */
function signToken(payload, ttlSeconds = TOKEN_TTL_SECONDS) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'CMT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('hex');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(body));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
