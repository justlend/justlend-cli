import { Command } from 'commander';
import { WTRX_ABI } from '../lib/abis.js';
import { getMoolahAddresses } from '../lib/chains.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { sendContractTx } from '../lib/tx.js';
import { utils } from '../lib/utils.js';

/**
 * WTRX (Wrapped TRX) wrap / unwrap — WETH-style native-TRX wrapper (1:1).
 *   - wrap <amount>   → deposit()          (TRX  → WTRX, payable via callValue)
 *   - unwrap <amount> → withdraw(uint256)  (burn WTRX → native TRX)
 *
 * Mirrors app-justlend `system.jsx::wtrxDeposit` / `wtrxWithdraw`, on the CLI's
 * hardened `sendContractTx` write path (economic precheck + triggerConstantRaw
 * pre-flight + fail-closed confirm + broadcast judge). WTRX mirrors TRX at 6dp,
 * so `utils.toSun` (parseUnits(_, 6): rejects negatives / over-precision) is the
 * correct amount conversion — same as `strx stake`/`unstake`.
 */
export function registerWtrxCommands(program: Command): void {
  const wtrx = program.command('wtrx').description('Wrap / unwrap native TRX <-> WTRX (1:1)');

  wtrx
    .command('wrap <amount>')
    .description('Wrap native TRX into WTRX (1:1)')
    .action(async function (this: Command, amount: string) {
      const network = getNetworkFromCommand(this);
      const { wtrxProxy } = getMoolahAddresses(network);
      const raw = utils.toSun(amount);
      await sendContractTx({
        command: this,
        contractAddress: wtrxProxy,
        abi: WTRX_ABI,
        functionName: 'deposit',
        callValue: raw,
        preview: { action: 'wrap TRX to WTRX', amount: `${amount} TRX`, wtrx: wtrxProxy },
      });
    });

  wtrx
    .command('unwrap <amount>')
    .description('Unwrap WTRX back into native TRX (1:1)')
    .action(async function (this: Command, amount: string) {
      const network = getNetworkFromCommand(this);
      const { wtrxProxy } = getMoolahAddresses(network);
      const raw = utils.toSun(amount);
      await sendContractTx({
        command: this,
        contractAddress: wtrxProxy,
        abi: WTRX_ABI,
        functionName: 'withdraw',
        args: [raw.toString()],
        preview: { action: 'unwrap WTRX to TRX', amount: `${amount} WTRX`, wtrx: wtrxProxy },
      });
    });
}
