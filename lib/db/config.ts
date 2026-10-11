export type StorageDriver = 'local' | 'supabase';

export const SUPPORTED_STORAGE_DRIVERS: readonly StorageDriver[] = ['local', 'supabase'];

/**
 * Detects whether the current process is running in a Vercel deployment environment.
 */
export function isVercelEnvironment(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

/**
 * Validates and resolves the configured storage driver according to environment rules:
 *
 * 1. Rejects unsupported driver names.
 * 2. On Vercel deployments (ephemeral serverless filesystem), requires an explicitly
 *    configured persistent database (STORAGE_DRIVER=supabase).
 * 3. In production (NODE_ENV=production), requires STORAGE_DRIVER to be explicitly
 *    configured and prevents silent fallback to local JSON storage.
 * 4. In non-production, non-Vercel environments (e.g. local dev / test), defaults
 *    to 'local' when STORAGE_DRIVER is unset.
 * 5. In self-hosted production with persistent volumes, permits STORAGE_DRIVER=local
 *    only when explicitly configured.
 * 6. Never prints sensitive environment variable values or secrets in error messages.
 */
export function resolveStorageDriver(): StorageDriver {
  const rawDriver = process.env.STORAGE_DRIVER;
  const isVercel = isVercelEnvironment();
  const isProduction = process.env.NODE_ENV === 'production';

  // 1. Vercel deployment safety checks: local filesystem is ephemeral
  if (isVercel) {
    if (!rawDriver || rawDriver.trim().length === 0) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Vercel deployments require an explicitly configured persistent database for student collaboration. Please set STORAGE_DRIVER=supabase along with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );
    }
    const normalized = rawDriver.trim().toLowerCase();
    if (normalized === 'local') {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Local JSON storage is ephemeral on Vercel deployments and cannot be used for student collaboration. Please configure STORAGE_DRIVER=supabase along with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );
    }
  }

  // 2. Production configuration checks: prevent silent fallback to local JSON storage
  if (!rawDriver || rawDriver.trim().length === 0) {
    if (isProduction) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER must be explicitly configured in production. Configure "supabase" for persistent cloud storage or "local" for persistent self-hosted volumes.'
      );
    }
    // Zero-config local development and testing
    return 'local';
  }

  const normalized = rawDriver.trim().toLowerCase();

  // 3. Reject unsupported drivers (sanitize output to prevent leaking accidental secrets)
  if (normalized !== 'local' && normalized !== 'supabase') {
    const safeDriver = normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
    throw new Error(
      `STORAGE CONFIGURATION ERROR: Unsupported STORAGE_DRIVER "${safeDriver}". Supported drivers are "local" and "supabase".`
    );
  }

  return normalized as StorageDriver;
}
