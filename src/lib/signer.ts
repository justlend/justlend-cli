/**
 * Signer abstraction.
 *
 * Skeleton ported from cli-tronlink. Two paths are supported:
 *   1. IPC into a running `justlend serve` daemon (preferred — reuses the
 *      browser tab and TronLink session across commands).
 *   2. In-process `tronlink-signer` (fallback when no daemon is reachable).
 *
 * Concrete sign / connect flows are filled in alongside the corresponding
 * write commands during P2+. For P0, this module exposes the connection
 * primitives and stubs that throw a clear error if a write path is hit.
 */
import { TronSigner } from 'tronlink-signer';
import type { TronNetwork } from './types.js';
import { tryConnectIPC, type IPCClient } from './ipc.js';
import { outputInfo } from './output.js';
import { debugLog } from './diagnostics.js';

let signerInstance: TronSigner | null = null;
let ipcClient: IPCClient | null = null;

const DEFAULT_TIMEOUT = 300_000;

/**
 * Resolve the signer IPC timeout from `JUSTLEND_TIMEOUT` (in ms).
 *
 * Returns the parsed value when it is a positive integer; otherwise falls back
 * to {@link DEFAULT_TIMEOUT} and emits a one-time `signer.timeout.invalid`
 * debug log. Centralizing this guard prevents `Number(env)` from leaking `NaN`
 * into `setTimeout`, which Node treats as 1 ms — making signer requests appear
 * to time out instantly when a user accidentally sets `JUSTLEND_TIMEOUT=5s`.
 *
 * Audit 20260527 MEDIUM remediation.
 */
let warnedInvalidTimeout = false;
export function resolveSignerTimeout(): number {
  const raw = process.env.JUSTLEND_TIMEOUT;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    if (!warnedInvalidTimeout) {
      warnedInvalidTimeout = true;
      debugLog('signer.timeout.invalid', { raw, fallbackMs: DEFAULT_TIMEOUT });
    }
    return DEFAULT_TIMEOUT;
  }
  return n;
}

export function resetSignerTimeoutWarningForTests(): void {
  warnedInvalidTimeout = false;
}

export interface SignerHandle {
  /** Send an RPC-style request to the signer (IPC or in-process). */
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  isIPC(): boolean;
  shutdown(): Promise<void>;
}

export async function initSigner(port?: number): Promise<SignerHandle> {
  // 1. Try existing serve daemon
  const existing = await tryConnectIPC();
  if (existing) {
    ipcClient = existing;
    outputInfo('Connected to signer');
    return makeIPCHandle(existing);
  }

  // 2. Fall back to in-process signer (auto-spawn daemon is a P0+ extension)
  if (port) process.env.TRON_HTTP_PORT = String(port);
  if (!signerInstance) signerInstance = new TronSigner();
  await signerInstance.start();
  return makeInProcessHandle(signerInstance);
}

export async function shutdownSigner(): Promise<void> {
  if (ipcClient) {
    ipcClient.disconnect();
    ipcClient = null;
  }
  if (signerInstance) {
    try {
      await signerInstance.stop();
    } catch (err) {
      debugLog('signer.stop.failed', { error: err instanceof Error ? err.message : String(err) });
    }
    signerInstance = null;
  }
}

export async function connectWallet(network: TronNetwork): Promise<{ address: string; network: TronNetwork }> {
  const handle = await initSigner();
  const result = await handle.call('connect', { network }, DEFAULT_TIMEOUT) as {
    address: string;
    network: TronNetwork;
  };
  return result;
}

function makeIPCHandle(client: IPCClient): SignerHandle {
  return {
    call: (method, params, timeoutMs) => client.call(method, params, timeoutMs),
    isIPC: () => true,
    shutdown: async () => { client.disconnect(); },
  };
}

function makeInProcessHandle(signer: TronSigner): SignerHandle {
  return {
    call: async (method, params, _timeoutMs) => {
      return dispatchSignerCall(signer, method, params);
    },
    isIPC: () => false,
    shutdown: async () => { await signer.stop(); },
  };
}

function requireObject(value: unknown, method: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid params for "${method}": "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, method: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid params for "${method}": "${field}" must be a non-empty string`);
  }
  return value;
}

export async function dispatchSignerCall(
  signer: TronSigner,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const network = params.network as TronNetwork | undefined;
  switch (method) {
    case 'connect':
      return signer.connectWallet(network, { signal });
    case 'signTransaction':
      return signer.signTransaction(
        requireObject(params.transaction, method, 'transaction'),
        network,
        Boolean(params.broadcast),
        {
          signal,
          confirm: params.confirm !== false,
          confirmTimeoutMs: typeof params.confirmTimeoutMs === 'number' ? params.confirmTimeoutMs : undefined,
        },
      );
    case 'waitForTransaction':
      return signer.waitForTransaction(requireString(params.txId, method, 'txId'), network, {
        signal,
        timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
      });
    case 'getBalance':
      return signer.getBalance(requireString(params.address, method, 'address'), network);
    default:
      throw new Error(`Unsupported signer method: ${method}`);
  }
}
