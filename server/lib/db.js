/* ============================================================
   Campus Market — database layer
   Uses Node's built-in node:sqlite module, so there is nothing
   to `npm install`. The database file lives at server/data/campus-market.db
   and is created automatically on first run.
   ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.CAMPUS_MARKET_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.CAMPUS_MARKET_DB_PATH || path.join(DATA_DIR, 'campus-market.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function ensureColumn(tableName, columnName, definition) {
  const existing = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (existing.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function ensureUserColumns() {
  ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
  ensureColumn('users', 'account_status', "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn('users', 'can_sell', "INTEGER NOT NULL DEFAULT 0");
  ensureColumn('users', 'verified_at', 'TEXT');
  ensureColumn('users', 'admin_note', 'TEXT');
  ensureColumn('users', 'verification_photo', 'TEXT');
  ensureColumn('users', 'avatar_url', 'TEXT');

  db.prepare("UPDATE users SET role = COALESCE(role, 'user') WHERE role IS NULL OR role = ''").run();
  db.prepare("UPDATE users SET account_status = COALESCE(account_status, 'approved') WHERE account_status IS NULL OR account_status = ''").run();
  db.prepare("UPDATE users SET can_sell = CASE WHEN account_status = 'approved' THEN 1 ELSE 0 END WHERE can_sell IS NULL").run();
}

function ensureProductColumns() {
  // Pre-existing databases created before verification photos were added were
  // missing this column entirely (CREATE TABLE IF NOT EXISTS does not retrofit
  // existing tables), which crashed listing creation with a 500 whenever a
  // seller attached a verification photo. Patch it in for any older database.
  ensureColumn('products', 'verification_method', 'TEXT');
  ensureColumn('products', 'verification_value', 'TEXT');
  ensureColumn('products', 'verification_photo', 'TEXT');
  ensureColumn('products', 'seller_contact', 'TEXT');
  // View-count tracking for the seller dashboard ("My adverts" style stats).
  ensureColumn('products', 'views_count', 'INTEGER NOT NULL DEFAULT 0');
  // Optional "was" price for discounted/sale listings — paired with the
  // admin-configurable minimum-sale-percent setting (see settings.js).
  ensureColumn('products', 'original_price', 'REAL');
}

function ensureSettingsSeed() {
  const existing = db.prepare("SELECT value FROM app_settings WHERE key = 'min_sale_percent'").get();
  if (!existing) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('min_sale_percent', '70')").run();
  }
}

function ensureDefaultAdmin() {
  // Guarantees a working admin login always exists in the database, no
  // matter where this is hosted or how many times it's redeployed/restarted.
  // Without this, a fresh disk (or a disk that was never seeded via
  // setup-admin.js) would have zero admin accounts and nobody could reach
  // /admin.html. This runs on every boot and is idempotent:
  //  - No matching account yet -> creates it as an approved admin.
  //  - Account already exists  -> re-locks its role/status/password to the
  //    known values, so admin access can never silently break (e.g. if the
  //    row were ever edited to a non-admin role, or the password changed
  //    and forgotten).
  // Override the credentials for a real deployment by setting
  // ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME as environment variables.
  const email = process.env.ADMIN_EMAIL || 'admin@campus.com';
  const password = process.env.ADMIN_PASSWORD || 'SecurePass123';
  const name = process.env.ADMIN_NAME || 'Campus Market Admin';

  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email.toLowerCase());
  const passwordHash = hashPassword(password);

  if (!existing) {
    db.prepare(
      `INSERT INTO users (name, email, student_id, password_hash, role, account_status, can_sell)
       VALUES (?, ?, ?, ?, 'admin', 'approved', 1)`
    ).run(name, email, `ADMIN-${Date.now()}`, passwordHash);
    console.log(`[campus-market] Created default admin account: ${email}`);
  } else {
    db.prepare(
      `UPDATE users
       SET name = ?, password_hash = ?, role = 'admin', account_status = 'approved', can_sell = 1
       WHERE id = ?`
    ).run(name, passwordHash, existing.id);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,
  student_id    TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT DEFAULT '#4F46E5',
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  account_status TEXT NOT NULL DEFAULT 'pending',
  can_sell      INTEGER NOT NULL DEFAULT 0,
  verified_at   TEXT,
  admin_note    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  sub                 TEXT,
  category            TEXT NOT NULL DEFAULT 'misc',
  price               REAL NOT NULL DEFAULT 0,
  description         TEXT,
  location            TEXT,
  seller_contact      TEXT,
  image               TEXT,
  gallery_json        TEXT NOT NULL DEFAULT '[]',
  sizes_json          TEXT,
  colors_json         TEXT,
  default_size        TEXT,
  default_color       TEXT,
  status              TEXT NOT NULL DEFAULT 'active', -- active | sold | claimed | removed | closed
  verification_method TEXT,
  verification_value  TEXT,
  verification_photo  TEXT,
  views_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 1,
  size        TEXT,
  color       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone_name          TEXT,
  zone_sub           TEXT,
  zone_icon          TEXT,
  meetup_time        TEXT,
  subtotal           REAL NOT NULL DEFAULT 0,
  payment_method     TEXT,
  status             TEXT NOT NULL DEFAULT 'confirmed',
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  seller_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title_snapshot  TEXT,
  image_snapshot  TEXT,
  qty             INTEGER NOT NULL DEFAULT 1,
  size            TEXT,
  color           TEXT,
  unit_price      REAL NOT NULL DEFAULT 0,
  line_total      REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  read_at          TEXT
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reporter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  details       TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  admin_note    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

-- Small key/value store for admin-configurable settings (e.g. the maximum
-- allowed discount depth on listings). Kept generic so future settings can
-- reuse it without another migration.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Forgot password" flow: a short-lived 6-digit code, hashed at rest just
-- like a password. A new request invalidates any previous outstanding code
-- for that user, and a code is deleted the moment it's successfully used.
CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_cart_user ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_product ON reports(product_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
`;

db.exec(SCHEMA);
ensureUserColumns();
ensureProductColumns();
ensureSettingsSeed();
ensureDefaultAdmin();

module.exports = db;
