import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import crypto from 'crypto';
import {
  createAdminClient,
  createTestRunnerClient,
  applyMigrations,
  cleanTables,
  withUser,
  withServiceRole,
  withAnon,
  withUnauthenticated,
  rpcCreateWorkspaceNode,
  rpcSaveWorkspaceFile,
  rpcUpdateWorkspaceNode,
  rpcDeleteWorkspaceNode,
  computeSha256,
  isVerifiedGitHubActionsService,
} from './fixtures/pgHarness';

import {
  provisionIsolatedPostgres,
  IsolatedPostgresInstance,
} from './fixtures/isolatedPgRunner';

describe('PostgreSQL Integration Test Harness - HackMate Workspace', () => {
  let isolatedInstance: IsolatedPostgresInstance | null = null;
  let adminClient: Client;
  let testClient: Client;
  let savedEnv: Record<string, string | undefined> | null = null;

  // Test UUIDs
  const USER_1 = '11111111-1111-1111-1111-111111111111';
  const USER_2 = '22222222-2222-2222-2222-222222222222';
  const USER_NON_MEMBER = '99999999-9999-9999-9999-999999999999';

  const PROJECT_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const PROJECT_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeAll(async () => {
    savedEnv = {
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      HACKMATE_DISPOSABLE_INSTANCE: process.env.HACKMATE_DISPOSABLE_INSTANCE,
    };

    // Only skip isolated ephemeral provisioning if running within the verified
    // GitHub Actions disposable service container environment targeting 'postgres'.
    // Local execution with loopback targets will NEVER bypass ephemeral provisioning,
    // even if CI markers are set.
    const targetHost = process.env.PGHOST || '127.0.0.1';
    if (isVerifiedGitHubActionsService(targetHost)) {
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
    } else {
      isolatedInstance = await provisionIsolatedPostgres();
      process.env.PGHOST = isolatedInstance.host;
      process.env.PGPORT = String(isolatedInstance.port);
      process.env.HACKMATE_DISPOSABLE_INSTANCE = 'true';
    }

    adminClient = await createAdminClient();
    // Apply bootstrap fixtures and all migrations in strict order
    await applyMigrations(adminClient);
    testClient = await createTestRunnerClient();
  }, 45000);

  afterAll(async () => {
    const teardownErrors: Error[] = [];

    if (testClient) {
      try {
        await testClient.end();
      } catch (err: any) {
        teardownErrors.push(new Error(`Failed to close testClient: ${err.message}`));
      }
    }

    if (adminClient) {
      try {
        await adminClient.end();
      } catch (err: any) {
        teardownErrors.push(new Error(`Failed to close adminClient: ${err.message}`));
      }
    }

    if (isolatedInstance) {
      try {
        await isolatedInstance.stop();
      } catch (err: any) {
        teardownErrors.push(new Error(`Failed to stop isolated PostgreSQL instance: ${err.message}`));
      }
    }

    try {
      if (savedEnv) {
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = v;
          }
        }
      }
    } catch (err: any) {
      teardownErrors.push(new Error(`Failed to restore environment variables: ${err.message}`));
    }

    if (teardownErrors.length > 0) {
      throw new Error(`Integration harness teardown encountered errors:\n${teardownErrors.map(e => e.message).join('\n')}`);
    }
  });

  beforeEach(async () => {
    // Clean and seed fresh test fixtures before each test
    await cleanTables(adminClient);

    // Seed test users
    await adminClient.query(`
      INSERT INTO auth.users (id, email) VALUES
        ('${USER_1}', 'user1@hackmate.dev'),
        ('${USER_2}', 'user2@hackmate.dev'),
        ('${USER_NON_MEMBER}', 'nonmember@hackmate.dev');

      INSERT INTO public.profiles (id, email, name) VALUES
        ('${USER_1}', 'user1@hackmate.dev', 'Alice Lead'),
        ('${USER_2}', 'user2@hackmate.dev', 'Bob Member'),
        ('${USER_NON_MEMBER}', 'nonmember@hackmate.dev', 'Charlie Stranger');

      INSERT INTO public.projects (id, name, invite_code, leader_id) VALUES
        ('${PROJECT_1}', 'Project Alpha', 'ALPHA123', '${USER_1}'),
        ('${PROJECT_2}', 'Project Beta', 'BETA123', '${USER_NON_MEMBER}');

      INSERT INTO public.project_members (project_id, user_id, role) VALUES
        ('${PROJECT_1}', '${USER_1}', 'leader'),
        ('${PROJECT_1}', '${USER_2}', 'member'),
        ('${PROJECT_2}', '${USER_NON_MEMBER}', 'leader');
    `);
  });

  // ============================================================================
  // 1. MIGRATION SAFETY & SCHEMA VERIFICATION
  // ============================================================================
  describe('1. Migration Safety & Schema Structure', () => {
    it('creates workspace_nodes and workspace_revisions tables with proper constraints', async () => {
      const res = await adminClient.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('workspace_nodes', 'workspace_revisions')
        ORDER BY table_name;
      `);
      expect(res.rows.map(r => r.table_name)).toEqual(['workspace_nodes', 'workspace_revisions']);

      // Check unique index on active paths
      const indexRes = await adminClient.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'workspace_nodes'
          AND indexname = 'unique_project_active_path';
      `);
      expect(indexRes.rows.length).toBe(1);

      // Check foreign key constraints
      const fkRes = await adminClient.query(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.workspace_nodes'::regclass
          AND conname IN ('uq_workspace_nodes_id_project', 'fk_workspace_nodes_parent_project');
      `);
      expect(fkRes.rows.length).toBe(2);
    });

    it('ensures all required atomic mutation RPC functions exist and obsolete overloads are gone', async () => {
      const procRes = await adminClient.query(`
        SELECT proname, pronargs
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND proname IN (
            'create_workspace_node_atomic',
            'save_workspace_file_atomic',
            'update_workspace_node_atomic',
            'delete_workspace_node_atomic',
            'workspace_calculate_checksum'
          );
      `);

      const procs = procRes.rows.map(r => `${r.proname}:${r.pronargs}`);
      // Exactly 1 overload of each
      expect(procs.filter(p => p.startsWith('create_workspace_node_atomic:'))).toHaveLength(1);
      expect(procs.filter(p => p.startsWith('save_workspace_file_atomic:'))).toHaveLength(1);
      expect(procs.filter(p => p.startsWith('update_workspace_node_atomic:'))).toHaveLength(1);
      expect(procs.filter(p => p.startsWith('delete_workspace_node_atomic:'))).toHaveLength(1);
      expect(procs.filter(p => p.startsWith('workspace_calculate_checksum:'))).toHaveLength(1);
    });

    it('is strictly idempotent when reapplying migrations', async () => {
      // Re-running migrations should succeed without errors or breaking constraints
      await expect(applyMigrations(adminClient)).resolves.not.toThrow();
    });
  });

  // ============================================================================
  // 2. AUTHORIZATION & SECURITY
  // ============================================================================
  describe('2. Authorization & Security', () => {
    it('permits authorized project members to create files and folders', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const folder = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'src',
          type: 'folder',
        });
        expect(folder).toBeDefined();
        expect(folder.name).toBe('src');
        expect(folder.path).toBe('/src');

        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: folder.id,
          name: 'index.ts',
          type: 'file',
          initialContent: 'console.log("hello");',
        });
        expect(file).toBeDefined();
        expect(file.name).toBe('index.ts');
        expect(file.path).toBe('/src/index.ts');
      });
    });

    it('rejects non-members attempting to create nodes in a project', async () => {
      await withUser(testClient, USER_NON_MEMBER, async (c) => {
        await expect(
          rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'hacked.txt',
            type: 'file',
            initialContent: 'malicious',
          })
        ).rejects.toThrow(/Forbidden: You are not an authorized member of this project/);
      });
    });

    it('rejects non-members attempting to save or update nodes in a project', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const node = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'secret.ts',
          type: 'file',
          initialContent: 'export const secret = 42;',
        });
        fileId = node.id;
      });

      await expect(
        withUser(testClient, USER_NON_MEMBER, async (c) => {
          await rpcSaveWorkspaceFile(c, {
            fileId,
            content: 'tampered',
            baseRevision: 1,
          });
        })
      ).rejects.toThrow(/Forbidden: You are not an authorized member of this project/);

      await expect(
        withUser(testClient, USER_NON_MEMBER, async (c) => {
          await rpcUpdateWorkspaceNode(c, {
            nodeId: fileId,
            name: 'renamed.ts',
          });
        })
      ).rejects.toThrow(/Forbidden: You are not an authorized member of this project/);

      await expect(
        withUser(testClient, USER_NON_MEMBER, async (c) => {
          await rpcDeleteWorkspaceNode(c, {
            nodeId: fileId,
          });
        })
      ).rejects.toThrow(/Forbidden: You are not an authorized member of this project/);
    });

    it('rejects unauthenticated callers (no JWT sub)', async () => {
      await withUnauthenticated(testClient, async (c) => {
        await expect(
          rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'unauth.txt',
            type: 'file',
            initialContent: 'test',
          })
        ).rejects.toThrow(/Unauthorized: Authenticated user required/);
      });
    });

    it('denies anonymous callers from executing RPC functions via SQL permissions', async () => {
      await withAnon(testClient, async (c) => {
        await expect(
          rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'anon.txt',
            type: 'file',
            initialContent: 'test',
          })
        ).rejects.toThrow(/permission denied for function create_workspace_node_atomic/);
      });
    });

    it('enforces anti-impersonation: callers cannot specify another authorId', async () => {
      await withUser(testClient, USER_1, async (c) => {
        await expect(
          rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'impersonated.txt',
            type: 'file',
            initialContent: 'test',
            authorId: USER_2, // Attempting to impersonate USER_2
          })
        ).rejects.toThrow(/Forbidden: Impersonation of other contributors is not permitted/);
      });
    });

    it('enforces cross-project boundary isolation', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'project1_file.txt',
          type: 'file',
          initialContent: 'hello',
        });
        fileId = file.id;
      });

      // Calling save with mismatched project ID
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcSaveWorkspaceFile(c, {
            fileId,
            content: 'update',
            baseRevision: 1,
            projectId: PROJECT_2,
          });
        })
      ).rejects.toThrow(/Forbidden: File does not belong to the specified project/);

      // Calling update with mismatched project ID
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcUpdateWorkspaceNode(c, {
            nodeId: fileId,
            name: 'new_name.txt',
            projectId: PROJECT_2,
          });
        })
      ).rejects.toThrow(/Forbidden: Node does not belong to specified project/);

      // Calling delete with mismatched project ID
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcDeleteWorkspaceNode(c, {
            nodeId: fileId,
            projectId: PROJECT_2,
          });
        })
      ).rejects.toThrow(/Forbidden: Node does not belong to specified project/);
    });

    it('allows service-role operations when authorId is explicitly supplied', async () => {
      await withServiceRole(testClient, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'service_created.txt',
          type: 'file',
          initialContent: 'service content',
          authorId: USER_1,
        });
        expect(file).toBeDefined();
        expect(file.last_modified_by).toBe(USER_1);

        // Service role without authorId must be rejected
        await expect(
          rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'no_author.txt',
            type: 'file',
            initialContent: 'test',
            authorId: null,
          })
        ).rejects.toThrow(/Unauthorized: Author ID is required for service-role workspace operations/);
      });
    });
  });

  // ============================================================================
  // 3. CHECKSUM VALIDATION & ATOMIC FILE CREATION
  // ============================================================================
  describe('3. Checksum Validation & Atomic File Creation', () => {
    it('computes SHA-256 hash authoritatively in database when checksum is omitted', async () => {
      const content = 'export const greeting = "Hello, world!";\n';
      const expectedChecksum = computeSha256(content);

      await withUser(testClient, USER_1, async (c) => {
        const node = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'greeting.ts',
          type: 'file',
          initialContent: content,
        });
        expect(node.size).toBe(Buffer.byteLength(content, 'utf8'));

        // Verify revision checksum in database
        const revRes = await c.query(
          `SELECT checksum, content, revision_number FROM public.workspace_revisions WHERE node_id = $1`,
          [node.id]
        );
        expect(revRes.rows).toHaveLength(1);
        expect(revRes.rows[0].revision_number).toBe(1);
        expect(revRes.rows[0].checksum).toBe(expectedChecksum);
        expect(revRes.rows[0].content).toBe(content);
      });
    });

    it('accepts matching client-provided checksum', async () => {
      const content = 'function add(a: number, b: number) { return a + b; }';
      const validChecksum = computeSha256(content);

      await withUser(testClient, USER_1, async (c) => {
        const node = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'math.ts',
          type: 'file',
          initialContent: content,
          checksum: validChecksum,
        });
        expect(node).toBeDefined();

        const revRes = await c.query(
          `SELECT checksum FROM public.workspace_revisions WHERE node_id = $1`,
          [node.id]
        );
        expect(revRes.rows[0].checksum).toBe(validChecksum);
      });
    });

    it('rejects mismatching checksum and rolls back atomically without partial nodes or revisions', async () => {
      const content = 'sensitive data';
      const fabricatedChecksum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // Mismatch

      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'corrupt.ts',
            type: 'file',
            initialContent: content,
            checksum: fabricatedChecksum,
          });
        })
      ).rejects.toThrow(/Checksum mismatch: Supplied checksum does not match computed content hash/);

      // Verify atomicity: no orphaned node exists
      const nodeRes = await adminClient.query(
        `SELECT count(*) FROM public.workspace_nodes WHERE project_id = $1 AND name = 'corrupt.ts'`,
        [PROJECT_1]
      );
      expect(parseInt(nodeRes.rows[0].count, 10)).toBe(0);

      // Verify no orphaned revision exists
      const revRes = await adminClient.query(
        `SELECT count(*) FROM public.workspace_revisions WHERE project_id = $1`,
        [PROJECT_1]
      );
      expect(parseInt(revRes.rows[0].count, 10)).toBe(0);
    });

    it('handles empty files correctly with size 0 and empty-string SHA-256', async () => {
      const emptyContent = '';
      const emptySha256 = computeSha256(emptyContent);

      await withUser(testClient, USER_1, async (c) => {
        const node = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'empty.txt',
          type: 'file',
          initialContent: emptyContent,
        });
        expect(node.size).toBe(0);

        const revRes = await c.query(
          `SELECT checksum, content FROM public.workspace_revisions WHERE node_id = $1`,
          [node.id]
        );
        expect(revRes.rows[0].checksum).toBe(emptySha256);
        expect(revRes.rows[0].content).toBe('');
      });
    });
  });

  // ============================================================================
  // 4. OPTIMISTIC CONCURRENCY CONTROL (OCC) & SAVES
  // ============================================================================
  describe('4. Optimistic Concurrency Control (OCC) & Saves', () => {
    it('saves a file with matching baseRevision and advances currentRevision', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'document.md',
          type: 'file',
          initialContent: '# Version 1',
        });
        fileId = file.id;

        const saveRes = await rpcSaveWorkspaceFile(c, {
          fileId,
          content: '# Version 2\nUpdated content.',
          baseRevision: 1,
        });
        expect(saveRes.conflict).toBe(false);
        expect(saveRes.currentRevision).toBe(2);
        expect(saveRes.file.current_revision).toBe(2);

        // Verify both revisions exist
        const revisions = await c.query(
          `SELECT revision_number, content FROM public.workspace_revisions WHERE node_id = $1 ORDER BY revision_number`,
          [fileId]
        );
        expect(revisions.rows).toHaveLength(2);
        expect(revisions.rows[0].revision_number).toBe(1);
        expect(revisions.rows[1].revision_number).toBe(2);
      });
    });

    it('returns conflict response when baseRevision is stale', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'shared.ts',
          type: 'file',
          initialContent: 'let val = 1;',
        });
        fileId = file.id;

        // Advance to revision 2
        await rpcSaveWorkspaceFile(c, {
          fileId,
          content: 'let val = 2;',
          baseRevision: 1,
        });

        // Stale save attempting to base off revision 1
        const staleRes = await rpcSaveWorkspaceFile(c, {
          fileId,
          content: 'let val = 999;',
          baseRevision: 1,
        });
        expect(staleRes.conflict).toBe(true);
        expect(staleRes.currentRevision).toBe(2);
        expect(staleRes.file.current_revision).toBe(2);

        // Verify revision 3 was NOT created
        const revCount = await c.query(
          `SELECT count(*) FROM public.workspace_revisions WHERE node_id = $1`,
          [fileId]
        );
        expect(parseInt(revCount.rows[0].count, 10)).toBe(2);
      });
    });

    it('isolates concurrent saves via row locking: exactly one succeeds and one receives conflict', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'concurrent.txt',
          type: 'file',
          initialContent: 'initial',
        });
        fileId = file.id;
      });

      // Open two separate clients to simulate concurrent user sessions
      const clientA = await createTestRunnerClient();
      const clientB = await createTestRunnerClient();

      try {
        // Start two concurrent save operations with baseRevision = 1
        const promiseA = withUser(clientA, USER_1, async (c) => {
          return rpcSaveWorkspaceFile(c, {
            fileId,
            content: 'User 1 edit',
            baseRevision: 1,
          });
        });

        const promiseB = withUser(clientB, USER_2, async (c) => {
          return rpcSaveWorkspaceFile(c, {
            fileId,
            content: 'User 2 edit',
            baseRevision: 1,
          });
        });

        const [resA, resB] = await Promise.all([promiseA, promiseB]);

        // One must succeed (conflict = false) and one must detect conflict (conflict = true)
        const successes = [resA, resB].filter(r => r.conflict === false);
        const conflicts = [resA, resB].filter(r => r.conflict === true);

        expect(successes).toHaveLength(1);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].currentRevision).toBe(2);
      } finally {
        await clientA.end();
        await clientB.end();
      }
    });

    it('bypasses concurrency check when forceOverwrite is true', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'force.txt',
          type: 'file',
          initialContent: 'v1',
        });
        fileId = file.id;

        // Force overwrite with stale baseRevision (1) while node is at 1 -> advances to 2
        const res1 = await rpcSaveWorkspaceFile(c, {
          fileId,
          content: 'v2',
          baseRevision: 1,
          forceOverwrite: false,
        });
        expect(res1.currentRevision).toBe(2);

        // Force overwrite with baseRevision = 1 (stale) and forceOverwrite = true
        const res2 = await rpcSaveWorkspaceFile(c, {
          fileId,
          content: 'v3 forced',
          baseRevision: 1,
          forceOverwrite: true,
        });
        expect(res2.conflict).toBe(false);
        expect(res2.currentRevision).toBe(3);
      });
    });

    it('rejects saves without baseRevision when forceOverwrite is false', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'missing_base.txt',
          type: 'file',
          initialContent: 'v1',
        });
        fileId = file.id;

        await expect(
          rpcSaveWorkspaceFile(c, {
            fileId,
            content: 'new content',
            baseRevision: null,
            forceOverwrite: false,
          })
        ).rejects.toThrow(/Concurrency check required: baseRevision must be specified for workspace saves/);
      });
    });
  });

  // ============================================================================
  // 5. NODE HIERARCHY, MOVE & RENAME OPERATIONS
  // ============================================================================
  describe('5. Node Hierarchy, Move & Rename Operations', () => {
    it('renames a folder without changing parent and cascades path updates to descendants', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const srcFolder = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'src',
          type: 'folder',
        });

        const subFolder = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: srcFolder.id,
          name: 'utils',
          type: 'folder',
        });

        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: subFolder.id,
          name: 'math.ts',
          type: 'file',
          initialContent: 'export const PI = 3.14;',
        });

        expect(file.path).toBe('/src/utils/math.ts');

        // Rename 'src' to 'app' preserving parent (updateParent = false)
        const updated = await rpcUpdateWorkspaceNode(c, {
          nodeId: srcFolder.id,
          name: 'app',
          updateParent: false,
        });
        expect(updated.name).toBe('app');
        expect(updated.path).toBe('/app');
        expect(updated.parent_id).toBeNull();

        // Verify descendant paths were updated
        const subRes = await c.query(
          `SELECT path FROM public.workspace_nodes WHERE id = $1`,
          [subFolder.id]
        );
        expect(subRes.rows[0].path).toBe('/app/utils');

        const fileRes = await c.query(
          `SELECT path FROM public.workspace_nodes WHERE id = $1`,
          [file.id]
        );
        expect(fileRes.rows[0].path).toBe('/app/utils/math.ts');
      });
    });

    it('moves a folder into another parent and updates descendant paths', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const dirA = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'dirA',
          type: 'folder',
        });

        const dirB = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'dirB',
          type: 'folder',
        });

        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: dirA.id,
          name: 'file.txt',
          type: 'file',
          initialContent: 'content',
        });

        // Move dirA into dirB (updateParent = true)
        const moved = await rpcUpdateWorkspaceNode(c, {
          nodeId: dirA.id,
          parentId: dirB.id,
          updateParent: true,
        });
        expect(moved.parent_id).toBe(dirB.id);
        expect(moved.path).toBe('/dirB/dirA');

        // Verify child file updated path
        const fileRes = await c.query(
          `SELECT path FROM public.workspace_nodes WHERE id = $1`,
          [file.id]
        );
        expect(fileRes.rows[0].path).toBe('/dirB/dirA/file.txt');
      });
    });

    it('moves a nested node back to the project root when parentId is null and updateParent is true', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const folder = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'parent',
          type: 'folder',
        });

        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: folder.id,
          name: 'nested.txt',
          type: 'file',
          initialContent: 'test',
        });
        expect(file.path).toBe('/parent/nested.txt');

        // Move to root
        const moved = await rpcUpdateWorkspaceNode(c, {
          nodeId: file.id,
          parentId: null,
          updateParent: true,
        });
        expect(moved.parent_id).toBeNull();
        expect(moved.path).toBe('/nested.txt');
      });
    });

    it('preserves existing parent when updateParent is false even if parentId parameter is omitted', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const folder = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'folder',
          type: 'folder',
        });

        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: folder.id,
          name: 'old_name.txt',
          type: 'file',
          initialContent: 'test',
        });

        // Rename without moving (updateParent = false, parentId = null)
        const renamed = await rpcUpdateWorkspaceNode(c, {
          nodeId: file.id,
          name: 'new_name.txt',
          parentId: null,
          updateParent: false,
        });
        expect(renamed.parent_id).toBe(folder.id);
        expect(renamed.path).toBe('/folder/new_name.txt');
      });
    });

    it('handles special characters and prevents wildcard pollution with % and _', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const folderWildcard = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'test%dir',
          type: 'folder',
        });

        const folderNormal = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'testxdir',
          type: 'folder',
        });

        const fileInWildcard = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: folderWildcard.id,
          name: 'child.txt',
          type: 'file',
          initialContent: 'inside wildcard',
        });

        const fileInNormal = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: folderNormal.id,
          name: 'child.txt',
          type: 'file',
          initialContent: 'inside normal',
        });

        // Rename folderWildcard
        await rpcUpdateWorkspaceNode(c, {
          nodeId: folderWildcard.id,
          name: 'renamed%dir',
          updateParent: false,
        });

        // Child in wildcard should update
        const wildChild = await c.query(`SELECT path FROM public.workspace_nodes WHERE id = $1`, [fileInWildcard.id]);
        expect(wildChild.rows[0].path).toBe('/renamed%dir/child.txt');

        // Child in normal folder should NOT be affected
        const normChild = await c.query(`SELECT path FROM public.workspace_nodes WHERE id = $1`, [fileInNormal.id]);
        expect(normChild.rows[0].path).toBe('/testxdir/child.txt');
      });
    });

    it('rejects directory cycle attempts (moving folder into itself or descendant)', async () => {
      let rootId = '';
      let grandChildId = '';

      await withUser(testClient, USER_1, async (c) => {
        const rootDir = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'root',
          type: 'folder',
        });
        rootId = rootDir.id;

        const childDir = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: rootDir.id,
          name: 'child',
          type: 'folder',
        });

        const grandChild = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: childDir.id,
          name: 'grandchild',
          type: 'folder',
        });
        grandChildId = grandChild.id;
      });

      // Attempt to move rootDir into itself
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcUpdateWorkspaceNode(c, {
            nodeId: rootId,
            parentId: rootId,
            updateParent: true,
          });
        })
      ).rejects.toThrow(/Cannot move a folder into itself/);

      // Attempt to move rootDir into its descendant grandchild
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcUpdateWorkspaceNode(c, {
            nodeId: rootId,
            parentId: grandChildId,
            updateParent: true,
          });
        })
      ).rejects.toThrow(/Cannot move a folder into one of its descendants/);
    });

    it('rejects invalid names containing path separators (/ or \\)', async () => {
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'foo/bar',
            type: 'file',
            initialContent: 'test',
          });
        })
      ).rejects.toThrow(/Name cannot be empty or contain path separators/);

      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: 'foo\\bar',
            type: 'file',
            initialContent: 'test',
          });
        })
      ).rejects.toThrow(/Name cannot be empty or contain path separators/);

      await expect(
        withUser(testClient, USER_1, async (c) => {
          await rpcCreateWorkspaceNode(c, {
            projectId: PROJECT_1,
            name: '..',
            type: 'file',
            initialContent: 'test',
          });
        })
      ).rejects.toThrow(/Name cannot be empty or contain path separators/);
    });

    it('rejects renaming to an existing path (path collision)', async () => {
      await withUser(testClient, USER_1, async (c) => {
        await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'first.txt',
          type: 'file',
          initialContent: 'first',
        });

        const second = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'second.txt',
          type: 'file',
          initialContent: 'second',
        });

        await expect(
          rpcUpdateWorkspaceNode(c, {
            nodeId: second.id,
            name: 'first.txt',
            updateParent: false,
          })
        ).rejects.toThrow(/already exists in this project/);
      });
    });
  });

  // ============================================================================
  // 6. DELETION & REVISIONS
  // ============================================================================
  describe('6. Deletion & Revision Immutability', () => {
    it('soft deletes folder and all its descendants recursively', async () => {
      await withUser(testClient, USER_1, async (c) => {
        const folder = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'to_delete',
          type: 'folder',
        });

        const sub = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: folder.id,
          name: 'sub',
          type: 'folder',
        });

        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          parentId: sub.id,
          name: 'leaf.txt',
          type: 'file',
          initialContent: 'leaf content',
        });

        // Soft delete folder
        const delRes = await rpcDeleteWorkspaceNode(c, {
          nodeId: folder.id,
        });
        expect(delRes.success).toBe(true);

        // Verify active query excludes all three
        const activeRes = await c.query(
          `SELECT id, name, deleted_at FROM public.workspace_nodes
           WHERE project_id = $1 AND deleted_at IS NULL`,
          [PROJECT_1]
        );
        expect(activeRes.rows).toHaveLength(0);

        // Verify all three have deleted_at IS NOT NULL in database
        const deletedRes = await c.query(
          `SELECT id, name, deleted_at FROM public.workspace_nodes
           WHERE project_id = $1 AND id IN ($2, $3, $4)`,
          [PROJECT_1, folder.id, sub.id, file.id]
        );
        expect(deletedRes.rows).toHaveLength(3);
        deletedRes.rows.forEach(r => expect(r.deleted_at).not.toBeNull());
      });
    });

    it('preserves revision history immutability after file deletion', async () => {
      let fileId: string;
      await withUser(testClient, USER_1, async (c) => {
        const file = await rpcCreateWorkspaceNode(c, {
          projectId: PROJECT_1,
          name: 'audit_trail.txt',
          type: 'file',
          initialContent: 'v1',
        });
        fileId = file.id;

        await rpcSaveWorkspaceFile(c, {
          fileId,
          content: 'v2',
          baseRevision: 1,
        });

        await rpcDeleteWorkspaceNode(c, {
          nodeId: fileId,
        });

        // Check revisions still exist intact
        const revRes = await c.query(
          `SELECT revision_number, content, checksum FROM public.workspace_revisions
           WHERE node_id = $1 ORDER BY revision_number`,
          [fileId]
        );
        expect(revRes.rows).toHaveLength(2);
        expect(revRes.rows[0].content).toBe('v1');
        expect(revRes.rows[1].content).toBe('v2');
      });
    });

    it('denies direct table DML (INSERT/UPDATE/DELETE) for authenticated and anon roles', async () => {
      // 1. Direct INSERT into workspace_nodes as authenticated
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await c.query(`
            INSERT INTO public.workspace_nodes (project_id, name, path, type, last_modified_by, last_modified_name)
            VALUES ('${PROJECT_1}', 'direct.txt', '/direct.txt', 'file', '${USER_1}', 'Alice');
          `);
        })
      ).rejects.toThrow(/permission denied for table workspace_nodes/);

      // 2. Direct UPDATE on workspace_nodes as authenticated
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await c.query(`
            UPDATE public.workspace_nodes SET name = 'tampered' WHERE project_id = '${PROJECT_1}';
          `);
        })
      ).rejects.toThrow(/permission denied for table workspace_nodes/);

      // 3. Direct DELETE on workspace_nodes as authenticated
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await c.query(`
            DELETE FROM public.workspace_nodes WHERE project_id = '${PROJECT_1}';
          `);
        })
      ).rejects.toThrow(/permission denied for table workspace_nodes/);

      // 4. Direct INSERT on workspace_revisions as authenticated
      await expect(
        withUser(testClient, USER_1, async (c) => {
          await c.query(`
            INSERT INTO public.workspace_revisions (node_id, project_id, revision_number, content, author_id, author_name)
            VALUES ('${crypto.randomUUID()}', '${PROJECT_1}', 1, 'fake', '${USER_1}', 'Alice');
          `);
        })
      ).rejects.toThrow(/permission denied for table workspace_revisions/);

      // 5. Direct access as anon
      await expect(
        withAnon(testClient, async (c) => {
          await c.query(`SELECT count(*) FROM public.workspace_nodes;`);
        })
      ).rejects.toThrow(/permission denied for table workspace_nodes/);
    });
  });
});
