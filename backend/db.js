const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
}) : null;

function isDatabaseEnabled() {
  return Boolean(pool);
}

async function withDatabase(fn, fallbackValue) {
  if (!pool) return fallbackValue;
  try {
    return await fn(pool);
  } catch (err) {
    console.warn('Database operation failed, falling back to legacy file storage:', err.message || err);
    return fallbackValue;
  }
}

async function ensureSchema() {
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  return true;
}

async function readJsonCollection(key, fallbackValue) {
  if (!pool) return fallbackValue;
  const { rows } = await pool.query('SELECT value FROM app_data WHERE key = $1', [key]);
  if (!rows.length) return fallbackValue;
  return rows[0].value;
}

async function writeJsonCollection(key, value) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO app_data (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

async function readConfigFromDb(fallbackValue = {}) {
  const data = await readJsonCollection('config', fallbackValue);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fallbackValue;
  return data;
}

async function writeConfigToDb(config) {
  await writeJsonCollection('config', config || {});
}

async function loadUsersFromDb() {
  const data = await readJsonCollection('users', { users: [] });
  const users = Array.isArray(data) ? data : data.users || [];
  return users.map((u) => ({
    ...u,
    admin: !!u.admin,
    email: u.email ? String(u.email).toLowerCase() : undefined,
    banned: u.banned || { active: false },
    loginHistory: Array.isArray(u.loginHistory) ? u.loginHistory.slice(0, 10) : []
  }));
}

async function saveUsersToDb(users) {
  await writeJsonCollection('users', { users });
}

async function loadGamesFromDb() {
  const data = await readJsonCollection('games', []);
  const games = Array.isArray(data) ? data : (data.games || []);
  return games.map((g) => ({ ...g, disabled: !!g.disabled, disabledMessage: g.disabledMessage || '' }));
}

async function saveGamesToDb(games) {
  await writeJsonCollection('games', games);
}

async function loadRequestsFromDb() {
  const data = await readJsonCollection('requests', { requests: [] });
  return Array.isArray(data) ? data : (data.requests || []);
}

async function saveRequestsToDb(requests) {
  await writeJsonCollection('requests', { requests });
}

async function loadReportsFromDb() {
  const data = await readJsonCollection('reports', { reports: [] });
  return Array.isArray(data) ? data : (data.reports || []);
}

async function saveReportsToDb(reports) {
  await writeJsonCollection('reports', { reports });
}

async function loadSessionsFromDb() {
  const data = await readJsonCollection('sessions', { sessions: [] });
  return Array.isArray(data) ? data : (data.sessions || []);
}

async function saveSessionsToDb(sessions) {
  await writeJsonCollection('sessions', { sessions });
}

module.exports = {
  isDatabaseEnabled,
  ensureSchema,
  withDatabase,
  readJsonCollection,
  writeJsonCollection,
  readConfigFromDb,
  writeConfigToDb,
  loadUsersFromDb,
  saveUsersToDb,
  loadGamesFromDb,
  saveGamesToDb,
  loadRequestsFromDb,
  saveRequestsToDb,
  loadReportsFromDb,
  saveReportsToDb,
  loadSessionsFromDb,
  saveSessionsToDb
};
