import { getApiHost } from '../chains.js';
import { fetchWithContext, HttpRequestError } from '../http.js';
import type { TronNetwork } from '../types.js';
import { fetchV1MarketsOnChain } from '../v1-onchain.js';

export interface V1MarketRow {
  jtokenAddress?: string;
  jtokenDecimal?: number;
  collateralSymbol?: string;
  collateralAddress?: string;
  collateralDecimal?: number;
  collateralName?: string;
  depositedAPY?: string;
  borrowedAPY?: string;
  totalDeposited?: string;
  totalBorrowed?: string;
  cash?: string;
  [key: string]: unknown;
}

export interface V1MarketsResult {
  list: V1MarketRow[];
  assetPrice: Record<string, string>;
  source: string;
  warning?: string;
  backendError?: unknown;
}

interface MarketsResponse {
  code?: number;
  data?: {
    jtokenList?: V1MarketRow[];
    assetPrice?: Record<string, string>;
  };
  message?: string;
}

function isFallbackEligible(error: unknown): boolean {
  return error instanceof HttpRequestError || error instanceof Error;
}

async function fetchV1MarketsFromBackend(network: TronNetwork): Promise<V1MarketsResult> {
  const source = `${getApiHost(network)}/justlend/markets`;
  const url = new URL(source);
  const res = await fetchWithContext(source, {
    code: 'V1_MARKETS_FETCH_FAILED',
    module: 'v1.market.list',
    network,
    host: url.origin,
    path: url.pathname,
    idempotent: true,
    hint: `${network} V1 market backend may be unavailable; retry later or use on-chain reads if available.`,
  });
  const body = await res.json() as MarketsResponse;
  if (typeof body.code === 'number' && body.code !== 0 && body.code !== 200) {
    throw new Error(`Markets API error ${body.code}: ${body.message ?? 'unknown'}`);
  }
  return {
    list: body.data?.jtokenList ?? [],
    assetPrice: body.data?.assetPrice ?? {},
    source,
  };
}

export async function fetchV1Markets(network: TronNetwork): Promise<V1MarketsResult> {
  try {
    return await fetchV1MarketsFromBackend(network);
  } catch (error) {
    if (!isFallbackEligible(error)) throw error;
    return fetchV1MarketsOnChain(network, error);
  }
}

export function findV1Market(list: V1MarketRow[], token: string): V1MarketRow | undefined {
  const wanted = token.toUpperCase();
  return list.find(row => row.collateralSymbol?.toUpperCase() === wanted || row.jtokenAddress?.toUpperCase() === wanted);
}
