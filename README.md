<div align="center">

# 🤖 NFT Minter Bot

**Universal EVM NFT minter — Telegram bot + CLI**

Auto-detects the mint path across OpenSea Seadrop, OpenSea Drops (OS2), Scatter.art, and generic ERC721/1155. Resolves per-wallet eligibility (merkle allowlist + OpenSea signed/GTD via automated SIWE login). Simulates every transaction before it touches the chain.

![Node](https://img.shields.io/badge/node-%3E%3D18-3C873A?logo=node.js&logoColor=white)
![ethers](https://img.shields.io/badge/ethers-6.13-2535A0)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)
![Chains](https://img.shields.io/badge/chains-11-627EEA)
![Platforms](https://img.shields.io/badge/platforms-Seadrop%20%C2%B7%20OpenSea%20%C2%B7%20Scatter-orange)
![License](https://img.shields.io/badge/private-use-lightgrey)

</div>

---

## 📖 Contents
- [✨ Features](#-features)
- [🎨 Platforms](#-platforms)
- [🔗 Supported Chains](#-supported-chains)
- [🚀 Setup](#-setup)
- [🎮 Bot Commands](#-bot-commands)
- [🔐 Eligibility & Auth](#-eligibility--auth)
- [👛 Multi-Wallet](#-multi-wallet)
- [⌨️ CLI](#️-cli)
- [🧩 Input Shapes](#-input-shapes)
- [⚙️ Detection Pipeline](#️-detection-pipeline)
- [🛡️ Security](#️-security)
- [📌 Notes](#-notes)

---

## ✨ Features
| | Feature | Detail |
|:--:|---------|--------|
| 🎯 | **Auto-detect mint path** | Seadrop v1/v2, OpenSea Drops (OS2 relayer), Scatter.art, or generic ERC721/1155 (`mint`/`publicMint`/`claim`), probed via `eth_call` |
| 💰 | **Auto price + gas** | Reads price on-chain; `estimateGas` +20% buffer, EIP-1559 with headroom (legacy fallback) |
| 🧪 | **Simulate-first** | Every mint runs `eth_call` before broadcast — a reverting simulate never spends gas |
| 🔐 | **Merkle allowlist** | Auto-fetches the tree, resolves per-wallet proof, mints `mintAllowList`; else falls back to public |
| 🔏 | **OpenSea signed/GTD** | Automated SIWE login (headless, uses your key) → eligibility probe + server-built mint tx |
| 🎫 | **Scatter.art** | Resolves eligible mint lists via public API (proof + signature server-built), ERC20 payment support |
| 👀 | **Eligibility preview** | `/check` shows per-wallet eligibility, price/max, stages, project links + deployer |
| 🕒 | **Scheduled + snipe** | `/mintat` fires at a time; `/mintopen` polls on-chain and mints the instant it opens |
| 🪙 | **Multi-wallet** | Fan one mint across many wallets concurrently (independent nonce + simulation) |
| ⚡ | **Session pre-warm** | SIWE sessions cached & warmed during the wait so login never sits in the mint critical path |
| 🔗 | **Auto-listener + shortcuts** | Bare URL/contract triggers `/check`; `/m` `/c` `/ma` `/mo` shortcuts |
| 🖥️ | **Telegram + CLI** | Same engine behind an owner-guarded bot and a headless CLI |

---

## 🎨 Platforms

| Platform | How it mints | Eligibility |
|----------|-------------|-------------|
| **Seadrop v1/v2** (direct) | `mintPublic` / `mintAllowList` straight to the SeaDrop contract | merkle allowlist resolved on-chain, no login |
| **OpenSea Drops (OS2)** | tx built server-side via GraphQL (relayer + `requestId`) | public no-login; signed/GTD via automated SIWE session |
| **Scatter.art** | tx built via Scatter public API (proof + signature) | eligible mint lists per wallet, no API key |
| **Generic ERC721/1155** | probes `mint`/`publicMint`/`claim` signatures | none (public) |

---

## 🔗 Supported Chains

| Chain | Key | chainId | Explorer |
|-------|-----|:-------:|----------|
| Ethereum | `ethereum` | `1` | etherscan.io |
| Base | `base` | `8453` | basescan.org |
| Polygon | `polygon` | `137` | polygonscan.com |
| Arbitrum | `arbitrum` | `42161` | arbiscan.io |
| Optimism | `optimism` | `10` | optimistic.etherscan.io |
| Zora | `zora-network` | `7777777` | explorer.zora.energy |
| BNB Chain | `bsc` | `56` | bscscan.com |
| Avalanche | `avalanche` | `43114` | snowtrace.io |
| Berachain | `bera` | `80094` | berascan.com |
| peaq | `peaq` | `3338` | peaq.subscan.io |
| **Robinhood** | `robinhood` | `4663` | robinhoodchain.blockscout.com |

> Every RPC is overridable with an `RPC_*` env var — see [`.env.example`](.env.example).

---

## 🚀 Setup

```bash
npm install
cp .env.example .env      # then fill in the required values
```

> 💡 Get your Telegram numeric ID from [`@userinfobot`](https://t.me/userinfobot).
> **`ALLOWED_USER_IDS` empty = the bot denies everyone** (safe default).

<details>
<summary><b>Environment variables</b></summary>

| Var | Required | Purpose |
|-----|:--------:|---------|
| `TELEGRAM_BOT_TOKEN` | ✅ (bot) | Bot token from `@BotFather` |
| `ALLOWED_USER_IDS` | — | Comma-separated Telegram IDs allowed to command the bot. Empty = deny all |
| `PRIVATE_KEY` | ✅ | Primary minting wallet |
| `PRIVATE_KEYS` | — | Extra wallets, comma-separated private keys |
| `WALLETS_FILE` | — | JSON wallets file path (`wallets.json`) |
| `OPENSEA_KEY` | — | OpenSea REST v2 key — enables slug resolution + project links (website/socials) |
| `RPC_*` | — | Per-chain RPC overrides |
| `OS_HASH_*` | — | Override OpenSea persisted-query hashes if the frontend redeploys (`OS_HASH_MINT_MODULE`, `OS_HASH_MINT_TIMELINE`, `OS_HASH_DROP_ELIGIBILITY`, `OS_HASH_MINT_QUERY`) |

</details>

Run it:

```bash
npm run bot
```

---

## 🎮 Bot Commands
| Command | Shortcut | Action |
|---------|:--------:|--------|
| `/mint <target> [wallets:all\|N]` | `/m` | detect → simulate → send → report |
| `/mintat <time> \| <target> [wallets:all\|N]` | `/ma` | schedule a mint for a time |
| `/mintopen <target> [wallets:all\|N]` | `/mo` | poll on-chain open, mint the instant it opens |
| `/check <target> [wallets:all\|N]` | `/c` | **dry run** — config, price, stages, per-wallet eligibility, links |
| `/jobs` | — | list scheduled / running jobs |
| `/cancel <id>` | — | cancel a scheduled or watching job |
| `/wallet` | — | list loaded wallets + non-zero balances per chain |
| `/help` | — | command reference |

> **Auto-listener:** send a bare OpenSea/Scatter URL or `0x…` contract (no command) and the bot auto-runs `/check`.

`<target>` = an OpenSea / Scatter / Zora URL or a raw `0x…` contract. See [Input Shapes](#-input-shapes).

<details>
<summary><b>Time formats for <code>/mintat</code></b></summary>

| Format | Example |
|--------|---------|
| ISO 8601 | `2026-08-12T14:00:00` |
| Unix | `1786000000` (s or ms) |
| Relative | `in 5m`, `30s`, `2h`, `1d` |
| Clock (next occurrence) | `HH:MM` |

All times displayed by the bot are **WIB**. The `|` separator splits the time from the target, because a time can contain spaces.

</details>

---

## 🔐 Eligibility & Auth

The bot resolves each wallet's eligibility **before** minting, per platform:

### Seadrop merkle allowlist (on-chain, no login)

```
getAllowListMerkleRoot
  ├─ root = 0x0 (no allowlist)      → mintPublic
  ├─ root set, wallet ON allowlist  → mintAllowList  (allowlist price + merkle proof)
  └─ root set, wallet NOT eligible  → fall back to mintPublic
```

<details>
<summary><b>How merkle eligibility is resolved</b> (<code>src/allowlist.js</code>)</summary>

1. Read the merkle root via `getAllowListMerkleRoot`. Zero root → no allowlist, everyone mints public.
2. Find the latest `allowListURI` from the `AllowListUpdated` event log (topic0 `0xefcd7e…52efa5`).
3. Download the allowlist tree JSON (supports `ipfs://` → gateway, or HTTPS).
4. Look up the wallet — the JSON ships the merkle `proof` and `mintParams`, so no local merkle computation is needed.

</details>

### OpenSea signed / GTD (automated SIWE)

OpenSea signed presale / GTD stages gate the mint behind a logged-in session. Since the bot holds the private key it performs the SIWE handshake headlessly (`src/opensea-auth.js`):

```
POST /siwe/nonce → wallet.signMessage(EIP-4361) → POST /siwe/verify → access_token (JWT)
```

- Session cached per wallet, keyed by address; **one login reused** across `/check`, `/mint`, `/mintat`, `/mintopen`.
- Auto-renews via `refresh_token` before expiry; full re-login only when refresh fails.
- Pre-warmed during the scheduled wait, so login never sits in the mint critical path.
- Eligibility is probed via the **authenticated mint-build** (`MintActionTimelineQuery`) — the resolver that actually gates minting — not the display resolver (which returns null for headless sessions).

### Scatter.art (public API, no key)

Resolves the wallet's eligible mint lists (`eligible-invite-lists`), picks the best (cheapest native > paid), and asks the API to build the tx (proof + signature included). ERC20-priced lists are auto-approved before minting.

### Preview

```
/check 0xCONTRACT robinhood wallets:all
```

```text
🔍 COLLECTION CHECK
━━━━━━━━━━━━━━━━━━━━
📄 0xCONTRACT
🔗 robinhood  ·  🎯 mint × 1

⚙️  OpenSea Drop — Gogh Punks
🔗 Website · Twitter · Discord · explorer
👤 deployer: 0xc7f55cE6…7AA6

🎬 Stages (WIB)
  🎫 stage 1: GTD · FREE · max 5 · 🟢 buka
  🌐 stage 0: Public stage · 0.0003 ETH · max 20 · 🟢 buka

━━━━━━━━━━━━━━━━━━━━
👛 Eligibility — 1 wallet
✅ 0x5e4bD635…  ELIGIBLE — bisa mint sekarang · 0.0003 ETH
```

> ⚠️ **Honest limits:** No on-chain mint has yet been confirmed end-to-end — paths are tested up to tx-build + auth-accepted. OpenSea signed/GTD auth is verified (mint resolver processes authed requests), but a signed tx landing on-chain is unproven. `mintAllowedTokenHolder` (token-gated) falls back to public. If an RPC caps `getLogs` range, merkle event lookup may false-negative (never crashes).

---

## 👛 Multi-Wallet

Default: one wallet (`PRIVATE_KEY`). To mint from many at once:

**1. Add wallets** — via `PRIVATE_KEYS` (comma-separated) or `WALLETS_FILE`:

```jsonc
// wallets.json
["0xpk1", "0xpk2"]            // or
[{ "pk": "0xpk1" }, { "pk": "0xpk2" }]
```

Wallets are deduped by address.

**2. Select per command** with the wallet spec (default: primary only):

| Spec | Selects |
|------|---------|
| `wallets:all` / `wallets:*` | all wallets |
| `wallets:3` | first 3 wallets |
| `wallets:1,2` | specific indices (1-based) |
| `--wallets all` / `-w 3` | CLI form |

> The bare `w` shorthand **requires** `:`/`=` (`w:2`) — never a space — so a target like `.../overview 10` is not mistaken for a spec.

Each wallet mints independently (own nonce + simulation), **max 5 in parallel**. One wallet failing does not fail the others. For Seadrop, each wallet resolves its own allowlist path.

---

## ⌨️ CLI

No Telegram required:

```bash
node src/mint-cli.js 0xABC... base 3
node src/mint-cli.js https://opensea.io/assets/base/0xABC.../1
node src/mint-cli.js "0xABC... on robinhood x2"

# scheduled / open-mint / multi-wallet
node src/mint-cli.js --at "2026-08-12T14:00" 0xABC... base 3
node src/mint-cli.js --at "in 5m"             0xABC... base
node src/mint-cli.js --when-open              0xABC... base 2
node src/mint-cli.js --wallets all --when-open 0xABC... base 1
```

> `--when-open` reads the Seadrop `startTime`, coarse-waits until just before it, then polls the simulation every **400ms** and sends on the first block that passes. Falls back to pure simulation-polling for non-Seadrop contracts.

---

## 🧩 Input Shapes

| Input | Example |
|-------|---------|
| OpenSea collection URL | `https://opensea.io/collection/toadlings` |
| OpenSea assets URL | `https://opensea.io/assets/base/0xABC.../5` |
| Scatter.art URL | `https://scatter.art/c/<slug>` · `/collection/<slug>` |
| Zora collect URL | `https://zora.co/collect/base:0xABC.../1` |
| Direct contract | `0xABC... on base 5` |
| Amount syntax | trailing `N` or `xN` anywhere (`0xABC base x10`) |

> Chain and amount after a direct address are **order-independent**; `on` is filler. In an OpenSea assets URL, a trailing `/5` is the **tokenId**, not the amount. Defaults: amount = `1`, chain = `ethereum`.

---

## ⚙️ Detection Pipeline
```
parse → resolve (slug/URL/contract)
  ├─ Scatter    → API: eligible lists → build tx (proof + signature)
  ├─ OpenSea OS2 → GraphQL: stages → build tx (relayer + requestId); SIWE for signed/GTD
  ├─ Seadrop    → allowlist check per wallet → mintAllowList | mintPublic
  └─ generic    → probe mint signatures (mint / publicMint / claim / …) → detect price
  → auto gas (+20% buffer, EIP-1559 or legacy)
  → simulate (eth_call) → send → wait → report
```

> For `/mintopen` and `--when-open`, the simulate doubles as the open detector: while it reverts (drop closed) it keeps polling; the first passing simulate = drop open → send in that block.

---

## 🛡️ Security

- 🔒 **Owner-guarded** by numeric Telegram user ID. Empty allowlist = deny all.
- 🙈 `PRIVATE_KEY`, `.env`, and `wallets.json` are **gitignored**. Never commit real keys.
- 🧼 **No credentials hardcoded** — every secret is read from the environment.
- 🧪 Always `/check` first on mainnet; the engine simulates before broadcasting.
- 🌐 Public RPCs may block datacenter IPs — override with private endpoints in `.env`.
- ⚠️ Private keys live in plaintext in memory/env (normal for a minter). Do not run on shared/untrusted hosts.

---

## 📌 Notes

- **Manifold** claims need the claim contract address — paste the `0x…` directly.
- **Scatter.art** is resolved by slug only (no address lookup) — paste the Scatter URL, not a bare `0x…`.
- **OpenSea Drops** persisted-query hashes can change on frontend redeploys — override via `OS_HASH_*` env vars if `/check` or minting starts failing.
- **Robinhood Chain** defaults to `https://robinhood-rpc.publicnode.com` (override via `RPC_ROBINHOOD`). In Indonesia the official `rpc.mainnet.chain.robinhood.com` endpoint can be blocked by ISP DNS; the public node avoids that.
- **Jobs are in-memory** — a bot restart clears scheduled/watching jobs.
- **`EFATAL: AggregateError`** on startup usually means the bot cannot reach `api.telegram.org` (ISP block / no network), not a code bug.
