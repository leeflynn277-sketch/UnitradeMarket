#!/usr/bin/env node
/**
 * Create or update an admin account
 * Usage: node server/setup-admin.js <email> <password> [name]
 * Example: node server/setup-admin.js admin@campus.com SecurePass123 "Campus Admin"
 */

'use strict';

const { hashPassword } = require('./lib/auth');
// Reuse the app's own database connection/schema instead of opening a second,
// hardcoded path — this is what makes the script respect CAMPUS_MARKET_DATA_DIR
// / CAMPUS_MARKET_DB_PATH (e.g. a persistent disk on Render/Railway/Fly) and
// guarantees the users table already exists, no matter when this is run.
const db = require('./lib/db');

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node server/setup-admin.js <email> <password> [name]');
  console.error('');
  console.error('Examples:');
  console.error('  node server/setup-admin.js admin@campus.com SecurePass123');
  console.error('  node server/setup-admin.js admin@campus.com SecurePass123 "Campus Administrator"');
  process.exit(1);
}

const email = args[0];
const password = args[1];
const name = args[2] || 'Campus Market Admin';

// Validate inputs
if (!email.includes('@')) {
  console.error('Error: Invalid email address');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Error: Password must be at least 8 characters');
  process.exit(1);
}

try {
  // Check if user exists
  const existing = db.prepare('SELECT id, role FROM users WHERE lower(email) = ?').get(email.toLowerCase());

  if (existing && existing.role === 'admin') {
    console.log(`✓ Updating admin account: ${email}`);
    const passwordHash = hashPassword(password);
    db.prepare(
      'UPDATE users SET name = ?, password_hash = ?, account_status = ?, can_sell = ? WHERE lower(email) = ?'
    ).run(name, passwordHash, 'approved', 1, email.toLowerCase());
    console.log(`✓ Admin account updated successfully`);
  } else if (existing) {
    console.log(`✓ Promoting existing account to admin: ${email}`);
    const passwordHash = hashPassword(password);
    db.prepare(
      'UPDATE users SET name = ?, password_hash = ?, role = ?, account_status = ?, can_sell = ? WHERE lower(email) = ?'
    ).run(name, passwordHash, 'admin', 'approved', 1, email.toLowerCase());
    console.log(`✓ Account promoted to admin successfully`);
  } else {
    console.log(`✓ Creating new admin account: ${email}`);
    const passwordHash = hashPassword(password);
    db.prepare(
      'INSERT INTO users (name, email, student_id, password_hash, role, account_status, can_sell) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(name, email, `ADMIN-${Date.now()}`, passwordHash, 'admin', 'approved', 1);
    console.log(`✓ Admin account created successfully`);
  }

  console.log('');
  console.log('Login credentials:');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log('');
  console.log('Sign in at /admin-login.html to access the admin panel.');

  process.exit(0);
} catch (err) {
  console.error('Error creating admin account:', err.message);
  process.exit(1);
}
