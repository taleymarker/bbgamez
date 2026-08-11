export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HealthResponse {
  status: string;
  version?: string;
  time?: string;
  games?: number;
  players?: number;
  onlineUsers?: number;
  onlineGuests?: number;
  totalUsers?: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  user?: {
    id: string;
    username?: string;
    email?: string;
  };
}

export class ApiClient {
  private readonly baseUrl: string
  private readonly getToken: () => string | null
  private readonly setToken: (token: string | null) => void

  constructor(baseUrl: string, getToken: () => string | null, setToken: (token: string | null) => void) {
    this.baseUrl = baseUrl
    this.getToken = getToken
    this.setToken = setToken
  }

  private buildUrl(path: string) {
    const safePath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${safePath}`;
  }

  private async parseJson(response: Response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      console.warn('Failed to parse JSON', err);
      return null;
    }
  }

  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Content-Type') && init.body) {
      headers.set('Content-Type', 'application/json');
    }

    const token = this.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    let response: Response;
    try {
      response = await fetch(this.buildUrl(path), {
        ...init,
        headers,
        credentials: 'include',
        signal: init.signal || controller.signal
      });
    } catch (err: any) {
      const message = err?.name === 'AbortError' ? 'Backend request timed out' : 'Backend is offline or unreachable';
      clearTimeout(timeout);
      throw new Error(message);
    }

    clearTimeout(timeout);

    const data = await this.parseJson(response);
    if (!response.ok) {
      const message = (data as any)?.error || (data as any)?.message || response.statusText;
      throw new Error(message || 'Request failed');
    }

    return data as T;
  }

  async health() {
    return this.request<HealthResponse>('/health');
  }

  async login(payload: LoginRequest) {
    const data = await this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (data?.accessToken) this.setToken(data.accessToken);
    return data;
  }

  logout() {
    this.setToken(null);
  }
}
