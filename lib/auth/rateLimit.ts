import { getSupabaseAdminClient } from '@/lib/supabase';
import net from 'net';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Validates whether an IP address matches IPv4 or IPv6 format using Node's net.isIP().
 * Returns true if valid IPv4 (4) or IPv6 (6), false otherwise (0).
 */
export function isValidIp(ip: string | null | undefined): boolean {
  if (!ip || typeof ip !== 'string') return false;
  return net.isIP(ip.trim()) !== 0;
}

/**
 * Extracts and sanitizes the client IP address from trusted hosting proxy headers.
 * Trusts ONLY hosting proxy headers (x-vercel-forwarded-for, x-real-ip).
 * Avoids mapping valid IPv6 to fallback IP.
 * Does NOT trust raw unverified x-forwarded-for.
 */
export function getClientIp(request: Request): string {
  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  if (vercelIp) {
    const candidate = vercelIp.split(',')[0].trim();
    if (isValidIp(candidate)) {
      return candidate;
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    const candidate = realIp.split(',')[0].trim();
    if (isValidIp(candidate)) {
      return candidate;
    }
  }

  return '127.0.0.1';
}

/**
 * Multi-layer rate limiter for authentication endpoints.
 * Supports:
 * 1. Distributed Upstash Redis (if configured via UPSTASH_REDIS_REST_URL/TOKEN)
 * 2. Shared PostgreSQL RPC check_rate_limit via Supabase service role client
 * 3. In-memory sliding window fallback for local development and test environments
 *
 * In production or on Vercel, fails closed if persistent backing stores fail.
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TEST !== 'true') {
    return {
      allowed: true,
      remaining: 999,
      resetAt: Date.now() + 60000,
    };
  }

  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 10;
  const windowSeconds = Math.ceil(windowMs / 1000);

  // 1. Upstash Redis REST backend (if configured)
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${redisToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['INCR', `ratelimit:${key}`],
          ['EXPIRE', `ratelimit:${key}`, windowSeconds, 'NX'],
          ['TTL', `ratelimit:${key}`],
        ]),
      });

      if (res.ok) {
        let results: any;
        try {
          results = await res.json();
        } catch {
          results = null;
        }

        // Validate results is a 3-element array
        if (Array.isArray(results) && results.length >= 3) {
          const [incrResult, expireResult, ttlResult] = results;

          // Detect command-level errors in each pipeline step
          const hasCommandError = Boolean(
            incrResult?.error ||
            expireResult?.error ||
            ttlResult?.error
          );

          if (!hasCommandError) {
            const count = typeof incrResult?.result === 'number'
              ? incrResult.result
              : Number(incrResult?.result);
            const ttl = typeof ttlResult?.result === 'number'
              ? ttlResult.result
              : Number(ttlResult?.result);

            // Validate that count is a valid positive integer and TTL is valid
            if (
              Number.isFinite(count) &&
              count >= 1 &&
              Number.isFinite(ttl) &&
              ttl >= -2
            ) {
              const resetAt = Date.now() + (ttl > 0 ? ttl * 1000 : windowMs);
              return {
                allowed: count <= max,
                remaining: Math.max(0, max - count),
                resetAt,
              };
            }
          }
        }
      }
    } catch {
      // Backend error: fall through to persistent PostgreSQL fallback
    }
  }

  // 2. PostgreSQL check_rate_limit RPC via Supabase admin client
  const supabase = getSupabaseAdminClient();
  if (supabase) {
    try {
      // Bounded opportunistic maintenance: trigger background cleanup at most once per cooldown
      const now = Date.now();
      if (now - lastCleanupTimestamp > CLEANUP_COOLDOWN_MS) {
        lastCleanupTimestamp = now;
        void cleanupExpiredRateLimits().catch(() => {});
      }

      const { data, error } = await supabase.rpc('check_rate_limit', {
        p_key: key,
        p_max: max,
        p_window_seconds: windowSeconds,
      });

      if (!error && data) {
        return {
          allowed: Boolean(data.allowed),
          remaining: Number(data.remaining),
          resetAt: Number(data.reset_at),
        };
      }
    } catch {
      // Handle fail-closed below
    }

    // When running in production on Vercel with Supabase configured, fail closed if DB RPC errors
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + windowMs,
      };
    }
  }

  // In production or on Vercel, persistent storage is required: fail closed
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') {
    return {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + windowMs,
    };
  }

  // 3. In-memory sliding window fallback (Local development and unit tests)
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now > record.resetAt) {
    const resetAt = now + windowMs;
    rateLimitMap.set(key, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: max - 1,
      resetAt,
    };
  }

  if (record.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: record.resetAt,
    };
  }

  record.count += 1;
  return {
    allowed: true,
    remaining: max - record.count,
    resetAt: record.resetAt,
  };
}

let lastCleanupTimestamp = 0;
const CLEANUP_COOLDOWN_MS = 15 * 60 * 1000; // Run at most once every 15 minutes

/**
 * Invokes the database cleanup function to prune rate-limit records older than 1 hour.
 * Protected by service-role authentication client.
 */
export async function cleanupExpiredRateLimits(): Promise<number | null> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('cleanup_expired_rate_limits');
    if (!error && typeof data === 'number') {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function resetCleanupCooldownForTest(): void {
  lastCleanupTimestamp = 0;
}

export function resetRateLimiter(): void {
  rateLimitMap.clear();
  lastCleanupTimestamp = 0;
}

