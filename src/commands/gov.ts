import { Command } from 'commander';
import { GOVERNOR_ALPHA_ABI, POLY_ABI, WJST_ABI } from '../lib/abis.js';
import { JUSTLEND_ADDRESSES } from '../lib/chains.js';
import { getNetworkFromCommand, parseNonNegativeInteger } from '../lib/command-utils.js';
import { outputList, outputResult } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { getTronWeb, validateAddress } from '../lib/tronweb.js';
import { utils } from '../lib/utils.js';
import { optionalRead, warningFields } from '../lib/optional-read.js';

const PROPOSAL_STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'];
const PROPOSAL_TITLES: Record<number, string> = {
  17: '新增 sTRX 市场 | Add sTRX Market',
  20: '新增 wstUSDT 市场 | Add wstUSDT Market',
  31: 'Proposal to add the USDD V2.0 Market',
  36: 'Proposal to add the USD1 Market',
  37: 'Proposal on JST Buyback & Burn Program',
  38: 'Proposal to add the WBTC Market',
  39: 'Proposal to Lower the Collateral Factor of USDDOLD Market to 50%',
};

function formatJst(value: unknown): string {
  return utils.formatUnits(BigInt(value?.toString?.() ?? String(value ?? 0)), 18);
}

function supportToNumber(choice: string): number {
  const normalized = choice.toLowerCase();
  if (normalized === 'for' || normalized === 'yes' || normalized === '1') return 1;
  if (normalized === 'against' || normalized === 'no' || normalized === '0') return 0;
  if (normalized === 'abstain' || normalized === '2') return 2;
  throw new Error('choice must be one of: for, against, abstain');
}

type GovernorProposal = Record<string, unknown> & Record<number, unknown>;
type VoteInfo = Record<string, unknown> & Record<number, unknown>;

export function registerGovCommands(program: Command): void {
  const gov = program.command('gov').description('JustLend governance commands');

  gov.command('list').description('List recent governance proposals').option('--limit <n>', 'Number of proposals', '20').action(async function (this: Command) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const contract = getTronWeb(network).contract(GOVERNOR_ALPHA_ABI as any, cfg.governorAlpha) as any;
    const countRaw = await contract.methods.proposalCount().call();
    const count = Number(countRaw.toString());
    const limit = Math.max(1, Math.min(50, Number(this.opts().limit ?? 20)));
    const ids = Array.from({ length: Math.min(limit, count) }, (_, index) => count - index).filter(id => id > 0);
    const warningSink = { warnings: [] as string[] };
    const rows = await Promise.all(ids.map(async proposalId => {
      const state = await optionalRead<unknown>(`governor.state(${proposalId})`, warningSink, () => contract.methods.state(proposalId).call());
      return {
        proposalId,
        state: state == null ? undefined : PROPOSAL_STATES[Number(state.toString())] ?? state.toString(),
        title: PROPOSAL_TITLES[proposalId] ?? `[Proposal #${proposalId}]`,
      };
    }));
    outputList(rows, `Governance Proposals (${count} total)`, Boolean(opts.json), {
      ...warningFields(warningSink),
    });
  });

  gov.command('info <proposalId>').description('Show governance proposal details').action(async function (this: Command, proposalId: string) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const contract = getTronWeb(network).contract(GOVERNOR_ALPHA_ABI as any, cfg.governorAlpha) as any;
    const warningSink = { warnings: [] as string[] };
    const [state, proposal] = await Promise.all([
      optionalRead<unknown>(`governor.state(${proposalId})`, warningSink, () => contract.methods.state(proposalId).call()),
      optionalRead<GovernorProposal>(`governor.proposals(${proposalId})`, warningSink, () => contract.methods.proposals(proposalId).call()),
    ]);
    // GovernorAlpha returns a zero-filled struct for unknown proposalIds and reverts
    // on `state(id)`. Surface that as a clear not-found error instead of a structurally
    // successful response full of zeros.
    const proposerRaw = String(proposal?.proposer ?? proposal?.[1] ?? '');
    const isZeroProposer = /^41[0]{40}$/i.test(proposerRaw);
    if (state == null && isZeroProposer) {
      throw new Error(`Proposal #${proposalId} does not exist on ${network}`);
    }
    outputResult({
      proposalId,
      title: PROPOSAL_TITLES[Number(proposalId)] ?? `[Proposal #${proposalId}]`,
      state: state == null ? undefined : PROPOSAL_STATES[Number(state.toString())] ?? state.toString(),
      proposer: proposal?.proposer ?? proposal?.[1],
      startBlock: (proposal?.startBlock ?? proposal?.[3])?.toString?.(),
      endBlock: (proposal?.endBlock ?? proposal?.[4])?.toString?.(),
      forVotes: formatJst(proposal?.forVotes ?? proposal?.[5] ?? 0),
      againstVotes: formatJst(proposal?.againstVotes ?? proposal?.[6] ?? 0),
      abstainVotes: formatJst(proposal?.abstainVotes ?? proposal?.[7] ?? 0),
      canceled: proposal?.canceled ?? proposal?.[8],
      executed: proposal?.executed ?? proposal?.[9],
      ...warningFields(warningSink),
    }, 'Governance Proposal', Boolean(opts.json));
  });

  gov.command('power <address>').description('Show governance voting power').action(async function (this: Command, address: string) {
    validateAddress(address);
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const tronWeb = getTronWeb(network);
    const poly = tronWeb.contract(POLY_ABI as any, cfg.poly) as any;
    const wjst = tronWeb.contract(WJST_ABI as any, cfg.wjst) as any;
    const warningSink = { warnings: [] as string[] };
    const [voteInfo, wjstBalance] = await Promise.all([
      optionalRead<VoteInfo>('poly.getVoteInfo', warningSink, () => poly.methods.getVoteInfo(address, cfg.jst, cfg.wjst).call()),
      optionalRead<unknown>('wJST.balanceOf', warningSink, () => wjst.methods.balanceOf(address).call()),
    ]);
    outputResult({
      address,
      network,
      jstBalance: formatJst(voteInfo?.jstBalance ?? voteInfo?.[0] ?? 0),
      surplusVotes: formatJst(voteInfo?.surplusVotes ?? voteInfo?.[1] ?? 0),
      totalVotes: formatJst(voteInfo?.totalVote ?? voteInfo?.[2] ?? 0),
      castVotes: formatJst(voteInfo?.castVote ?? voteInfo?.[3] ?? 0),
      wjstBalance: wjstBalance === undefined ? undefined : formatJst(wjstBalance),
      ...warningFields(warningSink),
    }, 'Governance Power', Boolean(opts.json));
  });

  gov.command('vote <proposalId> <choice>').description('Cast governance vote').option('--votes <amount>', 'Votes to cast, defaults to 0').action(async function (this: Command, proposalId: string, choice: string) {
    const proposalIdNum = parseNonNegativeInteger(proposalId);
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const votes = utils.parseUnits(this.opts().votes ?? '0', 18);
    await sendContractTx({
      command: this,
      contractAddress: cfg.governorAlpha,
      abi: GOVERNOR_ALPHA_ABI,
      functionName: 'castVote',
      args: [proposalIdNum, votes.toString(), supportToNumber(choice)],
      preview: { action: 'cast governance vote', proposalId, choice, votes: this.opts().votes ?? '0' },
    });
  });

  gov.command('redeem <proposalId>').description('Withdraw votes from proposal').action(async function (this: Command, proposalId: string) {
    const proposalIdNum = parseNonNegativeInteger(proposalId);
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    await sendContractTx({
      command: this,
      contractAddress: cfg.governorAlpha,
      abi: GOVERNOR_ALPHA_ABI,
      functionName: 'withdrawVotes',
      args: [proposalIdNum],
      preview: { action: 'withdraw proposal votes', proposalId },
    });
  });

  gov.command('exchange <amount>').description('Exchange JST for voting power (wrap JST to wJST)').action(async function (this: Command, amount: string) {
    const network = getNetworkFromCommand(this);
    const cfg = JUSTLEND_ADDRESSES[network];
    const raw = utils.parseUnits(amount, 18);
    await sendContractTx({
      command: this,
      contractAddress: cfg.wjst,
      abi: WJST_ABI,
      functionName: 'deposit',
      args: [raw.toString()],
      preview: { action: 'wrap JST to voting power', amount: `${amount} JST` },
    });
  });
}
