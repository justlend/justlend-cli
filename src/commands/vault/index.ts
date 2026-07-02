import { Command } from 'commander';
import { MOOLAH_VAULT_ABI, TRX_PROVIDER_ABI } from '../../lib/abis.js';
import { outputList, outputResult } from '../../lib/output.js';
import { fetchMoolahVaultInfo, fetchMoolahVaultList } from '../../lib/api/v2.js';
import { getNetworkFromCommand, requireMoolahMainnet, shorten } from '../../lib/command-utils.js';
import { getMoolahAddresses } from '../../lib/chains.js';
import { sendContractTx } from '../../lib/tx.js';
import { utils } from '../../lib/utils.js';
import { vaultAssetDecimals } from '../../lib/moolah.js';
import { validateAddress } from '../../lib/tronweb.js';

export function registerVaultCommands(program: Command): void {
  const vault = program
    .command('vault')
    .description('JustLend V2 (Moolah) ERC4626 vault commands');

  vault
    .command('list')
    .description('List all V2 Moolah vaults')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const { list, total } = await fetchMoolahVaultList(network);
      const rows = list.map(v => ({
        vault: v.vaultAddress ?? v.address,
        symbol: v.symbol,
        asset: v.assetSymbol ?? v.asset,
        apy: v.apy,
        totalAssets: v.totalAssets,
      }));
      outputList(rows, `V2 Moolah Vaults (${total} total)`, !!opts.json);
    });

  vault
    .command('info <vaultAddress>')
    .description('Show V2 vault details')
    .action(async function (this: Command, vaultAddress: string) {
      validateAddress(vaultAddress);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      requireMoolahMainnet(network);
      const info = await fetchMoolahVaultInfo(network, vaultAddress);
      outputResult(info, `V2 Vault ${shorten(vaultAddress)}`, !!opts.json);
    });

  vault
    .command('deposit <vaultAddress> <amount>')
    .description('Deposit into a Moolah vault')
    .action(async function (this: Command, vaultAddress: string, amount: string) {
      validateAddress(vaultAddress);
      const network = getNetworkFromCommand(this);
      const { decimals, isTrx } = await vaultAssetDecimals(network, vaultAddress);
      const raw = utils.parseUnits(amount, decimals);
      if (isTrx) {
        const moolah = getMoolahAddresses(network);
        await sendContractTx({ command: this, contractAddress: moolah.trxProviderProxy, abi: TRX_PROVIDER_ABI, functionName: 'deposit', args: [vaultAddress, '__WALLET__'], callValue: raw, preview: { action: 'V2 vault deposit TRX', vault: vaultAddress, amount } });
        return;
      }
      await sendContractTx({ command: this, contractAddress: vaultAddress, abi: MOOLAH_VAULT_ABI, functionName: 'deposit', args: [raw.toString(), '__WALLET__'], preview: { action: 'V2 vault deposit', vault: vaultAddress, amount } });
    });

  vault
    .command('redeem <vaultAddress> <amount>')
    .description('Redeem shares from a Moolah vault')
    .action(async function (this: Command, vaultAddress: string, amount: string) {
      validateAddress(vaultAddress);
      const network = getNetworkFromCommand(this);
      const { decimals, isTrx } = await vaultAssetDecimals(network, vaultAddress);
      const raw = utils.parseUnits(amount, decimals);
      if (isTrx) {
        const moolah = getMoolahAddresses(network);
        await sendContractTx({ command: this, contractAddress: moolah.trxProviderProxy, abi: TRX_PROVIDER_ABI, functionName: 'redeem', args: [vaultAddress, raw.toString(), '__WALLET__', '__WALLET__'], preview: { action: 'V2 vault redeem TRX shares', vault: vaultAddress, amount } });
        return;
      }
      await sendContractTx({ command: this, contractAddress: vaultAddress, abi: MOOLAH_VAULT_ABI, functionName: 'redeem', args: [raw.toString(), '__WALLET__', '__WALLET__'], preview: { action: 'V2 vault redeem shares', vault: vaultAddress, amount } });
    });
}
