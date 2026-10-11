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
  | 'ready';

export type InstanceLifecycleState =
  | 'provisioning_in_progress'
  | 'running'
  | 'teardown_in_progress'
  | 'stopped'
  | 'cleanup_failed';

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

export interface ProcessVerifier {
  verifyPostgresProcess: (pid: number, dataDir: string, isWsl: boolean) => boolean;
}

export interface ActiveInstanceRecord {
  dataDir: string;
  port: number;
  isWsl: boolean;
  pgCtlPath: string;
  stage: ProvisioningStage;
  lifecycleState: InstanceLifecycleState;
  serverStarted: boolean;
  serverStopped: boolean;
  stopped: boolean;
  lastCleanupError?: Error | null;
  teardownPromise?: Promise<void> | null;
}

export interface ProvisionOptions {
  executor?: Partial<ProcessExecutor>;
  verifier?: ProcessVerifier;
  skipReadinessWait?: boolean;
  readinessRetries?: number;
  readinessIntervalMs?: number;
}

export interface EmergencyCleanupSyncOptions {
  confirmStoppedSync?: (dataDir: string, isWsl: boolean) => boolean;
  stopServerSync?: (pgCtlPath: string, dataDir: string, isWsl: boolean) => void;
  removeDirSync?: (dataDir: string, isWsl: boolean) => void;
  tryKillPostmasterSync?: (dataDir: string, isWsl: boolean) => boolean;
}

// Registry of running instances for emergency process cleanup
export const activeInstanceRecords = new Set<ActiveInstanceRecord>();

/**
 * Synchronously checks whether postmaster.pid exists in the data directory.
 * If the file exists, the server cannot be confirmed as stopped.
 */
export function confirmStoppedSync(dataDir: string, isWsl: boolean): boolean {
  if (isWsl) {
    try {
      execFileSync('wsl', ['test', '-f', `${dataDir}/postmaster.pid`], { stdio: 'ignore' });
      return false; // File exists => not stopped
    } catch {
      return true; // File does not exist => stopped
    }
  } else {
    return !fs.existsSync(path.join(dataDir, 'postmaster.pid'));
  }
}

/**
 * Synchronous emergency cleanup for process exit and termination signals.
 * Uses argument-safe process execution, waits for shutdown, confirms stopped state
 * before removing data directories, and refuses deletion when shutdown is unconfirmed.
 * Unsuccessful cleanup retains records in activeInstanceRecords.
 */
export function performEmergencyCleanupSync(
  records: Set<ActiveInstanceRecord> = activeInstanceRecords,
  options?: EmergencyCleanupSyncOptions
): { succeeded: string[]; failed: string[] } {
  const succeeded: string[] = [];
  const failed: string[] = [];

  records.forEach((record) => {
    if (record.stopped || record.lifecycleState === 'stopped') return;

    // Check if server may have started
    const mayHaveStarted =
      !record.serverStopped &&
      (record.serverStarted || record.stage === 'starting_server');

    if (mayHaveStarted) {
      try {
        if (options?.stopServerSync) {
          options.stopServerSync(record.pgCtlPath, record.dataDir, record.isWsl);
        } else {
          if (record.isWsl) {
            execFileSync('wsl', [record.pgCtlPath, '-D', record.dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
          } else {
            execFileSync(record.pgCtlPath, ['-D', record.dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
          }
        }
      } catch {
        // Stop might fail; proceed to confirmation and guarded kill
      }

      const isStopped = options?.confirmStoppedSync
        ? options.confirmStoppedSync(record.dataDir, record.isWsl)
        : confirmStoppedSync(record.dataDir, record.isWsl);

      if (!isStopped) {
        if (options?.tryKillPostmasterSync) {
          options.tryKillPostmasterSync(record.dataDir, record.isWsl);
        } else {
          tryKillPostmaster(record.dataDir, record.isWsl);
        }

        const isStoppedAfterKill = options?.confirmStoppedSync
          ? options.confirmStoppedSync(record.dataDir, record.isWsl)
          : confirmStoppedSync(record.dataDir, record.isWsl);

        if (!isStoppedAfterKill) {
          record.lifecycleState = 'cleanup_failed';
          failed.push(record.dataDir);
          return;
        }
      }

      record.serverStopped = true;
    }

    // Server shutdown confirmed (or never started); remove directory
    try {
      if (options?.removeDirSync) {
        options.removeDirSync(record.dataDir, record.isWsl);
      } else {
        if (record.isWsl) {
          execFileSync('wsl', ['rm', '-rf', record.dataDir], { stdio: 'ignore' });
        } else {
          if (fs.existsSync(record.dataDir)) {
            fs.rmSync(record.dataDir, { recursive: true, force: true });
          }
        }
      }
      record.lifecycleState = 'stopped';
      record.stopped = true;
      record.lastCleanupError = null;
      records.delete(record);
      succeeded.push(record.dataDir);
    } catch (err: any) {
      record.lifecycleState = 'cleanup_failed';
      record.lastCleanupError = err;
      failed.push(record.dataDir);
    }
  });

  return { succeeded, failed };
}

let cleanupHooksRegistered = false;
export function registerCleanupHooks(): void {
  if (cleanupHooksRegistered) return;
  cleanupHooksRegistered = true;

  process.once('exit', () => {
    performEmergencyCleanupSync();
  });
  process.once('SIGINT', () => {
    performEmergencyCleanupSync();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    performEmergencyCleanupSync();
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
 * Verifies that the process with the given PID belongs to the PostgreSQL instance
 * running with the designated data directory.
 * Prevents force-killing unrelated processes due to stale or recycled PIDs.
 */
export function verifyPostmasterIdentity(pid: number, dataDir: string, isWsl: boolean): boolean {
  if (!pid || isNaN(pid) || pid <= 1) return false;

  try {
    if (isWsl) {
      const cmdline = execFileSync(
        'wsl',
        ['sh', '-c', `cat /proc/${pid}/cmdline 2>/dev/null || ps -p ${pid} -o args= 2>/dev/null`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const normalized = cmdline.replace(/\0/g, ' ');
      return normalized.includes('postgres') && normalized.includes(dataDir);
    } else if (process.platform === 'win32') {
      const cmdline = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return cmdline.toLowerCase().includes('postgres') && cmdline.includes(dataDir);
    } else {
      let cmdline = '';
      const procPath = `/proc/${pid}/cmdline`;
      if (fs.existsSync(procPath)) {
        cmdline = fs.readFileSync(procPath, 'utf8').replace(/\0/g, ' ');
      } else {
        cmdline = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      }
      return cmdline.includes('postgres') && cmdline.includes(dataDir);
    }
  } catch {
    // Process does not exist or cmdline could not be verified
    return false;
  }
}

/**
 * Attempts guarded kill of a postmaster process when regular shutdown fails.
 * Validates process identity against the expected data directory before sending SIGKILL.
 */
export function tryKillPostmaster(
  dataDir: string,
  isWsl: boolean,
  verifier?: ProcessVerifier
): boolean {
  try {
    let pid: number | null = null;
    if (isWsl) {
      const pidStr = execFileSync(
        'wsl',
        ['sh', '-c', `head -n 1 "${dataDir}/postmaster.pid" 2>/dev/null || true`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      pid = parseInt(pidStr, 10);
    } else {
      const pidFilePath = path.join(dataDir, 'postmaster.pid');
      if (fs.existsSync(pidFilePath)) {
        const content = fs.readFileSync(pidFilePath, 'utf8');
        pid = parseInt(content.split('\n')[0].trim(), 10);
      }
    }

    if (!pid || isNaN(pid)) return false;

    const isVerified = verifier
      ? verifier.verifyPostgresProcess(pid, dataDir, isWsl)
      : verifyPostmasterIdentity(pid, dataDir, isWsl);

    if (!isVerified) {
      // Unverified process or stale PID: refuse to kill!
      return false;
    }

    if (isWsl) {
      execFileSync('wsl', ['kill', '-9', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
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
  serverStopped?: boolean;
  stage?: ProvisioningStage;
  executor?: ProcessExecutor;
  verifier?: ProcessVerifier;
  onServerStopped?: () => void;
}): Promise<void> {
  const executor = params.executor || defaultProcessExecutor;

  // Determine if a server may have started
  const mayHaveStartedServer =
    !params.serverStopped &&
    (params.serverStarted || params.stage === 'starting_server');

  if (mayHaveStartedServer) {
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
      // Guarded force-kill attempt with process identity validation
      tryKillPostmaster(params.dataDir, params.isWsl, params.verifier);
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

    params.onServerStopped?.();
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
 * Tracks lifecycle and stages explicitly:
 * - allocation -> initdb -> starting_server -> creating_db -> verifying_readiness -> ready
 * - lifecycle: provisioning_in_progress -> running -> teardown_in_progress -> stopped / cleanup_failed
 * 
 * If any stage fails, performs stage-aware cleanup before propagating the original error.
 * Unregisters instance records and marks stopped ONLY upon confirmed shutdown and directory deletion.
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
  const verifier = options?.verifier;

  // Register in activeInstanceRecords early so emergency handlers and retry paths
  // can track and clean up partially initialized instances
  const record: ActiveInstanceRecord = {
    dataDir,
    port,
    isWsl: binaries.isWsl,
    pgCtlPath: binaries.pgCtlPath,
    stage: 'allocated',
    lifecycleState: 'provisioning_in_progress',
    serverStarted: false,
    serverStopped: false,
    stopped: false,
  };
  activeInstanceRecords.add(record);

  const stopFn = async (): Promise<void> => {
    // 1. If already stopped, return immediately (idempotent)
    if (record.lifecycleState === 'stopped' || record.stopped) {
      return;
    }

    // 2. If teardown in progress by concurrent caller, await in-flight promise
    if (record.lifecycleState === 'teardown_in_progress' && record.teardownPromise) {
      return record.teardownPromise;
    }

    // 3. Mark teardown in progress and execute
    record.lifecycleState = 'teardown_in_progress';
    record.teardownPromise = (async () => {
      try {
        await performTeardown({
          dataDir,
          port,
          isWsl: binaries.isWsl,
          pgCtlPath: binaries.pgCtlPath,
          serverStarted: record.serverStarted,
          serverStopped: record.serverStopped,
          stage: record.stage,
          executor,
          verifier,
          onServerStopped: () => {
            record.serverStopped = true;
          },
        });
        record.lifecycleState = 'stopped';
        record.stopped = true;
        record.lastCleanupError = null;
        activeInstanceRecords.delete(record);
      } catch (err: any) {
        record.lifecycleState = 'cleanup_failed';
        record.lastCleanupError = err;
        throw err;
      } finally {
        record.teardownPromise = null;
      }
    })();

    return record.teardownPromise;
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
    record.lifecycleState = 'running';

    // Stage 6: Successful handoff
    const instance: IsolatedPostgresInstance = {
      host: '127.0.0.1',
      port,
      dataDir,
      isWsl: binaries.isWsl,
      stop: stopFn,
    };

    return instance;
  } catch (provisionError: any) {
    // Stage-aware failure cleanup: clean up whatever was created before propagating
    record.lifecycleState = 'teardown_in_progress';
    let cleanupError: Error | null = null;
    try {
      await performTeardown({
        dataDir,
        port,
        isWsl: binaries.isWsl,
        pgCtlPath: binaries.pgCtlPath,
        serverStarted: record.serverStarted,
        serverStopped: record.serverStopped,
        stage: record.stage,
        executor,
        verifier,
        onServerStopped: () => {
          record.serverStopped = true;
        },
      });
      record.lifecycleState = 'stopped';
      record.stopped = true;
      record.lastCleanupError = null;
      activeInstanceRecords.delete(record);
    } catch (cleanupErr: any) {
      cleanupError = cleanupErr;
      record.lifecycleState = 'cleanup_failed';
      record.lastCleanupError = cleanupErr;
      // Do not delete record from activeInstanceRecords; preserve for retry or exit hooks
    }

    if (cleanupError) {
      provisionError.cleanupError = cleanupError;
      provisionError.message = `${provisionError.message} (Cleanup failure: ${cleanupError.message})`;
    }
    throw provisionError;
  }
}
