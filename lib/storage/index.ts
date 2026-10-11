import { IStorageAdapter } from './types';
import { LocalStorageAdapter } from './localStorage';
import { SupabaseStorageAdapter } from './supabaseStorage';
import { getSupabaseAdminClient } from '../supabase';
import { resolveStorageDriver } from '../db/config';

let storageInstance: IStorageAdapter | null = null;

export function getStorageAdapter(): IStorageAdapter {
  if (storageInstance) return storageInstance;

  const driver = resolveStorageDriver();

  if (driver === 'supabase') {
    const supabaseAdmin = getSupabaseAdminClient();
    if (!supabaseAdmin) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER is set to "supabase", but the Supabase admin client could not be initialized. Please configure valid NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
      );
    }
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'hackmate-contributions';
    storageInstance = new SupabaseStorageAdapter(supabaseAdmin, bucket);
  } else {
    storageInstance = new LocalStorageAdapter();
  }

  return storageInstance;
}

export function resetStorageAdapter(): void {
  storageInstance = null;
}

export function setStorageAdapter(adapter: IStorageAdapter | null): void {
  storageInstance = adapter;
}
