import { Command } from 'commander';
import { TRC20_ABI } from '../lib/abis.js';
import { outputList, outputResult } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { getTronWeb, validateAddress } from '../lib/tronweb.js';
import { utils } from '../lib/utils.js';
import { optionalRead, warningFields } from '../lib/optional-read.js';
import { MAX_UINT256, resolveApprovalAmount } from '../lib/approval.js';
import { getNetworkFromCommand, parseNonNegativeInteger } from '../lib/command-utils.js';
import { TronNetwork } from '../lib/types.js';
import { resolveTrc20Decimals } from '../lib/tokens.js';

async function resolveLpDecimals(network: TronNetwork, lpToken: string, override?: string): Promise<number> {
  return resolveTrc20Decimals(network, lpToken, override);
}

const SUN_POOL_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'pid' }, { type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'pid' }, { type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'pid' }], outputs: [] },
  { type: 'function', name: 'pendingSun', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'pid' }, { type: 'address', name: 'user' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'userInfo', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'pid' }, { type: 'address', name: 'user' }], outputs: [{ type: 'uint256', name: 'amount' }, { type: 'uint256', name: 'rewardDebt' }] },
  { type: 'function', name: 'poolInfo', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'pid' }], outputs: [
      { type: 'address', name: 'lpToken' },
      { type: 'uint256', name: 'allocPoint' },
      { type: 'uint256', name: 'lastRewardBlock' },
      { type: 'uint256', name: 'accSunPerShare' },
    ] },
  { type: 'function', name: 'poolLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

/**
 * Best-effort registry of SUN mining pool contracts the CLI knows about.
 *
 * NOTE: SUN/JustLend has shipped many pool contracts over the years. This
 * registry is intentionally small — only contracts whose ABI is known to match
 * the MasterChef-style `SUN_POOL_ABI` above. Add new pools here as they are
 * confirmed against front-app `pool.js` or on-chain bytecode.
 */
interface SunPoolEntry extends Record<string, unknown> {
  name: string;
  address: string;
  rewardToken: string;
  description: string;
}

/**
 * Static SUN mining pool registry — sourced from
 *   /Users/tron/Object/trontech/front-app/src/config.js (`activeSwaps: ['jstlp1']`)
 *
 * front-app currently ships only ONE active LP pool (`jstlp1` — SUNSWAP JST-TRX LP).
 * Older yielder pools and pool/poly aggregators exist in `front-app` but are not
 * MasterChef-style (they don't expose `poolInfo`/`pendingSun`), so we don't list
 * them here — calling `sun info` on them returns empty without crashing, but a
 * `sun list` entry would imply MasterChef semantics they don't have.
 *
 * Reward token for `jstlp1` is JST (`giftKey: ['jst']` in front-app config),
 * not SUN — the command/family name "sun" is historical.
 */
const SUN_POOL_REGISTRY: Record<TronNetwork, SunPoolEntry[]> = {
  [TronNetwork.Mainnet]: [
    {
      name: 'jstlp1',
      address: 'TUp1BWfAZidkNbWkoiCjJcf4ctE4PAR2Rg',
      rewardToken: 'JST',
      description: 'JustLend JST-TRX SUNSWAP LP staking (front-app activeSwaps default)',
    },
  ],
  [TronNetwork.Nile]: [
    {
      name: 'jstlp1',
      address: 'TMXkqc9RtGa3KB3Sx46bmrdTy9Xgi2cmTu',
      rewardToken: 'JST',
      description: 'JustLend JST-TRX SUNSWAP LP staking (Nile testnet, front-app activeSwaps default)',
    },
  ],
};

// JustLend confirmed (2026-05): the only currently-active mining surface is the V1
// USDD market via the V1 mining reward distributor (read via `rewards summary <address>`).
// The `sun` MasterChef-style pools registered below — including `jstlp1` — are
// historical / no longer active in production. The command family is retained for
// compatibility with legacy scripts and on-chain reads, but is flagged "legacy" in
// help and runtime output so callers don't mistake `sun claim` for USDD mining.
const SUN_LEGACY_NOTE = 'SUN pool family is legacy: JustLend\'s only active mining today is V1 USDD market mining — use `rewards summary <address>` to read it and `rewards claim` to claim. `sun deposit/withdraw/claim` is NOT the USDD mining entry.';

export function registerSunCommands(program: Command): void {
  const sun = program
    .command('sun')
    .description('[legacy] SUN MasterChef-style LP staking pools — no active pools in production; see `rewards`');

  sun.command('list')
    .description('[legacy] List known SUN mining pool contracts (no active pools in production)')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const rows = SUN_POOL_REGISTRY[network];
      if (rows.length === 0) {
        outputResult({
          network,
          status: 'legacy',
          legacyNote: SUN_LEGACY_NOTE,
          note: 'No SUN pool contracts bundled. Pass <pool> directly to sun deposit/withdraw/claim if you really need the legacy path.',
        }, 'SUN Pool Registry', Boolean(opts.json));
        return;
      }
      outputList(
        rows.map(row => ({ ...row, status: 'legacy' })),
        `SUN Pools (${network}) [legacy]`,
        Boolean(opts.json),
        { warning: SUN_LEGACY_NOTE },
      );
    });

  sun.command('info <pool>')
    .description('Inspect a SUN mining pool contract (pool length + total allocPoint)')
    .action(async function (this: Command, pool: string) {
      validateAddress(pool, 'pool');
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const tronWeb = getTronWeb(network);
      const contract = tronWeb.contract(SUN_POOL_ABI as any, pool) as any;
      const warningSink = { warnings: [] as string[] };
      const poolLength = await optionalRead<string>(`sun.poolLength(${pool})`, warningSink, () => contract.methods.poolLength().call());
      const lengthNumber = poolLength === undefined ? 0 : Number(poolLength.toString());
      const pools: Record<string, unknown>[] = [];
      for (let pid = 0; pid < Math.min(lengthNumber, 50); pid++) {
        const info = await optionalRead<any>(`sun.poolInfo(${pool}, ${pid})`, warningSink, () => contract.methods.poolInfo(pid).call()) as any;
        if (!info) {
          warningSink.warnings.push(`sun.poolInfo(${pool}, ${pid}) missing; stopping pool scan early`);
          break;
        }
        pools.push({
          pid,
          lpToken: info?.lpToken ?? info?.[0],
          allocPoint: (info?.allocPoint ?? info?.[1])?.toString?.(),
          lastRewardBlock: (info?.lastRewardBlock ?? info?.[2])?.toString?.(),
        });
      }
      outputResult({
        pool,
        network,
        poolLength: lengthNumber,
        pools,
        ...warningFields(warningSink),
      }, 'SUN Pool Info', Boolean(opts.json));
    });

  sun.command('position <pool> <pid> <address>')
    .description('Show SUN mining pool position for a configurable pool contract')
    .action(async function (this: Command, pool: string, pid: string, address: string) {
      validateAddress(pool, 'pool');
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const tronWeb = getTronWeb(network);
      const contract = tronWeb.contract(SUN_POOL_ABI as any, pool) as any;
      const warningSink = { warnings: [] as string[] };
      const [userInfo, pendingSun] = await Promise.all([
        optionalRead<any>(`sun.userInfo(${pool}, ${pid}, ${address})`, warningSink, () => contract.methods.userInfo(pid, address).call()),
        optionalRead<any>(`sun.pendingSun(${pool}, ${pid}, ${address})`, warningSink, () => contract.methods.pendingSun(pid, address).call()),
      ]);
      outputResult({
        pool,
        pid,
        address,
        stakedRaw: userInfo?.amount?.toString?.() ?? userInfo?.[0]?.toString?.(),
        pendingSunRaw: pendingSun?.toString?.(),
        ...warningFields(warningSink),
      }, 'SUN Pool Position', Boolean(opts.json));
    });

  sun.command('approve <lpToken> <spender> [amount]')
    .description('Approve a SUN pool to spend LP token (decimals auto-detected, override with --decimals)')
    .option('--decimals <n>', 'LP token decimals override (defaults to on-chain decimals())')
    .option('--unlimited', 'Explicitly approve MAX_UINT256 allowance')
    .option('--max', 'Alias for --unlimited')
    .action(async function (this: Command, lpToken: string, spender: string, amount?: string) {
      validateAddress(lpToken, 'LP token');
      validateAddress(spender, 'spender');
      const opts = this.opts();
      const network = getNetworkFromCommand(this);
      // For unlimited/MAX approval the raw value is MAX_UINT256 and decimals are irrelevant
      // (resolveApprovalAmount returns early), so skip the on-chain decimals resolution and the
      // previously-unvalidated `Number(opts.decimals ?? 18)` (which could silently produce NaN).
      const decimals = amount === undefined || amount === MAX_UINT256
        ? 0
        : await resolveLpDecimals(network, lpToken, opts.decimals);
      const raw = resolveApprovalAmount(amount ?? MAX_UINT256, decimals, Boolean(opts.unlimited || opts.max));
      await sendContractTx({
        command: this,
        contractAddress: lpToken,
        abi: TRC20_ABI,
        functionName: 'approve',
        args: [spender, raw.toString()],
        preview: { action: 'approve SUN LP', amount: amount ?? (opts.unlimited || opts.max ? 'max' : undefined), spender },
      });
    });

  sun.command('deposit <pool> <lpToken> <pid> <amount>')
    .description('Deposit LP token into a SUN mining pool (decimals auto-detected from <lpToken>)')
    .option('--decimals <n>', 'LP token decimals override (defaults to on-chain decimals())')
    .action(async function (this: Command, pool: string, lpToken: string, pid: string, amount: string) {
      validateAddress(pool, 'pool');
      validateAddress(lpToken, 'LP token');
      const pidNum = parseNonNegativeInteger(pid);
      const opts = this.opts();
      const network = getNetworkFromCommand(this);
      const decimals = await resolveLpDecimals(network, lpToken, opts.decimals);
      const raw = utils.parseUnits(amount, decimals);
      await sendContractTx({
        command: this,
        contractAddress: pool,
        abi: SUN_POOL_ABI,
        functionName: 'deposit',
        args: [pidNum, raw.toString()],
        preview: { action: 'SUN pool deposit', pool, pid, amount, decimals: String(decimals) },
      });
    });

  sun.command('withdraw <pool> <lpToken> <pid> <amount>')
    .description('Withdraw LP token from a SUN mining pool (decimals auto-detected from <lpToken>)')
    .option('--decimals <n>', 'LP token decimals override (defaults to on-chain decimals())')
    .action(async function (this: Command, pool: string, lpToken: string, pid: string, amount: string) {
      validateAddress(pool, 'pool');
      validateAddress(lpToken, 'LP token');
      const pidNum = parseNonNegativeInteger(pid);
      const opts = this.opts();
      const network = getNetworkFromCommand(this);
      const decimals = await resolveLpDecimals(network, lpToken, opts.decimals);
      const raw = utils.parseUnits(amount, decimals);
      await sendContractTx({
        command: this,
        contractAddress: pool,
        abi: SUN_POOL_ABI,
        functionName: 'withdraw',
        args: [pidNum, raw.toString()],
        preview: { action: 'SUN pool withdraw', pool, pid, amount, decimals: String(decimals) },
      });
    });

  sun.command('claim <pool> <pid>')
    .description('Claim SUN mining rewards')
    .action(async function (this: Command, pool: string, pid: string) {
      validateAddress(pool, 'pool');
      const pidNum = parseNonNegativeInteger(pid);
      await sendContractTx({
        command: this,
        contractAddress: pool,
        abi: SUN_POOL_ABI,
        functionName: 'claim',
        args: [pidNum],
        preview: { action: 'SUN pool claim', pool, pid },
      });
    });
}
