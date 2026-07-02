import { MOOLAH_CORE_ABI, MOOLAH_VAULT_ABI, TRC20_ABI } from './abis.js';
import { getMoolahAddresses, type VaultInfo } from './chains.js';
import type { TronNetwork } from './types.js';
import { getTronWeb } from './clients.js';
import { utils } from './utils.js';
import { toBase58Address } from './address.js';
import { formatReadError } from './optional-read.js';

export interface MarketParamsTuple {
  loanToken: string;       // Base58
  collateralToken: string; // Base58
  oracle: string;          // Base58
  irm: string;             // Base58
  lltv: string;            // decimal string (×1e18)
}

function decimalFallbackWarning(label: string, fallback: number, error: unknown): string {
  return `${label} failed: ${formatReadError(error)}; using fallback decimals=${fallback}`;
}

/** Normalize whatever TronWeb hands back into a Base58 TRON address. */
function asBase58(value: unknown): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (str.startsWith('T')) return str;
  return toBase58Address(str);
}

export async function getMarketParams(network: TronNetwork, marketId: string): Promise<MarketParamsTuple> {
  const moolah = getMoolahAddresses(network);
  const contract = getTronWeb(network).contract(MOOLAH_CORE_ABI as any, moolah.moolahProxy) as any;
  const raw = await contract.methods.idToMarketParams(marketId).call();
  // TronWeb may wrap or flatten — handle both
  const p = (raw && typeof raw === 'object' && !raw.loanToken && (raw.marketParams ?? raw[0]))
    ? (raw.marketParams ?? raw[0])
    : raw;
  return {
    loanToken:       asBase58(p?.loanToken       ?? p?.[0]),
    collateralToken: asBase58(p?.collateralToken ?? p?.[1]),
    oracle:          asBase58(p?.oracle          ?? p?.[2]),
    irm:             asBase58(p?.irm             ?? p?.[3]),
    lltv:            (p?.lltv ?? p?.[4]).toString(),
  };
}

export async function tokenDecimals(network: TronNetwork, token: string, fallback = 6): Promise<number> {
  if (!token) return 6;
  const contract = getTronWeb(network).contract(TRC20_ABI as any, token) as any;
  let raw: unknown;
  try {
    raw = await contract.methods.decimals().call();
  } catch (error) {
    console.warn(decimalFallbackWarning(`tokenDecimals(${token})`, fallback, error));
    raw = fallback;
  }
  const decimals = Number(String(raw));
  // Bound to a sane TRC20 range [0, 38]; a malformed/malicious token reporting e.g.
  // 255 would otherwise scale amounts by 10^255. Out-of-range falls back like non-integer.
  if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 38) return decimals;
  console.warn(`tokenDecimals(${token}) returned invalid value ${String(raw)}; using fallback decimals=${fallback}`);
  return fallback;
}

/**
 * Resolve `marketId` to (params, side decimals, side-is-TRX flag) for one of the two market sides.
 *
 * V2 markets that quote/loan TRX wrap WTRX on-chain; writes must route through
 * TrxProviderProxy with `callValue` carrying the native TRX amount. This helper
 * decides whether the loan/collateral side is the TRX side by comparing the
 * resolved address against `wtrxProxy` for the active network.
 */
export async function resolveMoolahSide(network: TronNetwork, marketId: string, side: 'loan' | 'collateral'): Promise<{
  params: MarketParamsTuple;
  decimals: number;
  isTrx: boolean;
  sideToken: string;
}> {
  const { wtrxProxy } = getMoolahAddresses(network);
  const params = await getMarketParams(network, marketId);
  const sideToken = side === 'loan' ? params.loanToken : params.collateralToken;
  const isTrx = sideToken === wtrxProxy;
  const decimals = isTrx ? 6 : await tokenDecimals(network, sideToken, 6);
  return { params, decimals, isTrx, sideToken };
}

export async function parseMoolahLoanAmount(network: TronNetwork, marketId: string, amount: string): Promise<{ params: MarketParamsTuple; raw: bigint; decimals: number; isTrx: boolean }> {
  const r = await resolveMoolahSide(network, marketId, 'loan');
  return { params: r.params, raw: utils.parseUnits(amount, r.decimals), decimals: r.decimals, isTrx: r.isTrx };
}

export async function parseMoolahCollateralAmount(network: TronNetwork, marketId: string, amount: string): Promise<{ params: MarketParamsTuple; raw: bigint; decimals: number; isTrx: boolean }> {
  const r = await resolveMoolahSide(network, marketId, 'collateral');
  return { params: r.params, raw: utils.parseUnits(amount, r.decimals), decimals: r.decimals, isTrx: r.isTrx };
}

/**
 * Validate liquidate-amount inputs: exactly one of seizedAssets / repaidShares
 * must be a non-empty, non-zero value. Pure / no I/O — easy to unit test.
 * @returns which mode was chosen
 */
export function selectLiquidateMode(seizedAssets: string | undefined, repaidShares: string | undefined): 'seized' | 'shares' {
  const haveSeized = seizedAssets !== undefined && seizedAssets !== '0' && seizedAssets !== '';
  const haveShares = repaidShares !== undefined && repaidShares !== '0' && repaidShares !== '';
  if (haveSeized && haveShares) {
    throw new Error('Provide EITHER --seized-assets OR --repaid-shares, not both.');
  }
  if (!haveSeized && !haveShares) {
    throw new Error('Provide one of --seized-assets or --repaid-shares (with non-zero amount).');
  }
  return haveSeized ? 'seized' : 'shares';
}

export function findVaultByAddress(network: TronNetwork, vaultAddress: string): VaultInfo | undefined {
  const moolah = getMoolahAddresses(network);
  return Object.values(moolah.vaults).find(vault => vault.address === vaultAddress);
}

/**
 * Decode V2 vault asset/share metadata. Returns:
 *   - underlyingDecimals: precision for asset amounts (deposit / withdraw input)
 *   - sharesDecimals:     precision for share amounts (redeem input)
 *   - isTrx:              vault wraps native TRX (use TrxProviderProxy path)
 *
 * For known vaults the data comes from the registry; for unknown vaults we
 * fall back to TRC20 decimals on the underlying asset and 18 decimals for
 * shares (Moolah ERC4626 default, matches MCP behaviour).
 */
export async function vaultAssetDecimals(network: TronNetwork, vaultAddress: string): Promise<{
  decimals: number;          // alias for underlyingDecimals (back-compat)
  underlyingDecimals: number;
  sharesDecimals: number;
  isTrx: boolean;
}> {
  const known = findVaultByAddress(network, vaultAddress);
  if (known) {
    return {
      decimals: known.underlyingDecimals,
      underlyingDecimals: known.underlyingDecimals,
      sharesDecimals: known.sharesDecimals,
      isTrx: !known.underlying,
    };
  }
  const vault = getTronWeb(network).contract(MOOLAH_VAULT_ABI as any, vaultAddress) as any;
  let asset: unknown;
  try {
    asset = await vault.methods.asset?.().call?.();
  } catch (error) {
    console.warn(decimalFallbackWarning(`vaultAssetDecimals(${vaultAddress}).asset`, 6, error));
  }
  const underlyingDecimals = asset ? await tokenDecimals(network, String(asset), 6) : 6;
  return { decimals: underlyingDecimals, underlyingDecimals, sharesDecimals: 18, isTrx: false };
}
