/**
 * URL and Origin Security Utilities for HackMate Authentication.
 */

/**
 * Resolves and validates the canonical application URL.
 *
 * In production or on Vercel:
 * Strictly uses validated NEXT_PUBLIC_APP_URL.
 * NEVER trusts incoming Host, X-Forwarded-Host, or X-Forwarded-Proto request headers,
 * preventing host-header injection and email verification token poisoning attacks.
 * If NEXT_PUBLIC_APP_URL is missing or invalid in production, falls back to the
 * canonical production deployment origin.
 *
 * In local development:
 * Uses NEXT_PUBLIC_APP_URL if valid, or falls back to 'http://localhost:3000'.
 */
export function getCanonicalAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;

  if (configured) {
    try {
      const parsed = new URL(configured.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // Invalid URL in env - fall through to environment-based defaults
    }
  }

  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

  if (isProduction) {
    // Canonical production origin
    return 'https://try-kohl-mu.vercel.app';
  }

  return 'http://localhost:3000';
}
