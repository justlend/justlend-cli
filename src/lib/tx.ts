import type { Command } from 'commander';
import { getNetworkFromCommand } from './command-utils.js';
import { getTronWeb, callValueToSafeNumber, broadcastTx, waitForTxResult, validateAddress, triggerConstantRaw } from './tronweb.js';
import { decodeRevertData } from './revert.js';
import { initSigner, resolveSignerTimeout, shutdownSigner } from './signer.js';
import { getExplorerTxUrl, type TransactionResult } from './types.js';
import { utils } from './utils.js';
import { outputAction, outputResult, confirmOnChain, outputInfo, confirmProceed, outputSignedTx } from './output.js';
import { isTrustedUrl } from './trusted-url.js';
import { checkContractTrigger, measureTxBytes, runPrecheck } from './precheck.js';

type AbiItem = { type: string; name?: string; inputs?: Array<{ type: string }> };

export interface ContractTxParams {
  command: Command;
  contractAddress: string;
  abi: AbiItem[];
  functionName: string;
  args?: unknown[];
  callValue?: bigint | string | number;
  preview: Record<string, string | number | boolean | undefined>;
}

export interface TxSummaryInput {
  network: string;
  ownerAddress: string;
  contractAddress: string;
  signature: string;
  typedParams: Array<{ type?: string; value: unknown }>;
  callValue: bigint | string | number;
  feeLimitSun: number;
  broadcast: boolean;
  localBroadcast: boolean;
  mode: 'dry-run' | 'sign+broadcast';
  preview: Record<string, string | number | boolean | undefined>;
  simulationStatus: 'not-run' | 'success' | 'reverted';
}

export function buildTxSummary(input: TxSummaryInput): Record<string, unknown> {
  return {
    from: input.ownerAddress,
    network: input.network,
    contract: input.contractAddress,
    function: input.signature,
    typedArgs: input.typedParams.map(arg => ({ type: arg.type, value: arg.value })),
    callValue: input.callValue.toString(),
    feeLimitSun: input.feeLimitSun,
    broadcast: input.broadcast,
    localBroadcast: input.localBroadcast,
    mode: input.mode,
    simulationStatus: input.simulationStatus,
    ...input.preview,
  };
}

export function getFeeLimitSun(command: Command): number {
  const opts = command.optsWithGlobals();
  return Number(utils.toSun(opts.feeLimit ?? '100'));
}

/**
 * Run the contract call through `triggerconstantcontract` instead of signing
 * + broadcasting. Verifies ABI encoding, parameter types, callValue safety,
 * and surfaces any on-chain revert reason. No signer / TronLink / daemon
 * required — purely an offline parity check against the real chain state.
 */
async function dryRunContractTx(params: ContractTxParams, ownerAddress: string): Promise<TransactionResult> {
  const opts = params.command.optsWithGlobals();
  const network = getNetworkFromCommand(params.command);
  const tronWeb = getTronWeb(network);
  const functionAbi = params.abi.find(item => item.type === 'function' && item.name === params.functionName);
  if (!functionAbi) throw new Error(`Function ${params.functionName} not found in ABI`);
  const inputTypes = functionAbi.inputs?.map(input => input.type) ?? [];
  const typedParams = (params.args ?? []).map((value, index) => ({
    type: inputTypes[index],
    value: value === '__WALLET__' ? ownerAddress : value,
  }));
  const options: Record<string, unknown> = {};
  const callValue = params.callValue === undefined ? 0n : BigInt(params.callValue.toString());
  if (callValue > 0n) options.callValue = callValueToSafeNumber(callValue);
  const signature = `${params.functionName}(${inputTypes.join(',')})`;

  outputAction({ from: ownerAddress, network, contract: params.contractAddress, function: signature, mode: 'dry-run', ...params.preview });

  // TronWeb sometimes surfaces a simulated REVERT as `sim.result.result === false`,
  // sometimes by throwing a JS Error directly. Catch the throw path so dry-run
  // produces the same structured `{reverted:true}` envelope either way instead of
  // crashing out through the global error handler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sim: any;
  let thrownMessage: string | undefined;
  try {
    sim = await triggerConstantRaw(
      tronWeb,
      params.contractAddress,
      signature,
      options,
      typedParams,
      ownerAddress,
    );
  } catch (err) {
    thrownMessage = err instanceof Error ? err.message : String(err);
  }

  const simResult = sim?.result ?? {};
  const reverted = sim === undefined || simResult.result === false || Boolean(simResult.code) || Boolean(simResult.message);
  let revertReason: string | undefined;
  if (reverted) {
    if (sim?.constant_result?.length) {
      revertReason = decodeRevertData(sim.constant_result[0]) ?? undefined;
    }
    if (!revertReason && simResult.message) {
      try { revertReason = Buffer.from(simResult.message, 'hex').toString('utf-8'); } catch { revertReason = simResult.message; }
    }
    if (!revertReason && thrownMessage) {
      revertReason = thrownMessage;
    }
  }

  const built = sim?.transaction;
  const calldataHex: string | undefined = built?.raw_data?.contract?.[0]?.parameter?.value?.data;
  const energyUsed: number | undefined = sim?.energy_used;
  const selector = calldataHex?.slice(0, 8);

  const result: TransactionResult & {
    mode: 'dry-run';
    reverted: boolean;
    revertReason?: string;
    selector?: string;
    energyUsed?: number;
    calldataLen?: number;
    callValue?: string;
  } = {
    mode: 'dry-run',
    status: reverted ? 'reverted' : 'success',
    from: ownerAddress,
    reverted,
    revertReason,
    selector,
    energyUsed,
    calldataLen: calldataHex?.length,
    callValue: callValue > 0n ? callValue.toString() : undefined,
  } as any;

  outputResult(result as unknown as Record<string, unknown>, 'Dry-Run Simulation', Boolean(opts.json));
  return result as TransactionResult;
}

export async function sendContractTx(params: ContractTxParams): Promise<TransactionResult> {
  const opts = params.command.optsWithGlobals();
  // Fail fast on a malformed target contract address before any signer / simulation
  // work — callers (esp. the V2 vault/market commands) may pass user-supplied addresses.
  validateAddress(params.contractAddress, 'contract');
  const network = getNetworkFromCommand(params.command);
  const broadcast = opts.broadcast !== false;
  const localBroadcast = Boolean(opts.localBroadcast);
  const dryRun = Boolean(opts.dryRun);
  const feeLimit = getFeeLimitSun(params.command);
  const tronWeb = getTronWeb(network);
  const fullHost = process.env.JUSTLEND_FULL_HOST || (network === 'nile' ? 'https://nile.trongrid.io' : 'https://api.trongrid.io');

  if (localBroadcast && !isTrustedUrl(fullHost)) {
    throw new Error(
      'Local broadcast requires a built-in trusted fullHost endpoint (e.g. https://api.trongrid.io). ' +
      'This guard intentionally does NOT honor JUSTLEND_ALLOW_UNTRUSTED_HOSTS or --allow-untrusted-host — ' +
      'use the signer\'s default broadcast path instead, or run without --local-broadcast.',
    );
  }

  if (dryRun) {
    const owner = (opts.dryRunOwner as string | undefined)
      ?? process.env.JUSTLEND_DRY_RUN_OWNER
      ?? 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // Token Banker (well-known burnable address)
    validateAddress(owner, 'dry-run owner');
    return dryRunContractTx(params, owner);
  }

  const handle = await initSigner(opts.port);

  try {
    const connected = await handle.call('connect', { network }, resolveSignerTimeout()) as { address: string };
    const ownerAddress = connected.address;
    const functionAbi = params.abi.find(item => item.type === 'function' && item.name === params.functionName);
    if (!functionAbi) throw new Error(`Function ${params.functionName} not found in ABI`);
    const inputTypes = functionAbi.inputs?.map(input => input.type) ?? [];
    const typedParams = (params.args ?? []).map((value, index) => ({
      type: inputTypes[index],
      value: value === '__WALLET__' ? ownerAddress : value,
    }));
    const options: Record<string, unknown> = { feeLimit };
    const callValue = params.callValue === undefined ? 0n : BigInt(params.callValue.toString());
    if (callValue > 0n) options.callValue = callValueToSafeNumber(callValue);
    const signature = `${params.functionName}(${inputTypes.join(',')})`;
    const txSummary = buildTxSummary({
      network,
      ownerAddress,
      contractAddress: params.contractAddress,
      signature,
      typedParams,
      callValue,
      feeLimitSun: feeLimit,
      broadcast,
      localBroadcast,
      mode: 'sign+broadcast',
      preview: params.preview,
      simulationStatus: 'not-run',
    });

    outputAction({
      from: ownerAddress,
      network,
      contract: params.contractAddress,
      function: signature,
      mode: 'sign+broadcast',
      broadcast,
      localBroadcast,
      feeLimitSun: feeLimit,
      feeLimitTRX: opts.feeLimit ?? '100',
      callValue: callValue > 0n ? callValue.toString() : undefined,
      explorer: network === 'nile' ? 'https://nile.tronscan.org' : 'https://tronscan.org',
      ...params.preview,
    });
    outputInfo('Safety: use --dry-run first to simulate calldata without signing; use --no-broadcast to sign only.');

    const buildTx = async () => {
      const b = await tronWeb.transactionBuilder.triggerSmartContract(
        params.contractAddress,
        signature,
        options,
        typedParams,
        ownerAddress,
      );
      if (!b?.result?.result || !b.transaction) {
        throw new Error(`Failed to build transaction: ${JSON.stringify(b?.result ?? b)}`);
      }
      return b;
    };

    // Economic preflight before the user confirms or signs: simulate the call
    // (catching reverts) and confirm the estimated energy + bandwidth burn fits
    // the fee limit and TRX balance. The dry-run path returns earlier, so this
    // only guards real sign+broadcast. Build first so bandwidth is measured
    // against the real payload; reuse that build for signing.
    let built: Awaited<ReturnType<typeof buildTx>> | undefined;
    if (opts.precheck !== false) {
      built = await buildTx();
      await runPrecheck('Prechecking transaction economics', () => checkContractTrigger(
        tronWeb,
        params.contractAddress,
        signature,
        typedParams,
        callValueToSafeNumber(callValue),
        feeLimit,
        measureTxBytes(built!.transaction),
        ownerAddress,
      ));
    }

    await confirmProceed(`About to ${broadcast ? 'sign and broadcast' : 'sign without broadcasting'} a ${network} transaction.`, Boolean(opts.yes));

    built = built ?? await buildTx();

    const signed = await handle.call('signTransaction', {
      transaction: built.transaction,
      network,
      broadcast: broadcast && !localBroadcast,
      confirm: broadcast && !localBroadcast,
      txSummary,
    }, resolveSignerTimeout()) as Record<string, unknown>;

    const signedTransaction = signed.signedTransaction as Record<string, unknown> | undefined;

    if (!broadcast) {
      if (!signedTransaction) throw new Error('Signer returned no signedTransaction payload');
      const result: TransactionResult = { status: 'signed', from: ownerAddress, txId: signedTransaction.txID as string | undefined } as TransactionResult;
      outputSignedTx(signedTransaction, { dump: Boolean(opts.dumpSignedTx) });
      return result;
    }

    let txId = signed.txId as string | undefined;
    if (localBroadcast) {
      if (!signedTransaction) throw new Error('Signer returned no signedTransaction payload for local broadcast');
      txId = await broadcastTx(tronWeb, signedTransaction);
      await confirmOnChain(waitForTxResult(tronWeb, txId));
    }
    if (!txId) throw new Error('Transaction signed/broadcasted but no txId was returned');
    const result: TransactionResult = {
      status: 'success',
      txId,
      from: ownerAddress,
      explorerUrl: getExplorerTxUrl(network, txId),
    };
    outputResult(result as unknown as Record<string, unknown>, 'Transaction Submitted', Boolean(opts.json));
    return result;
  } finally {
    if (!handle.isIPC()) await shutdownSigner();
  }
}
