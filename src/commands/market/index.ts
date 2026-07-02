import { Command } from 'commander';
import { outputList, outputResult } from '../../lib/output.js';
import { fetchMoolahMarketInfo, fetchMoolahMarketList } from '../../lib/api/v2.js';
import { getNetworkFromCommand, requireMoolahMainnet, shorten } from '../../lib/command-utils.js';

export function registerMarketCommands(program: Command): void {
  const market = program
    .command('market')
    .description('JustLend V2 (Moolah) market commands');

  market
    .command('list')
    .description('List all V2 Moolah lending markets')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const { list, total } = await fetchMoolahMarketList(network);
      const rows = list.map(m => ({
        marketId: shorten(m.marketId),
        loan: m.loanSymbol ?? shorten(m.loanToken),
        collateral: m.collateralSymbol ?? shorten(m.collateralToken),
        lltv: m.lltv,
        supplyAPY: m.supplyApy,
        borrowAPY: m.borrowApy,
        utilization: m.utilization,
      }));
      if (opts.json) {
        outputList(rows, '', true);
        return;
      }
      outputList(rows, `V2 Moolah Markets (${total} total)`, false);
    });

  market
    .command('info <marketId>')
    .description('Show details for a single V2 market')
    .action(async function (this: Command, marketId: string) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const info = await fetchMoolahMarketInfo(network, marketId);
      outputResult(info, `V2 Market ${shorten(marketId)}`, !!opts.json);
    });
}
