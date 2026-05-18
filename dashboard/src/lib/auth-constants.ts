// Edge-safe constants for auth. Anything that needs node:crypto must live
// in lib/auth.ts (server runtime only).

export const SESSION_COOKIE_NAME = 'ff_dash_session';
export const SESSION_MAX_AGE_S = 60 * 60 * 12;
