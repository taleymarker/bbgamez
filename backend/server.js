const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { Readable } = require('stream');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const morgan = require('morgan');
const yaml = require('js-yaml');

const APP_VERSION = '3.0.0';
const PORT = process.env.PORT || 3000;
const SESSION_SECRET_FILE = path.join(__dirname, 'data', 'session-secret.txt');
const JWT_SECRET = process.env.JWT_SECRET || loadSessionSecret();
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const CONFIG_GENERAL_FILE = path.join(DATA_DIR, 'config.yml');
const FEATURES_FILE = path.join(DATA_DIR, 'features.yml');
const DEFAULTS_FILE = path.join(DATA_DIR, 'default-settings.yml');
const LEGACY_CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const IMAGES_DIR = path.join(__dirname, 'images');
const SITEMAP_FILE = path.join(FRONTEND_DIR, 'sitemap.xml');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : null;
const COOKIE_NAME = 'jg_session';
const REFRESH_COOKIE_NAME = 'jg_refresh';
const GUEST_COOKIE = 'jg_guest';
const LEGACY_SESSION_COOKIE = 'ww_session';
const LEGACY_GUEST_COOKIE = 'ww_guest';
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 14; // keep users logged in for two weeks by default
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : (process.env.PUBLIC_BASE_URL || '').startsWith('https://'); // default to secure only when an https public URL is set
const COOKIE_SAME_SITE = (process.env.COOKIE_SAME_SITE || (COOKIE_SECURE ? 'none' : 'lax')).toLowerCase();
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const MAX_META_BYTES = Math.max(16 * 1024, Math.min(Number(process.env.MAX_META_BYTES) || 200_000, 1_000_000));
const MAX_PROXY_BYTES = Math.max(1_000_000, Math.min(Number(process.env.MAX_PROXY_BYTES) || 25_000_000, 100_000_000));
const ONLINE_WINDOW_MS = 20 * 1000; // users must ping within last 20 seconds to count as online
const ANALYTICS_DIR = path.join(DATA_DIR, 'analytics');
const ANALYTICS_PLAYERS_FILE = path.join(ANALYTICS_DIR, 'players.json');
const ANALYTICS_GAMES_FILE = path.join(ANALYTICS_DIR, 'games.json');
const ANALYTICS_RETENTION_MINUTES = 365 * 24 * 60; // keep up to ~12 months of minute snapshots (bounded by disk; tune as needed)
const ANALYTICS_FLUSH_INTERVAL_MS = 60 * 1000;
let analyticsFlushInFlight = false;
const analyticsCounters = {};

const BUILT_IN_PRESETS = {
    panicButtons: [
        { id: 'google-classroom', label: 'Google Classroom', url: 'https://classroom.google.com', keybind: 'Escape' },
        { id: 'khan-academy', label: 'Khan Academy', url: 'https://www.khanacademy.org', keybind: 'Escape' }
    ],
    tabDisguises: [
        {
            id: 'google-classroom',
            label: 'Google Classroom',
            title: 'Classes',
            favicon: 'https://ssl.gstatic.com/classroom/favicon.png',
            sourceUrl: 'https://classroom.google.com'
        },
        {
            id: 'khan-academy',
            label: 'Khan Academy',
            title: 'Khan Academy',
            favicon: 'https://www.khanacademy.org/favicon.ico',
            sourceUrl: 'https://www.khanacademy.org'
        }
    ]
};

const app = express();
// Trust only local/known proxies to keep rate-limit IPs accurate (avoids permissive 'true')
const TRUST_PROXY_SETTING = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
app.set('trust proxy', TRUST_PROXY_SETTING);

const DEFAULT_CORS_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

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

function parseStringList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function parseOrigins(value) {
    return parseStringList(value)
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean);
}

function parseBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

function parsePositiveInteger(value, fallback) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function normalizeCorsConfig(input = {}, fallbackAllowedOrigins = []) {
    const configuredOrigins = parseOrigins(input.allowedOrigins);
    const allowedOrigins = configuredOrigins.length ? configuredOrigins : fallbackAllowedOrigins;
    const methods = parseStringList(input.methods);
    const allowedHeaders = parseStringList(input.allowedHeaders);
    const exposedHeaders = parseStringList(input.exposedHeaders);
    const maxAge = parsePositiveInteger(input.maxAge, undefined);

    const normalized = {
        allowedOrigins,
        allowNoOrigin: parseBoolean(input.allowNoOrigin, true),
        credentials: parseBoolean(input.credentials, true),
        methods: methods.length ? methods : DEFAULT_CORS_METHODS,
        allowedHeaders,
        exposedHeaders,
        optionsSuccessStatus: parsePositiveInteger(input.optionsSuccessStatus, 204)
    };

    if (maxAge !== undefined) normalized.maxAge = maxAge;
    return normalized;
}

function loadGeneralConfigSync() {
    try {
        const raw = fsSync.readFileSync(CONFIG_GENERAL_FILE, 'utf8');
        const parsed = yaml.load(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

const ENV_CONFIGURED_ORIGINS = parseOrigins(process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN || PUBLIC_BASE_URL || '');
let runtimeCorsConfig = normalizeCorsConfig(loadGeneralConfigSync().cors || {}, ENV_CONFIGURED_ORIGINS);

function applyRuntimeCorsConfig(config) {
    runtimeCorsConfig = normalizeCorsConfig(config || {}, ENV_CONFIGURED_ORIGINS);
}

// In-memory heartbeat tracking for guests (non-authenticated visitors)
const guestHeartbeats = new Map();

// --- Middleware
app.disable('x-powered-by');
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
// Same-origin calls have no Origin header. Cross-origin calls are controlled by
// data/config.yml -> cors.allowedOrigins (env vars remain as fallback).
app.use(cors((req, callback) => {
    const currentCors = runtimeCorsConfig;
    const requestOrigin = req.header('Origin');
    const normalizedOrigin = normalizeOrigin(requestOrigin);
    const isAllowed = (!requestOrigin && currentCors.allowNoOrigin)
        || (normalizedOrigin && currentCors.allowedOrigins.includes(normalizedOrigin));

    if (!isAllowed) return callback(new Error('Origin not allowed by CORS'));

    return callback(null, {
        origin: true,
        credentials: currentCors.credentials,
        methods: currentCors.methods,
        allowedHeaders: currentCors.allowedHeaders.length ? currentCors.allowedHeaders : undefined,
        exposedHeaders: currentCors.exposedHeaders.length ? currentCors.exposedHeaders : undefined,
        maxAge: currentCors.maxAge,
        optionsSuccessStatus: currentCors.optionsSuccessStatus
    });
}));
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(morgan('dev'));
// Disable weak ETags to avoid 304 responses breaking SPA fetch flows
app.set('etag', false);

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false
});
app.use(['/api', '/proxy'], apiLimiter);

// --- Utility helpers
async function ensureFile(file, fallback) {
    try {
        await fs.access(file);
    } catch (_) {
        await writeAtomically(file, JSON.stringify(fallback, null, 2));
    }
}

async function fileExists(file) {
    try {
        await fs.access(file);
        return true;
    } catch (_) {
        return false;
    }
}

async function readYaml(file, fallback) {
    try {
        const raw = await fs.readFile(file, 'utf8');
        return yaml.load(raw);
    } catch (_) {
        return fallback;
    }
}

async function writeYaml(file, data) {
    const serialized = yaml.dump(data || {}, { noRefs: true, lineWidth: 120 });
    await writeAtomically(file, serialized);
}

async function ensureYamlFile(file, fallback) {
    try {
        await fs.access(file);
    } catch (_) {
        await writeYaml(file, fallback);
    }
}

function loadSessionSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    try {
        const existing = fsSync.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
        if (existing) return existing;
    } catch (_) {}
    const secret = crypto.randomBytes(48).toString('hex');
    try {
        fsSync.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
        fsSync.writeFileSync(SESSION_SECRET_FILE, secret, 'utf8');
    } catch (_) {}
    return secret;
}

async function readJson(file, fallback) {
    try {
        const raw = await fs.readFile(file, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

async function writeJson(file, data) {
    await writeAtomically(file, JSON.stringify(data, null, 2));
}

// Avoid leaving truncated JSON/YAML behind if the process stops during a write.
async function writeAtomically(file, content) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, file);
    } catch (err) {
        await fs.unlink(temp).catch(() => {});
        throw err;
    }
}

async function ensureAnalyticsFiles() {
    await fs.mkdir(ANALYTICS_DIR, { recursive: true });
    await ensureFile(ANALYTICS_PLAYERS_FILE, { entries: [] });
    await ensureFile(ANALYTICS_GAMES_FILE, { entries: [] });
}

async function loadAnalyticsFile(file) {
    return readJson(file, { entries: [] });
}

async function appendAnalyticsEntry(file, entry, maxEntries = ANALYTICS_RETENTION_MINUTES) {
    const data = await loadAnalyticsFile(file);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    entries.push(entry);
    const trimmed = entries.slice(-maxEntries);
    await writeJson(file, { entries: trimmed });
}

async function analyticsEnabled() {
    try {
        const config = await loadConfig();
        return config?.features?.analyticsEnabled !== false;
    } catch (_) {
        return true;
    }
}

async function loadConfig() {
    const legacy = await readJson(LEGACY_CONFIG_FILE, null);
    const general = await readYaml(CONFIG_GENERAL_FILE, legacy || {});
    const features = await readYaml(FEATURES_FILE, legacy?.features || {});
    const defaults = await readYaml(DEFAULTS_FILE, legacy?.defaults || {});
    const cors = normalizeCorsConfig(general?.cors || legacy?.cors || {}, ENV_CONFIGURED_ORIGINS);
    return {
        version: general?.version || APP_VERSION,
        maintenanceMode: general?.maintenanceMode || { enabled: false },
        uiControls: general?.uiControls || {},
        cors,
        features: features || {},
        defaults: (defaults && Object.keys(defaults).length ? defaults : { presets: BUILT_IN_PRESETS })
    };
}

async function saveConfig(config) {
    const cors = normalizeCorsConfig(config?.cors || {}, ENV_CONFIGURED_ORIGINS);
    const general = {
        version: config?.version || APP_VERSION,
        maintenanceMode: config?.maintenanceMode || { enabled: false },
        uiControls: config?.uiControls || {},
        cors
    };
    await writeYaml(CONFIG_GENERAL_FILE, general);
    applyRuntimeCorsConfig(cors);
    await writeYaml(FEATURES_FILE, config?.features || {});
    await writeYaml(DEFAULTS_FILE, config?.defaults || { presets: BUILT_IN_PRESETS });
}

async function migrateLegacyConfig() {
    if (!(await fileExists(LEGACY_CONFIG_FILE))) return;
    const legacy = await readJson(LEGACY_CONFIG_FILE, null);
    if (!legacy) return;

    if (!(await fileExists(CONFIG_GENERAL_FILE))) {
        await writeYaml(CONFIG_GENERAL_FILE, {
            version: legacy.version || APP_VERSION,
            maintenanceMode: legacy.maintenanceMode || { enabled: false },
            uiControls: legacy.uiControls || {},
            cors: normalizeCorsConfig(legacy.cors || {}, ENV_CONFIGURED_ORIGINS)
        });
    }
    if (!(await fileExists(FEATURES_FILE)) && legacy.features) {
        await writeYaml(FEATURES_FILE, legacy.features || {});
    }
    if (!(await fileExists(DEFAULTS_FILE)) && legacy.defaults) {
        await writeYaml(DEFAULTS_FILE, legacy.defaults || { presets: BUILT_IN_PRESETS });
    }
}

function isHttpUrl(url) {
    if (!url) return false;
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function isPrivateAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 168)) ||
            (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    if (family === 6) {
        const value = address.toLowerCase();
        if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
        return value === '::' || value === '::1' || value.startsWith('fc') ||
            value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
            value.startsWith('fea') || value.startsWith('feb');
    }
    return true;
}

async function assertSafeRemoteUrl(value) {
    const target = new URL(value);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw new Error('Only public http/https URLs are allowed');
    }
    const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
        (net.isIP(hostname) && isPrivateAddress(hostname))) {
        throw new Error('Private network URLs are not allowed');
    }
    const addresses = net.isIP(hostname)
        ? [{ address: hostname }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
        throw new Error('Private network URLs are not allowed');
    }
    return target;
}

async function fetchPublicUrl(value, options = {}) {
    let target = await assertSafeRemoteUrl(value);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
        const response = await fetch(target, { ...options, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: target.toString() };
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('Too many redirects');
        response.body?.cancel().catch(() => {});
        target = await assertSafeRemoteUrl(new URL(location, target).toString());
    }
    throw new Error('Too many redirects');
}

async function readResponseText(response, maxBytes) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new Error('Response is too large');
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new Error('Response is too large');
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
}

function isIconUrl(url) {
    if (!url) return true;
    return isHttpUrl(url) || url.startsWith('data:image/');
}

function resolveBaseUrl(req) {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
    const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
    return `${protocol}://${host}`.replace(/\/+$/, '');
}

function buildGamePathForSitemap(gameId) {
    return `/game/${encodeURIComponent(gameId)}`;
}

function extractMetaFromHtml(html = '', baseUrl = '') {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().slice(0, 160) : '';
    const linkMatch = html.match(/<link[^>]+rel=["'](?:shortcut\s+icon|icon)["'][^>]*>/i);
    let favicon = '';
    if (linkMatch) {
        const hrefMatch = linkMatch[0].match(/href=["']([^"']+)["']/i);
        if (hrefMatch && hrefMatch[1]) {
            try {
                favicon = new URL(hrefMatch[1], baseUrl || undefined).toString();
            } catch (_) {
                favicon = hrefMatch[1];
            }
        }
    }
    return { title, favicon };
}

function sanitizePanicPreset(preset = {}, fallbackId = '') {
    return {
        id: String(preset.id || fallbackId || crypto.randomUUID()),
        label: String(preset.label || 'Preset'),
        url: isHttpUrl(preset.url) ? preset.url : '',
        keybind: String(preset.keybind || '').slice(0, 80)
    };
}

function sanitizeTabPreset(preset = {}, fallbackId = '') {
    return {
        id: String(preset.id || fallbackId || crypto.randomUUID()),
        label: String(preset.label || 'Preset'),
        title: String(preset.title || ''),
        favicon: isIconUrl(preset.favicon) ? (preset.favicon || '') : '',
        sourceUrl: isHttpUrl(preset.sourceUrl) ? preset.sourceUrl : ''
    };
}

function normalizePresets(config) {
    const presets = config?.defaults?.presets || {};
    const panicButtonsRaw = Array.isArray(presets.panicButtons) ? presets.panicButtons : [];
    const tabDisguisesRaw = Array.isArray(presets.tabDisguises) ? presets.tabDisguises : [];
    const panicButtons = (panicButtonsRaw.length ? panicButtonsRaw : BUILT_IN_PRESETS.panicButtons)
        .slice(0, 25)
        .map((p, idx) => sanitizePanicPreset(p, p.id || `panic-${idx}`));
    const tabDisguises = (tabDisguisesRaw.length ? tabDisguisesRaw : BUILT_IN_PRESETS.tabDisguises)
        .slice(0, 25)
        .map((p, idx) => sanitizeTabPreset(p, p.id || `disguise-${idx}`));
    return { panicButtons, tabDisguises };
}

function defaultSettingsFromConfig(config) {
    const d = config.defaults || {};
    const particles = d.particles || {};
    const cursor = d.cursor || {};
    const panic = d.panicButton || d.panic || {};
    const disguise = d.tabDisguise || {};
    return {
        proxyDefault: !!d.proxyDefault,
        accentColor: d.accentColor || '#58a6ff',
        particlesEnabled: particles.enabled !== false,
        particleCount: Number.isFinite(particles.count) ? particles.count : 50,
        particleSpeed: Number.isFinite(particles.speed) ? particles.speed : 0.5,
        particleColor: particles.color || '#58a6ff',
        particleLineDistance: Number.isFinite(particles.lineDistance) ? particles.lineDistance : 150,
        particleMouseInteraction: particles.mouse !== false,
        cursorEnabled: cursor.enabled !== false,
        cursorSize: Number.isFinite(cursor.size) ? cursor.size : 8,
        cursorColor: cursor.color || '#ffffff',
        cursorType: ['circle', 'dot', 'none', 'custom'].includes(cursor.type) ? cursor.type : 'circle',
        showClock: d.showClock !== false,
        showCurrent: d.showCurrent !== false,
        panicEnabled: panic.enabled === true,
        panicUrl: panic.url || '',
        panicKeybind: panic.keybind || '',
        panicPreset: panic.preset || '',
        tabDisguiseEnabled: disguise.enabled === true,
        tabDisguiseTitle: disguise.title || '',
        tabDisguiseFavicon: disguise.favicon || '',
        tabDisguiseSource: disguise.sourceUrl || '',
        tabDisguisePreset: disguise.preset || ''
    };
}

async function loadGames() {
    const data = await readJson(GAMES_FILE, []);
    const games = Array.isArray(data) ? data : data.games || [];
    return games.map((g) => ({ ...g, disabled: !!g.disabled, disabledMessage: g.disabledMessage || '' }));
}

async function saveGames(games) {
    await writeJson(GAMES_FILE, games);
    try {
        await regenerateSitemap(games);
    } catch (err) {
        console.error('Failed to regenerate sitemap after saving games', err);
    }
}

async function generateSitemapXml(games, baseUrl) {
    const base = (baseUrl || PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
    const urls = [
        `${base}/`,
        ...games
            .filter((g) => !g.disabled)
            .map((g) => `${base}${buildGamePathForSitemap(g.id)}`)
    ];
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...urls.map((loc) => `  <url><loc>${loc}</loc></url>`),
        '</urlset>'
    ].join('\n');
}

async function regenerateSitemap(games, baseUrl) {
    const list = games || await loadGames();
    const xml = await generateSitemapXml(list, baseUrl);
    await fs.mkdir(path.dirname(SITEMAP_FILE), { recursive: true });
    await fs.writeFile(SITEMAP_FILE, xml, 'utf8');
    return xml;
}

async function loadUsers() {
    const data = await readJson(USERS_FILE, { users: [] });
    const users = Array.isArray(data) ? data : data.users || [];
    return users.map((u) => ({
        ...u,
        admin: !!u.admin,
        email: u.email ? String(u.email).toLowerCase() : undefined,
        banned: u.banned || { active: false },
        loginHistory: Array.isArray(u.loginHistory) ? u.loginHistory.slice(0, 10) : []
    }));
}

async function saveUsers(users) {
    await writeJson(USERS_FILE, { users });
}

async function loadRequests() {
    const data = await readJson(REQUESTS_FILE, { requests: [] });
    return Array.isArray(data) ? data : data.requests || [];
}

async function saveRequests(requests) {
    await writeJson(REQUESTS_FILE, { requests });
}

async function loadReports() {
    const data = await readJson(REPORTS_FILE, { reports: [] });
    return Array.isArray(data) ? data : data.reports || [];
}

async function saveReports(reports) {
    await writeJson(REPORTS_FILE, { reports });
}

function sanitizeUser(user) {
    if (!user) return null; // Ensure user object is valid
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        admin: !!user.admin,
        banned: user.banned || { active: false },
        online: isUserOnline(user),
        profile: {
            ...(user.profile || {}),
            lastPlayed: Array.isArray(user.profile?.lastPlayed) ? user.profile.lastPlayed : [],
            playtime: normalizePlaytime(user.profile?.playtime)
        },
        favorites: user.favorites || [],
        friends: user.friends || { accepted: [], incoming: [], outgoing: [], blocked: [] },
        settings: user.settings || {},
        presence: user.presence || { online: false, gameId: null, lastSeen: null },
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cookieOptions(maxAge, req) {
    const protoHeader = req?.get ? (req.get('x-forwarded-proto') || '').split(',')[0].trim() : '';
    const isHttps = (protoHeader || req?.protocol || '').toLowerCase() === 'https';
    const secureFlag = COOKIE_SECURE || isHttps;
    const requestedSameSite = (process.env.COOKIE_SAME_SITE || (secureFlag ? 'none' : 'lax')).toLowerCase();
    const sameSiteFlag = ['lax', 'strict', 'none'].includes(requestedSameSite) ? requestedSameSite : 'lax';
    const effectiveSameSite = sameSiteFlag === 'none' && !secureFlag ? 'lax' : sameSiteFlag;
    const opts = {
        httpOnly: true,
        secure: secureFlag,
        sameSite: effectiveSameSite,
        maxAge
    };
    if (COOKIE_DOMAIN) opts.domain = COOKIE_DOMAIN;
    return opts;
}

function parseSessionCookie(req) {
    const raw = req.cookies[COOKIE_NAME] || req.cookies[LEGACY_SESSION_COOKIE];
    if (!raw) return null;
    const [sessionId, ...rest] = String(raw).split('.');
    const token = rest.join('.');
    if (!sessionId || !token) return null;
    return { sessionId, token };
}

function setSessionCookie(res, sessionId, sessionToken, maxAge = REFRESH_TOKEN_TTL_MS) {
    res.cookie(COOKIE_NAME, `${sessionId}.${sessionToken}`, cookieOptions(maxAge, res.req));
    res.clearCookie(LEGACY_GUEST_COOKIE);
    res.clearCookie(LEGACY_SESSION_COOKIE);
    res.clearCookie(REFRESH_COOKIE_NAME);
}

function clearAuthCookies(res) {
    res.clearCookie(COOKIE_NAME);
    res.clearCookie(REFRESH_COOKIE_NAME);
    res.clearCookie(LEGACY_SESSION_COOKIE);
    res.clearCookie(LEGACY_GUEST_COOKIE);
}

async function loadSessions() {
    const data = await readJson(SESSION_FILE, { sessions: [] });
    return Array.isArray(data) ? data : data.sessions || [];
}

async function saveSessions(sessions) {
    await writeJson(SESSION_FILE, { sessions });
}

function pruneSessionsList(sessions, now = Date.now()) {
    const cutoff = now - REFRESH_TOKEN_TTL_MS;
    return sessions.filter((s) => {
        const exp = Date.parse(s.expiresAt || 0);
        const revoked = Date.parse(s.revokedAt || 0);
        const active = !Number.isFinite(exp) || exp > now;
        const recentlyRevoked = Number.isFinite(revoked) ? revoked > cutoff : false;
        return active || recentlyRevoked;
    });
}

async function persistSessions(sessions) {
    await saveSessions(pruneSessionsList(sessions));
}

async function createSession(user, meta = {}) {
    const sessions = await loadSessions();
    const sessionToken = crypto.randomBytes(48).toString('hex');
    const now = new Date();
    const session = {
        id: crypto.randomUUID(),
        userId: user.id,
        sessionHash: hashToken(sessionToken),
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
        ip: meta.ip || null,
        userAgent: meta.userAgent || null,
        revokedAt: null
    };
    sessions.push(session);
    await persistSessions(sessions);
    return { session, sessionToken };
}

async function replaceSessionForUser(user, req, res) {
    const meta = { ip: getClientIp(req), userAgent: req.headers['user-agent'] };
    const sessions = await loadSessions();
    if (req.session) {
        const existing = sessions.find((s) => s.id === req.session.id);
        if (existing) existing.revokedAt = new Date().toISOString();
        await persistSessions(sessions);
    }
    const { session, sessionToken } = await createSession(user, meta);
    setSessionCookie(res, session.id, sessionToken);
    req.session = session;
    return session;
}

async function refreshSessionFromCookie(req, res) {
    const parsed = parseSessionCookie(req);
    if (!parsed) return null;
    const sessions = await loadSessions();
    const session = sessions.find((s) => s.id === parsed.sessionId);
    if (!session || session.revokedAt) {
        await persistSessions(sessions);
        return null;
    }

    const now = Date.now();
    const expiresAt = Date.parse(session.expiresAt || 0);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
        session.revokedAt = session.revokedAt || new Date().toISOString();
        await persistSessions(sessions);
        return null;
    }

    if (session.sessionHash !== hashToken(parsed.token)) return null;

    const users = await loadUsers();
    const me = await getUserById(users, session.userId);
    if (!me) {
        session.revokedAt = session.revokedAt || new Date().toISOString();
        await persistSessions(sessions);
        return null;
    }

    session.lastSeenAt = new Date().toISOString();
    session.expiresAt = new Date(now + REFRESH_TOKEN_TTL_MS).toISOString();
    await persistSessions(sessions);

    // Refresh the session cookie so the window slides without rotating the token.
    setSessionCookie(res, session.id, parsed.token);
    return { user: me, session };
}

async function requireAuth(req, res, next) {
    const refreshed = await refreshSessionFromCookie(req, res);
    if (!refreshed?.user || !refreshed?.session) return res.status(401).json({ error: 'Session expired' });

    const { user, session } = refreshed;
    if (user.banned?.active) {
        clearAuthCookies(res);
        return res.status(403).json({ error: 'Account is banned' });
    }
    req.user = { id: user.id, username: user.username, admin: !!user.admin };
    req.me = user;
    req.session = session;
    return next();
}

async function requireAdmin(req, res, next) {
    return requireAuth(req, res, () => {
        if (!req.me?.admin) return res.status(403).json({ error: 'Admin required' });
        req.user = { ...(req.user || {}), admin: true };
        return next();
    });
}

async function getUserById(users, id) {
    return users.find(u => u.id === id);
}

async function getUserByUsername(users, username) {
    return users.find(u => u.username.toLowerCase() === username.toLowerCase());
}

async function getUserByEmail(users, email) {
    if (!email) return null;
    return users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
}

function colorIsValid(hex) {
    return /^#([0-9a-fA-F]{6})$/.test(hex);
}

function ensurePresence(user) {
    if (!user.presence) {
        user.presence = { online: false, gameId: null, lastSeen: new Date().toISOString() };
    }
    if (!user.presence.lastSeen) user.presence.lastSeen = new Date().toISOString();
    if (user.presence.online === undefined) user.presence.online = false;
    if (user.presence.gameId === undefined) user.presence.gameId = null;
}

function isUserOnline(user, now = Date.now()) {
    ensurePresence(user);
    const last = Date.parse(user.presence.lastSeen || '');
    const fresh = Number.isFinite(last) ? (now - last) <= ONLINE_WINDOW_MS : false;
    return !!user.presence.online && fresh;
}

function setPresence(user, { online, gameId }) {
    ensurePresence(user);
    if (online !== undefined) user.presence.online = !!online;
    if (gameId !== undefined) user.presence.gameId = gameId === null ? null : String(gameId);
    user.presence.lastSeen = new Date().toISOString();
}

function normalizePlaytime(playtime) {
    if (!playtime || typeof playtime !== 'object') return {};
    const normalized = {};
    Object.entries(playtime).forEach(([id, value]) => {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms < 0) return;
        normalized[String(id)] = ms;
    });
    return normalized;
}

function updateLastPlayed(user, gameId, max = 10) {
    if (!gameId) return;
    user.profile = user.profile || {};
    user.profile.playtime = normalizePlaytime(user.profile.playtime);
    const list = Array.isArray(user.profile.lastPlayed) ? user.profile.lastPlayed.slice() : [];
    const idStr = String(gameId);
    const filtered = list.filter(id => String(id) !== idStr);
    filtered.unshift(idStr);
    user.profile.lastPlayed = filtered.slice(0, max);
}

function addPlaytime(user, gameId, deltaMs) {
    if (!gameId) return;
    const delta = Number(deltaMs);
    if (!Number.isFinite(delta) || delta <= 0) return;
    user.profile = user.profile || {};
    user.profile.playtime = normalizePlaytime(user.profile.playtime);
    const key = String(gameId);
    user.profile.playtime[key] = (user.profile.playtime[key] || 0) + delta;
}

function pruneGuestHeartbeats(now = Date.now()) {
    for (const [id, ts] of guestHeartbeats.entries()) {
        if (now - ts > ONLINE_WINDOW_MS) guestHeartbeats.delete(id);
    }
    return guestHeartbeats.size;
}

function guestOnlineCount(now = Date.now()) {
    pruneGuestHeartbeats(now);
    return guestHeartbeats.size;
}

function recordFriendEvent(type) {
    return;
}

function recordAccountEvent(type) {
    return;
}

function countPlayersByGame(users = [], now = Date.now()) {
    const counts = {};
    users.forEach((u) => {
        if (!isUserOnline(u, now)) return;
        const gameId = u.presence?.gameId;
        if (!gameId) return;
        const key = String(gameId);
        counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
}

function countFavoritesByGame(users = []) {
    const counts = {};
    users.forEach((u) => {
        (u.favorites || []).forEach((id) => {
            const key = String(id);
            counts[key] = (counts[key] || 0) + 1;
        });
    });
    return counts;
}

async function flushAnalytics() {
    if (analyticsFlushInFlight) return;
    analyticsFlushInFlight = true;
    try {
        if (!(await analyticsEnabled())) return;
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const [users, games] = await Promise.all([loadUsers(), loadGames()]);
        const onlineUsers = users.filter((u) => isUserOnline(u, now)).length;
        const onlineGuests = guestOnlineCount(now);

        await appendAnalyticsEntry(ANALYTICS_PLAYERS_FILE, {
            time: nowIso,
            players: onlineUsers + onlineGuests,
            onlineUsers,
            onlineGuests
        });

        const favorites = countFavoritesByGame(users);
        const playersByGame = countPlayersByGame(users, now);
        const gamesSnapshot = games.map((g) => ({
            id: g.id,
            title: g.title,
            thumbnail: g.thumbnail || '',
            players: playersByGame[String(g.id)] || 0,
            favorites: favorites[String(g.id)] || 0,
            disabled: !!g.disabled
        }));

        await appendAnalyticsEntry(ANALYTICS_GAMES_FILE, { time: nowIso, games: gamesSnapshot });
    } catch (err) {
        console.error('Analytics flush failed', err?.message || err);
    } finally {
        analyticsFlushInFlight = false;
    }
}

setInterval(() => { flushAnalytics().catch(() => {}); }, ANALYTICS_FLUSH_INTERVAL_MS);
setTimeout(() => { flushAnalytics().catch(() => {}); }, 2000);

// --- Ensure data files exist on startup
(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await ensureFile(USERS_FILE, { users: [] });
    await ensureFile(GAMES_FILE, []);
    await migrateLegacyConfig();
    await ensureYamlFile(CONFIG_GENERAL_FILE, {
        version: APP_VERSION,
        maintenanceMode: { enabled: false },
        uiControls: {},
        cors: normalizeCorsConfig({}, ENV_CONFIGURED_ORIGINS)
    });
    await ensureYamlFile(FEATURES_FILE, {});
    await ensureYamlFile(DEFAULTS_FILE, { presets: BUILT_IN_PRESETS });
    const config = await loadConfig();
    applyRuntimeCorsConfig(config.cors || {});
    await ensureFile(REQUESTS_FILE, { requests: [] });
    await ensureFile(REPORTS_FILE, { reports: [] });
    await ensureFile(SESSION_FILE, { sessions: [] });
    await ensureAnalyticsFiles();
})();

// --- Core endpoints
app.get('/health', async (req, res) => {
    const games = await loadGames();
    const users = await loadUsers();
    const now = Date.now();
    const onlineUsers = users.filter(u => isUserOnline(u, now)).length;
    const onlineGuests = guestOnlineCount(now);
    res.json({
        status: 'ok',
        version: APP_VERSION,
        time: new Date().toISOString(),
        games: games.length,
        players: onlineUsers + onlineGuests,
        onlineUsers,
        onlineGuests,
        totalUsers: users.length
    });
});

// --- Game Requests
app.post('/api/requests', requireAuth, async (req, res) => {
    const { title, url, description, category } = req.body || {};
    if (!title || !url) return res.status(400).json({ error: 'Title and url are required' });
    if (String(title).length > 120) return res.status(400).json({ error: 'Title too long' });
    if (String(description || '').length > 1000) return res.status(400).json({ error: 'Description too long' });

    let parsed;
    try { parsed = new URL(url); } catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'URL must be http/https' });

    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const requests = await loadRequests();
    const now = new Date().toISOString();
    const request = {
        id: crypto.randomUUID(),
        userId: me.id,
        username: me.username,
        title: title.trim(),
        url: parsed.toString(),
        description: (description || '').trim(),
        category: (category || '').trim() || null,
        status: 'pending',
        createdAt: now,
        updatedAt: now
    };
    requests.push(request);
    await saveRequests(requests);
    res.status(201).json({ request });
});

app.get('/api/requests', requireAdmin, async (req, res) => {
    const requests = await loadRequests();
    res.json({ requests });
});

app.put('/api/requests/:id', requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (!['pending', 'approved', 'rejected', 'converted'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const requests = await loadRequests();
    const request = requests.find(r => r.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    request.status = status;
    request.updatedAt = new Date().toISOString();
    await saveRequests(requests);
    res.json({ request });
});

app.delete('/api/requests/:id', requireAdmin, async (req, res) => {
    const requests = await loadRequests();
    const idx = requests.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Request not found' });
    requests.splice(idx, 1);
    await saveRequests(requests);
    res.json({ success: true });
});

// --- Issue Reports
app.post('/api/reports', requireAuth, async (req, res) => {
    const { summary, description, category, gameId, gameTitle } = req.body || {};
    const title = (summary || '').trim();
    const details = (description || '').trim();
    if (!title || title.length < 3) return res.status(400).json({ error: 'Summary is required' });
    if (title.length > 160) return res.status(400).json({ error: 'Summary too long' });
    if (!details || details.length < 10) return res.status(400).json({ error: 'Description is required' });
    if (details.length > 2000) return res.status(400).json({ error: 'Description too long' });

    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const reports = await loadReports();
    const now = new Date().toISOString();
    const report = {
        id: crypto.randomUUID(),
        userId: me.id,
        username: me.username,
        summary: title,
        description: details,
        category: (category || 'general').toString().slice(0, 40),
        gameId: gameId ? String(gameId) : null,
        gameTitle: gameTitle ? String(gameTitle).slice(0, 180) : null,
        status: 'open',
        createdAt: now,
        updatedAt: now
    };
    reports.push(report);
    await saveReports(reports);
    res.status(201).json({ report });
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
    const reports = await loadReports();
    res.json({ reports });
});

app.put('/api/admin/reports/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (!['open', 'resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const reports = await loadReports();
    const report = reports.find((r) => r.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    report.status = status;
    report.updatedAt = new Date().toISOString();
    await saveReports(reports);
    res.json({ report });
});

app.delete('/api/admin/reports/:id', requireAdmin, async (req, res) => {
    const reports = await loadReports();
    const idx = reports.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Report not found' });
    reports.splice(idx, 1);
    await saveReports(reports);
    res.json({ success: true });
});

// --- Admin: Games
function isImageDataUrl(str) {
    return typeof str === 'string' && str.startsWith('data:image/') && str.length < 2_500_000;
}

function validateGamePayload(body, { partial = false } = {}) {
    const { title, category, embed, thumbnail, thumbnailData, description, disabled, disabledMessage } = body || {};
    const out = {};
    if (!partial || title !== undefined) {
        if (!title || String(title).trim().length < 2) throw new Error('Title required');
        if (String(title).length > 160) throw new Error('Title too long');
        out.title = String(title).trim();
    }
    if (!partial || category !== undefined) {
        out.category = category ? String(category).trim() : '';
    }
    if (!partial || embed !== undefined) {
        if (!embed) throw new Error('Embed URL required');
        try { new URL(embed); } catch (_) { throw new Error('Invalid embed URL'); }
        out.embed = embed;
    }
    if (thumbnailData !== undefined) {
        if (thumbnailData && !isImageDataUrl(thumbnailData)) throw new Error('Invalid thumbnail upload');
        if (thumbnailData) out.thumbnail = thumbnailData;
    } else if (thumbnail !== undefined) {
        if (thumbnail) {
            try { new URL(thumbnail); } catch (_) { throw new Error('Invalid thumbnail URL'); }
            out.thumbnail = thumbnail;
        } else {
            out.thumbnail = '';
        }
    }
    if (description !== undefined) {
        if (String(description).length > 1200) throw new Error('Description too long');
        out.description = description || '';
    }
    if (disabled !== undefined) out.disabled = !!disabled;
    if (disabledMessage !== undefined) out.disabledMessage = String(disabledMessage || '').slice(0, 200);
    return out;
}

function nextGameId(games) {
    const maxId = games.reduce((m, g) => Math.max(m, Number(g.id) || 0), 0);
    return maxId + 1;
}

app.get('/api/admin/games', requireAdmin, async (req, res) => {
    const games = await loadGames();
    res.json({ games });
});

app.post('/api/admin/games', requireAdmin, async (req, res) => {
    try {
        const games = await loadGames();
        const game = validateGamePayload(req.body || {});
        game.id = nextGameId(games);
        games.push(game);
        await saveGames(games);
        res.status(201).json({ game });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid game' });
    }
});

app.put('/api/admin/games/:id', requireAdmin, async (req, res) => {
    const games = await loadGames();
    const game = games.find(g => String(g.id) === String(req.params.id));
    if (!game) return res.status(404).json({ error: 'Game not found' });
    try {
        Object.assign(game, validateGamePayload(req.body || {}, { partial: true }));
        await saveGames(games);
        res.json({ game });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid game' });
    }
});

app.put('/api/admin/games/:id/disable', requireAdmin, async (req, res) => {
    const { disabled = true, message = '' } = req.body || {};
    const games = await loadGames();
    const game = games.find(g => String(g.id) === String(req.params.id));
    if (!game) return res.status(404).json({ error: 'Game not found' });
    game.disabled = !!disabled;
    game.disabledMessage = String(message || '').slice(0, 200);
    await saveGames(games);
    res.json({ game });
});

app.delete('/api/admin/games/:id', requireAdmin, async (req, res) => {
    const games = await loadGames();
    const idx = games.findIndex(g => String(g.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Game not found' });
    games.splice(idx, 1);
    await saveGames(games);
    res.json({ success: true });
});

// --- Admin: Users
function validateUsername(username) {
    if (!username || username.length < 3 || username.length > 24) throw new Error('Username must be 3-24 characters');
    return username;
}

function validatePassword(password) {
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
    return password;
}

function validateEmail(email) {
    if (!email) throw new Error('Email is required');
    const normalized = String(email).trim().toLowerCase();
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!re.test(normalized)) throw new Error('Invalid email');
    return normalized;
}

function getClientIp(req) {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.ip || req.connection?.remoteAddress || 'unknown';
}

function recordLoginIp(user, ip) {
    if (!ip || !user) return;
    const history = Array.isArray(user.loginHistory) ? user.loginHistory.slice() : [];
    const existing = history.find((h) => h.ip === ip);
    const now = new Date().toISOString();
    if (existing) {
        existing.count = (existing.count || 0) + 1;
        existing.lastAt = now;
    } else {
        history.unshift({ ip, count: 1, lastAt: now });
    }
    history.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
    user.loginHistory = history.slice(0, 10);
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const users = await loadUsers();
    res.json({ users: users.map(u => sanitizeUser(u)) });
});

app.get('/api/admin/users/:id/relations', requireAdmin, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.params.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    ensureFriendStruct(me);
    const now = Date.now();
    const friends = resolveFriendList(users, me.friends.accepted || [], now);
    const incoming = resolveFriendList(users, me.friends.incoming || [], now);
    const outgoing = resolveFriendList(users, me.friends.outgoing || [], now);
    const blocked = resolveFriendList(users, me.friends.blocked || [], now);
    res.json({ friends, incoming, outgoing, blocked });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { username, password, admin = false, email } = req.body || {};
    try {
        validateUsername(username);
        validatePassword(password);
        const normalizedEmail = validateEmail(email);
        const users = await loadUsers();
        const clash = await getUserByUsername(users, username);
        if (clash) return res.status(409).json({ error: 'Username already exists' });
        const emailClash = await getUserByEmail(users, normalizedEmail);
        if (emailClash) return res.status(409).json({ error: 'Email already exists' });
        const hash = await bcrypt.hash(password, 10);
        const now = new Date().toISOString();
        const user = {
            id: crypto.randomUUID(),
            username,
            email: normalizedEmail,
            passwordHash: hash,
            favorites: [],
            profile: { username, accentColor: '#58a6ff', avatar: null, lastPlayed: [], playtime: {} },
            settings: defaultSettingsFromConfig(await loadConfig()),
            friends: { accepted: [], incoming: [], outgoing: [], blocked: [] },
            presence: { online: false, gameId: null, lastSeen: now },
            loginHistory: [],
            banned: { active: false },
            createdAt: now,
            updatedAt: now,
            admin: !!admin
        };
        users.push(user);
        recordAccountEvent('signups');
        await saveUsers(users);
        res.status(201).json({ user: sanitizeUser(user) });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid user' });
    }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { username, password, admin, email } = req.body || {};
    const users = await loadUsers();
    const user = await getUserById(users, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
        if (username !== undefined) {
            validateUsername(username);
            const clash = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== user.id);
            if (clash) return res.status(409).json({ error: 'Username already exists' });
            user.username = username;
            user.profile = user.profile || {};
            user.profile.username = username;
        }
        if (email !== undefined) {
            const normalizedEmail = validateEmail(email);
            const clashEmail = users.find(u => (u.email || '').toLowerCase() === normalizedEmail && u.id !== user.id);
            if (clashEmail) return res.status(409).json({ error: 'Email already exists' });
            user.email = normalizedEmail;
        }
        if (password !== undefined) {
            validatePassword(password);
            user.passwordHash = await bcrypt.hash(password, 10);
        }
        if (admin !== undefined) {
            const isSelf = req.user?.id === user.id;
            if (isSelf && !admin && user.admin) {
                return res.status(400).json({ error: 'You cannot remove your own admin access' });
            }
            user.admin = !!admin;
        }
        user.updatedAt = new Date().toISOString();
        await saveUsers(users);
        res.json({ user: sanitizeUser(user) });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid update' });
    }
});

app.put('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
    const { active = true, reason = '' } = req.body || {};
    const users = await loadUsers();
    const user = await getUserById(users, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.banned = {
        active: !!active,
        reason: String(reason || '').slice(0, 240),
        at: new Date().toISOString()
    };
    if (!active) user.presence = { online: false, gameId: null, lastSeen: new Date().toISOString() };
    if (active) recordAccountEvent('bans'); else recordAccountEvent('unbans');
    await saveUsers(users);
    res.json({ user: sanitizeUser(user) });
});

app.get('/api/admin/users/:id/logins', requireAdmin, async (req, res) => {
    const users = await loadUsers();
    const user = await getUserById(users, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ loginHistory: user.loginHistory || [] });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const users = await loadUsers();
    if (req.user?.id === req.params.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users.splice(idx, 1);
    recordAccountEvent('deletions');
    await saveUsers(users);
    res.json({ success: true });
});

app.get('/api/admin/defaults', requireAdmin, async (req, res) => {
    const config = await loadConfig();
    res.json({ defaults: defaultSettingsFromConfig(config), presets: normalizePresets(config) });
});

app.put('/api/admin/defaults', requireAdmin, async (req, res) => {
    try {
        const { defaults: defaultsInput = {}, presets: presetsInput = {} } = req.body || {};
        const config = await loadConfig();
        const mergedDefaults = { ...(config.defaults || {}) };
        const validated = validateSettings(defaultsInput);

        const particles = mergedDefaults.particles || {};
        const cursor = mergedDefaults.cursor || {};
        const panic = mergedDefaults.panicButton || mergedDefaults.panic || {};
        const disguise = mergedDefaults.tabDisguise || {};

        if (validated.accentColor !== undefined) mergedDefaults.accentColor = validated.accentColor;
        if (validated.proxyDefault !== undefined) mergedDefaults.proxyDefault = validated.proxyDefault;

        if (
            validated.particlesEnabled !== undefined || validated.particleCount !== undefined ||
            validated.particleSpeed !== undefined || validated.particleColor !== undefined ||
            validated.particleLineDistance !== undefined || validated.particleMouseInteraction !== undefined
        ) {
            mergedDefaults.particles = {
                ...particles,
                enabled: validated.particlesEnabled ?? particles.enabled,
                count: validated.particleCount ?? particles.count,
                speed: validated.particleSpeed ?? particles.speed,
                color: validated.particleColor ?? particles.color,
                lineDistance: validated.particleLineDistance ?? particles.lineDistance,
                mouse: validated.particleMouseInteraction ?? particles.mouse
            };
        }

        if (
            validated.cursorEnabled !== undefined || validated.cursorSize !== undefined ||
            validated.cursorColor !== undefined || validated.cursorType !== undefined
        ) {
            mergedDefaults.cursor = {
                ...cursor,
                enabled: validated.cursorEnabled ?? cursor.enabled,
                size: validated.cursorSize ?? cursor.size,
                color: validated.cursorColor ?? cursor.color,
                type: validated.cursorType ?? cursor.type
            };
        }

        if (
            validated.panicEnabled !== undefined || validated.panicUrl !== undefined ||
            validated.panicKeybind !== undefined || validated.panicPreset !== undefined
        ) {
            mergedDefaults.panicButton = {
                ...panic,
                enabled: validated.panicEnabled ?? panic.enabled,
                url: validated.panicUrl ?? panic.url,
                keybind: validated.panicKeybind ?? panic.keybind,
                preset: validated.panicPreset ?? panic.preset
            };
        }

        if (
            validated.tabDisguiseEnabled !== undefined || validated.tabDisguiseTitle !== undefined ||
            validated.tabDisguiseFavicon !== undefined || validated.tabDisguiseSource !== undefined ||
            validated.tabDisguisePreset !== undefined
        ) {
            mergedDefaults.tabDisguise = {
                ...disguise,
                enabled: validated.tabDisguiseEnabled ?? disguise.enabled,
                title: validated.tabDisguiseTitle ?? disguise.title,
                favicon: validated.tabDisguiseFavicon ?? disguise.favicon,
                sourceUrl: validated.tabDisguiseSource ?? disguise.sourceUrl,
                preset: validated.tabDisguisePreset ?? disguise.preset
            };
        }

        if (validated.showClock !== undefined) mergedDefaults.showClock = validated.showClock;
        if (validated.showCurrent !== undefined) mergedDefaults.showCurrent = validated.showCurrent;

        const currentPresets = normalizePresets(config);
        const panicButtons = Array.isArray(presetsInput.panicButtons)
            ? presetsInput.panicButtons.slice(0, 25).map((p, idx) => sanitizePanicPreset(p, p.id || `panic-${idx}`))
            : currentPresets.panicButtons;
        const tabDisguises = Array.isArray(presetsInput.tabDisguises)
            ? presetsInput.tabDisguises.slice(0, 25).map((p, idx) => sanitizeTabPreset(p, p.id || `disguise-${idx}`))
            : currentPresets.tabDisguises;

        mergedDefaults.presets = { panicButtons, tabDisguises };

        const nextConfig = { ...config, defaults: mergedDefaults };
        await saveConfig(nextConfig);
        res.json({ defaults: defaultSettingsFromConfig(nextConfig), presets: normalizePresets(nextConfig) });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to update defaults' });
    }
});

app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 288, ANALYTICS_RETENTION_MINUTES));
    const [config, users, players, games] = await Promise.all([
        loadConfig(),
        loadUsers(),
        loadAnalyticsFile(ANALYTICS_PLAYERS_FILE),
        loadAnalyticsFile(ANALYTICS_GAMES_FILE)
    ]);
    const enabled = config?.features?.analyticsEnabled !== false;
    if (!enabled) return res.json({ enabled: false });

    const sliceEntries = (data) => (Array.isArray(data?.entries) ? data.entries.slice(-limit) : []);
    const playersEntries = sliceEntries(players);
    const latestPlayers = playersEntries.length ? playersEntries[playersEntries.length - 1] : null;
    res.json({
        enabled,
        retentionMinutes: ANALYTICS_RETENTION_MINUTES,
        players: playersEntries,
        games: sliceEntries(games),
        summary: {
            onlinePlayers: Number(latestPlayers?.players) || 0,
            totalAccounts: Array.isArray(users) ? users.length : 0,
            systemStatus: config?.maintenanceMode?.enabled ? 'Maintenance' : 'Operational'
        }
    });
});

app.get('/api/config', async (req, res) => {
    const config = await loadConfig();
    res.json(config);
});

app.get('/api/games', async (req, res) => {
    const { q, category } = req.query;
    const games = await loadGames();
    let filtered = games;
    if (q) {
        const term = q.toLowerCase();
        filtered = filtered.filter(g =>
            g.title.toLowerCase().includes(term) ||
            (g.description && g.description.toLowerCase().includes(term))
        );
    }
    if (category && category !== 'all') {
        filtered = filtered.filter(g => (g.category || '').toLowerCase() === category.toLowerCase());
    }
    res.json(filtered);
});

app.get('/api/games/:id', async (req, res) => {
    const games = await loadGames();
    const game = games.find(g => String(g.id) === String(req.params.id));
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
});

app.get('/api/stats', async (req, res) => {
    const games = await loadGames();
    const categories = Array.from(new Set(games.map(g => g.category))).filter(Boolean);
    const gamesByCategory = categories.reduce((acc, cat) => {
        acc[cat] = games.filter(g => g.category === cat).length;
        return acc;
    }, {});
    res.json({
        totalGames: games.length,
        categories,
        categoryCount: categories.length,
        gamesByCategory,
        serverVersion: APP_VERSION
    });
});

// --- Auth endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email } = req.body || {};
        validateUsername(username);
        validatePassword(password);
        const normalizedEmail = validateEmail(email);

        const users = await loadUsers();
        const config = await loadConfig();
        const defaultSettings = defaultSettingsFromConfig(config);
        const existing = await getUserByUsername(users, username);
        if (existing) return res.status(409).json({ error: 'Username already exists' });
        const emailClash = await getUserByEmail(users, normalizedEmail);
        if (emailClash) return res.status(409).json({ error: 'Email already in use' });

        const passwordHash = await bcrypt.hash(password, 10);
        const now = new Date().toISOString();
        const user = {
            id: crypto.randomUUID(),
            username,
            email: normalizedEmail,
            passwordHash,
            favorites: [],
            profile: {
                username,
                accentColor: config.defaults?.accentColor || '#58a6ff',
                avatar: null,
                lastPlayed: [],
                playtime: {}
            },
            settings: defaultSettings,
            friends: { accepted: [], incoming: [], outgoing: [], blocked: [] },
            presence: { online: true, gameId: null, lastSeen: now },
            loginHistory: [],
            banned: { active: false },
            createdAt: now,
            updatedAt: now,
            admin: false
        };
        recordLoginIp(user, getClientIp(req));
        users.push(user);
        recordAccountEvent('signups');
        await saveUsers(users);

        const { session, sessionToken } = await createSession(user, {
            ip: getClientIp(req),
            userAgent: req.headers['user-agent']
        });
        setSessionCookie(res, session.id, sessionToken);
        res.status(201).json({ user: sanitizeUser(user) });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid registration' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password, email, identifier } = req.body || {};
    const loginId = identifier || username || email;
    if (!loginId || !password) return res.status(400).json({ error: 'Username/email and password are required' });

    const users = await loadUsers();
    let user = null;
    const looksEmail = loginId.includes('@');
    if (looksEmail) user = await getUserByEmail(users, loginId);
    if (!user) user = await getUserByUsername(users, loginId);
    if (!user && !looksEmail) user = await getUserByEmail(users, loginId); // fall back if user typed email but without '@'
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned?.active) {
        return res.status(403).json({
            error: 'Account is banned',
            banned: true,
            reason: user.banned.reason || 'Your account is banned'
        });
    }

    recordLoginIp(user, getClientIp(req));
    setPresence(user, { online: true });
    user.updatedAt = new Date().toISOString();
    await saveUsers(users);
    const { session, sessionToken } = await createSession(user, {
        ip: getClientIp(req),
        userAgent: req.headers['user-agent']
    });
    setSessionCookie(res, session.id, sessionToken);
    const payload = { user: sanitizeUser(user) };
    if (user.banned?.active) {
        payload.banned = true;
        payload.reason = user.banned?.reason || 'Your account is banned';
    }
    res.json(payload);
});

app.post('/api/auth/logout', async (req, res) => {
    clearAuthCookies(res);
    try {
        const sessions = await loadSessions();
        const parsed = parseSessionCookie(req);
        let userId = null;
        if (parsed) {
            const session = sessions.find((s) => s.id === parsed.sessionId);
            if (session && session.sessionHash === hashToken(parsed.token)) {
                userId = session.userId;
                session.revokedAt = new Date().toISOString();
            }
            await persistSessions(sessions);
        }

        if (userId) {
            const users = await loadUsers();
            const me = await getUserById(users, userId);
            if (me) {
                setPresence(me, { online: false, gameId: null });
                me.updatedAt = new Date().toISOString();
                await saveUsers(users);
            }
        }
    } catch (_) {}

    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    setPresence(me, { online: true });
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    res.json({ user: sanitizeUser(me) });
});

// --- Profile
app.put('/api/profile', requireAuth, async (req, res) => {
    const { username, accentColor, avatar } = req.body || {};
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });

    if (username) {
        if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3-24 characters' });
        const clash = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== me.id);
        if (clash) return res.status(409).json({ error: 'Username already taken' });
        me.username = username;
        me.profile.username = username;
    }
    if (accentColor) {
        if (!colorIsValid(accentColor)) return res.status(400).json({ error: 'Invalid accent color' });
        me.profile.accentColor = accentColor;
    }
    if (avatar !== undefined) {
        if (avatar && avatar.length > 2_000_000) return res.status(400).json({ error: 'Avatar too large' });
        me.profile.avatar = avatar || null;
    }
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    await replaceSessionForUser(me, req, res);
    res.json({ user: sanitizeUser(me) });
});

app.put('/api/profile/email', requireAuth, async (req, res) => {
    const { newEmail, currentPassword } = req.body || {};
    if (!newEmail || !currentPassword) return res.status(400).json({ error: 'Email and current password are required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const normalized = validateEmail(newEmail);
    const clash = await getUserByEmail(users, normalized);
    if (clash && clash.id !== me.id) return res.status(409).json({ error: 'Email already in use' });
    const ok = await bcrypt.compare(currentPassword, me.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    me.email = normalized;
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    await replaceSessionForUser(me, req, res);
    res.json({ user: sanitizeUser(me) });
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, me.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid password' });
    validatePassword(newPassword);
    me.passwordHash = await bcrypt.hash(newPassword, 10);
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    await replaceSessionForUser(me, req, res);
    res.json({ success: true });
});

app.delete('/api/profile', requireAuth, async (req, res) => {
    const { currentPassword } = req.body || {};
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    if (!me.banned?.active || currentPassword) {
        if (!currentPassword) return res.status(400).json({ error: 'Password required to delete account' });
        const ok = await bcrypt.compare(currentPassword, me.passwordHash || '');
        if (!ok) return res.status(401).json({ error: 'Invalid password' });
    }
    const remaining = users.filter((u) => u.id !== me.id);
    // remove from friends lists
    remaining.forEach((u) => {
        if (u.friends?.accepted) u.friends.accepted = u.friends.accepted.filter((id) => id !== me.id);
        if (u.friends?.incoming) u.friends.incoming = u.friends.incoming.filter((id) => id !== me.id);
        if (u.friends?.outgoing) u.friends.outgoing = u.friends.outgoing.filter((id) => id !== me.id);
        if (u.friends?.blocked) u.friends.blocked = u.friends.blocked.filter((id) => id !== me.id);
    });
    recordAccountEvent('deletions');
    await saveUsers(remaining);
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
});

// --- Settings
function validateSettings(input) {
    const out = {};
    if (input.proxyDefault !== undefined) out.proxyDefault = !!input.proxyDefault;
    if (input.accentColor !== undefined) {
        if (!colorIsValid(input.accentColor)) throw new Error('Invalid accent color');
        out.accentColor = input.accentColor;
    }
    if (input.particlesEnabled !== undefined) out.particlesEnabled = !!input.particlesEnabled;
    if (input.particleCount !== undefined) {
        const n = Number(input.particleCount);
        if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error('Invalid particle count');
        out.particleCount = Math.round(n);
    }
    if (input.particleSpeed !== undefined) {
        const n = Number(input.particleSpeed);
        if (!Number.isFinite(n) || n < 0 || n > 3) throw new Error('Invalid particle speed');
        out.particleSpeed = n;
    }
    if (input.particleColor !== undefined) {
        if (!colorIsValid(input.particleColor)) throw new Error('Invalid particle color');
        out.particleColor = input.particleColor;
    }
    if (input.particleLineDistance !== undefined) {
        const n = Number(input.particleLineDistance);
        if (!Number.isFinite(n) || n < 10 || n > 600) throw new Error('Invalid line distance');
        out.particleLineDistance = Math.round(n);
    }
    if (input.particleMouseInteraction !== undefined) out.particleMouseInteraction = !!input.particleMouseInteraction;
    if (input.cursorEnabled !== undefined) out.cursorEnabled = !!input.cursorEnabled;
    if (input.cursorSize !== undefined) {
        const n = Number(input.cursorSize);
        if (!Number.isFinite(n) || n < 4 || n > 48) throw new Error('Invalid cursor size');
        out.cursorSize = Math.round(n);
    }
    if (input.cursorColor !== undefined) {
        if (!colorIsValid(input.cursorColor)) throw new Error('Invalid cursor color');
        out.cursorColor = input.cursorColor;
    }
    if (input.cursorType !== undefined) {
        const allowed = ['circle', 'dot', 'none', 'custom'];
        if (!allowed.includes(input.cursorType)) throw new Error('Invalid cursor type');
        out.cursorType = input.cursorType;
    }
    if (input.showClock !== undefined) out.showClock = !!input.showClock;
    if (input.showCurrent !== undefined) out.showCurrent = !!input.showCurrent;
    if (input.panicEnabled !== undefined) out.panicEnabled = !!input.panicEnabled;
    if (input.panicUrl !== undefined) {
        if (input.panicUrl && !isHttpUrl(input.panicUrl)) throw new Error('Invalid panic URL');
        out.panicUrl = input.panicUrl || '';
    }
    if (input.panicKeybind !== undefined) {
        out.panicKeybind = String(input.panicKeybind || '').slice(0, 80);
    }
    if (input.panicPreset !== undefined) {
        out.panicPreset = String(input.panicPreset || '');
    }
    if (input.tabDisguiseEnabled !== undefined) out.tabDisguiseEnabled = !!input.tabDisguiseEnabled;
    if (input.tabDisguiseTitle !== undefined) {
        out.tabDisguiseTitle = String(input.tabDisguiseTitle || '').slice(0, 120);
    }
    if (input.tabDisguiseFavicon !== undefined) {
        if (input.tabDisguiseFavicon && !isIconUrl(input.tabDisguiseFavicon)) throw new Error('Invalid tab favicon');
        out.tabDisguiseFavicon = input.tabDisguiseFavicon || '';
    }
    if (input.tabDisguiseSource !== undefined) {
        if (input.tabDisguiseSource && !isHttpUrl(input.tabDisguiseSource)) throw new Error('Invalid tab source URL');
        out.tabDisguiseSource = input.tabDisguiseSource || '';
    }
    if (input.tabDisguisePreset !== undefined) {
        out.tabDisguisePreset = String(input.tabDisguisePreset || '');
    }
    return out;
}

app.get('/api/settings', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const config = await loadConfig();
    const defaults = defaultSettingsFromConfig(config);
    const presets = normalizePresets(config);
    res.json({ settings: { ...defaults, ...(me.settings || {}) }, defaults, presets });
});

app.put('/api/settings', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    try {
        const update = validateSettings(req.body || {});
        me.settings = { ...(me.settings || defaultSettingsFromConfig(await loadConfig())), ...update };
        me.updatedAt = new Date().toISOString();
        await saveUsers(users);
        res.json({ settings: me.settings });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid settings' });
    }
});

app.post('/api/utils/page-meta', requireAuth, async (req, res) => {
    const { url } = req.body || {};
    if (!isHttpUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
        const { response: resp, url: base } = await fetchPublicUrl(url, { signal: controller.signal });
        if (!resp.ok) return res.status(400).json({ error: 'Unable to fetch page metadata' });
        const contentType = resp.headers.get('content-type') || '';
        if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
            return res.status(400).json({ error: 'URL did not return an HTML page' });
        }
        const html = await readResponseText(resp, MAX_META_BYTES);
        const meta = extractMetaFromHtml(html, base);
        res.json({ title: meta.title, favicon: meta.favicon });
    } catch (err) {
        res.status(400).json({ error: 'Unable to fetch page metadata' });
    } finally {
        clearTimeout(timer);
    }
});

// --- Favorites
app.get('/api/favorites', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    res.json({ favorites: me.favorites || [] });
});

app.post('/api/favorites/toggle', requireAuth, async (req, res) => {
    const { gameId } = req.body || {};
    if (!gameId) return res.status(400).json({ error: 'gameId is required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const id = String(gameId);
    const has = (me.favorites || []).includes(id);
    me.favorites = has ? me.favorites.filter(g => g !== id) : [...(me.favorites || []), id];
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    res.json({ favorites: me.favorites });
});

// --- Friends
function resolveFriendList(users, ids = [], now = Date.now()) {
    return ids
        .map(id => users.find(u => u.id === id))
        .filter(Boolean)
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.profile?.avatar,
            accentColor: u.profile?.accentColor,
            presence: {
                online: isUserOnline(u, now),
                gameId: u.presence?.gameId || null,
                lastSeen: u.presence?.lastSeen || null
            }
        }));
}

function ensureFriendStruct(user) {
    user.friends = user.friends || { accepted: [], incoming: [], outgoing: [], blocked: [] };
    user.friends.accepted = user.friends.accepted || [];
    user.friends.incoming = user.friends.incoming || [];
    user.friends.outgoing = user.friends.outgoing || [];
    user.friends.blocked = user.friends.blocked || [];
}

app.get('/api/friends', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = req.me || await getUserById(users, req.user.id);
    if (!me) {
        res.clearCookie(COOKIE_NAME);
        res.clearCookie(LEGACY_SESSION_COOKIE);
        return res.status(401).json({ error: 'Session expired' });
    }
    ensureFriendStruct(me);
    ensurePresence(me);
    const now = Date.now();
    const friends = resolveFriendList(users, me.friends?.accepted || [], now);
    const incoming = resolveFriendList(users, me.friends?.incoming || [], now);
    const outgoing = resolveFriendList(users, me.friends?.outgoing || [], now);
    const blocked = resolveFriendList(users, me.friends?.blocked || [], now);
    res.json({ friends, incomingRequests: incoming, outgoingRequests: outgoing, blocked });
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const target = await getUserByUsername(users, username);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === me.id) return res.status(400).json({ error: 'Cannot add yourself' });

    ensureFriendStruct(me);
    ensureFriendStruct(target);

    if (me.friends.blocked.includes(target.id) || target.friends.blocked.includes(me.id)) {
        return res.status(403).json({ error: 'User is blocked' });
    }

    if (me.friends.accepted.includes(target.id)) return res.status(409).json({ error: 'Already friends' });
    if (me.friends.outgoing.includes(target.id)) return res.status(409).json({ error: 'Request already sent' });
    if (me.friends.incoming.includes(target.id)) return res.status(409).json({ error: 'They already sent you a request' });

    me.friends.outgoing.push(target.id);
    target.friends.incoming.push(me.id);
    me.updatedAt = target.updatedAt = new Date().toISOString();
    recordFriendEvent('sent');
    await saveUsers(users);
    res.json({ success: true });
});

app.post('/api/friends/respond', requireAuth, async (req, res) => {
    const { username, accept, action } = req.body || {};
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const other = await getUserByUsername(users, username);
    if (!other) return res.status(404).json({ error: 'User not found' });

    ensureFriendStruct(me);
    ensureFriendStruct(other);

    // Must have an incoming request from other
    if (!me.friends.incoming.includes(other.id)) {
        return res.status(404).json({ error: 'No incoming request from this user' });
    }

    // Normalize accept/decline signal to support legacy boolean and current action string
    let shouldAccept = accept;
    if (shouldAccept === undefined) {
        if (action === 'accept') shouldAccept = true;
        else if (action === 'decline' || action === 'reject') shouldAccept = false;
    }
    if (shouldAccept === undefined) {
        return res.status(400).json({ error: 'Action is required' });
    }

    // Remove pending request entries
    me.friends.incoming = me.friends.incoming.filter((id) => id !== other.id);
    other.friends.outgoing = other.friends.outgoing.filter((id) => id !== me.id);

    if (shouldAccept) {
        if (!me.friends.accepted.includes(other.id)) me.friends.accepted.push(other.id);
        if (!other.friends.accepted.includes(me.id)) other.friends.accepted.push(me.id);
        recordFriendEvent('accepted');
    } else {
        recordFriendEvent('rejected');
    }

    me.updatedAt = other.updatedAt = new Date().toISOString();
    await saveUsers(users);
    res.json({ success: true, status: shouldAccept ? 'accepted' : 'rejected' });
});

app.post('/api/friends/block', requireAuth, async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const other = await getUserByUsername(users, username);
    if (!other) return res.status(404).json({ error: 'User not found' });

    ensureFriendStruct(me);
    ensureFriendStruct(other);

    if (!me.friends.blocked.includes(other.id)) me.friends.blocked.push(other.id);
    me.friends.accepted = me.friends.accepted.filter(id => id !== other.id);
    me.friends.incoming = me.friends.incoming.filter(id => id !== other.id);
    me.friends.outgoing = me.friends.outgoing.filter(id => id !== other.id);

    other.friends.accepted = other.friends.accepted.filter(id => id !== me.id);
    other.friends.incoming = other.friends.incoming.filter(id => id !== me.id);
    other.friends.outgoing = other.friends.outgoing.filter(id => id !== me.id);

    me.updatedAt = other.updatedAt = new Date().toISOString();
    await saveUsers(users);
    res.json({ success: true });
});

app.post('/api/friends/unblock', requireAuth, async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const other = await getUserByUsername(users, username);
    if (!other) return res.status(404).json({ error: 'User not found' });
    ensureFriendStruct(me);
    me.friends.blocked = me.friends.blocked.filter(id => id !== other.id);
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    res.json({ success: true });
});

// --- Heartbeat (online tracking for authenticated and guest users)
app.post('/api/online/ping', async (req, res) => {
    const { online = true, gameId } = req.body || {};
    const now = Date.now();
    pruneGuestHeartbeats(now);

    const refreshed = await refreshSessionFromCookie(req, res);
    let users = null;
    let me = null;

    if (refreshed?.user?.id) {
        users = await loadUsers();
        me = await getUserById(users, refreshed.user.id);
    }

    if (me) {
        const nextGameId = gameId === undefined ? (me.presence?.gameId || null) : gameId;
        setPresence(me, { online: online !== false, gameId: nextGameId });
        if (nextGameId) updateLastPlayed(me, nextGameId);
        me.updatedAt = new Date().toISOString();
        await saveUsers(users);
        const existingGuest = req.cookies[GUEST_COOKIE] || req.cookies[LEGACY_GUEST_COOKIE];
        if (existingGuest) guestHeartbeats.delete(existingGuest);
    } else {
        let guestId = req.cookies[GUEST_COOKIE] || req.cookies[LEGACY_GUEST_COOKIE] || crypto.randomUUID();
        if (online === false) {
            guestHeartbeats.delete(guestId);
        } else {
            guestHeartbeats.set(guestId, now);
        }
        res.cookie(GUEST_COOKIE, guestId, {
            httpOnly: false,
            secure: false,
            sameSite: 'lax',
            maxAge: 1000 * 60 * 60 * 24 * 7
        });
        res.clearCookie(LEGACY_GUEST_COOKIE);
    }

    const onlineGuests = guestOnlineCount(now);
    const onlineUsers = users ? users.filter(u => isUserOnline(u, now)).length : null;
    res.json({
        ok: true,
        onlineGuests,
        onlineUsers,
        lastPlayed: me?.profile?.lastPlayed || [],
        playtime: normalizePlaytime(me?.profile?.playtime)
    });
});

app.post('/api/playtime', requireAuth, async (req, res) => {
    const { gameId, deltaMs } = req.body || {};
    if (!gameId) return res.status(400).json({ error: 'gameId is required' });
    const delta = Number(deltaMs);
    if (!Number.isFinite(delta) || delta <= 0) return res.status(400).json({ error: 'deltaMs must be positive' });

    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });

    addPlaytime(me, gameId, delta);
    updateLastPlayed(me, gameId);
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);

    res.json({ playtime: normalizePlaytime(me.profile.playtime), lastPlayed: me.profile.lastPlayed });
});

// --- Presence
app.get('/api/presence', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    ensurePresence(me);
    const now = Date.now();
    res.json({ presence: { ...me.presence, online: isUserOnline(me, now) } });
});

app.put('/api/presence', requireAuth, async (req, res) => {
    const { online, gameId } = req.body || {};
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    if (gameId !== undefined && gameId !== null && String(gameId).length > 128) {
        return res.status(400).json({ error: 'Invalid gameId' });
    }
    setPresence(me, { online, gameId: gameId === undefined ? me.presence?.gameId || null : gameId });
    me.updatedAt = new Date().toISOString();
    await saveUsers(users);
    res.json({ presence: me.presence });
});

app.get('/api/presence/friends', requireAuth, async (req, res) => {
    const users = await loadUsers();
    const me = await getUserById(users, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    ensureFriendStruct(me);
    const friends = resolveFriendList(users, me.friends?.accepted || [], Date.now());
    res.json({ friends });
});

// --- Proxy
const BLOCKED_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security'];
const PROXY_RESPONSE_HEADERS = new Set(['accept-ranges', 'content-disposition', 'content-length', 'content-type', 'etag', 'last-modified']);

app.get('/proxy', async (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: 'url query parameter is required' });
    let parsed;
    try {
        parsed = new URL(target);
    } catch (err) {
        return res.status(400).json({ error: 'Invalid URL' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only http/https allowed' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const { response: upstream } = await fetchPublicUrl(parsed.toString(), {
            method: 'GET',
            signal: controller.signal
        });
        const contentLength = Number(upstream.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BYTES) {
            return res.status(413).json({ error: 'Proxy response is too large' });
        }
        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
            if (BLOCKED_HEADERS.includes(key.toLowerCase()) || !PROXY_RESPONSE_HEADERS.has(key.toLowerCase())) return;
            res.setHeader(key, value);
        });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', '*');
        res.setHeader('Cache-Control', 'no-store');

        if (!upstream.body) return res.end();
        let received = 0;
        const source = Readable.fromWeb(upstream.body);
        source.on('data', (chunk) => {
            received += chunk.length;
            if (received > MAX_PROXY_BYTES) source.destroy(new Error('Proxy response is too large'));
        });
        source.on('error', (err) => {
            if (!res.headersSent) return res.status(502).json({ error: err.message });
            res.destroy(err);
        });
        source.pipe(res);
    } catch (err) {
        const status = err.name === 'AbortError' ? 504 : 500;
        res.status(status).json({ error: 'Proxy fetch failed', detail: err.message });
    } finally {
        clearTimeout(timeout);
    }
});

// --- SEO sitemap
app.get('/sitemap.xml', async (req, res) => {
    try {
        const games = await loadGames();
        const base = resolveBaseUrl(req);
        const xml = await generateSitemapXml(games, base);
        res.type('application/xml').send(xml);
        regenerateSitemap(games, base).catch((err) => console.error('Failed to persist sitemap', err));
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate sitemap' });
    }
});

regenerateSitemap().catch((err) => console.error('Failed to generate initial sitemap', err));

// --- Static assets
app.use('/images', express.static(IMAGES_DIR, { maxAge: '1d', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }));

// --- Static frontend
app.use(express.static(path.join(FRONTEND_DIR, 'public'), { extensions: ['html'] }));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ bbgamez backend running on http://localhost:${PORT}`);
});
