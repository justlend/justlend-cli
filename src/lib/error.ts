import chalk from 'chalk';
import { HttpRequestError } from './http.js';

export class CliError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'CliError';
  }
}

interface JsonErrorPayload {
  success: false;
  error: string;
  code?: string;
  module?: string;
  network?: string;
  host?: string;
  path?: string;
  status?: number;
  hint?: string;
}

let jsonMode = false;
let quietMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function setQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

export function isQuietMode(): boolean {
  return quietMode;
}

export function handleError(err: unknown): never {
  const payload = classifyError(err);
  if (jsonMode) {
    process.stderr.write(JSON.stringify(payload) + '\n');
  } else {
    console.error(chalk.red(`Error: ${payload.error}`));
    const details = [
      payload.code ? `code=${payload.code}` : undefined,
      payload.module ? `module=${payload.module}` : undefined,
      payload.network ? `network=${payload.network}` : undefined,
      payload.host ? `host=${payload.host}` : undefined,
      payload.path ? `path=${payload.path}` : undefined,
      payload.hint ? `hint=${payload.hint}` : undefined,
    ].filter(Boolean);
    if (details.length > 0) console.error(chalk.gray(details.join(' ')));
  }
  process.exit(1);
}

const USER_CANCEL_PATTERNS = [
  /\buser[\s_](rejected|denied|cancell?ed)\b/i,
  /\brejected\s+by\s+user\b/i,
  /\bcancell?ed\s+by\s+user\b/i,
  /^USER_(REJECTED|DENIED|CANCELL?ED)$/i,
  /^CANCELLED_BY_CALLER$/,
];

function classifyError(err: unknown): JsonErrorPayload {
  if (err instanceof HttpRequestError) {
    return {
      success: false,
      error: err.message,
      code: err.code,
      module: err.module,
      network: err.network,
      host: err.host,
      path: err.path,
      status: err.status,
      hint: err.hint,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (USER_CANCEL_PATTERNS.some(p => p.test(msg))) {
    return { success: false, error: 'Transaction cancelled by user in TronLink', code: 'USER_CANCELLED' };
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return { success: false, error: 'TronLink approval timed out. Please try again', code: 'SIGNER_TIMEOUT' };
  }
  if (lower.includes('insufficient') || lower.includes('balance is not sufficient')) {
    return { success: false, error: `Insufficient balance: ${msg}`, code: 'INSUFFICIENT_BALANCE' };
  }
  if (lower.includes('allowance')) {
    return { success: false, error: `Insufficient allowance: ${msg}. Run \`justlend approve <token>\` first`, code: 'INSUFFICIENT_ALLOWANCE' };
  }
  if (lower.includes('invalid address') || lower.includes('invalid base58')) {
    return { success: false, error: 'Invalid TRON address provided', code: 'INVALID_ADDRESS' };
  }
  if (lower.includes('ipc connection closed') || lower.includes('ipc connection lost')) {
    return {
      success: false,
      error: 'Signer disconnected (browser closed?). Keep the TronLink signer page open in your browser and retry.',
      code: 'SIGNER_DISCONNECTED',
    };
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('etimedout') || lower.includes('network error') || lower.includes('failed to fetch') || lower === 'fetch failed') {
    return {
      success: false,
      error: 'Network connection failed. Check your internet connection',
      code: 'NETWORK_CONNECTION_FAILED',
    };
  }
  if (lower.includes('broadcast failed')) {
    return { success: false, error: `Transaction broadcast failed: ${msg}`, code: 'BROADCAST_FAILED' };
  }

  return { success: false, error: msg };
}

export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/0x[0-9a-fA-F]{40,}/g, m => `${m.slice(0, 8)}…${m.slice(-4)}`);
}
