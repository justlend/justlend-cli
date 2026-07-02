import { Command } from 'commander';
import { fetchMoolahPosition } from '../lib/api/v2.js';
import { JUSTLEND_ADDRESSES } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { outputResult } from '../lib/output.js';
import { getTronWeb, validateAddress } from '../lib/tronweb.js';
import { COMPTROLLER_ABI } from '../lib/abis.js';
import { optionalRead, warningFields } from '../lib/optional-read.js';

export function registerAdvancedCommands(program: Command): void {
  program.command('simulate <command...>').description('Explain how to dry-run a planned transaction').action(async function (this: Command, command: string[]) {
    const opts = this.optsWithGlobals();
    outputResult({
      status: 'manual_simulation_required',
      command: command.join(' '),
      note: 'Use --no-broadcast on write commands to build/sign without broadcasting. Full triggerconstantcontract simulation is still pending per-command integration.',
    }, 'Simulation', Boolean(opts.json));
  });

  program.command('watch <address>').description('Show current position health snapshot').action(async function (this: Command, address: string) {
    validateAddress(address);
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const tronWeb = getTronWeb(network);
    const comptroller = tronWeb.contract(COMPTROLLER_ABI as any, cfg.comptroller) as any;
    const warningSink = { warnings: [] as string[] };
    const v1Liquidity = await optionalRead<any>('advanced.v1.getAccountLiquidity', warningSink, () => comptroller.methods.getAccountLiquidity(address).call());
    let v2Position: unknown;
    if (network === 'mainnet') {
      v2Position = await fetchMoolahPosition(network, address).catch(error => ({ error: error.message }));
    }
    outputResult({
      address,
      network,
      v1LiquidityRaw: (v1Liquidity?.liquidity ?? v1Liquidity?.[1])?.toString?.(),
      v1ShortfallRaw: (v1Liquidity?.shortfall ?? v1Liquidity?.[2])?.toString?.(),
      v2Position,
      ...warningFields(warningSink),
      note: 'This is a one-shot health snapshot; continuous polling can be wrapped by shell watch.',
    }, 'Position Health', Boolean(opts.json));
  });

  program.command('portfolio <address>').description('Cross-module portfolio overview').action(async function (this: Command, address: string) {
    validateAddress(address);
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const tronWeb = getTronWeb(network);
    const warningSink = { warnings: [] as string[] };
    const [trxBalance, v2Position] = await Promise.all([
      optionalRead('advanced.trx.getBalance', warningSink, () => tronWeb.trx.getBalance(address)),
      network === 'mainnet' ? fetchMoolahPosition(network, address).catch(error => ({ error: error.message })) : Promise.resolve(undefined),
    ]);
    outputResult({
      address,
      network,
      trxBalanceSun: trxBalance?.toString?.() ?? trxBalance,
      v1MarketsConfigured: Object.keys(cfg.jTokens).length,
      v2Position,
      stusdt: cfg.stUSDT,
      strx: cfg.strx,
      ...warningFields(warningSink),
    }, 'Portfolio Overview', Boolean(opts.json));
  });
}
