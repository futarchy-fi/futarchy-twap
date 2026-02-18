/**
 * Express TWAP Server — thin HTTP wrapper around lib/index.js
 * 
 * All core logic lives in ./lib — this file just maps HTTP routes to library functions.
 * 
 * Endpoints:
 *   GET /twap/:chainId/:proposalAddress?endTimestamp=...&days=5
 *   GET /pools/:chainId/:proposalAddress
 *   GET /health
 */

const express = require('express');
const cors = require('cors');
const { calculateTwap, discoverPools, CHAIN_CONFIG } = require('./lib');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3005;

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

        const options = {};
        if (req.query.days) options.days = parseFloat(req.query.days);
        if (req.query.endTimestamp) options.endTimestamp = parseInt(req.query.endTimestamp);

        const result = await calculateTwap(proposalAddress, chainId, options);
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
        if (!CHAIN_CONFIG[chainId]) {
            return res.status(400).json({ error: `Unsupported chain ${chainId}. Use 100 (Gnosis) or 1 (Ethereum)` });
        }

        const result = await discoverPools(proposalAddress, chainId);
        res.json(result);

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
