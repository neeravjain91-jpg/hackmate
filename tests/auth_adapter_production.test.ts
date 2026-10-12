import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { SupabaseDatabaseAdapter } from '@/lib/db/supabaseDb';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';
import { checkRateLimit, resetRateLimiter, getClientIp } from '@/lib/auth/rateLimit';
import { POST as registerHandler } from '@/app/api/auth/register/route';
import { POST as loginHandler } from '@/app/api/auth/login/route';
import { GET as callbackHandler } from '@/app/api/auth/callback/route';
import { GET as cronCleanupHandler } from '@/app/api/cron/cleanup-rate-limits/route';
import { POST as refreshHandler } from '@/app/api/auth/refresh/route';
import { GET as meHandler } from '@/app/api/auth/me/route';
import { GET as healthHandler } from '@/app/api/health/route';
import { createSessionToken, SESSION_COOKIE_NAME, getCurrentUserFromRequest } from '@/lib/auth/session';
import { resetDatabaseAdapter, setDatabaseAdapter } from '@/lib/db';
import { getCanonicalAppUrl } from '@/lib/auth/url';

const TEST_DIR = path.join(process.cwd(), 'data', 'test_auth_adapter');
const TEST_DB_PATH = path.join(TEST_DIR, 'hackmate_test.json');

describe('Multi-User Production Authentication & Storage Alignment', () => {
  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.STORAGE_DRIVER;
    resetRateLimiter();
    resetDatabaseAdapter();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    delete process.env.VERCEL;
    delete process.env.STORAGE_DRIVER;
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

    it('authenticates user via dedicated authClient.auth.signInWithPassword and returns profile', async () => {
      const authUserId = '11111111-2222-3333-4444-555555555555';
      const mockAdminClient: any = {
        auth: {
          admin: {},
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

      const mockAuthClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockImplementation(({ email, password }) => {
            if (email === 'valid@university.edu' && password === 'correctPassword') {
              return Promise.resolve({
                data: {
                  user: {
                    id: authUserId,
                    email,
                    email_confirmed_at: '2026-10-12T00:00:00Z',
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
      };

      const adapter = new SupabaseDatabaseAdapter(mockAdminClient, () => mockAuthClient);

      // Successful login
      const user = await adapter.authenticateUser('valid@university.edu', 'correctPassword');
      expect(user).not.toBeNull();
      expect(user?.id).toBe(authUserId);
      expect(user?.name).toBe('Valid User');
      expect(mockAuthClient.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'valid@university.edu',
        password: 'correctPassword',
      });

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
    it('blocks excessive attempts once limit is reached and returns Retry-After', async () => {
      process.env.ENABLE_RATE_LIMIT_IN_TEST = 'true';

      const key = 'test-ip-rate-limit';
      const limit = 5;

      for (let i = 0; i < limit; i++) {
        const res = await checkRateLimit(key, { max: limit, windowMs: 60000 });
        expect(res.allowed).toBe(true);
      }

      // 6th attempt should be blocked
      const blocked = await checkRateLimit(key, { max: limit, windowMs: 60000 });
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetAt).toBeGreaterThan(Date.now());

      delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
    });

    it('extracts client IP from x-real-ip and ignores untrusted x-forwarded-for', () => {
      const untrustedReq = new Request('http://localhost:3000/api/auth/login', {
        headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      });
      // Untrusted raw x-forwarded-for falls back to loopback
      expect(getClientIp(untrustedReq)).toBe('127.0.0.1');

      const realIpReq = new Request('http://localhost:3000/api/auth/login', {
        headers: { 'x-real-ip': '203.0.113.195' },
      });
      expect(getClientIp(realIpReq)).toBe('203.0.113.195');
    });

    it('prioritizes trusted x-vercel-forwarded-for header and handles IPv6 without fallback', () => {
      const req = new Request('http://localhost:3000/api/auth/login', {
        headers: {
          'x-vercel-forwarded-for': '198.51.100.42',
          'x-real-ip': '203.0.113.195',
          'x-forwarded-for': '70.41.3.18',
        },
      });
      expect(getClientIp(req)).toBe('198.51.100.42');

      const ipv6Req = new Request('http://localhost:3000/api/auth/login', {
        headers: {
          'x-vercel-forwarded-for': '2001:db8:85a3::8a2e:370:7334',
        },
      });
      expect(getClientIp(ipv6Req)).toBe('2001:db8:85a3::8a2e:370:7334');

      const malformedReq = new Request('http://localhost:3000/api/auth/login', {
        headers: {
          'x-vercel-forwarded-for': 'not-a-valid-ip',
        },
      });
      expect(getClientIp(malformedReq)).toBe('127.0.0.1');
    });
  });

  describe('4. Session Refresh & Expiration Sliding', () => {
    it('refreshes session via POST /api/auth/refresh and updates session cookie without returning token in body', async () => {
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
      expect(data.token).toBeUndefined(); // Token MUST NOT be exposed in response body
      expect(data.success).toBe(true);

      const cookie = res.cookies.get(SESSION_COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(typeof cookie?.value).toBe('string');
      expect(cookie?.value.length).toBeGreaterThan(0);
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

  describe('7. Supabase Client Isolation & Authentication Boundary', () => {
    it('uses dedicated auth client for signInWithPassword without altering admin client', async () => {
      const adminClient: any = {
        auth: {
          admin: {
            createUser: vi.fn(),
          },
        },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'user-isolated-123',
                  email: 'isolated@uni.edu',
                  name: 'Isolated User',
                  avatar_url: null,
                  created_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
        }),
      };

      const authClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'user-isolated-123',
                email: 'isolated@uni.edu',
                email_confirmed_at: '2026-10-12T00:00:00Z',
                user_metadata: { name: 'Isolated User' },
              },
            },
            error: null,
          }),
        },
      };

      const adapter = new SupabaseDatabaseAdapter(adminClient, () => authClient);
      const user = await adapter.authenticateUser('isolated@uni.edu', 'secretPass');

      expect(user).not.toBeNull();
      expect(user?.id).toBe('user-isolated-123');
      // Auth was routed to authClient
      expect(authClient.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'isolated@uni.edu',
        password: 'secretPass',
      });
      // Admin client auth methods were NOT called for signInWithPassword
      expect((adminClient.auth as any).signInWithPassword).toBeUndefined();
    });
  });

  describe('8. Partial Failure Recovery & Auth User Rollback', () => {
    it('deletes newly created auth user if profile creation fails', async () => {
      const createdAuthId = 'orphan-user-uuid-999';
      const deleteUserMock = vi.fn().mockResolvedValue({ data: {}, error: null });

      const adminClient: any = {
        auth: {
          admin: {
            createUser: vi.fn().mockResolvedValue({
              data: {
                user: {
                  id: createdAuthId,
                  email: 'fail@uni.edu',
                  user_metadata: { name: 'Fail User' },
                },
              },
              error: null,
            }),
            deleteUser: deleteUserMock,
          },
        },
        from: (table: string) => {
          if (table === 'profiles') {
            return {
              upsert: () => ({
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { message: 'Database connection failed during profile write' },
                    }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      };

      const adapter = new SupabaseDatabaseAdapter(adminClient);

      await expect(
        adapter.createUser({
          email: 'fail@uni.edu',
          name: 'Fail User',
          password: 'password123',
        })
      ).rejects.toThrow('Failed to create profile: Database connection failed during profile write');

      // Verify that deleteUser was called to clean up the orphaned user
      expect(deleteUserMock).toHaveBeenCalledWith(createdAuthId);
    });
  });

  describe('9. Cross-Project Task & Contribution Isolation', () => {
    it('enforces task and contribution project boundaries in LocalDatabaseAdapter', async () => {
      const adapter = new LocalDatabaseAdapter(TEST_DB_PATH);

      const leaderA = await adapter.createUser({
        email: 'leaderA@uni.edu',
        name: 'Leader A',
        password: 'password123',
      });
      const leaderB = await adapter.createUser({
        email: 'leaderB@uni.edu',
        name: 'Leader B',
        password: 'password123',
      });
      const memberB = await adapter.createUser({
        email: 'memberB@uni.edu',
        name: 'Member B',
        password: 'password123',
      });

      const projA = await adapter.createProject({
        name: 'Project A',
        description: 'First Project',
        leader_id: leaderA.id,
      });
      const projB = await adapter.createProject({
        name: 'Project B',
        description: 'Second Project',
        leader_id: leaderB.id,
      });

      await adapter.joinProject(projB.id, memberB.id, 'member');

      // 1. Leader A cannot assign task to Member B (who is only in Project B)
      await expect(
        adapter.createTask({
          project_id: projA.id,
          title: 'Cross Task',
          description: 'Invalid assignment',
          assigned_to: memberB.id,
          created_by: leaderA.id,
        })
      ).rejects.toThrow('Assigned user must be a member of this project.');

      // 2. Create valid task in Project B
      const taskB = await adapter.createTask({
        project_id: projB.id,
        title: 'Project B Task',
        description: 'Valid task in B',
        assigned_to: memberB.id,
        created_by: leaderB.id,
      });

      // 3. Leader A cannot link Project B task when publishing contribution in Project A
      await expect(
        adapter.createContribution(
          {
            project_id: projA.id,
            title: 'Contribution in A with B task',
            description: 'Illicit cross link',
            contributor_id: leaderA.id,
            contributor_name: leaderA.name,
            task_id: taskB.id,
            usage_instructions: 'none',
            dependencies: 'none',
          },
          []
        )
      ).rejects.toThrow('Task does not belong to this project.');
    });
  });

  describe('10. Authentication Client Isolation & Missing Anon Key Defense', () => {
    it('fails closed with actionable configuration error if auth client is unavailable and never calls adminClient.auth.signInWithPassword', async () => {
      const adminSignInSpy = vi.fn();
      const adminClient: any = {
        auth: {
          admin: {},
          signInWithPassword: adminSignInSpy,
        },
      };

      // Construct adapter with a factory returning null (simulating missing anon key)
      const adapter = new SupabaseDatabaseAdapter(adminClient, () => null);

      await expect(
        adapter.authenticateUser('user@student.edu', 'secret123')
      ).rejects.toThrow(/STORAGE CONFIGURATION ERROR: Supabase authentication client could not be initialized/);

      // Verify admin client signInWithPassword was NEVER invoked
      expect(adminSignInSpy).not.toHaveBeenCalled();
    });

    it('fails closed in production if auth client is unavailable during registration', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalAutoConfirm = process.env.AUTH_AUTO_CONFIRM_EMAILS;
      try {
        (process.env as any).NODE_ENV = 'production';
        process.env.AUTH_AUTO_CONFIRM_EMAILS = 'false';

        const adminClient: any = {
          auth: { admin: {} },
        };
        const adapter = new SupabaseDatabaseAdapter(adminClient, () => null);

        await expect(
          adapter.createUser({
            email: 'prod@uni.edu',
            name: 'Prod User',
            password: 'Password123!',
          })
        ).rejects.toThrow(/STORAGE CONFIGURATION ERROR: Supabase authentication client could not be initialized/);
      } finally {
        (process.env as any).NODE_ENV = originalEnv;
        if (originalAutoConfirm !== undefined) {
          process.env.AUTH_AUTO_CONFIRM_EMAILS = originalAutoConfirm;
        } else {
          delete process.env.AUTH_AUTO_CONFIRM_EMAILS;
        }
      }
    });

    it('proves authenticating one user does not mutate or contaminate admin client authorization context', async () => {
      const adminHeaders: Record<string, string> = { Authorization: 'Bearer service-role-key-123' };
      const adminClient: any = {
        auth: { admin: {} },
        from: vi.fn().mockImplementation((table: string) => ({
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: 'student-uuid-456',
                    email: 'student@uni.edu',
                    name: 'Student User',
                    avatar_url: null,
                    created_at: '2026-10-12T00:00:00Z',
                  },
                  error: null,
                }),
            }),
          }),
        })),
        _headers: adminHeaders,
      };

      const authClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'student-uuid-456',
                email: 'student@uni.edu',
                email_confirmed_at: '2026-10-12T00:00:00Z',
                user_metadata: { name: 'Student User' },
              },
            },
            error: null,
          }),
        },
      };

      const adapter = new SupabaseDatabaseAdapter(adminClient, () => authClient);
      const user = await adapter.authenticateUser('student@uni.edu', 'password123');

      expect(user).not.toBeNull();
      expect(user?.id).toBe('student-uuid-456');

      // Crucial: verify admin client headers and service role context remained unchanged
      expect(adminClient._headers.Authorization).toBe('Bearer service-role-key-123');
    });
  });

  describe('11. Email Verification Lifecycle & Session Token Safeguards', () => {
    it('rejects unverified user at login with actionable verification message', async () => {
      const adminClient: any = { auth: { admin: {} } };
      const authClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'unverified-uuid-777',
                email: 'unverified@uni.edu',
                email_confirmed_at: null,
                confirmed_at: null,
                user_metadata: { name: 'Unverified User' },
              },
            },
            error: null,
          }),
        },
      };

      const adapter = new SupabaseDatabaseAdapter(adminClient, () => authClient);

      await expect(
        adapter.authenticateUser('unverified@uni.edu', 'secretPass123')
      ).rejects.toThrow('Please verify your email address before logging in. A confirmation email was sent to your inbox.');
    });

    it('rejects unverified user when Supabase Auth returns unconfirmed error message', async () => {
      const adminClient: any = { auth: { admin: {} } };
      const authClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({
            data: { user: null },
            error: { message: 'Email not confirmed' },
          }),
        },
      };

      const adapter = new SupabaseDatabaseAdapter(adminClient, () => authClient);

      await expect(
        adapter.authenticateUser('unverified@uni.edu', 'secretPass123')
      ).rejects.toThrow('Please verify your email address before logging in. A confirmation email was sent to your inbox.');
    });

    it('registration with requiresVerification returns 201 without setting session cookie', async () => {
      const mockAdapter: any = {
        getUserByEmail: vi.fn().mockResolvedValue(null),
        createUser: vi.fn().mockResolvedValue({
          id: 'new-unverified-id',
          email: 'newstudent@uni.edu',
          name: 'New Student',
          avatar_url: null,
          created_at: new Date().toISOString(),
          requiresVerification: true,
        }),
      };
      setDatabaseAdapter(mockAdapter);

      const req = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'newstudent@uni.edu',
          password: 'securePassword123!',
          name: 'New Student',
        }),
      });

      const res = await registerHandler(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.requiresVerification).toBe(true);
      expect(body.token).toBeUndefined();

      // Ensure no hackmate_session cookie was set
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeNull();
    });

    it('blocks unverified user from accessing protected routes via isUserVerified', async () => {
      const mockAdapter: any = {
        getUserById: vi.fn().mockResolvedValue({
          id: 'unverified-id-999',
          email: 'unverified@uni.edu',
          name: 'Unverified',
        }),
        isUserVerified: vi.fn().mockResolvedValue(false),
      };
      setDatabaseAdapter(mockAdapter);

      const token = createSessionToken('unverified-id-999');
      const req = new NextRequest('http://localhost:3000/api/auth/me', {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      });

      // getCurrentUserFromRequest should return null
      const user = await getCurrentUserFromRequest(req);
      expect(user).toBeNull();

      // GET /api/auth/me should return 401
      const res = await meHandler(req);
      expect(res.status).toBe(401);

      // POST /api/auth/refresh should return 401
      const refreshReq = new NextRequest('http://localhost:3000/api/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      });
      const refreshRes = await refreshHandler(refreshReq);
      expect(refreshRes.status).toBe(401);
    });

    it('callback route exchanges token/code and sets session cookie for verified user', async () => {
      const verifiedUserId = 'callback-user-888';
      const mockAdapter: any = {
        getUserById: vi.fn().mockResolvedValue({
          id: verifiedUserId,
          email: 'verified@uni.edu',
          name: 'Verified User',
        }),
        isUserVerified: vi.fn().mockResolvedValue(true),
      };
      setDatabaseAdapter(mockAdapter);

      const authClient: any = {
        auth: {
          verifyOtp: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: verifiedUserId,
                email: 'verified@uni.edu',
                user_metadata: { name: 'Verified User' },
              },
            },
            error: null,
          }),
        },
      };

      const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mock-anon-key';

      try {
        const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=validhash123&type=signup');
        // Inject auth client mock
        const { getSupabaseAuthClient } = await import('@/lib/supabase');
        vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(authClient);

        const res = await callbackHandler(req);
        expect(res.status).toBe(307); // Redirect to dashboard
        expect(res.headers.get('location')).toContain('/dashboard?verified=true');

        const setCookie = res.headers.get('set-cookie');
        expect(setCookie).toContain(SESSION_COOKIE_NAME);
      } finally {
        if (originalUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (originalKey) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
        else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        vi.restoreAllMocks();
      }
    });

    it('callback route redirects to login on invalid or expired token', async () => {
      const authClient: any = {
        auth: {
          verifyOtp: vi.fn().mockResolvedValue({
            data: { user: null },
            error: { message: 'Token has expired or is invalid' },
          }),
        },
      };

      const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mock-anon-key';

      try {
        vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(authClient);
        const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=expiredhash&type=signup');
        const res = await callbackHandler(req);

        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('/login?error=');
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        if (originalUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (originalKey) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
        else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        vi.restoreAllMocks();
      }
    });

    it('detects duplicate public signup and raises conflict error', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalAutoConfirm = process.env.AUTH_AUTO_CONFIRM_EMAILS;
      try {
        (process.env as any).NODE_ENV = 'production';
        process.env.AUTH_AUTO_CONFIRM_EMAILS = 'false';

        const authClient: any = {
          auth: {
            signUp: vi.fn().mockResolvedValue({
              data: {
                user: {
                  id: 'existing-id-123',
                  email: 'existing@uni.edu',
                  identities: [], // Empty identities array indicates already exists in Supabase
                },
              },
              error: null,
            }),
          },
        };

        const adapter = new SupabaseDatabaseAdapter({ auth: { admin: {} } } as any, () => authClient);

        await expect(
          adapter.createUser({
            email: 'existing@uni.edu',
            name: 'Existing User',
            password: 'password123!',
          })
        ).rejects.toThrow('An account with this email address already exists.');
      } finally {
        (process.env as any).NODE_ENV = originalEnv;
        if (originalAutoConfirm !== undefined) {
          process.env.AUTH_AUTO_CONFIRM_EMAILS = originalAutoConfirm;
        } else {
          delete process.env.AUTH_AUTO_CONFIRM_EMAILS;
        }
      }
    });

    it('callback fails closed and issues NO session cookie if profile creation fails', async () => {
      const mockAdapter: any = {
        isUserVerified: vi.fn().mockResolvedValue(true),
        getUserById: vi.fn().mockResolvedValue(null),
        createUser: vi.fn().mockRejectedValue(new Error('FATAL: Database disk full')),
      };
      setDatabaseAdapter(mockAdapter);

      const authClient: any = {
        auth: {
          verifyOtp: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'fail-profile-uuid',
                email: 'failcreate@uni.edu',
                user_metadata: { name: 'Fail User' },
              },
            },
            error: null,
          }),
        },
      };

      const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mock-anon-key';

      try {
        vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(authClient);
        const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=token123&type=signup');
        const res = await callbackHandler(req);

        // Redirects to login with failure error
        expect(res.status).toBe(307);
        const location = res.headers.get('location') || '';
        expect(location).toContain('/login?error=profile_creation_failed');
        // Crucial: no internal error leaked in URL
        expect(location).not.toContain('FATAL');
        expect(location).not.toContain('disk+full');
        // Crucial: NO session cookie issued
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        if (originalUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (originalKey) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
        else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        vi.restoreAllMocks();
      }
    });

    it('callback fails closed and issues NO session cookie if profile retrieval fails after creation', async () => {
      const mockAdapter: any = {
        isUserVerified: vi.fn().mockResolvedValue(true),
        getUserById: vi.fn().mockResolvedValue(null),
        createUser: vi.fn().mockResolvedValue({
          id: 'retrieval-fail-uuid',
          email: 'retrievalfail@uni.edu',
          name: 'Retrieval User',
        }),
      };
      setDatabaseAdapter(mockAdapter);

      const authClient: any = {
        auth: {
          verifyOtp: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'retrieval-fail-uuid',
                email: 'retrievalfail@uni.edu',
                user_metadata: { name: 'Retrieval User' },
              },
            },
            error: null,
          }),
        },
      };

      const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mock-anon-key';

      try {
        vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(authClient);
        const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=token456&type=signup');
        const res = await callbackHandler(req);

        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('/login?error=profile_retrieval_failed');
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        if (originalUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (originalKey) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
        else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        vi.restoreAllMocks();
      }
    });

    it('callback rejects with profile_mismatch if existing profile email does not match verified user', async () => {
      const mockAdapter: any = {
        getUserById: vi.fn().mockResolvedValue({
          id: 'victim-uuid-123',
          email: 'victim@uni.edu',
          name: 'Victim User',
        }),
      };
      setDatabaseAdapter(mockAdapter);

      const authClient: any = {
        auth: {
          verifyOtp: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: 'victim-uuid-123',
                email: 'attacker@evil.com', // Mismatched email claiming victim profile ID
                user_metadata: { name: 'Attacker' },
              },
            },
            error: null,
          }),
        },
      };

      const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mock-anon-key';

      try {
        vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(authClient);
        const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=hijacktoken&type=signup');
        const res = await callbackHandler(req);

        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('/login?error=profile_mismatch');
        expect(res.headers.get('set-cookie')).toBeNull();
      } finally {
        if (originalUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
        else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (originalKey) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
        else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        vi.restoreAllMocks();
      }
    });

    it('proves reliable cross-instance email verification using separate client instances', async () => {
      // Instance A (Registration Serverless Container):
      const userId = 'cross-instance-user-999';
      const instanceASignUpSpy = vi.fn().mockResolvedValue({
        data: {
          user: {
            id: userId,
            email: 'crossinstance@uni.edu',
            identities: [{ id: userId }],
            email_confirmed_at: null,
          },
        },
        error: null,
      });

      const clientInstanceA: any = {
        auth: {
          signUp: instanceASignUpSpy,
        },
      };

      // Instance B (Verification Callback Serverless Container):
      const instanceBVerifyOtpSpy = vi.fn().mockResolvedValue({
        data: {
          user: {
            id: userId,
            email: 'crossinstance@uni.edu',
            user_metadata: { name: 'Cross Instance Student' },
          },
        },
        error: null,
      });

      const clientInstanceB: any = {
        auth: {
          verifyOtp: instanceBVerifyOtpSpy,
        },
      };

      const originalEnv = process.env.NODE_ENV;
      const originalAutoConfirm = process.env.AUTH_AUTO_CONFIRM_EMAILS;
      const originalSecret = process.env.AUTH_SECRET;
      (process.env as any).NODE_ENV = 'production';
      process.env.AUTH_AUTO_CONFIRM_EMAILS = 'false';
      process.env.AUTH_SECRET = 'random-high-entropy-production-secret-999988887777';

      try {
        const adminClientA: any = {
          auth: { admin: {} },
          from: (table: string) => ({
            upsert: (payload: any) => ({
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: payload.id,
                      email: payload.email,
                      name: payload.name,
                      avatar_url: payload.avatar_url,
                      created_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
              }),
            }),
          }),
        };
        const adapterA = new SupabaseDatabaseAdapter(adminClientA, () => clientInstanceA);
        const created = await adapterA.createUser({
          email: 'crossinstance@uni.edu',
          password: 'Password123!',
          name: 'Cross Instance Student',
        });
        expect(created.requiresVerification).toBe(true);
        expect(instanceASignUpSpy).toHaveBeenCalled();

        // Run verification on Instance B
        const mockDb: any = {
          getUserById: vi.fn().mockResolvedValue({
            id: userId,
            email: 'crossinstance@uni.edu',
            name: 'Cross Instance Student',
          }),
        };
        setDatabaseAdapter(mockDb);

        vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(clientInstanceB);

        const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=crossinstancetoken&type=signup');
        const res = await callbackHandler(req);

        expect(instanceBVerifyOtpSpy).toHaveBeenCalledWith({
          token_hash: 'crossinstancetoken',
          type: 'email',
        });
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('/dashboard?verified=true');
        expect(res.headers.get('set-cookie')).toContain(SESSION_COOKIE_NAME);
      } finally {
        (process.env as any).NODE_ENV = originalEnv;
        if (originalAutoConfirm !== undefined) process.env.AUTH_AUTO_CONFIRM_EMAILS = originalAutoConfirm;
        else delete process.env.AUTH_AUTO_CONFIRM_EMAILS;
        if (originalSecret !== undefined) process.env.AUTH_SECRET = originalSecret;
        else delete process.env.AUTH_SECRET;
        vi.restoreAllMocks();
      }
    });

    it('validates verification redirect origins and ignores attacker-controlled Host and X-Forwarded-Host headers', async () => {
      let passedRedirectTo = '';
      const mockAdapter: any = {
        getUserByEmail: vi.fn().mockResolvedValue(null),
        createUser: vi.fn().mockImplementation((_userData: any, options: any) => {
          passedRedirectTo = options?.emailRedirectTo;
          return Promise.resolve({
            id: 'host-check-uuid',
            email: 'attackercheck@uni.edu',
            name: 'Test',
            requiresVerification: true,
          });
        }),
      };
      setDatabaseAdapter(mockAdapter);

      const maliciousReq = new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          host: 'attacker-poisoning.com',
          'x-forwarded-host': 'phishing-site.evil.org',
          'x-forwarded-proto': 'http',
        },
        body: JSON.stringify({
          email: 'attackercheck@uni.edu',
          password: 'Password123!',
          name: 'Test',
        }),
      });

      const res = await registerHandler(maliciousReq);
      expect(res.status).toBe(201);

      // Verify emailRedirectTo did NOT use attacker headers
      expect(passedRedirectTo).not.toContain('attacker-poisoning.com');
      expect(passedRedirectTo).not.toContain('phishing-site.evil.org');
      expect(passedRedirectTo).toBe(`${getCanonicalAppUrl()}/api/auth/callback`);
    });

    it('rejects verification callback when token_hash parameter is missing', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/callback?type=email');
      const res = await callbackHandler(req);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('error=missing_verification_params');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('rejects verification callback when type parameter is missing', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=some-token-hash');
      const res = await callbackHandler(req);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('error=missing_verification_type');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('rejects verification callback when type parameter is invalid or unsupported', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=some-token-hash&type=invalid_type');
      const res = await callbackHandler(req);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('error=invalid_verification_type');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('clearly rejects unsupported PKCE code exchange flow across serverless requests', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/callback?code=some-pkce-code-123');
      const res = await callbackHandler(req);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('error=unsupported_flow');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('fails closed when authentication client or verifyOtp is not configured', async () => {
      vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(null);
      vi.spyOn(await import('@/lib/supabase'), 'createSupabaseAuthClient').mockReturnValue(null);

      const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=validhash&type=email');
      const res = await callbackHandler(req);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('error=auth_unavailable');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('fails closed when verification token is invalid or expired', async () => {
      const mockAuthClient: any = {
        auth: {
          verifyOtp: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'Token has expired or is invalid' },
          }),
        },
      };
      vi.spyOn(await import('@/lib/supabase'), 'getSupabaseAuthClient').mockReturnValue(mockAuthClient);

      const req = new NextRequest('http://localhost:3000/api/auth/callback?token_hash=expiredhash&type=email');
      const res = await callbackHandler(req);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('error=verification_failed');
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('12. Fail Closed on Profile Recovery Failures', () => {
    it('throws clear operational error if profile lookup and recovery fail, never returning fallback profile', async () => {
      const authUserId = 'auth-user-without-profile';
      const adminClient: any = {
        auth: { admin: {} },
        from: (table: string) => {
          if (table === 'profiles') {
            return {
              select: () => ({
                eq: () => ({
                  single: () => Promise.resolve({ data: null, error: { message: 'Row not found' } }),
                }),
              }),
              upsert: () => ({
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: null,
                      error: { message: 'Foreign key violation or table locked' },
                    }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      };

      const authClient: any = {
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({
            data: {
              user: {
                id: authUserId,
                email: 'noprofile@uni.edu',
                email_confirmed_at: '2026-10-12T00:00:00Z',
                user_metadata: { name: 'No Profile' },
              },
            },
            error: null,
          }),
        },
      };

      const adapter = new SupabaseDatabaseAdapter(adminClient, () => authClient);

      await expect(
        adapter.authenticateUser('noprofile@uni.edu', 'secret123')
      ).rejects.toThrow(/Failed to recover user profile in database/);
    });
  });

  describe('13. Production Rate Limiting Fail-Closed Behavior', () => {
    it('fails closed in production if persistent storage is unavailable', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalVercel = process.env.VERCEL;
      const originalEnableTest = process.env.ENABLE_RATE_LIMIT_IN_TEST;

      try {
        (process.env as any).NODE_ENV = 'production';
        process.env.VERCEL = '1';
        process.env.ENABLE_RATE_LIMIT_IN_TEST = 'true';
        delete process.env.UPSTASH_REDIS_REST_URL;

        const res = await checkRateLimit('prod-key-no-backend', { max: 5 });
        expect(res.allowed).toBe(false);
        expect(res.remaining).toBe(0);
      } finally {
        (process.env as any).NODE_ENV = originalEnv;
        if (originalVercel !== undefined) process.env.VERCEL = originalVercel;
        else delete process.env.VERCEL;
        if (originalEnableTest !== undefined) process.env.ENABLE_RATE_LIMIT_IN_TEST = originalEnableTest;
        else delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
      }
    });
  });

  describe('14. Scheduled Rate Limit Cleanup Maintenance', () => {
    it('rejects unauthenticated requests to cron cleanup endpoint with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/cron/cleanup-rate-limits');
      const res = await cronCleanupHandler(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain('Unauthorized');
    });

    it('rejects cleanup request when CRON_SECRET is not configured on the server with 401', async () => {
      const originalSecret = process.env.CRON_SECRET;
      delete process.env.CRON_SECRET;

      try {
        const req = new NextRequest('http://localhost:3000/api/cron/cleanup-rate-limits', {
          headers: {
            authorization: 'Bearer any-secret-token',
          },
        });
        const res = await cronCleanupHandler(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('valid maintenance authentication is required');
      } finally {
        if (originalSecret !== undefined) process.env.CRON_SECRET = originalSecret;
        else delete process.env.CRON_SECRET;
      }
    });

    it('rejects cleanup request with incorrect secret with 401', async () => {
      const originalSecret = process.env.CRON_SECRET;
      process.env.CRON_SECRET = 'expected-secret-value-123';

      try {
        const req = new NextRequest('http://localhost:3000/api/cron/cleanup-rate-limits', {
          headers: {
            authorization: 'Bearer wrong-secret-value',
          },
        });
        const res = await cronCleanupHandler(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain('valid maintenance authentication is required');
      } finally {
        if (originalSecret !== undefined) process.env.CRON_SECRET = originalSecret;
        else delete process.env.CRON_SECRET;
      }
    });

    it('rejects forged x-vercel-cron header without matching Authorization header with 401', async () => {
      const originalSecret = process.env.CRON_SECRET;
      process.env.CRON_SECRET = 'expected-secret-value-123';

      try {
        // Forged cron header without authorization header
        const reqNoAuth = new NextRequest('http://localhost:3000/api/cron/cleanup-rate-limits', {
          headers: {
            'x-vercel-cron': '1',
          },
        });
        const resNoAuth = await cronCleanupHandler(reqNoAuth);
        expect(resNoAuth.status).toBe(401);

        // Forged cron header with incorrect authorization header
        const reqWrongAuth = new NextRequest('http://localhost:3000/api/cron/cleanup-rate-limits', {
          headers: {
            'x-vercel-cron': '1',
            authorization: 'Bearer forged-fake-secret',
          },
        });
        const resWrongAuth = await cronCleanupHandler(reqWrongAuth);
        expect(resWrongAuth.status).toBe(401);
      } finally {
        if (originalSecret !== undefined) process.env.CRON_SECRET = originalSecret;
        else delete process.env.CRON_SECRET;
      }
    });

    it('executes cleanup when authorized with exact matching CRON_SECRET Bearer token', async () => {
      const originalSecret = process.env.CRON_SECRET;
      process.env.CRON_SECRET = 'super-secret-cron-token-123';

      try {
        const req = new NextRequest('http://localhost:3000/api/cron/cleanup-rate-limits', {
          headers: {
            authorization: 'Bearer super-secret-cron-token-123',
          },
        });
        const res = await cronCleanupHandler(req);
        expect([200, 503]).toContain(res.status);
        const data = await res.json();
        if (res.status === 200) expect(data.success).toBe(true);
        expect(typeof data.deleted).toBe('number');
      } finally {
        if (originalSecret !== undefined) process.env.CRON_SECRET = originalSecret;
        else delete process.env.CRON_SECRET;
      }
    });
  });

  describe('15. Upstash Redis Pipeline Response Validation & Fail-Closed Behavior', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalVercel = process.env.VERCEL;
    const originalEnableTest = process.env.ENABLE_RATE_LIMIT_IN_TEST;
    const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    beforeEach(() => {
      (process.env as any).NODE_ENV = 'production';
      process.env.VERCEL = '1';
      process.env.ENABLE_RATE_LIMIT_IN_TEST = 'true';
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    });

    afterEach(() => {
      (process.env as any).NODE_ENV = originalEnv;
      if (originalVercel !== undefined) process.env.VERCEL = originalVercel;
      else delete process.env.VERCEL;
      if (originalEnableTest !== undefined) process.env.ENABLE_RATE_LIMIT_IN_TEST = originalEnableTest;
      else delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
      if (originalRedisUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
      else delete process.env.UPSTASH_REDIS_REST_URL;
      if (originalRedisToken !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
      else delete process.env.UPSTASH_REDIS_REST_TOKEN;
      vi.restoreAllMocks();
    });

    it('falls through to PostgreSQL on Redis HTTP 500 server error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as any);

      // Without PostgreSQL admin client, production fails closed
      const res = await checkRateLimit('key-http-500', { max: 5 });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('detects command-level errors in Redis pipeline even on HTTP 200 OK', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { error: 'ERR syntax error' },
          { result: 1 },
          { result: 60 },
        ]),
      } as any);

      const res = await checkRateLimit('key-cmd-error', { max: 5 });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('handles malformed JSON response from Redis pipeline', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('Unexpected token < in JSON')),
      } as any);

      const res = await checkRateLimit('key-bad-json', { max: 5 });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('handles missing or incomplete pipeline results array', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ result: 1 }]), // Only 1 element instead of 3
      } as any);

      const res = await checkRateLimit('key-missing-pipeline-items', { max: 5 });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('rejects invalid or NaN count from Redis pipeline', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { result: 'not-a-number' },
          { result: 1 },
          { result: 60 },
        ]),
      } as any);

      const res = await checkRateLimit('key-nan-count', { max: 5 });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('rejects invalid or negative TTL from Redis pipeline', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { result: 1 },
          { result: 1 },
          { result: -10 }, // Invalid TTL < -2
        ]),
      } as any);

      const res = await checkRateLimit('key-invalid-ttl', { max: 5 });
      expect(res.allowed).toBe(false);
      expect(res.remaining).toBe(0);
    });

    it('allows valid Redis pipeline response with correct count and TTL', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { result: 2 },
          { result: 1 },
          { result: 45 },
        ]),
      } as any);

      const res = await checkRateLimit('key-valid-redis', { max: 5 });
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(3);
    });
  });

  describe('16. Fail-Closed Email Verification Status (isUserVerified)', () => {
    it('returns false when getUserById is not supported on administrative client', async () => {
      const adminClient: any = { auth: { admin: {} } };
      const adapter = new SupabaseDatabaseAdapter(adminClient, () => ({}) as any);
      const isVerified = await adapter.isUserVerified('user-no-admin-method');
      expect(isVerified).toBe(false);
    });

    it('returns false when administrative user lookup fails or returns error', async () => {
      const adminClient: any = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'Database connection failed' },
            }),
          },
        },
      };
      const adapter = new SupabaseDatabaseAdapter(adminClient, () => ({}) as any);
      const isVerified = await adapter.isUserVerified('user-lookup-error');
      expect(isVerified).toBe(false);
    });

    it('returns false when administrative lookup throws an unhandled exception', async () => {
      const adminClient: any = {
        auth: {
          admin: {
            getUserById: vi.fn().mockRejectedValue(new Error('Network failure')),
          },
        },
      };
      const adapter = new SupabaseDatabaseAdapter(adminClient, () => ({}) as any);
      const isVerified = await adapter.isUserVerified('user-throws-exception');
      expect(isVerified).toBe(false);
    });

    it('returns false for unconfirmed user with null email_confirmed_at and confirmed_at', async () => {
      const adminClient: any = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: {
                user: {
                  id: 'unconfirmed-student-1',
                  email: 'student@uni.edu',
                  email_confirmed_at: null,
                  confirmed_at: null,
                },
              },
              error: null,
            }),
          },
        },
      };
      const adapter = new SupabaseDatabaseAdapter(adminClient, () => ({}) as any);
      const isVerified = await adapter.isUserVerified('unconfirmed-student-1');
      expect(isVerified).toBe(false);
    });

    it('returns true for confirmed user with email_confirmed_at set', async () => {
      const adminClient: any = {
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({
              data: {
                user: {
                  id: 'confirmed-student-1',
                  email: 'confirmed@uni.edu',
                  email_confirmed_at: '2026-10-10T12:00:00Z',
                  confirmed_at: '2026-10-10T12:00:00Z',
                },
              },
              error: null,
            }),
          },
        },
      };
      const adapter = new SupabaseDatabaseAdapter(adminClient, () => ({}) as any);
      const isVerified = await adapter.isUserVerified('confirmed-student-1');
      expect(isVerified).toBe(true);
    });

    it('returns true when administrative auto-confirm override is explicitly enabled', async () => {
      const original = process.env.AUTH_AUTO_CONFIRM_EMAILS;
      process.env.AUTH_AUTO_CONFIRM_EMAILS = 'true';

      try {
        const adminClient: any = { auth: { admin: {} } };
        const adapter = new SupabaseDatabaseAdapter(adminClient, () => ({}) as any);
        const isVerified = await adapter.isUserVerified('override-user-1');
        expect(isVerified).toBe(true);
      } finally {
        if (original !== undefined) process.env.AUTH_AUTO_CONFIRM_EMAILS = original;
        else delete process.env.AUTH_AUTO_CONFIRM_EMAILS;
      }
    });

    it('prevents issuing session cookie during login when isUserVerified returns false', async () => {
      const mockDb: any = {
        authenticateUser: vi.fn().mockResolvedValue({
          id: 'unverified-login-user',
          email: 'unverified@uni.edu',
          name: 'Unverified Student',
        }),
        isUserVerified: vi.fn().mockResolvedValue(false),
      };
      setDatabaseAdapter(mockDb);

      const req = new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'unverified@uni.edu',
          password: 'password123',
        }),
      });

      const res = await loginHandler(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('Please verify your email address before logging in');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('prevents refreshing session when isUserVerified returns false', async () => {
      const mockDb: any = {
        getUserById: vi.fn().mockResolvedValue({
          id: 'unverified-refresh-user',
          email: 'unverified@uni.edu',
          name: 'Unverified Student',
        }),
        isUserVerified: vi.fn().mockResolvedValue(false),
      };
      setDatabaseAdapter(mockDb);

      const token = createSessionToken('unverified-refresh-user');
      const req = new NextRequest('http://localhost:3000/api/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
        },
      });

      const res = await refreshHandler(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain('Unauthorized');
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });
});


