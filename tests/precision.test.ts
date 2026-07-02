/**
 * Precision / safe-conversion regression tests.
 *
 * Locks down two invariants we share with mcp-server-justlend's audit fixes:
 *   1. callValueToSafeNumber rejects negatives, non-integers (via BigInt parse),
 *      and amounts above Number.MAX_SAFE_INTEGER.
 *   2. utils.toSun / utils.parseUnits go through string math, NOT IEEE-754 float,
 *      so callers in commands/strx.ts and commands/energy.ts never feed a
 *      Number(big)/1e6 result into BigInt() on the write path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { callValueToSafeNumber } from '../src/lib/tronweb.js';
import { utils } from '../src/lib/utils.js';

describe('callValueToSafeNumber', () => {
  it('accepts 0 and small positive values', () => {
    assert.equal(callValueToSafeNumber(0n), 0);
    assert.equal(callValueToSafeNumber('1000000'), 1_000_000);
    assert.equal(callValueToSafeNumber(123), 123);
  });

  it('accepts exactly MAX_SAFE_INTEGER', () => {
    assert.equal(
      callValueToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('rejects MAX_SAFE_INTEGER + 1', () => {
    assert.throws(
      () => callValueToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
      /exceeds Number\.MAX_SAFE_INTEGER/,
    );
  });

  it('rejects negative values', () => {
    assert.throws(() => callValueToSafeNumber(-1n), /non-negative/);
    assert.throws(() => callValueToSafeNumber('-1000'), /non-negative/);
  });

  it('rejects non-integer strings via BigInt parse', () => {
    assert.throws(() => callValueToSafeNumber('1.5'));
    assert.throws(() => callValueToSafeNumber('abc'));
  });

  it('accepts bigint, string and number inputs interchangeably', () => {
    assert.equal(callValueToSafeNumber(42n), 42);
    assert.equal(callValueToSafeNumber('42'), 42);
    assert.equal(callValueToSafeNumber(42), 42);
  });
});

describe('utils.toSun precision', () => {
  it('handles exact 6-decimal inputs without float drift', () => {
    assert.equal(utils.toSun('1'), '1000000');
    assert.equal(utils.toSun('1.5'), '1500000');
    assert.equal(utils.toSun('0.000001'), '1');
    assert.equal(utils.toSun('123456.789012'), '123456789012');
  });

  it('produces strings safe to BigInt() without precision loss', () => {
    // 9,007,199.254740 TRX would land near MAX_SAFE_INTEGER as sun. Pick a
    // value just under: 9,000,000 TRX → 9e15 sun, still inside safe range.
    const sun = utils.toSun('9000000');
    assert.equal(BigInt(sun), 9_000_000_000_000n);
  });

  it('toSun output never contains a decimal point (no fractional sun)', () => {
    for (const v of ['1.5', '0.5', '0.000001', '999999.999999']) {
      assert.doesNotMatch(utils.toSun(v), /\./, `toSun(${v}) leaked a decimal`);
    }
  });
});

describe('utils.parseUnits / formatUnits roundtrip', () => {
  it('parseUnits uses string math (no IEEE-754 artifacts)', () => {
    // 0.1 + 0.2 in float = 0.30000000000000004; string path must be clean.
    assert.equal(utils.parseUnits('0.1', 18), 100_000_000_000_000_000n);
    assert.equal(utils.parseUnits('0.2', 18), 200_000_000_000_000_000n);
  });

  it('roundtrips large values that exceed 2^53', () => {
    // ~10^24 wei, well above 2^53 (~9.007e15). Must survive as BigInt.
    const raw = '1234567890000000000000000';
    assert.equal(utils.formatUnits(raw, 18), '1234567.89');
    assert.equal(utils.parseUnits('1234567.89', 18), BigInt(raw));
  });

  it('rejects malformed numeric strings', () => {
    assert.throws(() => utils.parseUnits('1.2.3', 6), /Invalid numeric value/);
    assert.throws(() => utils.parseUnits('abc', 6), /Invalid numeric value/);
  });

  it('rejects negative amounts (never reaches the signing path as a negative bigint)', () => {
    assert.throws(() => utils.parseUnits('-1', 6), /Invalid numeric value/);
    assert.throws(() => utils.parseUnits('-0.5', 18), /Invalid numeric value/);
  });
});
