/**
 * OpenZalo Login Manager
 * Handles QR-based login by spawning the `openzca` CLI tool.
 * Works cross-platform (macOS, Windows, Linux) via child_process.spawn.
 */
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, mkdtempSync, rmSync, watch } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { app } from 'electron';
import { logger } from './logger';

/**
 * Resolve the openzca binary path.
 * In packaged mode: resources/openclaw/node_modules/.bin/openzca
 * In dev mode: node_modules/.bin/openzca
 */
function resolveOpenzcaBinary(): string {
    const ext = process.platform === 'win32' ? '.cmd' : '';
    if (app.isPackaged) {
        return join(process.resourcesPath, 'openclaw', 'node_modules', '.bin', `openzca${ext}`);
    }
    // Dev mode: resolve from project root (app.getAppPath() = project root in dev)
    const projectRoot = resolve(app.getAppPath());
    return join(projectRoot, 'node_modules', '.bin', `openzca${ext}`);
}

export class ZaloUserLoginManager extends EventEmitter {
    private active = false;
    private profile: string | null = null;
    private childProcess: ChildProcess | null = null;

    constructor() {
        super();
    }

    async start(accountId: string = 'default'): Promise<void> {
        if (this.active && this.profile === accountId) {
            logger.info('[OpenZaloLogin] Already running for this profile');
            return;
        }

        if (this.active) {
            await this.stop();
        }

        this.profile = accountId;
        this.active = true;

        this.startCliLogin(accountId);
    }

    private startCliLogin(profile: string): void {
        if (!this.active) return;

        try {
            const binary = resolveOpenzcaBinary();
            logger.info('[OpenZaloLogin] Binary:', binary);

            if (!existsSync(binary)) {
                this.active = false;
                this.emit('error', `openzca binary not found at: ${binary}`);
                return;
            }

            // Create temp dir for QR image
            const tempDir = mkdtempSync(join(tmpdir(), 'crawbot-openzalo-'));
            const qrPath = join(tempDir, 'qr.png');

            logger.info('[OpenZaloLogin] Starting login for profile:', profile);

            // Spawn openzca auth login with --qr-path
            // Use shell: true on Windows for .cmd scripts
            const child = spawn(binary, [
                '--profile', profile,
                'auth', 'login',
                '--qr-path', qrPath,
            ], {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32',
                env: {
                    ...process.env,
                    OPENZCA_QR_RENDER: 'ascii',
                    OPENZCA_QR_AUTO_OPEN: '0',
                    OPENZCA_QR_ASCII: '0',
                },
            });

            this.childProcess = child;

            let stdout = '';
            let qrSent = false;

            // Watch for QR file to appear (more reliable than parsing stdout)
            const watcher = watch(tempDir, (_eventType, filename) => {
                if (filename === 'qr.png' && !qrSent && existsSync(qrPath)) {
                    try {
                        const pngData = readFileSync(qrPath);
                        if (pngData.length > 100) { // valid PNG
                            const dataUrl = `data:image/png;base64,${pngData.toString('base64')}`;
                            qrSent = true;
                            logger.info('[OpenZaloLogin] QR code captured from file');
                            this.emit('qr', { qr: dataUrl });
                        }
                    } catch {
                        // File not ready yet, will retry on next event
                    }
                }
            });

            // Also poll for QR file (fs.watch can be unreliable on some platforms)
            const pollInterval = setInterval(() => {
                if (qrSent || !this.active) return;
                if (existsSync(qrPath)) {
                    try {
                        const pngData = readFileSync(qrPath);
                        if (pngData.length > 100) {
                            const dataUrl = `data:image/png;base64,${pngData.toString('base64')}`;
                            qrSent = true;
                            logger.info('[OpenZaloLogin] QR code captured via poll');
                            this.emit('qr', { qr: dataUrl });
                        }
                    } catch { /* retry */ }
                }
            }, 500);

            child.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                logger.info('[OpenZaloLogin] stdout:', text.trim());

                // Parse events from openzca output
                if (text.includes('Scanned by:')) {
                    const match = text.match(/Scanned by:\s*(.+)/);
                    this.emit('scanned', { displayName: match?.[1]?.trim() });
                }
                if (text.includes('Logged in profile')) {
                    logger.info('[OpenZaloLogin] Login success detected');
                    // Login complete — don't emit yet, wait for process to exit
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                logger.info('[OpenZaloLogin] stderr:', data.toString().trim());
            });

            child.on('close', (code) => {
                clearInterval(pollInterval);
                watcher.close();

                // Cleanup temp dir
                try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

                if (!this.active) return; // stopped by user

                this.active = false;
                this.childProcess = null;

                if (code === 0 && stdout.includes('Logged in profile')) {
                    logger.info('[OpenZaloLogin] Process exited successfully');
                    this.emit('success', { accountId: profile });
                } else if (code === 0) {
                    // Exited OK but no "Logged in" message — might be --qr-base64 mode
                    this.emit('error', 'Login process exited without completing login');
                } else {
                    const errorMatch = stdout.match(/Error:\s*(.+)/i) ||
                                       stdout.match(/Can't login/i);
                    const msg = errorMatch?.[1] || errorMatch?.[0] || `Login failed (exit code: ${code})`;
                    logger.error('[OpenZaloLogin] Login failed:', msg);
                    this.emit('error', msg);
                }
            });

            child.on('error', (err) => {
                clearInterval(pollInterval);
                watcher.close();
                try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

                this.active = false;
                this.childProcess = null;
                logger.error('[OpenZaloLogin] Spawn error:', err.message);
                this.emit('error', `Failed to start openzca: ${err.message}`);
            });

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error('[OpenZaloLogin] Fatal error:', msg);
            this.active = false;
            this.emit('error', msg);
        }
    }

    async stop(): Promise<void> {
        logger.info('[OpenZaloLogin] Stop requested');
        this.active = false;
        if (this.childProcess) {
            try {
                this.childProcess.kill();
                logger.info('[OpenZaloLogin] Process killed');
            } catch { /* ignore */ }
            this.childProcess = null;
        }
    }
}

export const zaloUserLoginManager = new ZaloUserLoginManager();
