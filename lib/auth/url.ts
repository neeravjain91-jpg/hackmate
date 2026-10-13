/**
 * URL and Origin Security Utilities for HackMate Authentication.
 */

/**
 * Resolves and validates the canonical application URL.
 *
 * Production/Vercel deployments must explicitly configure NEXT_PUBLIC_APP_URL
 * as a canonical HTTPS origin. Falling back to a hard-coded deployment hostname
 * can silently direct confirmation links to a different deployment.
 *
 * Incoming Host and forwarded-host headers are never trusted.
 * Local development may use an explicitly configured HTTP/HTTPS origin or
 * falls back to http://localhost:3000.
 */
export function getCanonicalAppUrl(): string {
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const rawConfigured = process.env.NEXT_PUBLIC_APP_URL;
  const configured = rawConfigured?.trim().replace(/^["']|["']$/g, '').trim();

  if (configured) {
    try {
      const parsed = new URL(configured);
      const allowedProtocol =
        parsed.protocol === 'https:' ||
        (!isProduction && parsed.protocol === 'http:');

      if (allowedProtocol) {
        return parsed.origin;
      }
    } catch {
      // Invalid URL: reject below in production, use localhost only in development.
    }
  }

  if (isProduction) {
    throw new Error(
      'SECURITY CONFIGURATION ERROR: NEXT_PUBLIC_APP_URL must be configured as a valid canonical HTTPS origin in production.'
    );
  }

  return 'http://localhost:3000';
}
