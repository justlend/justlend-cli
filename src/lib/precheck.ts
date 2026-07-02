import { TronWeb } from 'tronweb';
import { triggerConstantRaw } from './tronweb.js';
import { decodeRevertData } from './revert.js';
import { utils } from './utils.js';
import { createSpinner, outputWarning } from './output.js';

type TW = InstanceType<typeof TronWeb>;

export interface CheckResult {
  ok: boolean;
  reason?: string;
  warnings?: string[];
}

// Chain defaults used only when getChainParameters omits an entry.
const DEFAULT_BANDWIDTH_FEE_SUN = 1000;
const DEFAULT_ENERGY_FEE_SUN = 420;
const SIGNATURE_BYTES = 67; // 65-byte sig + 2-byte protobuf overhead
const ENERGY_BUFFER = 1.1; // headroom over the simulated energy estimate

// Measure tx bandwidth bytes from a built (unsigned) transaction, so precheck
// estimates bandwidth against the real payload rather than a constant.
export function measureTxBytes(tx: { raw_data_hex?: string }): number {
  if (!tx.raw_data_hex) {
    throw new Error('Cannot measure tx size: raw_data_hex missing');
  }
  return tx.raw_data_hex.length / 2 + SIGNATURE_BYTES;
}

function fmt(sun: number): string {
  return `${utils.fromSun(Math.round(sun))} TRX`;
}

// -------- Chain params cache (per TronWeb instance) --------

interface FeeRates {
  energyFee: number;
  bandwidthFee: number;
}

const feeRatesCache = new WeakMap<TW, Promise<FeeRates>>();

function getFeeRates(tronWeb: TW): Promise<FeeRates> {
  const cached = feeRatesCache.get(tronWeb);
  if (cached) return cached;
  const p = (async () => {
    const params = await tronWeb.trx.getChainParameters();
    let energyFee = DEFAULT_ENERGY_FEE_SUN;
    let bandwidthFee = DEFAULT_BANDWIDTH_FEE_SUN;
    for (const entry of params as Array<{ key: string; value: number }>) {
      if (entry.key === 'getEnergyFee' && entry.value > 0) energyFee = entry.value;
      else if (entry.key === 'getTransactionFee' && entry.value > 0) bandwidthFee = entry.value;
    }
    return { energyFee, bandwidthFee };
  })();
  feeRatesCache.set(tronWeb, p);
  return p;
}

// -------- Helpers --------

interface ResourceState {
  availableEnergy: number;
  availableBandwidth: number;
}

async function getResourceState(tronWeb: TW, address: string): Promise<ResourceState> {
  const r = await tronWeb.trx.getAccountResources(address);
  return {
    availableEnergy: Math.max(0, (r.EnergyLimit || 0) - (r.EnergyUsed || 0)),
    availableBandwidth: Math.max(0, (r.NetLimit || 0) - (r.NetUsed || 0) + (r.freeNetLimit || 0) - (r.freeNetUsed || 0)),
  };
}

function estimateBandwidthFee(availableBandwidth: number, txBytes: number, feePerByte: number): number {
  const shortage = Math.max(0, txBytes - availableBandwidth);
  return shortage * feePerByte;
}

function estimateEnergyFee(availableEnergy: number, energyNeeded: number, feePerEnergy: number): number {
  const shortage = Math.max(0, energyNeeded - availableEnergy);
  return shortage * feePerEnergy;
}

function getBalanceFromAccount(acc: unknown): number {
  return (acc as { balance?: number })?.balance || 0;
}

// Inspect a triggerConstantContract response for failure. TRON marks revert
// with any of: `result.result === false`, `result.code`, or `result.message`
// (hex of a chain-level reason). On failure prefer the contract-level payload
// in `constant_result[0]` (decoded via the shared revert helper) over the
// chain message, which is often just generic "REVERT opcode executed" hex.
function detectSimulationFailure(simResult: unknown): string | null {
  const r = simResult as {
    result?: { result?: boolean; code?: string; message?: string };
    constant_result?: string[];
  };
  const failed = r.result?.result === false || !!r.result?.code || !!r.result?.message;
  if (!failed) return null;

  const decoded = decodeRevertData(r.constant_result?.[0]);
  if (decoded) return decoded;
  if (r.result?.message) {
    try { return Buffer.from(r.result.message, 'hex').toString('utf-8'); } catch { return r.result.message; }
  }
  if (r.result?.code) return r.result.code;
  return 'Contract reverted';
}

// -------- Checks --------

/**
 * Economic preflight for a contract write: simulate the call (surfacing any
 * revert reason), then verify the estimated energy + bandwidth burn fits both
 * the fee limit and the signer's TRX balance before anything is signed. Block
 * on shortfall; warn on burns that are affordable but non-zero.
 */
export async function checkContractTrigger(
  tronWeb: TW,
  contract: string,
  funcSig: string,
  typedParams: Array<{ type?: string; value: unknown }>,
  callValueSun: number,
  feeLimitSun: number,
  txBytes: number,
  from: string,
): Promise<CheckResult> {
  const options = callValueSun > 0 ? { callValue: callValueSun } : {};
  const simResult = await triggerConstantRaw(
    tronWeb,
    contract,
    funcSig,
    options,
    typedParams.map(p => ({ type: p.type ?? '', value: p.value })),
    from,
  );
  const simFail = detectSimulationFailure(simResult);
  if (simFail) return { ok: false, reason: `Contract simulation failed: ${simFail}` };

  const energyUsed = (simResult as unknown as { energy_used?: number }).energy_used || 0;
  const energyNeeded = Math.ceil(energyUsed * ENERGY_BUFFER);

  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const trxBalance = getBalanceFromAccount(acc);

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  const energyFee = estimateEnergyFee(res.availableEnergy, energyNeeded, rates.energyFee);
  const totalFee = bwFee + energyFee;
  const totalNeed = callValueSun + totalFee;

  if (totalFee > feeLimitSun) {
    return {
      ok: false,
      reason: `Estimated fee ~${fmt(totalFee)} exceeds --fee-limit ${fmt(feeLimitSun)} (energy needed ${energyNeeded}, available ${res.availableEnergy}). Raise --fee-limit or stake more TRX for energy`,
    };
  }
  if (totalNeed > trxBalance) {
    const parts: string[] = [];
    if (callValueSun > 0) parts.push(`callValue ${fmt(callValueSun)}`);
    if (totalFee > 0) parts.push(`fee ~${fmt(totalFee)}`);
    return {
      ok: false,
      reason: `Insufficient TRX: balance ${fmt(trxBalance)}, need ${fmt(totalNeed)} (${parts.join(' + ')})`,
    };
  }

  const warnings: string[] = [];
  if (energyFee > 0) warnings.push(`Energy insufficient (need ${energyNeeded}, have ${res.availableEnergy}) — ~${fmt(energyFee)} will be burned from TRX`);
  if (bwFee > 0) warnings.push(`Bandwidth insufficient — ~${fmt(bwFee)} will be burned from TRX`);
  return { ok: true, warnings };
}

// -------- Runner --------

export async function runPrecheck(
  label: string,
  check: () => Promise<CheckResult>,
): Promise<void> {
  const spinner = createSpinner(label);
  let result: CheckResult;
  try {
    result = await check();
  } catch (err) {
    spinner.fail('Precheck failed');
    throw err;
  }
  if (!result.ok) {
    spinner.fail(result.reason || 'Precheck failed');
    throw new Error(result.reason || 'Precheck failed');
  }
  spinner.succeed('Precheck passed');
  if (result.warnings?.length) {
    for (const w of result.warnings) outputWarning(w);
  }
}
