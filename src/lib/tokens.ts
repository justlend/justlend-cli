import { getAllJTokens } from "./chains.js";
import { getTronWeb } from "./clients.js";
import { promiseWithTimeout } from "./http.js";
import { utils } from "./utils.js";
import { TRC20_ABI } from "./abis.js";

const MAX_TRC20_DECIMALS = 38;

/**
 * Validate a token `decimals()` value read from an (untrusted) contract before
 * it is used to scale amounts via `utils.formatUnits` / `utils.parseUnits`.
 *
 * Shares the exact guard used by `resolveTrc20Decimals`: any malformed or
 * malicious response (non-integer, negative, `NaN`/`Infinity`, or an absurd
 * value > MAX_TRC20_DECIMALS) is rejected with a clear error so callers never
 * scale by `NaN` or end up doing `padStart(NaN + 1, ...)` inside `formatUnits`.
 */
function assertValidDecimals(raw: unknown, tokenAddress: string): number {
  const n = normalizeDecimalsValue(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_TRC20_DECIMALS) {
    throw new Error(
      `Token ${tokenAddress} returned invalid decimals: ${String(raw)}. ` +
      `Must be an integer between 0 and ${MAX_TRC20_DECIMALS}.`,
    );
  }
  return n;
}

function normalizeDecimalsValue(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (raw && typeof raw === "object" && "_hex" in (raw as Record<string, unknown>)) {
    try {
      return Number(BigInt((raw as { _hex: string })._hex).toString());
    } catch {
      return NaN;
    }
  }
  if (raw && typeof raw === "object" && typeof (raw as { toString?: () => string }).toString === "function") {
    const text = (raw as { toString: () => string }).toString();
    return Number(text);
  }
  return Number(raw);
}

/**
 * Resolve and validate a TRC20 token's decimals.
 *
 * Accepts an optional override (e.g. from a `--decimals` flag) and, when absent,
 * reads `decimals()` from the token contract. The return value is always an
 * integer in `[0, MAX_TRC20_DECIMALS]`; any malformed/malicious contract response
 * is rejected with a clear error so callers never end up scaling user amounts by
 * `NaN`, `Infinity`, or absurd values like 10^100.
 *
 * This is the shared defense lifted out of the `sun.ts` LP-token approve path
 * (audit 20260527 HIGH).
 */
export async function resolveTrc20Decimals(
  network: string,
  tokenAddress: string,
  override?: string | number,
): Promise<number> {
  if (override !== undefined && override !== null && override !== "") {
    const n = typeof override === "number" ? override : Number(override);
    if (!Number.isInteger(n) || n < 0 || n > MAX_TRC20_DECIMALS) {
      throw new Error(`Invalid --decimals "${override}": must be an integer between 0 and ${MAX_TRC20_DECIMALS}`);
    }
    return n;
  }
  const tronWeb = getTronWeb(network);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = tronWeb.contract(TRC20_ABI as any, tokenAddress) as any;
  const raw = await contract.methods.decimals().call();
  try {
    return assertValidDecimals(raw, tokenAddress);
  } catch {
    throw new Error(
      `Token ${tokenAddress} returned invalid decimals: ${String(raw)}. ` +
      `Pass --decimals <0..${MAX_TRC20_DECIMALS}> to override.`,
    );
  }
}

export interface ResolvedKnownToken {
  input: string;
  address: string;
  symbol: string;
  /**
   * Token decimals. `null` when the token was resolved by raw address and is
   * not in the known-token registry — callers MUST fetch real decimals from
   * the contract before scaling user amounts (use `getTRC20TokenInfo`).
   */
  decimals: number | null;
  resolution: "symbol" | "address";
}

function normalizeTokenSymbol(symbol: string): string {
  return symbol.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveKnownToken(tokenOrAddress: string, network = "mainnet"): ResolvedKnownToken | null {
  const input = tokenOrAddress.trim();
  if (!input) return null;

  if (utils.isAddress(input)) {
    return {
      input,
      address: input,
      symbol: input,
      decimals: null,
      resolution: "address",
    };
  }

  const normalizedInput = normalizeTokenSymbol(input);
  const resolvedByAddress = new Map<string, ResolvedKnownToken>();

  for (const token of getAllJTokens(network)) {
    if (!token.underlying) continue;

    const candidateKeys = new Set([
      normalizeTokenSymbol(token.underlyingSymbol),
      normalizeTokenSymbol(token.symbol),
      normalizeTokenSymbol(token.symbol.replace(/^j/i, "")),
    ]);
    if (!candidateKeys.has(normalizedInput)) continue;

    resolvedByAddress.set(token.underlying.toLowerCase(), {
      input,
      address: token.underlying,
      symbol: token.underlyingSymbol,
      decimals: token.underlyingDecimals,
      resolution: "symbol",
    });
  }

  if (resolvedByAddress.size === 1) {
    return Array.from(resolvedByAddress.values())[0];
  }

  return null;
}

/**
 * Get TRC20 token metadata (name, symbol, decimals, totalSupply).
 */
export async function getTRC20TokenInfo(
  tokenAddress: string,
  network = "mainnet",
): Promise<{
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  formattedTotalSupply: string;
}> {
  const tronWeb = getTronWeb(network);

  try {
    const contract: any = await promiseWithTimeout(
      tronWeb.contract().at(tokenAddress),
      undefined,
      "Timed out while loading TRC20 token contract",
    );

    const [name, symbol, decimals, totalSupply] = await promiseWithTimeout(Promise.all([
      contract.methods.name().call(),
      contract.methods.symbol().call(),
      contract.methods.decimals().call(),
      contract.methods.totalSupply().call(),
    ]), undefined, "Timed out while reading TRC20 token metadata");

    const decimalsNum = assertValidDecimals(decimals, tokenAddress);
    const totalSupplyBigInt = BigInt(totalSupply.toString());
    const formattedTotalSupply = utils.formatUnits(totalSupplyBigInt, decimalsNum);

    return {
      name: String(name),
      symbol: String(symbol),
      decimals: decimalsNum,
      totalSupply: totalSupplyBigInt,
      formattedTotalSupply,
    };
  } catch (error: any) {
    throw new Error(`Failed to get TRC20 token info: ${error.message}`);
  }
}

/**
 * Get TRC721 (NFT) token metadata for a specific tokenId.
 */
export async function getTRC721TokenMetadata(
  tokenAddress: string,
  tokenId: bigint,
  network = "mainnet",
): Promise<{ name: string; symbol: string; tokenURI: string }> {
  const tronWeb = getTronWeb(network);

  try {
    const contract: any = await promiseWithTimeout(
      tronWeb.contract().at(tokenAddress),
      undefined,
      "Timed out while loading TRC721 token contract",
    );

    const [name, symbol, tokenURI] = await promiseWithTimeout(Promise.all([
      contract.methods.name().call(),
      contract.methods.symbol().call(),
      contract.methods.tokenURI(tokenId.toString()).call(),
    ]), undefined, "Timed out while reading TRC721 token metadata");

    return { name: String(name), symbol: String(symbol), tokenURI: String(tokenURI) };
  } catch (error: any) {
    throw new Error(`Failed to get TRC721 metadata: ${error.message}`);
  }
}

/**
 * Get the URI for a TRC1155 token ID.
 */
export async function getTRC1155TokenURI(
  tokenAddress: string,
  tokenId: bigint,
  network = "mainnet",
): Promise<string> {
  const tronWeb = getTronWeb(network);

  try {
    const contract: any = await promiseWithTimeout(
      tronWeb.contract().at(tokenAddress),
      undefined,
      "Timed out while loading TRC1155 token contract",
    );
    const uri = await promiseWithTimeout(
      contract.methods.uri(tokenId.toString()).call(),
      undefined,
      "Timed out while reading TRC1155 token URI",
    );
    return String(uri);
  } catch (error: any) {
    throw new Error(`Failed to get TRC1155 URI: ${error.message}`);
  }
}
