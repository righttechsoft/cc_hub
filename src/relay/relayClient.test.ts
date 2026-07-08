import { describe, expect, it } from 'vitest';
import { isAllowedApiPath } from './relayClient.js';

describe('isAllowedApiPath', () => {
  it.each([
    '/api/v1/health',
    '/api/v1/sessions?status=active',
    '/api/v1/kb/search?q=x',
  ])('accepts %s', (path) => {
    expect(isAllowedApiPath(path)).toBe(true);
  });

  it.each([
    '/hooks/event',
    '/mcp',
    '/api/v1/../hooks/event',
    '/api/v1/%2e%2e/hooks',
    '/api/v1/%2E%2E/hooks',
    '/api/v10/x',
    '/API/v1/x',
    '',
  ])('rejects %s', (path) => {
    expect(isAllowedApiPath(path)).toBe(false);
  });
});
