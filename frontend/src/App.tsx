import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ApiClient, type HealthResponse } from './api/client'
import { API_BASE_URL, APP_NAME } from './config'
import './index.css'

type AuthForm = {
  email: string
  password: string
}

function App() {
  const [token, setToken] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [authForm, setAuthForm] = useState<AuthForm>({ email: '', password: '' })
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginSuccess, setLoginSuccess] = useState<string | null>(null)

  const api = useMemo(() => new ApiClient(API_BASE_URL, () => token, setToken), [token])

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then((data) => {
        if (!cancelled) setHealth(data)
      })
      .catch((err: Error) => {
        if (!cancelled) setHealthError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoginError(null)
    setLoginSuccess(null)
    try {
      const result = await api.login(authForm)
      const name = result.user?.username || result.user?.email || 'user'
      setLoginSuccess(`Signed in as ${name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to sign in'
      setLoginError(message)
    }
  }

  const handleLogout = () => {
    api.logout()
    setLoginSuccess(null)
  }

  const updateField = (key: keyof AuthForm, value: string) => {
    setAuthForm((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <p className="eyebrow">Static SPA · API first</p>
          <h1>{APP_NAME} Control Surface</h1>
          <p className="lede">
            Frontend is fully static (GitHub Pages-ready) and pulls every piece of data from the API at
            <span className="pill">{API_BASE_URL}</span>.
          </p>
        </div>
        <div className="status">
          <span className={token ? 'status__dot status__dot--on' : 'status__dot status__dot--off'} />
          <span className="status__label">{token ? 'Bearer token ready' : 'Not authenticated'}</span>
          {token && (
            <button className="ghost" type="button" onClick={handleLogout}>
              Clear token
            </button>
          )}
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <div className="card__header">
            <div>
              <p className="eyebrow">Connection</p>
              <h2>Backend health</h2>
            </div>
            <span className={`badge ${health ? 'badge--ok' : 'badge--warn'}`}>
              {health ? 'Reachable' : 'Pending'}
            </span>
          </div>
          <p className="muted">Checks the API /health endpoint without cookies (CORS-friendly).</p>
          {health && (
            <dl className="meta">
              <div>
                <dt>Status</dt>
                <dd>{health.status}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{health.version ?? '—'}</dd>
              </div>
              <div>
                <dt>Players</dt>
                <dd>
                  {health.players ?? 0} total · {health.onlineUsers ?? 0} users · {health.onlineGuests ?? 0} guests
                </dd>
              </div>
              <div>
                <dt>Games</dt>
                <dd>{health.games ?? 0}</dd>
              </div>
              <div>
                <dt>Users</dt>
                <dd>{health.totalUsers ?? 0}</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{health.time ?? '—'}</dd>
              </div>
            </dl>
          )}
          {!health && !healthError && <p className="muted">Loading...</p>}
          {healthError && <p className="error">{healthError}</p>}
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <p className="eyebrow">Authentication</p>
              <h2>Bearer login</h2>
            </div>
          </div>
          <p className="muted">Submits credentials to /auth/login and keeps the returned access token in memory.</p>
          <form className="form" onSubmit={handleLogin}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                value={authForm.email}
                onChange={(e) => updateField('email', e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                value={authForm.password}
                onChange={(e) => updateField('password', e.target.value)}
                required
              />
            </label>
            <div className="actions">
              <button type="submit">Sign in</button>
              <button type="button" className="ghost" onClick={handleLogout}>
                Clear token
              </button>
            </div>
          </form>
          {loginSuccess && <p className="success">{loginSuccess}</p>}
          {loginError && <p className="error">{loginError}</p>}
        </section>
      </main>
    </div>
  )
}

export default App
