import { Command } from 'commander';
import { COMPTROLLER_ABI, JTOKEN_ABI, JTRX_MINT_ABI, JTRX_REPAY_ABI } from '../../lib/abis.js';
import { fetchV1Markets, findV1Market } from '../../lib/api/v1.js';
import { JUSTLEND_ADDRESSES } from '../../lib/chains.js';
import { getNetworkFromCommand, pick, shorten } from '../../lib/command-utils.js';
import { outputList, outputResult } from '../../lib/output.js';
import { sendContractTx } from '../../lib/tx.js';
import { getTronWeb, validateAddress } from '../../lib/tronweb.js';
import { utils } from '../../lib/utils.js';
import { optionalRead, warningFields } from '../../lib/optional-read.js';

function marketInfo(network: ReturnType<typeof getNetworkFromCommand>, token: string) {
  const cfg = JUSTLEND_ADDRESSES[network];
  const direct = cfg.jTokens[token] ?? cfg.jTokens[token.toUpperCase()] ?? cfg.jTokens[`j${token.toUpperCase()}`];
  if (direct) return direct;
  const wanted = token.toUpperCase();
  const found = Object.values(cfg.jTokens).find(item =>
    item.symbol.toUpperCase() === wanted || item.underlyingSymbol.toUpperCase() === wanted || item.address.toUpperCase() === wanted,
  );
  if (!found) throw new Error(`Unknown V1 market/token "${token}". Available: ${Object.keys(cfg.jTokens).join(', ')}`);
  return found;
}

function formatRaw(value: unknown, decimals: number): string {
  return utils.formatUnits(BigInt(value?.toString?.() ?? String(value ?? 0)), decimals);
}

export function registerV1Commands(program: Command): void {
  const v1 = program
    .command('v1')
    .description('JustLend V1 legacy lending commands');

  const market = v1
    .command('market')
    .description('V1 jToken market read commands');

  market
    .command('list')
    .description('List V1 jToken markets')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const { list, assetPrice, source, warning, backendError } = await fetchV1Markets(network);
      const rows = list.map(row => ({
        token: row.collateralSymbol,
        jToken: shorten(row.jtokenAddress),
        supplyAPY: row.depositedAPY,
        borrowAPY: row.borrowedAPY,
        totalSupply: pick(row, ['totalDeposited', 'depositedTotal', 'totalSupply']),
        totalBorrow: pick(row, ['totalBorrowed', 'borrowedTotal', 'totalBorrows']),
        rawPrice: row.collateralAddress ? assetPrice[row.collateralAddress] : undefined,
      }));
      outputList(rows, `V1 Markets (${list.length} total)`, !!opts.json, {
        source,
        warning,
        backendError,
      });
    });

  market
    .command('info <token>')
    .description('Show V1 single market detail')
    .action(async function (this: Command, token: string) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const { list, assetPrice, source } = await fetchV1Markets(network);
      const row = findV1Market(list, token);
      if (!row) {
        const available = Array.from(new Set(list.map(item => item.collateralSymbol).filter(Boolean))).sort().join(', ');
        throw new Error(`Token "${token}" not found on ${network}. Available: ${available}`);
      }
      outputResult({
        ...row,
        rawPrice: row.collateralAddress ? assetPrice[row.collateralAddress] : undefined,
        source,
        network,
      }, `V1 Market ${row.collateralSymbol ?? token}`, !!opts.json);
    });

  v1
    .command('position <address>')
    .description('Show V1 user supply/borrow position')
    .action(async function (this: Command, address: string) {
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const cfg = JUSTLEND_ADDRESSES[network];
      const tronWeb = getTronWeb(network);
      const comptroller = tronWeb.contract(COMPTROLLER_ABI as any, cfg.comptroller) as any;
      const warningSink = { warnings: [] as string[] };
      const [liquidity, assetsIn] = await Promise.all([
        optionalRead<any>('v1.position.getAccountLiquidity', warningSink, () => comptroller.methods.getAccountLiquidity(address).call()),
        optionalRead<string[]>('v1.position.getAssetsIn', warningSink, () => comptroller.methods.getAssetsIn(address).call()),
      ]);
      const rows = await Promise.all(Object.values(cfg.jTokens).map(async info => {
        const contract = tronWeb.contract(JTOKEN_ABI as any, info.address) as any;
        const snapshot = await optionalRead<any>(`v1.position.getAccountSnapshot(${info.symbol})`, warningSink, () => contract.methods.getAccountSnapshot(address).call());
        const collateralEnabled = Array.isArray(assetsIn) && assetsIn.some((asset: string) => asset === info.address);
        return {
          token: info.underlyingSymbol,
          jToken: info.symbol,
          supplied: formatRaw(snapshot?.jTokenBalance ?? snapshot?.[1] ?? 0, info.decimals),
          borrowed: formatRaw(snapshot?.borrowBalance ?? snapshot?.[2] ?? 0, info.underlyingDecimals),
          collateral: collateralEnabled,
        };
      }));
      outputResult({
        address,
        network,
        liquidityRaw: (liquidity?.liquidity ?? liquidity?.[1])?.toString?.(),
        shortfallRaw: (liquidity?.shortfall ?? liquidity?.[2])?.toString?.(),
        positions: rows.filter(row => row.supplied !== '0' || row.borrowed !== '0' || row.collateral),
        ...warningFields(warningSink),
      }, 'V1 Position', !!opts.json);
    });

  v1.command('deposit <token> <amount>').description('V1 mint jToken').action(async function (this: Command, token: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const info = marketInfo(network, token);
    const raw = utils.parseUnits(amount, info.underlyingDecimals);
    await sendContractTx({
      command: this,
      contractAddress: info.address,
      abi: info.underlying ? JTOKEN_ABI : JTRX_MINT_ABI,
      functionName: 'mint',
      args: info.underlying ? [raw.toString()] : [],
      callValue: info.underlying ? 0n : raw,
      preview: { action: 'V1 deposit', token: info.underlyingSymbol, amount },
    });
  });

  v1.command('withdraw <token> <amount>').description('V1 redeem underlying').action(async function (this: Command, token: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const info = marketInfo(network, token);
    const raw = utils.parseUnits(amount, info.underlyingDecimals);
    await sendContractTx({
      command: this,
      contractAddress: info.address,
      abi: JTOKEN_ABI,
      functionName: 'redeemUnderlying',
      args: [raw.toString()],
      preview: { action: 'V1 withdraw underlying', token: info.underlyingSymbol, amount },
    });
  });

  v1.command('borrow <token> <amount>').description('V1 borrow').action(async function (this: Command, token: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const info = marketInfo(network, token);
    const raw = utils.parseUnits(amount, info.underlyingDecimals);
    await sendContractTx({ command: this, contractAddress: info.address, abi: JTOKEN_ABI, functionName: 'borrow', args: [raw.toString()], preview: { action: 'V1 borrow', token: info.underlyingSymbol, amount } });
  });

  v1.command('repay <token> <amount>').description('V1 repay').action(async function (this: Command, token: string, amount: string) {
    const network = getNetworkFromCommand(this);
    const info = marketInfo(network, token);
    const raw = utils.parseUnits(amount, info.underlyingDecimals);
    await sendContractTx({
      command: this,
      contractAddress: info.address,
      abi: info.underlying ? JTOKEN_ABI : JTRX_REPAY_ABI,
      functionName: 'repayBorrow',
      args: [raw.toString()],
      callValue: info.underlying ? 0n : raw,
      preview: { action: 'V1 repay', token: info.underlyingSymbol, amount },
    });
  });

  v1.command('collateral-enable <token>').description('V1 enable as collateral').action(async function (this: Command, token: string) {
    const network = getNetworkFromCommand(this);
    const info = marketInfo(network, token);
    await sendContractTx({ command: this, contractAddress: JUSTLEND_ADDRESSES[network].comptroller, abi: COMPTROLLER_ABI, functionName: 'enterMarkets', args: [[info.address]], preview: { action: 'V1 enable collateral', token: info.underlyingSymbol, jToken: info.address } });
  });

  v1.command('collateral-disable <token>').description('V1 disable as collateral').action(async function (this: Command, token: string) {
    const network = getNetworkFromCommand(this);
    const info = marketInfo(network, token);
    await sendContractTx({ command: this, contractAddress: JUSTLEND_ADDRESSES[network].comptroller, abi: COMPTROLLER_ABI, functionName: 'exitMarket', args: [info.address], preview: { action: 'V1 disable collateral', token: info.underlyingSymbol, jToken: info.address } });
  });
}
