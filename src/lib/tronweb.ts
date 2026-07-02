/**
 * Audit-hardened helpers for write-path TronWeb usage.
 * Read-only TronWeb factory lives in `clients.ts` (`getTronWeb`).
 */
import { TronWeb } from 'tronweb';

export { getTronWeb } from './clients.js';

export function validateAddress(address: string, label = 'address'): void {
  if (!TronWeb.isAddress(address)) {
    throw new Error(`Invalid TRON ${label}: "${address}"`);
  }
}

/**
 * Reject sun amounts above Number.MAX_SAFE_INTEGER (~9.007×10^15 sun ≈ 9B TRX) or negative.
 * Mirrors the v1.1.0 audit-fix guard from MCP `contracts.ts`.
 */
export function callValueToSafeNumber(callValueSun: bigint | string | number): number {
  const big = typeof callValueSun === 'bigint' ? callValueSun : BigInt(callValueSun.toString());
  if (big < 0n) {
    throw new Error(`callValue must be non-negative, got ${big.toString()}`);
  }
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `callValue ${big.toString()} sun exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
      `Use a smaller amount or a payload that doesn't require Number conversion`,
    );
  }
  return Number(big);
}

export async function broadcastTx(
  tronWeb: InstanceType<typeof TronWeb>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signedTx: any,
): Promise<string> {
  const result = await tronWeb.trx.sendRawTransaction(signedTx);
  if (result.result === false || result.code) {
    const reason = result.message
      ? Buffer.from(result.message, 'hex').toString('utf-8')
      : result.code || 'Unknown error';
    throw new Error(`Transaction broadcast failed: ${reason}`);
  }
  const txId = result.txid || result.transaction?.txID;
  if (!txId) {
    throw new Error('Transaction broadcast succeeded but no transaction ID was returned');
  }
  return txId;
}

export async function waitForTxResult(
  tronWeb: InstanceType<typeof TronWeb>,
  txId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  const toStr = (hex?: string): string => hex ? Buffer.from(hex, 'hex').toString('utf-8') : '';
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = await tronWeb.trx.getUnconfirmedTransactionInfo(txId) as any;
    if (info && (info.id || info.blockNumber)) {
      if (info.receipt?.result && info.receipt.result !== 'SUCCESS') {
        const msg = toStr(info.resMessage);
        throw new Error(`On-chain execution failed: ${info.receipt.result}${msg ? ` — ${msg}` : ''} (txId: ${txId})`);
      }
      if (info.result === 'FAILED') {
        const msg = toStr(info.resMessage) || 'unknown';
        throw new Error(`Transaction failed on-chain: ${msg} (txId: ${txId})`);
      }
      return;
    }
    // Add 0-500ms jitter so concurrent broadcasts don't pile up synchronized
    // polls against TronGrid. Math.random is fine here — not security-sensitive.
    await new Promise(r => setTimeout(r, 3_000 + Math.floor(Math.random() * 500)));
  }
  throw new Error(`Transaction not confirmed within ${timeoutMs / 1000}s: ${txId}`);
}

export interface TriggerConstantResult {
  result?: { result?: boolean; code?: string; message?: string };
  constant_result?: string[];
  energy_used?: number;
  transaction?: unknown;
}

// triggerConstantRaw reaches into TronWeb private internals
// (`transactionBuilder._getTriggerSmartContractArgs` + `fullNode.request`) that
// are NOT part of the public API and may change between releases. package.json
// pins tronweb to an exact version; this is the version that internal layout was
// verified against. If the pin is bumped, re-verify the call below and update this.
const VERIFIED_TRONWEB_VERSION = '6.2.2';

function assertTronWebInternals(tronWeb: InstanceType<typeof TronWeb>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tb = tronWeb.transactionBuilder as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const installed = (TronWeb as any).version as string | undefined;
  if (installed && installed !== VERIFIED_TRONWEB_VERSION) {
    throw new Error(
      `tronweb ${installed} is not the version triggerConstantRaw was verified against ` +
        `(${VERIFIED_TRONWEB_VERSION}). Re-verify the private-internals call in src/lib/tronweb.ts ` +
        `and update VERIFIED_TRONWEB_VERSION, or pin tronweb back to ${VERIFIED_TRONWEB_VERSION}.`,
    );
  }
  if (
    typeof tb?._getTriggerSmartContractArgs !== 'function' ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (tronWeb.fullNode as any)?.request !== 'function'
  ) {
    throw new Error(
      'tronweb private internals expected by triggerConstantRaw are missing ' +
        '(transactionBuilder._getTriggerSmartContractArgs / fullNode.request). ' +
        `Verified against tronweb ${VERIFIED_TRONWEB_VERSION}; check src/lib/tronweb.ts.`,
    );
  }
}

export async function triggerConstantRaw(
  tronWeb: InstanceType<typeof TronWeb>,
  contract: string,
  funcSig: string,
  options: {
    callValue?: number;
  },
  parameters: Array<{ type: string; value: unknown }>,
  from: string,
): Promise<TriggerConstantResult> {
  assertTronWebInternals(tronWeb);
  const opts = { ...options, _isConstant: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tb = tronWeb.transactionBuilder as any;
  const body = tb._getTriggerSmartContractArgs(
    contract,
    funcSig,
    opts,
    parameters,
    from,
    undefined,             // tokenValue
    undefined,             // tokenId
    options.callValue ?? 0,
    0,                     // feeLimit (ignored when _isConstant)
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tronWeb.fullNode as any).request(
    'wallet/triggerconstantcontract',
    body,
    'post',
  ) as Promise<TriggerConstantResult>;
}

