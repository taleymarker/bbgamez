// Backend API origin used by the static frontend.
// When the frontend is served from a different local port, point to the local backend.
const frontendHost = window.location.hostname;
const frontendPort = window.location.port;
const localBackend = (frontendHost === 'localhost' || frontendHost === '127.0.0.1')
    ? `http://${frontendHost}:3000`
    : window.location.origin;
window.JETTIC_CONFIG = {
  backendUrl: frontendPort && frontendPort !== '3000' ? localBackend : window.location.origin
};
