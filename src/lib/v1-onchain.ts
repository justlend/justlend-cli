import { COMPTROLLER_ABI, JTOKEN_ABI, PRICE_ORACLE_ABI } from './abis.js';
import { JUSTLEND_ADDRESSES, type JTokenInfo } from './chains.js';
import { getTronWeb } from './tronweb.js';
import type { TronNetwork } from './types.js';
import { utils } from './utils.js';
import type { V1MarketRow } from './api/v1.js';
import { optionalRead, warningFields } from './optional-read.js';

const TRON_BLOCKS_PER_YEAR = 365 * 24 * 60 * 60 / 3;
const MANTISSA_SCALE = 1e18;
const EXCHANGE_RATE_SCALE = 18;

export interface V1OnChainMarketResult {
  list: V1MarketRow[];
  assetPrice: Record<string, string>;
  source: string;
  warning?: string;
  backendError?: unknown;
  warnings?: string[];
  partialFailure?: true;
}

function stringifyCallValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return stringifyCallValue(value[0]);
  const maybe = value as { toString?: () => string };
  return maybe.toString?.() ?? String(value);
}

function formatRaw(value: unknown, decimals: number): string | undefined {
  const raw = stringifyCallValue(value);
  if (!raw) return undefined;
  try {
    return utils.formatUnits(BigInt(raw), decimals);
  } catch {
    return raw;
  }
}

export function estimateApy(ratePerBlockRaw: unknown): string | undefined {
  const raw = stringifyCallValue(ratePerBlockRaw);
  if (!raw) return undefined;
  let rawBig: bigint;
  try {
    rawBig = BigInt(raw);
  } catch {
    return undefined;
  }
  if (rawBig < BigInt(0) || rawBig > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const rate = Number(rawBig) / MANTISSA_SCALE;
  if (!Number.isFinite(rate) || rate < 0) return undefined;
  const apy = (Math.pow(1 + rate, TRON_BLOCKS_PER_YEAR) - 1) * 100;
  if (!Number.isFinite(apy)) return undefined;
  return apy.toFixed(6);
}

export const estimateApyForTest = estimateApy;

function depositedTotal(totalSupplyRaw: unknown, exchangeRateRaw: unknown, underlyingDecimals: number): string | undefined {
  const supply = stringifyCallValue(totalSupplyRaw);
  const rate = stringifyCallValue(exchangeRateRaw);
  if (!supply || !rate) return undefined;
  try {
    const decimals = EXCHANGE_RATE_SCALE + underlyingDecimals - 8;
    const denominator = pow10(decimals);
    const raw = BigInt(supply) * BigInt(rate) / denominator;
    return utils.formatUnits(raw, underlyingDecimals);
  } catch {
    return undefined;
  }
}

function pow10(exp: number): bigint {
  let value = BigInt(1);
  for (let i = 0; i < exp; i += 1) value *= BigInt(10);
  return value;
}

function byAddress(markets: JTokenInfo[]): Map<string, JTokenInfo> {
  const map = new Map<string, JTokenInfo>();
  for (const item of markets) map.set(item.address.toLowerCase(), item);
  return map;
}

function serializeBackendError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error instanceof Error ? error.message : error;
  const record = error as Record<string, unknown>;
  return {
    name: record.name,
    message: record.message,
    code: record.code,
    module: record.module,
    network: record.network,
    host: record.host,
    path: record.path,
    status: record.status,
    hint: record.hint,
  };
}

export async function fetchV1MarketsOnChain(network: TronNetwork, backendError?: unknown): Promise<V1OnChainMarketResult> {
  const cfg = JUSTLEND_ADDRESSES[network];
  const tronWeb = getTronWeb(network);
  const configuredMarkets = Object.values(cfg.jTokens);
  const configuredByAddress = byAddress(configuredMarkets);
  const comptroller = tronWeb.contract(COMPTROLLER_ABI as any, cfg.comptroller) as any;
  const warningSink = { warnings: [] as string[] };

  const onChainAddresses = await optionalRead<string[]>('v1.comptroller.getAllMarkets', warningSink, () => comptroller.methods.getAllMarkets().call());
  const marketAddresses = Array.from(new Set([
    ...(onChainAddresses ?? []),
    ...configuredMarkets.map(item => item.address),
  ].filter(Boolean)));

  const oracleAddress = cfg.priceOracle || await optionalRead<string>('v1.comptroller.oracle', warningSink, () => comptroller.methods.oracle().call()) || '';
  const oracle = oracleAddress ? tronWeb.contract(PRICE_ORACLE_ABI as any, oracleAddress) as any : undefined;
  const assetPrice: Record<string, string> = {};
  const rows: V1MarketRow[] = [];

  for (const address of marketAddresses) {
    const known = configuredByAddress.get(address.toLowerCase());
    const contract = tronWeb.contract(JTOKEN_ABI as any, address) as any;
    const [symbol, name, jDecimals, totalSupply, totalBorrows, cash, exchangeRate, supplyRate, borrowRate, underlying, price] = await Promise.all([
      optionalRead<string>(`jToken(${address}).symbol`, warningSink, () => contract.methods.symbol().call()),
      optionalRead<string>(`jToken(${address}).name`, warningSink, () => contract.methods.name().call()),
      optionalRead<string>(`jToken(${address}).decimals`, warningSink, () => contract.methods.decimals().call()),
      optionalRead<string>(`jToken(${address}).totalSupply`, warningSink, () => contract.methods.totalSupply().call()),
      optionalRead<string>(`jToken(${address}).totalBorrows`, warningSink, () => contract.methods.totalBorrows().call()),
      optionalRead<string>(`jToken(${address}).getCash`, warningSink, () => contract.methods.getCash().call()),
      optionalRead<string>(`jToken(${address}).exchangeRateStored`, warningSink, () => contract.methods.exchangeRateStored().call()),
      optionalRead<string>(`jToken(${address}).supplyRatePerBlock`, warningSink, () => contract.methods.supplyRatePerBlock().call()),
      optionalRead<string>(`jToken(${address}).borrowRatePerBlock`, warningSink, () => contract.methods.borrowRatePerBlock().call()),
      known?.underlying ? optionalRead<string>(`jToken(${address}).underlying`, warningSink, () => contract.methods.underlying().call()) : Promise.resolve(known?.underlying ?? ''),
      oracle ? optionalRead<string>(`priceOracle.getUnderlyingPrice(${address})`, warningSink, () => oracle.methods.getUnderlyingPrice(address).call()) : Promise.resolve(undefined),
    ]);

    const jtokenDecimal = Number(stringifyCallValue(jDecimals) ?? known?.decimals ?? 8);
    const collateralAddress = known?.underlying ?? stringifyCallValue(underlying) ?? '';
    const collateralDecimal = known?.underlyingDecimals ?? 6;
    const rawPrice = stringifyCallValue(price);
    if (rawPrice && collateralAddress) assetPrice[collateralAddress] = rawPrice;

    rows.push({
      jtokenAddress: address,
      jtokenDecimal,
      collateralSymbol: known?.underlyingSymbol ?? (String(symbol ?? '').replace(/^j/i, '') || undefined),
      collateralAddress,
      collateralDecimal,
      collateralName: known?.underlyingSymbol ?? stringifyCallValue(name),
      depositedAPY: estimateApy(supplyRate),
      borrowedAPY: estimateApy(borrowRate),
      totalDeposited: depositedTotal(totalSupply, exchangeRate, collateralDecimal),
      totalBorrowed: formatRaw(totalBorrows, collateralDecimal),
      depositedTotal: depositedTotal(totalSupply, exchangeRate, collateralDecimal),
      borrowedTotal: formatRaw(totalBorrows, collateralDecimal),
      totalSupply: formatRaw(totalSupply, jtokenDecimal),
      totalBorrows: formatRaw(totalBorrows, collateralDecimal),
      cash: formatRaw(cash, collateralDecimal),
      source: 'onchain-fallback',
      priceOracle: oracleAddress || undefined,
      rawPrice,
    });
  }

  if (rows.length === 0) {
    throw new Error(`V1 market backend unavailable and on-chain fallback returned no markets for ${network}`);
  }

  rows.sort((a, b) => String(a.collateralSymbol ?? '').localeCompare(String(b.collateralSymbol ?? '')));
  return {
    list: rows,
    assetPrice,
    source: `onchain:${cfg.comptroller}`,
    warning: `V1 backend unavailable; using on-chain fallback. APYs are estimated from per-block rates.`,
    backendError: serializeBackendError(backendError),
    ...warningFields(warningSink),
  };
}
