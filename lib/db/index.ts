import { IDatabaseAdapter } from './types';
import { LocalDatabaseAdapter } from './localDb';
import { SupabaseDatabaseAdapter } from './supabaseDb';
import { getSupabaseAdminClient } from '../supabase';
import { resolveStorageDriver } from './config';

let dbInstance: IDatabaseAdapter | null = null;

export function getDatabaseAdapter(): IDatabaseAdapter {
  if (dbInstance) return dbInstance;

  const driver = resolveStorageDriver();

  if (driver === 'supabase') {
    const supabaseAdmin = getSupabaseAdminClient();
    if (!supabaseAdmin) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER is set to "supabase", but the Supabase admin client could not be initialized. Please configure valid NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
      );
    }
    dbInstance = new SupabaseDatabaseAdapter(supabaseAdmin);
  } else {
    dbInstance = new LocalDatabaseAdapter();
  }

  return dbInstance;
}

export function resetDatabaseAdapter(): void {
  dbInstance = null;
}

export function setDatabaseAdapter(adapter: IDatabaseAdapter | null): void {
  dbInstance = adapter;
}

export { resolveStorageDriver, isVercelEnvironment, sanitizeApiError } from './config';
export type { StorageDriver } from './config';
export type { IDatabaseAdapter, PaginationOptions } from './types';
