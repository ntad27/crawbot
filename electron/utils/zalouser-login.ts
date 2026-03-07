/**
 * Zalo Personal (zalouser) Login Manager
 * Handles QR-based login for Zalo Personal accounts using zca-js.
 * Follows the same EventEmitter pattern as WhatsAppLoginManager.
 */
import { join } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

// --- Types from zca-js ---

interface ZcaLoginQRCallbackEvent {
    type: number;
    data: {
        code?: string;
        image?: string;
        avatar?: string;
        display_name?: string;
        cookie?: unknown;
        imei?: string;
        userAgent?: string;
    } | null;
    actions: {
        saveToFile?: (qrPath?: string) => Promise<unknown>;
        retry?: () => unknown;
        abort?: () => unknown;
    } | null;
}

const LoginQRCallbackEventType = {
    QRCodeGenerated: 0,
    QRCodeExpired: 1,
    QRCodeScanned: 2,
    QRCodeDeclined: 3,
    GotLoginInfo: 4,
} as const;

interface StoredCredentials {
    imei: string;
    cookie: unknown;
    userAgent: string;
    language?: string;
    createdAt: string;
    lastUsedAt?: string;
}

const CREDENTIALS_DIR = join(homedir(), '.openclaw', 'credentials', 'zalouser');

function credentialsPath(profile: string): string {
    if (profile === 'default') {
        return join(CREDENTIALS_DIR, 'credentials.json');
    }
    return join(CREDENTIALS_DIR, `credentials-${encodeURIComponent(profile)}.json`);
}

function ensureCredentialsDir(): void {
    if (!existsSync(CREDENTIALS_DIR)) {
        mkdirSync(CREDENTIALS_DIR, { recursive: true });
    }
}

function writeCredentials(
    profile: string,
    credentials: { imei: string; cookie: unknown; userAgent: string },
): void {
    ensureCredentialsDir();
    const stored: StoredCredentials = {
        ...credentials,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
    };
    writeFileSync(credentialsPath(profile), JSON.stringify(stored, null, 2), 'utf-8');
}

// --- Zalo QR Login Manager ---

export class ZaloUserLoginManager extends EventEmitter {
    private active = false;
    private profile: string | null = null;
    private abortFn: (() => void) | null = null;
    private retryFn: (() => void) | null = null;
    private loginCompleted = false;

    constructor() {
        super();
    }

    /**
     * Start Zalo Personal login via QR code
     */
    async start(accountId: string = 'default'): Promise<void> {
        if (this.active && this.profile === accountId) {
            console.log('[ZaloUserLogin] Already running for this profile');
            return;
        }

        if (this.active) {
            await this.stop();
        }

        this.profile = accountId;
        this.active = true;
        this.loginCompleted = false;

        await this.startQrLogin(accountId);
    }

    private async startQrLogin(profile: string): Promise<void> {
        if (!this.active) return;

        try {
            // Dynamically import zca-js
            const zcaModule = await import('zca-js');
            const Zalo = zcaModule.Zalo || zcaModule.default?.Zalo || zcaModule.default;

            if (!Zalo) {
                throw new Error('Could not load Zalo class from zca-js');
            }

            console.log('[ZaloUserLogin] Starting QR login for profile:', profile);

            const zalo = new Zalo({ logging: false, selfListen: false });

            // loginQR returns a Promise<API> that resolves when login completes
            const loginPromise = zalo.loginQR(
                undefined,
                (event: ZcaLoginQRCallbackEvent) => {
                    if (!this.active) return;

                    try {
                        switch (event.type) {
                            case LoginQRCallbackEventType.QRCodeGenerated: {
                                console.log('[ZaloUserLogin] QR code generated');
                                if (event.actions?.abort) {
                                    this.abortFn = event.actions.abort as () => void;
                                }
                                if (event.actions?.retry) {
                                    this.retryFn = event.actions.retry as () => void;
                                }

                                let image = event.data?.image || '';
                                // Normalize to data URL
                                if (image && !image.startsWith('data:image')) {
                                    image = `data:image/png;base64,${image}`;
                                }
                                if (image) {
                                    this.emit('qr', { qr: image });
                                }
                                break;
                            }

                            case LoginQRCallbackEventType.QRCodeExpired: {
                                console.log('[ZaloUserLogin] QR code expired, retrying...');
                                if (event.actions?.retry) {
                                    event.actions.retry();
                                } else {
                                    this.emit('error', 'QR code expired');
                                    this.active = false;
                                }
                                break;
                            }

                            case LoginQRCallbackEventType.QRCodeScanned: {
                                console.log('[ZaloUserLogin] QR code scanned by user:', event.data?.display_name);
                                this.emit('scanned', {
                                    displayName: event.data?.display_name,
                                    avatar: event.data?.avatar,
                                });
                                break;
                            }

                            case LoginQRCallbackEventType.QRCodeDeclined: {
                                console.log('[ZaloUserLogin] QR code declined by user');
                                this.emit('error', 'Login was declined on the phone');
                                this.active = false;
                                break;
                            }

                            case LoginQRCallbackEventType.GotLoginInfo: {
                                console.log('[ZaloUserLogin] Got login info, saving credentials...');
                                this.loginCompleted = true;
                                try {
                                    if (event.data?.imei && event.data?.cookie && event.data?.userAgent) {
                                        writeCredentials(profile, {
                                            imei: event.data.imei,
                                            cookie: event.data.cookie,
                                            userAgent: event.data.userAgent,
                                        });
                                        console.log('[ZaloUserLogin] Credentials saved successfully');
                                    } else {
                                        console.error('[ZaloUserLogin] GotLoginInfo but missing data:', {
                                            hasImei: !!event.data?.imei,
                                            hasCookie: !!event.data?.cookie,
                                            hasUserAgent: !!event.data?.userAgent,
                                        });
                                    }
                                } catch (err) {
                                    console.error('[ZaloUserLogin] Failed to save credentials:', err);
                                }
                                break;
                            }

                            default: {
                                console.log('[ZaloUserLogin] Unknown event type:', event.type, 'data keys:', event.data ? Object.keys(event.data) : 'null');
                                break;
                            }
                        }
                    } catch (err) {
                        console.error('[ZaloUserLogin] Error in callback:', err);
                    }
                },
            );

            // Wait for login to complete
            try {
                await loginPromise;
                if (this.active) {
                    console.log('[ZaloUserLogin] Login completed successfully');
                    this.active = false;
                    this.emit('success', { accountId: profile });
                }
            } catch (err) {
                if (this.active) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error('[ZaloUserLogin] Login failed:', msg);
                    this.active = false;
                    this.emit('error', msg);
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ZaloUserLogin] Fatal error:', msg);
            this.active = false;
            this.emit('error', msg);
        }
    }

    /**
     * Stop current login process
     */
    async stop(): Promise<void> {
        console.log('[ZaloUserLogin] Stop requested (active=%s, loginCompleted=%s)', this.active, this.loginCompleted);
        this.active = false;
        // Don't abort if login already completed — credentials are already saved
        if (this.abortFn && !this.loginCompleted) {
            try {
                this.abortFn();
                console.log('[ZaloUserLogin] Aborted QR login session');
            } catch {
                // Ignore abort errors
            }
        }
        this.abortFn = null;
        this.retryFn = null;
    }
}

export const zaloUserLoginManager = new ZaloUserLoginManager();
