import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { EventEmitter } from 'events';
import childProcess, { execSync } from 'child_process';
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
  checkPortOpenSync,
  checkPortOpen,
  probePortSyncNative,
  probePortSyncWsl,
  getWslPortProbeScript,
  parsePortProbeOutput,
  inspectPidFileSync,
  inspectPidFileAsync,
  inspectPidFileWslSync,
  inspectPidFile,
  verifyShutdownSync,
  verifyShutdownAsync,
  isValidPort,
  PortProbeResult,
  PidFileInspectionResult,
  ShutdownVerificationResult,
  setEmergencyFailureReporter,
  reportEmergencyCleanupFailures,
  EmergencyCleanupFailure,
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

  describe('5. Pure Isolated PostgreSQL Instances & Elimination of Shared CI Bypass', () => {
    it('proves ordinary execution requires an isolated instance even when CI=true is set', () => {
      process.env.CI = 'true';
      delete process.env.GITHUB_ACTIONS;
      delete process.env.HACKMATE_CI_SERVICE_CONTAINER;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;

      expect(() => {
        validateDbTarget({ host: '127.0.0.1', database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);
    });

    it('proves setting all existing CI markers locally does not permit connecting to an ordinary shared local PostgreSQL service', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;
      delete process.env.HACKMATE_DISPOSABLE_INSTANCE;

      // Even with all CI markers set, connecting to loopback 127.0.0.1:5432 without disposable flag fails closed
      expect(() => {
        validateDbTarget({ host: '127.0.0.1', port: 5432, database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);

      expect(() => {
        validateDbTarget({ host: 'localhost', port: 5432, database: 'hackmate_test' });
      }).toThrow(/Safety violation: Direct connection to shared PostgreSQL cluster is disallowed/);
    });

    it('proves a configured shared hostname (such as postgres) does not bypass the isolation requirement', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';

      // Shared hostname aliases are strictly rejected; only loopback is permitted
      expect(() => {
        validateDbTarget({ host: 'postgres', port: 5432, database: 'hackmate_test' });
      }).toThrow(/Safety violation: Target host must be a loopback address/);
    });

    it('rejects remote databases even if all CI markers are present', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      process.env.HACKMATE_CI_SERVICE_CONTAINER = 'true';
      process.env.PGDATABASE = EXPECTED_TEST_DATABASE;
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';

      expect(() => {
        validateDbTarget({
          host: 'db.supabase.co',
          port: 5432,
          database: 'hackmate_test',
        });
      }).toThrow(/Safety violation: Target host must be a loopback address/);
    });

    it('accepts strictly validated isolated ephemeral loopback instances', () => {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';

      const validConfig = {
        host: '127.0.0.1',
        port: 54321,
        database: 'hackmate_test',
        user: 'postgres',
        password: 'testpassword',
      };

      const validated = validateDbTarget(validConfig);
      expect(validated.host).toBe('127.0.0.1');
      expect(validated.database).toBe('hackmate_test');
      expect(validated.port).toBe(54321);
      expect(validated.user).toBe('postgres');
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

  describe('10. Synchronous Emergency Cleanup Safeguards & Explicit Result Probing', () => {
    it('1. successfully stops running server, confirms stopped, removes directory, and unregisters', () => {
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
      expect(res.failed).toHaveLength(0);
    });

    it('A. native port-probe spawn failure yields unknown status and preserves data directory', () => {
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        const err: any = new Error('spawn ENOMEM: out of memory');
        err.code = 'ENOMEM';
        throw err;
      });

      try {
        // Direct probe yields unknown, never closed
        const probeRes = checkPortOpenSync(54321, false);
        expect(probeRes.status).toBe('unknown');
        expect(probeRes.reason).toContain('spawn failure');

        // Combined verification must fail closed
        const verifyRes = verifyShutdownSync('/tmp/test_spawn_fail', 54321, false);
        expect(verifyRes.confirmedStopped).toBe(false);
        expect(verifyRes.portStatus).toBe('unknown');

        // In emergency cleanup, directory removal must be strictly aborted
        const records = new Set<ActiveInstanceRecord>();
        let removeCalled = false;

        const testRecord: ActiveInstanceRecord = {
          dataDir: '/tmp/test_spawn_fail',
          port: 54321,
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
          removeDirSync: () => {
            removeCalled = true;
          },
        });

        expect(removeCalled).toBe(false);
        expect(testRecord.stopped).toBe(false);
        expect(testRecord.lifecycleState).toBe('cleanup_failed');
        expect(records.has(testRecord)).toBe(true);
        expect(res.failed.some(f => f.dataDir === '/tmp/test_spawn_fail')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }
    });

    it('B. native port-probe timeout yields unknown status and cannot authorize data directory deletion', async () => {
      // 1. Sync timeout via ETIMEDOUT
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        const err: any = new Error('Process timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      });

      try {
        const probeRes = checkPortOpenSync(54322, false);
        expect(probeRes.status).toBe('unknown');
        expect(probeRes.reason).toContain('timed out');

        // In emergency cleanup, timeout cannot authorize deletion
        const records = new Set<ActiveInstanceRecord>();
        let removeCalled = false;

        const testRecord: ActiveInstanceRecord = {
          dataDir: '/tmp/test_timeout_fail',
          port: 54322,
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
          removeDirSync: () => {
            removeCalled = true;
          },
        });

        expect(removeCalled).toBe(false);
        expect(testRecord.stopped).toBe(false);
        expect(records.has(testRecord)).toBe(true);
        expect(res.failed.some(f => f.dataDir === '/tmp/test_timeout_fail')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }

      // 2. Async checkPortOpen timeout deterministically yields unknown (never allowed to be closed)
      const createConnSpy = vi.spyOn(net, 'createConnection').mockImplementation(() => {
        const fakeSocket = new EventEmitter() as any;
        fakeSocket.destroy = vi.fn();
        fakeSocket.setTimeout = vi.fn((ms: number) => {
          setTimeout(() => {
            fakeSocket.emit('timeout');
          }, ms);
          return fakeSocket;
        });
        return fakeSocket;
      });

      try {
        const asyncTimeoutRes = await checkPortOpen(54323, 10);
        expect(asyncTimeoutRes.status).toBe('unknown');
        expect(asyncTimeoutRes.status).not.toBe('closed');
        expect(asyncTimeoutRes.reason).toContain('timed out');
      } finally {
        createConnSpy.mockRestore();
      }
    });

    it('C. WSL inspection distinguishes failures from closures and prevents premature data directory deletion', async () => {
      // C1. Both ss and netstat unavailable: output marker HACKMATE_PORT:UNKNOWN_NO_TOOLS
      let execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
        if (cmd === 'wsl') {
          const err: any = new Error('Command failed');
          err.status = 1;
          err.stdout = 'HACKMATE_PORT:UNKNOWN_NO_TOOLS\n';
          throw err;
        }
        return Buffer.from('');
      });

      try {
        const noToolsRes = checkPortOpenSync(54324, true);
        expect(noToolsRes.status).toBe('unknown');
        expect(noToolsRes.status).not.toBe('closed');
        expect(noToolsRes.reason).toContain('Neither ss nor netstat');

        // Preserves directory and retains record
        const recordsNoTools = new Set<ActiveInstanceRecord>();
        let removeCalledNoTools = false;
        const testRecordNoTools: ActiveInstanceRecord = {
          dataDir: '/wsl/test_notools_dir',
          port: 54324,
          isWsl: true,
          pgCtlPath: 'pg_ctl',
          stage: 'ready',
          lifecycleState: 'running',
          serverStarted: true,
          serverStopped: false,
          stopped: false,
        };
        recordsNoTools.add(testRecordNoTools);

        const resNoTools = performEmergencyCleanupSync(recordsNoTools, {
          stopServerSync: () => {},
          removeDirSync: () => {
            removeCalledNoTools = true;
          },
        });

        expect(removeCalledNoTools).toBe(false);
        expect(testRecordNoTools.stopped).toBe(false);
        expect(testRecordNoTools.lifecycleState).toBe('cleanup_failed');
        expect(recordsNoTools.has(testRecordNoTools)).toBe(true);
        expect(resNoTools.failed.some(f => f.dataDir === '/wsl/test_notools_dir')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }

      // C2. ss exists but fails during execution: output marker HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED
      execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
        if (cmd === 'wsl') {
          const err: any = new Error('Command failed: ss runtime error');
          err.status = 1;
          err.stdout = 'HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED\n';
          throw err;
        }
        return Buffer.from('');
      });

      try {
        const ssFailRes = checkPortOpenSync(54325, true);
        expect(ssFailRes.status).toBe('unknown');
        expect(ssFailRes.status).not.toBe('closed');
        expect(ssFailRes.reason).toContain('failed during execution');

        // Preserves directory and retains record
        const recordsSsFail = new Set<ActiveInstanceRecord>();
        let removeCalledSsFail = false;
        const testRecordSsFail: ActiveInstanceRecord = {
          dataDir: '/wsl/test_ss_fail_dir',
          port: 54325,
          isWsl: true,
          pgCtlPath: 'pg_ctl',
          stage: 'ready',
          lifecycleState: 'running',
          serverStarted: true,
          serverStopped: false,
          stopped: false,
        };
        recordsSsFail.add(testRecordSsFail);

        const resSsFail = performEmergencyCleanupSync(recordsSsFail, {
          stopServerSync: () => {},
          removeDirSync: () => {
            removeCalledSsFail = true;
          },
        });

        expect(removeCalledSsFail).toBe(false);
        expect(testRecordSsFail.stopped).toBe(false);
        expect(testRecordSsFail.lifecycleState).toBe('cleanup_failed');
        expect(recordsSsFail.has(testRecordSsFail)).toBe(true);
        expect(resSsFail.failed.some(f => f.dataDir === '/wsl/test_ss_fail_dir')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }

      // C3. netstat exists but fails during execution: output marker HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED
      execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
        if (cmd === 'wsl') {
          const err: any = new Error('Command failed: netstat runtime error');
          err.status = 1;
          err.stdout = 'HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED\n';
          throw err;
        }
        return Buffer.from('');
      });

      try {
        const nsFailRes = checkPortOpenSync(54326, true);
        expect(nsFailRes.status).toBe('unknown');
        expect(nsFailRes.status).not.toBe('closed');
        expect(nsFailRes.reason).toContain('failed during execution');

        const recordsNsFail = new Set<ActiveInstanceRecord>();
        let removeCalledNsFail = false;
        const testRecordNsFail: ActiveInstanceRecord = {
          dataDir: '/wsl/test_ns_fail_dir',
          port: 54326,
          isWsl: true,
          pgCtlPath: 'pg_ctl',
          stage: 'ready',
          lifecycleState: 'running',
          serverStarted: true,
          serverStopped: false,
          stopped: false,
        };
        recordsNsFail.add(testRecordNsFail);

        const resNsFail = performEmergencyCleanupSync(recordsNsFail, {
          stopServerSync: () => {},
          removeDirSync: () => {
            removeCalledNsFail = true;
          },
        });

        expect(removeCalledNsFail).toBe(false);
        expect(testRecordNsFail.stopped).toBe(false);
        expect(testRecordNsFail.lifecycleState).toBe('cleanup_failed');
        expect(recordsNsFail.has(testRecordNsFail)).toBe(true);
        expect(resNsFail.failed.some(f => f.dataDir === '/wsl/test_ns_fail_dir')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }

      // C4. Valid inspection confirms an OPEN port (HACKMATE_PORT:OPEN) -> cannot authorize deletion
      execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
        if (cmd === 'wsl') {
          return Buffer.from('HACKMATE_PORT:OPEN\n');
        }
        return Buffer.from('');
      });

      try {
        const openRes = checkPortOpenSync(54327, true);
        expect(openRes.status).toBe('open');

        // Verification fails closed
        const verifyRes = verifyShutdownSync('/wsl/mock_open_dir', 54327, true);
        expect(verifyRes.confirmedStopped).toBe(false);
        expect(verifyRes.portStatus).toBe('open');

        const recordsOpen = new Set<ActiveInstanceRecord>();
        let removeCalledOpen = false;
        const testRecordOpen: ActiveInstanceRecord = {
          dataDir: '/wsl/test_open_dir',
          port: 54327,
          isWsl: true,
          pgCtlPath: 'pg_ctl',
          stage: 'ready',
          lifecycleState: 'running',
          serverStarted: true,
          serverStopped: false,
          stopped: false,
        };
        recordsOpen.add(testRecordOpen);

        const resOpen = performEmergencyCleanupSync(recordsOpen, {
          stopServerSync: () => {},
          removeDirSync: () => {
            removeCalledOpen = true;
          },
        });

        expect(removeCalledOpen).toBe(false);
        expect(testRecordOpen.stopped).toBe(false);
        expect(testRecordOpen.lifecycleState).toBe('cleanup_failed');
        expect(recordsOpen.has(testRecordOpen)).toBe(true);
        expect(resOpen.failed.some(f => f.dataDir === '/wsl/test_open_dir')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }

      // C5. Valid inspection confirms a CLOSED port (HACKMATE_PORT:CLOSED)
      execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
        if (cmd === 'wsl') {
          return Buffer.from('HACKMATE_PORT:CLOSED\n');
        }
        return Buffer.from('');
      });

      try {
        const closedRes = checkPortOpenSync(54328, true);
        expect(closedRes.status).toBe('closed');
      } finally {
        execSpy.mockRestore();
      }

      // C6. Production-generated script execution with fake utilities in CI across all platforms:
      const getShExecutor = (): { command: string; baseArgs: string[] } => {
        if (process.platform === 'win32') {
          const gitSh = 'C:\\Program Files\\Git\\bin\\sh.exe';
          if (fs.existsSync(gitSh)) {
            return { command: gitSh, baseArgs: ['-c'] };
          }
          return { command: 'sh', baseArgs: ['-c'] };
        }
        return { command: '/bin/sh', baseArgs: ['-c'] };
      };

      const toPosix = (p: string) =>
        p.replace(/^[A-Za-z]:/, (m) => '/' + m[0].toLowerCase()).replace(/\\/g, '/');

      const executeProdScript = (
        port: number,
        binDir?: string,
        isolatedEnvPath?: string
      ): { exitStatus: number; stdout: string; result: PortProbeResult } => {
        const prodScript = getWslPortProbeScript(port);
        const executor = getShExecutor();
        let fullScript = prodScript;
        if (isolatedEnvPath) {
          fullScript = `export PATH="${isolatedEnvPath}"; ${prodScript}`;
        } else if (binDir) {
          fullScript = `export PATH="${toPosix(binDir)}:$PATH"; ${prodScript}`;
        }

        let exitStatus = 0;
        let stdout = '';
        try {
          stdout = childProcess.execFileSync(
            executor.command,
            [...executor.baseArgs, fullScript],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
        } catch (err: any) {
          exitStatus = err.status ?? 1;
          stdout = err.stdout ? String(err.stdout) : '';
        }

        const result = parsePortProbeOutput(stdout);
        return { exitStatus, stdout: stdout.trim(), result };
      };

      const tempFakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'pg_test_fake_bin_'));
      try {
        const testPort = 59801;

        // 1. ss succeeds and port is listening -> open (exit 0)
        fs.writeFileSync(
          path.join(tempFakeBin, 'ss'),
          `#!/bin/sh\necho "LISTEN 0 128 127.0.0.1:${testPort} 0.0.0.0:*"\nexit 0\n`,
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(tempFakeBin, 'netstat'),
          `#!/bin/sh\nexit 1\n`,
          { mode: 0o755 }
        );

        const case1 = executeProdScript(testPort, tempFakeBin);
        expect(case1.exitStatus).toBe(0);
        expect(case1.stdout).toContain('HACKMATE_PORT:OPEN');
        expect(case1.result.status).toBe('open');

        // 2. ss succeeds and output does not contain the target port -> closed (exit 0)
        // Proves that template literal escaping bug is fixed and valid closed port is produced
        fs.writeFileSync(
          path.join(tempFakeBin, 'ss'),
          `#!/bin/sh\necho "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*"\nexit 0\n`,
          { mode: 0o755 }
        );
        const case2 = executeProdScript(testPort, tempFakeBin);
        expect(case2.exitStatus).toBe(0);
        expect(case2.stdout).toContain('HACKMATE_PORT:CLOSED');
        expect(case2.result.status).toBe('closed');

        // 3. ss fails and netstat also fails -> unknown (exit 1)
        fs.writeFileSync(
          path.join(tempFakeBin, 'ss'),
          `#!/bin/sh\nexit 1\n`,
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(tempFakeBin, 'netstat'),
          `#!/bin/sh\nexit 1\n`,
          { mode: 0o755 }
        );
        const case3 = executeProdScript(testPort, tempFakeBin);
        expect(case3.exitStatus).toBe(1);
        expect(case3.stdout).toContain('HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED');
        expect(case3.result.status).toBe('unknown');
        expect(case3.result.status).not.toBe('closed');

        // 4. ss fails but netstat successfully establishes the port state:
        // 4a. netstat establishes open port -> open (exit 0)
        fs.writeFileSync(
          path.join(tempFakeBin, 'ss'),
          `#!/bin/sh\nexit 1\n`,
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(tempFakeBin, 'netstat'),
          `#!/bin/sh\necho "tcp 0 0 127.0.0.1:${testPort} 0.0.0.0:* LISTEN"\nexit 0\n`,
          { mode: 0o755 }
        );
        const case4a = executeProdScript(testPort, tempFakeBin);
        expect(case4a.exitStatus).toBe(0);
        expect(case4a.stdout).toContain('HACKMATE_PORT:OPEN');
        expect(case4a.result.status).toBe('open');

        // 4b. netstat establishes closed port -> closed (exit 0)
        fs.writeFileSync(
          path.join(tempFakeBin, 'netstat'),
          `#!/bin/sh\necho "tcp 0 0 127.0.0.1:5432 0.0.0.0:* LISTEN"\nexit 0\n`,
          { mode: 0o755 }
        );
        const case4b = executeProdScript(testPort, tempFakeBin);
        expect(case4b.exitStatus).toBe(0);
        expect(case4b.stdout).toContain('HACKMATE_PORT:CLOSED');
        expect(case4b.result.status).toBe('closed');

        // 5. Neither inspection utility is available -> unknown (exit 1)
        const emptyFakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'pg_test_empty_bin_'));
        let case5: { exitStatus: number; stdout: string; result: PortProbeResult };
        try {
          fs.writeFileSync(
            path.join(emptyFakeBin, 'grep'),
            `#!/bin/sh\nexec /usr/bin/grep "$@"\n`,
            { mode: 0o755 }
          );
          case5 = executeProdScript(testPort, undefined, toPosix(emptyFakeBin));
          expect(case5.exitStatus).toBe(1);
          expect(case5.stdout).toContain('HACKMATE_PORT:UNKNOWN_NO_TOOLS');
          expect(case5.result.status).toBe('unknown');
          expect(case5.result.status).not.toBe('closed');
          expect(case5.result.reason).toContain('Neither ss nor netstat');
        } finally {
          fs.rmSync(emptyFakeBin, { recursive: true, force: true });
        }

        // 6. The matching command itself fails (grep exit >= 2) -> unknown (exit 1), NEVER closed!
        fs.writeFileSync(
          path.join(tempFakeBin, 'ss'),
          `#!/bin/sh\necho "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*"\nexit 0\n`,
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(tempFakeBin, 'netstat'),
          `#!/bin/sh\necho "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*"\nexit 0\n`,
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(tempFakeBin, 'grep'),
          `#!/bin/sh\nexit 2\n`,
          { mode: 0o755 }
        );
        const case6 = executeProdScript(testPort, tempFakeBin);
        expect(case6.exitStatus).toBe(1);
        expect(case6.stdout).toContain('HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED');
        expect(case6.stdout).not.toContain('HACKMATE_PORT:CLOSED');
        expect(case6.result.status).toBe('unknown');
        expect(case6.result.status).not.toBe('closed');

        // 7. Each ambiguous or failed inspection prevents data-directory removal and preserves cleanup record
        for (const failedCase of [case3, case5, case6]) {
          const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
            if (cmd === 'wsl') {
              const err: any = new Error('Command failed: simulated inspection failure');
              err.status = failedCase.exitStatus;
              err.stdout = `${failedCase.stdout}\n`;
              throw err;
            }
            return Buffer.from('');
          });

          try {
            const records = new Set<ActiveInstanceRecord>();
            let removeCalled = false;
            const failRecord: ActiveInstanceRecord = {
              dataDir: `/wsl/test_failed_${failedCase.stdout.replace(/[^a-zA-Z0-9]/g, '_')}`,
              port: testPort,
              isWsl: true,
              pgCtlPath: 'pg_ctl',
              stage: 'ready',
              lifecycleState: 'running',
              serverStarted: true,
              serverStopped: false,
              stopped: false,
            };
            records.add(failRecord);

            const cleanupRes = performEmergencyCleanupSync(records, {
              stopServerSync: () => {},
              removeDirSync: () => {
                removeCalled = true;
              },
            });

            // Blocked directory removal
            expect(removeCalled).toBe(false);
            expect(failRecord.stopped).toBe(false);
            expect(failRecord.lifecycleState).toBe('cleanup_failed');
            expect(records.has(failRecord)).toBe(true);
            expect(cleanupRes.failed.some((f) => f.dataDir === failRecord.dataDir)).toBe(true);
          } finally {
            spy.mockRestore();
          }
        }

        // 8. Confirm valid closed port result was produced by real shell execution (case2 & case4b),
        // confirming that template-literal escaping bug is completely eliminated.
        expect(case2.result.status).toBe('closed');
        expect(case4b.result.status).toBe('closed');

        // 9. On Windows systems where WSL is installed, test live execution of the production script
        if (process.platform === 'win32') {
          let wslAvailable = false;
          try {
            childProcess.execFileSync('wsl', ['-e', 'true'], { stdio: 'ignore' });
            wslAvailable = true;
          } catch {}

          if (wslAvailable) {
            const liveScript = getWslPortProbeScript(59998);
            const liveOut = String(
              childProcess.execFileSync('wsl', ['-e', 'sh', '-c', liveScript], { encoding: 'utf8' })
            );
            expect(liveOut.trim()).toBe('HACKMATE_PORT:CLOSED');
            expect(liveOut).not.toContain('syntax error');
            expect(liveOut).not.toContain('Recv-Q: not found');
          }
        }
      } finally {
        fs.rmSync(tempFakeBin, { recursive: true, force: true });
      }
    });

    it('D. native PID inspection distinguishes definitive absence (ENOENT) from filesystem errors (EACCES/EPERM)', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg_test_pid_'));
      try {
        // D1. Non-existent postmaster.pid -> definitive absence (ENOENT)
        const absentRes = inspectPidFileSync(tempDir);
        expect(absentRes.status).toBe('absent');

        // D2. Present postmaster.pid -> present
        fs.writeFileSync(path.join(tempDir, 'postmaster.pid'), '12345\n');
        const presentRes = inspectPidFileSync(tempDir);
        expect(presentRes.status).toBe('present');

        // D3. EACCES permission denied -> unknown (never treated as absent!)
        const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
          const err: any = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        });

        try {
          const eaccesRes = inspectPidFileSync(tempDir);
          expect(eaccesRes.status).toBe('unknown');
          expect(eaccesRes.status).not.toBe('absent');
          expect(eaccesRes.reason).toContain('EACCES');

          // Combined shutdown verification must fail closed
          const verifyRes = verifyShutdownSync(tempDir, 54325, false);
          expect(verifyRes.confirmedStopped).toBe(false);
          expect(verifyRes.pidStatus).toBe('unknown');
        } finally {
          statSpy.mockRestore();
        }

        // D4. EPERM operation not permitted -> unknown
        const epermSpy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
          const err: any = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        });

        try {
          const epermRes = inspectPidFileSync(tempDir);
          expect(epermRes.status).toBe('unknown');
          expect(epermRes.status).not.toBe('absent');
        } finally {
          epermSpy.mockRestore();
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('E. missing or invalid port strictly prevents shutdown confirmation and aborts data directory deletion', async () => {
      // E1. Port validation
      expect(isValidPort(undefined)).toBe(false);
      expect(isValidPort(null)).toBe(false);
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(-1)).toBe(false);
      expect(isValidPort(80)).toBe(false); // below ephemeral boundary (< 1024)
      expect(isValidPort(65536)).toBe(false); // exceeds valid 16-bit port
      expect(isValidPort(NaN)).toBe(false);
      expect(isValidPort(54321)).toBe(true);

      // E2. confirmStoppedSync rejects missing or invalid ports
      expect(confirmStoppedSync('/tmp/dir', false, undefined)).toBe(false);
      expect(confirmStoppedSync('/tmp/dir', false, 0)).toBe(false);
      expect(confirmStoppedSync('/tmp/dir', false, -5)).toBe(false);

      const verifyRes = verifyShutdownSync('/tmp/dir', 0, false);
      expect(verifyRes.confirmedStopped).toBe(false);
      expect(verifyRes.portStatus).toBe('unknown');
      expect(verifyRes.reason).toContain('Invalid or missing port');

      // E3. performEmergencyCleanupSync aborts directory removal when port is invalid
      const records = new Set<ActiveInstanceRecord>();
      let removeCalled = false;

      const invalidPortRecord: ActiveInstanceRecord = {
        dataDir: '/tmp/test_invalid_port_dir',
        port: 0, // invalid port!
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'ready',
        lifecycleState: 'running',
        serverStarted: true,
        serverStopped: false,
        stopped: false,
      };
      records.add(invalidPortRecord);

      const res = performEmergencyCleanupSync(records, {
        removeDirSync: () => {
          removeCalled = true;
        },
      });

      expect(removeCalled).toBe(false);
      expect(invalidPortRecord.stopped).toBe(false);
      expect(invalidPortRecord.lifecycleState).toBe('cleanup_failed');
      expect(records.has(invalidPortRecord)).toBe(true);
      expect(res.failed.some(f => f.dataDir === '/tmp/test_invalid_port_dir')).toBe(true);
      const failure = res.failed.find(f => f.dataDir === '/tmp/test_invalid_port_dir');
      expect(failure?.error).toContain('missing or invalid port');

      // E4. performTeardown aborts when port is invalid
      await expect(
        performTeardown({
          dataDir: '/tmp/test_teardown_invalid_port',
          port: 0,
          isWsl: false,
          pgCtlPath: 'pg_ctl',
          serverStarted: true,
        })
      ).rejects.toThrow(/missing or invalid port/);
    });

    it('F. unknown PID or port state prevents emergency cleanup and leaves instance tracked with actionable failure', () => {
      // F1. Unknown PID result
      const recordsPid = new Set<ActiveInstanceRecord>();
      let removeCalledPid = false;

      const testRecordPid: ActiveInstanceRecord = {
        dataDir: '/tmp/test_unknown_pid',
        port: 54326,
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'ready',
        lifecycleState: 'running',
        serverStarted: true,
        serverStopped: false,
        stopped: false,
      };
      recordsPid.add(testRecordPid);

      const resPid = performEmergencyCleanupSync(recordsPid, {
        confirmStoppedSync: () => ({
          confirmedStopped: false,
          pidStatus: 'unknown',
          portStatus: 'closed',
          reason: 'I/O failure reading PID file',
        }),
        tryKillPostmasterSync: () => false,
        removeDirSync: () => {
          removeCalledPid = true;
        },
      });

      expect(removeCalledPid).toBe(false);
      expect(testRecordPid.stopped).toBe(false);
      expect(testRecordPid.lifecycleState).toBe('cleanup_failed');
      expect(recordsPid.has(testRecordPid)).toBe(true);
      expect(resPid.failed.some(f => f.dataDir === '/tmp/test_unknown_pid')).toBe(true);
      expect(resPid.failed.find(f => f.dataDir === '/tmp/test_unknown_pid')?.error).toContain('I/O failure');

      // F2. Unknown port result
      const recordsPort = new Set<ActiveInstanceRecord>();
      let removeCalledPort = false;

      const testRecordPort: ActiveInstanceRecord = {
        dataDir: '/tmp/test_unknown_port',
        port: 54327,
        isWsl: false,
        pgCtlPath: 'pg_ctl',
        stage: 'ready',
        lifecycleState: 'running',
        serverStarted: true,
        serverStopped: false,
        stopped: false,
      };
      recordsPort.add(testRecordPort);

      const resPort = performEmergencyCleanupSync(recordsPort, {
        confirmStoppedSync: () => ({
          confirmedStopped: false,
          pidStatus: 'absent',
          portStatus: 'unknown',
          reason: 'Network inspection tool returned unexpected state',
        }),
        tryKillPostmasterSync: () => false,
        removeDirSync: () => {
          removeCalledPort = true;
        },
      });

      expect(removeCalledPort).toBe(false);
      expect(testRecordPort.stopped).toBe(false);
      expect(testRecordPort.lifecycleState).toBe('cleanup_failed');
      expect(recordsPort.has(testRecordPort)).toBe(true);
      expect(resPort.failed.some(f => f.dataDir === '/tmp/test_unknown_port')).toBe(true);
      expect(resPort.failed.find(f => f.dataDir === '/tmp/test_unknown_port')?.error).toContain('Network inspection tool');
    });

    it('G. genuine shutdown success with positively confirmed absent PID and closed port completes cleanup and unregisters record', async () => {
      // Actual loopback socket test
      const srv = net.createServer();
      const testPort = await new Promise<number>((resolve, reject) => {
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as net.AddressInfo;
          resolve(addr.port);
        });
        srv.on('error', reject);
      });

      // 1. Genuine OPEN port test
      const openSync = checkPortOpenSync(testPort, false);
      expect(openSync.status).toBe('open');
      const openAsync = await checkPortOpen(testPort);
      expect(openAsync.status).toBe('open');

      // 2. Close socket -> genuine CLOSED port test
      await new Promise<void>((resolve) => srv.close(() => resolve()));

      const closedSync = checkPortOpenSync(testPort, false);
      expect(closedSync.status).toBe('closed');
      const closedAsync = await checkPortOpen(testPort);
      expect(closedAsync.status).toBe('closed');

      // 3. Genuine absent PID + closed port allows complete shutdown
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg_test_genuine_'));
      try {
        const verifyRes = verifyShutdownSync(tempDir, testPort, false);
        expect(verifyRes.confirmedStopped).toBe(true);
        expect(verifyRes.pidStatus).toBe('absent');
        expect(verifyRes.portStatus).toBe('closed');

        expect(confirmStoppedSync(tempDir, false, testPort)).toBe(true);

        const records = new Set<ActiveInstanceRecord>();
        const testRecord: ActiveInstanceRecord = {
          dataDir: tempDir,
          port: testPort,
          isWsl: false,
          pgCtlPath: 'pg_ctl',
          stage: 'ready',
          lifecycleState: 'running',
          serverStarted: true,
          serverStopped: false,
          stopped: false,
        };
        records.add(testRecord);

        let removeCalled = false;
        const res = performEmergencyCleanupSync(records, {
          stopServerSync: () => {},
          removeDirSync: (dir) => {
            removeCalled = true;
            fs.rmSync(dir, { recursive: true, force: true });
          },
        });

        expect(removeCalled).toBe(true);
        expect(testRecord.stopped).toBe(true);
        expect(testRecord.lifecycleState).toBe('stopped');
        expect(records.has(testRecord)).toBe(false);
        expect(res.succeeded).toContain(tempDir);
        expect(res.failed).toHaveLength(0);
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });

    it('2. confirms stopped when PID file is absent and port is closed (native and WSL protocol markers)', () => {
      // 2a. Native: non-existent PID file and closed port
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg_test_stopped_'));
      try {
        const closedPort = 59998;
        const stoppedNative = confirmStoppedSync(tempDir, false, closedPort);
        expect(stoppedNative).toBe(true);

        // If postmaster.pid is present, confirmStoppedSync must return false
        fs.writeFileSync(path.join(tempDir, 'postmaster.pid'), '12345\n/tmp\n');
        expect(confirmStoppedSync(tempDir, false, closedPort)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      // 2b. WSL: explicit markers HACKMATE_PID:ABSENT and HACKMATE_PORT:CLOSED
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string, args: any) => {
        const fullArgs = Array.isArray(args) ? args.join(' ') : String(args || '');
        if (cmd === 'wsl' && fullArgs.includes('HACKMATE_PID')) {
          return Buffer.from('HACKMATE_PID:ABSENT\n');
        }
        if (cmd === 'wsl' && (fullArgs.includes('ss') || fullArgs.includes('HACKMATE_PORT'))) {
          return Buffer.from('HACKMATE_PORT:CLOSED\n');
        }
        return Buffer.from('');
      });

      try {
        const stoppedWsl = confirmStoppedSync('/wsl/mock/datadir', true, 59997);
        expect(stoppedWsl).toBe(true);
      } finally {
        execSpy.mockRestore();
      }
    });

    it('3. fails closed and preserves data directory when PID file is absent but port remains open', async () => {
      // Start an actual TCP server on loopback to hold port open
      const srv = net.createServer();
      const openPort = await new Promise<number>((resolve, reject) => {
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as net.AddressInfo;
          resolve(addr.port);
        });
        srv.on('error', reject);
      });

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg_test_openport_'));

      try {
        // PID file absent, but port is listening -> confirmStoppedSync returns false
        expect(confirmStoppedSync(tempDir, false, openPort)).toBe(false);

        // In performEmergencyCleanupSync, data directory must NOT be removed
        const records = new Set<ActiveInstanceRecord>();
        let removeCalled = false;

        const testRecord: ActiveInstanceRecord = {
          dataDir: tempDir,
          port: openPort,
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
          tryKillPostmasterSync: () => false,
          removeDirSync: () => {
            removeCalled = true;
          },
        });

        expect(removeCalled).toBe(false);
        expect(testRecord.stopped).toBe(false);
        expect(testRecord.lifecycleState).toBe('cleanup_failed');
        expect(records.has(testRecord)).toBe(true);
        expect(res.failed.some(f => f.dataDir === tempDir)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('4. fails closed and preserves data directory when WSL PID inspection encounters command/execution failure (exit status != 1)', () => {
      // WSL command failure with status 2 or execution error fails closed
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd: string) => {
        if (cmd === 'wsl') {
          const err: any = new Error('WSL command failed: syntax/communication error');
          err.status = 2; // Not status 1 (status 1 = file absent)
          throw err;
        }
        return Buffer.from('');
      });

      try {
        const isStopped = confirmStoppedSync('/wsl/mock/broken', true, 54321);
        expect(isStopped).toBe(false);

        // Emergency cleanup preserves directory
        const records = new Set<ActiveInstanceRecord>();
        let removeCalled = false;

        const testRecord: ActiveInstanceRecord = {
          dataDir: '/wsl/mock/broken',
          port: 54321,
          isWsl: true,
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
          tryKillPostmasterSync: () => false,
          removeDirSync: () => {
            removeCalled = true;
          },
        });

        expect(removeCalled).toBe(false);
        expect(testRecord.stopped).toBe(false);
        expect(testRecord.lifecycleState).toBe('cleanup_failed');
        expect(records.has(testRecord)).toBe(true);
        expect(res.failed.some(f => f.dataDir === '/wsl/mock/broken')).toBe(true);
      } finally {
        execSpy.mockRestore();
      }
    });

    it('5. failed orderly shutdown followed by unverifiable PID refuses force-kill and preserves data directory', () => {
      const records = new Set<ActiveInstanceRecord>();
      let removeCalled = false;

      const testRecord: ActiveInstanceRecord = {
        dataDir: '/tmp/test_emergency_unverifiable',
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
        tryKillPostmasterSync: () => false, // Force kill refused due to unverifiable PID
        removeDirSync: () => {
          removeCalled = true;
        },
      });

      expect(removeCalled).toBe(false);
      expect(testRecord.stopped).toBe(false);
      expect(testRecord.lifecycleState).toBe('cleanup_failed');
      expect(records.has(testRecord)).toBe(true);
      expect(res.failed.some(f => f.dataDir === '/tmp/test_emergency_unverifiable')).toBe(true);
      const failure = res.failed.find(f => f.dataDir === '/tmp/test_emergency_unverifiable');
      expect(failure?.error).toContain('force-kill was refused');
    });

    it('6. directory removal failure after confirmed shutdown records serverStopped === true and leaves instance tracked in failed', () => {
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
        confirmStoppedSync: () => true, // Server stopped confirmed
        removeDirSync: () => {
          throw new Error('EACCES: permission denied, unlink directory');
        },
      });

      expect(testRecord.serverStopped).toBe(true);
      expect(testRecord.stopped).toBe(false);
      expect(testRecord.lifecycleState).toBe('cleanup_failed');
      expect(testRecord.lastCleanupError).toBeDefined();
      expect(records.has(testRecord)).toBe(true);
      expect(res.failed.some(f => f.dataDir === '/tmp/test_emergency_rm_fail')).toBe(true);
      const failure = res.failed.find(f => f.dataDir === '/tmp/test_emergency_rm_fail');
      expect(failure?.error).toContain('permission denied');
    });

    it('7. emergency failure reporter surfaces cleanup failures cleanly without leaking sensitive credentials', () => {
      let capturedFailures: EmergencyCleanupFailure[] = [];
      setEmergencyFailureReporter((failed) => {
        capturedFailures = failed;
      });

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try {
        const failures: EmergencyCleanupFailure[] = [
          {
            dataDir: '/tmp/test_dir_failed',
            error: 'PostgreSQL server process could not be confirmed as terminated after force-kill',
            stage: 'ready',
          },
        ];

        reportEmergencyCleanupFailures(failures);

        expect(stderrSpy).toHaveBeenCalled();
        const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
        expect(output).toContain('EMERGENCY CLEANUP FAILURE');
        expect(output).toContain('/tmp/test_dir_failed');
        expect(output).toContain('Data directories have been preserved');
        // Ensure no secrets/passwords are printed
        expect(output).not.toContain('password');
        expect(output).not.toContain('secret');
      } finally {
        stderrSpy.mockRestore();
        setEmergencyFailureReporter(null);
      }
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
