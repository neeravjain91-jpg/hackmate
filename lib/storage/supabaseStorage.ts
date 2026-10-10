import crypto from 'crypto';
import { IStorageAdapter, StoredFileResult } from './types';
import { sanitizeFileName } from './localStorage';
import { SupabaseClient } from '@supabase/supabase-js';

export class SupabaseStorageAdapter implements IStorageAdapter {
  private client: SupabaseClient;
  private bucket: string;

  constructor(client: SupabaseClient, bucket = 'hackmate-contributions') {
    this.client = client;
    this.bucket = bucket;
  }

  async saveFile(
    projectId: string,
    fileId: string,
    fileName: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<StoredFileResult> {
    const cleanName = sanitizeFileName(fileName);
    const storagePath = `${projectId}/${fileId}_${cleanName}`;

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Failed to upload file to Supabase Storage: ${error.message}`);
    }

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      storagePath,
      checksum: hash,
      fileSize: buffer.length,
    };
  }

  async getFile(
    _projectId: string,
    storagePath: string
  ): Promise<{ buffer: Buffer; mimeType?: string } | null> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(storagePath);

    if (error || !data) {
      return null;
    }

    const arrayBuffer = await data.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: data.type,
    };
  }

  async deleteFile(_projectId: string, storagePath: string): Promise<boolean> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .remove([storagePath]);

    return !error;
  }
}
