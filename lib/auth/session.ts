import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { UserProfile } from '../types';
import { getDatabaseAdapter } from '../db';

export const SESSION_COOKIE_NAME = 'hackmate_session';
const SESSION_EXPIRY_DAYS = 7;

/**
 * Configured minimum length (in UTF-8 bytes) for production AUTH_SECRET.
 *
 * Enforcing a 32-byte minimum length ensures an adequate byte ceiling, but length
 * alone does not establish cryptographic entropy. Production operators must generate
 * secrets using a cryptographically secure random generator, such as:
 * ```bash
 * openssl rand -base64 32
 * ```
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
 * Known weak base words that must not be repeated or used as trivial secrets.
 */
const KNOWN_WEAK_WORDS: readonly string[] = [
  'password',
  'secret',
  'admin',
  'hackmate',
  'changeme',
  'qwerty',
  '12345678',
  'test',
  'letmein',
  'default',
];

/**
 * Checks for obvious low-complexity patterns:
 * 1. Single repeated character across the entire secret (e.g. "!" x 32, "a" x 32).
 * 2. Entire secret formed by repeating a known weak word (e.g. "password" x 4, with or without delimiters).
 * 3. Obvious repetition of a short predictable unit (period 1..16 characters repeating across the entire secret).
 */
function isLowComplexitySecret(str: string): boolean {
  // 1. Secret made entirely from the same repeated character
  if (new Set(str).size <= 1) {
    return true;
  }

  // 2. Secret formed by repeating a known weak word (case-insensitive, ignoring common delimiters)
  const normalized = str.toLowerCase().replace(/[-_.\s]/g, '');
  for (const word of KNOWN_WEAK_WORDS) {
    const regex = new RegExp(`^(?:${word})+$`, 'i');
    if (regex.test(normalized)) {
      return true;
    }
  }

  // 3. Obvious periodic repetition of short chunks (chunk size 1 to 16)
  const len = str.length;
  for (let period = 1; period <= 16; period++) {
    if (len >= period * 2) {
      const unit = str.slice(0, period);
      const repetitions = Math.floor(len / period);
      const remainder = str.slice(repetitions * period);
      if (unit.repeat(repetitions) + unit.slice(0, remainder.length) === str) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Rejects specific placeholder phrases without using an overly broad substring
 * blacklist that could reject valid random tokens.
 */
function isKnownPlaceholder(str: string): boolean {
  if (KNOWN_PLACEHOLDER_SECRETS.includes(str)) {
    return true;
  }
  const lower = str.toLowerCase();
  return (
    lower.includes('change-in-production') ||
    lower.includes('change-this-in-production') ||
    lower.includes('your-super-secret') ||
    lower.includes('placeholder')
  );
}

/**
 * Retrieves and validates the authentication secret used for HMAC-SHA256 session tokens.
 *
 * Security Model & Guarantees:
 * - String validation alone cannot prove cryptographic entropy. The actual guarantee
 *   provided by this validator is strict minimum-length enforcement (>= 32 bytes)
 *   combined with active rejection of known weak, placeholder, single-character, and
 *   predictable repeating patterns.
 * - The operator must still generate a cryptographically random secret (e.g., using `openssl rand -base64 32`).
 * - In production (`NODE_ENV === 'production'`), validation fails closed immediately rather than
 *   falling back to development secrets.
 * - Secret values or substrings are never logged or included in thrown error messages.
 * - Local development and test environments remain zero-config with the default development secret.
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

    if (isKnownPlaceholder(trimmed)) {
      throw new Error(
        'SECURITY VIOLATION: AUTH_SECRET cannot use default, placeholder, or example secrets in production. Generate a strong secret of at least 32 bytes using: openssl rand -base64 32'
      );
    }

    if (Buffer.byteLength(trimmed, 'utf8') < MIN_AUTH_SECRET_BYTES) {
      throw new Error(
        `SECURITY VIOLATION: AUTH_SECRET must be at least ${MIN_AUTH_SECRET_BYTES} bytes in production. Generate a strong secret using: openssl rand -base64 32`
      );
    }

    if (isLowComplexitySecret(trimmed)) {
      throw new Error(
        'SECURITY VIOLATION: AUTH_SECRET contains an obvious weak, repeated, or predictable pattern. Operators must configure a cryptographically random secret of at least 32 bytes (e.g. openssl rand -base64 32).'
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
