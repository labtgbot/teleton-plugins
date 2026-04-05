/**
 * TONCO DEX plugin — concentrated liquidity AMM on TON
 *
 * Browse pools, get swap quotes, execute swaps, and view liquidity positions
 * on TONCO — a next-generation AMM with concentrated liquidity on TON.
 *
 * TONCO SDK: https://github.com/cryptoalgebra/tonco-sdk
 * TONCO Protocol: https://tonco.io
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// CJS dependencies
// ---------------------------------------------------------------------------

const _require = createRequire(realpathSync(process.argv[1]));
const _pluginRequire = createRequire(import.meta.url);

const { Address } = _require("@ton/core");
const { TonClient } = _require("@ton/ton");

// TONCO SDK — loaded from plugin's local node_modules
let ToncoSDK = null;
try {
  ToncoSDK = _pluginRequire("@toncodex/sdk");
} catch {
  // SDK not available; swap estimation and on-chain tools will use API fallback
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TONCO GraphQL indexer endpoint */
const INDEXER_URL = "https://indexer.tonco.io/graphql";

/** TONCO farming APR API */
const FARMING_API = "https://api-farming.tonco.io";

/** Module-level SDK reference (set in tools(sdk) factory) */
let _sdk = null;

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL query against the TONCO indexer.
 * @param {string} query - GraphQL query string
 * @param {object} [variables] - Query variables
 * @returns {Promise<any>} Parsed response data
 */
async function gqlQuery(query, variables = {}) {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TONCO indexer error: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// TonClient helper (lazy, cached)
// ---------------------------------------------------------------------------

let _tonClient = null;

/**
 * Get or create a TonClient instance.
 * Uses @orbs-network/ton-access for decentralized endpoints when available.
 * @returns {Promise<TonClient>}
 */
async function getTonClient() {
  if (_tonClient) return _tonClient;
  let endpoint;
  try {
    const { getHttpEndpoint } = _pluginRequire("@orbs-network/ton-access");
    endpoint = await getHttpEndpoint({ network: "mainnet" });
  } catch {
    endpoint = "https://toncenter.com/api/v2/jsonRPC";
  }
  _tonClient = new TonClient({ endpoint });
  return _tonClient;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format a raw token amount (bigint string) to human-readable decimal.
 * @param {string|bigint|number} raw - Raw amount in smallest units
 * @param {number} decimals - Token decimals
 * @returns {string} Human-readable amount
 */
function formatAmount(raw, decimals = 9) {
  if (!raw && raw !== 0n) return "0";
  const s = String(raw);
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Format a USD value string for display.
 * @param {string|number|null} val
 * @returns {string}
 */
function formatUsd(val) {
  if (!val) return "0";
  const n = parseFloat(val);
  if (isNaN(n)) return "0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Parse a human-readable amount to raw bigint units.
 * @param {string|number} amount - Human-readable amount (e.g. "10.5")
 * @param {number} decimals - Token decimals
 * @returns {bigint}
 */
function parseAmount(amount, decimals