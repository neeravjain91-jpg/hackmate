import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;
let supabaseAuthClient: SupabaseClient | null = null;

function cleanEnvVar(val: string | undefined): string | undefined {
  if (!val) return undefined;
  const trimmed = val.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Creates a fresh, isolated public Supabase client configured specifically
 * for stateless authentication operations (e.g. signInWithPassword).
 * Configured with persistSession: false, autoRefreshToken: false to ensure
 * no shared session or bearer token state is retained across requests.
 */
export function createSupabaseAuthClient(): SupabaseClient | null {
  const url = cleanEnvVar(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = cleanEnvVar(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!url || !anonKey || url.includes('your-project') || anonKey.includes('your-anon-key')) {
    return null;
  }

  try {
    return createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  } catch {
    return null;
  }
}

/**
 * Returns a dedicated authentication client for credential verification.
 */
export function getSupabaseAuthClient(): SupabaseClient | null {
  if (supabaseAuthClient) {
    return supabaseAuthClient;
  }
  supabaseAuthClient = createSupabaseAuthClient();
  return supabaseAuthClient;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) {
    return supabaseClient;
  }

  const url = cleanEnvVar(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = cleanEnvVar(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!url || !anonKey || url.includes('your-project')) {
    return null;
  }

  try {
    supabaseClient = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  } catch {
    return null;
  }
  return supabaseClient;
}

export function getSupabaseAdminClient(): SupabaseClient | null {
  if (supabaseAdminClient) {
    return supabaseAdminClient;
  }

  const url = cleanEnvVar(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceKey = cleanEnvVar(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url || !serviceKey || url.includes('your-project') || serviceKey.includes('your-service-role-key')) {
    return null;
  }

  try {
    supabaseAdminClient = createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  } catch {
    return null;
  }
  return supabaseAdminClient;
}

export function resetSupabaseClients(): void {
  supabaseClient = null;
  supabaseAdminClient = null;
  supabaseAuthClient = null;
}

export function setSupabaseAdminClient(client: SupabaseClient | null): void {
  supabaseAdminClient = client;
}

export function setSupabaseClient(client: SupabaseClient | null): void {
  supabaseClient = client;
}

export function setSupabaseAuthClient(client: SupabaseClient | null): void {
  supabaseAuthClient = client;
}
