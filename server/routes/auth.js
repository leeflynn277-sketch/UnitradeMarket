/* ============================================================
   Campus Market — auth routes
   POST /api/auth/signup
   POST /api/auth/login
   GET  /api/auth/me
   ============================================================ */
'use strict';

const crypto = require('crypto');
const db = require('../lib/db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('../lib/auth');
const { HttpError, sendJson, requireAuth } = require('../lib/http-helpers');
const { publicUser } = require('../lib/format');
const { persistImages } = require('../lib/uploads');
const mailer = require('../lib/mailer');

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// UENR student/staff IDs: UEB + 7 digits, where the last 2 digits are the
// 2-digit year of admission (e.g. UEB3516722 -> admitted 2022). The
// university was established in 2011, so no valid ID can predate that, and
// an admission year can never be in the future.
const MIN_ADMISSION_YEAR = 11;

function isValidStudentId(studentId) {
  if (typeof studentId !== 'string') return false;
  const trimmed = studentId.trim();
  if (!/^UEB\d{7}$/i.test(trimmed)) return false;
  const admissionYear = parseInt(trimmed.slice(-2), 10);
  const currentYear = new Date().getFullYear() % 100;
  return admissionYear >= MIN_ADMISSION_YEAR && admissionYear <= currentYear;
}

function register(router) {
  router.post('/api/auth/signup', async (req, res) => {
    const body = req.body || {};
    const name = (body.name || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const studentId = (body.studentId || '').trim().toUpperCase();
    const password = body.password || '';

    if (!name) throw new HttpError(400, 'Please enter your full name.');
    if (!studentId) throw new HttpError(400, 'Please enter your student ID.');
    if (!isValidStudentId(studentId)) throw new HttpError(400, 'Student ID must be UEB followed by 7 digits, ending in your 2-digit admission year (e.g. UEB3516722 for a student admitted in 2022).');
    if (!isValidEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (!password || password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');

    const existing = db
      .prepare('SELECT id FROM users WHERE email = ? OR student_id = ?')
      .get(email, studentId);
    if (existing) throw new HttpError(409, 'An account with that email or student ID already exists.');

    const passwordHash = hashPassword(password);
    const info = db
      .prepare('INSERT INTO users (name, email, student_id, password_hash, role, account_status, can_sell) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, email, studentId, passwordHash, 'user', 'pending', 0);

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, 'welcome', '', 'Welcome to Campus Market!', 'Your account is waiting for admin approval before you can list items.', 'sell.html')`
    ).run(info.lastInsertRowid);

    const token = signToken({ uid: userRow.id });
    sendJson(res, 201, { token, user: publicUser(userRow) });
  });

  router.post('/api/auth/login', async (req, res) => {
    const body = req.body || {};
    const identifier = (body.identifier || '').trim();
    const password = body.password || '';
    const normalizedIdentifier = identifier.toLowerCase();

    if (!identifier) throw new HttpError(400, 'Please enter your email or student ID.');
    if (!isValidEmail(identifier) && !isValidStudentId(identifier)) {
      throw new HttpError(400, 'Please enter a valid email address or student ID (UEB followed by 7 digits).');
    }

    const userRow = db
      .prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(student_id) = ?')
      .get(normalizedIdentifier, normalizedIdentifier);

    if (!userRow || !verifyPassword(password, userRow.password_hash)) {
      throw new HttpError(401, 'No account matches that email/student ID and password.');
    }

    if (userRow.account_status === 'suspended') {
      throw new HttpError(403, 'This account has been suspended. Contact an administrator for help.');
    }

    const token = signToken({ uid: userRow.id });
    sendJson(res, 200, { token, user: publicUser(userRow) });
  });

  router.get('/api/auth/me', async (req, res) => {
    const auth = requireAuth(req);
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.uid);
    if (!userRow) throw new HttpError(401, 'Session is no longer valid.');
    sendJson(res, 200, { user: publicUser(userRow) });
  });

  router.post('/api/auth/profile-picture', async (req, res) => {
    const auth = requireAuth(req);
    const body = req.body || {};
    const image = body.image;

    if (typeof image !== 'string' || !image.trim()) {
      throw new HttpError(400, 'Please choose an image to upload.');
    }

    const [savedImage] = persistImages([image]);
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(savedImage || image, auth.uid);
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.uid);
    sendJson(res, 200, { user: publicUser(userRow) });
  });

  /* ---------- Forgot password ----------
     Three-step flow: request a 6-digit code -> verify the code (issues a
     short-lived reset token) -> set a new password with that token.

     NOTE: this project has zero external dependencies and no email/SMS
     service configured, so there is nowhere to actually deliver the code.
     Rather than fake it, the code is returned directly in the API response
     so the flow is genuinely usable end-to-end today. If this app is
     deployed somewhere real, swap the `devCode` field below for an actual
     email/SMS send (e.g. via an email API) and stop returning the code. */
  const RESET_CODE_TTL_SECONDS = 15 * 60; // 15 minutes
  const RESET_TOKEN_TTL_SECONDS = 15 * 60;

  router.post('/api/auth/forgot-password', async (req, res) => {
    const identifier = ((req.body && req.body.identifier) || '').trim().toLowerCase();
    if (!identifier) throw new HttpError(400, 'Please enter your email or student ID.');

    const userRow = db
      .prepare('SELECT id, name, email FROM users WHERE lower(email) = ? OR lower(student_id) = ?')
      .get(identifier, identifier);

    if (!userRow) {
      throw new HttpError(404, 'No account matches that email or student ID.');
    }

    // Only one live code per account at a time.
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userRow.id);

    const code = String(crypto.randomInt(100000, 1000000)); // 6 digits, zero-padded by range
    const codeHash = hashPassword(code);
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_SECONDS * 1000).toISOString();

    db.prepare('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)')
      .run(userRow.id, codeHash, expiresAt);

    db.prepare(
      `INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, 'admin', '', 'Password reset requested', 'A 6-digit reset code was generated for your account. If this wasn''t you, you can ignore it — it expires in 15 minutes.', 'login.html')`
    ).run(userRow.id);

    // Try to actually email the code. If email isn't configured (no
    // RESEND_API_KEY) or the send fails for any reason, fall back to
    // returning the code directly in the response so local dev/testing
    // and ungraded demos keep working without any setup. Once email is
    // configured and a send succeeds, the code is withheld from the
    // response — it only goes to the inbox, which is the whole point.
    let emailSent = false;
    if (mailer.isConfigured() && userRow.email) {
      const { subject, html, text } = mailer.passwordResetEmail({ name: userRow.name, code });
      const result = await mailer.sendEmail({ to: userRow.email, subject, html, text });
      emailSent = result.sent;
    }

    sendJson(res, 200, {
      message: emailSent
        ? `We've emailed a reset code to ${userRow.email}. It expires in 15 minutes.`
        : `A reset code was generated for ${userRow.name}. It expires in 15 minutes.`,
      emailSent,
      // Only present when we couldn't actually email it (e.g. no mail
      // provider configured yet) — stands in for the code so the flow
      // still works end to end without email set up.
      devCode: emailSent ? undefined : code,
    });
  });

  router.post('/api/auth/verify-reset-code', async (req, res) => {
    const body = req.body || {};
    const identifier = (body.identifier || '').trim().toLowerCase();
    const code = (body.code || '').trim();

    if (!identifier || !code) throw new HttpError(400, 'Please enter the code sent for your account.');

    const userRow = db
      .prepare('SELECT id FROM users WHERE lower(email) = ? OR lower(student_id) = ?')
      .get(identifier, identifier);
    if (!userRow) throw new HttpError(404, 'No account matches that email or student ID.');

    const resetRow = db
      .prepare(`
        SELECT * FROM password_resets
        WHERE user_id = ? AND used_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(userRow.id);

    if (!resetRow || !verifyPassword(code, resetRow.code_hash)) {
      throw new HttpError(400, 'That code is incorrect or has expired. Request a new one.');
    }

    const resetToken = signToken({ uid: userRow.id, resetId: resetRow.id, purpose: 'password-reset' }, RESET_TOKEN_TTL_SECONDS);
    sendJson(res, 200, { resetToken });
  });

  router.post('/api/auth/reset-password', async (req, res) => {
    const body = req.body || {};
    const resetToken = body.resetToken || '';
    const newPassword = body.newPassword || '';

    if (!newPassword || newPassword.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');

    const payload = verifyToken(resetToken);
    if (!payload || payload.purpose !== 'password-reset' || !payload.uid || !payload.resetId) {
      throw new HttpError(401, 'This reset link has expired. Please request a new code.');
    }

    const resetRow = db.prepare('SELECT * FROM password_resets WHERE id = ? AND user_id = ?').get(payload.resetId, payload.uid);
    if (!resetRow || resetRow.used_at) {
      throw new HttpError(401, 'This reset code has already been used. Please request a new one.');
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), payload.uid);
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(resetRow.id);

    db.prepare(
      `INSERT INTO notifications (user_id, type, icon, title, body, link) VALUES (?, 'admin', '', 'Password changed', 'Your password was just reset. If this wasn''t you, contact an administrator immediately.', 'profile.html')`
    ).run(payload.uid);

    sendJson(res, 200, { ok: true });
  });
}

module.exports = { register };
