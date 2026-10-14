import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IStorageAdapter, StoredFileResult } from './types';
import { isVercelEnvironment } from '../db/config';

export function sanitizeFileName(name: string): string {
  // Strip path traversal and forbidden characters
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\-]/g, '_');
  // Ensure non-empty and safe
  return base.length > 0 ? base : 'file.bin';
}

export class LocalStorageAdapter implements IStorageAdapter {
  private baseDir: string;

  constructor(baseDir?: string) {
    if (isVercelEnvironment()) {
      throw new Error(
        'STORAGE CONFIGURATION ERROR: Local disk storage cannot be instantiated in a Vercel environment. Vercel deployments require an explicitly configured persistent object storage (STORAGE_DRIVER=supabase).'
      );
    }
    this.baseDir = baseDir || process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), 'data', 'storage');
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  async saveFile(
    projectId: string,
    fileId: string,
    fileName: string,
    buffer: Buffer,
    _mimeType: string
  ): Promise<StoredFileResult> {
    const projectDir = path.join(this.baseDir, projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const cleanName = sanitizeFileName(fileName);
    const storageFileName = `${fileId}_${cleanName}`;
    const fullPath = path.join(projectDir, storageFileName);

    // Write file persistently to disk
    await fs.promises.writeFile(fullPath, buffer);

    // Compute SHA-256 hash
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      storagePath: `${projectId}/${storageFileName}`,
      checksum: hash,
      fileSize: buffer.length,
    };
  }

  async getFile(
    projectId: string,
    storagePath: string
  ): Promise<{ buffer: Buffer; mimeType?: string } | null> {
    // Prevent path traversal
    const normalized = path.normalize(storagePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.baseDir, normalized);

    // Verify fullPath stays within baseDir and matches projectId
    if (!fullPath.startsWith(path.resolve(this.baseDir))) {
      return null;
    }

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const buffer = await fs.promises.readFile(fullPath);
    return { buffer };
  }

  async deleteFile(projectId: string, storagePath: string): Promise<boolean> {
    try {
      const normalized = path.normalize(storagePath).replace(/^(\.\.[\/\\])+/, '');
      const fullPath = path.join(this.baseDir, normalized);
      if (fs.existsSync(fullPath)) {
        await fs.promises.unlink(fullPath);
      }
      return true;
    } catch {
      return false;
    }
  }
}
