import childProcess, { execFileSync, execSync } from 'child_process';
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

export interface EmergencyCleanupFailure {
  dataDir: string;
  error: string;
  stage?: ProvisioningStage;
}

export type PortProbeStatus = 'open' | 'closed' | 'unknown';

export interface PortProbeResult {
  status: PortProbeStatus;
  reason?: string;
  error?: unknown;
}

export type PidFileStatus = 'present' | 'absent' | 'unknown';

export interface PidFileInspectionResult {
  status: PidFileStatus;
  reason?: string;
  error?: unknown;
}

export type ShutdownConfirmationStatus = 'stopped' | 'running' | 'unknown';

export interface ShutdownVerificationResult {
  confirmedStopped: boolean;
  pidStatus: PidFileStatus;
  portStatus: PortProbeStatus;
  reason?: string;
}

export interface EmergencyCleanupSyncOptions {
  confirmStoppedSync?: (dataDir: string, isWsl: boolean, port?: number) => boolean | ShutdownVerificationResult;
  stopServerSync?: (pgCtlPath: string, dataDir: string, isWsl: boolean) => void;
  removeDirSync?: (dataDir: string, isWsl: boolean) => void;
  tryKillPostmasterSync?: (dataDir: string, isWsl: boolean) => boolean;
}

// Registry of running instances for emergency process cleanup
export const activeInstanceRecords = new Set<ActiveInstanceRecord>();

/**
 * Validates that a port is an integer in the safe ephemeral TCP port range.
 */
export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * Probes a local TCP port synchronously on native systems using Node child process.
 * Explicitly distinguishes:
 * - 'open': connection successfully established.
 * - 'closed': connection explicitly refused (ECONNREFUSED on loopback).
 * - 'unknown': process spawn failure, timeout, unexpected socket error, etc.
 */
export function probePortSyncNative(port: number, timeoutMs = 1500): PortProbeResult {
  if (!isValidPort(port)) {
    return { status: 'unknown', reason: `Invalid port: ${port}` };
  }

  const childScript = `
const net = require('net');
const s = net.createConnection({ port: ${port}, host: '127.0.0.1' }, () => {
  process.stdout.write('HACKMATE_PORT:OPEN\\n');
  s.destroy();
  process.exit(0);
});
s.on('error', (err) => {
  if (err && err.code === 'ECONNREFUSED') {
    process.stdout.write('HACKMATE_PORT:CLOSED\\n');
    process.exit(0);
  } else {
    process.stdout.write('HACKMATE_PORT:UNKNOWN_ERR_' + (err && err.code ? err.code : 'UNKNOWN') + '\\n');
    process.exit(2);
  }
});
setTimeout(() => {
  try { s.destroy(); } catch {}
  process.stdout.write('HACKMATE_PORT:TIMEOUT\\n');
  process.exit(3);
}, 300);
`;

  try {
    const stdoutBuf = childProcess.execFileSync(
      process.execPath,
      ['-e', childScript],
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const stdout = String(stdoutBuf);
    if (stdout.includes('HACKMATE_PORT:OPEN')) {
      return { status: 'open' };
    }
    if (stdout.includes('HACKMATE_PORT:CLOSED')) {
      return { status: 'closed' };
    }
    return { status: 'unknown', reason: `Unrecognized output from port probe: ${stdout.trim()}` };
  } catch (err: any) {
    if (err && err.stdout) {
      const stdout = String(err.stdout);
      if (stdout.includes('HACKMATE_PORT:OPEN')) return { status: 'open' };
      if (stdout.includes('HACKMATE_PORT:CLOSED')) return { status: 'closed' };
    }
    if (err?.code === 'ETIMEDOUT') {
      return { status: 'unknown', reason: `Port probe process timed out after ${timeoutMs}ms`, error: err };
    }
    if (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'ENOMEM' || String(err?.message).includes('spawn')) {
      return { status: 'unknown', reason: `Port probe process spawn failure: ${err.message}`, error: err };
    }
    return { status: 'unknown', reason: `Port probe process failure: ${err?.message || String(err)}`, error: err };
  }
}

/**
 * Generates the POSIX shell script used to probe port status in WSL or Linux environments.
 * The script inspects available utilities (ss, netstat), captures command output and exit status separately,
 * validates grep return codes (0 = open, 1 = closed, >=2 = error), and emits explicit protocol markers.
 */
export function getWslPortProbeScript(port: number): string {
  return (
    `has_tool=0; ` +
    `if command -v ss >/dev/null 2>&1; then ` +
    `  has_tool=1; ` +
    `  raw=$(ss -tln 2>/dev/null); ` +
    `  st=$?; ` +
    `  if [ "$st" = "0" ]; then ` +
    `    echo "$raw" | grep -E "[: ]${port}([[:space:]]|$)" >/dev/null 2>&1; ` +
    `    grep_st=$?; ` +
    `    if [ "$grep_st" = "0" ]; then ` +
    `      echo 'HACKMATE_PORT:OPEN'; ` +
    `      exit 0; ` +
    `    elif [ "$grep_st" = "1" ]; then ` +
    `      echo 'HACKMATE_PORT:CLOSED'; ` +
    `      exit 0; ` +
    `    fi; ` +
    `  fi; ` +
    `fi; ` +
    `if command -v netstat >/dev/null 2>&1; then ` +
    `  has_tool=1; ` +
    `  raw=$(netstat -tln 2>/dev/null); ` +
    `  st=$?; ` +
    `  if [ "$st" = "0" ]; then ` +
    `    echo "$raw" | grep -E "[: ]${port}([[:space:]]|$)" >/dev/null 2>&1; ` +
    `    grep_st=$?; ` +
    `    if [ "$grep_st" = "0" ]; then ` +
    `      echo 'HACKMATE_PORT:OPEN'; ` +
    `      exit 0; ` +
    `    elif [ "$grep_st" = "1" ]; then ` +
    `      echo 'HACKMATE_PORT:CLOSED'; ` +
    `      exit 0; ` +
    `    fi; ` +
    `  fi; ` +
    `fi; ` +
    `if [ "$has_tool" = "0" ]; then ` +
    `  echo 'HACKMATE_PORT:UNKNOWN_NO_TOOLS'; ` +
    `else ` +
    `  echo 'HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED'; ` +
    `fi; ` +
    `exit 1;`
  );
}

/**
 * Parses the stdout/stderr string produced by port probe execution into a structured PortProbeResult.
 */
export function parsePortProbeOutput(stdout: string): PortProbeResult {
  if (stdout.includes('HACKMATE_PORT:OPEN')) {
    return { status: 'open' };
  }
  if (stdout.includes('HACKMATE_PORT:CLOSED')) {
    return { status: 'closed' };
  }
  if (stdout.includes('HACKMATE_PORT:UNKNOWN_NO_TOOLS')) {
    return { status: 'unknown', reason: 'Neither ss nor netstat utility is available in WSL' };
  }
  if (stdout.includes('HACKMATE_PORT:UNKNOWN_INSPECTION_FAILED')) {
    return { status: 'unknown', reason: 'WSL port inspection utility (ss/netstat) failed during execution' };
  }
  return { status: 'unknown', reason: `Unrecognized WSL port probe output: ${stdout.trim()}` };
}

/**
 * Probes a local TCP port synchronously in WSL.
 * Verifies inspection utilities exist, avoids false closures from pipeline failures,
 * and uses unambiguous protocol markers.
 */
export function probePortSyncWsl(port: number, timeoutMs = 2000): PortProbeResult {
  if (!isValidPort(port)) {
    return { status: 'unknown', reason: `Invalid port: ${port}` };
  }

  const wslScript = getWslPortProbeScript(port);

  try {
    const stdoutBuf = childProcess.execFileSync(
      'wsl',
      ['-e', 'sh', '-c', wslScript],
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    return parsePortProbeOutput(String(stdoutBuf));
  } catch (err: any) {
    if (err && err.stdout) {
      const parsed = parsePortProbeOutput(String(err.stdout));
      if (
        parsed.status !== 'unknown' ||
        parsed.reason?.includes('WSL port inspection utility') ||
        parsed.reason?.includes('Neither ss nor netstat')
      ) {
        return parsed;
      }
    }
    return { status: 'unknown', reason: `WSL port probe failed: ${err?.message || String(err)}`, error: err };
  }
}

/**
 * Synchronously checks whether a local TCP port is open.
 * Returns PortProbeResult: 'open', 'closed', or 'unknown'.
 */
export function checkPortOpenSync(port: number, isWsl: boolean): PortProbeResult {
  if (isWsl) {
    return probePortSyncWsl(port);
  }
  return probePortSyncNative(port);
}

/**
 * Inspects postmaster.pid synchronously on native systems.
 * Distinguishes present, definitively absent (ENOENT / ENOTDIR), or unknown (EACCES / I/O errors).
 */
export function inspectPidFileSync(dataDir: string): PidFileInspectionResult {
  const pidPath = path.join(dataDir, 'postmaster.pid');
  try {
    fs.statSync(pidPath);
    return { status: 'present' };
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { status: 'absent' };
    }
    return {
      status: 'unknown',
      reason: `PID inspection filesystem error (${err?.code || err?.message || 'unknown'})`,
      error: err,
    };
  }
}

/**
 * Inspects postmaster.pid asynchronously on native systems.
 */
export async function inspectPidFileAsync(dataDir: string): Promise<PidFileInspectionResult> {
  const pidPath = path.join(dataDir, 'postmaster.pid');
  try {
    await fs.promises.stat(pidPath);
    return { status: 'present' };
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { status: 'absent' };
    }
    return {
      status: 'unknown',
      reason: `PID inspection filesystem error (${err?.code || err?.message || 'unknown'})`,
      error: err,
    };
  }
}

/**
 * Inspects postmaster.pid synchronously in WSL.
 * Uses explicit markers: HACKMATE_PID:PRESENT, HACKMATE_PID:ABSENT, HACKMATE_PID:UNKNOWN.
 */
export function inspectPidFileWslSync(dataDir: string, timeoutMs = 2000): PidFileInspectionResult {
  const pidPath = `${dataDir}/postmaster.pid`;
  const escapedPidPath = pidPath.replace(/'/g, "'\\''");
  const wslScript =
    `if [ -f '${escapedPidPath}' ]; then echo 'HACKMATE_PID:PRESENT'; exit 0; fi; ` +
    `d=$(dirname '${escapedPidPath}'); if [ -d "$d" ]; then if [ ! -x "$d" ] || [ ! -r "$d" ]; then echo 'HACKMATE_PID:UNKNOWN'; exit 1; fi; fi; ` +
    `if [ ! -e '${escapedPidPath}' ]; then echo 'HACKMATE_PID:ABSENT'; exit 0; fi; ` +
    `echo 'HACKMATE_PID:UNKNOWN'; exit 1`;

  try {
    const stdoutBuf = childProcess.execFileSync(
      'wsl',
      ['sh', '-c', wslScript],
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const stdout = String(stdoutBuf);
    if (stdout.includes('HACKMATE_PID:PRESENT')) {
      return { status: 'present' };
    }
    if (stdout.includes('HACKMATE_PID:ABSENT')) {
      return { status: 'absent' };
    }
    return { status: 'unknown', reason: `Unrecognized WSL PID inspection output: ${stdout.trim()}` };
  } catch (err: any) {
    if (err && err.stdout) {
      const stdout = String(err.stdout);
      if (stdout.includes('HACKMATE_PID:PRESENT')) return { status: 'present' };
      if (stdout.includes('HACKMATE_PID:ABSENT')) return { status: 'absent' };
    }
    return { status: 'unknown', reason: `WSL PID inspection failed: ${err?.message || String(err)}`, error: err };
  }
}

/**
 * Inspects postmaster.pid synchronously, delegating to native or WSL implementation.
 */
export function inspectPidFile(dataDir: string, isWsl: boolean): PidFileInspectionResult {
  if (isWsl) {
    return inspectPidFileWslSync(dataDir);
  }
  return inspectPidFileSync(dataDir);
}

/**
 * Synchronously verifies complete shutdown evidence for a PostgreSQL instance.
 * Positively requires BOTH confirmed absence of postmaster.pid AND confirmed closed TCP port.
 */
export function verifyShutdownSync(dataDir: string, port: number, isWsl: boolean): ShutdownVerificationResult {
  if (!isValidPort(port)) {
    return {
      confirmedStopped: false,
      pidStatus: 'unknown',
      portStatus: 'unknown',
      reason: `Invalid or missing port: ${port}. Active instance shutdown requires a valid loopback port.`,
    };
  }

  let pidResult: PidFileInspectionResult;
  try {
    pidResult = inspectPidFile(dataDir, isWsl);
  } catch (err: any) {
    pidResult = { status: 'unknown', reason: `PID inspection exception: ${err?.message || String(err)}` };
  }

  let portResult: PortProbeResult;
  try {
    portResult = checkPortOpenSync(port, isWsl);
  } catch (err: any) {
    portResult = { status: 'unknown', reason: `Port probe exception: ${err?.message || String(err)}` };
  }

  if (pidResult.status === 'present') {
    return {
      confirmedStopped: false,
      pidStatus: 'present',
      portStatus: portResult.status,
      reason: `PostgreSQL PID file is still present at "${dataDir}/postmaster.pid"`,
    };
  }

  if (portResult.status === 'open') {
    return {
      confirmedStopped: false,
      pidStatus: pidResult.status,
      portStatus: 'open',
      reason: `PostgreSQL port ${port} is still open and accepting connections`,
    };
  }

  if (pidResult.status === 'unknown') {
    return {
      confirmedStopped: false,
      pidStatus: 'unknown',
      portStatus: portResult.status,
      reason: `PostgreSQL PID file status is unknown (${pidResult.reason || 'inspection error'}). Shutdown cannot be confirmed.`,
    };
  }

  if (portResult.status === 'unknown') {
    return {
      confirmedStopped: false,
      pidStatus: pidResult.status,
      portStatus: 'unknown',
      reason: `PostgreSQL port ${port} status is unknown (${portResult.reason || 'probe error'}). Shutdown cannot be confirmed.`,
    };
  }

  if (pidResult.status === 'absent' && portResult.status === 'closed') {
    return {
      confirmedStopped: true,
      pidStatus: 'absent',
      portStatus: 'closed',
    };
  }

  return {
    confirmedStopped: false,
    pidStatus: pidResult.status,
    portStatus: portResult.status,
    reason: `Incomplete shutdown evidence (PID: ${pidResult.status}, Port: ${portResult.status})`,
  };
}

/**
 * Backward-compatible synchronous confirmation helper.
 * Returns true ONLY when shutdown is positively confirmed by complete evidence.
 */
export function confirmStoppedSync(dataDir: string, isWsl: boolean, port?: number): boolean {
  if (port === undefined || !isValidPort(port)) {
    return false;
  }
  const result = verifyShutdownSync(dataDir, port, isWsl);
  return result.confirmedStopped;
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
): { succeeded: string[]; failed: EmergencyCleanupFailure[] } {
  const succeeded: string[] = [];
  const failed: EmergencyCleanupFailure[] = [];

  records.forEach((record) => {
    if (record.stopped || record.lifecycleState === 'stopped') return;

    // Check if server may have started
    const mayHaveStarted =
      !record.serverStopped &&
      (record.serverStarted || record.stage === 'starting_server');

    if (mayHaveStarted) {
      if (!isValidPort(record.port)) {
        record.lifecycleState = 'cleanup_failed';
        failed.push({
          dataDir: record.dataDir,
          error: `Shutdown verification failed: missing or invalid port (${record.port}). Data directory removal aborted.`,
          stage: record.stage,
        });
        return; // Abort directory removal to protect running server!
      }

      try {
        if (options?.stopServerSync) {
          options.stopServerSync(record.pgCtlPath, record.dataDir, record.isWsl);
        } else {
          if (record.isWsl) {
            childProcess.execFileSync('wsl', [record.pgCtlPath, '-D', record.dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
          } else {
            childProcess.execFileSync(record.pgCtlPath, ['-D', record.dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
          }
        }
      } catch {
        // Orderly stop might fail
      }

      let checkResult: ShutdownVerificationResult;
      try {
        if (options?.confirmStoppedSync) {
          const optRes = options.confirmStoppedSync(record.dataDir, record.isWsl, record.port);
          if (typeof optRes === 'boolean') {
            checkResult = optRes
              ? { confirmedStopped: true, pidStatus: 'absent', portStatus: 'closed' }
              : { confirmedStopped: false, pidStatus: 'unknown', portStatus: 'unknown', reason: 'Shutdown confirmation returned false' };
          } else {
            checkResult = optRes;
          }
        } else {
          checkResult = verifyShutdownSync(record.dataDir, record.port, record.isWsl);
        }
      } catch (err: any) {
        checkResult = { confirmedStopped: false, pidStatus: 'unknown', portStatus: 'unknown', reason: err?.message };
      }

      if (!checkResult.confirmedStopped) {
        // Guarded force-kill attempt
        let killResult = false;
        try {
          if (options?.tryKillPostmasterSync) {
            killResult = options.tryKillPostmasterSync(record.dataDir, record.isWsl);
          } else {
            killResult = tryKillPostmaster(record.dataDir, record.isWsl);
          }
        } catch {
          killResult = false;
        }

        // Re-confirm shutdown. Do not treat killResult alone as proof that server stopped!
        let checkAfterKill: ShutdownVerificationResult;
        try {
          if (options?.confirmStoppedSync) {
            const optRes = options.confirmStoppedSync(record.dataDir, record.isWsl, record.port);
            if (typeof optRes === 'boolean') {
              checkAfterKill = optRes
                ? { confirmedStopped: true, pidStatus: 'absent', portStatus: 'closed' }
                : { confirmedStopped: false, pidStatus: 'unknown', portStatus: 'unknown', reason: 'Shutdown confirmation returned false' };
            } else {
              checkAfterKill = optRes;
            }
          } else {
            checkAfterKill = verifyShutdownSync(record.dataDir, record.port, record.isWsl);
          }
        } catch (err: any) {
          checkAfterKill = { confirmedStopped: false, pidStatus: 'unknown', portStatus: 'unknown', reason: err?.message };
        }

        if (!checkAfterKill.confirmedStopped) {
          record.lifecycleState = 'cleanup_failed';
          const reason = !killResult
            ? `PostgreSQL server failed to stop and force-kill was refused (unverifiable PID) or failed (${checkAfterKill.reason || 'shutdown unconfirmed'})`
            : `PostgreSQL server process could not be confirmed as terminated after force-kill (${checkAfterKill.reason || 'shutdown unconfirmed'})`;
          failed.push({ dataDir: record.dataDir, error: reason, stage: record.stage });
          return; // Abort directory removal to protect running server!
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
          childProcess.execFileSync('wsl', ['rm', '-rf', record.dataDir], { stdio: 'ignore' });
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
      failed.push({
        dataDir: record.dataDir,
        error: `Data directory removal failed: ${err.message}`,
        stage: record.stage,
      });
    }
  });

  return { succeeded, failed };
}

/**
 * Reports emergency cleanup failures synchronously to stderr.
 * Never outputs sensitive credentials or connection URLs.
 */
export function reportEmergencyCleanupFailures(failed: EmergencyCleanupFailure[]): void {
  if (!failed || failed.length === 0) return;
  const lines = [
    `\n[isolatedPgRunner] EMERGENCY CLEANUP FAILURE: ${failed.length} temporary PostgreSQL instance(s) could not be cleaned up:`,
    ...failed.map((f) => `  - Data directory: "${f.dataDir}" | Error: ${f.error}`),
    `Data directories have been preserved to avoid deleting data belonging to active postmaster processes. Please inspect and clean up manually.\n`,
  ];
  try {
    process.stderr.write(lines.join('\n'));
  } catch {
    // Best effort on stderr write
  }
}

let cleanupHooksRegistered = false;
let emergencyReporter: ((failed: EmergencyCleanupFailure[]) => void) | null = null;

export function setEmergencyFailureReporter(reporter: ((failed: EmergencyCleanupFailure[]) => void) | null): void {
  emergencyReporter = reporter;
}

export function registerCleanupHooks(): void {
  if (cleanupHooksRegistered) return;
  cleanupHooksRegistered = true;

  const handleExitCleanup = () => {
    const result = performEmergencyCleanupSync();
    if (result.failed.length > 0) {
      if (emergencyReporter) {
        emergencyReporter(result.failed);
      } else {
        reportEmergencyCleanupFailures(result.failed);
      }
    }
  };

  process.once('exit', handleExitCleanup);
  process.once('SIGINT', () => {
    handleExitCleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    handleExitCleanup();
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
 * Returns PortProbeResult: 'open', 'closed', or 'unknown'.
 */
export async function checkPortOpen(port: number, timeoutMs = 300): Promise<PortProbeResult> {
  if (!isValidPort(port)) {
    return { status: 'unknown', reason: `Invalid port: ${port}` };
  }

  return new Promise<PortProbeResult>((resolve) => {
    let resolved = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(timeoutMs);

    const finish = (result: PortProbeResult) => {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };

    socket.on('connect', () => {
      finish({ status: 'open' });
    });

    socket.on('timeout', () => {
      finish({
        status: 'unknown',
        reason: `Connection to 127.0.0.1:${port} timed out after ${timeoutMs}ms`,
      });
    });

    socket.on('error', (err: any) => {
      if (err && err.code === 'ECONNREFUSED') {
        finish({ status: 'closed' });
      } else {
        finish({
          status: 'unknown',
          reason: `Connection to 127.0.0.1:${port} failed with unexpected error: ${err?.code || err?.message}`,
          error: err,
        });
      }
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
    const result = await verifyShutdownAsync(dataDir, port, isWsl, maxWaitMs);
    return result.confirmedStopped;
  },

  removeDataDir(dataDir: string, isWsl: boolean) {
    if (isWsl) {
      try {
        childProcess.execFileSync('wsl', ['rm', '-rf', dataDir], { stdio: 'ignore' });
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
 * Asynchronously verifies complete shutdown evidence for a PostgreSQL instance.
 * Requires positively confirmed absence of postmaster.pid AND confirmed closed TCP port.
 */
export async function verifyShutdownAsync(
  dataDir: string,
  port: number,
  isWsl: boolean,
  maxWaitMs = 5000
): Promise<ShutdownVerificationResult> {
  if (!isValidPort(port)) {
    return {
      confirmedStopped: false,
      pidStatus: 'unknown',
      portStatus: 'unknown',
      reason: `Invalid or missing port: ${port}. Active instance shutdown requires a valid loopback port.`,
    };
  }

  const start = Date.now();
  let lastResult: ShutdownVerificationResult = {
    confirmedStopped: false,
    pidStatus: 'unknown',
    portStatus: 'unknown',
    reason: 'Shutdown verification timed out',
  };

  while (Date.now() - start < maxWaitMs) {
    let pidResult: PidFileInspectionResult;
    try {
      pidResult = isWsl ? inspectPidFileWslSync(dataDir) : await inspectPidFileAsync(dataDir);
    } catch (err: any) {
      pidResult = { status: 'unknown', reason: err?.message };
    }

    if (pidResult.status === 'present' || pidResult.status === 'unknown') {
      lastResult = {
        confirmedStopped: false,
        pidStatus: pidResult.status,
        portStatus: 'unknown',
        reason: pidResult.status === 'present' ? 'PID file is present' : `PID inspection error: ${pidResult.reason}`,
      };
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }

    // PID is confirmed absent
    let portResult: PortProbeResult;
    try {
      portResult = isWsl ? probePortSyncWsl(port) : await checkPortOpen(port);
    } catch (err: any) {
      portResult = { status: 'unknown', reason: err?.message };
    }

    if (portResult.status === 'closed') {
      return {
        confirmedStopped: true,
        pidStatus: 'absent',
        portStatus: 'closed',
      };
    }

    lastResult = {
      confirmedStopped: false,
      pidStatus: 'absent',
      portStatus: portResult.status,
      reason: portResult.status === 'open' ? `Port ${port} is still open` : `Port ${port} probe error: ${portResult.reason}`,
    };

    await new Promise((r) => setTimeout(r, 150));
  }

  return lastResult;
}

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
    if (!isValidPort(params.port)) {
      throw new Error(
        `Cleanup failure: PostgreSQL instance in "${params.dataDir}" has missing or invalid port (${params.port}). ` +
        `Data directory removal aborted to prevent running rogue postmaster process.`
      );
    }

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
      const killSucceeded = tryKillPostmaster(params.dataDir, params.isWsl, params.verifier);
      const isStoppedAfterKill = await executor.confirmStopped(
        params.dataDir,
        params.port,
        params.isWsl,
        params.pgCtlPath,
        1500
      );

      if (!isStoppedAfterKill) {
        const killNote = !killSucceeded
          ? ' (Guarded force-kill was refused due to unverifiable PID or missing process)'
          : ' (Process remained active despite kill signal)';
        throw new Error(
          `Cleanup failure: PostgreSQL server in "${params.dataDir}" failed to shut down within timeout.${killNote} ` +
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
    const probe = await checkPortOpen(port);
    if (probe.status === 'open') return;
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
