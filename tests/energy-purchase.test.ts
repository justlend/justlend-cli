import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EnergyPurchaseClient,
  EnergyPurchaseError,
  FileEnergyPaymentRiskStore,
  type EnergyPaymentRisk,
  type StorageLike,
} from '../src/lib/energy-purchase.js';
import { createProgram } from '../src/index.js';

const PAYER = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
const SECOND_PAYER = 'TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT';
const RECEIVER = 'TVjsyZ7fYF3qLF6BQgPmTEZy1xrNNyVAAA';
const PAY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: '0', msg: 'ok', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function config() {
  return {
    min_energy: 65000,
    max_energy: 5000000,
    max_receivers: 50,
    durations: ['1h'],
    presets: [65000],
    resource_pool_addresses: [],
  };
}

class MemoryRiskStore implements StorageLike {
  risks: EnergyPaymentRisk[] = [];
  intents = new Map<string, string>();
  list(payerAddress: string) { return this.risks.filter(risk => risk.payerAddress === payerAddress); }
  save(risk: EnergyPaymentRisk) {
    this.risks = this.risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
    this.risks.push({ ...risk });
  }
  remove(payerAddress: string, signedTxId?: string) {
    this.risks = this.risks.filter(risk => risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId));
  }
  acquirePurchaseIntent(payerAddress: string) {
    if (this.intents.has(payerAddress)) {
      throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'purchase in progress');
    }
    const token = `intent-${this.intents.size + 1}`;
    this.intents.set(payerAddress, token);
    return token;
  }
  releasePurchaseIntent(payerAddress: string, token: string) {
    if (this.intents.get(payerAddress) !== token) throw new Error('intent owner mismatch');
    this.intents.delete(payerAddress);
  }
}

function harness() {
  const unsigned = { txID: 'unsigned', raw_data: { expiration: 1000, contract: [] }, raw_data_hex: '00', visible: false };
  const extended = { ...unsigned, txID: 'signed-id', raw_data: { ...unsigned.raw_data, expiration: 300001 } };
  const tronWeb = {
    transactionBuilder: {
      sendTrx: mock.fn(async () => unsigned),
      extendExpiration: mock.fn(async () => extended),
    },
    trx: {
      getTransaction: mock.fn(async () => null),
    },
  };
  const signTransaction = mock.fn(async (transaction: Record<string, unknown>) => ({ ...transaction, signature: ['aa'] }));
  return { tronWeb, signTransaction };
}

describe('energy direct-purchase client', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = '1';
    delete process.env.JUSTLEND_ENERGY_API_URL;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('has no implicit production API fallback', () => {
    assert.throws(() => new EnergyPurchaseClient(), (error: unknown) =>
      error instanceof EnergyPurchaseError && error.code === 'CONFIG_MISSING');
  });

  it('exposes the nested energy purchase command tree', () => {
    const program = createProgram();
    const energy = program.commands.find(command => command.name() === 'energy');
    const purchase = energy?.commands.find(command => command.name() === 'purchase');
    assert.deepEqual(purchase?.commands.map(command => command.name()), ['config', 'quote', 'order', 'history', 'risk', 'buy']);
  });

  it('validates read-only quotes against live API limits', async () => {
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({ baseUrl: 'https://energy.example', fetch: fetchImpl });

    await assert.rejects(
      client.quote({ receivers: [RECEIVER], energyPerReceiver: 1 }),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'INVALID_AMOUNT',
    );
    assert.equal(fetchImpl.mock.callCount(), 1);
  });

  it('retries only the same signed payment and never calls a local broadcast method', async () => {
    const { tronWeb, signTransaction } = harness();
    const store = new MemoryRiskStore();
    const submitted: string[] = [];
    let buyCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) {
        return envelope({ amount_sun: 2405000, pay_address: PAY_ADDRESS, can_fulfill: true });
      }
      if (url.endsWith('/v1/consumer/energy/buy')) {
        submitted.push(JSON.parse(String(init?.body)).signed_transaction.txID);
        buyCalls += 1;
        if (buyCalls === 1) throw new Error('connection reset');
        return envelope({ id: 7, tx_id: 'signed-id', access_token: 'token', state: 'paid' });
      }
      if (url.endsWith('/v1/consumer/energy/orders/7')) return envelope({ id: 7, state: 'delivered' });
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: store,
      sleep: async () => {},
      now: () => 1,
    });

    const result = await client.purchase({
      payerAddress: PAYER,
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: '1h',
      expectedAmountSun: 2405000,
      signTransaction,
    });

    assert.deepEqual(submitted, ['signed-id', 'signed-id']);
    assert.equal(signTransaction.mock.callCount(), 1);
    assert.equal((result as any).state, 'delivered');
    assert.deepEqual(store.risks, []);
    assert.equal('sendRawTransaction' in tronWeb.trx, false);
  });

  it('rejects a concurrent purchase for the same payer before a second signature', async () => {
    const { tronWeb, signTransaction } = harness();
    const store = new MemoryRiskStore();
    let releaseConfig!: () => void;
    let markConfigStarted!: () => void;
    const configStarted = new Promise<void>(resolve => { markConfigStarted = resolve; });
    const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
    let buyCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) {
        markConfigStarted();
        await configGate;
        return envelope(config());
      }
      if (url.endsWith('/v1/price')) {
        return envelope({ amount_sun: 2405000, pay_address: PAY_ADDRESS, can_fulfill: true });
      }
      if (url.endsWith('/v1/consumer/energy/buy')) {
        buyCalls += 1;
        return envelope({ id: 8, tx_id: 'signed-id', access_token: 'token', state: 'paid' });
      }
      if (url.endsWith('/v1/consumer/energy/orders/8')) return envelope({ id: 8, state: 'delivered' });
      throw new Error(`unexpected ${url}`);
    });
    const options = {
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: store,
      sleep: async () => {},
      now: () => 1,
    };
    const firstClient = new EnergyPurchaseClient(options);
    const secondClient = new EnergyPurchaseClient(options);
    const input = {
      payerAddress: PAYER,
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: '1h',
      expectedAmountSun: 2405000,
      signTransaction,
    };

    const firstPurchase = firstClient.purchase(input);
    await configStarted;
    await assert.rejects(
      secondClient.purchase(input),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_IN_PROGRESS',
    );
    releaseConfig();
    await firstPurchase;

    assert.equal(signTransaction.mock.callCount(), 1);
    assert.equal(buyCalls, 1);
  });

  it('uses an atomic file intent to block a second process before signing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-energy-lock-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      const firstStore = new FileEnergyPaymentRiskStore(riskFile);
      const secondStore = new FileEnergyPaymentRiskStore(riskFile);
      const firstToken = firstStore.acquirePurchaseIntent(PAYER, 100, 1000);

      assert.throws(
        () => secondStore.acquirePurchaseIntent(PAYER, 101, 1001),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'PAYMENT_IN_PROGRESS',
      );

      firstStore.releasePurchaseIntent(PAYER, firstToken);
      const secondToken = secondStore.acquirePurchaseIntent(PAYER, 102, 1002);
      secondStore.releasePurchaseIntent(PAYER, secondToken);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes shared risk-file mutations across payer stores', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-risk-lock-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      const firstStore = new FileEnergyPaymentRiskStore(riskFile);
      const secondStore = new FileEnergyPaymentRiskStore(riskFile);
      const firstRisk: EnergyPaymentRisk = {
        payerAddress: PAYER,
        signedTxId: 'first',
        createdAt: 1,
        expiresAt: 2,
        paymentConfirmed: false,
      };
      const secondRisk: EnergyPaymentRisk = {
        payerAddress: SECOND_PAYER,
        signedTxId: 'second',
        createdAt: 1,
        expiresAt: 2,
        paymentConfirmed: false,
      };
      const firstInternals = firstStore as unknown as {
        writeAll(risks: EnergyPaymentRisk[]): void;
      };
      const writeAll = firstInternals.writeAll.bind(firstStore);
      firstInternals.writeAll = (risks) => {
        assert.throws(
          () => secondStore.save(secondRisk),
          (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_BUSY',
        );
        writeAll(risks);
      };

      firstStore.save(firstRisk);
      secondStore.save(secondRisk);
      assert.deepEqual(firstStore.list(PAYER), [firstRisk]);
      assert.deepEqual(firstStore.list(SECOND_PAYER), [secondRisk]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed without overwriting a corrupt payment-risk file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justlend-cli-energy-risk-'));
    try {
      const riskFile = path.join(directory, 'risks.json');
      fs.writeFileSync(riskFile, '{not-json', { mode: 0o600 });
      const store = new FileEnergyPaymentRiskStore(riskFile);

      assert.throws(
        () => store.list(PAYER),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_ERROR',
      );
      assert.throws(
        () => store.save({ payerAddress: PAYER, signedTxId: 'tx', createdAt: 1, expiresAt: 2, paymentConfirmed: false }),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_ERROR',
      );
      assert.equal(fs.readFileSync(riskFile, 'utf8'), '{not-json');

      const invalidSchema = JSON.stringify([{ payerAddress: PAYER, signedTxId: 'tx' }]);
      fs.writeFileSync(riskFile, invalidSchema, { mode: 0o600 });
      assert.throws(
        () => store.list(PAYER),
        (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'RISK_STORAGE_ERROR',
      );
      assert.equal(fs.readFileSync(riskFile, 'utf8'), invalidSchema);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects any authoritative quote change before signing', async () => {
    const { tronWeb, signTransaction } = harness();
    let buyCalls = 0;
    const fetchImpl = mock.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/config')) return envelope(config());
      if (url.endsWith('/v1/price')) {
        return envelope({ amount_sun: 2404999, pay_address: PAY_ADDRESS, can_fulfill: true });
      }
      if (url.endsWith('/v1/consumer/energy/buy')) {
        buyCalls += 1;
        return envelope({});
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new EnergyPurchaseClient({
      baseUrl: 'https://energy.example',
      fetch: fetchImpl,
      tronWeb: tronWeb as any,
      storage: new MemoryRiskStore(),
      now: () => 1,
    });

    await assert.rejects(
      client.purchase({
        payerAddress: PAYER,
        receivers: [RECEIVER],
        energyPerReceiver: 65000,
        duration: '1h',
        expectedAmountSun: 2405000,
        signTransaction,
      }),
      (error: unknown) => error instanceof EnergyPurchaseError && error.code === 'AMOUNT_CHANGED',
    );

    assert.equal(signTransaction.mock.callCount(), 0);
    assert.equal(buyCalls, 0);
  });
});
