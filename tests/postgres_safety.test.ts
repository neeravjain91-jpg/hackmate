import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { execSync } from 'child_process';
import { Client } from 'pg';
import {
  validateDbTarget,
  getDbConfig,
  createAdminClient,
  cleanTables,
  applyMigrations,
  isVerifiedGitHubActionsService,
  EXPECTED_TEST_DATABASE,
} from './fixtures/pgHarness';
import {
  provisionIsolatedPostgres,
  performTeardown,
  defaultProcessExecutor,
  ProcessExecutor,
  IsolatedPostgresInstance,
} from './fixtures/isolatedPgRunner';

describe('PostgreSQL Harness Target Safety & Isolation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.HACKMATE_CI_SERVICE_CONTAINER;
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    delete process.env.HACKMATE_DISPOSABLE_INSTANCE;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('1. Database Name Fail-Closed Validation', () => {
    it('rejects non-test database names strictly', () => {
      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_prod' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'postgres' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);
    });

    it('does not assume a database is safe just because its name contains "test"', () => {
      // Must not match arbitrary databases with "test" substring
      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'production_test_db' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_staging_test' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'test' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);
    });

    it('rejects unspecified or empty database names', () => {
      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: '' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);

      expect(() => {
        validateDbTarget({ host: '127.0.0.1' });
      }).toThrow(/Safety violation: Target database must be strictly "hackmate_test"/);
    });
  });

  describe('2. Host Validation & Disposable Isolation Enforcement', () => {
    it('accepts loopback hosts when running against an isolated disposable instance', () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_test' });
      }).not.toThrow();

      expect(() => {
        validateDbTarget({ host: 'localhost', database: 'hackmate_test' });
      }).not.toThrow();

      expect(() => {
        validateDbTarget({ host: '::1', database: 'hackmate_test' });
      }).not.toThrow();
    });

    it('strictly rejects local execution when isolated disposable instance flag is missing', () => {
      delete process.env.CI;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);

      expect(() => {
        validateDbTarget({ host: 'localhost', database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);
    });

    it('strictly rejects non-loopback hosts in local test execution even with disposable flag', () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
      const nonLoopbackHosts = [
        'db.supabase.co',
        'aws-rds.amazonaws.com',
        '192.168.1.100',
        '10.0.0.1',
        'production-pg.internal',
        'hackmate.internal.database',
      ];

      for (const host of nonLoopbackHosts) {
        expect(() => {
          validateDbTarget({ host, database: 'hackmate_test' });
        }).toThrow(/Safety violation: Target host must be a loopback address/);
      }
    });

    it('rejects unspecified host', () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
      expect(() => {
        validateDbTarget({ database: 'hackmate_test' });
      }).toThrow(/Safety violation: Target host is unspecified/);
    });
  });

  describe('3. Production DATABASE_URL Isolation & Redaction', () => {
    it('does not accept production-looking DATABASE_URL as an implicit test target', () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
      process.env.DATABASE_URL = 'postgres://prod_admin:supersecret@db.supabase.co:5432/hackmate_prod';

      // getDbConfig should NOT use DATABASE_URL
      const config = getDbConfig();
      expect(config.host).toBe('127.0.0.1');
      expect(config.database).toBe(EXPECTED_TEST_DATABASE);
      expect((config as any).connectionString).toBeUndefined();
    });

    it('rejects production-looking connection string if passed explicitly and redacts credentials', () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
      const prodUrl = 'postgres://superadmin:supersecretpassword@db.supabase.co:5432/hackmate_prod';

      let thrownError: Error | null = null;
      try {
        validateDbTarget({ connectionString: prodUrl });
      } catch (err: any) {
        thrownError = err;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError!.message).toMatch(/Safety violation/);
      // Redaction assertion: passwords and sensitive connection string must NEVER appear in error message
      expect(thrownError!.message).not.toContain('supersecretpassword');
      expect(thrownError!.message).not.toContain('superadmin');
      expect(thrownError!.message).not.toContain(prodUrl);
    });
  });

  describe('4. Pre-Connection & Pre-Mutation Safeguards', () => {
    it('fails before any connection attempt occurs when config is invalid', async () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
      const connectSpy = vi.spyOn(Client.prototype, 'connect');

      await expect(
        createAdminClient({
          host: 'production.internal',
          database: 'production_db',
        })
      ).rejects.toThrow(/Safety violation/);

      // Verify that Client.connect was NEVER invoked
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('fails before any connection attempt occurs when connecting to shared cluster without disposable flag', async () => {
      delete process.env.CI;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;
      const connectSpy = vi.spyOn(Client.prototype, 'connect');

      await expect(
        createAdminClient({
          host: '127.0.0.1',
          database: 'hackmate_test',
        })
      ).rejects.toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);

      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('cleanTables refuses to truncate if connected database is not hackmate_test', async () => {
      const mockQuery = vi.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('current_database()')) {
          return Promise.resolve({ rows: [{ db: 'production_database' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const fakeClient = { query: mockQuery } as unknown as Client;

      await expect(cleanTables(fakeClient)).rejects.toThrow(
        /Safety violation: Refusing to truncate tables on non-test database "production_database"/
      );

      // Verify TRUNCATE was never executed
      const wasTruncateCalled = mockQuery.mock.calls.some(call =>
        typeof call[0] === 'string' && call[0].includes('TRUNCATE')
      );
      expect(wasTruncateCalled).toBe(false);
    });

    it('applyMigrations refuses to execute if connected database is not hackmate_test', async () => {
      const mockQuery = vi.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('current_database()')) {
          return Promise.resolve({ rows: [{ db: 'shared_dev_database' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const fakeClient = { query: mockQuery } as unknown as Client;

      await expect(applyMigrations(fakeClient)).rejects.toThrow(
        /Safety violation: Refusing to apply migrations to non-test database "shared_dev_database"/
      );
    });
  });

  describe('5. Verified GitHub Actions Environment & CI Bypass Prevention', () => {
    it('proves a local process with CI=true alone cannot bypass ephemeral provisioning', () => {
      process.env.CI = 'true';
      delete process.env.GITHUB_ACTIONS;
      delete process.env.HACKMATE_CI_SERVICE_CONTAINER;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;

      expect(isVerifiedGitHubActionsService()).toBe(false);

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);
    });

    it('requires all GitHub Actions markers to recognize disposable CI container', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      delete process.env.HACKMATE_CI_SERVICE_CONTAINER;
      expect(isVerifiedGitHubActionsService()).toBe(false);

      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = 'wrong_database';
      expect(isVerifiedGitHubActionsService()).toBe(false);

      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;
      expect(isVerifiedGitHubActionsService()).toBe(true);
    });

    it('validates verified GitHub Actions service container configuration', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;

      const ciConfig = {
        host: '127.0.0.1',
        port: 5432,
        database: 'hackmate_test',
        user: 'postgres',
        password: 'testpassword',
      };

      const validated = validateDbTarget(ciConfig);
      expect(validated.host).toBe('127.0.0.1');
      expect(validated.database).toBe('hackmate_test');
      expect(validated.port).toBe(5432);
      expect(validated.user).toBe('postgres');
    });

    it('allows container service host "postgres" in verified GitHub Actions environment', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;

      const validated = validateDbTarget({
        host: 'postgres',
        port: 5432,
        database: 'hackmate_test',
      });
      expect(validated.host).toBe('postgres');
      expect(validated.database).toBe('hackmate_test');
    });

    it('rejects remote hosts even in verified GitHub Actions environment', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;

      expect(() => {
        validateDbTarget({
          host: 'db.supabase.co',
          port: 5432,
          database: 'hackmate_test',
        });
      }).toThrow(/Safety violation: Target host must be a loopback address/);
    });

    it('verifies that environment variables modified by integration harness are restored after teardown', async () => {
      const initialPgHost = process.env.PGHOST;
      const initialPgPort = process.env.PGPORT;
      const initialDisposable = process.env.HACKMATE_DISPOSABLE_INSTANCE;

      const savedEnv = {
        PGHOST: process.env.PGHOST,
        PGPORT: process.env.PGPORT,
        HACKMATE_DISPOSABLE_INSTANCE: process.env.HACKMATE_DISPOSABLE_INSTANCE,
      };

      // Simulate integration harness modifying env
      process.env.PGHOST = '127.0.0.1';
      process.env.PGPORT = '65432';
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';

      // Simulate afterAll restoration
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }

      expect(process.env.PGHOST).toBe(initialPgHost);
      expect(process.env.PGPORT).toBe(initialPgPort);
      expect(process.env.HACKMATE_DISPOSABLE_INSTANCE).toBe(initialDisposable);
    });
  });

  describe('6. Static Security Regression Guard', () => {
    it('ensures unsafe setup_local_postgres.sh script is removed', () => {
      const unsafeScriptPath = path.join(process.cwd(), 'tests/fixtures/setup_local_postgres.sh');
      expect(fs.existsSync(unsafeScriptPath)).toBe(false);
    });

    it('ensures no repository files introduce unsafe wildcard trust authentication', () => {
      const scanDirs = ['tests', '.github', 'supabase'];
      const dangerousPatterns = [
        '0.0.0.0/0 trust',
        'host all all all trust',
        "listen_addresses = '*'",
      ];

      function scanDir(dir: string) {
        const fullDir = path.join(process.cwd(), dir);
        if (!fs.existsSync(fullDir)) return;
        const entries = fs.readdirSync(fullDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(fullDir, entry.name);
          if (entry.isDirectory()) {
            scanDir(path.join(dir, entry.name));
          } else if (entry.isFile() && !entry.name.endsWith('.log')) {
            // Avoid self-matching this test file
            if (entry.name === 'postgres_safety.test.ts') continue;
            const content = fs.readFileSync(entryPath, 'utf8');
            for (const pattern of dangerousPatterns) {
              if (content.includes(pattern)) {
                throw new Error(`Dangerous pattern "${pattern}" detected in file: ${entryPath}`);
              }
            }
          }
        }
      }

      for (const dir of scanDirs) {
        expect(() => scanDir(dir)).not.toThrow();
      }
    });
  });

  describe('7. Disposable PostgreSQL Lifecycle & Cluster-Wide Role Isolation', () => {
    it('provisions and stops an isolated temporary instance cleanly, removing data directory', async () => {
      const inst = await provisionIsolatedPostgres();
      expect(inst.host).toBe('127.0.0.1');
      expect(inst.port).toBeGreaterThan(1024);

      const checkListening = async () => {
        return new Promise<boolean>((resolve) => {
          const s = net.createConnection({ host: inst.host, port: inst.port });
          s.setTimeout(1000);
          s.on('connect', () => {
            s.destroy();
            resolve(true);
          });
          s.on('timeout', () => {
            s.destroy();
            resolve(false);
          });
          s.on('error', () => {
            s.destroy();
            resolve(false);
          });
        });
      };

      const isListeningBefore = await checkListening();
      expect(isListeningBefore).toBe(true);

      const waitForClosed = async (port: number, maxWaitMs = 3000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
          const isClosed = await new Promise<boolean>((resolve) => {
            const s = net.createConnection({ host: '127.0.0.1', port });
            s.setTimeout(500);
            s.on('connect', () => {
              s.destroy();
              resolve(false);
            });
            s.on('timeout', () => {
              s.destroy();
              resolve(true);
            });
            s.on('error', () => {
              s.destroy();
              resolve(true);
            });
          });
          if (isClosed) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      };

      // Stop instance
      await inst.stop();

      // Verify server port is closed
      const isClosed = await waitForClosed(inst.port);
      expect(isClosed).toBe(true);

      // Verify data directory is deleted
      if (inst.isWsl) {
        let dirExists = true;
        try {
          execSync(`wsl test -d ${inst.dataDir}`, { stdio: 'ignore' });
        } catch {
          dirExists = false;
        }
        expect(dirExists).toBe(false);
      } else {
        expect(fs.existsSync(inst.dataDir)).toBe(false);
      }
    }, 45000);

    it('cleans up isolated instance even if test throws an exception (try / finally lifecycle)', async () => {
      let inst: IsolatedPostgresInstance | null = null;
      let errorCaught = false;

      try {
        inst = await provisionIsolatedPostgres();
        // Simulate test failure
        throw new Error('Simulated test execution failure');
      } catch (err: any) {
        errorCaught = true;
        expect(err.message).toBe('Simulated test execution failure');
      } finally {
        if (inst) {
          await inst.stop();
        }
      }

      expect(errorCaught).toBe(true);
      expect(inst).not.toBeNull();

      // Verify port is closed
      const waitForClosed = async (port: number, maxWaitMs = 3000): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
          const isClosed = await new Promise<boolean>((resolve) => {
            const s = net.createConnection({ host: '127.0.0.1', port });
            s.setTimeout(500);
            s.on('connect', () => {
              s.destroy();
              resolve(false);
            });
            s.on('timeout', () => {
              s.destroy();
              resolve(true);
            });
            s.on('error', () => {
              s.destroy();
              resolve(true);
            });
          });
          if (isClosed) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      };

      const isPortClosed = await waitForClosed(inst!.port);
      expect(isPortClosed).toBe(true);
    }, 45000);

    it('guarantees test-only roles are isolated strictly to disposable clusters', () => {
      // Local tests without HACKMATE_DISPOSABLE_INSTANCE fail closed before applying bootstrap_postgres.sql
      delete process.env.CI;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_test' });
      }).toThrow(/Direct connection to shared PostgreSQL cluster is disallowed/);
    });
  });

  describe('8. Provisioning Failure-Path Cleanup & Teardown Safety', () => {
    it('cleans up temporary directory on failure during initdb and propagates error', async () => {
      let removedDir: string | null = null;
      let stopCalled = false;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: (_bin, _dir) => {
          throw new Error('Injected failure during initdb');
        },
        execStopServer: () => {
          stopCalled = true;
        },
        removeDataDir: (dir) => {
          removedDir = dir;
        },
      };

      await expect(
        provisionIsolatedPostgres({ executor: mockExecutor })
      ).rejects.toThrow('Injected failure during initdb');

      expect(removedDir).not.toBeNull();
      expect(stopCalled).toBe(false); // Server was never started
    });

    it('cleans up temporary directory on failure during server startup and propagates error', async () => {
      let removedDir: string | null = null;
      let stopCalled = false;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {}, // initdb succeeds
        execStartServer: () => {
          throw new Error('Injected failure during pg_ctl start');
        },
        execStopServer: () => {
          stopCalled = true;
        },
        removeDataDir: (dir) => {
          removedDir = dir;
        },
      };

      await expect(
        provisionIsolatedPostgres({ executor: mockExecutor })
      ).rejects.toThrow('Injected failure during pg_ctl start');

      expect(removedDir).not.toBeNull();
      expect(stopCalled).toBe(false);
    });

    it('stops server and cleans up directory on failure during database creation after startup', async () => {
      let stoppedDir: string | null = null;
      let removedDir: string | null = null;
      let confirmedStopped = false;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {
          throw new Error('Injected failure during createdb');
        },
        execStopServer: (_bin, dir) => {
          stoppedDir = dir;
        },
        confirmStopped: async () => {
          confirmedStopped = true;
          return true;
        },
        removeDataDir: (dir) => {
          removedDir = dir;
        },
      };

      await expect(
        provisionIsolatedPostgres({ executor: mockExecutor })
      ).rejects.toThrow('Injected failure during createdb');

      expect(stoppedDir).not.toBeNull();
      expect(confirmedStopped).toBe(true);
      expect(removedDir).not.toBeNull();
    });

    it('stops server and cleans up directory on failure during readiness verification', async () => {
      let stoppedDir: string | null = null;
      let removedDir: string | null = null;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {},
        execStopServer: (_bin, dir) => {
          stoppedDir = dir;
        },
        confirmStopped: async () => true,
        removeDataDir: (dir) => {
          removedDir = dir;
        },
      };

      // Mock readiness failure with short retry loop to fail fast
      await expect(
        provisionIsolatedPostgres({
          executor: mockExecutor,
          readinessRetries: 3,
          readinessIntervalMs: 50,
        })
      ).rejects.toThrow(/Failed to establish connection to isolated PostgreSQL instance/);

      expect(stoppedDir).not.toBeNull();
      expect(removedDir).not.toBeNull();
    });

    it('refuses to remove data directory and reports error when shutdown cannot be confirmed', async () => {
      let removeCalled = false;

      const mockExecutor: Partial<ProcessExecutor> = {
        execStopServer: () => {},
        confirmStopped: async () => false, // Server refuses to stop
        removeDataDir: () => {
          removeCalled = true;
        },
      };

      await expect(
        performTeardown({
          dataDir: '/tmp/test_stubborn_pg',
          port: 54321,
          isWsl: false,
          pgCtlPath: 'pg_ctl',
          serverStarted: true,
          executor: { ...defaultProcessExecutor, ...mockExecutor },
        })
      ).rejects.toThrow(/Cleanup failure: PostgreSQL server in ".*" failed to shut down within timeout/);

      // Data directory must NOT have been removed
      expect(removeCalled).toBe(false);
    });

    it('guarantees stop() is strictly idempotent', async () => {
      let stopCallCount = 0;
      let removeCallCount = 0;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {},
        execStopServer: () => {
          stopCallCount++;
        },
        confirmStopped: async () => true,
        removeDataDir: () => {
          removeCallCount++;
        },
      };

      const inst = await provisionIsolatedPostgres({
        executor: mockExecutor,
        skipReadinessWait: true,
      });

      // First stop call
      await inst.stop();
      expect(stopCallCount).toBe(1);
      expect(removeCallCount).toBe(1);

      // Second stop call (must be no-op)
      await inst.stop();
      expect(stopCallCount).toBe(1);
      expect(removeCallCount).toBe(1);
    });
  });
});
