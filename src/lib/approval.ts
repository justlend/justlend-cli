export const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

export interface UnlimitedApprovalOptions {
  amountLabel?: string;
  allowUnlimited?: boolean;
  spender?: string;
}

export function requireExplicitUnlimitedApproval(options: UnlimitedApprovalOptions = {}): void {
  if (options.allowUnlimited) return;
  const target = options.spender ? ` for spender ${options.spender}` : '';
  throw new Error(
    `Unlimited approval${target} requires --unlimited or --max. ` +
    `Pass an explicit finite amount instead, or opt in to unlimited allowance intentionally.`,
  );
}

export function isUnlimitedApprovalAmount(amount: string | undefined): boolean {
  return amount === MAX_UINT256;
}

export function resolveApprovalAmount(amount: string | undefined, decimals: number, allowUnlimited = false): bigint {
  if (amount === undefined) {
    requireExplicitUnlimitedApproval({ amountLabel: 'max', allowUnlimited });
    return BigInt(MAX_UINT256);
  }
  const trimmed = amount.trim();
  if (trimmed === MAX_UINT256) {
    requireExplicitUnlimitedApproval({ amountLabel: 'max', allowUnlimited });
    return BigInt(MAX_UINT256);
  }
  if (/^\d+$/.test(trimmed) && BigInt(trimmed) === BigInt(MAX_UINT256)) {
    requireExplicitUnlimitedApproval({ amountLabel: 'max', allowUnlimited });
    return BigInt(MAX_UINT256);
  }
  return parseFiniteApprovalAmount(amount, decimals);
}

function parseFiniteApprovalAmount(amount: string, decimals: number): bigint {
  // Imported lazily at call sites would complicate sync API/tests; keep logic local equivalent
  // to utils.parseUnits by requiring callers to pass already validated decimal strings through
  // the public helper below.
  const trimmed = amount.trim();
  // Reject a leading '-': a negative approval amount is never legitimate and would otherwise
  // reach the signing path as a negative bigint (two's-complement wrap to a near-MAX_UINT256
  // allowance at ABI encoding). Mirrors callValueToSafeNumber's non-negative guard.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid numeric value: "${amount}"`);
  const [integer, fraction = ''] = trimmed.split('.');
  const excess = fraction.slice(decimals);
  if (/[^0]/.test(excess)) {
    throw new Error(`Too many decimal places: token supports at most ${decimals} decimals`);
  }
  const padded = fraction.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(integer + padded);
}
