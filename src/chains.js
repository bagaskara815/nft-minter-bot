// chains.js — chain registry, providers, explorers
import { ethers } from 'ethers';

// Canonical chain keys used everywhere in the engine.
export const RPCS = {
  ethereum: process.env.RPC_ETH || 'https://ethereum-rpc.publicnode.com',
  base: process.env.RPC_BASE || 'https://mainnet.base.org',
  polygon: process.env.RPC_POLYGON || 'https://polygon-bor-rpc.publicnode.com',
  arbitrum: process.env.RPC_ARB || 'https://arb1.arbitrum.io/rpc',
  optimism: process.env.RPC_OP || 'https://mainnet.optimism.io',
  'zora-network': process.env.RPC_ZORA || 'https://rpc.zora.energy',
  bsc: process.env.RPC_BSC || 'https://bsc-rpc.publicnode.com',
  avalanche: process.env.RPC_AVAX || 'https://avalanche-c-chain-rpc.publicnode.com',
  bera: process.env.RPC_BERA || 'https://rpc.berachain.com',
  peaq: process.env.RPC_PEAQ || 'https://peaq-rpc.publicnode.com',
  // Robinhood Chain (chainId 4663).
  robinhood: process.env.RPC_ROBINHOOD || 'https://robinhood-rpc.publicnode.com',
};

export const CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  'zora-network': 7777777,
  bsc: 56,
  avalanche: 43114,
  bera: 80094,
  peaq: 3338,
  robinhood: 4663,
};

const EXPLORERS = {
  ethereum: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  'zora-network': 'https://explorer.zora.energy/tx/',
  bsc: 'https://bscscan.com/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  bera: 'https://berascan.com/tx/',
  peaq: 'https://peaq.subscan.io/tx/',
  robinhood: 'https://robinhoodchain.blockscout.com/tx/',
};

export const explorerUrl = (chain, hash) => (EXPLORERS[chain] || '') + hash;

const providerCache = new Map();

export function getProvider(chain) {
  if (providerCache.has(chain)) return providerCache.get(chain);
  const url = RPCS[chain];
  if (!url) throw new Error(`unknown chain: ${chain}`);

  const chainId = CHAIN_IDS[chain];
  const network = chainId ? { chainId, name: chain } : undefined;
  const provider = new ethers.JsonRpcProvider(
    url,
    network,
    network ? { staticNetwork: true } : undefined,
  );
  providerCache.set(chain, provider);
  return provider;
}
