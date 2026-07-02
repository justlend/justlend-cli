import { Command } from 'commander';
import { MOOLAH_CORE_ABI, PUBLIC_LIQUIDATOR_ABI, TRC20_ABI, TRX_PROVIDER_ABI } from '../lib/abis.js';
import { getMoolahAddresses } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { parseMoolahCollateralAmount, parseMoolahLoanAmount, selectLiquidateMode } from '../lib/moolah.js';
import { sendContractTx } from '../lib/tx.js';
import { validateAddress } from '../lib/tronweb.js';
import { utils } from '../lib/utils.js';
import { MAX_UINT256, resolveApprovalAmount } from '../lib/approval.js';
import { resolveTrc20Decimals } from '../lib/tokens.js';

/**
 * V2 (Moolah) write commands.
 *
 * Two write paths exist for every loan/collateral op:
 *   - TRC20 side  → MoolahProxy + MOOLAH_CORE_ABI (no callValue)
 *   - native TRX  → TrxProviderProxy + TRX_PROVIDER_ABI (callValue = sun amount; supply/repay only)
 *
 * The router is `parseMoolahLoanAmount` / `parseMoolahCollateralAmount`, which
 * resolves `marketParams` and flags `isTrx` when the active side equals
 * `wtrxProxy` for the network. Mirrors the MCP v1.1.0 reference implementation.
 */
export function registerMoolahWriteCommands(program: Command): void {
  // ── supply (loan side) ──────────────────────────────────────────────────────
  program.command('supply <marketId> <amount>').description('V2 supply loan asset (TRX routes through TrxProvider)').action(async function (this: Command, marketId: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const { moolahProxy } = getMoolahAddresses(network);
    const { params, raw, isTrx } = await parseMoolahLoanAmount(network, marketId, amount);
    const preview = { action: 'V2 supply', marketId, amount, asset: isTrx ? 'TRX' : params.loanToken };
    if (isTrx) {
      // TrxProvider.supply doesn't exist in the public ABI — Moolah V2 only exposes
      // TrxProvider for supplyCollateral/withdrawCollateral/borrow/repay/deposit/withdraw/redeem.
      // Pure TRX *supply* (loan side) isn't supported on the native-TRX path; error early.
      throw new Error('Native TRX supply (loan side) is not supported by TrxProviderProxy. Wrap to WTRX first or use a TRC20 market.');
    }
    await sendContractTx({ command: this, contractAddress: moolahProxy, abi: MOOLAH_CORE_ABI, functionName: 'supply', args: [params, raw.toString(), '0', '__WALLET__', '0x'], preview });
  });

  // ── withdraw (loan side) ────────────────────────────────────────────────────
  program.command('withdraw <marketId> <amount>').description('V2 withdraw supplied loan asset').action(async function (this: Command, marketId: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const { moolahProxy } = getMoolahAddresses(network);
    const { params, raw } = await parseMoolahLoanAmount(network, marketId, amount);
    await sendContractTx({ command: this, contractAddress: moolahProxy, abi: MOOLAH_CORE_ABI, functionName: 'withdraw', args: [params, raw.toString(), '0', '__WALLET__', '__WALLET__'], preview: { action: 'V2 withdraw', marketId, amount } });
  });

  // ── borrow (loan side) ──────────────────────────────────────────────────────
  program.command('borrow <marketId> <amount>').description('V2 borrow loan asset (TRX routes through TrxProvider)').action(async function (this: Command, marketId: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const { moolahProxy, trxProviderProxy } = getMoolahAddresses(network);
    const { params, raw, isTrx } = await parseMoolahLoanAmount(network, marketId, amount);
    const contract = isTrx ? trxProviderProxy : moolahProxy;
    const abi = isTrx ? TRX_PROVIDER_ABI : MOOLAH_CORE_ABI;
    await sendContractTx({ command: this, contractAddress: contract, abi, functionName: 'borrow', args: [params, raw.toString(), '0', '__WALLET__', '__WALLET__'], preview: { action: 'V2 borrow', marketId, amount, asset: isTrx ? 'TRX' : params.loanToken } });
  });

  // ── repay (loan side) ───────────────────────────────────────────────────────
  program.command('repay <marketId> <amount>').description('V2 repay loan asset (TRX routes through TrxProvider with callValue)').action(async function (this: Command, marketId: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const { moolahProxy, trxProviderProxy } = getMoolahAddresses(network);
    const { params, raw, isTrx } = await parseMoolahLoanAmount(network, marketId, amount);
    const contract = isTrx ? trxProviderProxy : moolahProxy;
    const abi = isTrx ? TRX_PROVIDER_ABI : MOOLAH_CORE_ABI;
    await sendContractTx({
      command: this,
      contractAddress: contract,
      abi,
      functionName: 'repay',
      args: [params, raw.toString(), '0', '__WALLET__', '0x'],
      callValue: isTrx ? raw : undefined,
      preview: { action: 'V2 repay', marketId, amount, asset: isTrx ? 'TRX' : params.loanToken },
    });
  });

  // ── collateral ──────────────────────────────────────────────────────────────
  const collateral = program.command('collateral').description('V2 collateral commands');
  collateral.command('supply <marketId> <amount>').description('V2 supply collateral (TRX routes through TrxProvider with callValue)').action(async function (this: Command, marketId: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const { moolahProxy, trxProviderProxy } = getMoolahAddresses(network);
    const { params, raw, isTrx } = await parseMoolahCollateralAmount(network, marketId, amount);
    if (isTrx) {
      // TRX collateral path: TrxProvider.supplyCollateral(marketParams, onBehalf, data) — value carried by callValue
      await sendContractTx({
        command: this,
        contractAddress: trxProviderProxy,
        abi: TRX_PROVIDER_ABI,
        functionName: 'supplyCollateral',
        args: [params, '__WALLET__', '0x'],
        callValue: raw,
        preview: { action: 'V2 supply collateral', marketId, amount, asset: 'TRX' },
      });
      return;
    }
    await sendContractTx({ command: this, contractAddress: moolahProxy, abi: MOOLAH_CORE_ABI, functionName: 'supplyCollateral', args: [params, raw.toString(), '__WALLET__', '0x'], preview: { action: 'V2 supply collateral', marketId, amount } });
  });
  collateral.command('withdraw <marketId> <amount>').description('V2 withdraw collateral').action(async function (this: Command, marketId: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const { moolahProxy, trxProviderProxy } = getMoolahAddresses(network);
    const { params, raw, isTrx } = await parseMoolahCollateralAmount(network, marketId, amount);
    const contract = isTrx ? trxProviderProxy : moolahProxy;
    const abi = isTrx ? TRX_PROVIDER_ABI : MOOLAH_CORE_ABI;
    const preview: Record<string, string> = { action: 'V2 withdraw collateral', marketId, amount };
    if (isTrx) preview.asset = 'TRX';
    await sendContractTx({ command: this, contractAddress: contract, abi, functionName: 'withdrawCollateral', args: [params, raw.toString(), '__WALLET__', '__WALLET__'], preview });
  });

  // ── liquidate ───────────────────────────────────────────────────────────────
  //
  // The on-chain `liquidate(bytes32 marketId, address borrower, uint256 seizedAssets, uint256 repaidShares)`
  // takes EXACTLY ONE non-zero amount and the other side must be 0. Old behaviour
  // collapsed both into a single positional and silently treated it as repaidShares,
  // which is wrong when the user actually wants to seize a specific collateral amount.
  //
  // New contract:
  //   - `--seized-assets <amount>`  → liquidate by collateral amount (parsed with collateral decimals)
  //   - `--repaid-shares <amount>`  → liquidate by repay-shares amount (always 18 decimals, internal share unit)
  //   - exactly one of the two must be provided (mutually exclusive, non-zero)
  program
    .command('liquidate <marketId> <borrower>')
    .description('V2 liquidate. Supply EXACTLY ONE of --seized-assets or --repaid-shares.')
    .option('--seized-assets <amount>', 'Collateral amount to seize (parsed with collateral token decimals)')
    .option('--repaid-shares <amount>', 'Borrow shares to repay (18-decimal share unit)')
    .action(async function (this: Command, marketId: string, borrower: string) {
      validateAddress(borrower);
      const local = this.opts();
      const network = getNetworkFromCommand(this);
      const { publicLiquidatorProxy } = getMoolahAddresses(network);
      const seized = local.seizedAssets as string | undefined;
      const shares = local.repaidShares as string | undefined;
      const mode = selectLiquidateMode(seized, shares);
      let seizedRaw = '0';
      let sharesRaw = '0';
      let preview: Record<string, string>;
      if (mode === 'seized') {
        const { decimals } = await parseMoolahCollateralAmount(network, marketId, seized!);
        seizedRaw = utils.parseUnits(seized!, decimals).toString();
        preview = { action: 'V2 liquidate', marketId, borrower, seizedAssets: seized! };
      } else {
        // Shares are always 18 decimals (Moolah uses 1e18 share precision internally).
        sharesRaw = utils.parseUnits(shares!, 18).toString();
        preview = { action: 'V2 liquidate', marketId, borrower, repaidShares: shares! };
      }
      await sendContractTx({
        command: this,
        contractAddress: publicLiquidatorProxy,
        abi: PUBLIC_LIQUIDATOR_ABI,
        functionName: 'liquidate',
        args: [marketId, borrower, seizedRaw, sharesRaw],
        preview,
      });
    });
}

export function registerLegacyApproveAlias(program: Command): void {
  program.command('approve-v2 <token> <spender> [amount]')
    .description('Approve TRC20 for V2 integrations')
    .option('--decimals <n>', 'Token decimals override (defaults to on-chain decimals())')
    .option('--unlimited', 'Explicitly approve MAX_UINT256 allowance')
    .option('--max', 'Alias for --unlimited')
    .action(async function (this: Command, token: string, spender: string, amount?: string) {
      validateAddress(token);
      validateAddress(spender);
      const opts = this.opts();
      const network = getNetworkFromCommand(this);
      const allowUnlimited = Boolean(opts.unlimited || opts.max);
      const amountLabel = amount === 'max' ? MAX_UINT256 : amount;
      // For the unlimited/MAX branch resolveApprovalAmount returns early and never
      // scales by decimals, so skip the (otherwise unvalidated) on-chain read there.
      // For a finite amount, reuse the shared resolveTrc20Decimals guard (validates
      // integer + [0,38], honours --decimals override) — same as `approve`.
      const decimals = amountLabel === undefined || amountLabel === MAX_UINT256
        ? 0
        : await resolveTrc20Decimals(network, token, opts.decimals);
      const raw = resolveApprovalAmount(amountLabel, decimals, allowUnlimited);
      await sendContractTx({
        command: this,
        contractAddress: token,
        abi: TRC20_ABI,
        functionName: 'approve',
        args: [spender, raw.toString()],
        preview: { action: 'approve-v2', token, spender, amount: amount ?? (allowUnlimited ? 'max' : undefined) },
      });
    });
}
