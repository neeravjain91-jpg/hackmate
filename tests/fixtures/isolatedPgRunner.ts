import { execFileSync, execSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

export type ProvisioningStage =
  | 'allocated'
  | 'initdb_running'
  | 'initdb_completed'
  | 'starting_server'
  | 'server_started'
  | 'creating_db'
  | 'db_created'
  | 'verifying_readiness'
  | 'ready'
  | 'stopped';

export interface IsolatedPostgresInstance {
  host: string;
  port: number;
  dataDir: string;
  isWsl: boolean;
  stop: () => Promise<void>;
}

export interface PostgresBinaries {
  isWsl: boolean;
  binDir?: string;
  initdbPath: string;
  pgCtlPath: string;
  createdbPath: string;
  psqlPath: string;
}

export interface ProcessExecutor {
  execInitdb: (binPath: string, dataDir: string, isWsl: boolean) => void;
  execStartServer: (binPath: string, dataDir: string, port: number, isWsl: boolean) => void;
  execCreatedb: (binPath: string, port: number, isWsl: boolean) => void;
  execStopServer: (binPath: string, dataDir: string, isWsl: boolean) => void;
  confirmStopped: (dataDir: string, port: number, isWsl: boolean, pgCtlPath: string, maxWaitMs?: number) => Promise<boolean>;
  removeDataDir: (dataDir: string, isWsl: boolean) => void;
}

export interface ActiveInstanceRecord {
  dataDir: string;
  port: number;
  isWsl: boolean;
  pgCtlPath: string;
  stage: ProvisioningStage;
  serverStarted: boolean;
  stopped: boolean;
}

export interface ProvisionOptions {
  executor?: Partial<ProcessExecutor>;
  skipReadinessWait?: boolean;
  readinessRetries?: number;
  readinessIntervalMs?: number;
}

// Registry of running instances for emergency process cleanup
export const activeInstanceRecords = new Set<ActiveInstanceRecord>();

let cleanupHooksRegistered = false;
export function registerCleanupHooks(): void {
  if (cleanupHooksRegistered) return;
  cleanupHooksRegistered = true;

  const cleanupSync = () => {
    activeInstanceRecords.forEach((record) => {
      if (record.stopped) return;
      try {
        if (record.serverStarted) {
          if (record.isWsl) {
            execSync(`wsl ${record.pgCtlPath} -D ${record.dataDir} -m immediate stop 2>/dev/null || true`, { stdio: 'ignore' });
          } else {
            execSync(`"${record.pgCtlPath}" -D "${record.dataDir}" -m immediate stop 2>/dev/null || true`, { stdio: 'ignore' });
          }
        }
      } catch {
        // Best effort during emergency process exit
      }
      try {
        if (record.isWsl) {
          execSync(`wsl rm -rf ${record.dataDir} 2>/dev/null || true`, { stdio: 'ignore' });
        } else {
          if (fs.existsSync(record.dataDir)) {
            fs.rmSync(record.dataDir, { recursive: true, force: true });
          }
        }
        record.stopped = true;
      } catch {
        // Ignore during emergency exit
      }
    });
    activeInstanceRecords.clear();
  };

  process.once('exit', cleanupSync);
  process.once('SIGINT', () => {
    cleanupSync();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanupSync();
    process.exit(143);
  });
}

/**
 * Discovers PostgreSQL binaries on the host system.
 * Checks native PATH, common Linux/macOS directories, and WSL on Windows.
 */
export function discoverPostgresBinaries(): PostgresBinaries {
  // 1. Check native PATH
  try {
    execSync('initdb --version', { stdio: 'ignore' });
    return {
      isWsl: false,
      initdbPath: 'initdb',
      pgCtlPath: 'pg_ctl',
      createdbPath: 'createdb',
      psqlPath: 'psql',
    };
  } catch {
    // Not in native PATH
  }

  // 2. Check standard Linux/Debian/Ubuntu versioned directories
  const candidateLinuxDirs = [
    '/usr/lib/postgresql/18/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/15/bin',
    '/usr/lib/postgresql/14/bin',
  ];

  if (process.platform !== 'win32') {
    for (const binDir of candidateLinuxDirs) {
      if (fs.existsSync(path.join(binDir, 'initdb'))) {
        return {
          isWsl: false,
          binDir,
          initdbPath: path.join(binDir, 'initdb'),
          pgCtlPath: path.join(binDir, 'pg_ctl'),
          createdbPath: path.join(binDir, 'createdb'),
          psqlPath: path.join(binDir, 'psql'),
        };
      }
    }
  }

  // 3. On Windows, check WSL
  if (process.platform === 'win32') {
    try {
      const wslCheck = execSync('wsl bash -c "which initdb || ls /usr/lib/postgresql/*/bin/initdb"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (wslCheck) {
        const firstLine = wslCheck.split('\n')[0].trim();
        const binDir = path.posix.dirname(firstLine);
        return {
          isWsl: true,
          binDir,
          initdbPath: `${binDir}/initdb`,
          pgCtlPath: `${binDir}/pg_ctl`,
          createdbPath: `${binDir}/createdb`,
          psqlPath: `${binDir}/psql`,
        };
      }
    } catch {
      // WSL not available or PostgreSQL not installed in WSL
    }
  }

  throw new Error(
    'Safety violation: Could not locate isolated PostgreSQL binaries (initdb, pg_ctl, createdb). ' +
    'Local integration tests require an isolated PostgreSQL instance with its own temporary data directory ' +
    'to avoid modifying shared server roles. Please install PostgreSQL or configure WSL with postgresql-contrib.'
  );
}

/**
 * Finds an available ephemeral port on the local loopback interface.
 */
export async function getFreeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Checks whether TCP connection can be established on a local port.
 */
export async function checkPortOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.setTimeout(timeoutMs);
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
}

/**
 * Attempts best-effort kill of a postmaster process when regular shutdown fails.
 */
export function tryKillPostmaster(dataDir: string, isWsl: boolean): void {
  try {
    if (isWsl) {
      const pidStr = execSync(`wsl bash -c "head -n 1 ${dataDir}/postmaster.pid 2>/dev/null || true"`, { encoding: 'utf8' }).trim();
      const pid = parseInt(pidStr, 10);
      if (pid && !isNaN(pid)) {
        execSync(`wsl kill -9 ${pid} 2>/dev/null || true`, { stdio: 'ignore' });
      }
    } else {
      const pidFilePath = path.join(dataDir, 'postmaster.pid');
      if (fs.existsSync(pidFilePath)) {
        const content = fs.readFileSync(pidFilePath, 'utf8');
        const pid = parseInt(content.split('\n')[0].trim(), 10);
        if (pid && !isNaN(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
    }
  } catch {
    // Best effort
  }
}

/**
 * Default process executor using argument-safe execution.
 */
export const defaultProcessExecutor: ProcessExecutor = {
  execInitdb(binPath: string, dataDir: string, isWsl: boolean) {
    if (isWsl) {
      execFileSync('wsl', [binPath, '-D', dataDir, '-U', 'postgres', '--auth=trust', '--no-instructions'], { stdio: 'ignore' });
    } else {
      execFileSync(binPath, ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--no-instructions'], { stdio: 'ignore' });
    }
  },

  execStartServer(binPath: string, dataDir: string, port: number, isWsl: boolean) {
    if (isWsl) {
      const logPath = `${dataDir}/server.log`;
      const pgOptions = `-p ${port} -h 127.0.0.1 -k ${dataDir}`;
      execFileSync('wsl', [binPath, '-D', dataDir, '-l', logPath, '-o', pgOptions, '-w', 'start'], { stdio: 'ignore' });
    } else {
      const logPath = path.join(dataDir, 'server.log');
      const socketOption = process.platform === 'win32' ? '' : ` -k "${dataDir}"`;
      const pgOptions = `-p ${port} -h 127.0.0.1${socketOption}`;
      execFileSync(binPath, ['-D', dataDir, '-l', logPath, '-o', pgOptions, '-w', 'start'], { stdio: 'ignore' });
    }
  },

  execCreatedb(binPath: string, port: number, isWsl: boolean) {
    if (isWsl) {
      execFileSync('wsl', [binPath, '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'hackmate_test'], { stdio: 'ignore' });
    } else {
      execFileSync(binPath, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'hackmate_test'], { stdio: 'ignore' });
    }
  },

  execStopServer(binPath: string, dataDir: string, isWsl: boolean) {
    if (isWsl) {
      execFileSync('wsl', [binPath, '-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    } else {
      execFileSync(binPath, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    }
  },

  async confirmStopped(dataDir: string, port: number, isWsl: boolean, _pgCtlPath: string, maxWaitMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      let pidExists = false;
      if (isWsl) {
        try {
          execFileSync('wsl', ['test', '-f', `${dataDir}/postmaster.pid`], { stdio: 'ignore' });
          pidExists = true;
        } catch {
          pidExists = false;
        }
      } else {
        pidExists = fs.existsSync(path.join(dataDir, 'postmaster.pid'));
      }

      const isPortOpen = await checkPortOpen(port);

      if (!pidExists && !isPortOpen) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  },

  removeDataDir(dataDir: string, isWsl: boolean) {
    if (isWsl) {
      try {
        execFileSync('wsl', ['rm', '-rf', dataDir], { stdio: 'ignore' });
      } catch (err: any) {
        throw new Error(`Cleanup failure: Failed to remove WSL data directory "${dataDir}": ${err.message}`);
      }
    } else {
      try {
        if (fs.existsSync(dataDir)) {
          fs.rmSync(dataDir, { recursive: true, force: true });
        }
      } catch (err: any) {
        throw new Error(`Cleanup failure: Failed to remove data directory "${dataDir}": ${err.message}`);
      }
    }
  },
};

/**
 * Performs stage-aware teardown of a temporary PostgreSQL cluster.
 * Confirms shutdown before removing the data directory.
 * If shutdown cannot be confirmed, raises an explicit error and preserves data dir
 * rather than silently reporting success.
 */
export async function performTeardown(params: {
  dataDir: string;
  port: number;
  isWsl: boolean;
  pgCtlPath: string;
  serverStarted: boolean;
  executor?: ProcessExecutor;
}): Promise<void> {
  const executor = params.executor || defaultProcessExecutor;

  if (params.serverStarted) {
    let stopCmdError: Error | null = null;
    try {
      executor.execStopServer(params.pgCtlPath, params.dataDir, params.isWsl);
    } catch (err: any) {
      stopCmdError = err;
    }

    const isStopped = await executor.confirmStopped(
      params.dataDir,
      params.port,
      params.isWsl,
      params.pgCtlPath
    );

    if (!isStopped) {
      // Best-effort attempt to terminate postmaster process safely
      tryKillPostmaster(params.dataDir, params.isWsl);
      const isStoppedAfterKill = await executor.confirmStopped(
        params.dataDir,
        params.port,
        params.isWsl,
        params.pgCtlPath,
        1500
      );

      if (!isStoppedAfterKill) {
        throw new Error(
          `Cleanup failure: PostgreSQL server in "${params.dataDir}" failed to shut down within timeout. ` +
          `Data directory removal aborted to prevent running rogue postmaster process.` +
          (stopCmdError ? ` Underlying stop error: ${stopCmdError.message}` : '')
        );
      }
    }
  }

  // Server shutdown confirmed (or server never started); safely remove data directory
  executor.removeDataDir(params.dataDir, params.isWsl);
}

/**
 * Verifies TCP connectivity to PostgreSQL on the loopback port with retries.
 */
export async function verifyReadiness(port: number, maxRetries = 25, retryIntervalMs = 200): Promise<void> {
  for (let i = 1; i <= maxRetries; i++) {
    const isOpen = await checkPortOpen(port);
    if (isOpen) return;
    await new Promise((res) => setTimeout(res, retryIntervalMs));
  }
  throw new Error(`Failed to establish connection to isolated PostgreSQL instance on port ${port}.`);
}

/**
 * Provisions a truly isolated, temporary PostgreSQL instance on loopback with an ephemeral port.
 * Tracks initialization stages explicitly:
 * 1. Directory allocation
 * 2. initdb execution
 * 3. PostgreSQL startup
 * 4. Database creation
 * 5. Readiness verification
 * 6. Successful handoff
 * 
 * If any stage fails, performs stage-aware cleanup before propagating the original error.
 */
export async function provisionIsolatedPostgres(options?: ProvisionOptions): Promise<IsolatedPostgresInstance> {
  registerCleanupHooks();
  const binaries = discoverPostgresBinaries();
  const port = await getFreeEphemeralPort();
  const dirName = `hackmate_pg_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = binaries.isWsl ? `/tmp/${dirName}` : path.join(os.tmpdir(), dirName);

  const executor: ProcessExecutor = {
    ...defaultProcessExecutor,
    ...options?.executor,
  };

  // Register in activeInstanceRecords early so emergency handlers can clean up
  // partially initialized instances even if an interrupt occurs during provisioning
  const record: ActiveInstanceRecord = {
    dataDir,
    port,
    isWsl: binaries.isWsl,
    pgCtlPath: binaries.pgCtlPath,
    stage: 'allocated',
    serverStarted: false,
    stopped: false,
  };
  activeInstanceRecords.add(record);

  let isStopped = false;
  const stopFn = async (): Promise<void> => {
    if (isStopped || record.stopped) return;
    isStopped = true;
    record.stopped = true;
    record.stage = 'stopped';
    try {
      await performTeardown({
        dataDir,
        port,
        isWsl: binaries.isWsl,
        pgCtlPath: binaries.pgCtlPath,
        serverStarted: record.serverStarted,
        executor,
      });
    } finally {
      activeInstanceRecords.delete(record);
    }
  };

  try {
    // Stage 1 & 2: initdb execution
    record.stage = 'initdb_running';
    executor.execInitdb(binaries.initdbPath, dataDir, binaries.isWsl);
    record.stage = 'initdb_completed';

    // Stage 3: PostgreSQL startup
    record.stage = 'starting_server';
    executor.execStartServer(binaries.pgCtlPath, dataDir, port, binaries.isWsl);
    record.serverStarted = true;
    record.stage = 'server_started';

    // Stage 4: Database creation
    record.stage = 'creating_db';
    executor.execCreatedb(binaries.createdbPath, port, binaries.isWsl);
    record.stage = 'db_created';

    // Stage 5: Readiness verification
    if (!options?.skipReadinessWait) {
      record.stage = 'verifying_readiness';
      await verifyReadiness(port, options?.readinessRetries ?? 25, options?.readinessIntervalMs ?? 200);
    }
    record.stage = 'ready';

    // Stage 6: Successful handoff
    const instance: IsolatedPostgresInstance = {
      host: '127.0.0.1',
      port,
      dataDir,
      isWsl: binaries.isWsl,
      stop: stopFn,
    };

    return instance;
  } catch (provisionError) {
    // Stage-aware failure cleanup: clean up whatever was created before propagating
    try {
      await performTeardown({
        dataDir,
        port,
        isWsl: binaries.isWsl,
        pgCtlPath: binaries.pgCtlPath,
        serverStarted: record.serverStarted,
        executor,
      });
    } catch (cleanupErr) {
      // Record cleanup error details alongside original provisioning failure
      console.error(`Provisioning failure cleanup encountered secondary error for ${dataDir}:`, cleanupErr);
    } finally {
      record.stopped = true;
      activeInstanceRecords.delete(record);
    }
    throw provisionError;
  }
}
