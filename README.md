# NFT Minter Bot

Universal EVM NFT minter — Telegram bot + CLI. Auto-detects mint function, price, gas, and OpenSea Seadrop (v1/v2). Built from the `nft-minter` skill.

## Chains

`ethereum`, `base`, `polygon`, `arbitrum`, `optimism`, `zora`, `bsc`, `avalanche`, `bera`, `peaq`, `robinhood` (chainId 4663).

## Setup

```bash
npm install
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS, PRIVATE_KEY
```

Get your Telegram numeric ID from `@userinfobot`. `ALLOWED_USER_IDS` empty = bot denies everyone.

## Run the bot

```bash
npm run bot
```

Commands:
- `/mint <url|contract> [chain] [amount] [wallets:all|N]` — detect → simulate → send → report
- `/mintat <time> | <url|contract> [chain] [amount] [wallets:all|N]` — schedule a mint for a time
- `/mintopen <url|contract> [chain] [amount] [wallets:all|N]` — poll the on-chain open time, mint the instant it opens
- `/check <url|contract> [chain]` — dry run: fn/price/Seadrop config, no transaction
- `/jobs` — list scheduled/running jobs
- `/cancel <id>` — cancel a scheduled job
- `/wallet` — list loaded wallets + non-zero balances
- `/help`

`<time>`: ISO 8601 (`2026-08-12T14:00:00`), unix detik/ms, relatif (`in 5m`, `30s`, `2h`, `1d`), atau `HH:MM` (kejadian berikutnya, **WIB**). Semua waktu yang ditampilkan bot dalam WIB. Pemisah `|` memisahkan waktu dari target karena waktu bisa mengandung spasi.

## Multi-wallet (opsional)

Default: satu wallet (`PRIVATE_KEY`). Untuk mint dari banyak wallet sekaligus:

- Tambah wallet lewat `PRIVATE_KEYS` (koma) atau `WALLETS_FILE` (`wallets.json`: `["0xpk", …]` atau `[{"pk":"0x.."}]`).
- Pilih subset per-perintah dengan token wallet spec (opsional, default primary saja):
  - `wallets:all` / `wallets:*` — semua wallet
  - `wallets:3` — 3 wallet pertama
  - `wallets:1,2` — index tertentu (1-based)
  - CLI: `--wallets all` / `-w 3`

Setiap wallet mint independen (nonce & simulasi sendiri), maksimal 5 paralel. Kegagalan satu wallet tidak menggagalkan yang lain.

## CLI (no Telegram)

```bash
node src/mint-cli.js 0xABC... base 3
node src/mint-cli.js https://opensea.io/assets/base/0xABC.../1
node src/mint-cli.js "0xABC... on robinhood x2"

# scheduled / open-mint / multi-wallet
node src/mint-cli.js --at "2026-08-12T14:00" 0xABC... base 3
node src/mint-cli.js --at "in 5m" 0xABC... base
node src/mint-cli.js --when-open 0xABC... base 2
node src/mint-cli.js --wallets all --when-open 0xABC... base 1
```

`--when-open` reads the Seadrop `startTime`, coarse-waits until just before it, then polls the simulation every 400ms and sends on the first block that passes. Falls back to pure simulation-polling for non-Seadrop contracts.

## Input shapes

- OpenSea assets URL, collection URL (slug → contract via API/scrape)
- Zora collect URL
- Raw: `0xABC... on base 5`, `mint 0xABC 3`

## Detection pipeline

```
parse → resolve slug → detect Seadrop v1/v2 (getPublicDrop)
      → else probe mint signatures (mint/publicMint/claim/…)
      → detect price (mintPrice/price/cost/…)
      → auto gas (+20% buffer, EIP-1559 or legacy)
      → simulate (eth_call) → send → wait → report
```

## Security

- Bot is owner-guarded by numeric Telegram user ID. Empty allowlist = deny all.
- `PRIVATE_KEY` and `.env` are gitignored. Never commit real keys.
- Always `/check` first on mainnet; the engine simulates before broadcasting.
- Public RPCs may block datacenter IPs — override with private endpoints in `.env`.

## Notes

- Manifold claims need the claim contract address (paste `0x…` directly).
- Robinhood Chain uses `https://robinhood-rpc.publicnode.com` by default (override via `RPC_ROBINHOOD`).
