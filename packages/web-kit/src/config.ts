// Where the dashboard talks to. Split out of api.ts so the auth clients can
// import it without a circular dependency on the API client itself.
export const API_BASE = 'https://api.makerbay.app'
