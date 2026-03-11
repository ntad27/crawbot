/**
 * Build Tools Detection & Installation
 * Checks and installs C/C++ build tools (needed for native Node.js modules).
 */
import { spawn, spawnSync as nodeSpawnSync } from 'child_process';
import { logger } from './logger';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface BuildToolsStatus {
  installed: boolean;
  method?: string;
  installHint?: string;
}

export interface BuildToolsInstallResult {
  success: boolean;
  error?: string;
}

// ─── Check ───────────────────────────────────────────────────────────

export async function checkBuildTools(): Promise<BuildToolsStatus> {
  if (IS_MAC) return checkMacOS();
  if (IS_WIN) return checkWindows();
  return checkLinux();
}

function checkMacOS(): Promise<BuildToolsStatus> {
  return new Promise((resolve) => {
    const child = spawn('xcode-select', ['-p'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code) => {
      resolve(code === 0
        ? { installed: true, method: 'xcode-select' }
        : {
            installed: false,
            method: 'xcode-select',
            installHint: 'Click Install when the system dialog appears, or run "xcode-select --install" in Terminal.',
          });
    });
    child.on('error', () => {
      resolve({
        installed: false,
        method: 'xcode-select',
        installHint: 'Run "xcode-select --install" in Terminal to install Command Line Tools.',
      });
    });
  });
}

function checkLinux(): Promise<BuildToolsStatus> {
  return new Promise((resolve) => {
    const child = spawn('which', ['gcc'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code) => {
      resolve(code === 0
        ? { installed: true, method: 'gcc' }
        : {
            installed: false,
            method: 'gcc',
            installHint: 'Installing build-essential (may ask for password)...',
          });
    });
    child.on('error', () => {
      resolve({
        installed: false,
        method: 'gcc',
        installHint: 'Install a C compiler (gcc) using your package manager.',
      });
    });
  });
}

function checkWindows(): Promise<BuildToolsStatus> {
  return new Promise((resolve) => {
    const child = spawn('where.exe', ['cl.exe'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code) => {
      resolve(code === 0
        ? { installed: true, method: 'vs-build-tools' }
        : {
            installed: false,
            method: 'vs-build-tools',
            installHint: 'Installing Visual Studio Build Tools via winget...',
          });
    });
    child.on('error', () => {
      resolve({
        installed: false,
        method: 'vs-build-tools',
        installHint: 'Install Visual Studio Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      });
    });
  });
}

// ─── Install ─────────────────────────────────────────────────────────

export async function installBuildTools(): Promise<BuildToolsInstallResult> {
  if (IS_MAC) return installMacOS();
  if (IS_WIN) return installWindows();
  return installLinux();
}

/** macOS: trigger xcode-select --install (opens system dialog, user must click Install) */
function installMacOS(): Promise<BuildToolsInstallResult> {
  return new Promise((resolve) => {
    logger.info('[build-tools] Triggering xcode-select --install');
    const child = spawn('xcode-select', ['--install'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d; });

    child.on('close', (code) => {
      // xcode-select --install returns 0 and opens a GUI dialog
      // If already installed, it returns 1 with "already installed" message
      if (code === 0) {
        resolve({ success: true });
      } else if (stderr.includes('already installed')) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: `xcode-select --install failed (exit ${code}): ${stderr.slice(-200)}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: String(err) });
    });
  });
}

/** Linux: try pkexec (graphical sudo) → sudo → direct apt, to install build-essential */
function installLinux(): Promise<BuildToolsInstallResult> {
  return new Promise((resolve) => {
    // Detect package manager
    const useApt = spawnSync('which', ['apt-get']);
    const useDnf = !useApt && spawnSync('which', ['dnf']);

    let cmd: string;
    let args: string[];

    if (useApt) {
      // Try pkexec for graphical sudo prompt (works on most desktop Linux)
      cmd = 'pkexec';
      args = ['apt-get', 'install', '-y', 'build-essential'];
    } else if (useDnf) {
      cmd = 'pkexec';
      args = ['dnf', 'groupinstall', '-y', 'Development Tools'];
    } else {
      resolve({ success: false, error: 'No supported package manager found (apt/dnf). Please install gcc manually.' });
      return;
    }

    logger.info(`[build-tools] Running: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d; });
    child.stderr?.on('data', (d: Buffer) => { stderr += d; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ success: false, error: 'Installation timed out' });
    }, INSTALL_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true });
      } else {
        // pkexec not found? Try without it (user may not have polkit)
        if (code === 127 || stderr.includes('not found')) {
          resolve({ success: false, error: 'Please run in terminal: sudo apt-get install -y build-essential' });
        } else {
          resolve({ success: false, error: `Exit ${code}: ${stderr.slice(-300) || stdout.slice(-300)}` });
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Please run in terminal: sudo apt-get install -y build-essential (${err})` });
    });
  });
}

/** Check if a command exists synchronously */
function spawnSync(cmd: string, args: string[]): boolean {
  try {
    const child = nodeSpawnSync(cmd, args, { stdio: 'ignore' });
    return child.status === 0;
  } catch {
    return false;
  }
}

/** Windows: try winget to install VS Build Tools */
function installWindows(): Promise<BuildToolsInstallResult> {
  return new Promise((resolve) => {
    // First check if winget is available
    const checkChild = spawn('where.exe', ['winget.exe'], { stdio: ['ignore', 'pipe', 'pipe'] });

    checkChild.on('close', (checkCode) => {
      if (checkCode !== 0) {
        resolve({
          success: false,
          error: 'winget not available. Please install Visual Studio Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/',
        });
        return;
      }

      logger.info('[build-tools] Installing VS Build Tools via winget');
      const child = spawn(
        'winget.exe',
        [
          'install',
          'Microsoft.VisualStudio.2022.BuildTools',
          '--override', '"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], shell: true },
      );

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d; });
      child.stderr?.on('data', (d: Buffer) => { stderr += d; });

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ success: false, error: 'Installation timed out (VS Build Tools can take a while). Check if it is installing in background.' });
      }, INSTALL_TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: `winget install failed (exit ${code}): ${(stderr || stdout).slice(-300)}. You can manually install from https://visualstudio.microsoft.com/visual-cpp-build-tools/`,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: String(err) });
      });
    });

    checkChild.on('error', () => {
      resolve({
        success: false,
        error: 'Please install Visual Studio Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      });
    });
  });
}
