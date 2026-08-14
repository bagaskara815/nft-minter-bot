// seadrop.js — OpenSea Seadrop v1/v2 detection, public-drop config, price
import { ethers } from 'ethers';

export const SEADROP_V1 = '0x00000000006c3852cbEf3e08E8dF289169EdE581';
export const SEADROP_V2 = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

const SEADROP_ABI = [
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowListMerkleRoot(address) view returns (bytes32)',
  'function getAllowedFeeRecipients(address) view returns (address[])',
  'function getCreatorPayoutAddress(address) view returns (address)',
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable',
];

const TOKEN_ABI = [
  'function maxSupply() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function baseURI() view returns (string)',
];

// Determine whether a token contract is wired to Seadrop, and which version.
// Returns { version:'v1'|'v2'|null, seadrop:address|null }.
export async function detectSeadrop(nftContract, provider) {
  for (const [version, addr] of [['v2', SEADROP_V2], ['v1', SEADROP_V1]]) {
    const c = new ethers.Contract(addr, SEADROP_ABI, provider);
    try {
      const drop = await c.getPublicDrop(nftContract);
      // v2 getPublicDrop returns a zero tuple (no revert) for tokens it does
      // NOT manage, so a response alone is not proof. Require real evidence:
      // a configured drop (price/time set) or a non-zero allowlist root, or
      // allowed fee recipients registered for this token.
      const configured =
        drop.mintPrice > 0n || Number(drop.startTime) > 0 || Number(drop.endTime) > 0;
      let hasEvidence = configured;
      if (!hasEvidence) {
        try {
          const fr = await c.getAllowedFeeRecipients(nftContract);
          hasEvidence = Array.isArray(fr) && fr.length > 0;
        } catch { /* ignore */ }
      }
      if (!hasEvidence) {
        try {
          const root = await c.getAllowListMerkleRoot(nftContract);
          hasEvidence = !/^0x0*$/.test(root);
        } catch { /* ignore */ }
      }
      if (hasEvidence) return { version, seadrop: addr };
    } catch {
      // getPublicDrop reverts when the token isn't managed by this Seadrop.
      continue;
    }
  }
  return { version: null, seadrop: null };
}

// Read the public-drop config from a Seadrop contract. Returns null if unset.
export async function getPublicDrop(seadropAddr, nftContract, provider) {
  const c = new ethers.Contract(seadropAddr, SEADROP_ABI, provider);
  const d = await c.getPublicDrop(nftContract);
  return {
    mintPrice: d.mintPrice,
    startTime: Number(d.startTime),
    endTime: Number(d.endTime),
    maxPerWallet: Number(d.maxTotalMintableByWallet),
    feeBps: Number(d.feeBps),
    restrictFeeRecipients: d.restrictFeeRecipients,
  };
}

export async function getAllowlistRoot(seadropAddr, nftContract, provider) {
  const c = new ethers.Contract(seadropAddr, SEADROP_ABI, provider);
  try {
    const root = await c.getAllowListMerkleRoot(nftContract);
    return /^0x0*$/.test(root) ? null : root;
  } catch {
    return null;
  }
}

// Resolve the first allowed fee recipient (required arg for mintPublic).
export async function getFeeRecipient(seadropAddr, nftContract, provider) {
  const c = new ethers.Contract(seadropAddr, SEADROP_ABI, provider);
  try {
    const list = await c.getAllowedFeeRecipients(nftContract);
    if (list && list.length) return list[0];
  } catch { /* fall through */ }
  return ethers.ZeroAddress;
}

// Token-contract readiness snapshot (maxSupply/baseURI/totalSupply).
export async function tokenStatus(nftContract, provider) {
  const c = new ethers.Contract(nftContract, TOKEN_ABI, provider);
  const out = {};
  try { out.maxSupply = await c.maxSupply(); } catch { out.maxSupply = null; }
  try { out.totalSupply = await c.totalSupply(); } catch { out.totalSupply = null; }
  try { out.baseURI = await c.baseURI(); } catch { out.baseURI = null; }
  return out;
}

// Build the mintPublic transaction request for a Seadrop drop.
export async function buildSeadropMint({ seadropAddr, nftContract, minter, quantity, provider }) {
  const drop = await getPublicDrop(seadropAddr, nftContract, provider);
  const feeRecipient = await getFeeRecipient(seadropAddr, nftContract, provider);
  const iface = new ethers.Interface(SEADROP_ABI);
  const data = iface.encodeFunctionData('mintPublic', [
    nftContract,
    feeRecipient,
    ethers.ZeroAddress, // minterIfNotPayer = payer
    quantity,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const active = drop.startTime <= now && (drop.endTime === 0 || drop.endTime >= now);
  return {
    to: seadropAddr,
    data,
    value: drop.mintPrice * BigInt(quantity),
    drop,
    feeRecipient,
    active,
  };
}

// Build the mintAllowList transaction request for an allowlisted wallet.
// `mintParams` is the 8-field tuple and `proof` the bytes32[] merkle proof,
// both taken from the allowlist tree entry (see allowlist.js).
export async function buildAllowListMint({ seadropAddr, nftContract, quantity, mintParams, proof, provider }) {
  const feeRecipient = await getFeeRecipient(seadropAddr, nftContract, provider);
  const iface = new ethers.Interface(SEADROP_ABI);
  const data = iface.encodeFunctionData('mintAllowList', [
    nftContract,
    feeRecipient,
    ethers.ZeroAddress, // minterIfNotPayer = payer
    quantity,
    mintParams,
    proof,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const mintPrice = mintParams[0];
  const startTime = Number(mintParams[2]);
  const endTime = Number(mintParams[3]);
  const active = startTime <= now && (endTime === 0 || endTime >= now);
  return {
    to: seadropAddr,
    data,
    value: mintPrice * BigInt(quantity),
    startTime,
    endTime,
    feeRecipient,
    active,
  };
}
