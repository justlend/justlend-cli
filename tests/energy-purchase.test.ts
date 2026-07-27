import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  EnergyPurchaseClient,
  EnergyPurchaseError,
  type EnergyPaymentRisk,
  type StorageLike,
} from '../src/lib/energy-purchase.js';
import { createProgram } from '../src/index.js';

const PAYER = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
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
  list(payerAddress: string) { return this.risks.filter(risk => risk.payerAddress === payerAddress); }
  save(risk: EnergyPaymentRisk) {
    this.risks = this.risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
    this.risks.push({ ...risk });
  }
  remove(payerAddress: string, signedTxId?: string) {
    this.risks = this.risks.filter(risk => risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId));
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
});

