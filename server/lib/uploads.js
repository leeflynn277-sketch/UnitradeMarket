/* ============================================================
   Campus Market — image upload helper
   The "Sell an item" form already reads chosen photos into
   base64 data URLs in the browser (for instant previews). Rather
   than adding a multipart parser, we accept those same data URLs
   and write them to disk here — so listings get real, persisted
   image files on the server instead of localStorage blobs.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function toPublicUrl(relativePath) {
  if (!relativePath) return relativePath;
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  return relativePath.startsWith('/uploads/') ? relativePath : `/uploads/${relativePath}`;
}

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const DATA_URL_RE = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/;

/**
 * Accepts an array of strings that are either:
 *  - data URLs ("data:image/png;base64,...") which get written to disk, or
 *  - plain URLs (e.g. an existing /uploads/... path, or an external https:// image)
 *    which are passed through unchanged.
 * Returns an array of URL strings suitable for storing in the DB.
 */
function persistImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const item of images) {
    if (typeof item !== 'string' || !item) continue;
    const match = item.match(DATA_URL_RE);
    if (!match) {
      // Already a URL (http(s):// or an existing /uploads/ path) — keep as is.
      out.push(item);
      continue;
    }
    const [, mime, base64] = match;
    const ext = EXT_BY_MIME[mime] || '.jpg';
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    out.push(toPublicUrl(`/uploads/${filename}`));
  }
  return out;
}

module.exports = { persistImages, UPLOAD_DIR };
