import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDatabaseAdapter, resetDatabaseAdapter } from '@/lib/db';
import { getStorageAdapter, resetStorageAdapter } from '@/lib/storage';
import { resolveStorageDriver, isVercelEnvironment, sanitizeApiError } from '@/lib/db/config';
import { resetSupabaseClients, setSupabaseAdminClient } from '@/lib/supabase';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';
import { SupabaseDatabaseAdapter } from '@/lib/db/supabaseDb';
import { LocalStorageAdapter } from '@/lib/storage/localStorage';
import { SupabaseStorageAdapter } from '@/lib/storage/supabaseStorage';
import { POST as registerHandler } from '@/app/api/auth/register/route';
import type { SupabaseClient } from '@supabase/supabase-js';

function setNodeEnv(val: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = val;
}

const TEST_SANDBOX_DIR = path.join(process.cwd(), 'data', 'test_sandbox');
const TEST_SANDBOX_DB = path.join(TEST_SANDBOX_DIR, 'sandbox.json');
const TEST_SANDBOX_STORAGE = path.join(TEST_SANDBOX_DIR, 'sandbox_storage');

describe('Storage Driver Configuration & Production Safeguards', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetDatabaseAdapter();
    resetStorageAdapter();
    resetSupabaseClients();
    process.env = { ...originalEnv };
    if (fs.existsSync(TEST_SANDBOX_DIR)) {
      fs.rmSync(TEST_SANDBOX_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    resetDatabaseAdapter();
    resetStorageAdapter();
    resetSupabaseClients();
    process.env = { ...originalEnv };
    if (fs.existsSync(TEST_SANDBOX_DIR)) {
      fs.rmSync(TEST_SANDBOX_DIR, { recursive: true, force: true });
    }
  });

  describe('Local development and offline environments', () => {
    it('defaults to local JSON storage when STORAGE_DRIVER is unset in non-production, non-Vercel environment', () => {
      delete process.env.STORAGE_DRIVER;
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      setNodeEnv('development');

      expect(resolveStorageDriver()).toBe('local');

      const db = getDatabaseAdapter();
      expect(db).toBeInstanceOf(LocalDatabaseAdapter);

      const storage = getStorageAdapter();
      expect(storage).toBeInstanceOf(LocalStorageAdapter);
    });

    it('uses local JSON storage when STORAGE_DRIVER=local is explicitly configured in development', () => {
      process.env.STORAGE_DRIVER = 'local';
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      setNodeEnv('development');

      expect(resolveStorageDriver()).toBe('local');

      const db = getDatabaseAdapter();
      expect(db).toBeInstanceOf(LocalDatabaseAdapter);

      const storage = getStorageAdapter();
      expect(storage).toBeInstanceOf(LocalStorageAdapter);
    });

    it('permits STORAGE_DRIVER=local in self-hosted production with persistent writable storage', () => {
      process.env.STORAGE_DRIVER = 'local';
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      setNodeEnv('production');

      expect(resolveStorageDriver()).toBe('local');

      const db = getDatabaseAdapter();
      expect(db).toBeInstanceOf(LocalDatabaseAdapter);

      const storage = getStorageAdapter();
      expect(storage).toBeInstanceOf(LocalStorageAdapter);
    });
  });

  describe('Unsupported driver validation', () => {
    it('rejects unsupported driver names with a clear configuration error', () => {
      const unsupportedDrivers = ['redis', 'postgres', 'sqlite', 'mongodb', 'invalid'];

      for (const driver of unsupportedDrivers) {
        process.env.STORAGE_DRIVER = driver;
        delete process.env.VERCEL;
        delete process.env.VERCEL_ENV;

        expect(() => resolveStorageDriver()).toThrowError(
          /Unsupported STORAGE_DRIVER/
        );
        expect(() => resolveStorageDriver()).toThrowError(
          /Supported drivers are "local" and "supabase"/
        );

        resetDatabaseAdapter();
        expect(() => getDatabaseAdapter()).toThrowError(
          /Unsupported STORAGE_DRIVER/
        );

        resetStorageAdapter();
        expect(() => getStorageAdapter()).toThrowError(
          /Unsupported STORAGE_DRIVER/
        );
      }
    });

    it('never prints long or sensitive values in unsupported driver errors', () => {
      const sensitiveToken = 'eyJhGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-token-value-here-1234567890';
      process.env.STORAGE_DRIVER = sensitiveToken;
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;

      try {
        resolveStorageDriver();
        expect.fail('Expected resolveStorageDriver to throw');
      } catch (err: any) {
        expect(err.message).not.toContain(sensitiveToken);
        expect(err.message).toContain('...');
      }
    });
  });

  describe('Production fail-closed safeguards (prevent silent fallback)', () => {
    it('fails closed in production when STORAGE_DRIVER is unset, preventing silent fallback to local storage', () => {
      delete process.env.STORAGE_DRIVER;
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      setNodeEnv('production');

      expect(() => resolveStorageDriver()).toThrowError(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER must be explicitly configured in production. Configure "supabase" for persistent cloud storage or "local" for persistent self-hosted volumes.'
      );

      expect(() => getDatabaseAdapter()).toThrowError(
        /STORAGE_DRIVER must be explicitly configured in production/
      );

      expect(() => getStorageAdapter()).toThrowError(
        /STORAGE_DRIVER must be explicitly configured in production/
      );
    });

    it('fails closed in production when STORAGE_DRIVER is empty whitespace', () => {
      process.env.STORAGE_DRIVER = '   ';
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      setNodeEnv('production');

      expect(() => resolveStorageDriver()).toThrowError(
        /STORAGE_DRIVER must be explicitly configured in production/
      );
    });
  });

  describe('Vercel deployment safeguards', () => {
    it('detects Vercel environment correctly via VERCEL or VERCEL_ENV', () => {
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      expect(isVercelEnvironment()).toBe(false);

      process.env.VERCEL = '1';
      expect(isVercelEnvironment()).toBe(true);

      delete process.env.VERCEL;
      process.env.VERCEL_ENV = 'production';
      expect(isVercelEnvironment()).toBe(true);
    });

    it('requires explicitly configured persistent database on Vercel when STORAGE_DRIVER is unset', () => {
      delete process.env.STORAGE_DRIVER;
      process.env.VERCEL = '1';

      expect(() => resolveStorageDriver()).toThrowError(
        'STORAGE CONFIGURATION ERROR: Vercel deployments require an explicitly configured persistent database for student collaboration. Please set STORAGE_DRIVER=supabase along with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );

      expect(() => getDatabaseAdapter()).toThrowError(
        /Vercel deployments require an explicitly configured persistent database/
      );
    });

    it('rejects STORAGE_DRIVER=local on Vercel because serverless local disk is ephemeral', () => {
      process.env.STORAGE_DRIVER = 'local';
      process.env.VERCEL = '1';

      expect(() => resolveStorageDriver()).toThrowError(
        'STORAGE CONFIGURATION ERROR: Local JSON storage is ephemeral on Vercel deployments and cannot be used for student collaboration. Please configure STORAGE_DRIVER=supabase along with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      );

      expect(() => getDatabaseAdapter()).toThrowError(
        /Local JSON storage is ephemeral on Vercel deployments/
      );

      expect(() => getStorageAdapter()).toThrowError(
        /Local JSON storage is ephemeral on Vercel deployments/
      );
    });

    it('rejects unsupported drivers on Vercel requiring STORAGE_DRIVER=supabase', () => {
      process.env.STORAGE_DRIVER = 'redis';
      process.env.VERCEL = '1';

      expect(() => resolveStorageDriver()).toThrowError(
        'STORAGE CONFIGURATION ERROR: Unsupported STORAGE_DRIVER "redis" on Vercel. Vercel deployments require STORAGE_DRIVER=supabase.'
      );
    });

    it('prevents direct instantiation of LocalDatabaseAdapter and LocalStorageAdapter in Vercel environment', () => {
      process.env.VERCEL = '1';

      expect(() => new LocalDatabaseAdapter(TEST_SANDBOX_DB)).toThrowError(
        /STORAGE CONFIGURATION ERROR: Local JSON database cannot be instantiated in a Vercel environment/
      );
      // Ensure filesystem was NOT touched
      expect(fs.existsSync(TEST_SANDBOX_DIR)).toBe(false);

      expect(() => new LocalStorageAdapter(TEST_SANDBOX_STORAGE)).toThrowError(
        /STORAGE CONFIGURATION ERROR: Local disk storage cannot be instantiated in a Vercel environment/
      );
      expect(fs.existsSync(TEST_SANDBOX_STORAGE)).toBe(false);
    });

    it('ensures configuration failures on Vercel do NOT create the local database or storage directory', () => {
      process.env.VERCEL = '1';
      process.env.STORAGE_DRIVER = 'local';
      process.env.LOCAL_DB_PATH = TEST_SANDBOX_DB;
      process.env.LOCAL_STORAGE_DIR = TEST_SANDBOX_STORAGE;

      expect(() => getDatabaseAdapter()).toThrowError(/ephemeral on Vercel/);
      expect(() => getStorageAdapter()).toThrowError(/ephemeral on Vercel/);

      expect(fs.existsSync(TEST_SANDBOX_DIR)).toBe(false);
      expect(fs.existsSync(TEST_SANDBOX_STORAGE)).toBe(false);
    });
  });

  describe('Supabase driver initialization and failure behavior', () => {
    it('fails with a clear configuration error if STORAGE_DRIVER=supabase but credentials are missing', () => {
      process.env.STORAGE_DRIVER = 'supabase';
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;

      expect(resolveStorageDriver()).toBe('supabase');

      expect(() => getDatabaseAdapter()).toThrowError(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER is set to "supabase", but the Supabase admin client could not be initialized. Please configure valid NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
      );

      expect(() => getStorageAdapter()).toThrowError(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER is set to "supabase", but the Supabase admin client could not be initialized. Please configure valid NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
      );
    });

    it('fails with a clear configuration error if credentials contain placeholder strings', () => {
      process.env.STORAGE_DRIVER = 'supabase';
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://your-project.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'your-service-role-key';

      expect(() => getDatabaseAdapter()).toThrowError(
        'STORAGE CONFIGURATION ERROR: STORAGE_DRIVER is set to "supabase", but the Supabase admin client could not be initialized. Please configure valid NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.'
      );
    });

    it('never leaks secret values in Supabase initialization errors', () => {
      const sensitiveServiceKey = 'sensitive-test-service-role-key-987654321';
      process.env.STORAGE_DRIVER = 'supabase';
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://your-project.supabase.co'; // placeholder triggers null client
      process.env.SUPABASE_SERVICE_ROLE_KEY = sensitiveServiceKey;

      try {
        getDatabaseAdapter();
        expect.fail('Expected getDatabaseAdapter to throw');
      } catch (err: any) {
        expect(err.message).not.toContain(sensitiveServiceKey);
        expect(err.message).toContain('NEXT_PUBLIC_SUPABASE_URL');
        expect(err.message).toContain('SUPABASE_SERVICE_ROLE_KEY');
      }
    });

    it('initializes SupabaseDatabaseAdapter and SupabaseStorageAdapter when admin client is available', () => {
      process.env.STORAGE_DRIVER = 'supabase';

      // Provide a mock client to avoid network calls
      const mockSupabaseAdmin = {
        from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }),
        storage: { from: () => ({}) },
      } as unknown as SupabaseClient;

      setSupabaseAdminClient(mockSupabaseAdmin);

      const db = getDatabaseAdapter();
      expect(db).toBeInstanceOf(SupabaseDatabaseAdapter);

      const storage = getStorageAdapter();
      expect(storage).toBeInstanceOf(SupabaseStorageAdapter);
    });
  });

  describe('Registration API error responses and secret protection', () => {
    it('returns an actionable 503 error on Vercel without creating local filesystem directories or leaking paths', async () => {
      process.env.VERCEL = '1';
      process.env.STORAGE_DRIVER = 'local';
      process.env.LOCAL_DB_PATH = TEST_SANDBOX_DB;

      const req = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: 'student@university.edu',
          password: 'securePassword123',
          name: 'Student Developer',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await registerHandler(req);
      expect(res.status).toBe(503);
      const data = await res.json();

      expect(data.error).toContain('STORAGE CONFIGURATION ERROR: Local JSON storage is ephemeral on Vercel deployments');
      expect(data.error).not.toContain('/var/task');
      expect(data.error).not.toContain('ENOENT');

      // Crucial: verify that no data directory or file was created
      expect(fs.existsSync(TEST_SANDBOX_DIR)).toBe(false);
    });

    it('sanitizeApiError masks internal system errors and strips filesystem paths', () => {
      const rawEnoentError = new Error("ENOENT: no such file or directory, mkdir '/var/task/data'");
      (rawEnoentError as any).code = 'ENOENT';

      const sanitized = sanitizeApiError(rawEnoentError, 'Registration failed.');
      expect(sanitized.status).toBe(503);
      expect(sanitized.error).toBe('Database storage service is temporarily unavailable. Please check server configuration.');
      expect(sanitized.error).not.toContain('/var/task');
      expect(sanitized.error).not.toContain('ENOENT');
      expect(sanitized.error).not.toContain('mkdir');
    });
  });
});
