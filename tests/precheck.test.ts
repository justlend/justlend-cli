import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkContractTrigger, measureTxBytes, runPrecheck } from '../src/lib/precheck.js';
import { setJsonMode } from '../src/lib/error.js';

const SUN = 1_000_000;

// Minimal TronWeb stand-in: triggerConstantRaw only touches
// transactionBuilder._getTriggerSmartContractArgs + fullNode.request, and the
// economics read trx.getAccount / getAccountResources / getChainParameters.
function fakeTronWeb(opts: {
  sim: unknown;
  balanceSun: number;
  availableEnergy?: number;
  availableBandwidth?: number;
  energyFee?: number;
  bandwidthFee?: number;
}) {
  const energy = opts.availableEnergy ?? 0;
  const bandwidth = opts.availableBandwidth ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    transactionBuilder: { _getTriggerSmartContractArgs: () => ({}) },
    fullNode: { request: async () => opts.sim },
    trx: {
      getAccount: async () => ({ balance: opts.balanceSun }),
      getAccountResources: async () => ({
        EnergyLimit: energy,
        EnergyUsed: 0,
        NetLimit: bandwidth,
        NetUsed: 0,
        freeNetLimit: 0,
        freeNetUsed: 0,
      }),
      getChainParameters: async () => [
        { key: 'getEnergyFee', value: opts.energyFee ?? 420 },
        { key: 'getTransactionFee', value: opts.bandwidthFee ?? 1000 },
      ],
    },
  } as any;
}

const ok = (energyUsed = 0) => ({ result: { result: true }, energy_used: energyUsed, constant_result: ['00'] });

describe('precheck: measureTxBytes', () => {
  it('counts payload bytes plus the signature overhead', () => {
    // 8 hex chars = 4 bytes, + 67 signature bytes
    assert.equal(measureTxBytes({ raw_data_hex: 'deadbeef' }), 4 + 67);
  });

  it('throws when raw_data_hex is missing', () => {
    assert.throws(() => measureTxBytes({}), /raw_data_hex missing/);
  });
});

describe('precheck: checkContractTrigger economics', () => {
  it('blocks when the simulation reverts', async () => {
    const tw = fakeTronWeb({ sim: { result: { result: false } }, balanceSun: 1000 * SUN, availableEnergy: 1e9 });
    const r = await checkContractTrigger(tw, 'TContract', 'mint(uint256)', [{ type: 'uint256', value: '1' }], 0, 100 * SUN, 300, 'TFrom');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /Contract simulation failed/);
  });

  it('blocks when the estimated fee exceeds the fee limit', async () => {
    // energy_used 1_000_000 → needed 1_100_000; no available energy; 420 sun each
    // → ~462 TRX burn, over a 100 TRX fee limit.
    const tw = fakeTronWeb({ sim: ok(1_000_000), balanceSun: 10_000 * SUN, availableEnergy: 0 });
    const r = await checkContractTrigger(tw, 'TContract', 'borrow(uint256)', [], 0, 100 * SUN, 300, 'TFrom');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /exceeds --fee-limit/);
  });

  it('blocks when callValue + fee exceeds the TRX balance', async () => {
    // Small energy burn that fits the fee limit, but the wallet is empty.
    const tw = fakeTronWeb({ sim: ok(1000), balanceSun: 0, availableEnergy: 0 });
    const r = await checkContractTrigger(tw, 'TContract', 'repay(uint256)', [], 0, 100 * SUN, 300, 'TFrom');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /Insufficient TRX/);
  });

  it('passes with a warning when an affordable burn is required', async () => {
    const tw = fakeTronWeb({ sim: ok(1000), balanceSun: 100 * SUN, availableEnergy: 0, availableBandwidth: 0 });
    const r = await checkContractTrigger(tw, 'TContract', 'supply(uint256)', [], 0, 100 * SUN, 300, 'TFrom');
    assert.equal(r.ok, true);
    assert.ok(r.warnings && r.warnings.some(w => /Energy insufficient/.test(w)));
    assert.ok(r.warnings.some(w => /Bandwidth insufficient/.test(w)));
  });

  it('passes cleanly with no warnings when resources cover the call', async () => {
    const tw = fakeTronWeb({ sim: ok(1000), balanceSun: 100 * SUN, availableEnergy: 1e9, availableBandwidth: 1e9 });
    const r = await checkContractTrigger(tw, 'TContract', 'supply(uint256)', [], 0, 100 * SUN, 300, 'TFrom');
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
  });
});

describe('precheck: runPrecheck runner', () => {
  it('resolves when the check passes', async () => {
    setJsonMode(true);
    try {
      await runPrecheck('t', async () => ({ ok: true }));
    } finally {
      setJsonMode(false);
    }
  });

  it('throws the reason when the check fails', async () => {
    setJsonMode(true);
    try {
      await assert.rejects(() => runPrecheck('t', async () => ({ ok: false, reason: 'boom' })), /boom/);
    } finally {
      setJsonMode(false);
    }
  });

  it('propagates an error thrown by the check itself', async () => {
    setJsonMode(true);
    try {
      await assert.rejects(() => runPrecheck('t', async () => { throw new Error('network down'); }), /network down/);
    } finally {
      setJsonMode(false);
    }
  });

  it('prints affordable-burn warnings without throwing', async () => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
    try {
      await runPrecheck('t', async () => ({ ok: true, warnings: ['~1 TRX will be burned'] }));
    } finally {
      console.log = origLog;
    }
    assert.ok(out.some(line => /will be burned/.test(line)));
  });
});

describe('precheck: write-path wiring', () => {
  it('runs the preflight before confirmProceed and reuses the build', () => {
    const source = readFileSync('src/lib/tx.ts', 'utf8');
    const precheckAt = source.indexOf('runPrecheck(');
    const confirmAt = source.indexOf('confirmProceed(');
    assert.ok(precheckAt > -1 && confirmAt > -1, 'tx.ts should call both runPrecheck and confirmProceed');
    assert.ok(precheckAt < confirmAt, 'precheck must run before the user is asked to confirm');
    assert.match(source, /built = built \?\? await buildTx\(\)/);
  });

  it('is gated by opts.precheck so --no-precheck can skip it', () => {
    const source = readFileSync('src/lib/tx.ts', 'utf8');
    assert.match(source, /opts\.precheck !== false/);
  });

  it('exposes a --no-precheck global option', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    assert.match(source, /--no-precheck/);
  });
});
