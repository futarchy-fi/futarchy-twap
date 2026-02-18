# Futarchy TWAP

On-chain TWAP (Time-Weighted Average Price) calculator for [Futarchy](https://futarchy.fi) proposals.

Discovers pools **100% on-chain** from proposal contracts — no subgraph dependency.

Works as a **library**, **CLI tool**, **HTTP server**, or **AWS Lambda** — same core logic, multiple deployment options.

## Live API

A public instance is deployed at **`https://api.futarchy.fi`**:

```bash
# Health check
curl https://api.futarchy.fi/health

# Discover pools for a proposal (Gnosis)
curl https://api.futarchy.fi/pools/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc

# Calculate TWAP (last 5 days from now)
curl https://api.futarchy.fi/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc

# Calculate TWAP with custom end time and window
curl "https://api.futarchy.fi/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc?endTimestamp=1738886400&days=5"

# Ethereum (chain 1)
curl https://api.futarchy.fi/twap/1/0xfb45ae9d8e5874e85b8e23d735eb9718efef47fa
```

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
```

### As a Library

```js
const { calculateTwap, discoverPools } = require('futarchy-twap');

// Gnosis (chain 100) — GNO/sDAI proposal
const twap = await calculateTwap('0x45e1064348fd8a407d6d1f59fc64b05f633b28fc', 100, {
  days: 5,                    // TWAP window in days (default: 5)
  endTimestamp: 1738886400,   // optional, unix timestamp — defaults to now
  rpcUrl: 'https://...',      // optional, override default RPC
});
console.log(twap.twap.winner);  // "YES" or "NO"

// Ethereum (chain 1)
const ethTwap = await calculateTwap('0xfb45ae9d8e5874e85b8e23d735eb9718efef47fa', 1);
console.log(ethTwap.twap.winner);

// Discover pools only
const pools = await discoverPools('0x45e1064348fd8a407d6d1f59fc64b05f633b28fc', 100);
console.log(pools.found);  // number of pools found (up to 6)
```

### As a CLI Tool

```bash
# Calculate TWAP (Gnosis)
node cli.js twap 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc

# With options
node cli.js twap 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc --endTimestamp 1738886400 --days 5

# Ethereum
node cli.js twap 1 0xfb45ae9d8e5874e85b8e23d735eb9718efef47fa

# Discover pools
node cli.js pools 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc

# Custom RPC
node cli.js twap 1 0xfb45ae9d8e5874e85b8e23d735eb9718efef47fa --rpc https://my-rpc.com
```

### As a Local Server

```bash
node server.js
# Starts on http://localhost:3005
```

## API Reference

### `GET /health`

```json
{ "status": "ok", "service": "futarchy-twap-lambda" }
```

### `GET /pools/:chainId/:proposalAddress`

Discover all 6 pools for a proposal on-chain.

```bash
curl "https://api.futarchy.fi/pools/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"
```

### `GET /twap/:chainId/:proposalAddress`

Calculate TWAP for a proposal.

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `chainId` | path | `100` = Gnosis, `1` = Ethereum | required |
| `proposalAddress` | path | On-chain proposal contract address | required |
| `endTimestamp` | query | Unix timestamp when market closes | now |
| `days` | query | TWAP window in days | `5` |

```bash
# Last 5 days from now
curl "https://api.futarchy.fi/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"

# Custom end time and window
curl "https://api.futarchy.fi/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc?endTimestamp=1738886400&days=5"
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
    "no":  { "address": "0x76f7...", "inverted": true }
  },
  "twap": {
    "yes": { "price": 106.52 },
    "no":  { "price": 104.11 },
    "spread": 2.41,
    "percentDiff": "2.31",
    "winner": "YES"
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | Server port (local server only) |
| `GNOSIS_RPC` | `https://rpc.gnosischain.com` | Gnosis Chain RPC URL |
| `ETHEREUM_RPC` | `https://eth.llamarpc.com` | Ethereum Mainnet RPC URL |

## Deploy Your Own Lambda

You can deploy this as your own AWS Lambda + API Gateway with a custom domain.

### Prerequisites

- AWS CLI v2: `sudo snap install aws-cli --classic`
- AWS credentials with permissions for: `lambda:*`, `apigatewayv2:*`, `acm:*`, `route53:*`
- A Route 53 hosted zone for your domain
- An existing Lambda execution role (or `iam:CreateRole` permission)

### Steps

```bash
# 1. Configure AWS credentials
aws configure
# Enter: Access Key ID, Secret Access Key, region (e.g. eu-north-1), output: json

# 2. Edit deploy.sh — fill in the CONFIG section at the top:
#    REGION, DOMAIN_NAME, HOSTED_ZONE_DOMAIN, ROLE_ARN
nano deploy.sh

# 3. Run the deploy script
bash deploy.sh
```

The script will:
1. Package `lambda.js` + `lib/` + `node_modules/` into a zip
2. Create/update the Lambda function
3. Create an API Gateway HTTP API with catch-all routes
4. Request an ACM certificate (DNS-validated via Route 53 automatically)
5. Create a custom domain and map it to the API
6. Update your Route 53 A record to point to API Gateway

### Re-deploying after code changes

```bash
bash deploy.sh
# The script is idempotent — safely re-run anytime to update the Lambda code
```

## Project Structure

```
├── lib/index.js   ← Core logic (shared by all modes)
├── server.js      ← Express HTTP server
├── cli.js         ← CLI tool
├── lambda.js      ← AWS Lambda handler
├── deploy.sh      ← Lambda deployment script (fill in CONFIG section)
└── package.json
```

## Supported Chains

| Chain | ID | Pool Factory | Oracle |
|-------|-----|-------------|--------|
| Gnosis | `100` | Algebra (`poolByPair`) | `getTimepoints()` |
| Ethereum | `1` | Uniswap V3 (`getPool`) | `observe()` |

## License

MIT
