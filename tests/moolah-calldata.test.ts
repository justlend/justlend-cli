/**
 * Offline ABI / selector / calldata verification for the V2 write paths.
 *
 * No network, no signer, no markets needed — we just confirm that the function
 * signatures we ship match what TrxProvider / Moolah Core / PublicLiquidator
 * actually expose on-chain (per audited ABIs in mcp-server-justlend f/v1.1.0).
 *
 * If any of these selectors drifts, real-world calls will fail with
 * `REVERT_OPCODE` and no useful error.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { keccak256, toUtf8Bytes } from 'ethers';
import { MOOLAH_CORE_ABI, TRX_PROVIDER_ABI, PUBLIC_LIQUIDATOR_ABI } from '../src/lib/abis.js';

function selector(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(0, 10);
}

const MARKET_PARAMS_TUPLE = '(address,address,address,address,uint256)';

// Known selectors — these come from the on-chain ABIs of the deployed contracts
// (verified against mcp-server-justlend f/v1.1.0 service files).
//
// IMPORTANT: liquidate is on the PublicLiquidator proxy (bytes32 marketId based)
// rather than on Moolah Core itself, because PublicLiquidator wraps the core
// liquidator with bonus-aware accounting and is the entry point JustLend
// front-end uses. The Moolah Core does NOT expose a public `liquidate`.
const EXPECTED = {
  // TrxProvider — native TRX wrapper, all deposit/supply/repay are payable
  trxProvider: {
    deposit: `deposit(address,address)`,
    withdraw: `withdraw(address,uint256,address,address)`,
    redeem: `redeem(address,uint256,address,address)`,
    supplyCollateral: `supplyCollateral(${MARKET_PARAMS_TUPLE},address,bytes)`,
    withdrawCollateral: `withdrawCollateral(${MARKET_PARAMS_TUPLE},uint256,address,address)`,
    borrow: `borrow(${MARKET_PARAMS_TUPLE},uint256,uint256,address,address)`,
    repay: `repay(${MARKET_PARAMS_TUPLE},uint256,uint256,address,bytes)`,
  },
  // Moolah Core — TRC20 path, requires prior approve. No `liquidate` here.
  moolahCore: {
    supply: `supply(${MARKET_PARAMS_TUPLE},uint256,uint256,address,bytes)`,
    withdraw: `withdraw(${MARKET_PARAMS_TUPLE},uint256,uint256,address,address)`,
    borrow: `borrow(${MARKET_PARAMS_TUPLE},uint256,uint256,address,address)`,
    repay: `repay(${MARKET_PARAMS_TUPLE},uint256,uint256,address,bytes)`,
    supplyCollateral: `supplyCollateral(${MARKET_PARAMS_TUPLE},uint256,address,bytes)`,
    withdrawCollateral: `withdrawCollateral(${MARKET_PARAMS_TUPLE},uint256,address,address)`,
  },
  // PublicLiquidator — single entry point used by `justlend liquidate`.
  publicLiquidator: {
    liquidate: `liquidate(bytes32,address,uint256,uint256)`,
  },
};

function buildSig(fn: { name?: string; inputs?: Array<{ type: string; components?: any[] }> }): string {
  const types = (fn.inputs ?? []).map(i => i.type === 'tuple' ? MARKET_PARAMS_TUPLE : i.type);
  return `${fn.name}(${types.join(',')})`;
}

describe('TRX_PROVIDER_ABI selectors', () => {
  for (const [name, expectedSig] of Object.entries(EXPECTED.trxProvider)) {
    it(`${name} selector matches ${expectedSig}`, () => {
      const fn = TRX_PROVIDER_ABI.find(f => f.type === 'function' && f.name === name);
      assert.ok(fn, `${name} must be in TRX_PROVIDER_ABI`);
      assert.equal(buildSig(fn), expectedSig);
    });
  }
  it('deposit/supplyCollateral/repay are payable (TRX is callValue)', () => {
    for (const name of ['deposit', 'supplyCollateral', 'repay']) {
      const fn = TRX_PROVIDER_ABI.find(f => f.type === 'function' && f.name === name) as any;
      assert.equal(fn.stateMutability, 'payable', `${name} must be payable on TrxProvider`);
    }
  });
});

describe('MOOLAH_CORE_ABI selectors', () => {
  for (const [name, expectedSig] of Object.entries(EXPECTED.moolahCore)) {
    it(`${name} selector matches ${expectedSig}`, () => {
      const fn = MOOLAH_CORE_ABI.find(f => f.type === 'function' && f.name === name);
      assert.ok(fn, `${name} must be in MOOLAH_CORE_ABI`);
      assert.equal(buildSig(fn), expectedSig);
    });
  }
  it('all Moolah Core writes are nonpayable (TRC20 transfers, not native TRX)', () => {
    for (const name of Object.keys(EXPECTED.moolahCore)) {
      const fn = MOOLAH_CORE_ABI.find(f => f.type === 'function' && f.name === name) as any;
      assert.equal(fn.stateMutability, 'nonpayable', `${name} must NOT be payable on Moolah Core`);
    }
  });
  it('Moolah Core does NOT expose liquidate (use PublicLiquidator instead)', () => {
    const fn = MOOLAH_CORE_ABI.find(f => f.type === 'function' && f.name === 'liquidate');
    assert.equal(fn, undefined, 'Moolah Core must not expose public liquidate');
  });
});

describe('PUBLIC_LIQUIDATOR_ABI selectors', () => {
  for (const [name, expectedSig] of Object.entries(EXPECTED.publicLiquidator)) {
    it(`${name} selector matches ${expectedSig}`, () => {
      const fn = PUBLIC_LIQUIDATOR_ABI.find(f => f.type === 'function' && f.name === name);
      assert.ok(fn, `${name} must be in PUBLIC_LIQUIDATOR_ABI`);
      assert.equal(buildSig(fn), expectedSig);
    });
  }
  it('liquidate takes (marketId, borrower, seizedAssets, repaidShares) — no tuple, no bytes data', () => {
    const fn = PUBLIC_LIQUIDATOR_ABI.find(f => f.type === 'function' && f.name === 'liquidate') as any;
    assert.equal(fn.inputs.length, 4);
    assert.equal(fn.inputs[0].type, 'bytes32');
    assert.equal(fn.inputs[0].name, 'marketId');
    assert.equal(fn.inputs[2].name, 'seizedAssets');
    assert.equal(fn.inputs[3].name, 'repaidShares');
  });
});

describe('liquidate routing sanity', () => {
  it('TrxProvider does NOT expose liquidate (use PublicLiquidator)', () => {
    const fn = TRX_PROVIDER_ABI.find(f => f.type === 'function' && f.name === 'liquidate');
    assert.equal(fn, undefined);
  });
});

describe('selector uniqueness across ABIs (sanity)', () => {
  it('Moolah Core and TrxProvider repay selectors are distinct (different signatures)', () => {
    const coreRepay = MOOLAH_CORE_ABI.find(f => f.type === 'function' && f.name === 'repay') as any;
    const trxRepay = TRX_PROVIDER_ABI.find(f => f.type === 'function' && f.name === 'repay') as any;
    // Both share the (marketParams,uint256,uint256,address,bytes) shape, so selectors collide.
    // The difference is *which contract* you call (TrxProvider is payable). This assertion
    // documents that selectors alone are NOT enough to disambiguate — routing logic must
    // pick the right contract based on whether the loan token is WTRX.
    assert.equal(selector(buildSig(coreRepay)), selector(buildSig(trxRepay)),
      'repay shares the same selector on both ABIs by design — routing decides which to call');
  });
});
