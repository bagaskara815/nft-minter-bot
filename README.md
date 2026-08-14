<div align="center">

# 🤖 NFT Minter Bot

**Universal EVM NFT minter — Telegram bot + CLI**

Auto-detects the mint function, price, and gas. Understands OpenSea Seadrop (v1/v2) and per-wallet allowlist eligibility. Simulates every transaction before it touches the chain.

![Node](https://img.shields.io/badge/node-%3E%3D18-3C873A?logo=node.js&logoColor=white)
![ethers](https://img.shields.io/badge/ethers-6.13-2535A0)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)
![Chains](https://img.shields.io/badge/chains-11-627EEA)
![License](https://img.shields.io/badge/private-use-lightgrey)

</div>

---

## 📖 Contents

- [✨ Features](#-features)
- [🔗 Supported Chains](#-supported-chains)
- [🚀 Setup](#-setup)
- [🎮 Bot Commands](#-bot-commands)
- [🔐 Allowlist &amp; Eligibility](#-allowlist--eligibility)
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
| 🎯 | **Auto-detect mint path** | Seadrop v1/v2 (`mintPublic` / `mintAllowList`) or generic ERC721/1155 (`mint`, `publicMint`, `claim`, …), probed via `eth_call` |
| 💰 | **Auto price** | Reads `mintPrice` from Seadrop, or probes `price` / `cost` / `mintPrice` on generic contracts |
| ⛽ | **Auto gas** | `estimateGas` + 20% buffer, EIP-1559 fees with headroom (legacy fallback) |
| 🧪 | **Simulate-first** | Every mint runs `eth_call` before broadcast — a reverting simulate never spends gas |
| 🔐 | **Allowlist-aware** | Checks the wallet against the on-chain merkle allowlist; mints via `mintAllowList` with proof when eligible, else public |
| 👀 | **Eligibility preview** | `/check` reports which wallets are allowlisted vs public, with allowlist price/max |
| 🕒 | **Scheduled mint** | `/mintat` fires at an absolute or relative time |
| ⚡ | **Open-mint snipe** | `/mintopen` polls on-chain open state, sends the instant the drop opens |
| 🪙 | **Multi-wallet** | Fan one mint across many wallets concurrently (independent nonce + simulation) |
| 🖥️ | **Telegram + CLI** | Same engine behind an owner-guarded bot and a headless CLI |

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
| `OPENSEA_KEY` | — | OpenSea API key for reliable slug→contract resolution |
| `RPC_*` | — | Per-chain RPC overrides |

</details>

Run it:

```bash
npm run bot
```

---

## 🎮 Bot Commands

| Command | Action |
|---------|--------|
| `/mint <target> [wallets:all\|N]` | detect → simulate → send → report |
| `/mintat <time> \| <target> [wallets:all\|N]` | schedule a mint for a time |
| `/mintopen <target> [wallets:all\|N]` | poll on-chain open, mint the instant it opens |
| `/check <target> [wallets:all\|N]` | **dry run** — config, price, schedule, per-wallet eligibility |
| `/jobs` | list scheduled / running jobs |
| `/cancel <id>` | cancel a scheduled or watching job |
| `/wallet` | list loaded wallets + non-zero balances per chain |
| `/help` | command reference |

`<target>` = an OpenSea/Zora URL or a raw `0x…` contract. See [Input Shapes](#-input-shapes).

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

## 🔐 Allowlist &amp; Eligibility

For Seadrop drops, the bot resolves each wallet's path **before** minting:

```
detectSeadrop → getAllowListMerkleRoot
  ├─ root = 0x0 (no allowlist)      → mintPublic
  ├─ root set, wallet ON allowlist  → mintAllowList  (allowlist price + merkle proof)
  └─ root set, wallet NOT eligible  → fall back to mintPublic
```

<details>
<summary><b>How eligibility is resolved</b> (<code>src/allowlist.js</code>)</summary>

1. Read the merkle root via `getAllowListMerkleRoot`. Zero root → no allowlist, everyone mints public.
2. Find the latest `allowListURI` from the `AllowListUpdated` event log (topic0 `0xefcd7e…52efa5`, filtered by NFT contract).
3. Download the allowlist tree JSON (supports `ipfs://` → gateway, or HTTPS).
4. Look up the wallet — the JSON ships the merkle `proof` and `mintParams` per wallet, so no local merkle computation is needed.

</details>

Preview eligibility without sending:

```
/check 0xCONTRACT robinhood wallets:all
```

```text
🔍 COLLECTION CHECK
━━━━━━━━━━━━━━━━━━━━
📄 0xCONTRACT
🔗 robinhood  ·  🎯 mint × 1

⚙️  Seadrop v2  ·  🔴 inactive
⏳ buka dalam 16j 48m

💰 Harga
    0.005 ETH / unit
    0.005 ETH total (× 1)

🕒 Jadwal (WIB)
    buka   Sab, 15 Agu 2026 02:00 WIB
    tutup  Sab, 15 Agu 2026 02:02 WIB
    window 2m

📋 Aturan
    max/wallet  1
    allowlist   🌐 tidak (public)

━━━━━━━━━━━━━━━━━━━━
👛 Eligibility — 3 wallet
✅ 0x36473f15…  →  allowlist  ·  0.005 ETH  ·  max 2
⚪ 0x8a1b2c3d…  →  public
⚪ 0x9e4f5a6b…  →  public
```

> ⚠️ **Not yet handled:** `mintSigned` (server-signature presale) and `mintAllowedTokenHolder` (token-gated / GTD) fall back to public. If an RPC caps the `getLogs` block range, the event lookup may fail and treat the wallet as public — a false negative, never a crash.

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
| Zora collect URL | `https://zora.co/collect/base:0xABC.../1` |
| Direct contract | `0xABC... on base 5` |
| Amount syntax | trailing `N` or `xN` anywhere (`0xABC base x10`) |

> Chain and amount after a direct address are **order-independent**; `on` is filler. In an OpenSea assets URL, a trailing `/5` is the **tokenId**, not the amount. Defaults: amount = `1`, chain = `ethereum`.

---

## ⚙️ Detection Pipeline

```
parse → resolve slug → detect Seadrop v1/v2 (getPublicDrop)
      ├─ Seadrop:  allowlist check per wallet → mintAllowList | mintPublic
      └─ generic:  probe mint signatures (mint / publicMint / claim / …)
                 → detect price (mintPrice / price / cost / …)
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
- **Robinhood Chain** defaults to `https://robinhood-rpc.publicnode.com` (override via `RPC_ROBINHOOD`). In Indonesia the official `rpc.mainnet.chain.robinhood.com` endpoint can be blocked by ISP DNS; the public node avoids that.
- **Jobs are in-memory** — a bot restart clears scheduled/watching jobs.
- **`EFATAL: AggregateError`** on startup usually means the bot cannot reach `api.telegram.org` (ISP block / no network), not a code bug.
