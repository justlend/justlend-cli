import { Command } from 'commander';
import { outputResult } from '../lib/output.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { fetchV1Markets, findV1Market } from '../lib/api/v1.js';

/**
 * P0 implementation: returns the raw `assetPrice[underlyingAddress]` value plus
 * the underlying decimals so users can see a meaningful number. Full
 * Oracle-with-API-fallback (per MCP `price.ts`) lands in P1.
 */
export function registerPriceCommand(program: Command): void {
  program
    .command('price <token>')
    .description('Query token price from JustLend backend (raw assetPrice; full Oracle fallback lands in P1)')
    .action(async function (this: Command, token: string) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const { list, assetPrice, source } = await fetchV1Markets(network);
      const row = findV1Market(list, token);
      if (!row) {
        const available = Array.from(new Set(list.map(r => r.collateralSymbol).filter(Boolean))).sort().join(', ');
        throw new Error(`Token "${token}" not found on ${network}. Available: ${available}`);
      }
      const rawPrice = row.collateralAddress
        ? assetPrice[row.collateralAddress]
        : undefined;

      outputResult({
        Token: row.collateralSymbol,
        Underlying: row.collateralAddress,
        UnderlyingDecimals: row.collateralDecimal,
        jToken: row.jtokenAddress,
        RawPrice: rawPrice ?? '(absent)',
        SupplyAPY: row.depositedAPY,
        BorrowAPY: row.borrowedAPY,
        Source: source,
        Network: network,
      }, `Price: ${row.collateralSymbol ?? token.toUpperCase()}`, !!opts.json);
    });
}
