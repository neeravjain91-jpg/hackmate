import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';
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
      expect(content).toContain('save_workspace_file_atomic');
      expect(content).toContain('update_workspace_node_atomic');
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
});
