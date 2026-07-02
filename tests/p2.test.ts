import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';

import { configureDiagnostics, debugLog } from '../src/lib/diagnostics.js';
import { getApiHost, getMoolahApiHost } from '../src/lib/chains.js';

describe('P2 configuration and diagnostics helpers', () => {
  const oldEnv = { ...process.env };
  const oldStderr = process.stderr.write;

  beforeEach(() => {
    process.env = { ...oldEnv };
    configureDiagnostics({ verbose: false, debug: false });
  });

  afterEach(() => {
    process.env = { ...oldEnv };
    process.stderr.write = oldStderr;
    configureDiagnostics({ verbose: false, debug: false });
  });

  it('allows backend host overrides via environment only with explicit untrusted-host opt-in', () => {
    process.env.JUSTLEND_API_HOST = 'https://example.invalid/api';
    process.env.JUSTLEND_MOOLAH_API_HOST = 'https://moolah.example.invalid';
    assert.throws(() => getApiHost('nile'), /not in the trusted allowlist/i);
    assert.throws(() => getMoolahApiHost('mainnet'), /not in the trusted allowlist/i);
    process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = '1';
    assert.equal(getApiHost('nile'), 'https://example.invalid/api');
    assert.equal(getMoolahApiHost('mainnet'), 'https://moolah.example.invalid');
  });

  it('resolves the mainnet Moolah V2 host to the mainnet backend (not the Nile-serving qorvex host)', () => {
    const host = getMoolahApiHost('mainnet');
    assert.equal(host, 'https://zenvora.ablesdxd.link');
    assert.doesNotMatch(host, /qorvex/);
    // aliases for mainnet should resolve identically
    assert.equal(getMoolahApiHost('tron'), 'https://zenvora.ablesdxd.link');
    assert.equal(getMoolahApiHost('trx'), 'https://zenvora.ablesdxd.link');
  });

  it('redacts sensitive values in debug diagnostics', () => {
    let written = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    configureDiagnostics({ debug: true });
    debugLog('unit.test', { apiKey: 'SECRET', nested: { token: 'TOKEN', normal: 'ok' } });

    assert.match(written, /unit\.test/);
    assert.match(written, /\[REDACTED\]/);
    assert.doesNotMatch(written, /SECRET|TOKEN/);
    assert.match(written, /normal/);
  });
});
