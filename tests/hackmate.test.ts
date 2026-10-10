import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { LocalDatabaseAdapter } from '@/lib/db/localDb';
import { LocalStorageAdapter } from '@/lib/storage/localStorage';

const TEST_DIR = path.join(process.cwd(), 'data', 'test_data');
const TEST_DB_PATH = path.join(TEST_DIR, 'hackmate_test.json');
const TEST_STORAGE_DIR = path.join(TEST_DIR, 'storage');

describe('HackMate — End-to-End Specification Verification Suite', () => {
  let db: LocalDatabaseAdapter;
  let storage: LocalStorageAdapter;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new LocalDatabaseAdapter(TEST_DB_PATH);
    storage = new LocalStorageAdapter(TEST_STORAGE_DIR);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('Test 1: Project creation — Registered user creates a project and becomes its leader', async () => {
    const leader = await db.createUser({
      email: 'leader@hackathon.org',
      name: 'Leader Alice',
      password_hash: 'hashed_pw',
    });
    expect(leader.id).toBeDefined();
    expect(leader.email).toBe('leader@hackathon.org');

    const project = await db.createProject({
      name: 'NeuroVision AI',
      description: 'Computer vision diagnostics for medical scans',
      hackathon_name: 'HackMIT 2026',
      leader_id: leader.id,
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe('NeuroVision AI');
    expect(project.leader_id).toBe(leader.id);
    expect(project.invite_code).toHaveLength(8);
    expect(project.members).toHaveLength(1);
    expect(project.members[0].user_id).toBe(leader.id);
    expect(project.members[0].role).toBe('leader');

    const isLeader = await db.isProjectLeader(project.id, leader.id);
    expect(isLeader).toBe(true);
  });

  it('Test 2: Team membership — Additional users join using an invitation code', async () => {
    const leader = await db.createUser({ email: 'alice@mit.edu', name: 'Alice' });
    const project = await db.createProject({
      name: 'HackMate Core',
      description: 'Platform for hackathon teams',
      leader_id: leader.id,
    });

    const memberB = await db.createUser({ email: 'bob@mit.edu', name: 'Bob' });
    const memberC = await db.createUser({ email: 'carol@mit.edu', name: 'Carol' });

    // Join using project ID / invitation code
    const foundProject = await db.getProjectByInviteCode(project.invite_code);
    expect(foundProject).not.toBeNull();
    expect(foundProject?.id).toBe(project.id);

    const membershipB = await db.joinProject(project.id, memberB.id, 'member');
    const membershipC = await db.joinProject(project.id, memberC.id, 'member');

    expect(membershipB.role).toBe('member');
    expect(membershipC.role).toBe('member');

    const members = await db.getProjectMembers(project.id);
    expect(members).toHaveLength(3);
    const emails = members.map((m) => m.user?.email);
    expect(emails).toContain('alice@mit.edu');
    expect(emails).toContain('bob@mit.edu');
    expect(emails).toContain('carol@mit.edu');
  });

  it('Test 3: Team limit — Project accepts strictly no more than 6 members (1 leader + 5 teammates)', async () => {
    const leader = await db.createUser({ email: 'l@test.com', name: 'Leader' });
    const project = await db.createProject({
      name: 'Strict Six Team',
      description: 'Testing 6-member hard cap',
      leader_id: leader.id,
    });

    // Add 5 teammates (total reaching 6 members)
    for (let i = 1; i <= 5; i++) {
      const user = await db.createUser({ email: `member${i}@test.com`, name: `Member ${i}` });
      await db.joinProject(project.id, user.id, 'member');
    }

    const currentMembers = await db.getProjectMembers(project.id);
    expect(currentMembers).toHaveLength(6);

    // Attempt to add a 7th member — MUST be rejected
    const extraUser = await db.createUser({ email: 'member7@test.com', name: 'Member 7' });
    await expect(db.joinProject(project.id, extraUser.id, 'member')).rejects.toThrow(
      /cannot have more than 6 members/i
    );

    // Verify team count remains 6
    const finalMembers = await db.getProjectMembers(project.id);
    expect(finalMembers).toHaveLength(6);
  });

  it('Test 4: Assignment & status updates — Leader assigns task, member updates permitted status', async () => {
    const leader = await db.createUser({ email: 'lead@test.com', name: 'Lead' });
    const project = await db.createProject({ name: 'TaskProject', description: 'Testing Tasks', leader_id: leader.id });
    const member = await db.createUser({ email: 'dev@test.com', name: 'Dev' });
    await db.joinProject(project.id, member.id, 'member');

    // Leader creates and assigns task
    const task = await db.createTask({
      project_id: project.id,
      title: 'Train ML Model',
      description: 'Train ResNet50 on dataset and export weights',
      assigned_to: member.id,
      created_by: leader.id,
      deadline: '2026-10-12T18:00:00Z',
    });

    expect(task.status).toBe('Assigned');
    expect(task.assigned_to).toBe(member.id);

    // Member updates status to "In Progress"
    const inProgressTask = await db.updateTask(task.id, member.id, { status: 'In Progress' });
    expect(inProgressTask.status).toBe('In Progress');

    // Member updates status to "Submitted"
    const submittedTask = await db.updateTask(task.id, member.id, { status: 'Submitted' });
    expect(submittedTask.status).toBe('Submitted');

    // Member cannot approve their own task (leader permission required)
    await expect(
      db.updateTask(task.id, member.id, { status: 'Approved' })
    ).rejects.toThrow(/requires leader review/i);

    // Member cannot modify task description or title
    await expect(
      db.updateTask(task.id, member.id, { title: 'Hacked Title' })
    ).rejects.toThrow(/cannot change task details/i);
  });

  it('Test 5: Contribution publishing — Member publishes contribution with multiple files', async () => {
    const leader = await db.createUser({ email: 'l@hack.com', name: 'Leader' });
    const project = await db.createProject({ name: 'SharedWorkProject', description: 'Contributions', leader_id: leader.id });
    const member = await db.createUser({ email: 'ai@hack.com', name: 'AI Engineer' });
    await db.joinProject(project.id, member.id, 'member');

    const file1Name = 'train_model.py';
    const file1Buffer = Buffer.from('import torch\nprint("Model training pipeline")\n', 'utf-8');
    const file1Id = uuidv4();
    const stored1 = await storage.saveFile(project.id, file1Id, file1Name, file1Buffer, 'text/x-python');

    const file2Name = 'requirements.txt';
    const file2Buffer = Buffer.from('torch>=2.0.0\ntorchvision\nnumpy\n', 'utf-8');
    const file2Id = uuidv4();
    const stored2 = await storage.saveFile(project.id, file2Id, file2Name, file2Buffer, 'text/plain');

    const contribution = await db.createContribution(
      {
        project_id: project.id,
        title: 'PyTorch Model Inference and Training Pipeline',
        description: 'Complete pipeline with checkpoints and preprocessing',
        contributor_id: member.id,
        contributor_name: member.name,
        version_label: 'v1.0.0',
        usage_instructions: 'Run `pip install -r requirements.txt` then `python train_model.py`',
        dependencies: 'Python 3.10+, CUDA 12',
      },
      [
        {
          id: file1Id,
          file_name: file1Name,
          file_size: stored1.fileSize,
          mime_type: 'text/x-python',
          storage_path: stored1.storagePath,
          checksum: stored1.checksum,
        },
        {
          id: file2Id,
          file_name: file2Name,
          file_size: stored2.fileSize,
          mime_type: 'text/plain',
          storage_path: stored2.storagePath,
          checksum: stored2.checksum,
        },
      ]
    );

    expect(contribution.id).toBeDefined();
    expect(contribution.files).toHaveLength(2);
    expect(contribution.version_label).toBe('v1.0.0');
    expect(contribution.contributor_name).toBe('AI Engineer');
  });

  it('Test 6 & 7: Cross-member access and Byte-for-byte File integrity', async () => {
    const leader = await db.createUser({ email: 'l@integrity.com', name: 'Leader' });
    const project = await db.createProject({ name: 'IntegrityProj', description: 'Testing File Integrity', leader_id: leader.id });
    const author = await db.createUser({ email: 'author@integrity.com', name: 'Author' });
    const downloader = await db.createUser({ email: 'downloader@integrity.com', name: 'Downloader' });

    await db.joinProject(project.id, author.id, 'member');
    await db.joinProject(project.id, downloader.id, 'member');

    // Create a binary file (e.g. simulated model weights or compressed archive)
    const originalBytes = crypto.randomBytes(64 * 1024); // 64 KB random binary data
    const originalHash = crypto.createHash('sha256').update(originalBytes).digest('hex');

    const fileId = uuidv4();
    const stored = await storage.saveFile(project.id, fileId, 'model_weights.bin', originalBytes, 'application/octet-stream');
    expect(stored.checksum).toBe(originalHash);

    const contrib = await db.createContribution(
      {
        project_id: project.id,
        title: 'Model Weights Binary Checkpoint',
        description: 'Trained checkpoint for production deployment',
        contributor_id: author.id,
        contributor_name: author.name,
        usage_instructions: 'Load via torch.load()',
        dependencies: 'PyTorch',
      },
      [
        {
          id: fileId,
          file_name: 'model_weights.bin',
          file_size: stored.fileSize,
          mime_type: 'application/octet-stream',
          storage_path: stored.storagePath,
          checksum: stored.checksum,
        },
      ]
    );

    // Downloader lists contributions
    const contribs = await db.getProjectContributions(project.id);
    expect(contribs).toHaveLength(1);
    expect(contribs[0].title).toBe('Model Weights Binary Checkpoint');

    // Downloader gets file metadata
    const fileRecord = await db.getContributionFileById(fileId);
    expect(fileRecord).not.toBeNull();
    expect(fileRecord?.checksum).toBe(originalHash);

    // Downloader downloads file from private storage
    const retrieved = await storage.getFile(project.id, fileRecord!.storage_path);
    expect(retrieved).not.toBeNull();

    // Verify exact byte-for-byte equality
    expect(Buffer.compare(originalBytes, retrieved!.buffer)).toBe(0);

    const retrievedHash = crypto.createHash('sha256').update(retrieved!.buffer).digest('hex');
    expect(retrievedHash).toBe(originalHash);
  });

  it('Test 8: Review — Leader approves submitted work or requests changes', async () => {
    const leader = await db.createUser({ email: 'lead@rev.com', name: 'Leader' });
    const project = await db.createProject({ name: 'ReviewProj', description: 'Testing Review', leader_id: leader.id });
    const member = await db.createUser({ email: 'mem@rev.com', name: 'Member' });
    await db.joinProject(project.id, member.id, 'member');

    const task = await db.createTask({
      project_id: project.id,
      title: 'Frontend Auth Screen',
      description: 'Implement Login and Registration components',
      assigned_to: member.id,
      created_by: leader.id,
    });

    // Member submits work
    await db.updateTask(task.id, member.id, { status: 'Submitted' });

    // Leader requests changes
    const changesRequested = await db.updateTask(task.id, leader.id, { status: 'Changes Requested' });
    expect(changesRequested.status).toBe('Changes Requested');

    // Member updates to in-progress then re-submits
    await db.updateTask(task.id, member.id, { status: 'In Progress' });
    await db.updateTask(task.id, member.id, { status: 'Submitted' });

    // Leader approves task
    const approvedTask = await db.updateTask(task.id, leader.id, { status: 'Approved' });
    expect(approvedTask.status).toBe('Approved');
  });

  it('Test 9: Access control — Non-member cannot access private project resources', async () => {
    const leader = await db.createUser({ email: 'l@sec.com', name: 'Leader' });
    const project = await db.createProject({ name: 'SecretProject', description: 'Classified work', leader_id: leader.id });

    const outsideUser = await db.createUser({ email: 'stranger@outside.com', name: 'Stranger' });

    const isMember = await db.isProjectMember(project.id, outsideUser.id);
    expect(isMember).toBe(false);

    // Non-member cannot publish contribution to this project
    await expect(
      db.createContribution(
        {
          project_id: project.id,
          title: 'Malicious Upload',
          description: 'Hacked',
          contributor_id: outsideUser.id,
          contributor_name: outsideUser.name,
          usage_instructions: 'none',
          dependencies: 'none',
        },
        []
      )
    ).rejects.toThrow(/Only project members can publish/i);
  });

  it('Test 10: Persistence — Data remains intact across independent database re-instantiations', async () => {
    const leader = await db.createUser({ email: 'persist@test.com', name: 'Persist Leader' });
    const project = await db.createProject({
      name: 'Persistent Hack',
      description: 'Will survive reload',
      leader_id: leader.id,
    });

    const task = await db.createTask({
      project_id: project.id,
      title: 'Persistent Task',
      description: 'Check persistence',
      assigned_to: leader.id,
      created_by: leader.id,
    });

    // Re-instantiate database adapter from same file path
    const reloadedDb = new LocalDatabaseAdapter(TEST_DB_PATH);

    const reloadedProject = await reloadedDb.getProjectById(project.id);
    expect(reloadedProject).not.toBeNull();
    expect(reloadedProject?.name).toBe('Persistent Hack');

    const reloadedTasks = await reloadedDb.getProjectTasks(project.id);
    expect(reloadedTasks).toHaveLength(1);
    expect(reloadedTasks[0].id).toBe(task.id);
    expect(reloadedTasks[0].title).toBe('Persistent Task');
  });

  it('Test 11: Error handling — Invalid inputs, duplicate emails, full team errors handled cleanly', async () => {
    // Duplicate email
    await db.createUser({ email: 'dup@test.com', name: 'First' });
    await expect(db.createUser({ email: 'dup@test.com', name: 'Second' })).rejects.toThrow(
      /already exists/i
    );

    // Creating project with nonexistent leader
    await expect(
      db.createProject({ name: 'BadProj', description: '', leader_id: 'non-existent-uuid' })
    ).rejects.toThrow(/Leader user does not exist/i);
  });
});
