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
function normalizeDriver(raw: string | undefined): string | null {
  if (!raw) return null;
  const unquoted = raw.trim().replace(/^["']|["']$/g, '').trim();
  return unquoted.length > 0 ? unquoted.toLowerCase() : null;
}

export function resolveStorageDriver(): StorageDriver {
  const rawDriver = process.env.STORAGE_DRIVER;
  const isVercel = isVercelEnvironment();
  const isProduction = process.env.NODE_ENV === 'production';
  const normalized = normalizeDriver(rawDriver);

  // 1. Vercel deployment safety checks: serverless local filesystem is ephemeral
  if (isVercel) {
    if (!normalized) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Vercel deployments require an explicitly configured persistent database for student collaboration. Please set STORAGE_DRIVER=supabase along with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );
    }
    if (normalized === 'local') {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Local JSON storage is ephemeral on Vercel deployments and cannot be used for student collaboration. Please configure STORAGE_DRIVER=supabase along with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );
    }
    if (normalized !== 'supabase') {
      const safeDriver = normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
      throw new Error(
        `STORAGE CONFIGURATION ERROR: Unsupported STORAGE_DRIVER "${safeDriver}" on Vercel. Vercel deployments require STORAGE_DRIVER=supabase.`
      );
    }
    return 'supabase';
  }

  // 2. Production configuration checks: prevent silent fallback to local JSON storage
  if (!normalized) {
    if (isProduction) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER must be explicitly configured in production. Configure "supabase" for persistent cloud storage or "local" for persistent self-hosted volumes.'
      );
    }
    // Zero-config local development and testing
    return 'local';
  }

  // 3. Reject unsupported drivers (sanitize output to prevent leaking accidental secrets)
  if (normalized !== 'local' && normalized !== 'supabase') {
    const safeDriver = normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
    throw new Error(
      `STORAGE CONFIGURATION ERROR: Unsupported STORAGE_DRIVER "${safeDriver}". Supported drivers are "local" and "supabase".`
    );
  }

  return normalized as StorageDriver;
}

/**
 * Formats caught errors into safe, actionable API responses without exposing
 * internal stack traces, filesystem paths (e.g. /var/task), or secret values.
 */
export function sanitizeApiError(
  err: any,
  fallbackMessage: string
): { error: string; status: number } {
  const message = typeof err?.message === 'string' ? err.message : '';

  // 1. Explicit configuration and security violation errors: safe and actionable for operators
  if (message.includes('STORAGE CONFIGURATION ERROR') || message.includes('SECURITY VIOLATION')) {
    return { error: message, status: 503 };
  }

  // 2. Expected unverified email condition: 403 Forbidden
  if (
    err?.status === 403 ||
    err?.code === 'email_not_confirmed' ||
    message.includes('verify your email address before logging in') ||
    (message.toLowerCase().includes('email') &&
      (message.toLowerCase().includes('not confirmed') || message.toLowerCase().includes('unverified')))
  ) {
    return {
      error:
        'Please verify your email address before logging in. A confirmation email was sent to your inbox.',
      status: 403,
    };
  }

  // 3. File system, operating system, or network connection errors: sanitize completely
  const isSystemError =
    Boolean(err?.code && (String(err.code).startsWith('E') || typeof err.errno === 'number')) ||
    message.includes('/var/task') ||
    message.includes('ENOENT') ||
    message.includes('EACCES') ||
    message.includes('EROFS') ||
    message.includes('mkdir');

  if (isSystemError) {
    return {
      error: 'Database storage service is temporarily unavailable. Please check server configuration.',
      status: 503,
    };
  }

  return {
    error: message || fallbackMessage,
    status: 500,
  };
}
