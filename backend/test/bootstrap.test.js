const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ensureDefaultAdminUser, getRequestOrigin, ensureConfigAllowedOrigin } = require('../bootstrap');

test('ensureDefaultAdminUser creates admin when there are no users', async () => {
  const dir = path.join(__dirname, 'tmp-empty-users');
  const usersPath = path.join(dir, 'users.json');
  const configPath = path.join(dir, 'config.yml');

  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(usersPath, JSON.stringify({ users: [] }, null, 2));
  fs.writeFileSync(configPath, 'cors:\n  allowedOrigins: []\n');

  const result = await ensureDefaultAdminUser({ usersPath, configPath, username: 'admin', password: 'password' });
  assert.equal(result.username, 'admin');
  assert.equal(result.admin, true);
  const saved = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  assert.equal(saved.users.length, 1);
  assert.equal(saved.users[0].username, 'admin');
});

test('getRequestOrigin resolves forwarded host and scheme', () => {
  const req = {
    get(header) {
      if (header === 'x-forwarded-proto') return 'https';
      if (header === 'x-forwarded-host') return 'example.herokuapp.com';
      return '';
    },
    protocol: 'http',
    headers: { host: 'localhost:3000' }
  };
  assert.equal(getRequestOrigin(req), 'https://example.herokuapp.com');
});

test('ensureConfigAllowedOrigin adds the detected origin to config', async () => {
  const dir = path.join(__dirname, 'tmp-config');
  const configPath = path.join(dir, 'config.yml');
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, 'cors:\n  allowedOrigins:\n    - http://localhost:3000\n');

  const result = await ensureConfigAllowedOrigin(configPath, 'https://example.herokuapp.com');
  assert.ok(result.allowedOrigins.includes('https://example.herokuapp.com'));
  assert.ok(result.allowedOrigins.includes('http://localhost:3000'));
});
