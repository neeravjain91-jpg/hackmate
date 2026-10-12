import { getSupabaseAdminClient } from '@/lib/supabase';

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
 * Validates whether an IP address matches IPv4 or IPv6 format.
 */
function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  // IPv4 format check
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4Regex.test(ip)) return true;
  // Basic IPv6 format check
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;
  return ipv6Regex.test(ip);
}

/**
 * Extracts and sanitizes the client IP address from trusted headers.
 * Evaluates x-vercel-forwarded-for, x-forwarded-for (first client hop), and x-real-ip.
 */
export function getClientIp(request: Request): string {
  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  if (vercelIp && isValidIp(vercelIp.trim())) {
    return vercelIp.trim();
  }

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const clientIp = forwarded.split(',')[0].trim();
    if (isValidIp(clientIp)) {
      return clientIp;
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp && isValidIp(realIp.trim())) {
    return realIp.trim();
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
        const results = await res.json();
        const count = Number(results[0]?.result ?? 1);
        const ttl = Number(results[2]?.result ?? windowSeconds);
        const resetAt = Date.now() + (ttl > 0 ? ttl * 1000 : windowMs);
        return {
          allowed: count <= max,
          remaining: Math.max(0, max - count),
          resetAt,
        };
      }
    } catch {
      // Continue to PostgreSQL or fail-closed
    }
  }

  // 2. PostgreSQL check_rate_limit RPC via Supabase admin client
  const supabase = getSupabaseAdminClient();
  if (supabase) {
    try {
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

export function resetRateLimiter(): void {
  rateLimitMap.clear();
}
