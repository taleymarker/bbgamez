const globalBase = (window as any)?.JETTIC_CONFIG?.backendUrl;
const envBase = import.meta.env.VITE_API_BASE_URL;
const rawBase = (globalBase || envBase || window.location.origin).trim();
const normalizedBase = rawBase.replace(/\/$/, '');

export const API_BASE_URL = normalizedBase || window.location.origin;
export const APP_NAME = 'bbgamez';
