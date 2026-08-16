/* ============================================================
   Campus Market — email delivery
   Zero-dependency: calls Resend's REST API (https://resend.com)
   directly over Node's built-in `https` module — no SDK, no
   npm package, matching the rest of this codebase's "only
   Node's built-in modules" approach.

   Configure with two environment variables:
     RESEND_API_KEY  — from https://resend.com/api-keys
     MAIL_FROM       — e.g. "Campus Market <noreply@yourdomain.com>"
                        (defaults to Resend's shared test sender,
                        which only delivers to the email address you
                        signed up to Resend with — fine for testing,
                        but you'll want a verified sending domain
                        before relying on this for real users)

   If RESEND_API_KEY is not set, sendEmail() resolves to
   { sent: false } instead of throwing, so the app keeps working
   exactly as before (the reset code just gets handed back in the
   API response / shown on screen) until email is configured.
   ============================================================ */
'use strict';

const https = require('https');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Campus Market <onboarding@resend.dev>';

function isConfigured() {
  return Boolean(RESEND_API_KEY);
}

function sendEmail({ to, subject, html, text }) {
  if (!isConfigured()) {
    return Promise.resolve({ sent: false, reason: 'not_configured' });
  }

  const payload = JSON.stringify({
    from: MAIL_FROM,
    to: [to],
    subject,
    html,
    text,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ sent: true });
          } else {
            console.error('[mailer] Resend API error', res.statusCode, body);
            resolve({ sent: false, reason: 'api_error', status: res.statusCode });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ sent: false, reason: 'timeout' });
    });

    req.on('error', (err) => {
      console.error('[mailer] Resend request failed', err.message);
      resolve({ sent: false, reason: 'network_error' });
    });

    req.write(payload);
    req.end();
  });
}

function passwordResetEmail({ name, code }) {
  return {
    subject: `Your Campus Market password reset code: ${code}`,
    text: `Hi ${name},\n\nYour password reset code is ${code}. It expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.\n\n— Campus Market`,
    html: `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px; color: #16A34A;">Campus Market</h2>
        <p style="margin: 0 0 16px; color: #111827;">Hi ${name},</p>
        <p style="margin: 0 0 16px; color: #111827;">Use this code to reset your password. It expires in 15 minutes.</p>
        <div style="font-size: 32px; font-weight: 800; letter-spacing: 6px; text-align: center; background: #f0fdf4; color: #15803D; padding: 16px; border-radius: 12px; margin: 0 0 16px;">${code}</div>
        <p style="margin: 0; color: #6b7280; font-size: 13px;">If you didn't request this, you can safely ignore this email — your password won't change unless this code is used.</p>
      </div>
    `,
  };
}

module.exports = { isConfigured, sendEmail, passwordResetEmail };
