/**
 * Paper Trading Mode — запускает бота без реальных ордеров.
 * Симулирует несколько стратегий одновременно и отдаёт данные в дашборд.
 *
 * Запуск: npx tsx src/paper.ts
 * Дашборд: http://localhost:4242
 */

import { ClobClient } from "@polymarket/clob-client";
import { WebSocket } from "ws";
import { generateMarketSlug } from "./config";
import type { Coin, MarketConfig, Minutes } from "./types";
import {
    CHAIN_ID, FUNDER, getMarket, HOST, SIGNATURE_TYPE, SIGNER,
    createUserWebSocket, orderBook, createRTDSClient, setMarket,
} from "./services";
import { getCurrentTime } from "./utils";
import { loadConfig } from "./config/toml";
import { current_price, price_to_beat_global, set_purchased_token } from "./services/ws_rtds";
import { Volatility } from "./analysis";
import { tui } from "./tui";
import { PaperTradingEngine } from "./paper-trading/engine";
import { DashboardServer } from "./dashboard/server";

loadConfig();

export let startTimestampGlobal: number;
export let endTimestampGlobal: number;
export let marketPeriod: number;
export const volatility = new Volatility();

// ─── Стратегии для сравнения ──────────────────────────────────────────────────
const engine = new PaperTradingEngine();

// Стратегия 1: Консервативная — входим только близко к концу с большой дельтой
engine.addStrategy({
    id: "conservative",
    label: "Conservative",
    color: "#4ade80",
    entries: [
        { min: 70, max: 500, entry_remaining_sec_down: 1, entry_remaining_sec_up: 3, amount: 5 },
        { min: 100, max: 500, entry_remaining_sec_down: 3, entry_remaining_sec_up: 7, amount: 5 },
    ],
});

// Стратегия 2: Конфиг из trade.toml (оригинальная)
engine.addStrategy({
    id: "original",
    label: "Original (trade.toml)",
    color: "#60a5fa",
    entries: globalThis.__CONFIG__?.trade_1?.entry ?? [
        { min: 10, max: 500, entry_remaining_sec_down: 1, entry_remaining_sec_up: 2, amount: 5 },
        { min: 20, max: 500, entry_remaining_sec_down: 2, entry_remaining_sec_up: 3, amount: 5 },
        { min: 40, max: 500, entry_remaining_sec_down: 3, entry_remaining_sec_up: 5, amount: 5 },
        { min: 70, max: 500, entry_remaining_sec_down: 5, entry_remaining_sec_up: 7, amount: 5 },
        { min: 85, max: 500, entry_remaining_sec_down: 7, entry_remaining_sec_up: 12, amount: 5 },
        { min: 100, max: 500, entry_remaining_sec_down: 12, entry_remaining_sec_up: 20, amount: 5 },
        { min: 210, max: 500, entry_remaining_sec_down: 20, entry_remaining_sec_up: 45, amount: 5 },
    ],
});

// Стратегия 3: Агрессивная — входим рано с маленькой дельтой
engine.addStrategy({
    id: "aggressive",
    label: "Aggressive",
    color: "#f87171",
    entries: [
        { min: 5, max: 500, entry_remaining_sec_down: 10, entry_remaining_sec_up: 30, amount: 5 },
        { min: 15, max: 500, entry_remaining_sec_down: 30, entry_remaining_sec_up: 60, amount: 5 },
        { min: 30, max: 500, entry_remaining_sec_down: 60, entry_remaining_sec_up: 120, amount: 5 },
    ],
});
engine.addStrategy({
    id: "my_strategy",
    label: "My Strategy",
    color: "#a78bfa",
    entries: [
        { min: 50, max: 300, entry_remaining_sec_down: 5, entry_remaining_sec_up: 10, amount: 10 },
    ],
});

// ─── Запуск дашборда ──────────────────────────────────────────────────────────
const dashboard = new DashboardServer(engine, 4242);
dashboard.start();

// ─── Основной цикл ────────────────────────────────────────────────────────────
const marketConfig: MarketConfig = {
    coin: globalThis.__CONFIG__?.market?.market_coin as Coin ?? "btc",
    minutes: parseInt(globalThis.__CONFIG__?.market?.market_period ?? "5") as Minutes,
};

async function main() {
    const clobClient = new ClobClient(HOST, CHAIN_ID, SIGNER);
    const apiKey = await clobClient.createOrDeriveApiKey();

    console.log(tui.section("Paper Trading Mode 📄", [
        "🔕 No real orders will be placed",
        `📊 Dashboard: http://localhost:4242`,
        `🎯 Strategies: conservative, original, aggressive`,
    ]));

    while (true) {
        const { slug, startTimestamp, endTimestamp } = generateMarketSlug(
            marketConfig.coin,
            marketConfig.minutes
        );

        startTimestampGlobal = startTimestamp;
        endTimestampGlobal = endTimestamp;
        marketPeriod = endTimestamp - startTimestamp;

        console.log(tui.section("Market", [
            `🔍 Slug: ${tui.highlight(slug)}`,
            tui.dim(`Ends: ${getCurrentTime()} / ${endTimestamp}`),
        ]));

        const market = await getMarket(slug);
        setMarket(market);

        const upTokenId = JSON.parse(market.clobTokenIds)[0];
        const downTokenId = JSON.parse(market.clobTokenIds)[1];

        const client = new ClobClient(HOST, CHAIN_ID, SIGNER, apiKey, SIGNATURE_TYPE, FUNDER);

        set_purchased_token(false);
        engine.startRound(startTimestamp, endTimestamp);

        const USER_WS = createUserWebSocket();
        let RTDS_WS: ReturnType<typeof createRTDSClient>;

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 10000);
            let userOk = false, rtdsOk = false;
            const check = () => { if (userOk && rtdsOk) { clearTimeout(timeout); resolve(); } };
            USER_WS.onopen = () => { userOk = true; check(); };
            USER_WS.onerror = (e) => { clearTimeout(timeout); reject(e); };
            RTDS_WS = createRTDSClient(() => { rtdsOk = true; check(); }, (e) => { clearTimeout(timeout); reject(e); });
        });

        USER_WS.send(JSON.stringify({ type: "market", assets_ids: [upTokenId, downTokenId] }));

        RTDS_WS.subscribe({
            subscriptions: [
                { topic: "crypto_prices", type: "update", filters: "{\"symbol\":\"BTCUSDT\"}" },
                { topic: "crypto_prices_chainlink", type: "update", filters: "{\"symbol\":\"btc/usd\"}" },
            ],
        });

        // Inner tick loop — feeds data into paper trading engine
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            USER_WS.send("PING");

            const remainingSec = endTimestampGlobal - getCurrentTime();

            if (price_to_beat_global !== 0) {
                const upAsk = orderBook[upTokenId]?.asks.slice(-1)[0]?.price;
                const upBid = orderBook[upTokenId]?.bids.slice(-1)[0]?.price;
                const downAsk = orderBook[downTokenId]?.asks.slice(-1)[0]?.price;
                const downBid = orderBook[downTokenId]?.bids.slice(-1)[0]?.price;

                const delta = current_price - price_to_beat_global;

                // Feed tick into paper trading engine
                engine.tick({
                    timestamp: Date.now(),
                    remainingSec,
                    delta,
                    currentPrice: current_price,
                    priceToBeat: price_to_beat_global,
                    upAsk: parseFloat(upAsk),
                    upBid: parseFloat(upBid),
                    downAsk: parseFloat(downAsk),
                    downBid: parseFloat(downBid),
                });
            }

            if (price_to_beat_global !== 0 && remainingSec <= 0) {
                const winner = current_price > price_to_beat_global ? "UP WIN" : "DOWN WIN";
                console.log(tui.outcomeBanner(winner as any));

                // Settle round in paper engine
                const results = engine.endRound(current_price, price_to_beat_global);
                results.forEach(r => {
                    if (r.outcome !== "NO_TRADE") {
                        const icon = r.outcome === "WIN" ? "✅" : "❌";
                        const pnlStr = (r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(2);
                        console.log(`${icon} [${r.strategyId}] ${r.outcome} | P&L: $${pnlStr}`);
                    }
                });

                volatility.clearHistory();
                break;
            }
        }

        if (USER_WS.readyState === WebSocket.OPEN || USER_WS.readyState === WebSocket.CONNECTING) {
            USER_WS.close();
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

main().catch(console.error);