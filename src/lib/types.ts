/**
 * Re-exports the canonical `TronNetwork` enum from chains.ts and adds
 * CLI-specific helpers (explorer URLs, command context, validators).
 *
 * Note: JustLend V1/V2 only runs on mainnet + nile, so shasta is not supported.
 */
import { TronNetwork, NETWORKS } from './chains.js';
export { TronNetwork } from './chains.js';

export type ResourceType = 'ENERGY' | 'BANDWIDTH';

export interface TransactionResult {
  status: 'success' | 'signed';
  txId?: string;
  from: string;
  explorerUrl?: string;
  signedTransaction?: Record<string, unknown>;
}

export interface CommandContext {
  address: string;
  network: TronNetwork;
  broadcast: boolean;
  json: boolean;
}

export const EXPLORERS: Record<TronNetwork, { fullHost: string; explorerUrl: string }> = {
  [TronNetwork.Mainnet]: {
    fullHost: NETWORKS[TronNetwork.Mainnet].fullNode,
    explorerUrl: NETWORKS[TronNetwork.Mainnet].explorer,
  },
  [TronNetwork.Nile]: {
    fullHost: NETWORKS[TronNetwork.Nile].fullNode,
    explorerUrl: NETWORKS[TronNetwork.Nile].explorer,
  },
};

export function validateNetworkOption(network?: string): TronNetwork | undefined {
  if (!network) return undefined;
  const lower = network.toLowerCase();
  if (lower === TronNetwork.Mainnet) return TronNetwork.Mainnet;
  if (lower === TronNetwork.Nile) return TronNetwork.Nile;
  throw new Error(`Invalid network: "${network}". JustLend supports only mainnet or nile`);
}

export function getExplorerTxUrl(network: TronNetwork, txId: string): string {
  return `${EXPLORERS[network].explorerUrl}/#/transaction/${txId}`;
}
