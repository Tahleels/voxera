/**
 * EchoMart backend — entry point
 *
 * System design concepts wired here:
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │  Incoming request                                           │
 *  │      │                                                      │
 *  │  [1] helmet()        — Security + CDN headers               │
 *  │      │                                                      │
 *  │  [2] compression()   — gzip response bodies                 │
 *  │      │                                                      │
 *  │  [3] cdnHeaders()    — Vary, X-Content-Type-Options         │
 *  │      │                                                      │
 *  │  [4] globalLimiter   — 200 req/min per IP (all routes)      │
 *  │      │                                                      │
 *  │  [5] Route-level middleware                                 │
 *  │      ├── GET  /api/capabilities   → cacheFor(60, public)    │
 *  │      ├── GET  /api/state/:id      → cacheFor(5, private)    │
 *  │      ├── POST /api/voice/setup    → voiceLimiter (2/min)    │
 *  │      └── POST /api/tools/*        → toolLimiter (60/min)    │
 *  │                          + sanitiseBody + requireValidSession│
 *  │                                                             │
 *  │  [6] Circuit breakers  (voice.ts, geminiClient.ts)       │
 *  │  [7] Product cache     (productCache.ts)                    │
 *  │  [8] MongoDB pool      (mongoStore.ts, poolSize:10)         │
 *  │  [9] Graceful shutdown (SIGTERM / SIGINT)                   │
 *  └─────────────────────────────────────────────────────────────┘
 */

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import helmet from "helmet";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { initStore } from "./db/index.js";
import { sessionRouter } from "./routes/session.js";
import { toolsRouter } from "./routes/tools.js";
import { stateRouter, capabilitiesRouter } from "./routes/state.js";
import { voiceRouter } from "./routes/voice.js";
import { optionalAuth } from "./middleware/auth.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { apiRateLimiter } from "./middleware/rateLimit.js";

export async function startServer(opts: { port?: number } = {}): Promise<Server> {
  await initStore();

  const app = express();

  // Security headers
  app.use(helmet({ contentSecurityPolicy: false }));

  // Gzip compression
  app.use(compression());

  // Request logging
  app.use(requestLogger);

  // Rate limiting for all API routes
  app.use("/api", apiRateLimiter);

  // CORS with credentials support. On Railway, trust requests from any HTTPS
  // origin (prevent open redirect by enforcing HTTPS). If FRONTEND_ORIGIN is set,
  // use it as the explicit allowlist; otherwise auto-allow all HTTPS origins.
  const corsConfig = config.frontendOrigin && config.frontendOrigin !== "http://localhost:3000"
    ? {
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
          if (!origin) return callback(null, true);
          const allowedOrigins = config.frontendOrigin.split(",").map((o) => o.trim());
          if (allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error("Not allowed by CORS"));
        },
        credentials: true,
      }
    : {
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
          // Production: only allow HTTPS to prevent open redirect
          if (!origin || /^https?:\/\//i.test(origin)) return callback(null, true);
          callback(new Error("Not allowed by CORS"));
        },
        credentials: true,
      };
  app.use(cors(corsConfig));


  app.use(express.json({ limit: "30mb" }));
  app.use(cookieParser(config.sessionSecret));

  // Optional auth on all /api routes - attaches session if valid token present
  app.use("/api", optionalAuth);

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  });

  // ── Routers ─────────────────────────────────────────────────────────────────
  app.use("/api", sessionRouter());
  app.use("/api", toolsRouter());
  app.use("/api", stateRouter());
  app.use("/api", capabilitiesRouter());
  app.use("/api", voiceRouter());

  const port = opts.port ?? config.port;
  const server = app.listen(port, () => {
    console.log(`[ECHOLABS] backend listening on http://127.0.0.1:${port}`);
    console.log(`[ECHOLABS] middleware: helmet, gzip, rate-limit, cache-headers, validation, circuit-breaker`);
  });

  // ── [9] Graceful shutdown ───────────────────────────────────────────────────
  // On SIGTERM/SIGINT: stop accepting new connections, finish in-flight requests,
  // then exit. This prevents data loss during deploys / container restarts.
  setupGracefulShutdown(server);

  return server;
}

function setupGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ECHOLABS] ${signal} received — graceful shutdown started`);

    server.close((err) => {
      if (err) {
        console.error("[ECHOLABS] Error during shutdown:", err);
        process.exit(1);
      }
      console.log("[ECHOLABS] All connections closed — exiting cleanly");
      process.exit(0);
    });

    // Force-kill after 10 s if connections hang (e.g. persistent WebSocket clients).
    setTimeout(() => {
      console.warn("[ECHOLABS] Shutdown timeout — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

// Main entry (dev/start). Tests and the demo script import startServer directly.
const entrypoint    = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFile   = path.resolve(fileURLToPath(import.meta.url));

if (entrypoint === currentFile) {
  startServer().catch((err) => {
    console.error("[ECHOLABS] failed to start:", err);
    process.exit(1);
  });
}
