/* ============================================================
   Campus Market — admin-configurable settings
   Backed by the app_settings key/value table. Currently just the
   discount cap, but kept generic for future settings.
   ============================================================ */
'use strict';

const db = require('./db');

const DEFAULTS = {
  min_sale_percent: '70',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function getNumberSetting(key) {
  const value = Number(getSetting(key));
  return Number.isFinite(value) ? value : Number(DEFAULTS[key]);
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

module.exports = { getSetting, getNumberSetting, setSetting };
