import { IDatabaseAdapter } from './types';
import { LocalDatabaseAdapter } from './localDb';
import { SupabaseDatabaseAdapter } from './supabaseDb';
import { getSupabaseAdminClient } from '../supabase';

let dbInstance: IDatabaseAdapter | null = null;

export function getDatabaseAdapter(): IDatabaseAdapter {
  if (dbInstance) return dbInstance;

  const storageDriver = process.env.STORAGE_DRIVER || 'local';
  const supabaseAdmin = getSupabaseAdminClient();

  if (storageDriver === 'supabase' && supabaseAdmin) {
    dbInstance = new SupabaseDatabaseAdapter(supabaseAdmin);
  } else {
    dbInstance = new LocalDatabaseAdapter();
  }

  return dbInstance;
}
