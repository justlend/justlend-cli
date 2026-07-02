import { Command } from 'commander';
import { TRC20_ABI } from '../lib/abis.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { sendContractTx } from '../lib/tx.js';
import { validateAddress } from '../lib/tronweb.js';
import { resolveTrc20Decimals } from '../lib/tokens.js';
import { MAX_UINT256, requireExplicitUnlimitedApproval, resolveApprovalAmount } from '../lib/approval.js';

export function registerApproveCommand(program: Command): void {
  program.command('approve <token> <spender> [amount]')
    .description('Approve TRC20 token spending')
    .option('--decimals <n>', 'Token decimals override (integer in [0, 38])')
    .option('--unlimited', 'Explicitly approve MAX_UINT256 allowance')
    .option('--max', 'Alias for --unlimited')
    .action(async function (this: Command, token: string, spender: string, amount?: string) {
      validateAddress(token);
      validateAddress(spender);
      const network = getNetworkFromCommand(this);
      const opts = this.opts();
      if (amount === undefined && !(opts.unlimited || opts.max)) {
        requireExplicitUnlimitedApproval({ amountLabel: 'max', allowUnlimited: false, spender });
      }
      const decimals = await resolveTrc20Decimals(network, token, opts.decimals);
      const raw = resolveApprovalAmount(amount ?? MAX_UINT256, decimals, Boolean(opts.unlimited || opts.max));
      await sendContractTx({
        command: this,
        contractAddress: token,
        abi: TRC20_ABI,
        functionName: 'approve',
        args: [spender, raw.toString()],
        preview: { action: 'TRC20 approve', token, spender, amount: amount ?? (opts.unlimited || opts.max ? 'max' : undefined) },
      });
    });
}
