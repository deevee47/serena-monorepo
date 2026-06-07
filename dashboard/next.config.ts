import type { NextConfig } from 'next';

// Server Actions reject requests whose Origin isn't allow-listed. Behind
// Coolify/Traefik the Origin is the public host, so it must be added or the
// Offers / Trigger / Talk pages 403 in production. DASHBOARD_DOMAIN is a bare
// host (e.g. `app.example.com`, no scheme) injected at build time.
const serverActionOrigins = ['localhost:4000', '127.0.0.1:4000'];
if (process.env.DASHBOARD_DOMAIN) {
  serverActionOrigins.push(process.env.DASHBOARD_DOMAIN);
}

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { allowedOrigins: serverActionOrigins },
  },
  // ESLint runs via `bun run lint`; skipping during `next build` keeps the
  // production build from failing on stylistic rules that don't affect runtime.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
