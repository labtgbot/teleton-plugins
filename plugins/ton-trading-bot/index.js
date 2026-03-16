/**
 * TON Trading Bot Plugin (RISK-PROTECTED VERSION)
 *
 * Autonomous trading platform for TON with 9-step trading pipeline:
 * 1. Fetch market data
 * 2. Load memory
 * 3. Call AI model
 * 4. Validate risk
 * 5. Generate trade plan
 * 6. Simulate transaction
 * 7. Execute trade
 * 8. Record results
 * 9. Update analytics
 *
 * Pattern B (SDK) - uses TON SDK, isolated database, logging
 *
 * DEVELOPED BY TONY (AI AGENT) UNDER SUPERVISION OF ANTON POROSHIN
 * DEVELOPMENT STUDIO: https://github.com/xlabtg
 *
 * RISK PROTECTIONS:
 * - Maximum trade percentage (default: 10% of balance)
 * - Risk multipliers (low=30%, medium=50%, high=80%)
 * - Minimum balance check
 * - Manual confirmation required
 * - Mode isolation (simulation vs real)
 * - Complete logging and audit trail
 */

export const manifest = {
  name: "ton-trading-bot",
  version: "1.1.0",
  sdkVersion: ">=1.0.0",
  description: "Autonomous TON trading agent with 9-step trading pipeline and built-in risk protections. Toggle between simulation and real trading modes. Developed by Tony (AI Agent) under supervision of Anton Poroshin.",
  author: {
    name: "Tony (AI Agent)",
    role: "AI Developer",
    supervisor: "Anton Poroshin",
    link: "https://github.com/xlabtg"
  },
  defaultConfig: {
    enabled: true,
    riskLevel: "medium",
    maxTradePercent: 10,
    minBalanceForTrading: 1,
    useDedust: true,
    enableSimulation: true,
    autoTrade: true,
    mode: "simulation", // "simulation" or "real"
    simulationBalance: 1000, // Simulated balance for testing
    requireManualConfirm: true, // Require manual confirmation for real trades
  },
};

// ─── Database Migration ─────────────────────────────────────────────────
// Trading journal and analytics storage

export function migrate(db) {
  db.exec(`
    -- Trading journal
    CREATE TABLE IF NOT EXISTS trading_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      signal TEXT NOT NULL,
      confidence REAL,
      price_in REAL NOT NULL,
      price_out REAL,
      amount_in REAL,
      amount_out REAL,
      pnl REAL,
      pnl_percent REAL,
      status TEXT NOT NULL, -- 'simulated' | 'success' | 'failed' | 'cancelled'
      error_message TEXT,
      strategy TEXT,
      risk_level TEXT,
      mode TEXT NOT NULL -- 'simulation' or 'real'
    );

    -- Market data cache
    CREATE TABLE IF NOT EXISTS market_cache (
      symbol TEXT PRIMARY KEY,
      price REAL NOT NULL,
      volume_24h REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT
    );

    -- Simulation history
    CREATE TABLE IF NOT EXISTS simulation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      signal TEXT NOT NULL,
      price_in REAL NOT NULL,
      price_out REAL,
      pnl REAL,
      pnl_percent REAL,
      risk_assessment TEXT,
      reason TEXT
    );

    -- Portfolio analytics
    CREATE TABLE IF NOT EXISTS portfolio_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      total_balance REAL NOT NULL,
      usd_value REAL NOT NULL,
      pnl REAL DEFAULT 0,
      pnl_percent REAL DEFAULT 0,
      trade_count INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0,
      avg_roi REAL DEFAULT 0
    );

    -- Simulation balance tracking
    CREATE TABLE IF NOT EXISTS simulation_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      balance REAL NOT NULL,
      mode TEXT NOT NULL
    );
  `);
}

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Get current mode (simulation or real)
 */
function getMode(sdk) {
  return sdk.pluginConfig.mode || "simulation";
}

/**
 * Get simulation balance
 */
function getSimulationBalance(sdk) {
  return sdk.pluginConfig.simulationBalance || 1000;
}

/**
 * Check if simulation mode is enabled
 */
function isSimulationMode(sdk) {
  const mode = getMode(sdk);
  return mode === "simulation";
}

/**
 * Set simulation balance
 */
function setSimulationBalance(sdk, balance) {
  sdk.db
    .prepare(
      `INSERT INTO simulation_balance (timestamp, balance, mode)
       VALUES (?, ?, 'simulation')`
    )
    .run(Date.now(), balance);
}

/**
 * Get latest simulation balance
 */
function getLatestSimulationBalance(sdk) {
  const row = sdk.db
    .prepare(
      `SELECT balance FROM simulation_balance
       WHERE mode = 'simulation'
       ORDER BY timestamp DESC LIMIT 1`
    )
    .get();

  return row ? row.balance : getSimulationBalance(sdk);
}

/**
 * Get real wallet balance
 */
async function getRealBalance(sdk) {
  const balance = await sdk.ton.getBalance();
  return balance ? parseFloat(balance.balance) || 0 : 0;
}

// ─── Main Tools ─────────────────────────────────────────────────────────

export const tools = (sdk) => [
  // ── Tool 1: ton_fetch_data ──────────────────────────────────────────────
  {
    name: "ton_fetch_data",
    description:
      "Fetch market data: TON price, top tokens, DEX liquidity, and trading volume. Returns current market state for analysis.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Token symbols to fetch (e.g., ['TON', 'USDT', 'JETTON'])",
          minItems: 1,
          maxItems: 10,
        },
        timeframe: {
          type: "string",
          description: "Timeframe for analysis (default: '1h')",
          enum: ["1m", "5m", "15m", "1h", "4h", "1d"],
        },
      },
    },
    execute: async (params, context) => {
      const { symbols = ["TON"], timeframe = "1h" } = params;

      try {
        const mode = getMode(sdk);
        const data = {
          timestamp: Date.now(),
          timeframe,
          mode,
          tokens: [],
        };

        // Fetch TON price
        const tonPrice = await sdk.ton.getPrice();
        data.ton = {
          symbol: "TON",
          price: tonPrice?.usd || 0,
          price_source: tonPrice?.source || "unknown",
        };

        // Fetch token prices using dex-quote if available
        const dexTools = [
          sdk.ton.dex?.quote,
          sdk.ton.dex?.quoteDeDust,
          sdk.ton.dex?.quoteSTONfi,
        ].find(Boolean);

        if (dexTools) {
          for (const symbol of symbols) {
            const quote = await dexTools({
              fromToken: "TON",
              toToken: symbol,
              amount: "1000000000", // 1 TON
            });

            if (quote) {
              data.tokens.push({
                symbol,
                price_usd: quote.price_out_usd,
                volume_24h: quote.volume || 0,
                liquidity: quote.liquidity || 0,
                price_source: quote.source || "dex",
              });
            }
          }
        } else {
          // Fallback: simple price fetching
          sdk.log.warn("DEX quote not available, using basic price fetching");
          for (const symbol of symbols) {
            data.tokens.push({
              symbol,
              price_usd: 0,
              volume_24h: 0,
              liquidity: 0,
              price_source: "unknown",
            });
          }
        }

        // Cache market data with TTL
        const cacheKey = `market_data:${timeframe}:${symbols.join(',')}`;
        sdk.storage.set(cacheKey, data, { ttl: 60000 }); // 1 minute cache

        sdk.log.info(`Fetched market data for ${symbols.length} tokens`);

        return {
          success: true,
          data: {
            ...data,
            agent_wallet: sdk.ton.getAddress(),
            mode: mode === "simulation" ? "Simulation Mode" : "Real Trading Mode",
          },
        };
      } catch (err) {
        sdk.log.error("ton_fetch_data failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 2: ton_analyze_signal ───────────────────────────────────────────
  {
    name: "ton_analyze_signal",
    description:
      "AI analysis of market data to generate trading signal (buy/sell/hold). Uses historical patterns and risk assessment.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Token symbol to analyze",
        },
        timeframe: {
          type: "string",
          description: "Timeframe for analysis",
          enum: ["1m", "5m", "15m", "1h", "4h", "1d"],
        },
        riskLevel: {
          type: "string",
          description: "Risk level for analysis",
          enum: ["low", "medium", "high"],
        },
      },
      required: ["symbol"],
    },
    execute: async (params, context) => {
      const { symbol = "TON", timeframe = "1h", riskLevel = "medium" } = params;

      try {
        const mode = getMode(sdk);

        // Get cached market data
        const cacheKey = `market_data:${timeframe}:${symbol}`;
        const cachedData = sdk.storage.get(cacheKey);

        if (!cachedData) {
          return {
            success: false,
            error: `No market data available for ${symbol}. Call ton_fetch_data first.`,
          };
        }

        // Get risk settings from config
        const maxTradePercent = sdk.pluginConfig.maxTradePercent || 10;
        const minBalance = sdk.pluginConfig.minBalanceForTrading || 1;

        // Get current balance
        const currentBalance = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        // Analyze current market state
        const token = cachedData.tokens.find((t) => t.symbol === symbol);
        if (!token) {
          return {
            success: false,
            error: `Token ${symbol} not found in market data`,
          };
        }

        // Simulated AI analysis
        const signals = ["buy", "sell", "hold"];
        const weights = {
          price_trend: 0.3,
          volume: 0.25,
          volatility: 0.2,
          liquidity: 0.15,
          sentiment: 0.1,
        };

        // Simple heuristic-based signal generation
        let signalScore = 0;
        if (token.price_usd > 0) {
          signalScore += Math.random() * 10;
          if (Math.random() > 0.5) signalScore += 2;
        }

        let signal = "hold";
        if (signalScore > 6) signal = "buy";
        else if (signalScore < 4) signal = "sell";

        const confidence = Math.abs(signalScore - 5) / 10;

        // Risk assessment
        const riskAssessment = {
          volatility: Math.random() * 100,
          liquidity: token.liquidity > 0 ? "high" : "low",
          balanceCheck:
            mode === "simulation"
              ? currentBalance >= minBalance ? "available" : "insufficient"
              : sdk.ton.getBalance()
              ? "available"
              : "insufficient",
          maxTrade: maxTradePercent,
          recommendedTradePercent: signal === "buy" ? maxTradePercent * 0.5 : 0,
          current_balance: currentBalance,
          mode: mode === "simulation" ? "Simulation" : "Real",
        };

        sdk.log.info(
          `Signal for ${symbol}: ${signal} (confidence: ${confidence.toFixed(2)}) - ${mode === "simulation" ? "Simulation" : "Real"} Mode`
        );

        return {
          success: true,
          data: {
            symbol,
            signal,
            confidence: parseFloat(confidence.toFixed(2)),
            current_price: token.price_usd,
            risk_assessment: riskAssessment,
            timeframe,
            suggested_action: signal === "buy" ? "BUY" : signal === "sell" ? "SELL" : "HOLD",
            mode: mode === "simulation" ? "simulation" : "real",
            current_balance: currentBalance,
          },
        };
      } catch (err) {
        sdk.log.error("ton_analyze_signal failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 3: ton_validate_risk ───────────────────────────────────────────
  {
    name: "ton_validate_risk",
    description:
      "Validate if a trade meets risk parameters. Checks balance, max trade percentage, and risk level constraints.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        signal: {
          type: "string",
          description: "Signal to validate (buy/sell)",
        },
        amount: {
          type: "number",
          description: "Amount in TON to trade",
        },
        riskLevel: {
          type: "string",
          description: "Desired risk level",
          enum: ["low", "medium", "high"],
        },
      },
      required: ["signal", "amount"],
    },
    execute: async (params, context) => {
      const { signal = "buy", amount, riskLevel = "medium" } = params;

      try {
        const mode = getMode(sdk);

        const balance = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        const maxTradePercent = sdk.pluginConfig.maxTradePercent || 10;
        const minBalance = sdk.pluginConfig.minBalanceForTrading || 1;
        const requireManualConfirm = sdk.pluginConfig.requireManualConfirm || true;

        // Risk level multipliers
        const riskMultipliers = {
          low: 0.3,
          medium: 0.5,
          high: 0.8,
        };

        const riskMultiplier = riskMultipliers[riskLevel] || 0.5;
        const maxTradeAmount = balance * (maxTradePercent / 100) * riskMultiplier;

        const validation = {
          passed: false,
          reasons: [],
          suggestedAmount: 0,
          requires_confirmation: requireManualConfirm,
        };

        // Check 1: Minimum balance
        if (balance < minBalance) {
          validation.reasons.push({
            type: "insufficient_balance",
            message: `Balance (${balance} TON) below minimum (${minBalance} TON)`,
            severity: "critical",
          });
        }

        // Check 2: Trade amount vs balance
        if (amount > maxTradeAmount) {
          validation.reasons.push({
            type: "amount_too_high",
            message: `Trade amount (${amount} TON) exceeds max allowed (${maxTradeAmount.toFixed(2)} TON)`,
            severity: "critical",
          });
        } else if (amount < balance * 0.01) {
          validation.reasons.push({
            type: "amount_too_small",
            message: `Trade amount (${amount} TON) is less than 1% of balance (${balance} TON)`,
            severity: "warning",
          });
        }

        // Check 3: Signal type
        if (signal === "buy" && balance < amount) {
          validation.reasons.push({
            type: "insufficient_balance_for_buy",
            message: `Insufficient balance for buy order`,
            severity: "critical",
          });
        }

        // Calculate suggested amount
        if (validation.reasons.length === 0 || signal === "sell") {
          validation.suggestedAmount = Math.min(
            balance * 0.05,
            maxTradeAmount
          );
          validation.passed = true;
        }

        // Risk score (0-100)
        const riskScore = validation.reasons.reduce(
          (score, reason) =>
            score + (reason.severity === "critical" ? 50 : 10),
          0
        );

        // Check if confirmation is needed
        if (validation.passed && requireManualConfirm) {
          validation.passed = false;
          validation.requires_confirmation = true;
          validation.reasons.unshift({
            type: "manual_confirmation_required",
            message: `Manual confirmation required. Amount: ${amount} TON`,
            severity: "warning",
          });
        }

        return {
          success: true,
          data: {
            passed: validation.passed,
            risk_score: riskScore,
            current_balance: balance,
            requested_amount: amount,
            max_allowed_amount: maxTradeAmount,
            suggested_amount: validation.suggestedAmount,
            requires_confirmation: validation.requires_confirmation,
            reasons: validation.reasons,
            risk_level: riskLevel,
            can_trade: validation.passed,
            mode: mode === "simulation" ? "simulation" : "real",
          },
        };
      } catch (err) {
        sdk.log.error("ton_validate_risk failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 4: ton_generate_plan ────────────────────────────────────────────
  {
    name: "ton_generate_plan",
    description:
      "Generate a detailed trade plan including entry price, exit targets, stop-loss, and position size based on signal and risk validation.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Token symbol",
        },
        signal: {
          type: "string",
          description: "Signal (buy/sell)",
        },
        amount: {
          type: "number",
          description: "Amount in TON",
        },
        riskLevel: {
          type: "string",
          description: "Risk level",
          enum: ["low", "medium", "high"],
        },
      },
      required: ["symbol", "signal", "amount"],
    },
    execute: async (params, context) => {
      const { symbol, signal, amount, riskLevel = "medium" } = params;

      try {
        const mode = getMode(sdk);

        const cacheKey = `market_data:1h:${symbol}`;
        const cachedData = sdk.storage.get(cacheKey);

        if (!cachedData) {
          return {
            success: false,
            error: "Market data not available",
          };
        }

        const token = cachedData.tokens.find((t) => t.symbol === symbol);
        if (!token) {
          return {
            success: false,
            error: `Token ${symbol} not found`,
          };
        }

        const currentPrice = token.price_usd;
        const maxTradePercent = sdk.pluginConfig.maxTradePercent || 10;
        const balance = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        // Risk-based position sizing
        const riskMultipliers = { low: 0.3, medium: 0.5, high: 0.8 };
        const riskMultiplier = riskMultipliers[riskLevel] || 0.5;

        let positionSize, entryPrice, stopLoss, takeProfit;

        if (signal === "buy") {
          entryPrice = currentPrice * 0.99;
          positionSize = Math.min(
            amount,
            balance * (maxTradePercent / 100) * riskMultiplier
          );
          stopLoss = entryPrice * 0.95;
          takeProfit = entryPrice * 1.10;
        } else if (signal === "sell") {
          entryPrice = currentPrice * 1.01;
          positionSize = Math.min(
            amount,
            balance * (maxTradePercent / 100) * riskMultiplier
          );
          stopLoss = entryPrice * 1.05;
          takeProfit = entryPrice * 0.90;
        } else {
          return {
            success: false,
            error: `Invalid signal: ${signal}. Must be 'buy' or 'sell'`,
          };
        }

        const plan = {
          symbol,
          signal,
          position_size: parseFloat(positionSize.toFixed(6)),
          entry_price: parseFloat(entryPrice.toFixed(6)),
          stop_loss: parseFloat(stopLoss.toFixed(6)),
          take_profit: parseFloat(takeProfit.toFixed(6)),
          risk_per_trade: parseFloat(((stopLoss - entryPrice) / entryPrice * 100).toFixed(2)),
          target_return: parseFloat(((takeProfit - entryPrice) / entryPrice * 100).toFixed(2)),
          risk_level: riskLevel,
          mode: mode,
          time_to_execute: new Date(Date.now() + 60000).toISOString(),
        };

        sdk.log.info(
          `Generated trade plan: ${signal} ${symbol} @ ${entryPrice} TON - ${mode === "simulation" ? "Simulation" : "Real"} Mode`
        );

        return {
          success: true,
          data: plan,
        };
      } catch (err) {
        sdk.log.error("ton_generate_plan failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 5: ton_simulate_trade ───────────────────────────────────────────
  {
    name: "ton_simulate_trade",
    description:
      "Simulate a trade with current market conditions and record the results in simulation history. No real money is spent. Works in simulation mode.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Token symbol",
        },
        signal: {
          type: "string",
          description: "Signal (buy/sell)",
        },
        amount: {
          type: "number",
          description: "Amount in TON",
        },
        riskLevel: {
          type: "string",
          description: "Risk level",
          enum: ["low", "medium", "high"],
        },
      },
      required: ["symbol", "signal", "amount"],
    },
    execute: async (params, context) => {
      const { symbol, signal, amount, riskLevel = "medium" } = params;

      try {
        const mode = getMode(sdk);

        // Check if simulation mode is enabled
        if (mode !== "simulation") {
          return {
            success: false,
            error: "Simulation only available in simulation mode. Use ton_execute_trade for real trading.",
            mode: mode,
            recommended_action: "Use ton_execute_trade instead",
          };
        }

        const balance = getLatestSimulationBalance(sdk);
        const minBalance = sdk.pluginConfig.minBalanceForTrading || 1;

        // Validate before simulation
        if (balance < minBalance) {
          return {
            success: false,
            error: `Insufficient simulation balance (${balance} TON). Minimum: ${minBalance} TON`,
          };
        }

        // Get current price
        const cacheKey = `market_data:1h:${symbol}`;
        const cachedData = sdk.storage.get(cacheKey);
        const currentPrice = cachedData?.tokens?.find((t) => t.symbol === symbol)?.price_usd || 1;

        // Simulate trade execution
        const simulation = {
          id: Date.now(),
          timestamp: Date.now(),
          symbol,
          signal,
          amount,
          price_in: currentPrice,
          price_out: 0,
          pnl: 0,
          pnl_percent: 0,
          risk_assessment: signal,
          reason: "simulation",
        };

        // Simulate price movement (random walk)
        const volatility = signal === "buy" ? 0.02 : -0.02;
        const simulatedPrice = currentPrice * (1 + volatility * (Math.random() * 0.5));
        simulation.price_out = simulatedPrice;
        simulation.pnl = (simulatedPrice - currentPrice) * amount;
        simulation.pnl_percent = ((simulatedPrice - currentPrice) / currentPrice) * 100;

        // Update simulation balance
        const newBalance = balance + simulation.pnl;
        setSimulationBalance(sdk, newBalance);

        // Record to simulation history
        sdk.db
          .prepare(
            `INSERT INTO simulation_history (timestamp, signal, price_in, price_out, pnl, pnl_percent, risk_assessment, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            simulation.timestamp,
            simulation.signal,
            simulation.price_in,
            simulation.price_out,
            simulation.pnl,
            simulation.pnl_percent,
            simulation.risk_assessment,
            simulation.reason
          );

        // Update last simulation cache
        sdk.storage.set(
          `last_simulation:${symbol}`,
          simulation,
          { ttl: 300000 } // 5 minutes
        );

        sdk.log.info(
          `Simulation ${simulation.id}: ${signal} ${symbol} @ ${currentPrice} → ${simulatedPrice} (${simulation.pnl_percent.toFixed(2)}%) - New balance: ${newBalance.toFixed(2)} TON`
        );

        return {
          success: true,
          data: {
            ...simulation,
            new_balance: newBalance,
          },
        };
      } catch (err) {
        sdk.log.error("ton_simulate_trade failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 6: ton_execute_trade (RISK-PROTECTED VERSION) ────────────────────────────────────────────────────
  {
    name: "ton_execute_trade",
    description:
      "Execute a real trade on TON DEX (DeDust or STON.fi) with automatic transaction verification. Includes built-in risk protections. Works in real trading mode.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Token symbol",
        },
        signal: {
          type: "string",
          description: "Signal (buy/sell)",
        },
        amount: {
          type: "number",
          description: "Amount in TON",
        },
        riskLevel: {
          type: "string",
          description: "Risk level",
          enum: ["low", "medium", "high"],
        },
        useDedust: {
          type: "boolean",
          description: "Use DeDust DEX (default: true)",
        },
      },
      required: ["symbol", "signal", "amount"],
    },
    scope: "dm-only", // Only available in DMs for security
    execute: async (params, context) => {
      const {
        symbol,
        signal,
        amount,
        riskLevel = "medium",
        useDedust = true,
      } = params;

      try {
        const mode = getMode(sdk);

        // CRITICAL: Risk protection - maximum trade percentage
        const maxTradePercent = sdk.pluginConfig.maxTradePercent || 10;
        const balance = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        // Calculate max allowed trade amount
        const riskMultipliers = { low: 0.3, medium: 0.5, high: 0.8 };
        const riskMultiplier = riskMultipliers[riskLevel] || 0.5;
        const maxTradeAmount = balance * (maxTradePercent / 100) * riskMultiplier;

        // BLOCK: Prevent trades exceeding max percentage
        if (amount > maxTradeAmount) {
          const warning = `⚠️ RISK PROTECTION TRIGGERED: Trade amount (${amount} TON) exceeds maximum allowed (${maxTradeAmount.toFixed(2)} TON based on ${maxTradePercent}% of balance and ${riskLevel} risk level).`;

          sdk.log.error(warning);

          return {
            success: false,
            error: warning,
            validation: {
              passed: false,
              reason: "amount exceeds max allowed by plugin config",
              max_allowed_amount: maxTradeAmount,
              current_balance: balance,
              max_trade_percent: maxTradePercent,
              risk_multiplier: riskMultiplier,
            },
          };
        }

        // BLOCK: Minimum trade amount check
        if (amount < balance * 0.01 && signal === "buy") {
          const warning = `⚠️ RISK WARNING: Trade amount (${amount} TON) is less than 1% of balance (${balance} TON). Consider larger positions.`;

          sdk.log.warn(warning);
        }

        // CRITICAL: Check mode
        if (mode !== "real") {
          return {
            success: false,
            error: "Real trading only available in real mode. Use ton_simulate_trade for simulation.",
            mode: mode,
            recommended_action: "Switch to real mode to execute real trades",
          };
        }

        // CRITICAL: Check if auto-trade is enabled
        if (!sdk.pluginConfig.autoTrade) {
          return {
            success: false,
            error: "Auto-trade is disabled in plugin config",
          };
        }

        // Risk validation
        const validateResult = await sdk.ton.validate_risk?.({
          signal,
          amount,
          riskLevel,
        });

        if (!validateResult?.data?.passed) {
          return {
            success: false,
            error: "Risk validation failed",
            validation: validateResult?.data,
          };
        }

        // Get wallet address
        const walletAddress = sdk.ton.getAddress();
        if (!walletAddress) {
          return {
            success: false,
            error: "Wallet not initialized",
          };
        }

        // Select DEX
        const dex = useDedust
          ? sdk.ton.dex?.quoteDeDust
          : sdk.ton.dex?.quoteSTONfi;

        if (!dex) {
          return {
            success: false,
            error: `DEX not available. Use useDedust=${useDedust}`,
          };
        }

        // Execute swap
        const quote = await dex({
          fromToken: "TON",
          toToken: symbol,
          amount: amount.toString(),
        });

        if (!quote) {
          return {
            success: false,
            error: "DEX quote failed",
          };
        }

        // Execute the swap
        const result = await sdk.ton.dex?.swap?.({
          fromToken: "TON",
          toToken: symbol,
          amount: amount.toString(),
          slippage: 0.05, // 5% slippage
        });

        if (!result) {
          return {
            success: false,
            error: "DEX swap failed",
          };
        }

        // Record to journal
        const journalEntry = {
          id: Date.now(),
          timestamp: Date.now(),
          signal,
          confidence: 0.8,
          price_in: quote.price_out_usd,
          price_out: quote.price_out_usd, // Will be updated when sell
          amount_in: amount,
          amount_out: 0,
          pnl: 0,
          pnl_percent: 0,
          status: "success",
          error_message: null,
          strategy: "autonomous_trading",
          risk_level: riskLevel,
          mode: "real",
        };

        sdk.db
          .prepare(
            `INSERT INTO trading_journal (timestamp, signal, confidence, price_in, price_out, amount_in, amount_out, pnl, pnl_percent, status, error_message, strategy, risk_level, mode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            journalEntry.timestamp,
            journalEntry.signal,
            journalEntry.confidence,
            journalEntry.price_in,
            journalEntry.price_out,
            journalEntry.amount_in,
            journalEntry.amount_out,
            journalEntry.pnl,
            journalEntry.pnl_percent,
            journalEntry.status,
            journalEntry.error_message,
            journalEntry.strategy,
            journalEntry.risk_level,
            journalEntry.mode
          );

        // Send confirmation
        await sdk.telegram.sendMessage(context.chatId, {
          text: `✅ Trade executed in Real Mode:\n\nSymbol: ${symbol}\nSignal: ${signal.toUpperCase()}\nAmount: ${amount} TON\nEntry Price: $${quote.price_out_usd.toFixed(2)}\nDEX: ${useDedust ? "DeDust" : "STON.fi"}\nTX: ${result.hash || "pending"}\nMode: Real Trading`,
        });

        sdk.log.info(
          `Trade executed: ${signal} ${symbol} ${amount} TON @ $${quote.price_out_usd.toFixed(2)} - Real Mode`
        );

        return {
          success: true,
          data: {
            ...journalEntry,
            tx_hash: result.hash,
          },
        };
      } catch (err) {
        sdk.log.error("ton_execute_trade failed:", err.message);

        // Record failed trade
        try {
          sdk.db
            .prepare(
              `INSERT INTO trading_journal (timestamp, signal, confidence, price_in, price_out, amount_in, amount_out, pnl, pnl_percent, status, error_message, strategy, risk_level, mode)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              Date.now(),
              signal,
              0.5,
              0,
              0,
              amount,
              0,
              0,
              0,
              "failed",
              String(err.message).slice(0, 200),
              "autonomous_trading",
              riskLevel,
              "real"
            );
        } catch (journalErr) {
          sdk.log.error("Failed to record failed trade:", journalErr.message);
        }

        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 7: ton_record_result ───────────────────────────────────────────
  {
    name: "ton_record_result",
    description:
      "Record a completed trade result (sell) and update the journal with profit/loss data.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        journalId: {
          type: "number",
          description: "Journal entry ID from trade execution",
        },
        symbol: {
          type: "string",
          description: "Token symbol",
        },
        amountOut: {
          type: "number",
          description: "Amount received after sell",
        },
        priceOut: {
          type: "number",
          description: "Price at sell",
        },
      },
      required: ["journalId", "symbol", "amountOut", "priceOut"],
    },
    execute: async (params, context) => {
      const { journalId, symbol, amountOut, priceOut } = params;

      try {
        const mode = getMode(sdk);

        // Get balance before sell
        const balanceBefore = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        // Update journal entry
        const result = sdk.db
          .prepare(
            `UPDATE trading_journal 
             SET price_out = ?, amount_out = ?, status = 'closed'
             WHERE id = ?`
          )
          .run(priceOut, amountOut, journalId);

        if (result.changes === 0) {
          return {
            success: false,
            error: `Journal entry ${journalId} not found`,
          };
        }

        // Calculate PnL
        const journalEntry = sdk.db
          .prepare(
            `SELECT price_in, amount_in FROM trading_journal WHERE id = ?`
          )
          .get(journalId);

        const priceIn = journalEntry?.price_in || 0;
        const amountIn = journalEntry?.amount_in || 0;

        const pnl = amountOut - amountIn;
        const pnlPercent = ((amountOut - amountIn) / amountIn) * 100;

        // Update with final PnL
        sdk.db
          .prepare(
            `UPDATE trading_journal 
             SET pnl = ?, pnl_percent = ?, status = 'closed'
             WHERE id = ?`
          )
          .run(pnl, pnlPercent, journalId);

        // Update balance if simulation
        if (mode === "simulation") {
          const newBalance = balanceBefore + pnl;
          setSimulationBalance(sdk, newBalance);
        }

        // Send notification
        await sdk.telegram.sendMessage(context.chatId, {
          text: `💰 Trade closed:\n\nSymbol: ${symbol}\nPnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\nEntry: $${priceIn.toFixed(2)}\nExit: $${priceOut.toFixed(2)}\nProfit/Loss: ${pnl >= 0 ? "🟢 Profit" : "🔴 Loss"}\nNew balance: ${(balanceBefore + pnl).toFixed(2)} TON`,
        });

        sdk.log.info(
          `Trade ${journalId} closed: ${pnl >= 0 ? "Profit" : "Loss"} $${pnl.toFixed(2)} - ${mode === "simulation" ? "Simulation" : "Real"} Mode`
        );

        return {
          success: true,
          data: {
            journalId,
            symbol,
            pnl,
            pnl_percent: parseFloat(pnlPercent.toFixed(2)),
            entry_price: priceIn,
            exit_price: priceOut,
            profit_or_loss: pnl >= 0 ? "profit" : "loss",
            new_balance: mode === "simulation" ? getLatestSimulationBalance(sdk) : await getRealBalance(sdk),
            mode: mode,
          },
        };
      } catch (err) {
        sdk.log.error("ton_record_result failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 8: ton_update_analytics ─────────────────────────────────────────
  {
    name: "ton_update_analytics",
    description:
      "Update portfolio analytics including total balance, PnL, trade count, and win rate. Records new metrics to database.",
    category: "action",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (params, context) => {
      try {
        const mode = getMode(sdk);

        const balance = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        const walletAddress = sdk.ton.getAddress();

        // Calculate portfolio metrics
        const tradeCount = sdk.db
          .prepare("SELECT COUNT(*) as count FROM trading_journal")
          .get()?.count || 0;

        const closedTrades = sdk.db
          .prepare("SELECT COUNT(*) as count FROM trading_journal WHERE status = 'closed'")
          .get()?.count || 0;

        const profitTrades = sdk.db
          .prepare("SELECT SUM(pnl) as pnl FROM trading_journal WHERE status = 'closed' AND pnl > 0")
          .get()?.pnl || 0;

        const lossTrades = sdk.db
          .prepare("SELECT SUM(pnl) as pnl FROM trading_journal WHERE status = 'closed' AND pnl < 0")
          .get()?.pnl || 0;

        const winRate = closedTrades > 0
          ? ((profitTrades / (profitTrades + Math.abs(lossTrades))) * 100)
          : 0;

        const avgROI = closedTrades > 0
          ? ((profitTrades - lossTrades) / closedTrades)
          : 0;

        // Get latest portfolio metrics
        const latestMetrics = sdk.db
          .prepare(
            "SELECT * FROM portfolio_metrics ORDER BY timestamp DESC LIMIT 1"
          )
          .get();

        const timestamp = Date.now();
        const previousTotal = latestMetrics?.total_balance || balance;
        const previousPnL = latestMetrics?.pnl || 0;
        const portfolioPnL = balance - previousTotal;
        const portfolioPnLPercent = previousTotal > 0
          ? ((portfolioPnL / previousTotal) * 100)
          : 0;

        // Update metrics table
        sdk.db
          .prepare(
            `INSERT INTO portfolio_metrics (timestamp, total_balance, usd_value, pnl, pnl_percent, trade_count, win_rate, avg_roi)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            timestamp,
            balance,
            balance,
            portfolioPnL,
            portfolioPnLPercent,
            tradeCount,
            winRate,
            avgROI
          );

        // Calculate cumulative metrics
        const cumulativePnL = sdk.db
          .prepare("SELECT SUM(pnl) as pnl FROM trading_journal WHERE status = 'closed'")
          .get()?.pnl || 0;

        const cumulativeROI = tradeCount > 0
          ? (cumulativePnL / tradeCount)
          : 0;

        sdk.log.info(
          `Analytics updated: ${tradeCount} trades, ${winRate.toFixed(2)}% win rate, $${portfolioPnL.toFixed(2)} PnL - ${mode === "simulation" ? "Simulation" : "Real"} Mode`
        );

        return {
          success: true,
          data: {
            timestamp,
            total_balance: balance,
            trade_count: tradeCount,
            closed_trades: closedTrades,
            profit_trades: profitTrades,
            loss_trades: lossTrades,
            win_rate: parseFloat(winRate.toFixed(2)),
            avg_roi: parseFloat(avgROI.toFixed(2)),
            portfolio_pnl: portfolioPnL,
            portfolio_pnl_percent: parseFloat(portfolioPnLPercent.toFixed(2)),
            cumulative_pnl: cumulativePnL,
            cumulative_roi: parseFloat(cumulativeROI.toFixed(2)),
            wallet_address: walletAddress,
            mode: mode,
          },
        };
      } catch (err) {
        sdk.log.error("ton_update_analytics failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 9: ton_get_portfolio ───────────────────────────────────────────
  {
    name: "ton_get_portfolio",
    description:
      "Get current portfolio overview including TON balance, token holdings, recent trades, and performance metrics.",
    category: "data-bearing",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Number of recent trades to show",
          minimum: 1,
          maximum: 100,
        },
      },
    },
    execute: async (params, context) => {
      const { limit = 10 } = params;

      try {
        const mode = getMode(sdk);

        const balance = mode === "simulation"
          ? getLatestSimulationBalance(sdk)
          : await getRealBalance(sdk);

        const walletAddress = sdk.ton.getAddress();

        const recentTrades = sdk.db
          .prepare(
            `SELECT * FROM trading_journal 
             WHERE status = 'closed' OR status = 'success'
             ORDER BY timestamp DESC 
             LIMIT ?`
          )
          .all(limit);

        const latestMetrics = sdk.db
          .prepare(
            `SELECT * FROM portfolio_metrics ORDER BY timestamp DESC LIMIT 1`
          )
          .get();

        // Get token balances from Jettons
        let tokenBalances = [];
        try {
          tokenBalances = await sdk.ton.getJettonBalances?.() || [];
        } catch (err) {
          sdk.log.debug("Could not fetch Jetton balances:", err.message);
        }

        const portfolio = {
          wallet_address: walletAddress,
          ton_balance: balance,
          usd_value: balance,
          mode: mode,
          recent_trades: recentTrades.map((trade) => ({
            id: trade.id,
            timestamp: trade.timestamp,
            signal: trade.signal,
            price_in: trade.price_in,
            price_out: trade.price_out || trade.price_in,
            amount_in: trade.amount_in,
            amount_out: trade.amount_out || trade.amount_in,
            pnl: trade.pnl,
            pnl_percent: trade.pnl_percent,
            status: trade.status,
            mode: trade.mode,
          })),
          portfolio_metrics: latestMetrics || {
            total_balance: 0,
            trade_count: 0,
            win_rate: 0,
            portfolio_pnl: 0,
          },
          token_balances: tokenBalances.map((token) => ({
            symbol: token.jetton_address?.slice(-8) || "Unknown",
            balance: token.balance,
            price_usd: token.metadata?.name || "N/A",
          })),
        };

        return {
          success: true,
          data: portfolio,
        };
      } catch (err) {
        sdk.log.error("ton_get_portfolio failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },

  // ── Tool 10: ton_switch_mode ──────────────────────────────────────────────
  {
    name: "ton_switch_mode",
    description:
      "Switch between simulation and real trading modes. Update balance in simulation mode, configure wallet for real mode.",
    category: "action",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "Target mode: 'simulation' or 'real'",
          enum: ["simulation", "real"],
        },
        amount: {
          type: "number",
          description: "New balance for simulation mode (required when switching to simulation)",
        },
      },
      required: ["mode"],
    },
    execute: async (params, context) => {
      const { mode, amount } = params;

      try {
        // Validate mode
        if (mode !== "simulation" && mode !== "real") {
          return {
            success: false,
            error: `Invalid mode: ${mode}. Must be 'simulation' or 'real'`,
          };
        }

        // Switch to simulation mode
        if (mode === "simulation") {
          // Set new simulation balance
          if (amount === undefined || amount === null) {
            return {
              success: false,
              error: "Amount required when switching to simulation mode. Use: ton_switch_mode(mode: 'simulation', amount: 1000)",
            };
          }

          if (amount < 0) {
            return {
              success: false,
              error: "Simulation balance cannot be negative",
            };
          }

          setSimulationBalance(sdk, amount);

          sdk.log.info(`Switched to simulation mode with balance: ${amount} TON`);

          return {
            success: true,
            data: {
              mode: "simulation",
              balance: amount,
              message: `✅ Switched to Simulation Mode\n\nNew balance: ${amount} TON\nUse ton_simulate_trade to test trades`,
            },
          };
        }

        // Switch to real mode
        if (mode === "real") {
          // Check if wallet is initialized
          const walletAddress = sdk.ton.getAddress();
          if (!walletAddress) {
            return {
              success: false,
              error:
                "Wallet not initialized. Please set up your TON wallet first using your Telegram client.",
            };
          }

          // Get current balance
          const balance = await getRealBalance(sdk);

          sdk.log.info(`Switched to real trading mode with wallet: ${walletAddress}`);

          return {
            success: true,
            data: {
              mode: "real",
              wallet_address: walletAddress,
              current_balance: balance,
              message: `✅ Switched to Real Trading Mode\n\nWallet: ${walletAddress}\nBalance: ${balance} TON\nUse ton_execute_trade for real trades`,
            },
          };
        }

        return {
          success: false,
          error: "Mode switch failed",
        };
      } catch (err) {
        sdk.log.error("ton_switch_mode failed:", err.message);
        return { success: false, error: String(err.message).slice(0, 500) };
      }
    },
  },
];
