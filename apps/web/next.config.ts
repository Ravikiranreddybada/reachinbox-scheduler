import type { NextConfig } from 'next';

// When API_PROXY_TARGET is set (hosted demo), the browser calls /backend/* on the web origin
// and Next forwards it to the API. Cookies stay first-party, so login works across hosts.
const apiProxyTarget = process.env.API_PROXY_TARGET;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  async rewrites() {
    return apiProxyTarget
      ? [{ source: '/backend/:path*', destination: `${apiProxyTarget}/:path*` }]
      : [];
  },
};
export default nextConfig;
