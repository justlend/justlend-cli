import { Command } from 'commander';
import { outputResult } from '../lib/output.js';
import { EXPLORERS, validateNetworkOption, TronNetwork } from '../lib/types.js';
import { getJustLendAddresses, getMoolahAddresses } from '../lib/chains.js';

export function registerNetworkCommand(program: Command): void {
  program
    .command('network')
    .description('Show network endpoints + JustLend contract addresses')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = validateNetworkOption(opts.network) ?? TronNetwork.Mainnet;
      const v1 = getJustLendAddresses(network);
      const v2 = getMoolahAddresses(network);

      outputResult({
        Network: network,
        FullHost: EXPLORERS[network].fullHost,
        Explorer: EXPLORERS[network].explorerUrl,
        V1_Comptroller: v1.comptroller,
        V1_PriceOracle: v1.priceOracle || '(resolved dynamically)',
        V1_Governor: v1.governorAlpha,
        V2_MoolahProxy: v2.moolahProxy,
        V2_TrxProvider: v2.trxProviderProxy,
        V2_PublicLiquidator: v2.publicLiquidatorProxy,
        V2_Oracle: v2.resilientOracleProxy,
        V2_IRM: v2.irmProxy,
        V2_WTRX: v2.wtrxProxy,
        V2_Vaults: Object.keys(v2.vaults).join(', ') || '(none)',
      }, `JustLend on ${network}`, !!opts.json);
    });
}
