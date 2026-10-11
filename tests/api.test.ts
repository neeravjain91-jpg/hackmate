import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST as registerHandler } from '@/app/api/auth/register/route';
import { POST as loginHandler } from '@/app/api/auth/login/route';
import { GET as meHandler } from '@/app/api/auth/me/route';
import { GET as getProjectsHandler, POST as createProjectHandler } from '@/app/api/projects/route';
import { POST as joinProjectHandler } from '@/app/api/projects/join/route';
import { GET as getProjectDetailHandler } from '@/app/api/projects/[id]/route';
import { GET as getTasksHandler, POST as createTaskHandler } from '@/app/api/projects/[id]/tasks/route';
import { PATCH as updateTaskHandler } from '@/app/api/projects/[id]/tasks/[taskId]/route';
import { GET as getContributionsHandler, POST as publishContributionHandler } from '@/app/api/projects/[id]/contributions/route';
import { GET as downloadFileHandler } from '@/app/api/projects/[id]/files/[fileId]/download/route';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { resetDatabaseAdapter } from '@/lib/db';
import { resetStorageAdapter } from '@/lib/storage';

const TEST_DIR = path.join(process.cwd(), 'data');
const TEST_DB_PATH = path.join(TEST_DIR, 'hackmate.json');
const TEST_STORAGE_DIR = path.join(TEST_DIR, 'storage');

describe('HackMate — HTTP API End-to-End Suite', () => {
  beforeEach(() => {
    resetDatabaseAdapter();
    resetStorageAdapter();
    // Reset test db
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH, { force: true });
    }
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    resetDatabaseAdapter();
    resetStorageAdapter();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH, { force: true });
    }
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      fs.rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  function createAuthedRequest(url: string, userId: string, init?: RequestInit): NextRequest {
    const token = createSessionToken(userId);
    const headers = new Headers(init?.headers);
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    const { signal, ...rest } = init || {};
    return new NextRequest(url, { ...rest, signal: signal ?? undefined, headers });
  }

  it('Flow: Full lifecycle from registration to project creation, join, task flow, upload, and download', async () => {
    // 1. Register Alice (Leader)
    const regReq = new NextRequest('http://localhost:3000/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@team.io', password: 'password123', name: 'Alice Leader' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const regRes = await registerHandler(regReq);
    expect(regRes.status).toBe(201);
    const { user: alice } = await regRes.json();
    expect(alice.id).toBeDefined();

    // 2. Register Bob (Member)
    const regBobReq = new NextRequest('http://localhost:3000/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'bob@team.io', password: 'password123', name: 'Bob Teammate' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const regBobRes = await registerHandler(regBobReq);
    expect(regBobRes.status).toBe(201);
    const { user: bob } = await regBobRes.json();

    // 3. Register Charlie (Outside User)
    const regCharlieReq = new NextRequest('http://localhost:3000/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'charlie@other.io', password: 'password123', name: 'Charlie Stranger' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const regCharlieRes = await registerHandler(regCharlieReq);
    const { user: charlie } = await regCharlieRes.json();

    // 4. Alice creates project
    const createProjReq = createAuthedRequest('http://localhost:3000/api/projects', alice.id, {
      method: 'POST',
      body: JSON.stringify({
        name: 'AutoML Studio',
        description: 'Automated ML for climate predictions',
        hackathon_name: 'ClimateHack 2026',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const createProjRes = await createProjectHandler(createProjReq);
    expect(createProjRes.status).toBe(201);
    const { project } = await createProjRes.json();
    expect(project.invite_code).toBeDefined();

    // 5. Bob joins using invite code
    const joinReq = createAuthedRequest('http://localhost:3000/api/projects/join', bob.id, {
      method: 'POST',
      body: JSON.stringify({ inviteCode: project.invite_code }),
      headers: { 'Content-Type': 'application/json' },
    });
    const joinRes = await joinProjectHandler(joinReq);
    expect(joinRes.status).toBe(200);
    const joinData = await joinRes.json();
    expect(joinData.success).toBe(true);

    // 6. Access control: Charlie tries to view Alice & Bob's project
    const charlieDetailReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}`,
      charlie.id
    );
    const charlieDetailRes = await getProjectDetailHandler(charlieDetailReq, {
      params: { id: project.id },
    });
    expect(charlieDetailRes.status).toBe(403);

    // 7. Alice creates a task for Bob
    const createTaskReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/tasks`,
      alice.id,
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Build Data Preprocessor',
          description: 'Normalize tabular inputs and remove outliers',
          assigned_to: bob.id,
          deadline: '2026-10-14',
        }),
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const createTaskRes = await createTaskHandler(createTaskReq, { params: { id: project.id } });
    expect(createTaskRes.status).toBe(201);
    const { task } = await createTaskRes.json();
    expect(task.status).toBe('Assigned');

    // 8. Bob updates task status to 'In Progress' and then 'Submitted'
    const updateTaskReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/tasks/${task.id}`,
      bob.id,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'In Progress' }),
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const updateTaskRes = await updateTaskHandler(updateTaskReq, {
      params: { id: project.id, taskId: task.id },
    });
    expect(updateTaskRes.status).toBe(200);

    const submitTaskReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/tasks/${task.id}`,
      bob.id,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Submitted' }),
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const submitTaskRes = await updateTaskHandler(submitTaskReq, {
      params: { id: project.id, taskId: task.id },
    });
    expect(submitTaskRes.status).toBe(200);

    // 9. Bob publishes contribution with attached file
    const fileContent = 'def preprocess(df):\n    return df.dropna()\n';
    const blob = new Blob([fileContent], { type: 'text/x-python' });
    const formData = new FormData();
    formData.append('title', 'Data Cleaning Script');
    formData.append('description', 'Pandas pipeline for data cleaning');
    formData.append('task_id', task.id);
    formData.append('version_label', 'v1.0');
    formData.append('usage_instructions', 'import preprocess from clean.py');
    formData.append('dependencies', 'pandas>=2.0');
    formData.append('files', blob, 'clean.py');

    const publishReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/contributions`,
      bob.id,
      {
        method: 'POST',
        body: formData,
      }
    );
    const publishRes = await publishContributionHandler(publishReq, {
      params: { id: project.id },
    });
    expect(publishRes.status).toBe(201);
    const { contribution } = await publishRes.json();
    expect(contribution.files).toHaveLength(1);
    const uploadedFile = contribution.files[0];
    expect(uploadedFile.file_name).toBe('clean.py');

    // 10. Alice (leader) downloads Bob's uploaded file and verifies integrity
    const downloadReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/files/${uploadedFile.id}/download`,
      alice.id
    );
    const downloadRes = await downloadFileHandler(downloadReq, {
      params: { id: project.id, fileId: uploadedFile.id },
    });
    expect(downloadRes.status).toBe(200);
    const downloadedText = await downloadRes.text();
    expect(downloadedText).toBe(fileContent);

    // 11. Charlie (outside user) tries to download Bob's file -> 403 Forbidden!
    const charlieDownloadReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/files/${uploadedFile.id}/download`,
      charlie.id
    );
    const charlieDownloadRes = await downloadFileHandler(charlieDownloadReq, {
      params: { id: project.id, fileId: uploadedFile.id },
    });
    expect(charlieDownloadRes.status).toBe(403);

    // 12. Alice (leader) reviews and Approves the submitted task
    const approveReq = createAuthedRequest(
      `http://localhost:3000/api/projects/${project.id}/tasks/${task.id}`,
      alice.id,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Approved' }),
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const approveRes = await updateTaskHandler(approveReq, {
      params: { id: project.id, taskId: task.id },
    });
    expect(approveRes.status).toBe(200);
    const { task: approvedTask } = await approveRes.json();
    expect(approvedTask.status).toBe('Approved');
  });
});
