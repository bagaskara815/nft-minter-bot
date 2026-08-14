// allowlist.js — resolve a wallet's Seadrop allowlist eligibility.
//
// Flow: getAllowListMerkleRoot → if zero, no allowlist (public only).
// Else fetch the allowListURI from the AllowListUpdated event log, download the
// tree JSON, and look up the wallet. The JSON already ships the merkle `proof`
// and `mintParams` per wallet, so no local merkle computation is needed.
import { ethers } from 'ethers';

// keccak256("AllowListUpdated(address,bytes32,bytes32,string[],string)")
const ALLOWLIST_UPDATED_TOPIC0 =
  '0xefcd7e019bc8b47d27881fd59e2619280ca5894f285950f10ab049870652efa5';

// Event data layout: (string[] publicKeyURI, string allowListURI). Indexed args
// (nftContract, prev/new root) live in topics, not data.
const ALLOWLIST_EVENT_ABI = [
  'event AllowListUpdated(address indexed nftContract, bytes32 indexed previousMerkleRoot, bytes32 indexed newMerkleRoot, string[] publicKeyURI, string allowListURI)',
];

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

function normalizeUri(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
  return uri;
}

// Fetch the most recent allowListURI emitted for `nftContract` on `seadropAddr`.
// Returns null when no such event exists.
async function fetchAllowListUri(seadropAddr, nftContract, provider) {
  const topics = [
    ALLOWLIST_UPDATED_TOPIC0,
    ethers.zeroPadValue(ethers.getAddress(nftContract), 32),
  ];
  let logs;
  try {
    logs = await provider.getLogs({ address: seadropAddr, topics, fromBlock: 0, toBlock: 'latest' });
  } catch {
    return null; // RPC block-range limits, etc. — treat as unknown.
  }
  if (!logs || !logs.length) return null;

  const iface = new ethers.Interface(ALLOWLIST_EVENT_ABI);
  const last = logs[logs.length - 1]; // most recent update wins
  try {
    const parsed = iface.parseLog(last);
    return normalizeUri(parsed.args.allowListURI);
  } catch {
    return null;
  }
}

// Download and index the allowlist tree keyed by lowercased address.
async function fetchTree(uri) {
  const r = await fetch(uri, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`allowlist fetch ${r.status}`);
  const j = await r.json();

  // Accept the common shapes: { allowList:[...] }, { merkleTree:[...] }, or a bare array.
  const list = Array.isArray(j) ? j : j.allowList || j.merkleTree || j.entries || [];
  const byAddr = new Map();
  for (const e of list) {
    const addr = (e.address || e.minter || e.wallet || '').toLowerCase();
    if (addr) byAddr.set(addr, e);
  }
  return { root: j.merkleRoot || null, byAddr };
}

// Normalize an entry's mintParams into the tuple order Seadrop's ABI expects.
function toMintParams(mp) {
  return [
    BigInt(mp.mintPrice ?? 0),
    BigInt(mp.maxTotalMintableByWallet ?? 0),
    BigInt(mp.startTime ?? 0),
    BigInt(mp.endTime ?? 0),
    BigInt(mp.dropStageIndex ?? 0),
    BigInt(mp.maxTokenSupplyForStage ?? 0),
    BigInt(mp.feeBps ?? 0),
    Boolean(mp.restrictFeeRecipients ?? false),
  ];
}

// Check a wallet's allowlist eligibility for a Seadrop drop.
// Returns:
//   { eligible:false }                         — no allowlist configured (mint public)
//   { eligible:false, hasAllowlist:true }       — allowlist exists but wallet not on it
//   { eligible:true, mintParams, proof, raw }   — wallet is on the allowlist
export async function checkAllowlist(seadropAddr, nftContract, minter, provider, root) {
  if (!root) return { eligible: false, hasAllowlist: false };

  const uri = await fetchAllowListUri(seadropAddr, nftContract, provider);
  if (!uri) return { eligible: false, hasAllowlist: true, reason: 'allowListURI not found in event logs' };

  let tree;
  try {
    tree = await fetchTree(uri);
  } catch (e) {
    return { eligible: false, hasAllowlist: true, reason: `allowlist unreachable: ${e.message}` };
  }

  const entry = tree.byAddr.get(minter.toLowerCase());
  if (!entry) return { eligible: false, hasAllowlist: true, reason: 'wallet not on allowlist' };

  const mp = entry.mintParams || entry.params;
  const proof = entry.proof || entry.proofs;
  if (!mp || !Array.isArray(proof)) {
    return { eligible: false, hasAllowlist: true, reason: 'allowlist entry missing mintParams/proof' };
  }
  return { eligible: true, mintParams: toMintParams(mp), proof, raw: mp };
}
