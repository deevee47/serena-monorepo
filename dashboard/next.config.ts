import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: { allowedOrigins: ['localhost:4000', '127.0.0.1:4000'] },
  },
  // ESLint runs via `bun run lint`; skipping during `next build` keeps the
  // production build from failing on stylistic rules that don't affect runtime.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
