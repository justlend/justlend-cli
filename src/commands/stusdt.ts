import { Command } from 'commander';
import { TRC20_ABI } from '../lib/abis.js';
import { JUSTLEND_ADDRESSES } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { outputResult } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { getTronWeb, validateAddress } from '../lib/tronweb.js';
import { utils } from '../lib/utils.js';
import { optionalRead, warningFields } from '../lib/optional-read.js';

import { MAX_UINT256, resolveApprovalAmount } from '../lib/approval.js';

const STUSDT_MINTER_ABI = [
  { type: 'function', name: 'submit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'amount' }], outputs: [{ type: 'uint256' }] },
];

const STUSDT_UNSTAKER_ABI = [
  { type: 'function', name: 'requestWithdrawal', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'amount' }], outputs: [] },
  { type: 'function', name: 'claimWithdrawals', stateMutability: 'nonpayable', inputs: [{ type: 'uint256[]', name: 'requestIds' }], outputs: [] },
];

const WSTUSDT_ABI = [
  ...TRC20_ABI,
  { type: 'function', name: 'wrap',   stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'stUSDTAmount' }],  outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unwrap', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'wstUSDTAmount' }], outputs: [{ type: 'uint256' }] },
];

export function registerStusdtCommands(program: Command): void {
  const stusdt = program.command('stusdt').description('stUSDT / wstUSDT staking commands');

  stusdt.command('info').description('Show stUSDT contract overview').action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
    const tronWeb = getTronWeb(network);
    const contract = tronWeb.contract(TRC20_ABI as any, cfg.stUsdt) as any;
    const wst = tronWeb.contract(TRC20_ABI as any, cfg.wstUsdt) as any;
    const warningSink = { warnings: [] as string[] };
    const [totalSupply, wstTotalSupply] = await Promise.all([
      contract.methods.totalSupply().call(),
      optionalRead<unknown>('wstUSDT.totalSupply', warningSink, () => wst.methods.totalSupply().call()),
    ]);
    outputResult({
      network,
      stUSDT: cfg.stUsdt,
      wstUSDT: cfg.wstUsdt,
      USDT: cfg.usdt,
      minter: cfg.minter,
      unstaker: cfg.unstaker,
      totalSupply: utils.formatUnits(BigInt(totalSupply.toString()), cfg.decimals),
      wstTotalSupply: wstTotalSupply == null ? undefined : utils.formatUnits(BigInt(wstTotalSupply.toString()), cfg.decimals),
      ...warningFields(warningSink),
    }, 'stUSDT Overview', Boolean(opts.json));
  });

  stusdt.command('position <address>').description('Show user stUSDT / wstUSDT balances').action(async function (this: Command, address: string) {
    validateAddress(address);
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
    const tronWeb = getTronWeb(network);
    const stusdtContract = tronWeb.contract(TRC20_ABI as any, cfg.stUsdt) as any;
    const wstusdtContract = tronWeb.contract(TRC20_ABI as any, cfg.wstUsdt) as any;
    const [stBalance, wstBalance] = await Promise.all([
      stusdtContract.methods.balanceOf(address).call(),
      wstusdtContract.methods.balanceOf(address).call(),
    ]);
    outputResult({
      address,
      network,
      stUSDT: utils.formatUnits(BigInt(stBalance.toString()), cfg.decimals),
      wstUSDT: utils.formatUnits(BigInt(wstBalance.toString()), cfg.decimals),
    }, 'stUSDT Position', Boolean(opts.json));
  });

  stusdt.command('approve [amount]').description('Approve the stUSDT minter to spend your USDT')
    .option('--max', 'Explicitly approve MAX_UINT256 allowance')
    .option('--unlimited', 'Alias for --max')
    .action(async function (this: Command, amount?: string) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
    const opts = this.opts();
    const raw = resolveApprovalAmount(amount ?? MAX_UINT256, cfg.usdtDecimals, Boolean(opts.max || opts.unlimited));
    await sendContractTx({
      command: this,
      contractAddress: cfg.usdt,
      abi: TRC20_ABI,
      functionName: 'approve',
      args: [cfg.minter, raw.toString()],
      preview: { action: 'approve USDT for stUSDT minter', amount: amount ?? (opts.max || opts.unlimited ? 'max' : undefined), spender: cfg.minter },
    });
  });

  stusdt.command('mint <amount>').description('Deposit USDT to mint stUSDT').action(async function (this: Command, amount: string) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
    const raw = utils.parseUnits(amount, cfg.usdtDecimals);
    await sendContractTx({
      command: this,
      contractAddress: cfg.minter,
      abi: STUSDT_MINTER_ABI,
      functionName: 'submit',
      args: [raw.toString()],
      preview: { action: 'mint stUSDT', amount: `${amount} USDT` },
    });
  });

  stusdt.command('unstake <amount>').description('Request redeem stUSDT to USDT').action(async function (this: Command, amount: string) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
    const raw = utils.parseUnits(amount, cfg.decimals);
    await sendContractTx({
      command: this,
      contractAddress: cfg.unstaker,
      abi: STUSDT_UNSTAKER_ABI,
      functionName: 'requestWithdrawal',
      args: [raw.toString()],
      preview: { action: 'request stUSDT withdraw', amount: `${amount} stUSDT` },
    });
  });

  stusdt.command('claim <requestIds...>').description('Claim completed stUSDT withdrawal request IDs').action(async function (this: Command, requestIds: string[]) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
    await sendContractTx({
      command: this,
      contractAddress: cfg.unstaker,
      abi: STUSDT_UNSTAKER_ABI,
      functionName: 'claimWithdrawals',
      args: [requestIds],
      preview: { action: 'claim stUSDT withdrawal', requestIds: requestIds.join(',') },
    });
  });

  stusdt.command('approve-wrap [amount]')
    .description('Approve wstUSDT contract to pull your stUSDT before wrap()')
    .option('--max', 'Explicitly approve MAX_UINT256 allowance')
    .option('--unlimited', 'Alias for --max')
    .action(async function (this: Command, amount?: string) {
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
      const opts = this.opts();
      const raw = resolveApprovalAmount(amount ?? MAX_UINT256, cfg.decimals, Boolean(opts.max || opts.unlimited));
      await sendContractTx({
        command: this,
        contractAddress: cfg.stUsdt,
        abi: TRC20_ABI,
        functionName: 'approve',
        args: [cfg.wstUsdt, raw.toString()],
        preview: { action: 'approve stUSDT for wstUSDT', amount: amount ?? (opts.max || opts.unlimited ? 'max' : undefined), spender: cfg.wstUsdt },
      });
    });

  stusdt.command('wrap <amount>')
    .description('Wrap stUSDT → wstUSDT (non-rebasing). Requires prior approve-wrap.')
    .action(async function (this: Command, amount: string) {
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
      const raw = utils.parseUnits(amount, cfg.decimals);
      await sendContractTx({
        command: this,
        contractAddress: cfg.wstUsdt,
        abi: WSTUSDT_ABI,
        functionName: 'wrap',
        args: [raw.toString()],
        preview: { action: 'wrap stUSDT → wstUSDT', amount: `${amount} stUSDT` },
      });
    });

  stusdt.command('unwrap <amount>')
    .description('Unwrap wstUSDT → stUSDT (rebasing form)')
    .action(async function (this: Command, amount: string) {
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network].stUSDT;
      const raw = utils.parseUnits(amount, cfg.decimals);
      await sendContractTx({
        command: this,
        contractAddress: cfg.wstUsdt,
        abi: WSTUSDT_ABI,
        functionName: 'unwrap',
        args: [raw.toString()],
        preview: { action: 'unwrap wstUSDT → stUSDT', amount: `${amount} wstUSDT` },
      });
    });
}
