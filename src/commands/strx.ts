import { Command } from 'commander';
import { STRX_ABI } from '../lib/abis.js';
import { JUSTLEND_ADDRESSES } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { outputResult } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { getTronWeb, validateAddress } from '../lib/tronweb.js';
import { utils } from '../lib/utils.js';
import { optionalRead, warningFields } from '../lib/optional-read.js';

function formatSun(value: unknown): string {
  return utils.formatUnits(BigInt(value?.toString?.() ?? String(value ?? 0)), 6);
}

export function registerStrxCommands(program: Command): void {
  const strx = program.command('strx').description('sTRX liquid staking commands');

  strx.command('info').description('Show sTRX dashboard').action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].strx;
    const tronWeb = getTronWeb(network);
    const contract = tronWeb.contract(STRX_ABI as any, cfg.proxy) as any;
    const warningSink = { warnings: [] as string[] };
    const [totalSupply, totalUnderlying, exchangeRate, totalUnfreezable, delayDays] = await Promise.all([
      contract.methods.totalSupply().call(),
      optionalRead('strx.totalUnderlying', warningSink, () => contract.methods.totalUnderlying().call()),
      optionalRead('strx.exchangeRate', warningSink, () => contract.methods.exchangeRate().call()),
      optionalRead('strx.totalUnfreezable', warningSink, () => contract.methods.totalUnfreezable().call()),
      optionalRead('strx.getUnfreezeDelayDays', warningSink, () => contract.methods.getUnfreezeDelayDays().call()),
    ]);
    outputResult({
      network,
      strx: cfg.proxy,
      market: cfg.market,
      totalSupply: formatSun(totalSupply),
      totalUnderlyingTRX: totalUnderlying === undefined ? undefined : formatSun(totalUnderlying),
      exchangeRate: exchangeRate?.toString?.(),
      totalUnfreezableTRX: totalUnfreezable === undefined ? undefined : formatSun(totalUnfreezable),
      unfreezeDelayDays: delayDays?.toString?.(),
      ...warningFields(warningSink),
    }, 'sTRX Overview', Boolean(opts.json));
  });

  strx.command('position <address>').description('Show user sTRX position').action(async function (this: Command, address: string) {
    validateAddress(address);
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].strx;
    const tronWeb = getTronWeb(network);
    const contract = tronWeb.contract(STRX_ABI as any, cfg.proxy) as any;
    const warningSink = { warnings: [] as string[] };
    const [balance, underlying] = await Promise.all([
      contract.methods.balanceOf(address).call(),
      optionalRead('strx.viewBalanceOfUnderlying', warningSink, () => contract.methods.viewBalanceOfUnderlying(address).call()),
    ]);
    outputResult({
      address,
      network,
      sTRX: formatSun(balance),
      underlyingTRX: underlying === undefined ? undefined : formatSun(underlying),
      ...warningFields(warningSink),
    }, 'sTRX Position', Boolean(opts.json));
  });

  strx.command('stake <amount>').description('Stake TRX to mint sTRX').action(async function (this: Command, amount: string) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].strx;
    const raw = utils.toSun(amount);
    await sendContractTx({
      command: this,
      contractAddress: cfg.proxy,
      abi: STRX_ABI,
      functionName: 'deposit',
      callValue: raw,
      preview: { action: 'stake TRX to sTRX', amount: `${amount} TRX` },
    });
  });

  strx.command('unstake <amount>').description('Unstake sTRX').action(async function (this: Command, amount: string) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].strx;
    const raw = utils.toSun(amount);
    await sendContractTx({
      command: this,
      contractAddress: cfg.proxy,
      abi: STRX_ABI,
      functionName: 'withdraw',
      args: [raw.toString()],
      preview: { action: 'unstake sTRX', amount: `${amount} sTRX` },
    });
  });

  // NOTE: There is intentionally no separate `strx withdraw` command.
  //
  // The JustLend sTRX proxy exposes only three write methods:
  //   - `deposit()`           → `strx stake`   (TRX → sTRX, payable)
  //   - `withdraw(uint256)`   → `strx unstake` (burn sTRX, enter unfreeze queue)
  //   - `claimAll()`          → `strx claim`   (claim accrued staking rewards)
  //
  // After `strx unstake`, the underlying TRX is released by the TRON protocol's
  // WithdrawExpireUnfreeze mechanism (operates at network resource layer, not
  // via a contract call). Verified against front-app `system.jsx::strWithdraw`
  // — `withdraw(uint256)` is what the dApp calls "unstake", no second step.
  //
  // We register a stub that explains this clearly rather than failing silently.
  strx.command('withdraw')
    .description('Deprecated alias — sTRX has no separate withdraw step; see notes')
    .action(async () => {
      throw new Error(
        'sTRX has no contract-level "withdraw unlocked TRX" call. After `strx unstake`, ' +
        'the TRX is released automatically by TRON\'s WithdrawExpireUnfreeze (protocol-level, ' +
        'not via the sTRX proxy). Use `strx claim` for staking rewards, or watch your TRX ' +
        'balance after the unfreeze period.'
      );
    });

  strx.command('claim').description('Claim sTRX staking rewards').action(async function (this: Command) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].strx;
    await sendContractTx({
      command: this,
      contractAddress: cfg.proxy,
      abi: STRX_ABI,
      functionName: 'claimAll',
      preview: { action: 'claim sTRX rewards' },
    });
  });
}
