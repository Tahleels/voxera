import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";

/**
 * Rate limiting configuration from environment variables.
 */
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000); // 1 minute
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 100); // 100 requests per window

// Stricter limits for expensive operations
const STRICT_WINDOW_MS = Number(process.env.RATE_LIMIT_STRICT_WINDOW_MS || 60 * 1000);
const STRICT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_STRICT_MAX_REQUESTS || 20);

/**
 * General API rate limiter - applied to all /api routes.
 */
export const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    error: true,
    code: "rate_limited",
    message: "Too many requests. Please slow down.",
  },
  skip: (req) => req.path === "/health",
  keyGenerator: (req) => {
    const auth = (req as any).auth;
    if (auth?.sessionId) return `session:${auth.sessionId}`;
    return req.ip ?? req.socket.remoteAddress ?? "unknown";
  },
});

/**
 * Stricter rate limiter for expensive endpoints (voice, checkout, session creation).
 */
export const strictRateLimiter = rateLimit({
  windowMs: STRICT_WINDOW_MS,
  max: STRICT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    error: true,
    code: "rate_limited",
    message: "Too many requests to this endpoint. Please wait a moment.",
  },
  keyGenerator: (req) => {
    const auth = (req as any).auth;
    if (auth?.sessionId) return `strict:session:${auth.sessionId}`;
    return `strict:ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
  },
});

/**
 * Apply strict rate limiting to specific routes.
 */
export function applyStrictRateLimiting(router: any): void {
  // Session creation
  router.post("/session", strictRateLimiter);
  // Voice endpoints
  router.post("/voice/setup", strictRateLimiter);
  router.post("/voice", strictRateLimiter);
  // Checkout is handled in tools router but we can add a specific route if needed
}