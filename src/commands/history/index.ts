import { Command } from 'commander';
import { fetchMoolahHistory, fetchLiquidationRecords } from '../../lib/api/v2.js';
import { getNetworkFromCommand, parsePositiveInteger, pick, requireMoolahMainnet, shorten } from '../../lib/command-utils.js';
import { validateAddress } from '../../lib/tronweb.js';
import { outputList, outputResult } from '../../lib/output.js';
import {
  fetchLendingRecords,
  fetchStrxRecords,
  fetchVoteRecords,
  fetchEnergyRentalRecords,
} from '../../lib/records.js';

type HistoryType = 'moolah' | 'lend' | 'strx' | 'vote' | 'energy' | 'liquidation';

const TYPES: HistoryType[] = ['moolah', 'lend', 'strx', 'vote', 'energy', 'liquidation'];

function summarize(row: any): Record<string, unknown> {
  return {
    time: pick(row, ['time', 'timestamp', 'blockTime', 'blockTimestamp', 'createdAt', 'createTime']),
    type: pick(row, ['type', 'action', 'actionName', 'opName', 'actionType', 'opType', 'recordType', 'event']),
    market: shorten(pick(row, ['marketId', 'market', 'vaultAddress', 'jtokenAddress', 'jTokenAddress']) as unknown),
    token: pick(row, ['symbol', 'tokenSymbol', 'assetSymbol', 'collateralSymbol']),
    amount: pick(row, ['amount', 'assets', 'shares', 'tokenAmount', 'value']),
    tx: shorten(pick(row, ['txId', 'txHash', 'transactionHash', 'hash']) as unknown),
  };
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history <address>')
    .description('Show cross-module transaction history. Supported --type: moolah | lend | strx | vote | energy | liquidation')
    .option('--type <type>', `History type filter (one of: ${TYPES.join(', ')})`, 'moolah')
    .option('--time-filter <filter>', 'Backend time filter, e.g. 7d/30d/all (V2 backend only)', 'all')
    .option('--page <n>', 'Page number', parsePositiveInteger, 1)
    .option('--page-size <n>', 'Page size', parsePositiveInteger, 20)
    .action(async function (this: Command, address: string) {
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const local = this.opts();
      const type = String(local.type).toLowerCase() as HistoryType;
      if (!TYPES.includes(type)) {
        throw new Error(`Unsupported --type "${local.type}". Supported: ${TYPES.join(', ')}`);
      }
      const network = getNetworkFromCommand(this);
      const isJson = Boolean(opts.json);

      if (type === 'moolah') {
        requireMoolahMainnet(network);
        const { list, total } = await fetchMoolahHistory(network, {
          userAddress: address,
          timeFilter: local.timeFilter,
          pageNo: local.page,
          pageSize: local.pageSize,
        });
        outputList(list.map(summarize), `V2 Moolah History (${total} total)`, isJson);
        return;
      }

      if (type === 'liquidation') {
        // Try V2 endpoint first (Moolah liquidations on mainnet), then fall back to V1
        try {
          requireMoolahMainnet(network);
          const { list, total } = await fetchLiquidationRecords(network, { page: local.page, pageSize: local.pageSize });
          const filtered = list.filter(row => {
            const candidate = `${row?.user ?? ''}${row?.borrower ?? ''}${row?.liquidator ?? ''}`.toLowerCase();
            return !address || candidate.includes(address.toLowerCase());
          });
          if (filtered.length > 0) {
            outputList(filtered.map(summarize), `V2 Liquidation Records (${filtered.length}/${total})`, isJson);
            return;
          }
        } catch {
          // fall through to V1 records endpoint
        }
        const { fetchLiquidationRecords: fetchV1Liquidations } = await import('../../lib/records.js');
        const page = await fetchV1Liquidations(address, local.page, local.pageSize, network);
        outputList(page.items.map(summarize), `Liquidation Records (${page.items.length}/${page.totalCount})`, isJson);
        return;
      }

      // V1 records via labc.ablesdxd.link — confirmed endpoints from MCP audit.
      const network_ = network as string;
      if (type === 'lend') {
        const page = await fetchLendingRecords(address, local.page, local.pageSize, network_);
        outputList(page.items.map(summarize), `Lending History (${page.items.length}/${page.totalCount})`, isJson);
        return;
      }
      if (type === 'strx') {
        const page = await fetchStrxRecords(address, local.page, local.pageSize, network_);
        outputList(page.items.map(summarize), `sTRX History (${page.items.length}/${page.totalCount})`, isJson);
        return;
      }
      if (type === 'vote') {
        const page = await fetchVoteRecords(address, local.page, local.pageSize, network_);
        outputList(page.items.map(summarize), `Vote History (${page.items.length}/${page.totalCount})`, isJson);
        return;
      }
      if (type === 'energy') {
        const page = await fetchEnergyRentalRecords(address, local.page, local.pageSize, network_);
        outputList(page.items.map(summarize), `Energy Rental History (${page.items.length}/${page.totalCount})`, isJson);
        return;
      }

      // Unreachable — TYPES validated above
      outputResult({ type, address, note: 'unsupported type' }, 'history', isJson);
    });
}
