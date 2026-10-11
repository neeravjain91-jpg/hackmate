import { Client, ClientConfig } from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface HarnessConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
}

export function getDbConfig(overrides?: HarnessConfig): ClientConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ...overrides };
  }
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'hackmate_test',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'testpassword',
    ...overrides,
  };
}

export async function createAdminClient(): Promise<Client> {
  const config = getDbConfig();
  const client = new Client(config);
  await client.connect();
  return client;
}

export async function createTestRunnerClient(): Promise<Client> {
  const baseConfig = getDbConfig();
  const config: ClientConfig = {
    ...baseConfig,
    user: 'test_runner',
    password: 'testpassword',
  };
  const client = new Client(config);
  await client.connect();
  return client;
}

export async function applyMigrations(adminClient: Client): Promise<void> {
  const rootDir = process.cwd();
  const files = [
    path.join(rootDir, 'tests/fixtures/bootstrap_postgres.sql'),
    path.join(rootDir, 'supabase/migrations/20241011_add_workspace.sql'),
    path.join(rootDir, 'supabase/migrations/20241012_harden_workspace_security_and_rpc.sql'),
  ];

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Migration file not found: ${filePath}`);
    }
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await adminClient.query(sql);
    } catch (err: any) {
      throw new Error(`Failed to apply migration ${path.basename(filePath)}: ${err.message}`);
    }
  }
}

export async function cleanTables(adminClient: Client): Promise<void> {
  await adminClient.query(`
    TRUNCATE
      public.workspace_revisions,
      public.workspace_nodes,
      public.project_members,
      public.projects,
      public.profiles,
      auth.users
    CASCADE;
  `);
}

export async function withUser<T>(
  client: Client,
  userId: string,
  fn: (c: Client) => Promise<T>,
  role: string = 'authenticated'
): Promise<T> {
  await client.query('BEGIN;');
  try {
    await client.query(`SET LOCAL ROLE ${role};`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', true);`);
    await client.query(`SELECT set_config('request.jwt.claim.role', '${role}', true);`);
    const result = await fn(client);
    await client.query('COMMIT;');
    return result;
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  }
}

export async function withServiceRole<T>(
  client: Client,
  fn: (c: Client) => Promise<T>
): Promise<T> {
  await client.query('BEGIN;');
  try {
    await client.query('SET LOCAL ROLE service_role;');
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true);`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', true);`);
    const result = await fn(client);
    await client.query('COMMIT;');
    return result;
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  }
}

export async function withAnon<T>(
  client: Client,
  fn: (c: Client) => Promise<T>
): Promise<T> {
  await client.query('BEGIN;');
  try {
    await client.query('SET LOCAL ROLE anon;');
    await client.query(`SELECT set_config('request.jwt.claim.role', 'anon', true);`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', true);`);
    const result = await fn(client);
    await client.query('COMMIT;');
    return result;
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  }
}

export async function withUnauthenticated<T>(
  client: Client,
  fn: (c: Client) => Promise<T>
): Promise<T> {
  await client.query('BEGIN;');
  try {
    await client.query('SET LOCAL ROLE authenticated;');
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', true);`);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true);`);
    const result = await fn(client);
    await client.query('COMMIT;');
    return result;
  } catch (err) {
    await client.query('ROLLBACK;');
    throw err;
  }
}

// Direct RPC helper wrappers
export async function rpcCreateWorkspaceNode(
  client: Client,
  params: {
    projectId: string;
    parentId?: string | null;
    name: string;
    type: 'file' | 'folder';
    initialContent?: string | null;
    authorId?: string | null;
    authorName?: string | null;
    checksum?: string | null;
  }
) {
  const query = `
    SELECT public.create_workspace_node_atomic(
      $1::uuid,
      $2::uuid,
      $3::text,
      $4::public.workspace_node_type,
      $5::text,
      $6::uuid,
      $7::text,
      $8::text
    ) as result;
  `;
  const res = await client.query(query, [
    params.projectId,
    params.parentId ?? null,
    params.name,
    params.type,
    params.initialContent ?? null,
    params.authorId ?? null,
    params.authorName ?? null,
    params.checksum ?? null,
  ]);
  return res.rows[0]?.result;
}

export async function rpcSaveWorkspaceFile(
  client: Client,
  params: {
    fileId: string;
    content: string;
    baseRevision: number | null;
    authorId?: string | null;
    authorName?: string | null;
    checksum?: string | null;
    projectId?: string | null;
    forceOverwrite?: boolean;
  }
) {
  const query = `
    SELECT public.save_workspace_file_atomic(
      $1::uuid,
      $2::text,
      $3::integer,
      $4::uuid,
      $5::text,
      $6::text,
      $7::uuid,
      $8::boolean
    ) as result;
  `;
  const res = await client.query(query, [
    params.fileId,
    params.content,
    params.baseRevision,
    params.authorId ?? null,
    params.authorName ?? null,
    params.checksum ?? null,
    params.projectId ?? null,
    params.forceOverwrite ?? false,
  ]);
  return res.rows[0]?.result;
}

export async function rpcUpdateWorkspaceNode(
  client: Client,
  params: {
    nodeId: string;
    name?: string | null;
    parentId?: string | null;
    authorId?: string | null;
    authorName?: string | null;
    projectId?: string | null;
    updateParent?: boolean;
  }
) {
  const query = `
    SELECT public.update_workspace_node_atomic(
      $1::uuid,
      $2::text,
      $3::uuid,
      $4::uuid,
      $5::text,
      $6::uuid,
      $7::boolean
    ) as result;
  `;
  const res = await client.query(query, [
    params.nodeId,
    params.name ?? null,
    params.parentId ?? null,
    params.authorId ?? null,
    params.authorName ?? null,
    params.projectId ?? null,
    params.updateParent ?? false,
  ]);
  return res.rows[0]?.result;
}

export async function rpcDeleteWorkspaceNode(
  client: Client,
  params: {
    nodeId: string;
    authorId?: string | null;
    projectId?: string | null;
  }
) {
  const query = `
    SELECT public.delete_workspace_node_atomic(
      $1::uuid,
      $2::uuid,
      $3::uuid
    ) as result;
  `;
  const res = await client.query(query, [
    params.nodeId,
    params.authorId ?? null,
    params.projectId ?? null,
  ]);
  return res.rows[0]?.result;
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
