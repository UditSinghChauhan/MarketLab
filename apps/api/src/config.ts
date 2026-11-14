import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** PostgreSQL connection string. Without it the command log is kept in memory. */
  DATABASE_URL: z.url().optional(),
  /** HMAC key for session tokens. Required in production. */
  TOKEN_SECRET: z.string().min(32).optional(),
  /** Milliseconds between simulated market ticks. */
  TICK_MS: z.coerce.number().int().min(100).default(600),
  /** Minutes of simulated history generated when a new session starts. */
  WARMUP_MINUTES: z.coerce.number().min(0).max(240).default(30),
  /** A session (one simulated trading day) is replaced after this many hours. */
  SESSION_HOURS: z.coerce.number().positive().default(24),
  /** Directory of the built web app to serve, if any. */
  WEB_DIST: z.string().optional(),
  /**
   * The site's public origin, for absolute URLs in link previews. Render sets
   * RENDER_EXTERNAL_URL on its own; PUBLIC_URL overrides it for a custom domain.
   */
  PUBLIC_URL: z.url().optional(),
  RENDER_EXTERNAL_URL: z.url().optional(),
  /** Multiplies every rate limit. The end-to-end suite raises it; leave it at 1 otherwise. */
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof Env> & { tokenSecret: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  if (parsed.NODE_ENV === "production" && !parsed.TOKEN_SECRET) {
    throw new Error("TOKEN_SECRET must be set (at least 32 characters) in production");
  }
  return {
    ...parsed,
    tokenSecret: parsed.TOKEN_SECRET ?? "development-only-secret-do-not-use-in-prod",
  };
}
