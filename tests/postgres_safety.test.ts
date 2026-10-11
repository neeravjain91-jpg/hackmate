import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import {
  validateDbTarget,
  getDbConfig,
  createAdminClient,
  cleanTables,
  applyMigrations,
  EXPECTED_TEST_DATABASE,
} from './fixtures/pgHarness';

describe('PostgreSQL Harness Target Safety & Isolation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CI;
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
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

  describe('2. Host Validation for Local Execution', () => {
    it('accepts loopback hosts for local test execution', () => {
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

    it('strictly rejects non-loopback hosts in local test execution', () => {
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
      expect(() => {
        validateDbTarget({ database: 'hackmate_test' });
      }).toThrow(/Safety violation: Target host is unspecified/);
    });
  });

  describe('3. Production DATABASE_URL Isolation & Redaction', () => {
    it('does not accept production-looking DATABASE_URL as an implicit test target', () => {
      process.env.DATABASE_URL = 'postgres://prod_admin:supersecret@db.supabase.co:5432/hackmate_prod';

      // getDbConfig should NOT use DATABASE_URL
      const config = getDbConfig();
      expect(config.host).toBe('127.0.0.1');
      expect(config.database).toBe(EXPECTED_TEST_DATABASE);
      expect((config as any).connectionString).toBeUndefined();
    });

    it('rejects production-looking connection string if passed explicitly and redacts credentials', () => {
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

  describe('5. Documented CI Configuration Validation', () => {
    it('validates the documented CI service container configuration', () => {
      process.env.CI = 'true';

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

    it('allows container service host "postgres" in CI environment', () => {
      process.env.CI = 'true';

      const validated = validateDbTarget({
        host: 'postgres',
        port: 5432,
        database: 'hackmate_test',
      });
      expect(validated.host).toBe('postgres');
      expect(validated.database).toBe('hackmate_test');
    });

    it('rejects remote non-service hosts even in CI', () => {
      process.env.CI = 'true';

      expect(() => {
        validateDbTarget({
          host: 'db.supabase.co',
          port: 5432,
          database: 'hackmate_test',
        });
      }).toThrow(/Safety violation: Target host must be a loopback address/);
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
});
