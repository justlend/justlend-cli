import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRevertData } from '../src/lib/revert.js';

describe('decodeRevertData', () => {
  it('returns null for empty/falsy inputs', () => {
    assert.equal(decodeRevertData(null), null);
    assert.equal(decodeRevertData(undefined), null);
    assert.equal(decodeRevertData(''), null);
    assert.equal(decodeRevertData('0x'), null);
  });

  it('decodes standard Solidity Error(string)', () => {
    // ABI-encoded "Error(string)" with "insufficient balance"
    // selector: 08c379a0
    // offset: 0000000000000000000000000000000000000000000000000000000000000020
    // length: 0000000000000000000000000000000000000000000000000000000000000014 (20 bytes)
    // data: 696e73756666696369656e742062616c616e6365 ("insufficient balance") + padding
    const hex = '0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000014' +
      '696e73756666696369656e742062616c616e6365000000000000000000000000';
    assert.equal(decodeRevertData(hex), 'insufficient balance');
  });

  it('decodes standard Solidity Panic(uint256)', () => {
    // selector: 4e487b71
    // panic code 0x11 (arithmetic overflow or underflow)
    const hex = '0x4e487b71' +
      '0000000000000000000000000000000000000000000000000000000000000011';
    assert.equal(decodeRevertData(hex), 'Panic(0x11): arithmetic overflow or underflow');
  });

  it('falls back to custom error format for unknown selectors', () => {
    // custom error selector: a9059cbb (standard transfer selector as custom error placeholder)
    const hex = '0xa9059cbb' + '0000000000000000000000000000000000000000000000000000000000000123';
    assert.equal(
      decodeRevertData(hex),
      'Contract reverted with custom error 0xa9059cbb (args 0x0000000000000000000000000000000000000000000000000000000000000123)'
    );
  });
});
