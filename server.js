/**
 * Express TWAP Server — Pure On-Chain
 * 
 * Discovers pools on-chain from the proposal contract using wrappedOutcome(),
 * then reads TWAP from Algebra (chain 100) or Uniswap V3 (chain 1) pool oracles.
 * 
 * No subgraph dependency for pool discovery. TWAP window defined by arguments:
 *   - endTimestamp: Unix timestamp when the proposal/market closes
 *   - days: Number of days before endTimestamp for TWAP window (default: 5)
 * 
 * Endpoints:
 *   GET /twap/:chainId/:proposalAddress?endTimestamp=...&days=5
 *   GET /health
 */

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3005;

// ─── Chain Config ────────────────────────────────────────────────────────────

const CHAIN_CONFIG = {
    100: {
        name: 'Gnosis',
        rpcUrl: process.env.GNOSIS_RPC || 'https://rpc.gnosischain.com',
        mode: 'algebra',
        factory: '0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766',  // Swapr/Algebra Factory
    },
    1: {
        name: 'Ethereum',
        rpcUrl: process.env.ETHEREUM_RPC || 'https://eth-mainnet.public.blastapi.io',
        mode: 'uniswap',
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',  // Uniswap V3 Factory
        feeTiers: [500, 3000, 10000, 100],
    }
};

// ─── ABIs ────────────────────────────────────────────────────────────────────

// Proposal contract — reads wrapped outcome tokens
const PROPOSAL_ABI = [
    'function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)',
    'function collateralToken1() view returns (address)',
    'function collateralToken2() view returns (address)',
    'function marketName() view returns (string)',
    'function questionId() view returns (bytes32)',
];

// Algebra Factory (Gnosis chain 100)
const ALGEBRA_FACTORY_ABI = [
    'function poolByPair(address token0, address token1) view returns (address pool)',
];

// Uniswap V3 Factory (Ethereum chain 1)
const UNISWAP_FACTORY_ABI = [
    'function getPool(address token0, address token1, uint24 fee) view returns (address)',
];

// Pool ABIs — shared for token order detection
const POOL_TOKEN_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

// Algebra pool TWAP oracle (chain 100)
const ALGEBRA_TWAP_ABI = [
    'function getTimepoints(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulatives, uint112[] volatilityCumulatives, uint256[] volumePerAvgLiquiditys)',
    'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)',
];

// Uniswap V3 pool TWAP oracle (chain 1)
const UNISWAP_TWAP_ABI = [
    'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

// ERC20 for token info
const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
];

// ─── Provider Cache ──────────────────────────────────────────────────────────

const providers = {};
function getProvider(chainId) {
    if (!providers[chainId]) {
        const config = CHAIN_CONFIG[chainId];
        if (!config) throw new Error(`Unsupported chain ${chainId}`);
        providers[chainId] = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    }
    return providers[chainId];
}

// ─── On-Chain Pool Discovery ─────────────────────────────────────────────────

/**
 * Read wrapped outcome tokens from proposal contract
 * Index: 0=YES_COMPANY, 1=NO_COMPANY, 2=YES_CURRENCY, 3=NO_CURRENCY
 */
async function getProposalTokens(provider, proposalAddress) {
    const proposal = new ethers.Contract(proposalAddress, PROPOSAL_ABI, provider);

    const [
        wo0, wo1, wo2, wo3,
        companyToken, currencyToken,
        marketName
    ] = await Promise.all([
        proposal.wrappedOutcome(0),
        proposal.wrappedOutcome(1),
        proposal.wrappedOutcome(2),
        proposal.wrappedOutcome(3),
        proposal.collateralToken1(),
        proposal.collateralToken2(),
        proposal.marketName().catch(() => 'Unknown'),
    ]);

    return {
        yesCompany: wo0.wrapped1155 || wo0[0],
        noCompany: wo1.wrapped1155 || wo1[0],
        yesCurrency: wo2.wrapped1155 || wo2[0],
        noCurrency: wo3.wrapped1155 || wo3[0],
        companyToken,
        currencyToken,
        marketName,
    };
}

/**
 * Find a pool for a token pair using the chain's factory
 */
async function findPool(provider, chainId, tokenA, tokenB) {
    const config = CHAIN_CONFIG[chainId];
    const ZERO = ethers.constants.AddressZero;

    if (config.mode === 'algebra') {
        const factory = new ethers.Contract(config.factory, ALGEBRA_FACTORY_ABI, provider);

        // Try both orderings — poolByPair is order-sensitive
        let pool = await factory.poolByPair(tokenA, tokenB).catch(() => ZERO);
        if (pool === ZERO) {
            pool = await factory.poolByPair(tokenB, tokenA).catch(() => ZERO);
        }
        return pool === ZERO ? null : pool;

    } else if (config.mode === 'uniswap') {
        const factory = new ethers.Contract(config.factory, UNISWAP_FACTORY_ABI, provider);

        // Try all fee tiers in parallel for speed
        const results = await Promise.all(
            config.feeTiers.map(fee =>
                factory.getPool(tokenA, tokenB, fee).catch(() => ZERO)
            )
        );
        const pool = results.find(r => r !== ZERO);
        return pool || null;
    }

    return null;
}

/**
 * Discover the YES and NO conditional pools from proposal tokens.
 * 
 * TWAP conditional pools:
 *   YES pool = YES_COMPANY / YES_CURRENCY
 *   NO pool  = NO_COMPANY  / NO_CURRENCY
 */
async function discoverConditionalPools(provider, chainId, tokens) {
    const [yesPool, noPool] = await Promise.all([
        findPool(provider, chainId, tokens.yesCompany, tokens.yesCurrency),
        findPool(provider, chainId, tokens.noCompany, tokens.noCurrency),
    ]);

    return { yesPool, noPool };
}

/**
 * Auto-detect inversion by reading pool.token0() and comparing to company token.
 * If company token is token1, price is company/currency → needs inversion to get currency/company.
 */
async function detectInversion(provider, poolAddress, companyTokenAddress) {
    const pool = new ethers.Contract(poolAddress, POOL_TOKEN_ABI, provider);
    const token0 = await pool.token0();

    // If company token is token0 → price = 1.0001^tick = currency/company → no inversion needed
    // If company token is token1 → price = 1.0001^tick = company/currency → invert
    const shouldInvert = token0.toLowerCase() !== companyTokenAddress.toLowerCase();

    return { shouldInvert, token0 };
}

// ─── TWAP Calculation ────────────────────────────────────────────────────────

/**
 * Calculate TWAP from pool oracle
 * Works for both Algebra (getTimepoints) and Uniswap V3 (observe)
 */
async function calculatePoolTwap(provider, chainId, poolAddress, secondsAgo, shouldInvert) {
    const config = CHAIN_CONFIG[chainId];
    const secondsWindow = Math.max(1, Math.floor(secondsAgo));

    let tickCumulatives;

    if (config.mode === 'algebra') {
        const pool = new ethers.Contract(poolAddress, ALGEBRA_TWAP_ABI, provider);
        const result = await pool.getTimepoints([secondsWindow, 0]);
        tickCumulatives = result.tickCumulatives || result[0];
    } else {
        const pool = new ethers.Contract(poolAddress, UNISWAP_TWAP_ABI, provider);
        const result = await pool.observe([secondsWindow, 0]);
        tickCumulatives = result.tickCumulatives || result[0];
    }

    const latest = BigInt(tickCumulatives[1].toString());
    const oldest = BigInt(tickCumulatives[0].toString());
    const tickDelta = latest - oldest;
    const averageTick = Number(tickDelta) / secondsWindow;

    // price = 1.0001^averageTick
    const rawPrice = Math.pow(1.0001, averageTick);

    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
        throw new Error('Invalid price from oracle');
    }

    const normalizedPrice = shouldInvert ? 1 / rawPrice : rawPrice;

    return {
        rawPrice,
        normalizedPrice,
        averageTick,
        secondsWindow,
        inverted: shouldInvert,
    };
}

/**
 * Get current spot price from pool
 */
async function getSpotPrice(provider, chainId, poolAddress, shouldInvert) {
    const config = CHAIN_CONFIG[chainId];

    let tick;
    if (config.mode === 'algebra') {
        const pool = new ethers.Contract(poolAddress, ALGEBRA_TWAP_ABI, provider);
        const state = await pool.globalState();
        tick = Number(state.tick ?? state[1]);
    } else {
        const pool = new ethers.Contract(poolAddress, UNISWAP_TWAP_ABI, provider);
        const state = await pool.slot0();
        tick = Number(state.tick ?? state[1]);
    }

    const rawPrice = Math.pow(1.0001, tick);
    return shouldInvert ? 1 / rawPrice : rawPrice;
}

/**
 * Get token symbol + decimals
 */
async function getTokenInfo(provider, address) {
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
        token.symbol().catch(() => 'UNKNOWN'),
        token.decimals().catch(() => 18),
    ]);
    return { address, symbol, decimals };
}

// ─── Full TWAP Calculation ───────────────────────────────────────────────────

async function calculateTwap(proposalAddress, chainId, endTimestamp, days) {
    const config = CHAIN_CONFIG[chainId];
    if (!config) throw new Error(`Unsupported chain ${chainId}`);

    const provider = getProvider(chainId);
    const now = Math.floor(Date.now() / 1000);

    // TWAP window
    const twapDurationSeconds = days * 86400;
    const twapStartTimestamp = endTimestamp - twapDurationSeconds;

    // Determine status
    let status;
    if (now < twapStartTimestamp) status = 'NOT_STARTED';
    else if (now >= endTimestamp) status = 'ENDED';
    else status = 'ACTIVE';

    console.log(`\n[TWAP] ${proposalAddress} on ${config.name}`);
    console.log(`  Window: ${new Date(twapStartTimestamp * 1000).toISOString()} → ${new Date(endTimestamp * 1000).toISOString()} (${days}d)`);
    console.log(`  Status: ${status}`);

    // 1. Get tokens from proposal contract
    console.log('  📦 Reading wrappedOutcome tokens...');
    const tokens = await getProposalTokens(provider, proposalAddress);

    // 2. Discover pools on-chain
    console.log('  🔍 Discovering conditional pools via factory...');
    const pools = await discoverConditionalPools(provider, chainId, tokens);

    if (!pools.yesPool || !pools.noPool) {
        return {
            proposalAddress,
            chainId,
            chain: config.name,
            marketName: tokens.marketName,
            error: 'Could not find YES/NO conditional pools on-chain',
            pools: { yes: pools.yesPool, no: pools.noPool },
            tokens: {
                yesCompany: tokens.yesCompany,
                noCompany: tokens.noCompany,
                yesCurrency: tokens.yesCurrency,
                noCurrency: tokens.noCurrency,
                companyToken: tokens.companyToken,
                currencyToken: tokens.currencyToken,
            },
        };
    }

    console.log(`  ✅ YES pool: ${pools.yesPool}`);
    console.log(`  ✅ NO pool:  ${pools.noPool}`);

    // 3. Auto-detect inversion
    console.log('  🔄 Detecting token ordering (inversion)...');
    const [yesInversion, noInversion] = await Promise.all([
        detectInversion(provider, pools.yesPool, tokens.yesCompany),
        detectInversion(provider, pools.noPool, tokens.noCompany),
    ]);
    console.log(`  YES pool: company is token${yesInversion.shouldInvert ? '1' : '0'} → invert=${yesInversion.shouldInvert}`);
    console.log(`  NO pool:  company is token${noInversion.shouldInvert ? '1' : '0'} → invert=${noInversion.shouldInvert}`);

    // 4. Get token info for display
    const [companyInfo, currencyInfo] = await Promise.all([
        getTokenInfo(provider, tokens.companyToken),
        getTokenInfo(provider, tokens.currencyToken),
    ]);

    // Build result
    const result = {
        proposalAddress,
        chainId,
        chain: config.name,
        marketName: tokens.marketName,
        tokens: {
            company: companyInfo,
            currency: currencyInfo,
            yesCompany: tokens.yesCompany,
            noCompany: tokens.noCompany,
            yesCurrency: tokens.yesCurrency,
            noCurrency: tokens.noCurrency,
        },
        pools: {
            yes: { address: pools.yesPool, inverted: yesInversion.shouldInvert },
            no: { address: pools.noPool, inverted: noInversion.shouldInvert },
        },
        twapWindow: {
            startTimestamp: twapStartTimestamp,
            startDate: new Date(twapStartTimestamp * 1000).toISOString(),
            endTimestamp,
            endDate: new Date(endTimestamp * 1000).toISOString(),
            days,
            durationSeconds: twapDurationSeconds,
        },
        status,
        timestamp: new Date().toISOString(),
    };

    // If not started, show countdown
    if (status === 'NOT_STARTED') {
        result.timeUntilStart = {
            seconds: twapStartTimestamp - now,
            human: formatDuration(twapStartTimestamp - now),
        };
        return result;
    }

    // 5. Calculate TWAP
    const timeSinceStart = Math.min(now - twapStartTimestamp, twapDurationSeconds);
    const secondsAgo = status === 'ENDED' ? twapDurationSeconds : timeSinceStart;

    console.log(`  📊 Calculating TWAP (${secondsAgo}s window)...`);

    try {
        const [yesTwap, noTwap, yesSpot, noSpot] = await Promise.all([
            calculatePoolTwap(provider, chainId, pools.yesPool, secondsAgo, yesInversion.shouldInvert),
            calculatePoolTwap(provider, chainId, pools.noPool, secondsAgo, noInversion.shouldInvert),
            getSpotPrice(provider, chainId, pools.yesPool, yesInversion.shouldInvert).catch(() => null),
            getSpotPrice(provider, chainId, pools.noPool, noInversion.shouldInvert).catch(() => null),
        ]);

        const spread = yesTwap.normalizedPrice - noTwap.normalizedPrice;
        const winner = spread > 1e-8 ? 'YES' : spread < -1e-8 ? 'NO' : 'TIE';
        const loser = Math.min(yesTwap.normalizedPrice, noTwap.normalizedPrice);
        const percentDiff = loser > 0 ? (Math.abs(spread) / loser * 100) : 0;

        result.twap = {
            yes: {
                price: yesTwap.normalizedPrice,
                rawPrice: yesTwap.rawPrice,
                averageTick: yesTwap.averageTick,
                inverted: yesTwap.inverted,
            },
            no: {
                price: noTwap.normalizedPrice,
                rawPrice: noTwap.rawPrice,
                averageTick: noTwap.averageTick,
                inverted: noTwap.inverted,
            },
            spread,
            percentDiff: percentDiff.toFixed(4),
            winner,
            windowSeconds: secondsAgo,
            windowHours: (secondsAgo / 3600).toFixed(2),
        };

        if (yesSpot !== null || noSpot !== null) {
            result.spot = { yes: yesSpot, no: noSpot };
        }

        if (status === 'ACTIVE') {
            const remaining = endTimestamp - now;
            result.timeRemaining = {
                seconds: remaining,
                human: formatDuration(remaining),
            };
        }

        console.log(`  ✅ YES TWAP: ${yesTwap.normalizedPrice.toFixed(6)}, NO TWAP: ${noTwap.normalizedPrice.toFixed(6)}`);
        console.log(`  🏆 Winner: ${winner} (spread: ${spread.toFixed(6)}, ${percentDiff.toFixed(2)}%)`);

    } catch (err) {
        result.error = `TWAP calculation failed: ${err.message}`;
        console.error(`  ❌ TWAP error: ${err.message}`);
    }

    return result;
}

function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0) parts.push(`${s}s`);
    return parts.join(' ') || '0s';
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'express-twap', uptime: process.uptime() });
});

// Calculate TWAP for a proposal
// GET /twap/:chainId/:proposalAddress?endTimestamp=1234567890&days=5
// If endTimestamp is omitted, defaults to "now" (calculates TWAP looking back N days from now)
app.get('/twap/:chainId/:proposalAddress', async (req, res) => {
    try {
        const { chainId: chainIdStr, proposalAddress } = req.params;
        const chainId = parseInt(chainIdStr);

        if (!/^0x[a-fA-F0-9]{40}$/.test(proposalAddress)) {
            return res.status(400).json({ error: 'Invalid proposal address' });
        }
        if (!CHAIN_CONFIG[chainId]) {
            return res.status(400).json({ error: `Unsupported chain ${chainId}. Use 100 (Gnosis) or 1 (Ethereum)` });
        }

        const days = parseFloat(req.query.days) || 5;

        // endTimestamp: if omitted, defaults to now (useful for testing / live tracking)
        const now = Math.floor(Date.now() / 1000);
        const endTimestamp = parseInt(req.query.endTimestamp) || now;

        const result = await calculateTwap(proposalAddress, chainId, endTimestamp, days);
        res.json(result);

    } catch (err) {
        console.error('[/twap] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Discover pools only (no TWAP calculation)
// GET /pools/:chainId/:proposalAddress
app.get('/pools/:chainId/:proposalAddress', async (req, res) => {
    try {
        const { chainId: chainIdStr, proposalAddress } = req.params;
        const chainId = parseInt(chainIdStr);

        if (!/^0x[a-fA-F0-9]{40}$/.test(proposalAddress)) {
            return res.status(400).json({ error: 'Invalid proposal address' });
        }

        const config = CHAIN_CONFIG[chainId];
        if (!config) return res.status(400).json({ error: `Unsupported chain ${chainId}. Use 100 (Gnosis) or 1 (Ethereum)` });

        const provider = getProvider(chainId);

        // 1. Tokens
        const tokens = await getProposalTokens(provider, proposalAddress);

        // 2. Discover all 6 pools
        const pairs = [
            { name: 'YES_COMPANY/YES_CURRENCY (Conditional)', t0: tokens.yesCompany, t1: tokens.yesCurrency },
            { name: 'NO_COMPANY/NO_CURRENCY (Conditional)', t0: tokens.noCompany, t1: tokens.noCurrency },
            { name: 'YES_COMPANY/BASE_CURRENCY (Prediction)', t0: tokens.yesCompany, t1: tokens.currencyToken },
            { name: 'NO_COMPANY/BASE_CURRENCY (Prediction)', t0: tokens.noCompany, t1: tokens.currencyToken },
            { name: 'YES_CURRENCY/BASE_CURRENCY (Prediction)', t0: tokens.yesCurrency, t1: tokens.currencyToken },
            { name: 'NO_CURRENCY/BASE_CURRENCY (Prediction)', t0: tokens.noCurrency, t1: tokens.currencyToken },
        ];

        const poolResults = [];
        for (const pair of pairs) {
            const address = await findPool(provider, chainId, pair.t0, pair.t1);
            let inversion = null;
            if (address) {
                // Check token ordering for the conditional pools (first two)
                if (pair.name.includes('Conditional')) {
                    const companyToken = pair.name.startsWith('YES') ? tokens.yesCompany : tokens.noCompany;
                    inversion = await detectInversion(provider, address, companyToken);
                }
            }
            poolResults.push({
                name: pair.name,
                address: address || null,
                exists: !!address,
                inverted: inversion?.shouldInvert ?? null,
            });
        }

        // Token info
        const [companyInfo, currencyInfo] = await Promise.all([
            getTokenInfo(provider, tokens.companyToken),
            getTokenInfo(provider, tokens.currencyToken),
        ]);

        res.json({
            proposalAddress,
            chainId,
            chain: config.name,
            marketName: tokens.marketName,
            tokens: {
                company: companyInfo,
                currency: currencyInfo,
                yesCompany: tokens.yesCompany,
                noCompany: tokens.noCompany,
                yesCurrency: tokens.yesCurrency,
                noCurrency: tokens.noCurrency,
            },
            pools: poolResults,
            found: poolResults.filter(p => p.exists).length,
            total: poolResults.length,
        });

    } catch (err) {
        console.error('[/pools] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🕐 Express TWAP Server running on http://localhost:${PORT}`);
    console.log(`\n  Endpoints:`);
    console.log(`    GET /health                                             - Health check`);
    console.log(`    GET /pools/:chainId/:proposalAddress                    - Discover all 6 pools on-chain`);
    console.log(`    GET /twap/:chainId/:proposalAddress                     - Calculate TWAP`);
    console.log(`        ?endTimestamp=1234567890                            - Market close time (unix, default: now)`);
    console.log(`        &days=5                                             - TWAP window in days (default: 5)`);
    console.log(`\n  Example:`);
    console.log(`    curl "http://localhost:${PORT}/pools/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"`);
    console.log(`    curl "http://localhost:${PORT}/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc?endTimestamp=1738886400&days=5"`);
    console.log(`    curl "http://localhost:${PORT}/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"  # defaults to now, last 5 days`);
    console.log('');
});
