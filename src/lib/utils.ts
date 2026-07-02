import { TronWeb } from "tronweb";

/**
 * Utility functions for formatting and converting TRON values.
 * 1 TRX = 1,000,000 SUN
 */
export const utils = {
  /**
   * Convert TRX to Sun (smallest unit) with integer precision.
   *
   * TronWeb.toSun can return decimal strings for inputs with more than 6
   * places (for example "1.2345678" -> "1234567.8"), which later breaks
   * BigInt(callValue) or ABI uint256 encoding. Keep the CLI contract strict:
   * SUN is integer-only and TRX accepts at most 6 decimal places.
   */
  toSun: (trx: number | string): string => {
    return utils.parseUnits(String(trx), 6).toString();
  },

  /** Convert Sun to TRX. */
  fromSun: (sun: number | string | bigint): string => {
    return TronWeb.fromSun(sun.toString() as any).toString();
  },

  /** Stringify a bigint or number. */
  formatBigInt: (value: bigint | number): string => value.toString(),

  /** JSON-serialize an object, converting BigInts to strings. */
  formatJson: (obj: unknown): string =>
    JSON.stringify(obj, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2),

  /** Format a number with locale comma separators. */
  formatNumber: (value: number | string): string => Number(value).toLocaleString(),

  /** Convert a hex string to a decimal number. */
  hexToNumber: (hex: string): number => parseInt(hex, 16),

  /** Convert a decimal number to a hex string (0x-prefixed). */
  numberToHex: (num: number): string => "0x" + num.toString(16),

  /** Check whether a string is a valid TRON address. */
  isAddress: (address: string): boolean => TronWeb.isAddress(address),

  /**
   * Format a raw BigInt/string amount into a human-readable decimal string.
   * Inverse of parseUnits. Example: formatUnits("1500000000000000000", 18) => "1.5"
   */
  formatUnits: (value: string | bigint, decimals: number): string => {
    const s = value.toString();
    if (decimals === 0) return s;
    const padded = s.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
    return fracPart ? `${intPart}.${fracPart}` : intPart;
  },

  /**
   * Parse a human-readable decimal string into a BigInt of the smallest unit.
   * Uses pure string manipulation to avoid IEEE-754 floating-point precision loss.
   * Example: parseUnits("1.5", 18) => 1500000000000000000n
   */
  parseUnits: (value: string, decimals: number): bigint => {
    const trimmed = value.trim();
    // Reject a leading '-': a negative token amount is never legitimate and would
    // otherwise reach the signing path as a negative bigint (two's-complement wrap to a
    // huge uint256 at ABI encoding). Mirrors callValueToSafeNumber's non-negative guard.
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Invalid numeric value: "${value}"`);
    }
    const [integer, fraction = ""] = trimmed.split(".");
    const excess = fraction.slice(decimals);
    if (/[^0]/.test(excess)) {
      throw new Error(`Too many decimal places: token supports at most ${decimals} decimals`);
    }
    const padded = fraction.slice(0, decimals).padEnd(decimals, "0");
    return BigInt(integer + padded);
  },
};
