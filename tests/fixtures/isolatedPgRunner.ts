import { execSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// Registry of running instances for emergency process cleanup
const activeInstances = new Set<IsolatedPostgresInstance>();

let cleanupHooksRegistered = false;
function registerCleanupHooks() {
  if (cleanupHooksRegistered) return;
  cleanupHooksRegistered = true;

  const cleanupSync = () => {
    activeInstances.forEach((inst) => {
      try {
        if (inst.isWsl) {
          execSync(`wsl bash -c "pg_ctl -D ${inst.dataDir} -m immediate stop 2>/dev/null || /usr/lib/postgresql/*/bin/pg_ctl -D ${inst.dataDir} -m immediate stop 2>/dev/null || true"`);
          execSync(`wsl bash -c "rm -rf ${inst.dataDir} 2>/dev/null || true"`);
        } else {
          execSync(`pg_ctl -D "${inst.dataDir}" -m immediate stop 2>/dev/null || true"`);
          fs.rmSync(inst.dataDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore during emergency exit
      }
    });
    activeInstances.clear();
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
 * Provisions a truly isolated, temporary PostgreSQL instance on loopback with an ephemeral port.
 * Configured with its own temporary data directory, destroyed upon stop.
 */
export async function provisionIsolatedPostgres(): Promise<IsolatedPostgresInstance> {
  registerCleanupHooks();
  const binaries = discoverPostgresBinaries();
  const port = await getFreeEphemeralPort();
  const dirName = `hackmate_pg_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let dataDir: string;
  let initdbCmd: string;
  let startCmd: string;
  let createdbCmd: string;
  let stopCmd: string;
  let rmDirCmd: () => void;

  if (binaries.isWsl) {
    dataDir = `/tmp/${dirName}`;
    initdbCmd = `wsl bash -c "${binaries.initdbPath} -D ${dataDir} -U postgres --auth=trust --no-instructions"`;
    startCmd = `wsl bash -c "${binaries.pgCtlPath} -D ${dataDir} -o '-p ${port} -h 127.0.0.1 -k ${dataDir}' -w start"`;
    createdbCmd = `wsl bash -c "${binaries.createdbPath} -h 127.0.0.1 -p ${port} -U postgres hackmate_test"`;
    stopCmd = `wsl bash -c "${binaries.pgCtlPath} -D ${dataDir} -m immediate -w stop"`;
    rmDirCmd = () => {
      try {
        execSync(`wsl bash -c "rm -rf ${dataDir}"`, { stdio: 'ignore' });
      } catch {
        // Ignore
      }
    };
  } else {
    dataDir = path.join(os.tmpdir(), dirName);
    const socketOption = process.platform === 'win32' ? '' : ` -k "${dataDir}"`;
    initdbCmd = `"${binaries.initdbPath}" -D "${dataDir}" -U postgres --auth=trust --no-instructions`;
    startCmd = `"${binaries.pgCtlPath}" -D "${dataDir}" -o "-p ${port} -h 127.0.0.1${socketOption}" -w start`;
    createdbCmd = `"${binaries.createdbPath}" -h 127.0.0.1 -p ${port} -U postgres hackmate_test`;
    stopCmd = `"${binaries.pgCtlPath}" -D "${dataDir}" -m immediate -w stop`;
    rmDirCmd = () => {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    };
  }

  // 1. Initialize temporary cluster
  execSync(initdbCmd, { stdio: 'pipe' });

  // 2. Start server on loopback
  execSync(startCmd, { stdio: 'pipe' });

  // 3. Create dedicated test database
  execSync(createdbCmd, { stdio: 'pipe' });

  // 4. Wait for TCP readiness on loopback with retry loop
  let isReady = false;
  const maxRetries = 25;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Timeout'));
        });
        socket.on('error', (err) => {
          socket.destroy();
          reject(err);
        });
        socket.connect(port, '127.0.0.1');
      });
      isReady = true;
      break;
    } catch {
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  if (!isReady) {
    try {
      execSync(stopCmd, { stdio: 'ignore' });
    } finally {
      rmDirCmd();
    }
    throw new Error(`Failed to establish connection to isolated PostgreSQL instance on port ${port}.`);
  }

  let isStopped = false;
  const instance: IsolatedPostgresInstance = {
    host: '127.0.0.1',
    port,
    dataDir,
    isWsl: binaries.isWsl,
    stop: async () => {
      if (isStopped) return;
      isStopped = true;
      activeInstances.delete(instance);
      try {
        execSync(stopCmd, { stdio: 'ignore' });
      } catch {
        // Ignore stop errors
      } finally {
        rmDirCmd();
      }
    },
  };

  activeInstances.add(instance);
  return instance;
}
