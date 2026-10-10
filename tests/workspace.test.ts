import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';

const TEST_DIR = path.join(process.cwd(), 'data', 'test_workspace_data');
const TEST_DB_PATH = path.join(TEST_DIR, 'hackmate_test.json');

describe('Milestone: Common Development Workspace — Acceptance Test Suite', () => {
  let db: LocalDatabaseAdapter;

  beforeEach(() => {
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
  });

  it('W1 & W2: Multi-member access & file creation visibility', async () => {
    // Leader Alice creates project
    const alice = await db.createUser({ email: 'alice@mit.edu', name: 'Alice' });
    const project = await db.createProject({
      name: 'Workspace Core',
      description: 'Shared editor testing',
      leader_id: alice.id,
    });

    // Teammate Bob joins
    const bob = await db.createUser({ email: 'bob@mit.edu', name: 'Bob' });
    await db.joinProject(project.id, bob.id, 'member');

    // Alice creates a folder 'src'
    const folder = await db.createWorkspaceNode({
      project_id: project.id,
      name: 'src',
      type: 'folder',
      author_id: alice.id,
      author_name: alice.name,
    });
    expect(folder.path).toBe('/src');

    // Bob creates a file 'src/model.py'
    const file = await db.createWorkspaceNode({
      project_id: project.id,
      parent_id: folder.id,
      name: 'model.py',
      type: 'file',
      initialContent: 'import torch\nclass Net(torch.nn.Module):\n    pass\n',
      author_id: bob.id,
      author_name: bob.name,
    });
    expect(file.path).toBe('/src/model.py');
    expect(file.current_revision).toBe(1);

    // Alice fetches the workspace tree and verifies she sees Bob's file inside 'src'
    const tree = await db.getWorkspaceTree(project.id);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('src');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].name).toBe('model.py');

    // Alice opens the file
    const fileForAlice = await db.getWorkspaceFile(file.id);
    expect(fileForAlice).not.toBeNull();
    expect(fileForAlice?.content).toContain('class Net');
    expect(fileForAlice?.last_modified_name).toBe('Bob');
  });

  it('W3: Persistence across database re-instantiations (logout/login)', async () => {
    const alice = await db.createUser({ email: 'a@test.com', name: 'Alice' });
    const project = await db.createProject({ name: 'PersistProj', description: '', leader_id: alice.id });

    const file = await db.createWorkspaceNode({
      project_id: project.id,
      name: 'pipeline.ts',
      type: 'file',
      initialContent: 'export const run = () => true;',
      author_id: alice.id,
      author_name: alice.name,
    });

    // Save an edit
    await db.saveWorkspaceFile(
      file.id,
      'export const run = () => false; // updated',
      1,
      alice.id,
      alice.name
    );

    // Re-instantiate database adapter (simulating server reboot or new session)
    const freshDb = new LocalDatabaseAdapter(TEST_DB_PATH);
    const reloadedFile = await freshDb.getWorkspaceFile(file.id);

    expect(reloadedFile).not.toBeNull();
    expect(reloadedFile?.content).toBe('export const run = () => false; // updated');
    expect(reloadedFile?.current_revision).toBe(2);
  });

  it('W4: File revision history and non-destructive recovery', async () => {
    const alice = await db.createUser({ email: 'alice@rev.com', name: 'Alice' });
    const bob = await db.createUser({ email: 'bob@rev.com', name: 'Bob' });
    const project = await db.createProject({ name: 'RevisionProj', description: '', leader_id: alice.id });
    await db.joinProject(project.id, bob.id, 'member');

    // Rev 1
    const file = await db.createWorkspaceNode({
      project_id: project.id,
      name: 'config.json',
      type: 'file',
      initialContent: '{"version": 1}',
      author_id: alice.id,
      author_name: alice.name,
    });

    // Rev 2 (Alice edits)
    await db.saveWorkspaceFile(file.id, '{"version": 2}', 1, alice.id, alice.name);

    // Rev 3 (Bob edits)
    await db.saveWorkspaceFile(file.id, '{"version": 3}', 2, bob.id, bob.name);

    // Inspect history
    const revisions = await db.getWorkspaceFileRevisions(file.id);
    expect(revisions).toHaveLength(3);
    expect(revisions[0].revision_number).toBe(3);
    expect(revisions[0].author_name).toBe('Bob');
    expect(revisions[1].revision_number).toBe(2);
    expect(revisions[2].revision_number).toBe(1);

    // Restore Rev 1 -> creates Rev 4 with Rev 1 content
    const restored = await db.restoreWorkspaceRevision(file.id, 1, alice.id, alice.name);
    expect(restored.current_revision).toBe(4);
    expect(restored.content).toBe('{"version": 1}');

    // Previous revisions remain intact
    const afterRestoreRevisions = await db.getWorkspaceFileRevisions(file.id);
    expect(afterRestoreRevisions).toHaveLength(4);
  });

  it('W5: Conflict detection prevents silent overwrites', async () => {
    const alice = await db.createUser({ email: 'alice@conflict.com', name: 'Alice' });
    const bob = await db.createUser({ email: 'bob@conflict.com', name: 'Bob' });
    const project = await db.createProject({ name: 'ConflictProj', description: '', leader_id: alice.id });
    await db.joinProject(project.id, bob.id, 'member');

    const file = await db.createWorkspaceNode({
      project_id: project.id,
      name: 'shared.py',
      type: 'file',
      initialContent: '# Initial version',
      author_id: alice.id,
      author_name: alice.name,
    });
    expect(file.current_revision).toBe(1);

    // Both Alice and Bob open file at base revision 1
    // Alice saves first -> advances to Rev 2
    const aliceSave = await db.saveWorkspaceFile(
      file.id,
      '# Alice changes',
      1,
      alice.id,
      alice.name
    );
    expect(aliceSave.conflict).toBe(false);
    expect(aliceSave.file.current_revision).toBe(2);

    // Bob tries to save against base revision 1 -> CONFLICT DETECTED!
    const bobSave = await db.saveWorkspaceFile(
      file.id,
      '# Bob conflicting changes',
      1,
      bob.id,
      bob.name
    );
    expect(bobSave.conflict).toBe(true);
    expect(bobSave.currentRevision).toBe(2);

    // Verify Bob's change did NOT overwrite Alice's file
    const currentFile = await db.getWorkspaceFile(file.id);
    expect(currentFile?.content).toBe('# Alice changes');
    expect(currentFile?.current_revision).toBe(2);
  });

  it('W6: Unauthorized users cannot access or modify workspace files', async () => {
    const alice = await db.createUser({ email: 'alice@private.com', name: 'Alice' });
    const stranger = await db.createUser({ email: 'stranger@outside.com', name: 'Stranger' });
    const project = await db.createProject({ name: 'PrivateProj', description: '', leader_id: alice.id });

    // Stranger tries to create a file in Alice's project -> REJECTED
    await expect(
      db.createWorkspaceNode({
        project_id: project.id,
        name: 'hacked.sh',
        type: 'file',
        author_id: stranger.id,
        author_name: stranger.name,
      })
    ).rejects.toThrow(/Forbidden/i);
  });

  it('W7: Existing task management and Shared Work functionality continue operating cleanly', async () => {
    const alice = await db.createUser({ email: 'alice@full.com', name: 'Alice' });
    const bob = await db.createUser({ email: 'bob@full.com', name: 'Bob' });
    const project = await db.createProject({ name: 'FullProj', description: '', leader_id: alice.id });
    await db.joinProject(project.id, bob.id, 'member');

    // Create task
    const task = await db.createTask({
      project_id: project.id,
      title: 'Build Neural Net',
      description: 'Use the common workspace src/net.py',
      assigned_to: bob.id,
      created_by: alice.id,
    });
    expect(task.status).toBe('Assigned');

    // Bob creates the workspace file
    const node = await db.createWorkspaceNode({
      project_id: project.id,
      name: 'net.py',
      type: 'file',
      initialContent: 'import torch',
      author_id: bob.id,
      author_name: bob.name,
    });
    expect(node.id).toBeDefined();

    // Bob updates task to In Progress and then Submitted
    const updatedTask = await db.updateTask(task.id, bob.id, { status: 'Submitted' });
    expect(updatedTask.status).toBe('Submitted');

    // Alice approves task
    const approved = await db.updateTask(task.id, alice.id, { status: 'Approved' });
    expect(approved.status).toBe('Approved');
  });

  it('W8: File and folder deletion does not destroy recoverable history', async () => {
    const alice = await db.createUser({ email: 'alice@audit.com', name: 'Alice' });
    const bob = await db.createUser({ email: 'bob@audit.com', name: 'Bob' });
    const project = await db.createProject({ name: 'AuditProj', description: '', leader_id: alice.id });
    await db.joinProject(project.id, bob.id, 'member');

    // Alice creates file
    const file = await db.createWorkspaceNode({
      project_id: project.id,
      name: 'critical_model.py',
      type: 'file',
      initialContent: '# Initial release v1',
      author_id: alice.id,
      author_name: alice.name,
    });
    expect(file.current_revision).toBe(1);

    // Bob edits file to Rev 2
    await db.saveWorkspaceFile(file.id, '# Bob improved v2', 1, bob.id, bob.name);

    // Alice deletes the file
    const deleteResult = await db.deleteWorkspaceNode(file.id);
    expect(deleteResult).toBe(true);

    // Tree no longer contains the deleted file
    const activeTree = await db.getWorkspaceTree(project.id);
    expect(activeTree).toHaveLength(0);

    // getWorkspaceFile returns null
    const opened = await db.getWorkspaceFile(file.id);
    expect(opened).toBeNull();

    // CRITICAL REQUIREMENT: Revision history is NOT destroyed and remains recoverable
    const revisions = await db.getWorkspaceFileRevisions(file.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[0].revision_number).toBe(2);
    expect(revisions[0].content).toBe('# Bob improved v2');
    expect(revisions[0].author_name).toBe('Bob');
    expect(revisions[1].revision_number).toBe(1);
    expect(revisions[1].content).toBe('# Initial release v1');
    expect(revisions[1].author_name).toBe('Alice');

    // Editing a deleted file is rejected
    await expect(
      db.saveWorkspaceFile(file.id, '# new edit', 2, alice.id, alice.name)
    ).rejects.toThrow(/Workspace file not found/i);
  });

  it('W9: Security validation — Path traversal and file size limit checks', async () => {
    const alice = await db.createUser({ email: 'alice@sec.com', name: 'Alice' });
    const project = await db.createProject({ name: 'SecProj', description: '', leader_id: alice.id });

    // Path traversal in filename
    await expect(
      db.createWorkspaceNode({
        project_id: project.id,
        name: '../evil.py',
        type: 'file',
        author_id: alice.id,
        author_name: alice.name,
      })
    ).rejects.toThrow(/Invalid file or folder name/i);

    // File content exceeding 10MB limit
    const hugeContent = 'a'.repeat(10 * 1024 * 1024 + 10);
    await expect(
      db.createWorkspaceNode({
        project_id: project.id,
        name: 'huge.txt',
        type: 'file',
        initialContent: hugeContent,
        author_id: alice.id,
        author_name: alice.name,
      })
    ).rejects.toThrow(/maximum size limit/i);
  });
});
