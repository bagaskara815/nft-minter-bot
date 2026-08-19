// mint.js — universal mint engine: detect fn → price → gas → simulate → send → report
import { ethers } from 'ethers';
import { getProvider, explorerUrl } from './chains.js';
import { detectSeadrop, buildSeadropMint, buildAllowListMint, getAllowlistRoot, getMintMechanisms, tokenStatus } from './seadrop.js';
import { checkAllowlist } from './allowlist.js';
import { getEligibleLists, pickBestList, buildScatterMint } from './scatter.js';
import { buildOpenseaMint, explainOpenseaError } from './opensea-drop.js';
import { getSessionCookies } from './opensea-auth.js';
import { fmtWIB } from './time.js';

// Ordered by specificity. Protocol-tagged entries are handled specially.
const MINT_SIGNATURES = [
  { sig: 'mintPublic(uint256)', args: ['amount'] },
  { sig: 'publicMint(uint256)', args: ['amount'] },
  { sig: 'mint(uint256)', args: ['amount'] },
  { sig: 'claim(uint256)', args: ['amount'] },
  { sig: 'mint(address,uint256)', args: ['to', 'amount'] },
  { sig: 'claim(address,uint256)', args: ['to', 'amount'] },
  { sig: 'mint(address,uint256,uint256,bytes)', args: ['to', 'id', 'amount', 'data'] },
  { sig: 'mint()', args: [] },
];

const PRICE_READERS = [
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function PRICE() view returns (uint256)',
  'function publicSalePrice() view returns (uint256)',
];

function synthArg(name, addr, amount) {
  switch (name) {
    case 'to': return addr;
    case 'amount': return BigInt(amount || 1);
    case 'id': return 0n;
    case 'data': return '0x';
    default: return 0n;
  }
}

function buildArgs(fn, addr, amount) {
  return fn.args.map((a) => synthArg(a, addr, amount));
}

// Probe candidate mint signatures via eth_call. A revert with data means the
// function exists but needs payment/proof — still a match.
async function detectMintFunction(contract, signer, amount) {
  for (const fn of MINT_SIGNATURES) {
    const name = fn.sig.split('(')[0];
    const iface = new ethers.Interface([`function ${fn.sig} payable`]);
    const data = iface.encodeFunctionData(name, buildArgs(fn, signer.address, amount));
    try {
      await signer.provider.call({ to: contract, from: signer.address, data, value: 0 });
      return fn;
    } catch (e) {
      const errData = e?.data ?? e?.info?.error?.data;
      if (errData && errData !== '0x') return fn; // exists, reverted on state/payment
      continue;
    }
  }
  throw new Error('no recognized mint function');
}

async function detectPrice(contract, provider, amount = 1) {
  for (const sig of PRICE_READERS) {
    try {
      const name = sig.match(/function (\w+)/)[1];
      const c = new ethers.Contract(contract, [sig], provider);
      const p = await c[name]();
      if (typeof p === 'bigint') return p * BigInt(amount);
    } catch { continue; }
  }
  return 0n;
}

// Estimate gas with a 20% buffer and derive EIP-1559 fees with headroom.
async function autoGas(provider, txRequest) {
  const feeData = await provider.getFeeData();
  let gasLimit;
  try {
    gasLimit = (await provider.estimateGas(txRequest)) * 120n / 100n;
  } catch (e) {
    throw new Error(`gas estimate failed (likely revert): ${e.shortMessage || e.message}`);
  }

  // Legacy-fee chains (no maxFeePerGas): use gasPrice.
  if (feeData.maxFeePerGas == null) {
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');
    return { gasLimit, gasPrice };
  }

  const priorityFee = feeData.maxPriorityFeePerGas
    ? feeData.maxPriorityFeePerGas * 110n / 100n
    : ethers.parseUnits('1.5', 'gwei');
  const base = feeData.maxFeePerGas;
  const maxFee = base * 2n + priorityFee;
  return { gasLimit, maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee };
}

function parseRevert(e) {
  return e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || 'unknown revert';
}

// Mint one target with one wallet. `onEvent` receives progress updates for UIs.
export async function mintOne(target, wallet, onEvent = () => {}) {
  const provider = getProvider(target.chain);
  const signer = wallet.connect(provider);
  const amount = target.amount || 1;

  onEvent({ stage: 'target', contract: target.contract, chain: target.chain, amount });

  // Scatter.art collections use a custom mint entrypoint; the API builds the
  // tx (proof + signature). Handle entirely here, then return.
  if (target.source === 'scatter') {
    return await mintScatter(target, signer, provider, amount, onEvent);
  }

  // OpenSea Drops (OS2): the mint tx is generated server-side via GraphQL
  // (relayer + requestId). Only route here when we have the collection slug
  // (collection URL). Assets URLs without a slug fall through to Seadrop.
  if (target.source === 'opensea' && target.slug) {
    return await mintOpenseaDrop(target, signer, provider, amount, onEvent);
  }

  // Prefer Seadrop path when the token is Seadrop-managed.
  const sd = await detectSeadrop(target.contract, provider);
  let txRequest;
  let fnLabel;
  let price;

  if (sd.version) {
    // Allowlist-first: if this drop has a merkle allowlist AND this wallet is on
    // it, mint via mintAllowList (allowlist price/window). Otherwise fall back to
    // the public drop. This avoids blasting mintPublic while an allowlist-only
    // window is open (which would revert and burn gas).
    const root = await getAllowlistRoot(sd.seadrop, target.contract, provider);
    const al = await checkAllowlist(sd.seadrop, target.contract, signer.address, provider, root);

    if (al.eligible) {
      const built = await buildAllowListMint({
        seadropAddr: sd.seadrop,
        nftContract: target.contract,
        quantity: amount,
        mintParams: al.mintParams,
        proof: al.proof,
        provider,
      });
      onEvent({ stage: 'allowlist', eligible: true, wallet: signer.address });
      if (!built.active) {
        throw new Error(
          `seadrop ${sd.version} allowlist: belum aktif (buka ${fmtWIB(built.startTime)}, tutup ${built.endTime ? fmtWIB(built.endTime) : 'tanpa batas'})`,
        );
      }
      txRequest = { to: built.to, from: signer.address, data: built.data, value: built.value };
      fnLabel = `seadrop ${sd.version} mintAllowList × ${amount}`;
      price = built.value;
    } else {
      // Not on the merkle allowlist. Some drops gate via signed/token-gated
      // mints (eligibility off-chain, needs OpenSea's signature) — warn so the
      // user isn't misled into thinking a public fallback covers their spot.
      if (al.hasAllowlist) {
        onEvent({ stage: 'allowlist', eligible: false, reason: al.reason, wallet: signer.address });
      } else {
        const mech = await getMintMechanisms(sd.seadrop, target.contract, provider);
        if (mech.signers.length || mech.tokenGated.length) {
          const kind = mech.signers.length ? 'signed (butuh signature OpenSea)' : 'token-gated';
          onEvent({ stage: 'allowlist', eligible: false, wallet: signer.address, reason: `${kind} — fallback ke public` });
        }
      }
      const built = await buildSeadropMint({
        seadropAddr: sd.seadrop,
        nftContract: target.contract,
        minter: signer.address,
        quantity: amount,
        provider,
      });
      if (!built.active) {
        const st = await tokenStatus(target.contract, provider);
        throw new Error(
          `seadrop ${sd.version}: public mint belum aktif (buka ${fmtWIB(built.drop.startTime)}, tutup ${built.drop.endTime ? fmtWIB(built.drop.endTime) : 'tanpa batas'}, maxSupply=${st.maxSupply ?? '?'})`,
        );
      }
      txRequest = { to: built.to, from: signer.address, data: built.data, value: built.value };
      fnLabel = `seadrop ${sd.version} mintPublic × ${amount}`;
      price = built.value;
    }
  } else {
    const fn = await detectMintFunction(target.contract, signer, amount);
    price = await detectPrice(target.contract, provider, amount);
    const name = fn.sig.split('(')[0];
    const iface = new ethers.Interface([`function ${fn.sig} payable`]);
    const data = iface.encodeFunctionData(name, buildArgs(fn, signer.address, amount));
    txRequest = { to: target.contract, from: signer.address, data, value: price };
    fnLabel = `${fn.sig} × ${amount}`;
  }

  onEvent({ stage: 'detected', fn: fnLabel, price: ethers.formatEther(price) });

  // Simulate before broadcast.
  try {
    await provider.call(txRequest);
  } catch (e) {
    throw new Error(`simulation revert: ${parseRevert(e)}`);
  }

  const gas = await autoGas(provider, txRequest);
  onEvent({ stage: 'gas', gasLimit: gas.gasLimit.toString() });

  const tx = await signer.sendTransaction({ ...txRequest, ...gas });
  onEvent({ stage: 'sent', hash: tx.hash, explorer: explorerUrl(target.chain, tx.hash) });

  const receipt = await tx.wait();
  const result = {
    contract: target.contract,
    chain: target.chain,
    amount,
    fn: fnLabel,
    priceEth: ethers.formatEther(price),
    hash: tx.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status === 1 ? 'success' : 'reverted',
    explorer: explorerUrl(target.chain, tx.hash),
  };
  onEvent({ stage: 'done', ...result });
  return result;
}

// Minimal ERC20 ABI for allowance/approve when a Scatter list is token-priced.
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// Mint from a Scatter.art collection. Resolves the wallet's eligible lists,
// picks the best (cheapest native, else token), asks the API to build the tx,
// approves any ERC20 payment, then simulates → sends → waits.
async function mintScatter(target, signer, provider, amount, onEvent) {
  const slug = target.scatter?.slug || target.slug;
  const col = target.scatter;

  const lists = await getEligibleLists(slug, signer.address);
  const list = pickBestList(lists);
  if (!list) {
    throw new Error(`scatter: wallet ${signer.address.slice(0, 10)}… not eligible for any mint list`);
  }
  const listPriceEth = ethers.formatEther(ethers.parseUnits(String(list.token_price || '0'), 18));
  onEvent({
    stage: 'allowlist',
    eligible: true,
    wallet: signer.address,
    reason: `list "${list.name}" @ ${list.token_price} ${list.currency_symbol || ''}`.trim(),
  });

  const built = await buildScatterMint({
    collectionAddress: target.contract,
    chainId: col?.chainId ?? undefined,
    minterAddress: signer.address,
    lists: [{ id: list.id, quantity: amount }],
    affiliate: target.affiliate,
  });

  const fnLabel = `scatter "${list.name}" × ${amount}`;
  onEvent({ stage: 'detected', fn: fnLabel, price: ethers.formatEther(built.value) });

  // Approve any ERC20 payments the mint requires before sending.
  for (const erc20 of built.erc20s) {
    const token = new ethers.Contract(erc20.address, ERC20_ABI, signer);
    const need = BigInt(erc20.amount);
    const have = await token.allowance(signer.address, target.contract);
    if (have < need) {
      onEvent({ stage: 'approve', token: erc20.address, amount: erc20.amount });
      const atx = await token.approve(target.contract, ethers.MaxUint256);
      await atx.wait();
    }
  }

  const txRequest = { to: built.to, from: signer.address, data: built.data, value: built.value };

  // Simulate before broadcast.
  try {
    await provider.call(txRequest);
  } catch (e) {
    throw new Error(`simulation revert: ${parseRevert(e)}`);
  }

  const gas = await autoGas(provider, txRequest);
  onEvent({ stage: 'gas', gasLimit: gas.gasLimit.toString() });

  const tx = await signer.sendTransaction({ ...txRequest, ...gas });
  onEvent({ stage: 'sent', hash: tx.hash, explorer: explorerUrl(target.chain, tx.hash) });

  const receipt = await tx.wait();
  const result = {
    contract: target.contract,
    chain: target.chain,
    amount,
    fn: fnLabel,
    priceEth: ethers.formatEther(built.value),
    hash: tx.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status === 1 ? 'success' : 'reverted',
    explorer: explorerUrl(target.chain, tx.hash),
  };
  onEvent({ stage: 'done', ...result });
  return result;
}

// Mint an OpenSea Drop (OS2) via the GraphQL-built relayer transaction. The
// tx (to/data/value) is generated server-side per wallet; we simulate → sign →
// send it directly. Eligibility/signature for signed presale stages is
// enforced by OpenSea's backend and may require a logged-in session — those
// fail here with a clear reason (not-eligible / drop-not-minting).
async function mintOpenseaDrop(target, signer, provider, amount, onEvent) {
  const slug = target.slug;

  const buildArgs = {
    slug,
    minterAddress: signer.address,
    contract: target.contract,
    chain: target.chain,
    tokenId: target.tokenId || '0',
    quantity: amount,
  };

  // Public stages need no login: try building the tx unauthenticated first so
  // public mints pay zero login latency. Only if OpenSea rejects (drop gated /
  // not eligible) do we log in (SIWE) and retry — that path is for signed/GTD.
  let built;
  try {
    built = await buildOpenseaMint(buildArgs);
  } catch (firstErr) {
    // Retry authenticated. A cached session (pre-warmed) makes this ~0ms.
    let cookie = null;
    try {
      cookie = await getSessionCookies(signer);
      onEvent({ stage: 'allowlist', eligible: true, wallet: signer.address, reason: 'opensea session aktif' });
    } catch (e) {
      // Login itself failed → surface the original (public) error, it's clearer.
      throw new Error(firstErr.message);
    }
    try {
      built = await buildOpenseaMint({ ...buildArgs, cookie });
    } catch (authErr) {
      const { meaning } = explainOpenseaError(authErr.message);
      throw new Error(`opensea: ${meaning}`);
    }
  }

  const stageLabel = built.stageType === 'PUBLIC_SALE' ? 'public'
    : built.stageType === 'SIGNED_PRESALE' ? 'presale/GTD'
    : built.stageType === 'MERKLE_PRESALE' ? 'allowlist'
    : built.stageType || '?';
  const fnLabel = `opensea ${stageLabel}${built.stageIndex != null ? ` #${built.stageIndex}` : ''}${built.crossChain ? ' (relayer)' : ''} × ${amount}`;
  onEvent({ stage: 'detected', fn: fnLabel, price: ethers.formatEther(built.value) });

  const txRequest = { to: built.to, from: signer.address, data: built.data, value: built.value };

  // Simulate before broadcast.
  try {
    await provider.call(txRequest);
  } catch (e) {
    throw new Error(`simulation revert: ${parseRevert(e)}`);
  }

  const gas = await autoGas(provider, txRequest);
  onEvent({ stage: 'gas', gasLimit: gas.gasLimit.toString() });

  const tx = await signer.sendTransaction({ ...txRequest, ...gas });
  onEvent({ stage: 'sent', hash: tx.hash, explorer: explorerUrl(target.chain, tx.hash) });

  const receipt = await tx.wait();
  const result = {
    contract: target.contract,
    chain: target.chain,
    amount,
    fn: fnLabel,
    priceEth: ethers.formatEther(built.value),
    hash: tx.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status === 1 ? 'success' : 'reverted',
    explorer: explorerUrl(target.chain, tx.hash),
  };
  onEvent({ stage: 'done', ...result });
  return result;
}

// Mint one target across several wallets concurrently. Each wallet gets its
// own mintOne (independent nonce/simulation). Never rejects — failures are
// captured per wallet. onEvent is tagged with { wallet } for multi context.
export async function mintMany(target, wallets, onEvent = () => {}, opts = {}) {
  if (wallets.length === 1) return [await mintOne(target, wallets[0], onEvent)];

  const limit = Math.max(1, opts.concurrency ?? 5);
  const results = new Array(wallets.length);
  let cursor = 0;

  async function worker() {
    while (cursor < wallets.length) {
      const i = cursor++;
      const w = wallets[i];
      const tag = (ev) => onEvent({ ...ev, wallet: w.address });
      try {
        results[i] = await mintOne(target, w, tag);
      } catch (e) {
        results[i] = { wallet: w.address, status: 'error', error: e.shortMessage || e.message };
        onEvent({ stage: 'wallet_error', wallet: w.address, error: results[i].error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, wallets.length) }, worker));
  return results;
}

export { detectMintFunction, detectPrice, autoGas };
