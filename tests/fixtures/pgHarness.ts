import { Client, ClientConfig } from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const EXPECTED_TEST_DATABASE = 'hackmate_test';
export const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
export const ALLOWED_CI_SERVICE_HOSTS = new Set(['postgres']);

export interface HarnessConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
}

export interface ValidatedTestConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string | (() => string | Promise<string>);
}

/**
 * Verifies whether the target is the designated GitHub Actions disposable
 * service container environment.
 * Requires:
 * 1. CI === 'true'
 * 2. GITHUB_ACTIONS === 'true'
 * 3. HACKMATE_CI_SERVICE_CONTAINER === 'true'
 * 4. PGDATABASE === EXPECTED_TEST_DATABASE
 * 5. targetHost (or process.env.PGHOST) is an allowed CI service host ('postgres')
 *    and NOT a local loopback host (127.0.0.1, localhost, ::1).
 *
 * Local execution with loopback targets (127.0.0.1/localhost) CANNOT bypass
 * isolated disposable cluster provisioning, even if CI markers are set.
 */
export function isVerifiedGitHubActionsService(targetHost?: string): boolean {
  const isCI = process.env.CI === 'true';
  const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  const isHackmateService = process.env.HACKMATE_CI_SERVICE_CONTAINER === 'true';
  const isExpectedDb = process.env.PGDATABASE === EXPECTED_TEST_DATABASE;

  if (!isCI || !isGitHubActions || !isHackmateService || !isExpectedDb) {
    return false;
  }

  const hostToCheck = (targetHost || process.env.PGHOST || '').toLowerCase();
  if (!hostToCheck || ALLOWED_LOCAL_HOSTS.has(hostToCheck)) {
    return false;
  }

  return ALLOWED_CI_SERVICE_HOSTS.has(hostToCheck);
}

/**
 * Validates connection target strictly against safety rules.
 * Fails closed before any connection, migration, fixture creation, or truncation.
 * Error messages never leak passwords or sensitive connection URLs.
 */
export function validateDbTarget(config: ClientConfig | HarnessConfig): ValidatedTestConfig {
  let host: string | undefined;
  let port: number | undefined;
  let database: string | undefined;
  let user: string | undefined;
  let password: string | (() => string | Promise<string>) | undefined;

  if (config.connectionString) {
    let parsed: URL;
    try {
      parsed = new URL(config.connectionString);
    } catch {
      throw new Error('Safety violation: Invalid connection URL format. Aborting.');
    }
    host = parsed.hostname;
    port = parsed.port ? parseInt(parsed.port, 10) : 5432;
    database = parsed.pathname.replace(/^\//, '');
    user = parsed.username || undefined;
    password = parsed.password || undefined;
  } else {
    host = config.host;
    port = config.port ? Number(config.port) : 5432;
    database = config.database;
    user = config.user;
    password = config.password;
  }

  // 1. Database name validation: must be strictly 'hackmate_test'
  if (!database || database !== EXPECTED_TEST_DATABASE) {
    const sanitizedDb = database ? `"${database}"` : '(unspecified)';
    throw new Error(
      `Safety violation: Target database must be strictly "${EXPECTED_TEST_DATABASE}". ` +
      `Received: ${sanitizedDb}. Aborting to prevent accidental execution against non-test database.`
    );
  }

  // 2. Host validation: local execution must be loopback only
  if (!host) {
    throw new Error('Safety violation: Target host is unspecified. Aborting.');
  }

  const hostLower = host.toLowerCase();
  const isLoopback = ALLOWED_LOCAL_HOSTS.has(hostLower);
  const isCiServiceHost = ALLOWED_CI_SERVICE_HOSTS.has(hostLower);

  if (isLoopback) {
    // Local loopback execution strictly requires an isolated temporary instance.
    // CI service bypass is forbidden on loopback to protect local developer databases.
    const isDisposable = process.env.HACKMATE_DISPOSABLE_INSTANCE === 'true';
    if (!isDisposable) {
      throw new Error(
        'Safety violation: Direct connection to shared PostgreSQL cluster is disallowed. ' +
        'Local tests must execute against an isolated temporary instance with HACKMATE_DISPOSABLE_INSTANCE=true ' +
        'to prevent persistent cluster-wide changes.'
      );
    }
  } else if (isCiServiceHost) {
    // CI service container host is only allowed in verified GitHub Actions environment
    if (!isVerifiedGitHubActionsService(host)) {
      throw new Error(
        `Safety violation: CI service container host "${host}" is only permitted ` +
        `within a verified GitHub Actions disposable container environment. Aborting.`
      );
    }
  } else {
    // All other hosts (remote databases, shared development hosts) are strictly forbidden
    throw new Error(
      `Safety violation: Target host must be a loopback address (${Array.from(ALLOWED_LOCAL_HOSTS).join(', ')}) ` +
      `for local test execution or a verified CI service host (${Array.from(ALLOWED_CI_SERVICE_HOSTS).join(', ')}) in CI. ` +
      `Received: "${host}". Remote or shared databases are strictly disallowed.`
    );
  }

  return {
    host,
    port: port || 5432,
    database,
    user: user || 'postgres',
    password,
  };
}

/**
 * Resolves database configuration for test execution.
 * DATABASE_URL is deliberately ignored as an implicit test target to prevent
 * accidental connection to shared/production databases.
 * Only TEST_DATABASE_URL or discrete PG* variables are considered, and they
 * are strictly validated against fail-closed safety constraints.
 */
export function getDbConfig(overrides?: HarnessConfig): ClientConfig {
  let rawConfig: HarnessConfig;

  if (overrides?.connectionString) {
    rawConfig = { ...overrides };
  } else if (process.env.TEST_DATABASE_URL) {
    rawConfig = { connectionString: process.env.TEST_DATABASE_URL, ...overrides };
  } else {
    rawConfig = {
      host: process.env.PGHOST || '127.0.0.1',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || EXPECTED_TEST_DATABASE,
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'testpassword',
      ...overrides,
    };
  }

  const validated = validateDbTarget(rawConfig);
  return {
    host: validated.host,
    port: validated.port,
    database: validated.database,
    user: validated.user,
    password: validated.password,
  };
}

export async function createAdminClient(overrides?: HarnessConfig): Promise<Client> {
  const config = getDbConfig(overrides);
  const client = new Client(config);
  await client.connect();

  // In-database runtime verification before any operations
  const res = await client.query('SELECT current_database() as db;');
  const activeDb = res.rows[0]?.db;
  if (activeDb !== EXPECTED_TEST_DATABASE) {
    await client.end();
    throw new Error(
      `Safety violation: Active connected database is "${activeDb}", expected "${EXPECTED_TEST_DATABASE}". Connection aborted.`
    );
  }

  return client;
}

export async function createTestRunnerClient(overrides?: HarnessConfig): Promise<Client> {
  const baseConfig = getDbConfig(overrides);
  const config: ClientConfig = {
    ...baseConfig,
    user: 'test_runner',
    password: 'testpassword',
  };
  const client = new Client(config);
  await client.connect();

  // In-database runtime verification
  const res = await client.query('SELECT current_database() as db;');
  const activeDb = res.rows[0]?.db;
  if (activeDb !== EXPECTED_TEST_DATABASE) {
    await client.end();
    throw new Error(
      `Safety violation: Active connected database is "${activeDb}", expected "${EXPECTED_TEST_DATABASE}". Connection aborted.`
    );
  }

  return client;
}

export async function applyMigrations(adminClient: Client): Promise<void> {
  // Pre-migration safety check
  const checkRes = await adminClient.query('SELECT current_database() as db;');
  if (checkRes.rows[0]?.db !== EXPECTED_TEST_DATABASE) {
    throw new Error(
      `Safety violation: Refusing to apply migrations to non-test database "${checkRes.rows[0]?.db}".`
    );
  }

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
  // Pre-truncation safety check
  const checkRes = await adminClient.query('SELECT current_database() as db;');
  if (checkRes.rows[0]?.db !== EXPECTED_TEST_DATABASE) {
    throw new Error(
      `Safety violation: Refusing to truncate tables on non-test database "${checkRes.rows[0]?.db}".`
    );
  }

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
