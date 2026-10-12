import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { SupabaseDatabaseAdapter } from '@/lib/db/supabaseDb';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';
import { checkRateLimit, resetRateLimiter, getClientIp } from '@/lib/auth/rateLimit';
import { POST as refreshHandler } from '@/app/api/auth/refresh/route';
import { GET as meHandler } from '@/app/api/auth/me/route';
import { GET as healthHandler } from '@/app/api/health/route';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { resetDatabaseAdapter, setDatabaseAdapter } from '@/lib/db';

const TEST_DIR = path.join(process.cwd(), 'data', 'test_auth_adapter');
const TEST_DB_PATH = path.join(TEST_DIR, 'hackmate_test.json');

describe('Multi-User Production Authentication & Storage Alignment', () => {
  beforeEach(() => {
    resetRateLimiter();
    resetDatabaseAdapter();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    resetRateLimiter();
    resetDatabaseAdapter();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('1. SupabaseDatabaseAdapter Auth & Profile ID Alignment', () => {
    it('creates user via auth.admin.createUser and binds profiles.id directly to auth.users(id)', async () => {
      const authUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      let upsertPayload: any = null;

      const mockClient: any = {
        auth: {
          admin: {
            createUser: vi.fn().mockResolvedValue({
              data: {
                user: {
                  id: authUserId,
                  email: 'student@university.edu',
                  user_metadata: { name: 'Alice Student', avatar_url: null },
                  created_at: '2026-10-12T00:00:00Z',
                },
              },
              error: null,
            }),
          },
        },
        from: (table: string) => {
          if (table === 'profiles') {
            return {
              upsert: (payload: any) => {
                upsertPayload = payload;
                return {
                  select: () => ({
                    single: () =>
                      Promise.resolve({
                        data: {
                          id: payload.id,
                          email: payload.email,
                          name: payload.name,
                          avatar_url: payload.avatar_url,
                          created_at: '2026-10-12T00:00:00Z',
                        },
                        error: null,
                      }),
                  }),
                };
              },
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      };

      const adapter = new SupabaseDatabaseAdapter(mockClient);
      const profile = await adapter.createUser({
        email: 'student@university.edu',
        name: 'Alice Student',
        password: 'secureStudentPassword123!',
      });

      // Verify auth.admin.createUser was called with exact credentials
      expect(mockClient.auth.admin.createUser).toHaveBeenCalledWith({
        email: 'student@university.edu',
        password: 'secureStudentPassword123!',
        email_confirm: true,
        user_metadata: {
          name: 'Alice Student',
          avatar_url: null,
        },
      });

      // Verify profiles.id matches auth.users(id) exactly
      expect(profile.id).toBe(authUserId);
      expect(upsertPayload).toBeDefined();
      expect(upsertPayload.id).toBe(authUserId);
      expect(upsertPayload.email).toBe('student@university.edu');

      // Crucial: verify that NO custom password_hash was stored in profiles table
      expect(upsertPayload.password_hash).toBeUndefined();
    });

    it('propagates Supabase Auth registration errors when email already exists', async () => {
      const mockClient: any = {
        auth: {
          admin: {
            createUser: vi.fn().mockResolvedValue({
              data: { user: null },
              error: { message: 'A user with this email address has already been registered' },
            }),
          },
        },
      };

      const adapter = new SupabaseDatabaseAdapter(mockClient);
      await expect(
        adapter.createUser({
          email: 'duplicate@university.edu',
          name: 'Bob Duplicate',
          password: 'password123',
        })
      ).rejects.toThrow('A user with this email address has already been registered');
    });

    it('authenticates user via auth.signInWithPassword and returns profile', async () => {
      const authUserId = '11111111-2222-3333-4444-555555555555';
      const mockClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockImplementation(({ email, password }) => {
            if (email === 'valid@university.edu' && password === 'correctPassword') {
              return Promise.resolve({
                data: {
                  user: {
                    id: authUserId,
                    email,
                    user_metadata: { name: 'Valid User' },
                    created_at: '2026-10-12T00:00:00Z',
                  },
                },
                error: null,
              });
            }
            return Promise.resolve({
              data: { user: null },
              error: { message: 'Invalid login credentials' },
            });
          }),
        },
        from: (table: string) => {
          if (table === 'profiles') {
            return {
              select: () => ({
                eq: (_col: string, val: string) => ({
                  single: () =>
                    Promise.resolve({
                      data: {
                        id: val,
                        email: 'valid@university.edu',
                        name: 'Valid User',
                        avatar_url: null,
                        created_at: '2026-10-12T00:00:00Z',
                      },
                      error: null,
                    }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      };

      const adapter = new SupabaseDatabaseAdapter(mockClient);

      // Successful login
      const user = await adapter.authenticateUser('valid@university.edu', 'correctPassword');
      expect(user).not.toBeNull();
      expect(user?.id).toBe(authUserId);
      expect(user?.name).toBe('Valid User');

      // Failed login with wrong password
      const failed = await adapter.authenticateUser('valid@university.edu', 'wrongPassword');
      expect(failed).toBeNull();
    });
  });

  describe('2. LocalDatabaseAdapter Auth & Password Hashing', () => {
    it('hashes passwords with bcrypt and authenticates correctly', async () => {
      const adapter = new LocalDatabaseAdapter(TEST_DB_PATH);

      const created = await adapter.createUser({
        email: 'local@student.edu',
        name: 'Local Student',
        password: 'localPassword123',
      });

      expect(created.id).toBeDefined();
      expect(created.email).toBe('local@student.edu');

      // Verify successful authentication
      const authenticated = await adapter.authenticateUser('local@student.edu', 'localPassword123');
      expect(authenticated).not.toBeNull();
      expect(authenticated?.id).toBe(created.id);

      // Verify rejection of wrong password
      const wrong = await adapter.authenticateUser('local@student.edu', 'wrongPassword');
      expect(wrong).toBeNull();

      // Verify rejection of non-existent user
      const nonExistent = await adapter.authenticateUser('nobody@student.edu', 'somePassword');
      expect(nonExistent).toBeNull();
    });
  });

  describe('3. Rate Limiting Protection on Authentication', () => {
    it('blocks excessive attempts once limit is reached and returns Retry-After', () => {
      process.env.ENABLE_RATE_LIMIT_IN_TEST = 'true';

      const key = 'test-ip-rate-limit';
      const limit = 5;

      for (let i = 0; i < limit; i++) {
        const res = checkRateLimit(key, { max: limit, windowMs: 60000 });
        expect(res.allowed).toBe(true);
      }

      // 6th attempt should be blocked
      const blocked = checkRateLimit(key, { max: limit, windowMs: 60000 });
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetAt).toBeGreaterThan(Date.now());

      delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
    });

    it('extracts client IP from x-forwarded-for header', () => {
      const req = new Request('http://localhost:3000/api/auth/login', {
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      });
      expect(getClientIp(req)).toBe('203.0.113.195');
    });
  });

  describe('4. Session Refresh & Expiration Sliding', () => {
    it('refreshes session via POST /api/auth/refresh and updates session cookie', async () => {
      const localAdapter = new LocalDatabaseAdapter(TEST_DB_PATH);
      setDatabaseAdapter(localAdapter);

      const user = await localAdapter.createUser({
        email: 'refresh@student.edu',
        name: 'Refresh User',
        password: 'password123',
      });

      const token = createSessionToken(user.id);
      const req = new NextRequest('http://localhost:3000/api/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      });

      const res = await refreshHandler(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.user.id).toBe(user.id);
      expect(data.token).toBeDefined();

      const cookie = res.cookies.get(SESSION_COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie?.value).toBe(data.token);
    });

    it('rejects POST /api/auth/refresh with 401 when unauthenticated', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/refresh', {
        method: 'POST',
      });

      const res = await refreshHandler(req);
      expect(res.status).toBe(401);
    });

    it('slides session expiration on GET /api/auth/me', async () => {
      const localAdapter = new LocalDatabaseAdapter(TEST_DB_PATH);
      setDatabaseAdapter(localAdapter);

      const user = await localAdapter.createUser({
        email: 'me@student.edu',
        name: 'Me User',
        password: 'password123',
      });

      const token = createSessionToken(user.id);
      const req = new NextRequest('http://localhost:3000/api/auth/me', {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      });

      const res = await meHandler(req);
      expect(res.status).toBe(200);

      const cookie = res.cookies.get(SESSION_COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie?.value).toBeDefined();
    });
  });

  describe('5. Health Check Monitoring Endpoint (/api/health)', () => {
    it('returns 200 and healthy status for local development driver', async () => {
      delete process.env.STORAGE_DRIVER;
      const res = await healthHandler();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('healthy');
      expect(data.driver).toBe('local');
      expect(data.latencyMs).toBeTypeOf('number');
    });

    it('returns 503 if STORAGE_DRIVER=local is set in Vercel environment', async () => {
      process.env.VERCEL = '1';
      process.env.STORAGE_DRIVER = 'local';

      const res = await healthHandler();
      expect(res.status).toBe(503);

      const data = await res.json();
      expect(data.status).toBe('unhealthy');
      expect(data.error).toContain('STORAGE CONFIGURATION ERROR: Local JSON storage is ephemeral on Vercel');

      delete process.env.VERCEL;
      delete process.env.STORAGE_DRIVER;
    });
  });

  describe('6. Query Pagination Across Adapters', () => {
    it('LocalDatabaseAdapter slices lists accurately according to limit and offset', async () => {
      const adapter = new LocalDatabaseAdapter(TEST_DB_PATH);

      const leader = await adapter.createUser({
        email: 'leader_pages@team.io',
        name: 'Leader Pages',
        password: 'password123',
      });

      const proj = await adapter.createProject({
        name: 'Paging Project',
        description: 'Pagination test',
        leader_id: leader.id,
      });

      // Create 5 tasks
      for (let i = 1; i <= 5; i++) {
        await adapter.createTask({
          project_id: proj.id,
          title: `Task ${i}`,
          description: `Description ${i}`,
          assigned_to: leader.id,
          created_by: leader.id,
        });
      }

      // Page 1: limit 2, offset 0
      const page1 = await adapter.getProjectTasks(proj.id, { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].title).toBe('Task 1');
      expect(page1[1].title).toBe('Task 2');

      // Page 2: limit 2, offset 2
      const page2 = await adapter.getProjectTasks(proj.id, { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
      expect(page2[0].title).toBe('Task 3');
      expect(page2[1].title).toBe('Task 4');

      // Page 3: limit 2, offset 4
      const page3 = await adapter.getProjectTasks(proj.id, { limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
      expect(page3[0].title).toBe('Task 5');
    });
  });
});
