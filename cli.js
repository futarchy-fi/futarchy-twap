#!/usr/bin/env node

/**
 * Futarchy TWAP CLI
 * 
 * Usage:
 *   node cli.js twap <chainId> <proposalAddress> [--endTimestamp <ts>] [--days <n>] [--rpc <url>]
 *   node cli.js pools <chainId> <proposalAddress> [--rpc <url>]
 * 
 * Examples:
 *   node cli.js twap 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc
 *   node cli.js twap 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc --endTimestamp 1738886400 --days 5
 *   node cli.js pools 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc
 *   node cli.js twap 100 0x45e1064... --rpc https://my-custom-rpc.com
 */

const { calculateTwap, discoverPools } = require('./lib');

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

function parseArgs(args) {
    const parsed = { _: [] };
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            parsed[key] = args[i + 1];
            i++;
        } else {
            parsed._.push(args[i]);
        }
    }
    return parsed;
}

function printUsage() {
    console.log(`
Futarchy TWAP — On-Chain TWAP Calculator

Usage:
  futarchy-twap twap  <chainId> <proposalAddress> [options]
  futarchy-twap pools <chainId> <proposalAddress> [options]

Commands:
  twap    Calculate TWAP for a proposal
  pools   Discover all 6 pools for a proposal

Options:
  --endTimestamp <ts>   Unix timestamp for TWAP window end (default: now)
  --days <n>            TWAP window in days (default: 5)
  --rpc <url>           Override the default RPC URL for the chain

Chains:
  100   Gnosis (Algebra / Swapr)
  1     Ethereum (Uniswap V3)

Examples:
  futarchy-twap twap 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc
  futarchy-twap twap 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc --endTimestamp 1738886400 --days 5
  futarchy-twap pools 100 0x45e1064348fd8a407d6d1f59fc64b05f633b28fc
  futarchy-twap twap 1 0xABC... --rpc https://my-custom-rpc.com
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    const chainId = parseInt(args._[1]);
    const proposalAddress = args._[2];

    if (!command || !chainId || !proposalAddress) {
        printUsage();
        process.exit(command ? 1 : 0);
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(proposalAddress)) {
        console.error('Error: Invalid proposal address');
        process.exit(1);
    }

    const options = {};
    if (args.endTimestamp) options.endTimestamp = parseInt(args.endTimestamp);
    if (args.days) options.days = parseFloat(args.days);
    if (args.rpc) options.rpcUrl = args.rpc;

    try {
        let result;

        if (command === 'twap') {
            result = await calculateTwap(proposalAddress, chainId, options);
        } else if (command === 'pools') {
            result = await discoverPools(proposalAddress, chainId, options);
        } else {
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
        }

        console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

main();
