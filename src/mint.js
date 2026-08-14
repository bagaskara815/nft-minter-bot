// mint.js — universal mint engine: detect fn → price → gas → simulate → send → report
import { ethers } from 'ethers';
import { getProvider, explorerUrl } from './chains.js';
import { detectSeadrop, buildSeadropMint, buildAllowListMint, getAllowlistRoot, tokenStatus } from './seadrop.js';
import { checkAllowlist } from './allowlist.js';
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
      if (al.hasAllowlist) {
        onEvent({ stage: 'allowlist', eligible: false, reason: al.reason, wallet: signer.address });
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
