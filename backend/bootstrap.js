const fs = require('fs/promises');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const yaml = require('js-yaml');

function normalizeOrigin(origin) {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function getRequestOrigin(req) {
  const forwardedProto = (req?.get ? req.get('x-forwarded-proto') : '') ||
    (req?.headers?.['x-forwarded-proto'] || '') ||
    (req?.protocol || 'http');
  const forwardedHost = (req?.get ? req.get('x-forwarded-host') : '') ||
    (req?.headers?.['x-forwarded-host'] || '') ||
    req?.headers?.host ||
    'localhost:3000';

  const scheme = String(forwardedProto).split(',')[0].trim() || 'http';
  const host = String(forwardedHost).split(',')[0].trim() || 'localhost:3000';
  return `${scheme}://${host}`.replace(/\/+$/, '');
}

async function ensureConfigAllowedOrigin(configPath, origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return null;

  let config = {};
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = yaml.load(raw);
    config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    config = {};
  }

  const cors = config.cors && typeof config.cors === 'object' && !Array.isArray(config.cors) ? config.cors : {};
  const existing = Array.isArray(cors.allowedOrigins) ? cors.allowedOrigins : [];
  const merged = Array.from(new Set([...existing.map(String), normalized]));
  config.cors = { ...cors, allowedOrigins: merged };

  await fs.mkdir(require('path').dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.dump(config, { noRefs: true, lineWidth: 120 }), 'utf8');
  return config.cors;
}

async function ensureDefaultAdminUser({ usersPath, configPath, username = 'admin', password = 'password' } = {}) {
  const raw = await fs.readFile(usersPath, 'utf8').catch(() => '{"users":[]}');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = { users: [] };
  }

  const users = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.users) ? parsed.users : []);
  if (users.length > 0) {
    return null;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    username,
    email: `${username}@local.local`,
    passwordHash,
    favorites: [],
    profile: {
      username,
      accentColor: '#58a6ff',
      avatar: null,
      lastPlayed: [],
      playtime: {}
    },
    settings: {},
    friends: { accepted: [], incoming: [], outgoing: [], blocked: [] },
    presence: { online: true, gameId: null, lastSeen: now },
    loginHistory: [],
    banned: { active: false },
    createdAt: now,
    updatedAt: now,
    admin: true
  };

  await fs.writeFile(usersPath, JSON.stringify({ users: [user] }, null, 2), 'utf8');

  if (configPath) {
    const detectedOrigin = process.env.PUBLIC_BASE_URL || process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN;
    if (detectedOrigin) {
      await ensureConfigAllowedOrigin(configPath, detectedOrigin);
    }
  }

  return user;
}

module.exports = {
  normalizeOrigin,
  getRequestOrigin,
  ensureConfigAllowedOrigin,
  ensureDefaultAdminUser
};
