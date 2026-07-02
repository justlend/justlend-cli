/**
 * V2 Moolah Backend API client.
 *
 * P1 surface: typed wrappers for the V2 REST read endpoints listed in the CLI
 * plan. The backend evolves independently, so the concrete payloads remain
 * loose records while command-level summaries pull stable known fields.
 */
import { fetchWithContext } from '../http.js';
import { debugLog } from '../diagnostics.js';
import { getMoolahApiHost } from '../chains.js';
import type { TronNetwork } from '../types.js';

export type MoolahRecord = Record<string, unknown>;

export interface MoolahMarketSummary {
  marketId?: string;
  loanToken?: string;
  loanSymbol?: string;
  collateralToken?: string;
  collateralSymbol?: string;
  lltv?: string;
  totalSupplyAssets?: string;
  totalBorrowAssets?: string;
  borrowApy?: string;
  supplyApy?: string;
  utilization?: string;
  [k: string]: unknown;
}

export interface MoolahVaultSummary {
  vaultAddress?: string;
  address?: string;
  name?: string;
  symbol?: string;
  asset?: string;
  assetSymbol?: string;
  apy?: string;
  totalAssets?: string;
  [k: string]: unknown;
}

interface ListEnvelope<T> {
  list?: T[];
  total?: number;
  allMarkets?: T[];
  allVaults?: { list?: T[]; total?: number };
  records?: T[];
  rows?: T[];
  data?: T[];
  pageNo?: number;
  pageSize?: number;
}

function buildUrl(network: TronNetwork, path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(path, getMoolahApiHost(network));
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  debugLog('moolah.url', { network, path, host: url.origin });
  return url.toString();
}

export async function fetchMoolahJson<T>(network: TronNetwork, path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  return fetchJson<T>(buildUrl(network, path, params), {
    code: 'MOOLAH_API_FETCH_FAILED',
    module: `moolah${path}`,
    network,
    hint: `${network} Moolah backend may be unavailable or the endpoint schema may have changed.`,
  });
}

async function fetchJson<T>(url: string, context?: { code?: string; module?: string; network?: string; hint?: string }): Promise<T> {
  const res = await fetchWithContext(url, context);
  const body = await res.json() as { code?: number; data?: T; msg?: string };
  if (typeof body.code === 'number' && body.code !== 0 && body.code !== 200) {
    throw new Error(`Moolah API error ${body.code}: ${body.msg ?? 'unknown'}`);
  }
  return (body.data ?? body) as T;
}

function listFromEnvelope<T extends MoolahRecord>(env: ListEnvelope<T>): { list: T[]; total: number } {
  const list = env.list ?? env.records ?? env.rows ?? env.data ?? [];
  return { list, total: env.total ?? list.length };
}

export async function fetchMoolahMarketList(network: TronNetwork): Promise<{
  list: MoolahMarketSummary[];
  total: number;
}> {
  const env = await fetchMoolahJson<ListEnvelope<MoolahMarketSummary>>(network, '/index/market/list');
  const list = env.list ?? env.allMarkets ?? [];
  return { list, total: env.total ?? list.length };
}

export async function fetchMoolahMarketInfo(network: TronNetwork, marketId: string): Promise<MoolahRecord> {
  return fetchMoolahJson<MoolahRecord>(network, '/market/marketInfo', { marketId });
}

export async function fetchMoolahVaultList(network: TronNetwork): Promise<{
  list: MoolahVaultSummary[];
  total: number;
}> {
  const env = await fetchMoolahJson<ListEnvelope<MoolahVaultSummary>>(network, '/index/vault/list');
  const list = env.list ?? env.allVaults?.list ?? [];
  return { list, total: env.total ?? env.allVaults?.total ?? list.length };
}

export async function fetchMoolahVaultInfo(network: TronNetwork, vaultAddress: string): Promise<MoolahRecord> {
  return fetchMoolahJson<MoolahRecord>(network, '/vault/info', { address: vaultAddress });
}

export async function fetchMoolahPosition(network: TronNetwork, address: string): Promise<MoolahRecord> {
  return fetchMoolahJson<MoolahRecord>(network, '/index/position', { address });
}

export async function fetchMoolahMarketPosition(network: TronNetwork, market: string, address: string): Promise<MoolahRecord> {
  return fetchMoolahJson<MoolahRecord>(network, '/market/position', { market, address });
}

export async function fetchMoolahVaultPosition(network: TronNetwork, vaultAddress: string, address: string): Promise<MoolahRecord> {
  return fetchMoolahJson<MoolahRecord>(network, '/vault/position', { vaultAddress, address });
}

export async function fetchPendingLiquidations(network: TronNetwork): Promise<{ list: MoolahRecord[]; total: number }> {
  const env = await fetchMoolahJson<ListEnvelope<MoolahRecord>>(network, '/liquidate/pendingLiquidations');
  return listFromEnvelope(env);
}

export async function fetchLiquidationRecords(
  network: TronNetwork,
  params: { type?: string; debt?: string; collateral?: string; page?: number; pageSize?: number },
): Promise<{ list: MoolahRecord[]; total: number }> {
  const env = await fetchMoolahJson<ListEnvelope<MoolahRecord>>(network, '/liquidate/records', params);
  return listFromEnvelope(env);
}

export async function fetchMoolahHistory(
  network: TronNetwork,
  params: { userAddress: string; timeFilter?: string; pageNo?: number; pageSize?: number },
): Promise<{ list: MoolahRecord[]; total: number }> {
  const env = await fetchMoolahJson<ListEnvelope<MoolahRecord>>(network, '/index/history-records', params);
  return listFromEnvelope(env);
}
