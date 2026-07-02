import { Command } from 'commander';
import { fetchMoolahMarketPosition, fetchMoolahPosition, fetchMoolahVaultPosition } from '../../lib/api/v2.js';
import { getNetworkFromCommand, requireMoolahMainnet, shorten } from '../../lib/command-utils.js';
import { outputResult } from '../../lib/output.js';
import { validateAddress } from '../../lib/tronweb.js';

export function registerPositionCommands(program: Command): void {
  const position = program
    .command('position')
    .description('V2 user position read commands');

  position
    .command('overview <address>', { isDefault: true })
    .description('Show V2 user portfolio overview')
    .action(async function (this: Command, address: string) {
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const data = await fetchMoolahPosition(network, address);
      outputResult(data, `V2 Position ${shorten(address)}`, !!opts.json);
    });

  position
    .command('market <marketId> <address>')
    .description('Show user position in a V2 market')
    .action(async function (this: Command, marketId: string, address: string) {
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const data = await fetchMoolahMarketPosition(network, marketId, address);
      outputResult(data, `V2 Market Position ${shorten(marketId)}`, !!opts.json);
    });

  position
    .command('vault <vaultAddress> <address>')
    .description('Show user position in a V2 vault')
    .action(async function (this: Command, vaultAddress: string, address: string) {
      validateAddress(vaultAddress);
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const data = await fetchMoolahVaultPosition(network, vaultAddress, address);
      outputResult(data, `V2 Vault Position ${shorten(vaultAddress)}`, !!opts.json);
    });
}
