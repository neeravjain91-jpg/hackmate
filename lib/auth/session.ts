import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { UserProfile } from '../types';
import { getDatabaseAdapter } from '../db';

export const SESSION_COOKIE_NAME = 'hackmate_session';
const SESSION_EXPIRY_DAYS = 7;

/**
 * Minimum required byte length for production AUTH_SECRET.
 * Cryptographically strong HMAC-SHA256 signing requires at least 256 bits (32 bytes) of entropy.
 */
export const MIN_AUTH_SECRET_BYTES = 32;

/**
 * Built-in zero-configuration development secret for local offline development.
 * Strictly forbidden in production.
 */
export const DEFAULT_DEV_AUTH_SECRET = 'hackmate-default-dev-secret-change-in-production-1234567890';

/**
 * Example template secret from .env.example.
 * Strictly forbidden in production.
 */
export const EXAMPLE_ENV_AUTH_SECRET = 'hackmate-local-session-secret-change-in-production';

const KNOWN_PLACEHOLDER_SECRETS: readonly string[] = [
  DEFAULT_DEV_AUTH_SECRET,
  EXAMPLE_ENV_AUTH_SECRET,
];

/**
 * Retrieves and validates the authentication secret used for HMAC-SHA256 session tokens.
 *
 * Requirements:
 * - Production (`NODE_ENV === 'production'`) requires an explicitly set, non-empty secret.
 * - Production secrets must be at least 32 bytes (`Buffer.byteLength(secret, 'utf8') >= 32`).
 * - Production rejects default development, placeholder, and example secrets.
 * - Production fails closed immediately rather than falling back to the development secret.
 * - Secret values or substrings are never logged or leaked in error messages.
 * - Local development remains zero-config and functional with the default development secret.
 *
 * To generate a cryptographically secure random 32-byte secret for production:
 * ```bash
 * openssl rand -base64 32
 * ```
 */
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!secret || secret.trim().length === 0) {
      throw new Error(
        'SECURITY VIOLATION: AUTH_SECRET must be explicitly configured in production. Generate a secure secret of at least 32 bytes using: openssl rand -base64 32'
      );
    }

    const trimmed = secret.trim();
    const lower = trimmed.toLowerCase();

    const isPlaceholder =
      KNOWN_PLACEHOLDER_SECRETS.includes(trimmed) ||
      lower.includes('change-in-production') ||
      lower.includes('change-this-in-production') ||
      lower.includes('your-super-secret') ||
      lower.includes('placeholder') ||
      lower === 'secret' ||
      lower === 'password';

    if (isPlaceholder) {
      throw new Error(
        'SECURITY VIOLATION: AUTH_SECRET cannot use default, placeholder, or example secrets in production. Generate a strong secret of at least 32 bytes using: openssl rand -base64 32'
      );
    }

    if (Buffer.byteLength(trimmed, 'utf8') < MIN_AUTH_SECRET_BYTES) {
      throw new Error(
        `SECURITY VIOLATION: AUTH_SECRET must be at least ${MIN_AUTH_SECRET_BYTES} bytes in production. Generate a strong secret using: openssl rand -base64 32`
      );
    }

    return trimmed;
  }

  return secret && secret.trim().length > 0
    ? secret.trim()
    : DEFAULT_DEV_AUTH_SECRET;
}


export function createSessionToken(userId: string): string {
  const expiresAt = Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('hex');
  const token = Buffer.from(`${payload}:${hmac}`).toString('base64url');
  return token;
}

export function verifySessionToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;

    const [userId, expiresAtStr, receivedHmac] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return null;
    }

    const payload = `${userId}:${expiresAtStr}`;
    const expectedHmac = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))) {
      return null;
    }

    return userId;
  } catch {
    return null;
  }
}

export async function getCurrentUserFromRequest(request: NextRequest | Request): Promise<UserProfile | null> {
  let token: string | null = null;

  // 1. Try Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. Try cookie
  if (!token) {
    const cookieHeader = request.headers.get('cookie') || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, v.join('=')];
      })
    );
    token = cookies[SESSION_COOKIE_NAME] || null;
  }

  if (!token) return null;

  const userId = verifySessionToken(token);
  if (!userId) return null;

  const db = getDatabaseAdapter();
  return db.getUserById(userId);
}
