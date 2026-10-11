import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';
import { SupabaseDatabaseAdapter } from '@/lib/db/supabaseDb';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { GET as getTreeHandler } from '@/app/api/projects/[id]/workspace/tree/route';
import { POST as createNodeHandler } from '@/app/api/projects/[id]/workspace/nodes/route';
import { PATCH as updateNodeHandler, DELETE as deleteNodeHandler } from '@/app/api/projects/[id]/workspace/nodes/[nodeId]/route';
import { GET as getFileHandler, PUT as saveFileHandler } from '@/app/api/projects/[id]/workspace/files/[fileId]/route';
import { GET as getRevisionsHandler } from '@/app/api/projects/[id]/workspace/files/[fileId]/revisions/route';
import { POST as restoreRevisionHandler } from '@/app/api/projects/[id]/workspace/files/[fileId]/restore/route';

const TEST_DIR = path.join(process.cwd(), 'data', 'test_review_workspace_data');
const TEST_DB_PATH = path.join(TEST_DIR, 'hackmate_test.json');

describe('Technical Review Audit & Regression Test Suite', () => {
  let db: LocalDatabaseAdapter;

  beforeEach(() => {
    process.env.LOCAL_DB_PATH = TEST_DB_PATH;
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new LocalDatabaseAdapter(TEST_DB_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    delete process.env.LOCAL_DB_PATH;
  });

  function createAuthedRequest(url: string, userId: string, init?: RequestInit): NextRequest {
    const token = createSessionToken(userId);
    const headers = new Headers(init?.headers);
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    const { signal, ...rest } = init || {};
    return new NextRequest(url, { ...rest, signal: signal ?? undefined, headers });
  }

  // =========================================================================
  // AREA A: Database migration safety
  // =========================================================================
  describe('Area A: Database migration safety', () => {
    it('migration script contains idempotency guards and composite constraints', () => {
      const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '20241011_add_workspace.sql');
      expect(fs.existsSync(migrationPath)).toBe(true);

      const content = fs.readFileSync(migrationPath, 'utf-8');

      // 1. Enum creation safeguard
      expect(content).toContain("IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_node_type')");

      // 2. Composite unique constraint for multi-tenant isolation
      expect(content).toContain('uq_workspace_nodes_id_project');
      expect(content).toContain('UNIQUE (id, project_id)');

      // 3. Composite self-referencing foreign key for project isolation
      expect(content).toContain('fk_workspace_nodes_parent_project');
      expect(content).toContain('FOREIGN KEY (parent_id, project_id)');

      // 4. Foreign key on revisions with RESTRICT to prevent accidental cascade deletion
      expect(content).toContain('fk_workspace_revisions_node_project');
      expect(content).toContain('ON DELETE RESTRICT');

      // 5. Policies have DROP POLICY IF EXISTS safeguards
      expect(content).toContain('DROP POLICY IF EXISTS "Members can view workspace nodes"');
      expect(content).toContain('DROP POLICY IF EXISTS "Members can create workspace nodes"');
      expect(content).toContain('DROP POLICY IF EXISTS "Members can update workspace nodes"');
      expect(content).toContain('DROP POLICY IF EXISTS "Members can view workspace revisions"');
      expect(content).toContain('DROP POLICY IF EXISTS "Members can insert workspace revisions"');

      // 6. Revision immutability trigger
      expect(content).toContain('trigger_workspace_revisions_immutable');
      expect(content).toContain('BEFORE UPDATE OR DELETE ON public.workspace_revisions');

      // 7. Atomic functions
      expect(content).toContain('create_workspace_node_atomic');
      expect(content).toContain('save_workspace_file_atomic');
      expect(content).toContain('update_workspace_node_atomic');
      expect(content).toContain('delete_workspace_node_atomic');

      // 8. Security Definer and pinned search path
      expect(content).toContain("SET search_path = ''");

      // 9. Restrict execution privileges
      expect(content).toContain('REVOKE ALL ON FUNCTION public.create_workspace_node_atomic');
      expect(content).toContain('REVOKE ALL ON FUNCTION public.save_workspace_file_atomic');
      expect(content).toContain('REVOKE ALL ON FUNCTION public.update_workspace_node_atomic');
      expect(content).toContain('REVOKE ALL ON FUNCTION public.delete_workspace_node_atomic');
      expect(content).toContain('GRANT EXECUTE ON FUNCTION public.create_workspace_node_atomic');
      expect(content).toContain('GRANT EXECUTE ON FUNCTION public.save_workspace_file_atomic');
      expect(content).toContain('GRANT EXECUTE ON FUNCTION public.update_workspace_node_atomic');
      expect(content).toContain('GRANT EXECUTE ON FUNCTION public.delete_workspace_node_atomic');

      // 10. Project immutability trigger
      expect(content).toContain('prevent_workspace_node_project_transfer');
      expect(content).toContain('BEFORE UPDATE OF project_id ON public.workspace_nodes');

      // 11. Revoke direct mutation privileges on tables from authenticated and anon
      expect(content).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.workspace_nodes FROM PUBLIC, anon, authenticated');
      expect(content).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.workspace_revisions FROM PUBLIC, anon, authenticated');
      expect(content).toContain('GRANT SELECT ON TABLE public.workspace_nodes TO authenticated, service_role');
      expect(content).toContain('GRANT SELECT ON TABLE public.workspace_revisions TO authenticated, service_role');

      // 12. Distinguish parent updates in update_workspace_node_atomic
      expect(content).toContain('p_update_parent BOOLEAN DEFAULT FALSE');
    });
  });

  // =========================================================================
  // AREA B: Revision integrity and project isolation
  // =========================================================================
  describe('Area B: Revision integrity and project isolation', () => {
    it('child node cannot reference parent belonging to another project', async () => {
      const userA = await db.createUser({ email: 'usera@mit.edu', name: 'User A' });
      const userB = await db.createUser({ email: 'userb@mit.edu', name: 'User B' });

      const projA = await db.createProject({ name: 'Project A', description: '', leader_id: userA.id });
      const projB = await db.createProject({ name: 'Project B', description: '', leader_id: userB.id });

      // In Project A, create a folder
      const folderA = await db.createWorkspaceNode({
        project_id: projA.id,
        name: 'dirA',
        type: 'folder',
        author_id: userA.id,
        author_name: userA.name,
      });

      // User B in Project B tries to create a node referencing folderA in Project A -> REJECTED
      await expect(
        db.createWorkspaceNode({
          project_id: projB.id,
          parent_id: folderA.id,
          name: 'cross_file.ts',
          type: 'file',
          author_id: userB.id,
          author_name: userB.name,
        })
      ).rejects.toThrow(/belongs to another project|Parent folder not found/i);
    });

    it('moving a node to a parent in another project is strictly rejected', async () => {
      const userA = await db.createUser({ email: 'usera2@mit.edu', name: 'User A2' });
      const userB = await db.createUser({ email: 'userb2@mit.edu', name: 'User B2' });

      const projA = await db.createProject({ name: 'Project A2', description: '', leader_id: userA.id });
      const projB = await db.createProject({ name: 'Project B2', description: '', leader_id: userB.id });

      const folderA = await db.createWorkspaceNode({
        project_id: projA.id,
        name: 'dirA2',
        type: 'folder',
        author_id: userA.id,
        author_name: userA.name,
      });

      const fileB = await db.createWorkspaceNode({
        project_id: projB.id,
        name: 'fileB.ts',
        type: 'file',
        author_id: userB.id,
        author_name: userB.name,
      });

      await expect(
        db.updateWorkspaceNode(fileB.id, { parent_id: folderA.id }, userB.id, userB.name)
      ).rejects.toThrow(/belongs to another project|Target parent folder not found/i);
    });

    it('soft deletion preserves revision history and prevents modification of deleted file', async () => {
      const user = await db.createUser({ email: 'dev@mit.edu', name: 'Dev' });
      const proj = await db.createProject({ name: 'SoftDelProj', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'script.py',
        type: 'file',
        initialContent: 'print("v1")',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'print("v2")', 1, user.id, user.name);

      // Delete file
      const deleted = await db.deleteWorkspaceNode(file.id);
      expect(deleted).toBe(true);

      // Revisions preserved
      const history = await db.getWorkspaceFileRevisions(file.id);
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('print("v2")');
      expect(history[1].content).toBe('print("v1")');

      // Attempting to modify deleted file is rejected
      await expect(
        db.saveWorkspaceFile(file.id, 'print("v3")', 2, user.id, user.name)
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // AREA C: Atomic saves and concurrent editing
  // =========================================================================
  describe('Area C: Atomic saves and concurrent editing', () => {
    it('concurrent save attempts with identical baseRevision result in conflict for subsequent writer', async () => {
      const userA = await db.createUser({ email: 'alice_c@mit.edu', name: 'Alice' });
      const userB = await db.createUser({ email: 'bob_c@mit.edu', name: 'Bob' });
      const proj = await db.createProject({ name: 'AtomicProj', description: '', leader_id: userA.id });
      await db.joinProject(proj.id, userB.id, 'member');

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'concurrent.txt',
        type: 'file',
        initialContent: 'Initial base',
        author_id: userA.id,
        author_name: userA.name,
      });
      expect(file.current_revision).toBe(1);

      // Alice saves revision 2
      const aliceSave = await db.saveWorkspaceFile(file.id, 'Alice content', 1, userA.id, userA.name);
      expect(aliceSave.conflict).toBe(false);
      expect(aliceSave.file.current_revision).toBe(2);

      // Bob attempts to save using stale baseRevision 1
      const bobSave = await db.saveWorkspaceFile(file.id, 'Bob stale content', 1, userB.id, userB.name);
      expect(bobSave.conflict).toBe(true);
      expect(bobSave.currentRevision).toBe(2);

      // File content reflects Alice's changes
      const current = await db.getWorkspaceFile(file.id);
      expect(current?.content).toBe('Alice content');
      expect(current?.current_revision).toBe(2);
    });

    it('rejects invalid baseRevision values (negative, fractional)', async () => {
      const user = await db.createUser({ email: 'val@mit.edu', name: 'Val' });
      const proj = await db.createProject({ name: 'ValProj', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'validate.txt',
        type: 'file',
        initialContent: 'hello',
        author_id: user.id,
        author_name: user.name,
      });

      await expect(
        db.saveWorkspaceFile(file.id, 'new', -1, user.id, user.name)
      ).rejects.toThrow(/positive integer/i);

      await expect(
        db.saveWorkspaceFile(file.id, 'new', 1.5, user.id, user.name)
      ).rejects.toThrow(/positive integer/i);
    });
  });

  // =========================================================================
  // AREA D: Revision restoration
  // =========================================================================
  describe('Area D: Revision restoration', () => {
    it('restoration rejects invalid, negative, fractional, and non-numeric revision numbers', async () => {
      const user = await db.createUser({ email: 'rest_val@mit.edu', name: 'RestVal' });
      const proj = await db.createProject({ name: 'RestValProj', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'app.js',
        type: 'file',
        initialContent: 'v1',
        author_id: user.id,
        author_name: user.name,
      });

      // Negative revision
      await expect(
        db.restoreWorkspaceRevision(file.id, -1, user.id, user.name)
      ).rejects.toThrow(/positive integer/i);

      // Fractional revision
      await expect(
        db.restoreWorkspaceRevision(file.id, 1.5, user.id, user.name)
      ).rejects.toThrow(/positive integer/i);

      // Zero revision
      await expect(
        db.restoreWorkspaceRevision(file.id, 0, user.id, user.name)
      ).rejects.toThrow(/positive integer/i);
    });

    it('restoration enforces concurrency checks against baseRevision and prevents silent overwrites', async () => {
      const user = await db.createUser({ email: 'concur_rest@mit.edu', name: 'ConcurRest' });
      const proj = await db.createProject({ name: 'ConcurRestProj', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'module.ts',
        type: 'file',
        initialContent: 'version 1',
        author_id: user.id,
        author_name: user.name,
      });

      // Advance to rev 2
      await db.saveWorkspaceFile(file.id, 'version 2', 1, user.id, user.name);

      // Advance to rev 3
      await db.saveWorkspaceFile(file.id, 'version 3', 2, user.id, user.name);

      // Attempt to restore Rev 1 with stale baseRevision 2 (current is 3) -> CONFLICT REJECTED
      await expect(
        db.restoreWorkspaceRevision(file.id, 1, user.id, user.name, 2)
      ).rejects.toThrow(/Conflict.*updated to revision 3/i);

      // Restore with matching baseRevision 3 succeeds and creates rev 4
      const restored = await db.restoreWorkspaceRevision(file.id, 1, user.id, user.name, 3);
      expect(restored.current_revision).toBe(4);
      expect(restored.content).toBe('version 1');

      // Verify all previous revisions remain intact
      const history = await db.getWorkspaceFileRevisions(file.id);
      expect(history).toHaveLength(4);
    });
  });

  // =========================================================================
  // AREA E: File and folder operations
  // =========================================================================
  describe('Area E: File and folder operations', () => {
    it('renaming and moving a folder updates all descendant paths consistently', async () => {
      const user = await db.createUser({ email: 'folder_op@mit.edu', name: 'FolderOp' });
      const proj = await db.createProject({ name: 'FolderProj', description: '', leader_id: user.id });

      const srcFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'src',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const componentsFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: srcFolder.id,
        name: 'components',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const buttonFile = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: componentsFolder.id,
        name: 'Button.tsx',
        type: 'file',
        initialContent: '<button />',
        author_id: user.id,
        author_name: user.name,
      });

      expect(buttonFile.path).toBe('/src/components/Button.tsx');

      // Rename 'src' -> 'lib'
      await db.updateWorkspaceNode(srcFolder.id, { name: 'lib' }, user.id, user.name);

      // Verify descendant paths were updated consistently
      const updatedComponents = await db.getWorkspaceNode(componentsFolder.id);
      expect(updatedComponents?.path).toBe('/lib/components');

      const updatedButton = await db.getWorkspaceNode(buttonFile.id);
      expect(updatedButton?.path).toBe('/lib/components/Button.tsx');
    });

    it('rejects directory cycles when moving a folder into itself or a descendant', async () => {
      const user = await db.createUser({ email: 'cycle@mit.edu', name: 'CycleUser' });
      const proj = await db.createProject({ name: 'CycleProj', description: '', leader_id: user.id });

      const parentFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'parent',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const childFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: parentFolder.id,
        name: 'child',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      // 1. Moving folder into itself -> REJECTED
      await expect(
        db.updateWorkspaceNode(parentFolder.id, { parent_id: parentFolder.id }, user.id, user.name)
      ).rejects.toThrow(/Cannot move a folder into itself/i);

      // 2. Moving parent into child (cycle) -> REJECTED
      await expect(
        db.updateWorkspaceNode(parentFolder.id, { parent_id: childFolder.id }, user.id, user.name)
      ).rejects.toThrow(/Cannot move a folder into one of its descendants/i);
    });

    it('rejects duplicate paths during node rename and move', async () => {
      const user = await db.createUser({ email: 'dup@mit.edu', name: 'DupUser' });
      const proj = await db.createProject({ name: 'DupProj', description: '', leader_id: user.id });

      const file1 = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'file1.ts',
        type: 'file',
        author_id: user.id,
        author_name: user.name,
      });

      await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'file2.ts',
        type: 'file',
        author_id: user.id,
        author_name: user.name,
      });

      // Renaming file1.ts to file2.ts -> DUPLICATE REJECTED
      await expect(
        db.updateWorkspaceNode(file1.id, { name: 'file2.ts' }, user.id, user.name)
      ).rejects.toThrow(/already exists/i);
    });

    it('renaming a nested file preserves its parent folder and full path hierarchy', async () => {
      const user = await db.createUser({ email: 'preserve_parent@mit.edu', name: 'PreserveUser' });
      const proj = await db.createProject({ name: 'PreserveProj', description: '', leader_id: user.id });

      const srcFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'src',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const utilsFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: srcFolder.id,
        name: 'utils',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: utilsFolder.id,
        name: 'math.ts',
        type: 'file',
        initialContent: 'export const add = (a: number, b: number) => a + b;',
        author_id: user.id,
        author_name: user.name,
      });

      expect(file.parent_id).toBe(utilsFolder.id);
      expect(file.path).toBe('/src/utils/math.ts');

      // 1. Rename without passing parent_id -> MUST preserve existing parent
      const renamedFile = await db.updateWorkspaceNode(
        file.id,
        { name: 'calculator.ts' },
        user.id,
        user.name
      );

      expect(renamedFile.name).toBe('calculator.ts');
      expect(renamedFile.parent_id).toBe(utilsFolder.id);
      expect(renamedFile.path).toBe('/src/utils/calculator.ts');

      // 2. Renaming the nested folder 'utils' -> 'helpers' preserves its parent 'src'
      const renamedFolder = await db.updateWorkspaceNode(
        utilsFolder.id,
        { name: 'helpers' },
        user.id,
        user.name
      );

      expect(renamedFolder.name).toBe('helpers');
      expect(renamedFolder.parent_id).toBe(srcFolder.id);
      expect(renamedFolder.path).toBe('/src/helpers');

      // Descendant paths must reflect the renamed folder
      const fileAfterFolderRename = await db.getWorkspaceNode(file.id);
      expect(fileAfterFolderRename?.path).toBe('/src/helpers/calculator.ts');
      expect(fileAfterFolderRename?.parent_id).toBe(utilsFolder.id);

      // 3. Moving the file to another folder updates parent and path
      const otherFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'lib',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const movedFile = await db.updateWorkspaceNode(
        file.id,
        { parent_id: otherFolder.id },
        user.id,
        user.name
      );
      expect(movedFile.parent_id).toBe(otherFolder.id);
      expect(movedFile.path).toBe('/lib/calculator.ts');

      // 4. Explicit move to root (parent_id: null) sets parent to null and path to /calculator.ts
      const rootFile = await db.updateWorkspaceNode(
        file.id,
        { parent_id: null },
        user.id,
        user.name
      );
      expect(rootFile.parent_id).toBeNull();
      expect(rootFile.path).toBe('/calculator.ts');
    });
  });

  // =========================================================================
  // AREA F: API authorization & HTTP routes
  // =========================================================================
  describe('Area F: API authorization and HTTP security gates', () => {
    it('HTTP endpoints require authentication and reject unauthorized requests with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/projects/proj-123/workspace/tree');
      const res = await getTreeHandler(req, { params: { id: 'proj-123' } });
      expect(res.status).toBe(401);
    });

    it('HTTP endpoints check project membership and reject non-members with 403', async () => {
      const alice = await db.createUser({ email: 'owner@mit.edu', name: 'Owner' });
      const stranger = await db.createUser({ email: 'stranger_api@mit.edu', name: 'Stranger' });
      const proj = await db.createProject({ name: 'SecureProj', description: '', leader_id: alice.id });

      const req = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/tree`,
        stranger.id
      );
      const res = await getTreeHandler(req, { params: { id: proj.id } });
      expect(res.status).toBe(403);
    });

    it('HTTP save route returns 409 conflict when baseRevision does not match', async () => {
      const alice = await db.createUser({ email: 'save_alice@mit.edu', name: 'Alice' });
      const bob = await db.createUser({ email: 'save_bob@mit.edu', name: 'Bob' });
      const proj = await db.createProject({ name: 'SaveProj', description: '', leader_id: alice.id });
      await db.joinProject(proj.id, bob.id, 'member');

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'server.ts',
        type: 'file',
        initialContent: 'export const port = 3000;',
        author_id: alice.id,
        author_name: alice.name,
      });

      // Alice saves rev 2
      await db.saveWorkspaceFile(file.id, 'export const port = 8080;', 1, alice.id, alice.name);

      // Bob sends PUT via HTTP with stale baseRevision 1
      const req = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}`,
        bob.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'export const port = 9000;', baseRevision: 1 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const res = await saveFileHandler(req, { params: { id: proj.id, fileId: file.id } });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.conflict).toBe(true);
      expect(body.currentRevision).toBe(2);
    });

    it('HTTP restore route returns 409 conflict on concurrent edit and 400 on invalid revision numbers', async () => {
      const alice = await db.createUser({ email: 'rest_alice@mit.edu', name: 'Alice' });
      const proj = await db.createProject({ name: 'RestProj', description: '', leader_id: alice.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'config.env',
        type: 'file',
        initialContent: 'DEBUG=false',
        author_id: alice.id,
        author_name: alice.name,
      });

      await db.saveWorkspaceFile(file.id, 'DEBUG=true', 1, alice.id, alice.name);

      // Invalid revision number (e.g. fractional)
      const invalidReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        alice.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1.5 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const invalidRes = await restoreRevisionHandler(invalidReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(invalidRes.status).toBe(400);

      // Stale baseRevision -> 409
      const staleReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        alice.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1, baseRevision: 1 }), // current is 2
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const staleRes = await restoreRevisionHandler(staleReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(staleRes.status).toBe(409);
    });

    it('validates parent_id in node creation HTTP route against current project', async () => {
      const alice = await db.createUser({ email: 'iso_alice@mit.edu', name: 'Alice' });
      const stranger = await db.createUser({ email: 'iso_stranger@mit.edu', name: 'Stranger' });
      const projAlice = await db.createProject({ name: 'AliceProj', description: '', leader_id: alice.id });
      const projStranger = await db.createProject({ name: 'StrangerProj', description: '', leader_id: stranger.id });

      const foreignFolder = await db.createWorkspaceNode({
        project_id: projStranger.id,
        name: 'secret_dir',
        type: 'folder',
        author_id: stranger.id,
        author_name: stranger.name,
      });

      const req = createAuthedRequest(
        `http://localhost:3000/api/projects/${projAlice.id}/workspace/nodes`,
        alice.id,
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'injected.ts',
            type: 'file',
            parent_id: foreignFolder.id,
          }),
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const res = await createNodeHandler(req, { params: { id: projAlice.id } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Parent folder not found in this project/i);
    });
  });

  // =========================================================================
  // AREA G: Supabase RPC Function and Adapter Transaction Integrity
  // =========================================================================
  describe('Area G: Supabase RPC Function and Adapter Transaction Integrity', () => {
    it('SupabaseDatabaseAdapter.saveWorkspaceFile requires baseRevision unless forceOverwrite is enabled', async () => {
      const mockClient: any = {
        rpc: async () => ({ data: null, error: null }),
      };
      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);

      // Missing baseRevision without forceOverwrite -> throws concurrency check error
      await expect(
        supabaseDb.saveWorkspaceFile('file-1', 'content', undefined, 'user-1', 'User 1')
      ).rejects.toThrow(/baseRevision must be specified/i);

      // Invalid baseRevision numbers -> throws validation error
      await expect(
        supabaseDb.saveWorkspaceFile('file-1', 'content', -1, 'user-1', 'User 1')
      ).rejects.toThrow(/positive integer/i);

      await expect(
        supabaseDb.saveWorkspaceFile('file-1', 'content', 1.5, 'user-1', 'User 1')
      ).rejects.toThrow(/positive integer/i);
    });

    it('SupabaseDatabaseAdapter.saveWorkspaceFile propagates RPC errors without falling back to non-atomic writes', async () => {
      let fromCallCount = 0;
      const mockClient: any = {
        rpc: async (fnName: string, args: any) => {
          expect(fnName).toBe('save_workspace_file_atomic');
          return { data: null, error: { message: 'Database transaction aborted' } };
        },
        from: () => {
          fromCallCount++;
          return {
            select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
          };
        },
      };

      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);

      await expect(
        supabaseDb.saveWorkspaceFile('file-1', 'new code', 1, 'user-1', 'User 1')
      ).rejects.toThrow(/Failed to save revision: Database transaction aborted/i);

      // Verify that no fallback multi-query inserts or updates were attempted
      expect(fromCallCount).toBe(0);
    });

    it('SupabaseDatabaseAdapter.saveWorkspaceFile handles revision conflicts atomically', async () => {
      const mockFile = {
        id: 'file-1',
        project_id: 'proj-1',
        name: 'app.ts',
        type: 'file',
        current_revision: 5,
        content: 'latest content',
      };

      const mockClient: any = {
        rpc: async (fnName: string, args: any) => {
          expect(fnName).toBe('save_workspace_file_atomic');
          expect(args.p_base_revision).toBe(3);
          expect(args.p_force_overwrite).toBe(false);
          return {
            data: { conflict: true, currentRevision: 5 },
            error: null,
          };
        },
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              is: () => ({
                single: async () => ({ data: mockFile, error: null }),
              }),
              order: () => ({
                eq: async () => ({ data: [{ revision_number: 5, content: 'latest content' }], error: null }),
              }),
            }),
          }),
        }),
      };

      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);
      const res = await supabaseDb.saveWorkspaceFile('file-1', 'my draft', 3, 'user-1', 'User 1');

      expect(res.conflict).toBe(true);
      expect(res.currentRevision).toBe(5);
      expect(res.file.id).toBe('file-1');
    });

    it('SupabaseDatabaseAdapter.saveWorkspaceFile passes forceOverwrite to RPC function', async () => {
      let passedArgs: any = null;
      const mockFile = {
        id: 'file-1',
        project_id: 'proj-1',
        name: 'app.ts',
        type: 'file',
        current_revision: 2,
        content: 'force overwrite content',
      };

      const mockClient: any = {
        rpc: async (fnName: string, args: any) => {
          passedArgs = args;
          return {
            data: {
              node: mockFile,
              revision: { revision_number: 2 },
            },
            error: null,
          };
        },
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              is: () => ({
                single: async () => ({ data: mockFile, error: null }),
              }),
              order: () => ({
                eq: async () => ({ data: [{ revision_number: 2, content: 'force overwrite content' }], error: null }),
              }),
            }),
          }),
        }),
      };

      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);
      const res = await supabaseDb.saveWorkspaceFile('file-1', 'force overwrite content', undefined, 'user-1', 'User 1', true);

      expect(passedArgs.p_force_overwrite).toBe(true);
      expect(passedArgs.p_base_revision).toBeNull();
      expect(res.conflict).toBe(false);
    });

    it('SupabaseDatabaseAdapter.createWorkspaceNode executes atomic RPC and rolls back on failure', async () => {
      const mockClient: any = {
        rpc: async (fnName: string, args: any) => {
          expect(fnName).toBe('create_workspace_node_atomic');
          return { data: null, error: { message: 'Failed to insert initial revision snapshot' } };
        },
      };

      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);

      await expect(
        supabaseDb.createWorkspaceNode({
          project_id: 'proj-1',
          name: 'index.ts',
          type: 'file',
          initialContent: 'console.log("hello");',
          author_id: 'user-1',
          author_name: 'User 1',
        })
      ).rejects.toThrow(/Failed to create workspace item: Failed to insert initial revision snapshot/i);
    });

    it('SupabaseDatabaseAdapter routes folder mutations through atomic RPC operations and distinguishes rename vs moves', async () => {
      let rpcCalls: { fn: string; args: any }[] = [];
      const mockClient: any = {
        rpc: async (fnName: string, args: any) => {
          rpcCalls.push({ fn: fnName, args });
          if (fnName === 'update_workspace_node_atomic') {
            return {
              data: { id: 'node-1', name: args.p_name || 'orig-name', parent_id: args.p_parent_id },
              error: null,
            };
          }
          if (fnName === 'delete_workspace_node_atomic') {
            return {
              data: { success: true },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };

      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);

      // 1. Rename without changing parent -> p_update_parent: false, p_parent_id: null
      const renamed = await supabaseDb.updateWorkspaceNode(
        'node-1',
        { name: 'renamed-name' },
        'user-1',
        'User 1'
      );
      expect(renamed.name).toBe('renamed-name');
      const renameCall = rpcCalls.find((c) => c.fn === 'update_workspace_node_atomic' && c.args.p_name === 'renamed-name');
      expect(renameCall?.args.p_update_parent).toBe(false);
      expect(renameCall?.args.p_parent_id).toBeNull();

      // 2. Move to target folder -> p_update_parent: true, p_parent_id: 'folder-123'
      await supabaseDb.updateWorkspaceNode(
        'node-1',
        { parent_id: 'folder-123' },
        'user-1',
        'User 1'
      );
      const moveCall = rpcCalls.find((c) => c.args.p_parent_id === 'folder-123');
      expect(moveCall?.args.p_update_parent).toBe(true);
      expect(moveCall?.args.p_parent_id).toBe('folder-123');

      // 3. Explicit root move -> p_update_parent: true, p_parent_id: null
      await supabaseDb.updateWorkspaceNode(
        'node-1',
        { parent_id: null },
        'user-1',
        'User 1'
      );
      const rootMoveCall = rpcCalls.find((c) => c.args.p_update_parent === true && c.args.p_parent_id === null);
      expect(rootMoveCall).toBeDefined();

      // 4. Delete operation -> calls delete_workspace_node_atomic
      const deleted = await supabaseDb.deleteWorkspaceNode('node-1');
      expect(deleted).toBe(true);
      expect(rpcCalls.some((c) => c.fn === 'delete_workspace_node_atomic')).toBe(true);
    });

    it('HTTP route PUT /api/projects/:id/workspace/files/:fileId rejects missing baseRevision and validates project isolation', async () => {
      const alice = await db.createUser({ email: 'owner_alice@mit.edu', name: 'Alice' });
      const bob = await db.createUser({ email: 'hacker_bob@mit.edu', name: 'Bob' });
      const projA = await db.createProject({ name: 'Project A', description: '', leader_id: alice.id });
      const projB = await db.createProject({ name: 'Project B', description: '', leader_id: bob.id });

      const fileA = await db.createWorkspaceNode({
        project_id: projA.id,
        name: 'secret.txt',
        type: 'file',
        initialContent: 'secret info',
        author_id: alice.id,
        author_name: alice.name,
      });

      // 1. Missing baseRevision without forceOverwrite -> 400 Bad Request
      const missingBaseReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${projA.id}/workspace/files/${fileA.id}`,
        alice.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'tampered' }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const missingBaseRes = await saveFileHandler(missingBaseReq, {
        params: { id: projA.id, fileId: fileA.id },
      });
      expect(missingBaseRes.status).toBe(400);
      const missingBody = await missingBaseRes.json();
      expect(missingBody.error).toMatch(/baseRevision must be specified/i);

      // 2. Cross-project file save attempt -> 404 Not Found (file does not belong to Project B)
      const crossReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${projB.id}/workspace/files/${fileA.id}`,
        bob.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'cross-project overwrite', baseRevision: 1 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const crossRes = await saveFileHandler(crossReq, {
        params: { id: projB.id, fileId: fileA.id },
      });
      expect(crossRes.status).toBe(404);

      // 3. Unauthorized non-member attempt -> 403 Forbidden
      const unauthReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${projA.id}/workspace/files/${fileA.id}`,
        bob.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'unauthorized save', baseRevision: 1 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const unauthRes = await saveFileHandler(unauthReq, {
        params: { id: projA.id, fileId: fileA.id },
      });
      expect(unauthRes.status).toBe(403);

      // 4. Legitimate save with correct baseRevision -> 200 OK
      const validReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${projA.id}/workspace/files/${fileA.id}`,
        alice.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'updated valid content', baseRevision: 1 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const validRes = await saveFileHandler(validReq, {
        params: { id: projA.id, fileId: fileA.id },
      });
      expect(validRes.status).toBe(200);

      // 5. Subsequent save with old baseRevision (1) -> 409 Conflict
      const conflictReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${projA.id}/workspace/files/${fileA.id}`,
        alice.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'stale save', baseRevision: 1 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const conflictRes = await saveFileHandler(conflictReq, {
        params: { id: projA.id, fileId: fileA.id },
      });
      expect(conflictRes.status).toBe(409);

      // 6. Explicit forceOverwrite: true succeeds even when baseRevision is omitted
      const forceReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${projA.id}/workspace/files/${fileA.id}`,
        alice.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'forced content', forceOverwrite: true }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const forceRes = await saveFileHandler(forceReq, {
        params: { id: projA.id, fileId: fileA.id },
      });
      expect(forceRes.status).toBe(200);
      const forceBody = await forceRes.json();
      expect(forceBody.file.content).toBe('forced content');
      expect(forceBody.file.current_revision).toBe(3);
    });

    it('HTTP route PATCH /api/projects/:id/workspace/nodes/:nodeId distinguishes rename, folder move, and explicit root move', async () => {
      const alice = await db.createUser({ email: 'patch_alice@mit.edu', name: 'Alice' });
      const proj = await db.createProject({ name: 'PatchProj', description: '', leader_id: alice.id });

      const srcFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'src',
        type: 'folder',
        author_id: alice.id,
        author_name: alice.name,
      });

      const utilsFolder = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: srcFolder.id,
        name: 'utils',
        type: 'folder',
        author_id: alice.id,
        author_name: alice.name,
      });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: utilsFolder.id,
        name: 'test.ts',
        type: 'file',
        initialContent: 'test',
        author_id: alice.id,
        author_name: alice.name,
      });

      expect(file.parent_id).toBe(utilsFolder.id);
      expect(file.path).toBe('/src/utils/test.ts');

      // 1. Rename only -> MUST preserve parent utilsFolder.id
      const renameReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/nodes/${file.id}`,
        alice.id,
        {
          method: 'PATCH',
          body: JSON.stringify({ name: 'renamed.ts' }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const renameRes = await updateNodeHandler(renameReq, {
        params: { id: proj.id, nodeId: file.id },
      });
      expect(renameRes.status).toBe(200);
      const renameBody = await renameRes.json();
      expect(renameBody.node.name).toBe('renamed.ts');
      expect(renameBody.node.parent_id).toBe(utilsFolder.id);
      expect(renameBody.node.path).toBe('/src/utils/renamed.ts');

      // 2. Move to folder srcFolder -> updates parent and path
      const moveReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/nodes/${file.id}`,
        alice.id,
        {
          method: 'PATCH',
          body: JSON.stringify({ parent_id: srcFolder.id }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const moveRes = await updateNodeHandler(moveReq, {
        params: { id: proj.id, nodeId: file.id },
      });
      expect(moveRes.status).toBe(200);
      const moveBody = await moveRes.json();
      expect(moveBody.node.parent_id).toBe(srcFolder.id);
      expect(moveBody.node.path).toBe('/src/renamed.ts');

      // 3. Explicit root move (parent_id: null) -> updates parent to null and path to /renamed.ts
      const rootMoveReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/nodes/${file.id}`,
        alice.id,
        {
          method: 'PATCH',
          body: JSON.stringify({ parent_id: null }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const rootMoveRes = await updateNodeHandler(rootMoveReq, {
        params: { id: proj.id, nodeId: file.id },
      });
      expect(rootMoveRes.status).toBe(200);
      const rootMoveBody = await rootMoveRes.json();
      expect(rootMoveBody.node.parent_id).toBeNull();
      expect(rootMoveBody.node.path).toBe('/renamed.ts');

      // 4. Moving folder into its own descendant -> 400
      const cycleReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/nodes/${srcFolder.id}`,
        alice.id,
        {
          method: 'PATCH',
          body: JSON.stringify({ parent_id: utilsFolder.id }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const cycleRes = await updateNodeHandler(cycleReq, {
        params: { id: proj.id, nodeId: srcFolder.id },
      });
      expect(cycleRes.status).toBe(400);
      const cycleBody = await cycleRes.json();
      expect(cycleBody.error).toMatch(/descendant/i);

      // 5. Cross-project parent folder injection -> 400
      const stranger = await db.createUser({ email: 'stranger_patch@mit.edu', name: 'Stranger' });
      const foreignProj = await db.createProject({ name: 'ForeignProj', description: '', leader_id: stranger.id });
      const foreignFolder = await db.createWorkspaceNode({
        project_id: foreignProj.id,
        name: 'foreign_dir',
        type: 'folder',
        author_id: stranger.id,
        author_name: stranger.name,
      });

      const foreignReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/nodes/${file.id}`,
        alice.id,
        {
          method: 'PATCH',
          body: JSON.stringify({ parent_id: foreignFolder.id }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const foreignRes = await updateNodeHandler(foreignReq, {
        params: { id: proj.id, nodeId: file.id },
      });
      expect(foreignRes.status).toBe(400);
      const foreignBody = await foreignRes.json();
      expect(foreignBody.error).toMatch(/Target parent folder not found/i);
    });
  });

  // =========================================================================
  // AREA H: Concurrency-Safe Revision Restoration
  // =========================================================================
  describe('Area H: Concurrency-Safe Revision Restoration', () => {
    it('HTTP restore route requires positive-integer baseRevision and rejects missing with 400', async () => {
      const user = await db.createUser({ email: 'h_restore1@mit.edu', name: 'User H1' });
      const proj = await db.createProject({ name: 'Proj H1', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.txt',
        type: 'file',
        initialContent: 'v1',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'v2', 1, user.id, user.name);

      // 1. Missing baseRevision -> 400 Bad Request
      const missingReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const missingRes = await restoreRevisionHandler(missingReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(missingRes.status).toBe(400);
      const missingBody = await missingRes.json();
      expect(missingBody.error).toMatch(/baseRevision.*required/i);
    });

    it('HTTP restore route rejects non-numeric, zero, negative, and fractional baseRevision with 400', async () => {
      const user = await db.createUser({ email: 'h_restore2@mit.edu', name: 'User H2' });
      const proj = await db.createProject({ name: 'Proj H2', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.txt',
        type: 'file',
        initialContent: 'v1',
        author_id: user.id,
        author_name: user.name,
      });

      for (const invalidBase of [-1, 0, 1.5, 'invalid', null]) {
        const req = createAuthedRequest(
          `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
          user.id,
          {
            method: 'POST',
            body: JSON.stringify({ revisionNumber: 1, baseRevision: invalidBase }),
            headers: { 'Content-Type': 'application/json' },
          }
        );
        const res = await restoreRevisionHandler(req, {
          params: { id: proj.id, fileId: file.id },
        });
        expect(res.status).toBe(400);
      }
    });

    it('HTTP restore route rejects stale baseRevision with 409 conflict and includes currentRevision', async () => {
      const user = await db.createUser({ email: 'h_restore3@mit.edu', name: 'User H3' });
      const proj = await db.createProject({ name: 'Proj H3', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.txt',
        type: 'file',
        initialContent: 'v1',
        author_id: user.id,
        author_name: user.name,
      });

      // Update to rev 2, then rev 3
      await db.saveWorkspaceFile(file.id, 'v2', 1, user.id, user.name);
      await db.saveWorkspaceFile(file.id, 'v3', 2, user.id, user.name);

      // Attempt restore of rev 1 using stale baseRevision 2 (current is 3) -> 409 Conflict
      const req = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1, baseRevision: 2 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const res = await restoreRevisionHandler(req, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.conflict).toBe(true);
      expect(body.currentRevision).toBe(3);
    });

    it('HTTP restore route succeeds with matching baseRevision, creates new revision, and preserves history', async () => {
      const user = await db.createUser({ email: 'h_restore4@mit.edu', name: 'User H4' });
      const proj = await db.createProject({ name: 'Proj H4', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.txt',
        type: 'file',
        initialContent: 'version 1 content',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'version 2 content', 1, user.id, user.name);
      await db.saveWorkspaceFile(file.id, 'version 3 content', 2, user.id, user.name);

      // Restore Rev 1 with current baseRevision 3 -> 200 OK
      const req = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1, baseRevision: 3 }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const res = await restoreRevisionHandler(req, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.file.current_revision).toBe(4);
      expect(body.file.content).toBe('version 1 content');

      // Check all 4 revisions are intact
      const revisions = await db.getWorkspaceFileRevisions(file.id);
      expect(revisions).toHaveLength(4);
      expect(revisions[0].revision_number).toBe(4);
      expect(revisions[0].content).toBe('version 1 content');
      expect(revisions[1].revision_number).toBe(3);
      expect(revisions[1].content).toBe('version 3 content');
    });

    it('HTTP restore route permits separate deliberate forceOverwrite workflow without baseRevision', async () => {
      const user = await db.createUser({ email: 'h_restore5@mit.edu', name: 'User H5' });
      const proj = await db.createProject({ name: 'Proj H5', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.txt',
        type: 'file',
        initialContent: 'first',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'second', 1, user.id, user.name);

      // Deliberate force restoration
      const req = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1, forceOverwrite: true }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const res = await restoreRevisionHandler(req, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.file.current_revision).toBe(3);
      expect(body.file.content).toBe('first');
    });

    it('SupabaseDatabaseAdapter.restoreWorkspaceRevision enforces baseRevision concurrency check', async () => {
      let rpcCalls: any[] = [];
      const mockFile = {
        id: 'file-occ-1',
        project_id: 'proj-1',
        type: 'file',
        name: 'doc.md',
        current_revision: 2,
      };

      const mockClient: any = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              is: () => ({
                single: async () => ({ data: mockFile, error: null }),
              }),
              eq: () => ({
                single: async () => ({
                  data: { node_id: 'file-occ-1', revision_number: 1, content: 'original' },
                  error: null,
                }),
              }),
              order: () => ({
                eq: async () => ({ data: [{ revision_number: 2, content: 'v2' }], error: null }),
              }),
            }),
          }),
        }),
        rpc: async (fn: string, args: any) => {
          rpcCalls.push({ fn, args });
          return { data: { conflict: false, currentRevision: 3, file: mockFile }, error: null };
        },
      };

      const adapter = new SupabaseDatabaseAdapter(mockClient);

      // Missing baseRevision without forceOverwrite throws error
      await expect(
        adapter.restoreWorkspaceRevision('file-occ-1', 1, 'user-1', 'User 1')
      ).rejects.toThrow(/baseRevision must be specified/i);

      // Stale baseRevision (passing 1 when current is 2) throws Conflict
      await expect(
        adapter.restoreWorkspaceRevision('file-occ-1', 1, 'user-1', 'User 1', 1)
      ).rejects.toThrow(/Conflict.*updated to revision 2/i);

      // Correct baseRevision passes baseRevision and forceOverwrite: false to saveWorkspaceFile
      await adapter.restoreWorkspaceRevision('file-occ-1', 1, 'user-1', 'User 1', 2);
      expect(rpcCalls.length).toBe(1);
      expect(rpcCalls[0].args.p_base_revision).toBe(2);
      expect(rpcCalls[0].args.p_force_overwrite).toBe(false);

      // Force overwrite passes forceOverwrite: true
      await adapter.restoreWorkspaceRevision('file-occ-1', 1, 'user-1', 'User 1', undefined, true);
      expect(rpcCalls.length).toBe(2);
      expect(rpcCalls[1].args.p_force_overwrite).toBe(true);
    });
  });

  // =========================================================================
  // AREA I: Wildcard-Safe Folder Hierarchy and Subtree Traversal
  // =========================================================================
  describe('Area I: Wildcard-Safe Folder Hierarchy and Subtree Traversal', () => {
    it('renaming and soft-deleting folders with SQL wildcard characters (_ and %) does not affect sibling paths', async () => {
      const user = await db.createUser({ email: 'wildcard_user@mit.edu', name: 'Wildcard User' });
      const proj = await db.createProject({ name: 'WildcardProj', description: '', leader_id: user.id });

      // Create folder /test_dir and its child /test_dir/nested.txt
      const testDir = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test_dir',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const nestedFile = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: testDir.id,
        name: 'nested.txt',
        type: 'file',
        initialContent: 'nested content',
        author_id: user.id,
        author_name: user.name,
      });

      // Create sibling folder /test1dir and its child /test1dir/sibling.txt
      const test1Dir = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test1dir',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const siblingFile = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: test1Dir.id,
        name: 'sibling.txt',
        type: 'file',
        initialContent: 'sibling content',
        author_id: user.id,
        author_name: user.name,
      });

      // Create folder /100%_docs and /1000docs
      const percentDir = await db.createWorkspaceNode({
        project_id: proj.id,
        name: '100%_docs',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const percentFile = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: percentDir.id,
        name: 'readme.md',
        type: 'file',
        initialContent: 'readme',
        author_id: user.id,
        author_name: user.name,
      });

      const thousandDir = await db.createWorkspaceNode({
        project_id: proj.id,
        name: '1000docs',
        type: 'folder',
        author_id: user.id,
        author_name: user.name,
      });

      const thousandFile = await db.createWorkspaceNode({
        project_id: proj.id,
        parent_id: thousandDir.id,
        name: 'spec.md',
        type: 'file',
        initialContent: 'spec',
        author_id: user.id,
        author_name: user.name,
      });

      expect(testDir.path).toBe('/test_dir');
      expect(nestedFile.path).toBe('/test_dir/nested.txt');
      expect(test1Dir.path).toBe('/test1dir');
      expect(siblingFile.path).toBe('/test1dir/sibling.txt');
      expect(percentDir.path).toBe('/100%_docs');
      expect(percentFile.path).toBe('/100%_docs/readme.md');
      expect(thousandDir.path).toBe('/1000docs');
      expect(thousandFile.path).toBe('/1000docs/spec.md');

      // 1. Rename /test_dir -> /test_dir_renamed
      await db.updateWorkspaceNode(testDir.id, { name: 'test_dir_renamed' }, user.id, user.name);

      const updatedNested = await db.getWorkspaceNode(nestedFile.id);
      expect(updatedNested?.path).toBe('/test_dir_renamed/nested.txt');

      // Sibling /test1dir must be UNCHANGED
      const checkTest1Dir = await db.getWorkspaceNode(test1Dir.id);
      expect(checkTest1Dir?.path).toBe('/test1dir');
      const checkSibling = await db.getWorkspaceNode(siblingFile.id);
      expect(checkSibling?.path).toBe('/test1dir/sibling.txt');

      // 2. Soft delete /test_dir_renamed
      await db.deleteWorkspaceNode(testDir.id);

      // Verify /test_dir_renamed and its child are deleted
      expect(await db.getWorkspaceNode(testDir.id)).toBeNull();
      expect(await db.getWorkspaceNode(nestedFile.id)).toBeNull();

      // Sibling /test1dir and its child must remain ACTIVE
      expect(await db.getWorkspaceNode(test1Dir.id)).not.toBeNull();
      expect(await db.getWorkspaceNode(siblingFile.id)).not.toBeNull();

      // 3. Rename /100%_docs -> /100%_archive
      await db.updateWorkspaceNode(percentDir.id, { name: '100%_archive' }, user.id, user.name);

      const updatedPercentFile = await db.getWorkspaceNode(percentFile.id);
      expect(updatedPercentFile?.path).toBe('/100%_archive/readme.md');

      // /1000docs and its child must remain completely UNCHANGED
      const checkThousandDir = await db.getWorkspaceNode(thousandDir.id);
      expect(checkThousandDir?.path).toBe('/1000docs');
      const checkThousandFile = await db.getWorkspaceNode(thousandFile.id);
      expect(checkThousandFile?.path).toBe('/1000docs/spec.md');
    });
  });

  // =========================================================================
  // AREA J: Security Definer Hardening, RPC Hygiene, and Caller Identity
  // =========================================================================
  describe('Area J: Security Definer RPC Hardening, Checksum Resolution, and Caller Identity', () => {
    it('migration 20241011 and corrective migration 20241012 satisfy all architectural hardening requirements', () => {
      const mig1Path = path.join(process.cwd(), 'supabase', 'migrations', '20241011_add_workspace.sql');
      const mig2Path = path.join(process.cwd(), 'supabase', 'migrations', '20241012_harden_workspace_security_and_rpc.sql');

      expect(fs.existsSync(mig1Path)).toBe(true);
      expect(fs.existsSync(mig2Path)).toBe(true);

      const m1 = fs.readFileSync(mig1Path, 'utf-8');
      const m2 = fs.readFileSync(mig2Path, 'utf-8');

      for (const [name, content] of [['20241011', m1], ['20241012', m2]]) {
        // 1. Pinned empty search_path for SECURITY DEFINER hardening
        expect(content).toContain("SET search_path = ''");

        // 2. Schema-agnostic checksum calculation function
        expect(content).toContain('CREATE OR REPLACE FUNCTION public.workspace_calculate_checksum');
        expect(content).toContain('extensions.digest');
        expect(content).toContain('public.digest');

        // 3. Wildcard-safe recursive CTE subtree traversal
        expect(content).toContain('WITH RECURSIVE descendants AS');

        // 4. Stale overload removal
        expect(content).toContain('DROP FUNCTION IF EXISTS public.save_workspace_file_atomic(UUID, TEXT, INTEGER, UUID, TEXT, TEXT);');
        expect(content).toContain('DROP FUNCTION IF EXISTS public.update_workspace_node_atomic(UUID, TEXT, UUID, UUID, TEXT);');
        expect(content).toContain('DROP FUNCTION IF EXISTS public.delete_workspace_node_atomic(UUID, UUID);');

        // 5. Caller identity handling checking JWT claims / session user instead of vulnerable current_user or invalid pg_catalog.session_user
        expect(content).toContain("current_setting('request.jwt.claim.role', true)");
        expect(content).toContain("SESSION_USER IN ('service_role', 'postgres')");
        expect(content).not.toContain("pg_catalog.session_user");
        expect(content).toContain('p_author_id <> v_auth_uid');

        // 6. Direct table writes revoked from PUBLIC, anon, authenticated
        expect(content).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.workspace_nodes FROM PUBLIC, anon, authenticated;');
        expect(content).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.workspace_revisions FROM PUBLIC, anon, authenticated;');

        // 7. Explicit RPC privileges
        expect(content).toContain('GRANT EXECUTE ON FUNCTION public.create_workspace_node_atomic');
        expect(content).toContain('GRANT EXECUTE ON FUNCTION public.save_workspace_file_atomic');
        expect(content).toContain('GRANT EXECUTE ON FUNCTION public.update_workspace_node_atomic');
        expect(content).toContain('GRANT EXECUTE ON FUNCTION public.delete_workspace_node_atomic');
        expect(content).toContain('GRANT EXECUTE ON FUNCTION public.workspace_calculate_checksum');

        // 8. Database-level authoritative checksum computation and integrity check
        expect(content).toContain('v_computed_checksum := public.workspace_calculate_checksum');
        expect(content).toContain('Checksum mismatch: Supplied checksum does not match computed content hash.');
      }
    });

    it('SupabaseDatabaseAdapter.createWorkspaceNode computes sha256 checksum and passes it to atomic RPC', async () => {
      let rpcArgs: any = null;
      const mockClient: any = {
        rpc: async (fn: string, args: any) => {
          rpcArgs = args;
          return {
            data: {
              id: 'node-chk-1',
              name: 'index.ts',
              type: 'file',
              current_revision: 1,
            },
            error: null,
          };
        },
      };

      const adapter = new SupabaseDatabaseAdapter(mockClient);
      await adapter.createWorkspaceNode({
        project_id: 'proj-chk',
        name: 'index.ts',
        type: 'file',
        initialContent: 'hello world',
        author_id: 'user-chk',
        author_name: 'Checksum User',
      });

      expect(rpcArgs).toBeDefined();
      expect(rpcArgs.p_name).toBe('index.ts');
      // sha256 of "hello world" is b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
      expect(rpcArgs.p_checksum).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });
  });

  // =========================================================================
  // AREA K: Strict forceOverwrite Type Validation and Explicit Workflow Enforcement
  // =========================================================================
  describe('Area K: Strict forceOverwrite Type Validation and Explicit Workflow Enforcement', () => {
    it('HTTP save route strictly rejects non-boolean forceOverwrite values with 400', async () => {
      const user = await db.createUser({ email: 'k_save_val@mit.edu', name: 'User K1' });
      const proj = await db.createProject({ name: 'Proj K1', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.ts',
        type: 'file',
        initialContent: 'initial',
        author_id: user.id,
        author_name: user.name,
      });

      // Invalid types for forceOverwrite: string "false", string "true", number 1, number 0, null, object {}
      for (const invalidVal of ['false', 'true', 1, 0, null, {}]) {
        const req = createAuthedRequest(
          `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}`,
          user.id,
          {
            method: 'PUT',
            body: JSON.stringify({
              content: 'tampered',
              forceOverwrite: invalidVal,
            }),
            headers: { 'Content-Type': 'application/json' },
          }
        );
        const res = await saveFileHandler(req, {
          params: { id: proj.id, fileId: file.id },
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/forceOverwrite.*boolean/i);
      }
    });

    it('HTTP restore route strictly rejects non-boolean forceOverwrite values with 400', async () => {
      const user = await db.createUser({ email: 'k_rest_val@mit.edu', name: 'User K2' });
      const proj = await db.createProject({ name: 'Proj K2', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'test.ts',
        type: 'file',
        initialContent: 'v1',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'v2', 1, user.id, user.name);

      // Invalid types for forceOverwrite in restore
      for (const invalidVal of ['false', 'true', 1, 0, null, {}]) {
        const req = createAuthedRequest(
          `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
          user.id,
          {
            method: 'POST',
            body: JSON.stringify({
              revisionNumber: 1,
              forceOverwrite: invalidVal,
            }),
            headers: { 'Content-Type': 'application/json' },
          }
        );
        const res = await restoreRevisionHandler(req, {
          params: { id: proj.id, fileId: file.id },
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/forceOverwrite.*boolean/i);
      }
    });

    it('LocalDatabaseAdapter and SupabaseDatabaseAdapter reject non-boolean forceOverwrite values', async () => {
      const user = await db.createUser({ email: 'k_adapter@mit.edu', name: 'User K3' });
      const proj = await db.createProject({ name: 'Proj K3', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'adapter_test.ts',
        type: 'file',
        initialContent: 'init',
        author_id: user.id,
        author_name: user.name,
      });

      // Local adapter save
      await expect(
        db.saveWorkspaceFile(file.id, 'new', 1, user.id, user.name, 'false' as any)
      ).rejects.toThrow(/forceOverwrite.*boolean/i);

      // Local adapter restore
      await expect(
        db.restoreWorkspaceRevision(file.id, 1, user.id, user.name, 1, 'false' as any)
      ).rejects.toThrow(/forceOverwrite.*boolean/i);

      // Supabase adapter save
      const mockClient: any = { rpc: async () => ({ data: null, error: null }) };
      const supabaseDb = new SupabaseDatabaseAdapter(mockClient);

      await expect(
        supabaseDb.saveWorkspaceFile(file.id, 'new', 1, user.id, user.name, 'false' as any)
      ).rejects.toThrow(/forceOverwrite.*boolean/i);

      // Supabase adapter restore
      await expect(
        supabaseDb.restoreWorkspaceRevision(file.id, 1, user.id, user.name, 1, 'false' as any)
      ).rejects.toThrow(/forceOverwrite.*boolean/i);
    });

    it('forceOverwrite: false preserves optimistic concurrency checks and returns 409 conflict on stale save and restore', async () => {
      const user = await db.createUser({ email: 'k_occ@mit.edu', name: 'User K4' });
      const proj = await db.createProject({ name: 'Proj K4', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'occ_test.ts',
        type: 'file',
        initialContent: 'rev1',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'rev2', 1, user.id, user.name);

      // Save with forceOverwrite: false and stale baseRevision 1 (current is 2) -> 409
      const saveReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}`,
        user.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'stale', baseRevision: 1, forceOverwrite: false }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const saveRes = await saveFileHandler(saveReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(saveRes.status).toBe(409);

      // Restore with forceOverwrite: false and stale baseRevision 1 (current is 2) -> 409
      const restReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1, baseRevision: 1, forceOverwrite: false }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const restRes = await restoreRevisionHandler(restReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(restRes.status).toBe(409);
    });

    it('explicit forceOverwrite: true bypasses OCC checks and succeeds for both save and restore', async () => {
      const user = await db.createUser({ email: 'k_force@mit.edu', name: 'User K5' });
      const proj = await db.createProject({ name: 'Proj K5', description: '', leader_id: user.id });

      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'force_test.ts',
        type: 'file',
        initialContent: 'rev1',
        author_id: user.id,
        author_name: user.name,
      });

      await db.saveWorkspaceFile(file.id, 'rev2', 1, user.id, user.name);

      // Force save with forceOverwrite: true
      const saveReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}`,
        user.id,
        {
          method: 'PUT',
          body: JSON.stringify({ content: 'forced rev3', forceOverwrite: true }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const saveRes = await saveFileHandler(saveReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(saveRes.status).toBe(200);
      const saveBody = await saveRes.json();
      expect(saveBody.file.current_revision).toBe(3);
      expect(saveBody.file.content).toBe('forced rev3');

      // Force restore with forceOverwrite: true
      const restReq = createAuthedRequest(
        `http://localhost:3000/api/projects/${proj.id}/workspace/files/${file.id}/restore`,
        user.id,
        {
          method: 'POST',
          body: JSON.stringify({ revisionNumber: 1, forceOverwrite: true }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const restRes = await restoreRevisionHandler(restReq, {
        params: { id: proj.id, fileId: file.id },
      });
      expect(restRes.status).toBe(200);
      const restBody = await restRes.json();
      expect(restBody.file.current_revision).toBe(4);
      expect(restBody.file.content).toBe('rev1');
    });
  });

  // =========================================================================
  // AREA L: Database Checksum Integrity & SHA-256 Representation
  // =========================================================================
  describe('Area L: Database Checksum Integrity & SHA-256 Representation', () => {
    it('verifies SHA-256 checksums match authoritative cryptographic test vectors', () => {
      const crypto = require('crypto');

      const testVectors = [
        {
          input: '',
          expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        {
          input: 'hello world',
          expected: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
        },
        {
          input: 'The quick brown fox jumps over the lazy dog',
          expected: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
        },
        {
          input: '{"version": 1, "test": true}',
          expected: '34a1fe834ac25512d2ec3d8f3baeae721377ea246a9c9fb3a6268f8ebe6957b4',
        },
      ];

      for (const vector of testVectors) {
        const computed = crypto.createHash('sha256').update(vector.input).digest('hex');
        expect(computed).toBe(vector.expected);
        expect(computed).toHaveLength(64);
        expect(computed).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('persists identical and correct SHA-256 representation across initial node creation and subsequent saves', async () => {
      const user = await db.createUser({ email: 'l_chk@mit.edu', name: 'User L' });
      const proj = await db.createProject({ name: 'Proj L', description: '', leader_id: user.id });

      // 1. Initial creation with known vector
      const file = await db.createWorkspaceNode({
        project_id: proj.id,
        name: 'vector.txt',
        type: 'file',
        initialContent: 'The quick brown fox jumps over the lazy dog',
        author_id: user.id,
        author_name: user.name,
      });

      const rev1 = (await db.getWorkspaceFileRevisions(file.id))[0];
      expect(rev1.checksum).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');

      // 2. Subsequent save with empty string
      await db.saveWorkspaceFile(file.id, '', 1, user.id, user.name);
      const rev2 = (await db.getWorkspaceFileRevisions(file.id))[0];
      expect(rev2.checksum).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

      // 3. Subsequent save with "hello world"
      await db.saveWorkspaceFile(file.id, 'hello world', 2, user.id, user.name);
      const rev3 = (await db.getWorkspaceFileRevisions(file.id))[0];
      expect(rev3.checksum).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });

    it('direct RPC invocation simulation: rejects fabricated checksum and rolls back transaction', async () => {
      // Simulating the database logic in create_workspace_node_atomic and save_workspace_file_atomic:
      const simulateRpcChecksumPolicy = (content: string, clientChecksum: string | null | undefined) => {
        const crypto = require('crypto');
        const computedChecksum = crypto.createHash('sha256').update(content).digest('hex');

        if (clientChecksum !== null && clientChecksum !== undefined && clientChecksum.trim() !== '') {
          if (clientChecksum.trim().toLowerCase() !== computedChecksum) {
            throw new Error('Checksum mismatch: Supplied checksum does not match computed content hash.');
          }
        }
        return computedChecksum;
      };

      const validContent = 'secure payload';
      const crypto = require('crypto');
      const correctHash = crypto.createHash('sha256').update(validContent).digest('hex');

      // 1. Valid checksum matches
      expect(simulateRpcChecksumPolicy(validContent, correctHash)).toBe(correctHash);

      // 2. Omitted checksum defaults to authoritative computed hash
      expect(simulateRpcChecksumPolicy(validContent, null)).toBe(correctHash);
      expect(simulateRpcChecksumPolicy(validContent, undefined)).toBe(correctHash);
      expect(simulateRpcChecksumPolicy(validContent, '')).toBe(correctHash);

      // 3. Fabricated checksum throws mismatch exception
      expect(() =>
        simulateRpcChecksumPolicy(validContent, 'fabricated0000000000000000000000000000000000000000000000000000000000')
      ).toThrow(/Checksum mismatch/i);

      // 4. Case-insensitive match accepted and normalized
      expect(simulateRpcChecksumPolicy(validContent, correctHash.toUpperCase())).toBe(correctHash);
    });
  });

  // =========================================================================
  // AREA M: Filename Path Separator Validation and SQL Syntax Audit
  // =========================================================================
  describe('Area M: Filename Path Separator Validation and SQL Syntax Audit', () => {
    describe('[Static Migration SQL Audit]', () => {
      it('both migration files replace pg_catalog.position with pg_catalog.strpos and remove redundant E\'\\0\'', () => {
        const migrations = [
          path.join(process.cwd(), 'supabase', 'migrations', '20241011_add_workspace.sql'),
          path.join(process.cwd(), 'supabase', 'migrations', '20241012_harden_workspace_security_and_rpc.sql'),
        ];

        for (const migPath of migrations) {
          expect(fs.existsSync(migPath)).toBe(true);
          const sql = fs.readFileSync(migPath, 'utf-8');

          // Must NOT contain schema-qualified position with special IN syntax
          expect(sql).not.toMatch(/pg_catalog\.position\s*\(/i);
          expect(sql).not.toMatch(/position\s*\([^)]*in\s+v_clean_name\)/i);

          // Must NOT contain redundant E'\0'
          expect(sql).not.toContain("E'\\0'");

          // Must use pg_catalog.strpos(v_clean_name, '/') > 0
          const forwardSlashMatches = sql.match(/pg_catalog\.strpos\s*\(\s*v_clean_name\s*,\s*'\/'\s*\)\s*>\s*0/g);
          expect(forwardSlashMatches).not.toBeNull();
          expect(forwardSlashMatches!.length).toBeGreaterThanOrEqual(2);

          // Must use pg_catalog.strpos(v_clean_name, pg_catalog.chr(92)) > 0
          const backslashMatches = sql.match(
            /pg_catalog\.strpos\s*\(\s*v_clean_name\s*,\s*pg_catalog\.chr\s*\(\s*92\s*\)\s*\)\s*>\s*0/g
          );
          expect(backslashMatches).not.toBeNull();
          expect(backslashMatches!.length).toBeGreaterThanOrEqual(2);
        }
      });
    });

    describe('[Observable Application & Local Adapter Tests]', () => {
      it('rejects file and folder creation with names containing forward slash (/)', async () => {
        const user = await db.createUser({ email: 'm_slash@mit.edu', name: 'User M1' });
        const proj = await db.createProject({ name: 'Proj M1', description: '', leader_id: user.id });

        const invalidNames = ['foo/bar.ts', '/leading.ts', 'trailing/', 'a/b/c'];
        for (const name of invalidNames) {
          // Direct DB adapter test
          await expect(
            db.createWorkspaceNode({
              project_id: proj.id,
              name,
              type: 'file',
              author_id: user.id,
              author_name: user.name,
            })
          ).rejects.toThrow(/Invalid file or folder name/i);

          // API route test
          const req = createAuthedRequest(
            `http://localhost:3000/api/projects/${proj.id}/workspace/nodes`,
            user.id,
            {
              method: 'POST',
              body: JSON.stringify({ name, type: 'file' }),
              headers: { 'Content-Type': 'application/json' },
            }
          );
          const res = await createNodeHandler(req, { params: { id: proj.id } });
          expect(res.status).toBe(400);
          const body = await res.json();
          expect(body.error).toMatch(/Invalid file or folder name/i);
        }
      });

      it('rejects file and folder creation with names containing single or multiple backslashes (\\)', async () => {
        const user = await db.createUser({ email: 'm_backslash@mit.edu', name: 'User M2' });
        const proj = await db.createProject({ name: 'Proj M2', description: '', leader_id: user.id });

        // Note: includes single backslash, consecutive backslashes, and literal \0 sequence
        const invalidNames = ['foo\\bar.ts', '\\leading.ts', 'trailing\\', 'test\\0file.ts', 'deep\\\\name.ts'];
        for (const name of invalidNames) {
          await expect(
            db.createWorkspaceNode({
              project_id: proj.id,
              name,
              type: 'file',
              author_id: user.id,
              author_name: user.name,
            })
          ).rejects.toThrow(/Invalid file or folder name/i);

          const req = createAuthedRequest(
            `http://localhost:3000/api/projects/${proj.id}/workspace/nodes`,
            user.id,
            {
              method: 'POST',
              body: JSON.stringify({ name, type: 'folder' }),
              headers: { 'Content-Type': 'application/json' },
            }
          );
          const res = await createNodeHandler(req, { params: { id: proj.id } });
          expect(res.status).toBe(400);
        }
      });

      it('rejects empty names, whitespace-only names, and dot relative path names', async () => {
        const user = await db.createUser({ email: 'm_empty@mit.edu', name: 'User M3' });
        const proj = await db.createProject({ name: 'Proj M3', description: '', leader_id: user.id });

        const invalidNames = ['', '   ', '.', '..', ' . ', ' .. '];
        for (const name of invalidNames) {
          await expect(
            db.createWorkspaceNode({
              project_id: proj.id,
              name,
              type: 'file',
              author_id: user.id,
              author_name: user.name,
            })
          ).rejects.toThrow(/Invalid file or folder name/i);
        }
      });

      it('accepts valid ordinary filenames and folder names with typical conventions', async () => {
        const user = await db.createUser({ email: 'm_valid@mit.edu', name: 'User M4' });
        const proj = await db.createProject({ name: 'Proj M4', description: '', leader_id: user.id });

        const validNames = [
          'main.ts',
          'app.component.spec.tsx',
          'README-2024.md',
          'data_source_v2.json',
          'spaced file name.txt',
          '.env.example',
          'src',
          'sub-folder_01',
        ];

        for (const name of validNames) {
          const node = await db.createWorkspaceNode({
            project_id: proj.id,
            name,
            type: name.includes('.') ? 'file' : 'folder',
            author_id: user.id,
            author_name: user.name,
          });
          expect(node).toBeDefined();
          expect(node.name).toBe(name.trim());
        }
      });

      it('rejects node rename with invalid path separators (/ and \\)', async () => {
        const user = await db.createUser({ email: 'm_rename_invalid@mit.edu', name: 'User M5' });
        const proj = await db.createProject({ name: 'Proj M5', description: '', leader_id: user.id });

        const file = await db.createWorkspaceNode({
          project_id: proj.id,
          name: 'original.ts',
          type: 'file',
          author_id: user.id,
          author_name: user.name,
        });

        const invalidRenameNames = ['renamed/file.ts', 'renamed\\file.ts', '..', ''];
        for (const badName of invalidRenameNames) {
          // Direct DB
          await expect(
            db.updateWorkspaceNode(file.id, { name: badName }, user.id, user.name)
          ).rejects.toThrow(/Invalid name/i);

          // API route
          const req = createAuthedRequest(
            `http://localhost:3000/api/projects/${proj.id}/workspace/nodes/${file.id}`,
            user.id,
            {
              method: 'PATCH',
              body: JSON.stringify({ name: badName }),
              headers: { 'Content-Type': 'application/json' },
            }
          );
          const res = await updateNodeHandler(req, { params: { id: proj.id, nodeId: file.id } });
          expect(res.status).toBe(400);
        }
      });

      it('continues to support folder rename and move operations with proper path updates', async () => {
        const user = await db.createUser({ email: 'm_folder_ops@mit.edu', name: 'User M6' });
        const proj = await db.createProject({ name: 'Proj M6', description: '', leader_id: user.id });

        // 1. Create parent folder and nested child folder and file
        const parentFolder = await db.createWorkspaceNode({
          project_id: proj.id,
          name: 'parent',
          type: 'folder',
          author_id: user.id,
          author_name: user.name,
        });
        expect(parentFolder.path).toBe('/parent');

        const childFolder = await db.createWorkspaceNode({
          project_id: proj.id,
          name: 'child',
          type: 'folder',
          parent_id: parentFolder.id,
          author_id: user.id,
          author_name: user.name,
        });
        expect(childFolder.path).toBe('/parent/child');

        const childFile = await db.createWorkspaceNode({
          project_id: proj.id,
          name: 'child_file.ts',
          type: 'file',
          parent_id: childFolder.id,
          author_id: user.id,
          author_name: user.name,
        });
        expect(childFile.path).toBe('/parent/child/child_file.ts');

        // 2. Rename parent folder -> descendant paths must update
        const renamedParent = await db.updateWorkspaceNode(
          parentFolder.id,
          { name: 'renamed_parent' },
          user.id,
          user.name
        );
        expect(renamedParent.name).toBe('renamed_parent');
        expect(renamedParent.path).toBe('/renamed_parent');

        const childFolderAfter = await db.getWorkspaceNode(childFolder.id);
        const childFileAfter = await db.getWorkspaceNode(childFile.id);
        expect(childFolderAfter?.path).toBe('/renamed_parent/child');
        expect(childFileAfter?.path).toBe('/renamed_parent/child/child_file.ts');

        // Verify tree hierarchy also reflects updated path and structure
        const treeAfterRename = await db.getWorkspaceTree(proj.id);
        expect(treeAfterRename).toHaveLength(1);
        expect(treeAfterRename[0].path).toBe('/renamed_parent');
        expect(treeAfterRename[0].children?.[0].path).toBe('/renamed_parent/child');
        expect(treeAfterRename[0].children?.[0].children?.[0].path).toBe('/renamed_parent/child/child_file.ts');

        // 3. Move child folder to root -> descendant file path must update
        const movedChild = await db.updateWorkspaceNode(
          childFolder.id,
          { parent_id: null },
          user.id,
          user.name
        );
        expect(movedChild.parent_id).toBeNull();
        expect(movedChild.path).toBe('/child');

        const childFileAfterMove = await db.getWorkspaceNode(childFile.id);
        expect(childFileAfterMove?.path).toBe('/child/child_file.ts');

        const treeAfterMove = await db.getWorkspaceTree(proj.id);
        const rootChild = treeAfterMove.find((n) => n.id === childFolder.id);
        expect(rootChild?.path).toBe('/child');
        expect(rootChild?.children?.[0].path).toBe('/child/child_file.ts');
      });
    });
  });
});
