import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the EchoLabs backend (the "tool gateway") is listening.
 *
 * The browser only ever talks to Next, so every /api/* call is rewritten
 * server-side to the Express app. That makes this one value the single point
 * where a mismatch silently breaks the site, so it is resolved in this order:
 *
 *   1. BACKEND_ORIGIN  – explicit override, e.g. http://192.168.1.5:4000
 *   2. BACKEND_PORT    – just the port
 *   3. PORT in backend/.env – follow the backend's own config
 *   4. 4000            – the backend's built-in default
 *
 * Run `npm run dev --workspace=backend` alongside `npm run dev --workspace=frontend`.
 */
function backendOrigin() {
  const fromEnv = process.env.BACKEND_ORIGIN?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  // Deployed on Railway and BACKEND_ORIGIN wasn't set in this env — use the
  // known production backend URL instead of a useless localhost fallback.
  if (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV === "production") {
    return "https://echolabs-backend-production.up.railway.app";
  }

  let port = process.env.BACKEND_PORT?.trim();
  if (!port) {
    try {
      const envFile = path.resolve(here, "../../backend/.env");
      const match = fs.readFileSync(envFile, "utf8").match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
      if (match) port = match[1];
    } catch {
      // no backend/.env — fall through to the default
    }
  }
  return `http://127.0.0.1:${port || 4000}`;
}

const backend = backendOrigin();

const nextConfig = {
  // Resolve the "@/*" alias explicitly. Vercel's workspace install hoists deps
  // and the tsconfig-paths pickup becomes unreliable there, so pin it here.
  webpack: (config) => {
    config.resolve.alias["@"] = path.resolve(here, "src");
    return config;
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      // Product photos are served by the backend from the same origin, so they
      // are proxied too. Keeps the browser on one origin (no CORS, no hardcoded
      // host in the markup).
      { source: "/images/:path*", destination: `${backend}/images/:path*` },
    ];
  },
};

export default nextConfig;
