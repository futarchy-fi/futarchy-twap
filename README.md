# Futarchy TWAP Server

On-chain TWAP (Time-Weighted Average Price) calculator for [Futarchy](https://futarchy.fi) proposals.

Discovers pools **100% on-chain** from proposal contracts — no subgraph dependency for pool discovery.

## How It Works

```
Proposal Contract
  ├── wrappedOutcome(0) → YES_COMPANY token
  ├── wrappedOutcome(1) → NO_COMPANY token
  ├── wrappedOutcome(2) → YES_CURRENCY token
  ├── wrappedOutcome(3) → NO_CURRENCY token
  ├── collateralToken1() → Company token (e.g., GNO)
  └── collateralToken2() → Currency token (e.g., sDAI)

TWAP uses "conditional" pools:
  YES pool = YES_COMPANY / YES_CURRENCY → factory.poolByPair()
  NO pool  = NO_COMPANY  / NO_CURRENCY  → factory.poolByPair()
```

1. Reads wrapped outcome tokens from the proposal contract
2. Finds pool addresses via Algebra factory `poolByPair()` (Gnosis) or Uniswap V3 `getPool()` (Ethereum)
3. Auto-detects price inversion by reading `pool.token0()`
4. Calculates TWAP from pool oracle (`getTimepoints` / `observe`)

## Quick Start

```bash
npm install
node server.js
```

Server starts on `http://localhost:3005`.

## API

### `GET /pools/:chainId/:proposalAddress`

Discover all 6 pools for a proposal on-chain.

```bash
curl "http://localhost:3005/pools/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"
```

### `GET /twap/:chainId/:proposalAddress`

Calculate TWAP for a proposal.

| Param | Description | Default |
|-------|-------------|---------|
| `chainId` (path) | `100` = Gnosis, `1` = Ethereum | required |
| `endTimestamp` (query) | Unix timestamp when market closes | now |
| `days` (query) | TWAP window in days | `5` |

```bash
# Default: TWAP over last 5 days from now
curl "http://localhost:3005/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"

# Custom: TWAP 5 days before a specific end time
curl "http://localhost:3005/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc?endTimestamp=1738886400&days=5"
```

### Example Response

```json
{
  "proposalAddress": "0x45e1064348fd8a407d6d1f59fc64b05f633b28fc",
  "chainId": 100,
  "chain": "Gnosis",
  "marketName": "Will GIP-145 ... be approved?",
  "tokens": {
    "company": { "symbol": "GNO", "decimals": 18 },
    "currency": { "symbol": "sDAI", "decimals": 18 }
  },
  "pools": {
    "yes": { "address": "0xF834...", "inverted": false },
    "no": { "address": "0x76f7...", "inverted": true }
  },
  "twap": {
    "yes": { "price": 106.52 },
    "no": { "price": 104.11 },
    "spread": 2.41,
    "percentDiff": "2.31",
    "winner": "YES"
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | Server port |
| `GNOSIS_RPC` | `https://rpc.gnosischain.com` | Gnosis Chain RPC |
| `ETHEREUM_RPC` | `https://eth.llamarpc.com` | Ethereum Mainnet RPC |

## Supported Chains

| Chain | ID | Pool Factory | Oracle |
|-------|-----|-------------|--------|
| Gnosis | `100` | Algebra (`poolByPair`) | `getTimepoints()` |
| Ethereum | `1` | Uniswap V3 (`getPool`) | `observe()` |

## License

MIT
