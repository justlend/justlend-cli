import { Command, InvalidArgumentError } from 'commander';
import { TronNetwork, validateNetworkOption } from './types.js';

export function getNetworkFromCommand(command: Command): TronNetwork {
  const opts = command.optsWithGlobals();
  return validateNetworkOption(opts.network) ?? TronNetwork.Mainnet;
}

export function requireMoolahMainnet(network: TronNetwork): void {
  if (network !== TronNetwork.Mainnet) {
    throw new Error('V2 backend API is mainnet-only. Use mainnet or wait for on-chain nile reads.');
  }
}

export function parsePositiveInteger(value: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new InvalidArgumentError(`Invalid positive integer: "${value}"`);
  }
  return numberValue;
}

/**
 * Validate a non-negative integer index (e.g. a SUN pool `pid`, which is a
 * uint256 where 0 is a legitimate pool). Mirrors `parsePositiveInteger` but
 * accepts 0, and rejects negatives / non-integers / NaN early with a clear
 * message instead of letting a malformed value reach ABI encoding.
 */
export function parseNonNegativeInteger(value: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new InvalidArgumentError(`Invalid non-negative integer: "${value}"`);
  }
  return numberValue;
}

export function shorten(value?: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (text.length <= 14) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function summarizeRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') row[key] = value;
  }
  return Object.keys(row).length > 0 ? row : record;
}
