const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
}) : null;

let dbDisabledReason = null;

function disableDatabase(err) {
  if (dbDisabledReason) return;
  dbDisabledReason = err?.message || String(err || 'Unknown database error');
  console.error('Database disabled for this process. Falling back to file storage:', dbDisabledReason);
}

function isDatabaseEnabled() {
  return Boolean(pool) && !dbDisabledReason;
}

async function withDatabase(fn, fallbackValue) {
  if (!isDatabaseEnabled()) return fallbackValue;
  try {
    return await fn(pool);
  } catch (err) {
    disableDatabase(err);
    return fallbackValue;
  }
}

async function ensureSchema() {
  return withDatabase(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_games (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_requests (
        id TEXT PRIMARY KEY,
        row_order INTEGER NOT NULL DEFAULT 0,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_reports (
        id TEXT PRIMARY KEY,
        row_order INTEGER NOT NULL DEFAULT 0,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_analytics_players (
        id BIGSERIAL PRIMARY KEY,
        captured_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_analytics_games (
        id BIGSERIAL PRIMARY KEY,
        captured_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      )
    `);

    await migrateFromLegacyAppData();
    return true;
  }, false);
}

async function migrateFromLegacyAppData() {
  if (!pool) return;
  const exists = await pool.query("SELECT to_regclass('public.app_data') AS name");
  if (!exists.rows[0]?.name) return;

  const [cfgCount, userCount, gameCount, requestCount, reportCount, sessionCount, playersCount, gamesAnalyticsCount] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM app_config'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_users'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_games'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_requests'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_reports'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_sessions'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_analytics_players'),
    pool.query('SELECT COUNT(*)::int AS count FROM app_analytics_games')
  ]);

  const readLegacy = async (key, fallback) => {
    const { rows } = await pool.query('SELECT value FROM app_data WHERE key = $1', [key]);
    if (!rows.length) return fallback;
    return rows[0].value;
  };

  if ((cfgCount.rows[0]?.count || 0) === 0) {
    const cfg = await readLegacy('config', null);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      await writeConfigToDb(cfg);
    }
  }

  if ((userCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('users', { users: [] });
    const users = Array.isArray(raw) ? raw : (raw.users || []);
    await saveUsersToDb(users);
  }

  if ((gameCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('games', []);
    const games = Array.isArray(raw) ? raw : (raw.games || []);
    await saveGamesToDb(games);
  }

  if ((requestCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('requests', { requests: [] });
    const requests = Array.isArray(raw) ? raw : (raw.requests || []);
    await saveRequestsToDb(requests);
  }

  if ((reportCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('reports', { reports: [] });
    const reports = Array.isArray(raw) ? raw : (raw.reports || []);
    await saveReportsToDb(reports);
  }

  if ((sessionCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('sessions', { sessions: [] });
    const sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
    await saveSessionsToDb(sessions);
  }

  if ((playersCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('analytics_players', { entries: [] });
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      await appendAnalyticsEntryToDb('players', entry, Number.MAX_SAFE_INTEGER);
    }
  }

  if ((gamesAnalyticsCount.rows[0]?.count || 0) === 0) {
    const raw = await readLegacy('analytics_games', { entries: [] });
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      await appendAnalyticsEntryToDb('games', entry, Number.MAX_SAFE_INTEGER);
    }
  }
}

function normalizeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function safeString(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

function dedupeRowsById(rows) {
  const map = new Map();
  for (const row of normalizeArray(rows)) {
    const candidate = row || {};
    const id = safeString(candidate.id, cryptoRandomId());
    map.set(id, { ...candidate, id });
  }
  return Array.from(map.values());
}

async function replaceRows(tableName, rows) {
  return withDatabase(async () => {
    const normalized = dedupeRowsById(rows);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < normalized.length; i += 1) {
        const row = normalized[i];
        await client.query(
          `INSERT INTO ${tableName} (id, row_order, data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (id)
           DO UPDATE SET row_order = EXCLUDED.row_order, data = EXCLUDED.data, updated_at = NOW()`,
          [row.id, i, row]
        );
      }

      if (normalized.length) {
        const ids = normalized.map((row) => row.id);
        await client.query(`DELETE FROM ${tableName} WHERE id <> ALL($1::text[])`, [ids]);
      } else {
        await client.query(`DELETE FROM ${tableName}`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }, undefined);
}

function cryptoRandomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function replaceRowsById(tableName, rows) {
  return withDatabase(async () => {
    const normalized = dedupeRowsById(rows);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of normalized) {
        await client.query(
          `INSERT INTO ${tableName} (id, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id)
           DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [row.id, row]
        );
      }

      if (normalized.length) {
        const ids = normalized.map((row) => row.id);
        await client.query(`DELETE FROM ${tableName} WHERE id <> ALL($1::text[])`, [ids]);
      } else {
        await client.query(`DELETE FROM ${tableName}`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }, undefined);
}

async function readOrderedRows(tableName) {
  return withDatabase(async () => {
    const { rows } = await pool.query(`SELECT data FROM ${tableName} ORDER BY row_order ASC, updated_at ASC`);
    return rows.map((r) => r.data).filter(Boolean);
  }, []);
}

async function readRowsById(tableName) {
  return withDatabase(async () => {
    const { rows } = await pool.query(`SELECT data FROM ${tableName} ORDER BY updated_at ASC`);
    return rows.map((r) => r.data).filter(Boolean);
  }, []);
}

async function readConfigFromDb(fallbackValue = {}) {
  return withDatabase(async () => {
    const { rows } = await pool.query('SELECT data FROM app_config WHERE id = 1');
    if (!rows.length) return fallbackValue;
    const data = rows[0].data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fallbackValue;
    return data;
  }, fallbackValue);
}

async function writeConfigToDb(config) {
  await withDatabase(async () => {
    await pool.query(
      `INSERT INTO app_config (id, data, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [config || {}]
    );
  }, undefined);
}

async function loadUsersFromDb() {
  const users = await readRowsById('app_users');
  return users.map((u) => ({
    ...u,
    admin: !!u.admin,
    email: u.email ? String(u.email).toLowerCase() : undefined,
    banned: u.banned || { active: false },
    loginHistory: Array.isArray(u.loginHistory) ? u.loginHistory.slice(0, 10) : []
  }));
}

async function saveUsersToDb(users) {
  await replaceRowsById('app_users', normalizeArray(users));
}

async function loadGamesFromDb() {
  const games = await readRowsById('app_games');
  return games.map((g) => ({ ...g, disabled: !!g.disabled, disabledMessage: g.disabledMessage || '' }));
}

async function saveGamesToDb(games) {
  await replaceRowsById('app_games', normalizeArray(games));
}

async function loadRequestsFromDb() {
  return readOrderedRows('app_requests');
}

async function saveRequestsToDb(requests) {
  await replaceRows('app_requests', normalizeArray(requests));
}

async function loadReportsFromDb() {
  return readOrderedRows('app_reports');
}

async function saveReportsToDb(reports) {
  await replaceRows('app_reports', normalizeArray(reports));
}

async function loadSessionsFromDb() {
  return readRowsById('app_sessions');
}

async function saveSessionsToDb(sessions) {
  await replaceRowsById('app_sessions', normalizeArray(sessions));
}

function analyticsTable(name) {
  return name === 'games' ? 'app_analytics_games' : 'app_analytics_players';
}

async function loadAnalyticsSeriesFromDb(name) {
  return withDatabase(async () => {
    const table = analyticsTable(name);
    const { rows } = await pool.query(
      `SELECT data FROM ${table} ORDER BY captured_at ASC, id ASC`
    );
    return { entries: rows.map((r) => r.data).filter(Boolean) };
  }, { entries: [] });
}

async function appendAnalyticsEntryToDb(name, entry, maxEntries) {
  await withDatabase(async () => {
    const table = analyticsTable(name);
    const parsedTime = Date.parse(entry?.time || '');
    const capturedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : new Date().toISOString();
    await pool.query(`INSERT INTO ${table} (captured_at, data) VALUES ($1, $2)`, [capturedAt, entry]);
    if (Number.isFinite(maxEntries) && maxEntries > 0) {
      await pool.query(
        `DELETE FROM ${table}
         WHERE id IN (
           SELECT id FROM ${table}
           ORDER BY captured_at DESC, id DESC
           OFFSET $1
         )`,
        [maxEntries]
      );
    }
  }, undefined);
}

module.exports = {
  isDatabaseEnabled,
  ensureSchema,
  withDatabase,
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
  saveSessionsToDb,
  loadAnalyticsSeriesFromDb,
  appendAnalyticsEntryToDb
};
