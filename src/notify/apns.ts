import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import * as http2 from 'node:http2';
import type { HubConfig, Logger } from '../types.js';

export type ApnsSendResult = 'ok' | 'unregistered' | 'failed';

export interface ApnsSenderDeps {
  config: HubConfig;
  log: Logger;
}

export interface ApnsSender {
  send(deviceToken: string, title: string, body: string | undefined): Promise<ApnsSendResult>;
  stop(): void;
}

const JWT_TTL_MS = 45 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const UNREGISTERED_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/** Pure: builds an ES256 JWT for the APNs provider token. Apple requires the raw r||s signature
 * (ieee-p1363), not node's default DER encoding — a DER-signed token is silently rejected. */
export function buildApnsJwt(opts: { keyPem: string; keyId: string; teamId: string; nowMs: number }): string {
  const { keyPem, keyId, teamId, nowMs } = opts;
  const header = { alg: 'ES256', kid: keyId };
  const payload = { iss: teamId, iat: Math.floor(nowMs / 1000) };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(keyPem),
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

export function createApnsSender(deps: ApnsSenderDeps): ApnsSender {
  const { config, log } = deps;

  let keyPem: string | undefined;
  let cachedJwt: { jwt: string; builtAt: number } | undefined;

  function loadKey(): string | undefined {
    if (keyPem !== undefined) return keyPem;
    try {
      keyPem = readFileSync(config.push.apns.keyPath, 'utf8');
      return keyPem;
    } catch (err) {
      log.warn('apns: failed to read APNs auth key', { error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  function getJwt(): string | undefined {
    const now = Date.now();
    if (cachedJwt && now - cachedJwt.builtAt < JWT_TTL_MS) return cachedJwt.jwt;

    const pem = loadKey();
    if (!pem) return undefined;

    const jwt = buildApnsJwt({
      keyPem: pem,
      keyId: config.push.apns.keyId,
      teamId: config.push.apns.teamId,
      nowMs: now,
    });
    cachedJwt = { jwt, builtAt: now };
    return jwt;
  }

  async function send(deviceToken: string, title: string, body: string | undefined): Promise<ApnsSendResult> {
    try {
      const jwt = getJwt();
      if (!jwt) return 'failed';

      const host =
        config.push.apns.environment === 'sandbox'
          ? 'https://api.sandbox.push.apple.com'
          : 'https://api.push.apple.com';

      const payload = JSON.stringify({
        aps: { alert: body ? { title, body } : { title }, sound: 'default' },
      });

      return await new Promise<ApnsSendResult>((resolve) => {
        const session = http2.connect(host);
        let settled = false;

        function finish(result: ApnsSendResult): void {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            session.close();
          } catch {
            // ignore
          }
          resolve(result);
        }

        const timeout = setTimeout(() => {
          log.warn('apns: request timed out', { deviceToken: deviceToken.slice(0, 8) });
          finish('failed');
        }, REQUEST_TIMEOUT_MS);

        session.on('error', (err) => {
          log.warn('apns: session error', { error: err.message });
          finish('failed');
        });

        const req = session.request({
          ':method': 'POST',
          ':path': '/3/device/' + deviceToken,
          authorization: 'bearer ' + jwt,
          'apns-topic': config.push.apns.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
        });

        let status: number | undefined;
        let responseBody = '';

        req.on('response', (headers) => {
          const s = headers[':status'];
          status = typeof s === 'number' ? s : Number(s);
        });

        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          responseBody += chunk;
        });

        req.on('end', () => {
          if (status === 200) {
            finish('ok');
            return;
          }

          let reason: string | undefined;
          try {
            const parsed: unknown = responseBody ? JSON.parse(responseBody) : undefined;
            if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
              reason = String((parsed as { reason: unknown }).reason);
            }
          } catch {
            // ignore — reason stays undefined
          }

          if (status === 410 || (reason && UNREGISTERED_REASONS.has(reason))) {
            log.warn('apns: device token unregistered', { status, reason });
            finish('unregistered');
            return;
          }

          log.warn('apns: send failed', { status, reason });
          finish('failed');
        });

        req.on('error', (err) => {
          log.warn('apns: request error', { error: err.message });
          finish('failed');
        });

        req.write(payload);
        req.end();
      });
    } catch (err) {
      log.warn('apns: send threw', { error: err instanceof Error ? err.message : String(err) });
      return 'failed';
    }
  }

  function stop(): void {
    // Nothing to tear down — each send() opens and closes its own http2 session.
  }

  return { send, stop };
}
