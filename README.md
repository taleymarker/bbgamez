# bbgamez

## Overview

This repository contains the local `bbgamez` application.

- `backend/` — Express API server, data storage, authentication, admin APIs, and static frontend serving
- `frontend/` — React/Vite frontend source and public assets

## Prerequisites

- Node.js 18 or newer
- npm

## Install

Install backend dependencies:

```bash
cd backend
npm install
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

## Start the servers

### Backend only

The backend can serve the static frontend from `frontend/public`.

```bash
cd backend
npm start
```

Then open:

- http://localhost:3000

### Backend + frontend development

Run the backend and frontend in parallel:

Terminal 1:

```bash
cd backend
npm run dev
```

Terminal 2:

```bash
cd frontend
npm run dev
```

Open the Vite development URL shown in the frontend terminal (commonly http://localhost:5173).

## Backend URL configuration

The frontend runtime backend URL is controlled by `frontend/public/config.js`.

By default, the frontend chooses the backend URL as follows:

- If the frontend runs on `localhost` or `127.0.0.1` and the port is not `3000`, it uses `http://localhost:3000`
- Otherwise it uses `window.location.origin`

This means:

- Vite dev frontend with backend on port `3000` will use `http://localhost:3000`
- When both frontend and backend are served from the same origin, the frontend uses that origin

## Backend environment variables

The backend supports these environment variables:

- `PORT` — port for the backend (default: `3000`)
- `JWT_SECRET` — JWT signing secret; if unset, the app will generate and save one to `backend/data/session-secret.txt`
- `PUBLIC_BASE_URL` — external backend base URL used for cookies and absolute URLs
- `COOKIE_SECURE` — `true` or `false`; overrides secure cookie behavior
- `COOKIE_SAME_SITE` — `lax`, `strict`, or `none`; controls cookie SameSite mode
- `COOKIE_DOMAIN` — optional cookie domain
- `REFRESH_TOKEN_TTL_DAYS` — refresh token lifetime in days (default: `14`)
- `TRUST_PROXY` — proxy trust setting (default: `loopback, linklocal, uniquelocal`)

Example:

```bash
cd backend
PUBLIC_BASE_URL=https://my.domain.com JWT_SECRET="supersecret" npm start
```

## Admin accounts and authentication

### Default admin

A default admin user is already present in `backend/data/users.json` with `admin: true`.

### Adding or modifying admin accounts

The backend provides admin APIs to create and update users:

- `POST /api/admin/users` — create a user with `{ username, password, email, admin: true }`
- `PUT /api/admin/users/:id` — update user details and admin status

These endpoints require an authenticated admin user.

### Manual account changes

If needed, edit `backend/data/users.json` directly. Each user record includes:

- `username`
- `email`
- `passwordHash` — bcrypt hash
- `admin` — set to `true` for admin accounts

**Important:** Do not modify existing password hashes unless you re-hash the password.

## Data and config files

The backend stores runtime data in `backend/data/`:

- `config.yml` — general runtime settings
- `features.yml` — feature flags
- `default-settings.yml` — default site and UI settings
- `users.json` — user accounts and admin flags
- `games.json` — game catalog
- `sessions.json` — session state
- `requests.json` — game/feature requests
- `reports.json` — admin reports
- `session-secret.txt` — persisted JWT secret when `JWT_SECRET` is not provided

## Development notes

- The backend serves static frontend files from `frontend/public` when running with `npm start`.
- The source frontend lives in `frontend/src` and is built by Vite.
- If you change `PUBLIC_BASE_URL`, make sure the URL matches the browser address used to access the app.

## Useful commands

From the repository root:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

Build the frontend:

```bash
cd frontend
npm run build
```

## Static frontend deployment

The frontend is deployed independently from the Heroku backend. Configure the
following build-time variables on each static hosting provider:

- `VITE_API_BASE_URL` — the public Heroku URL, such as `https://bbgamez-api.herokuapp.com`
- `VITE_BASE_PATH` — `/` for a custom domain, Netlify, or Vercel; use
	`/<repository-name>/` for a default GitHub Pages project site

Provider configuration is included in `.gitlab-ci.yml`, `netlify.toml`,
`vercel.json`, and `.github/workflows/deploy-frontend.yml`. Each provider
installs dependencies and builds only `frontend/`; the root Heroku package
continues to start `backend/`.

Start the backend in production mode:

```bash
cd backend
npm start
```
