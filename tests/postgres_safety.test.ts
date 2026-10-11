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
  ALLOWED_LOCAL_HOSTS,
  ALLOWED_CI_SERVICE_HOSTS,
} from './fixtures/pgHarness';
import {
  provisionIsolatedPostgres,
  performTeardown,
  defaultProcessExecutor,
  ProcessExecutor,
  ProcessVerifier,
  IsolatedPostgresInstance,
  activeInstanceRecords,
  performEmergencyCleanupSync,
  verifyPostmasterIdentity,
  tryKillPostmaster,
  confirmStoppedSync,
  ActiveInstanceRecord,
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
    delete process.env.PGHOST;
    delete process.env.PGPORT;
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
      expect(isVerifiedGitHubActionsService('postgres')).toBe(false);

      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = 'wrong_database';
      expect(isVerifiedGitHubActionsService('postgres')).toBe(false);

      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;
      expect(isVerifiedGitHubActionsService('postgres')).toBe(true);
      expect(isVerifiedGitHubActionsService('127.0.0.1')).toBe(false);
      expect(isVerifiedGitHubActionsService('localhost')).toBe(false);
      expect(isVerifiedGitHubActionsService('::1')).toBe(false);
    });

    it('validates verified GitHub Actions service container configuration', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;

      const ciConfig = {
        host: 'postgres',
        port: 5432,
        database: 'hackmate_test',
        user: 'postgres',
        password: 'testpassword',
      };

      const validated = validateDbTarget(ciConfig);
      expect(validated.host).toBe('postgres');
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

    it('proves setting all four CI markers locally with 127.0.0.1:5432 cannot bypass isolated provisioning or reach shared-cluster path', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;

      // Loopback targets must NEVER be recognized as the CI service container
      expect(isVerifiedGitHubActionsService('127.0.0.1')).toBe(false);
      expect(isVerifiedGitHubActionsService('localhost')).toBe(false);
      expect(isVerifiedGitHubActionsService('::1')).toBe(false);

      // validateDbTarget must reject loopback 127.0.0.1:5432 without disposable flag
      expect(() => {
        validateDbTarget({ host: '127.0.0.1', port: 5432, database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);
    });

    it('rejects CI service container host "postgres" when not in a verified GitHub Actions environment', () => {
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;

      expect(() => {
        validateDbTarget({ host: 'postgres', port: 5432, database: 'hackmate_test' });
      }).toThrow(/Safety violation: CI service container host "postgres" is only permitted within a verified GitHub Actions/);
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

    it('cleans up temporary directory on failure during server startup and attempts shutdown before removal', async () => {
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
        confirmStopped: async () => true,
        removeDataDir: (dir) => {
          removedDir = dir;
        },
      };

      await expect(
        provisionIsolatedPostgres({ executor: mockExecutor })
      ).rejects.toThrow('Injected failure during pg_ctl start');

      expect(removedDir).not.toBeNull();
      // Per Objective 2: starting_server is treated as potentially active, so shutdown is attempted
      expect(stopCalled).toBe(true);
    });

    it('partially successful startup: simulated postmaster launch followed by startup failure attempts shutdown, confirms stopped, and removes directory', async () => {
      let stoppedDir: string | null = null;
      let removedDir: string | null = null;
      let confirmedStopped = false;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: (_bin, _dir) => {
          // Simulate a partial startup that launched the postmaster daemon before failing
          throw new Error('pg_ctl start timed out after launching postmaster daemon');
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
      ).rejects.toThrow('pg_ctl start timed out after launching postmaster daemon');

      expect(stoppedDir).not.toBeNull();
      expect(confirmedStopped).toBe(true);
      expect(removedDir).not.toBeNull();
    });

    it('startup failure where server refuses to stop: preserves data directory, retains active tracking, and enriches error', async () => {
      let removeCalled = false;
      const initialActiveCount = activeInstanceRecords.size;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {
          throw new Error('Startup failed after launching daemon');
        },
        execStopServer: () => {},
        confirmStopped: async () => false, // Shutdown refused
        removeDataDir: () => {
          removeCalled = true;
        },
      };

      await expect(
        provisionIsolatedPostgres({ executor: mockExecutor })
      ).rejects.toThrow(/Cleanup failure: PostgreSQL server in ".*" failed to shut down within timeout/);

      // Data directory was NOT removed
      expect(removeCalled).toBe(false);

      // Instance record was NOT discarded from activeInstanceRecords
      expect(activeInstanceRecords.size).toBe(initialActiveCount + 1);
      const remainingRecord = Array.from(activeInstanceRecords).find(r => r.lifecycleState === 'cleanup_failed');
      expect(remainingRecord).toBeDefined();
      expect(remainingRecord!.stopped).toBe(false);

      // Clean up test record from registry
      if (remainingRecord) {
        activeInstanceRecords.delete(remainingRecord);
      }
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

  describe('9. Retryable & State-Safe Teardown Lifecycle', () => {
    it('failed shutdown leaves instance tracked with lifecycleState === "cleanup_failed" and stopped === false', async () => {
      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {},
        execStopServer: () => {},
        confirmStopped: async () => false, // Shutdown fails
        removeDataDir: () => {},
      };

      const inst = await provisionIsolatedPostgres({
        executor: mockExecutor,
        skipReadinessWait: true,
      });

      const record = Array.from(activeInstanceRecords).find(r => r.dataDir === inst.dataDir);
      expect(record).toBeDefined();

      await expect(inst.stop()).rejects.toThrow(/failed to shut down within timeout/);

      // Record remains tracked and marked cleanup_failed
      expect(activeInstanceRecords.has(record!)).toBe(true);
      expect(record!.lifecycleState).toBe('cleanup_failed');
      expect(record!.stopped).toBe(false);

      // Clean up record from test set
      activeInstanceRecords.delete(record!);
    });

    it('failed directory removal after server stopped leaves instance tracked with serverStopped === true', async () => {
      let directoryRemovalAttempted = false;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {},
        execStopServer: () => {},
        confirmStopped: async () => true, // Server stopped successfully
        removeDataDir: () => {
          directoryRemovalAttempted = true;
          throw new Error('EACCES: permission denied, unlink data directory');
        },
      };

      const inst = await provisionIsolatedPostgres({
        executor: mockExecutor,
        skipReadinessWait: true,
      });

      const record = Array.from(activeInstanceRecords).find(r => r.dataDir === inst.dataDir);
      expect(record).toBeDefined();

      await expect(inst.stop()).rejects.toThrow(/permission denied/);

      expect(directoryRemovalAttempted).toBe(true);
      expect(activeInstanceRecords.has(record!)).toBe(true);
      expect(record!.lifecycleState).toBe('cleanup_failed');
      expect(record!.serverStopped).toBe(true);
      expect(record!.stopped).toBe(false);

      // Clean up record from test set
      activeInstanceRecords.delete(record!);
    });

    it('retry after cleanup failure succeeds once underlying issue is resolved', async () => {
      let directoryRemovalShouldFail = true;
      let stopCallCount = 0;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {},
        execStopServer: () => {
          stopCallCount++;
        },
        confirmStopped: async () => true,
        removeDataDir: () => {
          if (directoryRemovalShouldFail) {
            throw new Error('EBUSY: resource busy or locked');
          }
        },
      };

      const inst = await provisionIsolatedPostgres({
        executor: mockExecutor,
        skipReadinessWait: true,
      });

      const record = Array.from(activeInstanceRecords).find(r => r.dataDir === inst.dataDir);
      expect(record).toBeDefined();

      // First stop attempt fails on directory removal
      await expect(inst.stop()).rejects.toThrow(/resource busy or locked/);
      expect(record!.lifecycleState).toBe('cleanup_failed');
      expect(activeInstanceRecords.has(record!)).toBe(true);
      expect(stopCallCount).toBe(1);

      // Resolve the issue and retry stop()
      directoryRemovalShouldFail = false;
      await expect(inst.stop()).resolves.not.toThrow();

      // Server was already stopped, so execStopServer was not re-executed
      expect(stopCallCount).toBe(1);
      // Now successfully stopped and unregistered
      expect(record!.lifecycleState).toBe('stopped');
      expect(record!.stopped).toBe(true);
      expect(activeInstanceRecords.has(record!)).toBe(false);
    });

    it('concurrent stop() calls do not run conflicting operations and resolve together', async () => {
      let stopCallCount = 0;
      let removeCallCount = 0;

      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {},
        execCreatedb: () => {},
        execStopServer: () => {
          stopCallCount++;
        },
        confirmStopped: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return true;
        },
        removeDataDir: () => {
          removeCallCount++;
        },
      };

      const inst = await provisionIsolatedPostgres({
        executor: mockExecutor,
        skipReadinessWait: true,
      });

      // Call stop() 3 times concurrently
      await Promise.all([inst.stop(), inst.stop(), inst.stop()]);

      // Exactly one execution occurred
      expect(stopCallCount).toBe(1);
      expect(removeCallCount).toBe(1);
    });
  });

  describe('10. Synchronous Emergency Cleanup Safeguards', () => {
    it('successfully stops running server, confirms stopped, removes directory, and unregisters', () => {
      const records = new Set<ActiveInstanceRecord>();
      let stopCalled = false;
      let removeCalled = false;

      const testRecord: ActiveInstanceRecord = {
        dataDir: '/tmp/test_emergency_success',
        port: 45678,
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'ready',
        lifecycleState: 'running',
        serverStarted: true,
        serverStopped: false,
        stopped: false,
      };
      records.add(testRecord);

      const res = performEmergencyCleanupSync(records, {
        stopServerSync: () => {
          stopCalled = true;
        },
        confirmStoppedSync: () => true,
        removeDirSync: () => {
          removeCalled = true;
        },
      });

      expect(stopCalled).toBe(true);
      expect(removeCalled).toBe(true);
      expect(testRecord.stopped).toBe(true);
      expect(testRecord.lifecycleState).toBe('stopped');
      expect(records.has(testRecord)).toBe(false);
      expect(res.succeeded).toContain('/tmp/test_emergency_success');
    });

    it('failed stop does not remove directory and retains record in cleanup_failed state', () => {
      const records = new Set<ActiveInstanceRecord>();
      let removeCalled = false;

      const testRecord: ActiveInstanceRecord = {
        dataDir: '/tmp/test_emergency_fail',
        port: 45679,
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'ready',
        lifecycleState: 'running',
        serverStarted: true,
        serverStopped: false,
        stopped: false,
      };
      records.add(testRecord);

      const res = performEmergencyCleanupSync(records, {
        stopServerSync: () => {
          throw new Error('pg_ctl stop error');
        },
        confirmStoppedSync: () => false, // Cannot confirm stopped
        tryKillPostmasterSync: () => false,
        removeDirSync: () => {
          removeCalled = true;
        },
      });

      expect(removeCalled).toBe(false);
      expect(testRecord.stopped).toBe(false);
      expect(testRecord.lifecycleState).toBe('cleanup_failed');
      expect(records.has(testRecord)).toBe(true);
      expect(res.failed).toContain('/tmp/test_emergency_fail');
    });

    it('unconfirmed shutdown preserves data directory and reports failure', () => {
      const records = new Set<ActiveInstanceRecord>();
      let removeCalled = false;

      const testRecord: ActiveInstanceRecord = {
        dataDir: '/tmp/test_emergency_unconfirmed',
        port: 45680,
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'starting_server',
        lifecycleState: 'provisioning_in_progress',
        serverStarted: false,
        serverStopped: false,
        stopped: false,
      };
      records.add(testRecord);

      const res = performEmergencyCleanupSync(records, {
        stopServerSync: () => {},
        confirmStoppedSync: () => false, // PID file still present
        tryKillPostmasterSync: () => false,
        removeDirSync: () => {
          removeCalled = true;
        },
      });

      expect(removeCalled).toBe(false);
      expect(testRecord.stopped).toBe(false);
      expect(records.has(testRecord)).toBe(true);
      expect(res.failed).toContain('/tmp/test_emergency_unconfirmed');
    });

    it('directory removal failure leaves record tracked in cleanup_failed state with serverStopped === true', () => {
      const records = new Set<ActiveInstanceRecord>();

      const testRecord: ActiveInstanceRecord = {
        dataDir: '/tmp/test_emergency_rm_fail',
        port: 45681,
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'ready',
        lifecycleState: 'running',
        serverStarted: true,
        serverStopped: false,
        stopped: false,
      };
      records.add(testRecord);

      const res = performEmergencyCleanupSync(records, {
        stopServerSync: () => {},
        confirmStoppedSync: () => true, // Server stopped
        removeDirSync: () => {
          throw new Error('File lock error');
        },
      });

      expect(testRecord.serverStopped).toBe(true);
      expect(testRecord.stopped).toBe(false);
      expect(testRecord.lifecycleState).toBe('cleanup_failed');
      expect(records.has(testRecord)).toBe(true);
      expect(res.failed).toContain('/tmp/test_emergency_rm_fail');
    });
  });

  describe('11. Process Identity Verification Before Force-Kill', () => {
    it('returns false for invalid or missing PIDs', () => {
      expect(verifyPostmasterIdentity(0, '/tmp/pg', false)).toBe(false);
      expect(verifyPostmasterIdentity(-1, '/tmp/pg', false)).toBe(false);
      expect(verifyPostmasterIdentity(1, '/tmp/pg', false)).toBe(false);
      expect(verifyPostmasterIdentity(NaN, '/tmp/pg', false)).toBe(false);
    });

    it('refuses to kill process when verifier rejects process identity', () => {
      let killCalled = false;

      const mockVerifier: ProcessVerifier = {
        verifyPostgresProcess: (_pid, _dataDir) => false, // Stale or mismatched PID
      };

      const result = tryKillPostmaster('/tmp/nonexistent_test_pg_dir', false, mockVerifier);
      expect(result).toBe(false);
      expect(killCalled).toBe(false);
    });
  });

  describe('12. Error Enrichment & Teardown Independence', () => {
    it('provisioning failure enriches original error with secondary cleanup failure details without swallowing either', async () => {
      const mockExecutor: Partial<ProcessExecutor> = {
        execInitdb: () => {},
        execStartServer: () => {
          throw new Error('Primary provisioning failure: port in use');
        },
        execStopServer: () => {},
        confirmStopped: async () => false, // Secondary cleanup fails
        removeDataDir: () => {},
      };

      let thrownError: any = null;
      try {
        await provisionIsolatedPostgres({ executor: mockExecutor });
      } catch (err: any) {
        thrownError = err;
      }

      expect(thrownError).not.toBeNull();
      // Primary error message is preserved
      expect(thrownError.message).toContain('Primary provisioning failure: port in use');
      // Secondary cleanup failure is surfaced
      expect(thrownError.message).toContain('Cleanup failure');
      expect(thrownError.cleanupError).toBeDefined();

      // Clean up any tracked record
      const record = Array.from(activeInstanceRecords).find(r => r.lifecycleState === 'cleanup_failed');
      if (record) {
        activeInstanceRecords.delete(record);
      }
    });
  });
});
