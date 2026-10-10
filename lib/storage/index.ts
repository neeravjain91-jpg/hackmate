import { IStorageAdapter } from './types';
import { LocalStorageAdapter } from './localStorage';
import { SupabaseStorageAdapter } from './supabaseStorage';
import { getSupabaseAdminClient } from '../supabase';

let storageInstance: IStorageAdapter | null = null;

export function getStorageAdapter(): IStorageAdapter {
  if (storageInstance) return storageInstance;

  const storageDriver = process.env.STORAGE_DRIVER || 'local';
  const supabaseAdmin = getSupabaseAdminClient();

  if (storageDriver === 'supabase' && supabaseAdmin) {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'hackmate-contributions';
    storageInstance = new SupabaseStorageAdapter(supabaseAdmin, bucket);
  } else {
    storageInstance = new LocalStorageAdapter();
  }

  return storageInstance;
}
