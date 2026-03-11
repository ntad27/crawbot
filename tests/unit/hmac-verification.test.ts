/**
 * Unit tests for HMAC webhook signature verification
 * Source: electron/automation/http-server.ts (verifyWebhookSignature)
 *
 * Signature format: sha256=HMAC-SHA256(secret, timestamp + '.' + body)
 * Timestamp must be within 300 seconds of now.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyWebhookSignature } from '@electron/automation/http-server';

// ---- helper: compute a valid signature ----

function makeSignature(secret: string, timestamp: string, body: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${mac}`;
}

const SECRET = 'super-secret-key-123';
const BODY = JSON.stringify({ event: 'test', data: 42 });

describe('verifyWebhookSignature — valid signature', () => {
  it('accepts a valid signature with a recent timestamp', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSignature(SECRET, timestamp, BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, timestamp)).toBe(true);
  });

  it('accepts timestamp right at the 300-second boundary', () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 299);
    const sig = makeSignature(SECRET, timestamp, BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, timestamp)).toBe(true);
  });

  it('handles empty body correctly', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSignature(SECRET, timestamp, '');
    expect(verifyWebhookSignature(SECRET, '', sig, timestamp)).toBe(true);
  });
});

describe('verifyWebhookSignature — invalid signature', () => {
  it('rejects a tampered body', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSignature(SECRET, timestamp, BODY);
    const tamperedBody = BODY + 'x';
    expect(verifyWebhookSignature(SECRET, tamperedBody, sig, timestamp)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSignature('wrong-secret', timestamp, BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, timestamp)).toBe(false);
  });

  it('rejects a completely wrong signature string', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(verifyWebhookSignature(SECRET, BODY, 'sha256=deadbeef', timestamp)).toBe(false);
  });

  it('rejects signature without sha256= prefix (length mismatch)', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const mac = crypto.createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest('hex');
    // Omit the sha256= prefix — will have different length
    expect(verifyWebhookSignature(SECRET, BODY, mac, timestamp)).toBe(false);
  });
});

describe('verifyWebhookSignature — expired timestamp', () => {
  it('rejects a timestamp older than 300 seconds', () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const sig = makeSignature(SECRET, oldTimestamp, BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, oldTimestamp)).toBe(false);
  });

  it('rejects a future timestamp farther than 300 seconds away', () => {
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 301);
    const sig = makeSignature(SECRET, futureTimestamp, BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, futureTimestamp)).toBe(false);
  });

  it('rejects NaN timestamp', () => {
    const sig = makeSignature(SECRET, 'not-a-number', BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, 'not-a-number')).toBe(false);
  });

  it('rejects empty timestamp string', () => {
    const sig = makeSignature(SECRET, '', BODY);
    expect(verifyWebhookSignature(SECRET, BODY, sig, '')).toBe(false);
  });
});
