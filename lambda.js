/**
 * AWS Lambda Handler — futarchy-twap
 *
 * Maps API Gateway HTTP API events to lib/index.js functions.
 * No Express needed — pure Lambda.
 *
 * Routes:
 *   GET /health
 *   GET /twap/{chainId}/{proposalAddress}?endTimestamp=...&days=5
 *   GET /pools/{chainId}/{proposalAddress}
 */

const { calculateTwap, discoverPools, CHAIN_CONFIG } = require('./lib');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function response(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
        body: JSON.stringify(body),
    };
}

function parsePathParams(path) {
    // Supports both API Gateway v1 (/twap/100/0xABC) and v2 path formats
    const twapMatch = path.match(/^\/twap\/(\d+)\/(0x[a-fA-F0-9]{40})\/?$/);
    if (twapMatch) return { route: 'twap', chainId: parseInt(twapMatch[1]), proposalAddress: twapMatch[2] };

    const poolsMatch = path.match(/^\/pools\/(\d+)\/(0x[a-fA-F0-9]{40})\/?$/);
    if (poolsMatch) return { route: 'pools', chainId: parseInt(poolsMatch[1]), proposalAddress: poolsMatch[2] };

    if (path === '/health' || path === '/health/') return { route: 'health' };

    return null;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
    // Support both API Gateway v1 (REST) and v2 (HTTP API) event formats
    const path = event.rawPath || event.path || '/';
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const qs = event.queryStringParameters || {};

    // Handle CORS preflight
    if (method === 'OPTIONS') {
        return response(200, {});
    }

    const parsed = parsePathParams(path);

    if (!parsed) {
        return response(404, { error: `Route not found: ${path}` });
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (parsed.route === 'health') {
        return response(200, { status: 'ok', service: 'futarchy-twap-lambda' });
    }

    const { chainId, proposalAddress } = parsed;

    // Validate inputs
    if (!/^0x[a-fA-F0-9]{40}$/.test(proposalAddress)) {
        return response(400, { error: 'Invalid proposal address' });
    }
    if (!CHAIN_CONFIG[chainId]) {
        return response(400, { error: `Unsupported chain ${chainId}. Use 100 (Gnosis) or 1 (Ethereum)` });
    }

    // ── GET /pools/:chainId/:proposalAddress ─────────────────────────────────
    if (parsed.route === 'pools') {
        try {
            const result = await discoverPools(proposalAddress, chainId);
            return response(200, result);
        } catch (err) {
            console.error('[/pools] Error:', err.message);
            return response(500, { error: err.message });
        }
    }

    // ── GET /twap/:chainId/:proposalAddress ──────────────────────────────────
    if (parsed.route === 'twap') {
        try {
            const options = {};
            if (qs.days) options.days = parseFloat(qs.days);
            if (qs.endTimestamp) options.endTimestamp = parseInt(qs.endTimestamp);

            const result = await calculateTwap(proposalAddress, chainId, options);
            return response(200, result);
        } catch (err) {
            console.error('[/twap] Error:', err.message);
            return response(500, { error: err.message });
        }
    }

    return response(404, { error: 'Not found' });
};
