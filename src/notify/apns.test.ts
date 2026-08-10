import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { buildApnsJwt, buildApnsPayload } from './apns.js';

describe('buildApnsJwt', () => {
  it('produces a header.payload.signature JWT verifiable with the matching public key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const nowMs = 1_700_000_000_000;
    const jwt = buildApnsJwt({ keyPem, keyId: 'ABC1234567', teamId: 'TEAM123456', nowMs });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'ES256', kid: 'ABC1234567' });

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(payload).toEqual({ iss: 'TEAM123456', iat: Math.floor(nowMs / 1000) });

    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sigB64, 'base64url')
    );
    expect(ok).toBe(true);
  });
});

describe('buildApnsPayload', () => {
  it('builds the plain alert payload when no opts are given (byte-identical to the pre-actionable-push shape)', () => {
    const payload = buildApnsPayload('proj — permission', 'Bash: ls -la');
    expect(JSON.parse(payload)).toEqual({
      aps: { alert: { title: 'proj — permission', body: 'Bash: ls -la' }, sound: 'default' },
    });
  });

  it('omits body from alert when body is undefined', () => {
    const payload = buildApnsPayload('cc_hub — usage limit', undefined);
    expect(JSON.parse(payload)).toEqual({
      aps: { alert: { title: 'cc_hub — usage limit' }, sound: 'default' },
    });
  });

  it('adds category, interruption-level, and root-level data when opts are given', () => {
    const payload = buildApnsPayload('proj — permission', 'Bash: ls -la', {
      category: 'PERMISSION_REQUEST',
      timeSensitive: true,
      data: { type: 'permission_request', requestId: 42, sessionId: 'sess-1', instance: 'proj' },
    });
    expect(JSON.parse(payload)).toEqual({
      type: 'permission_request',
      requestId: 42,
      sessionId: 'sess-1',
      instance: 'proj',
      aps: {
        alert: { title: 'proj — permission', body: 'Bash: ls -la' },
        sound: 'default',
        category: 'PERMISSION_REQUEST',
        'interruption-level': 'time-sensitive',
      },
    });
  });
});
