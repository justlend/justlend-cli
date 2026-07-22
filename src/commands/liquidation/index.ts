import { Command } from 'commander';
import { fetchLiquidationRecords, fetchPendingLiquidations } from '../../lib/api/v2.js';
import { getNetworkFromCommand, parsePositiveInteger, pick, requireMoolahMainnet, shorten } from '../../lib/command-utils.js';
import { outputList } from '../../lib/output.js';
import { validateAddress } from '../../lib/tronweb.js';

export function registerLiquidationCommands(program: Command): void {
  const liquidation = program
    .command('liquidation')
    .description('V2 liquidation read commands');

  liquidation
    .command('list')
    .description('List pending V2 liquidations')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const { list, total } = await fetchPendingLiquidations(network);
      const rows = list.map(row => ({
        borrower: shorten(pick(row, ['borrower', 'user', 'account', 'address'])),
        market: shorten(pick(row, ['marketId', 'market', 'id'])),
        debt: pick(row, ['debt', 'debtAmount', 'borrowAssets', 'borrowed']),
        collateral: pick(row, ['collateral', 'collateralAmount', 'collateralAssets']),
        health: pick(row, ['healthFactor', 'health', 'liquidity']),
      }));
      outputList(rows, `V2 Pending Liquidations (${total} total)`, !!opts.json);
    });

  liquidation
    .command('records')
    .description('List V2 historical liquidation records')
    .option('--type <type>', 'Record type filter')
    .option('--debt <token>', 'Debt token filter')
    .option('--collateral <token>', 'Collateral token filter')
    .option('--page <n>', 'Page number', parsePositiveInteger, 1)
    .option('--page-size <n>', 'Page size', parsePositiveInteger, 20)
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const local = this.opts();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      if (local.debt) validateAddress(local.debt, 'debt token');
      if (local.collateral) validateAddress(local.collateral, 'collateral token');
      const { list, total } = await fetchLiquidationRecords(network, {
        type: local.type,
        debt: local.debt,
        collateral: local.collateral,
        page: local.page,
        pageSize: local.pageSize,
      });
      const rows = list.map(row => ({
        time: pick(row, ['time', 'timestamp', 'blockTime', 'createdAt']),
        liquidator: shorten(pick(row, ['liquidator', 'caller'])),
        borrower: shorten(pick(row, ['borrower', 'user', 'account'])),
        debt: pick(row, ['debt', 'debtAmount', 'repayAmount']),
        collateral: pick(row, ['collateral', 'collateralAmount', 'seizedAmount']),
        tx: shorten(pick(row, ['txId', 'txHash', 'transactionHash'])),
      }));
      outputList(rows, `V2 Liquidation Records (${total} total)`, !!opts.json);
    });
}
