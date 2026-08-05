import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TronWeb } from 'tronweb';
import { validateTrustedUrl } from './trusted-url.js';
import { validateAddress } from './tronweb.js';

export const ENERGY_PURCHASE_PATHS = {
  config: '/v1/config',
  currentPrice: '/v1/price/current',
  poolHealth: '/v1/pool/health',
  quote: '/v1/price',
  buy: '/v1/consumer/energy/buy',
  order: (id: string | number) => `/v1/consumer/energy/orders/${encodeURIComponent(String(id))}`,
  history: '/v1/consumer/energy/orders/history',
} as const;

export const ENERGY_PURCHASE_TERMINAL_STATES = ['delivered', 'partial', 'failed', 'expired', 'cancelled'] as const;

const ORDER_TTL_MS = 5 * 60 * 1000;
const PAYMENT_RETRY_TIMEOUT_MS = 2 * 60 * 1000;
const PURCHASE_INTENT_TTL_MS = 15 * 60 * 1000;
const RISK_MUTATION_LOCK_WAIT_MS = 2_000;
const RISK_MUTATION_LOCK_RETRY_MS = 10;
const RISK_FILE = path.join(os.homedir(), '.justlend-cli', 'energy-payment-risks.json');
const mutationLockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export class EnergyPurchaseError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly isBusinessError: boolean;
  readonly retryable: boolean;
  readonly details?: unknown;
  paymentRisk?: EnergyPaymentRisk;

  constructor(code: string, message?: string, options: {
    status?: number;
    isBusinessError?: boolean;
    retryable?: boolean;
    details?: unknown;
    cause?: unknown;
  } = {}) {
    super(message || code, { cause: options.cause });
    this.name = 'EnergyPurchaseError';
    this.code = code;
    this.status = options.status;
    this.isBusinessError = options.isBusinessError === true;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

export interface EnergyPurchaseConfig {
  min_energy: number;
  max_energy: number;
  max_receivers: number;
  presets?: number[];
  activation_fee_sun?: number;
  usage_window_minutes?: number;
  durations: string[];
  resource_pool_addresses?: string[];
  [key: string]: unknown;
}

export interface EnergyPurchaseQuote {
  amount_sun: number;
  pay_address: string;
  can_fulfill: boolean;
  max_single_order_energy?: number;
  items?: unknown[];
  [key: string]: unknown;
}

export interface EnergyPaymentRisk {
  payerAddress: string;
  signedTxId: string;
  createdAt: number;
  expiresAt: number;
  paymentConfirmed: boolean;
}

export interface StorageLike {
  list(payerAddress: string): EnergyPaymentRisk[];
  save(risk: EnergyPaymentRisk): void;
  remove(payerAddress: string, signedTxId?: string): void;
  acquirePurchaseIntent(payerAddress: string, createdAt: number, expiresAt: number): string;
  releasePurchaseIntent(payerAddress: string, token: string): void;
}

interface PurchaseIntent {
  payerAddress: string;
  token: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
}

interface RiskMutationLock {
  token: string;
  pid: number;
  createdAt: number;
}

function storageError(message: string, cause?: unknown): EnergyPurchaseError {
  return new EnergyPurchaseError('RISK_STORAGE_ERROR', message, { cause });
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function parsePaymentRisks(raw: string): EnergyPaymentRisk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw storageError('Energy payment risk file contains invalid JSON; purchases are blocked until it is repaired.', cause);
  }
  if (!Array.isArray(parsed) || !parsed.every((risk): risk is EnergyPaymentRisk => {
    if (!risk || typeof risk !== 'object') return false;
    const candidate = risk as Partial<EnergyPaymentRisk>;
    return typeof candidate.payerAddress === 'string' && candidate.payerAddress.length > 0 &&
      typeof candidate.signedTxId === 'string' && candidate.signedTxId.length > 0 &&
      Number.isSafeInteger(candidate.createdAt) && Number(candidate.createdAt) >= 0 &&
      Number.isSafeInteger(candidate.expiresAt) && Number(candidate.expiresAt) >= 0 &&
      typeof candidate.paymentConfirmed === 'boolean';
  })) {
    throw storageError('Energy payment risk file has an invalid schema; purchases are blocked until it is repaired.');
  }
  return parsed;
}

function parsePurchaseIntent(raw: string): PurchaseIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw storageError('Energy purchase intent lock contains invalid JSON; purchases remain blocked.', cause);
  }
  const intent = parsed as Partial<PurchaseIntent> | null;
  if (
    !intent || typeof intent !== 'object' || typeof intent.payerAddress !== 'string' ||
    typeof intent.token !== 'string' || intent.token.length === 0 || !Number.isSafeInteger(intent.pid) ||
    !Number.isSafeInteger(intent.createdAt) || !Number.isSafeInteger(intent.expiresAt)
  ) {
    throw storageError('Energy purchase intent lock has an invalid schema; purchases remain blocked.');
  }
  return intent as PurchaseIntent;
}

function parseRiskMutationLock(raw: string): RiskMutationLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw storageError('Energy payment risk lock contains invalid JSON; purchases remain blocked.', cause);
  }
  const lock = parsed as Partial<RiskMutationLock> | null;
  if (
    !lock || typeof lock !== 'object' || typeof lock.token !== 'string' || lock.token.length === 0 ||
    !Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0 ||
    !Number.isSafeInteger(lock.createdAt) || Number(lock.createdAt) < 0
  ) {
    throw storageError('Energy payment risk lock has an invalid schema; purchases remain blocked.');
  }
  return lock as RiskMutationLock;
}

export class FileEnergyPaymentRiskStore implements StorageLike {
  constructor(private readonly filePath = RISK_FILE) {}

  private readAll(): EnergyPaymentRisk[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return [];
      throw storageError('Unable to read the energy payment risk file; purchases are blocked.', cause);
    }
    return parsePaymentRisks(raw);
  }

  private writeAll(risks: EnergyPaymentRisk[]): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(risks, null, 2), { mode: 0o600 });
        fs.renameSync(temp, this.filePath);
      } finally {
        try {
          fs.unlinkSync(temp);
        } catch (cause) {
          if (!isNodeError(cause, 'ENOENT')) throw cause;
        }
      }
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to persist the energy payment risk file; purchases are blocked.', cause);
    }
  }

  private mutationLockPath(): string {
    return `${this.filePath}.mutation.lock`;
  }

  private acquireMutationLock(): string {
    const lockPath = this.mutationLockPath();
    const deadline = Date.now() + RISK_MUTATION_LOCK_WAIT_MS;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    for (;;) {
      const token = randomUUID();
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      } catch (cause) {
        if (!isNodeError(cause, 'EEXIST')) {
          throw storageError('Unable to lock the energy payment risk file; purchases are blocked.', cause);
        }
        if (Date.now() >= deadline) {
          throw new EnergyPurchaseError(
            'RISK_STORAGE_BUSY',
            'The energy payment risk file is busy or its previous writer exited unexpectedly; purchases remain blocked.',
            { retryable: true },
          );
        }
        Atomics.wait(mutationLockWaitBuffer, 0, 0, RISK_MUTATION_LOCK_RETRY_MS);
        continue;
      }

      try {
        fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
      } catch (cause) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original persistence error. */ }
        try { fs.unlinkSync(lockPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw storageError('Unable to persist the energy payment risk lock; purchases remain blocked.', cause);
      }
      return token;
    }
  }

  private releaseMutationLock(token: string): void {
    const lockPath = this.mutationLockPath();
    let current: RiskMutationLock;
    try {
      current = parseRiskMutationLock(fs.readFileSync(lockPath, 'utf8'));
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to verify the energy payment risk lock; it was preserved.', cause);
    }
    if (current.token !== token) {
      throw storageError('Energy payment risk lock ownership changed; the current lock was preserved.');
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return;
      throw storageError('Unable to release the energy payment risk lock; purchases remain blocked.', cause);
    }
  }

  private mutateAll(mutator: (risks: EnergyPaymentRisk[]) => EnergyPaymentRisk[]): void {
    const token = this.acquireMutationLock();
    try {
      this.writeAll(mutator(this.readAll()));
    } finally {
      this.releaseMutationLock(token);
    }
  }

  private intentPath(payerAddress: string): string {
    return path.join(`${this.filePath}.locks`, `${encodeURIComponent(payerAddress)}.json`);
  }

  private readIntent(lockPath: string): PurchaseIntent {
    try {
      return parsePurchaseIntent(fs.readFileSync(lockPath, 'utf8'));
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to read the energy purchase intent lock; purchases remain blocked.', cause);
    }
  }

  private createIntent(lockPath: string, intent: PurchaseIntent): void {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(intent));
      fs.fsyncSync(descriptor);
    } catch (cause) {
      if (descriptor !== undefined) {
        try { fs.unlinkSync(lockPath); } catch { /* The failed lock remains fail-closed if cleanup is denied. */ }
      }
      throw cause;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  acquirePurchaseIntent(payerAddress: string, createdAt: number, expiresAt: number): string {
    const lockPath = this.intentPath(payerAddress);
    const recoveryPath = `${lockPath}.recovery`;
    const intent: PurchaseIntent = { payerAddress, token: randomUUID(), pid: process.pid, createdAt, expiresAt };
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      try {
        this.createIntent(lockPath, intent);
        return intent.token;
      } catch (cause) {
        if (!isNodeError(cause, 'EEXIST')) throw cause;
      }

      const current = this.readIntent(lockPath);
      if (current.expiresAt > createdAt) {
        throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
      }

      let recoveryDescriptor: number | undefined;
      try {
        recoveryDescriptor = fs.openSync(
          recoveryPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
        const refreshed = this.readIntent(lockPath);
        if (refreshed.expiresAt > createdAt) {
          throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
        }
        fs.unlinkSync(lockPath);
        try {
          this.createIntent(lockPath, intent);
          return intent.token;
        } catch (cause) {
          if (isNodeError(cause, 'EEXIST')) {
            throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
          }
          throw cause;
        }
      } catch (cause) {
        if (isNodeError(cause, 'EEXIST')) {
          throw storageError('A stale energy purchase lock is already being recovered; purchases remain blocked.', cause);
        }
        throw cause;
      } finally {
        if (recoveryDescriptor !== undefined) {
          fs.closeSync(recoveryDescriptor);
          try { fs.unlinkSync(recoveryPath); } catch { /* A leftover recovery marker keeps recovery fail-closed. */ }
        }
      }
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to acquire the energy purchase intent lock; purchases are blocked.', cause);
    }
  }

  releasePurchaseIntent(payerAddress: string, token: string): void {
    const lockPath = this.intentPath(payerAddress);
    try {
      const current = this.readIntent(lockPath);
      if (current.payerAddress !== payerAddress || current.token !== token) {
        throw storageError('Energy purchase intent lock ownership changed; the lock was not removed.');
      }
      fs.unlinkSync(lockPath);
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to release the energy purchase intent lock; purchases remain blocked.', cause);
    }
  }

  list(payerAddress: string): EnergyPaymentRisk[] {
    return this.readAll().filter(risk => risk.payerAddress === payerAddress);
  }

  save(risk: EnergyPaymentRisk): void {
    this.mutateAll((risks) => {
      const remaining = risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
      remaining.push(risk);
      return remaining;
    });
  }

  remove(payerAddress: string, signedTxId?: string): void {
    this.mutateAll(risks => risks.filter(risk =>
      risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId),
    ));
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnergyPurchaseClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  tronWeb?: InstanceType<typeof TronWeb>;
  storage?: StorageLike;
  requestTimeoutMs?: number;
  paymentRetryIntervalMs?: number;
  paymentRetryTimeoutMs?: number;
  orderPollIntervalMs?: number;
  orderPollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function resolveBaseUrl(explicit?: string): string {
  const value = explicit || process.env.JUSTLEND_ENERGY_API_URL;
  if (!value) {
    throw new EnergyPurchaseError(
      'CONFIG_MISSING',
      'Set JUSTLEND_ENERGY_API_URL (or --energy-api-url). No production fallback is configured.',
    );
  }
  return validateTrustedUrl(value, 'energyApiHost');
}

function positiveInteger(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new EnergyPurchaseError('INVALID_AMOUNT', `${label} must be a positive safe integer.`);
  }
  return numberValue;
}

function validateQuoteInput(receivers: string[], energyPerReceiver: number, config: EnergyPurchaseConfig): void {
  if (!Array.isArray(receivers) || receivers.length === 0) {
    throw new EnergyPurchaseError('EMPTY_RECEIVERS', 'At least one receiver is required.');
  }
  receivers.forEach((receiver, index) => validateAddress(receiver, `receiver[${index}]`));
  const energy = positiveInteger(energyPerReceiver, 'energyPerReceiver');
  const min = positiveInteger(config?.min_energy, 'config.min_energy');
  const max = positiveInteger(config?.max_energy, 'config.max_energy');
  const maxReceivers = positiveInteger(config?.max_receivers, 'config.max_receivers');
  if (max < min) throw new EnergyPurchaseError('INVALID_RESPONSE', 'API returned max_energy below min_energy.');
  if (energy < min || energy > max) {
    throw new EnergyPurchaseError('INVALID_AMOUNT', `Energy per receiver must be between ${min} and ${max}.`);
  }
  if (receivers.length > maxReceivers) {
    throw new EnergyPurchaseError('ADDR_OVERFLOW', `A maximum of ${maxReceivers} receivers is allowed.`);
  }
  const resourcePools = new Set(config.resource_pool_addresses || []);
  if (receivers.some(receiver => resourcePools.has(receiver))) {
    throw new EnergyPurchaseError('INVALID_RECEIVERS', 'Resource-pool addresses cannot receive purchased energy.');
  }
}

function normalizeSignedTransaction(value: unknown): Record<string, any> {
  const outer = value as Record<string, any> | undefined;
  const signed = outer?.signedTransaction || outer;
  if (
    !signed || typeof signed.txID !== 'string' || !signed.raw_data ||
    !Array.isArray(signed.signature) || signed.signature.length !== 1
  ) {
    throw new EnergyPurchaseError(
      'INVALID_SIGNED_TX',
      'Signer must return one signed TRX transfer with txID, raw_data, and exactly one signature.',
    );
  }
  return signed;
}

export class EnergyPurchaseClient {
  private static readonly activePayers = new Set<string>();
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tronWeb?: InstanceType<typeof TronWeb>;
  private readonly storage: StorageLike;
  private readonly requestTimeoutMs: number;
  private readonly paymentRetryIntervalMs: number;
  private readonly paymentRetryTimeoutMs: number;
  private readonly orderPollIntervalMs: number;
  private readonly orderPollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: EnergyPurchaseClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch || fetch;
    this.tronWeb = options.tronWeb;
    this.storage = options.storage || new FileEnergyPaymentRiskStore();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.paymentRetryIntervalMs = options.paymentRetryIntervalMs ?? 5000;
    this.paymentRetryTimeoutMs = options.paymentRetryTimeoutMs ?? PAYMENT_RETRY_TIMEOUT_MS;
    this.orderPollIntervalMs = options.orderPollIntervalMs ?? 3000;
    this.orderPollTimeoutMs = options.orderPollTimeoutMs ?? 150000;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
  }

  private async request<T>(method: string, apiPath: string, options: {
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, timeout])
      : options.signal || timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.token ? { 'X-Consumer-Order-Token': options.token } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (cause) {
      throw new EnergyPurchaseError('NETWORK_ERROR', 'Energy purchase API request returned no response.', {
        retryable: true,
        cause,
      });
    }

    let envelope: { code?: string; msg?: string; data?: T };
    try {
      envelope = await response.json() as typeof envelope;
    } catch (cause) {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase API returned non-JSON data.', {
        status: response.status,
        retryable: response.status >= 500,
        cause,
      });
    }
    if (envelope.code !== '0') {
      const business = typeof envelope.code === 'string' && envelope.code.length > 0;
      throw new EnergyPurchaseError(business ? String(envelope.code).toUpperCase() : 'INVALID_RESPONSE', envelope.msg, {
        status: response.status,
        isBusinessError: business,
        retryable: !business && response.status >= 500,
      });
    }
    if (!response.ok) {
      throw new EnergyPurchaseError('HTTP_ERROR', `Energy purchase API returned HTTP ${response.status}.`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    return envelope.data as T;
  }

  getConfig(signal?: AbortSignal): Promise<EnergyPurchaseConfig> {
    return this.request('GET', ENERGY_PURCHASE_PATHS.config, { signal });
  }

  getCurrentPrice(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', ENERGY_PURCHASE_PATHS.currentPrice, { signal });
  }

  getPoolHealth(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', ENERGY_PURCHASE_PATHS.poolHealth, { signal });
  }

  async quote(input: {
    receivers: string[];
    energyPerReceiver: number;
    config?: EnergyPurchaseConfig;
    signal?: AbortSignal;
  }): Promise<EnergyPurchaseQuote> {
    const config = input.config || await this.getConfig(input.signal);
    validateQuoteInput(input.receivers, input.energyPerReceiver, config);
    const quote = await this.request<EnergyPurchaseQuote>('POST', ENERGY_PURCHASE_PATHS.quote, {
      body: { receivers: input.receivers, energy_per_receiver: input.energyPerReceiver },
      signal: input.signal,
    });
    if (
      typeof quote?.can_fulfill !== 'boolean' || !Number.isSafeInteger(Number(quote?.amount_sun)) ||
      Number(quote.amount_sun) <= 0 || typeof quote.pay_address !== 'string'
    ) {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase quote is missing required fields.');
    }
    validateAddress(quote.pay_address, 'quote pay_address');
    if (!quote.can_fulfill) {
      throw new EnergyPurchaseError('POOL_INSUFFICIENT', 'No single resource pool can fulfill the quote.', {
        isBusinessError: true,
        details: {
          requiredEnergy: input.energyPerReceiver * input.receivers.length,
          maxSingleOrderEnergy: quote.max_single_order_energy ?? null,
        },
      });
    }
    return quote;
  }

  getOrder(orderId: string | number, token?: string, signal?: AbortSignal): Promise<Record<string, any>> {
    if (String(orderId).length === 0) throw new EnergyPurchaseError('INVALID_ORDER_ID', 'orderId is required.');
    return this.request('GET', ENERGY_PURCHASE_PATHS.order(orderId), { token, signal });
  }

  getHistory(address: string, options: { page?: number; size?: number; signal?: AbortSignal } = {}): Promise<Record<string, any>> {
    validateAddress(address, 'history address');
    const query = new URLSearchParams({ address });
    if (options.size !== undefined) {
      query.set('page', String(positiveInteger(options.page ?? 1, 'page')));
      query.set('size', String(positiveInteger(options.size, 'size')));
    }
    return this.request('GET', `${ENERGY_PURCHASE_PATHS.history}?${query}`, { signal: options.signal });
  }

  getPaymentRisks(payerAddress: string): EnergyPaymentRisk[] {
    validateAddress(payerAddress, 'payerAddress');
    return this.storage.list(payerAddress);
  }

  private async buildAndSignPayment(input: {
    payerAddress: string;
    payAddress: string;
    amountSun: number;
    signTransaction: (transaction: Record<string, any>) => Promise<unknown>;
  }): Promise<Record<string, any>> {
    if (!this.tronWeb?.transactionBuilder?.sendTrx) {
      throw new EnergyPurchaseError('CONFIG_MISSING', 'A TronWeb client is required to build the payment.');
    }
    validateAddress(input.payerAddress, 'payerAddress');
    validateAddress(input.payAddress, 'payAddress');
    const amountSun = positiveInteger(input.amountSun, 'amountSun');
    let unsigned = await this.tronWeb.transactionBuilder.sendTrx(input.payAddress, amountSun, input.payerAddress) as Record<string, any>;
    if (unsigned?.raw_data?.expiration && this.tronWeb.transactionBuilder.extendExpiration) {
      const seconds = Math.ceil((this.now() + ORDER_TTL_MS - Number(unsigned.raw_data.expiration)) / 1000);
      if (seconds > 0) {
        try {
          const candidate = { ...unsigned, raw_data: { ...unsigned.raw_data } };
          unsigned = await this.tronWeb.transactionBuilder.extendExpiration(candidate as any, seconds, { txLocal: true }) as Record<string, any>;
        } catch {
          // The shorter node-provided expiration remains a safe fallback.
        }
      }
    }
    return normalizeSignedTransaction(await input.signTransaction(unsigned));
  }

  private async lookupTransaction(txId: string): Promise<'found' | 'not_found' | 'unavailable'> {
    if (typeof this.tronWeb?.trx?.getTransaction !== 'function') return 'unavailable';
    try {
      const transaction = await this.tronWeb.trx.getTransaction(txId) as { txID?: string } | undefined;
      return transaction?.txID === txId ? 'found' : 'not_found';
    } catch (error) {
      return String((error as Error)?.message || error).toLowerCase().includes('transaction not found')
        ? 'not_found'
        : 'unavailable';
    }
  }

  private async pollOrder(orderId: string | number, token?: string, signal?: AbortSignal): Promise<Record<string, any> | null> {
    const deadline = this.now() + this.orderPollTimeoutMs;
    let detail: Record<string, any> | null = null;
    while (this.now() < deadline) {
      try {
        detail = await this.getOrder(orderId, token, signal);
        if ((ENERGY_PURCHASE_TERMINAL_STATES as readonly string[]).includes(detail.state)) return detail;
      } catch (error) {
        if (signal?.aborted) throw new EnergyPurchaseError('ABORTED', 'Order polling was aborted.', { cause: error });
        // Payment is already accepted; tolerate transient order-query failures until the deadline.
      }
      await this.sleep(this.orderPollIntervalMs);
    }
    return detail;
  }

  async reconcilePaymentRisks(payerAddress: string): Promise<EnergyPaymentRisk[]> {
    const risks = this.getPaymentRisks(payerAddress);
    let history: Record<string, any> | null = null;
    for (const risk of risks) {
      const lookup = await this.lookupTransaction(risk.signedTxId);
      if (lookup === 'found') {
        risk.paymentConfirmed = true;
        this.storage.save(risk);
        history ||= await this.getHistory(payerAddress).catch(() => null);
        const rows = Array.isArray(history?.rows) ? history.rows : [];
        if (rows.some(row => row.payment_tx_id === risk.signedTxId)) {
          this.storage.remove(payerAddress, risk.signedTxId);
        }
      } else if (lookup === 'not_found' && this.now() >= risk.expiresAt) {
        this.storage.remove(payerAddress, risk.signedTxId);
      }
    }
    return this.storage.list(payerAddress);
  }

  async purchase(input: {
    payerAddress: string;
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    signTransaction: (transaction: Record<string, any>) => Promise<unknown>;
    onState?: (state: string) => void;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    validateAddress(input.payerAddress, 'payerAddress');
    if (EnergyPurchaseClient.activePayers.has(input.payerAddress)) {
      throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
    }
    EnergyPurchaseClient.activePayers.add(input.payerAddress);
    let intentToken: string | undefined;
    try {
      const createdAt = this.now();
      intentToken = this.storage.acquirePurchaseIntent(
        input.payerAddress,
        createdAt,
        createdAt + PURCHASE_INTENT_TTL_MS,
      );
      return await this.purchaseWithIntent(input);
    } finally {
      try {
        if (intentToken !== undefined) this.storage.releasePurchaseIntent(input.payerAddress, intentToken);
      } finally {
        EnergyPurchaseClient.activePayers.delete(input.payerAddress);
      }
    }
  }

  private async purchaseWithIntent(input: {
    payerAddress: string;
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    signTransaction: (transaction: Record<string, any>) => Promise<unknown>;
    onState?: (state: string) => void;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const existing = await this.reconcilePaymentRisks(input.payerAddress);
    if (existing.length) {
      throw Object.assign(
        new EnergyPurchaseError(
          'PAYMENT_RISK_UNRESOLVED',
          'A previous payment has an unknown result. Inspect history/chain state before attempting another payment.',
        ),
        { paymentRisk: existing[0] },
      );
    }

    input.onState?.('quoting');
    const config = await this.getConfig(input.signal);
    const durations = Array.isArray(config.durations) ? config.durations.filter(item => typeof item === 'string' && item.trim()) : [];
    if (!durations.includes(input.duration)) {
      throw new EnergyPurchaseError('INVALID_DURATION', 'duration must come from the live /v1/config durations list.');
    }
    const quote = await this.quote({ ...input, config });
    const expectedAmountSun = positiveInteger(input.expectedAmountSun, 'expectedAmountSun');
    if (quote.amount_sun !== expectedAmountSun) {
      throw new EnergyPurchaseError('AMOUNT_CHANGED', 'The authoritative quote differs from the exact amount confirmed.', {
        details: { expectedAmountSun: input.expectedAmountSun, amountSun: quote.amount_sun },
      });
    }

    input.onState?.('signing');
    const signed = await this.buildAndSignPayment({
      payerAddress: input.payerAddress,
      payAddress: quote.pay_address,
      amountSun: quote.amount_sun,
      signTransaction: input.signTransaction,
    });
    const signedDeadline = Number.isFinite(Number(signed.raw_data?.expiration))
      ? Number(signed.raw_data.expiration)
      : this.now() + ORDER_TTL_MS;
    const retryDeadline = Math.min(signedDeadline, this.now() + this.paymentRetryTimeoutMs);
    const risk: EnergyPaymentRisk = {
      payerAddress: input.payerAddress,
      signedTxId: signed.txID,
      createdAt: this.now(),
      expiresAt: signedDeadline,
      paymentConfirmed: false,
    };

    input.onState?.('submitting');
    let order: Record<string, any> | null = null;
    while (!order) {
      this.storage.save(risk);
      try {
        order = await this.request('POST', ENERGY_PURCHASE_PATHS.buy, {
          body: {
            receivers: input.receivers,
            energy_per_receiver: input.energyPerReceiver,
            duration: input.duration,
            payer_address: input.payerAddress,
            signed_transaction: signed,
          },
          signal: input.signal,
        });
      } catch (error) {
        const typed = error as EnergyPurchaseError;
        if (typed.isBusinessError) {
          if (typed.code === 'TX_ALREADY_CLAIMED') {
            risk.paymentConfirmed = true;
            this.storage.save(risk);
            typed.paymentRisk = risk;
          } else {
            this.storage.remove(input.payerAddress, signed.txID);
          }
          throw typed;
        }
        if (this.now() >= retryDeadline) {
          if (await this.lookupTransaction(signed.txID) === 'found') {
            risk.paymentConfirmed = true;
            this.storage.save(risk);
            return { ok: true, orderId: null, txHash: signed.txID, state: 'pending', confirmedOnChain: true };
          }
          throw Object.assign(
            new EnergyPurchaseError(
              'PAYMENT_RESULT_UNKNOWN',
              'Payment result is unknown. Do not create another signed payment until this risk is reconciled.',
              { cause: typed },
            ),
            { paymentRisk: risk },
          );
        }
        await this.sleep(this.paymentRetryIntervalMs);
      }
    }

    this.storage.remove(input.payerAddress, signed.txID);
    const orderId = order.id;
    const txHash = order.tx_id || signed.txID;
    input.onState?.('delivering');
    const detail = await this.pollOrder(orderId, order.access_token, input.signal);
    const state = detail?.state || order.state || 'pending';
    if (state === 'failed' || state === 'expired') {
      throw new EnergyPurchaseError('DELIVERY_FAILED', 'Payment was accepted but energy delivery failed.', {
        details: { orderId, txHash, state, detail },
      });
    }
    return { ok: true, orderId, txHash, state, detail };
  }
}
