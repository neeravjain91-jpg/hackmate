import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) {
    return supabaseClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey || url.includes('your-project')) {
    return null;
  }

  try {
    supabaseClient = createClient(url, anonKey);
  } catch {
    return null;
  }
  return supabaseClient;
}

export function getSupabaseAdminClient(): SupabaseClient | null {
  if (supabaseAdminClient) {
    return supabaseAdminClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey || url.includes('your-project') || serviceKey.includes('your-service-role-key')) {
    return null;
  }

  try {
    supabaseAdminClient = createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
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
}

export function setSupabaseAdminClient(client: SupabaseClient | null): void {
  supabaseAdminClient = client;
}

export function setSupabaseClient(client: SupabaseClient | null): void {
  supabaseClient = client;
}
