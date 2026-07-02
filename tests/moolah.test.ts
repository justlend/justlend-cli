import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { selectLiquidateMode, findVaultByAddress } from '../src/lib/moolah.js';
import { getMoolahAddresses } from '../src/lib/chains.js';
import { TronNetwork } from '../src/lib/chains.js';

describe('selectLiquidateMode', () => {
  it('returns "seized" when only --seized-assets is provided', () => {
    assert.equal(selectLiquidateMode('100', undefined), 'seized');
    assert.equal(selectLiquidateMode('100', '0'), 'seized');
    assert.equal(selectLiquidateMode('100', ''), 'seized');
  });
  it('returns "shares" when only --repaid-shares is provided', () => {
    assert.equal(selectLiquidateMode(undefined, '50'), 'shares');
    assert.equal(selectLiquidateMode('0', '50'), 'shares');
    assert.equal(selectLiquidateMode('', '50'), 'shares');
  });
  it('throws when both are non-zero (mutually exclusive)', () => {
    assert.throws(() => selectLiquidateMode('100', '50'), /EITHER/);
  });
  it('throws when neither is provided', () => {
    assert.throws(() => selectLiquidateMode(undefined, undefined), /one of/);
    assert.throws(() => selectLiquidateMode('0', '0'), /one of/);
    assert.throws(() => selectLiquidateMode('', ''), /one of/);
  });
});

describe('vault registry decimals', () => {
  it('mainnet TRX vault: underlyingDecimals=6, sharesDecimals defined, native (no underlying)', () => {
    const moolah = getMoolahAddresses(TronNetwork.Mainnet);
    const trx = moolah.vaults.TRX;
    assert.ok(trx, 'TRX vault must exist on mainnet');
    assert.equal(trx.underlyingDecimals, 6);
    assert.equal(typeof trx.sharesDecimals, 'number');
    assert.ok(trx.sharesDecimals > 0);
    assert.equal(trx.underlying, '', 'TRX vault must have empty underlying (native)');
  });
  it('mainnet USDT vault: underlyingDecimals=6', () => {
    const usdt = getMoolahAddresses(TronNetwork.Mainnet).vaults.USDT;
    assert.ok(usdt);
    assert.equal(usdt.underlyingDecimals, 6);
  });
  it('findVaultByAddress returns the registry entry for known TRX vault', () => {
    const moolah = getMoolahAddresses(TronNetwork.Mainnet);
    const found = findVaultByAddress(TronNetwork.Mainnet, moolah.vaults.TRX.address);
    assert.equal(found?.underlyingSymbol, 'TRX');
  });
  it('findVaultByAddress returns undefined for unknown address', () => {
    const found = findVaultByAddress(TronNetwork.Mainnet, 'TR0000000000000000000000000000000000');
    assert.equal(found, undefined);
  });
});

describe('moolah addresses sanity', () => {
  it('mainnet exposes both trxProviderProxy and wtrxProxy', () => {
    const m = getMoolahAddresses(TronNetwork.Mainnet);
    assert.match(m.trxProviderProxy, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    assert.match(m.wtrxProxy, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    assert.notEqual(m.trxProviderProxy, m.wtrxProxy, 'TrxProvider and WTRX must be distinct contracts');
  });
});
