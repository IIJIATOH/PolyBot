import { EventEmitter } from "events";

export type TradeDirection = "UP" | "DOWN";
export type TradeOutcome = "WIN" | "LOSS" | "PENDING";

export interface SimulatedTrade {
    id: string;
    strategyId: string;
    direction: TradeDirection;
    entryDelta: number;
    entryPrice: number;
    tokenPrice: number;
    amount: number;
    remainingSecAtEntry: number;
    timestamp: number;
    outcome: TradeOutcome;
    pnl: number | null; // null = pending
    priceToBeat: number;
}

export interface StrategyConfig {
    id: string;
    label: string;
    entries: Array<{
        min: number;
        max: number;
        entry_remaining_sec_down: number;
        entry_remaining_sec_up: number;
        amount: number;
    }>;
    color: string; // hex for dashboard
}

export interface RoundResult {
    strategyId: string;
    trade: SimulatedTrade | null;
    outcome: TradeOutcome | "NO_TRADE";
    pnl: number;
}

export interface DeltaSnapshot {
    timestamp: number;
    remainingSec: number;
    delta: number;
    currentPrice: number;
    priceToBeat: number;
    upAsk?: number;
    upBid?: number;
    downAsk?: number;
    downBid?: number;
}

export interface StrategyStats {
    strategyId: string;
    label: string;
    color: string;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    trades: SimulatedTrade[];
}

export class PaperTradingEngine extends EventEmitter {
    private strategies: Map<string, StrategyConfig> = new Map();
    private activeTrades: Map<string, SimulatedTrade | null> = new Map(); // strategyId -> trade this round
    private allTrades: SimulatedTrade[] = [];
    private deltaHistory: DeltaSnapshot[] = [];
    private roundStarted = false;
    private currentRoundStart = 0;
    private currentRoundEnd = 0;

    addStrategy(config: StrategyConfig) {
        this.strategies.set(config.id, config);
        this.activeTrades.set(config.id, null);
    }

    startRound(startTimestamp: number, endTimestamp: number) {
        this.roundStarted = true;
        this.currentRoundStart = startTimestamp;
        this.currentRoundEnd = endTimestamp;
        this.deltaHistory = [];

        // Reset active trades for this round
        for (const id of this.strategies.keys()) {
            this.activeTrades.set(id, null);
        }

        this.emit("round_start", { startTimestamp, endTimestamp });
    }

    tick(snapshot: DeltaSnapshot) {
        this.deltaHistory.push(snapshot);

        // Evaluate each strategy
        for (const [strategyId, strategy] of this.strategies) {
            const alreadyTraded = this.activeTrades.get(strategyId) !== null;
            if (alreadyTraded) continue;

            const { delta, remainingSec, upBid, downBid, tokenPrice, amount, direction } = this.evaluateStrategy(
                strategy,
                snapshot
            );

            if (direction !== null) {
                const trade: SimulatedTrade = {
                    id: `${strategyId}-${Date.now()}`,
                    strategyId,
                    direction: direction!,
                    entryDelta: snapshot.delta,
                    entryPrice: snapshot.currentPrice,
                    tokenPrice: tokenPrice ?? 0,
                    amount: amount,
                    remainingSecAtEntry: snapshot.remainingSec,
                    timestamp: snapshot.timestamp,
                    outcome: "PENDING",
                    pnl: null,
                    priceToBeat: snapshot.priceToBeat,
                };

                this.activeTrades.set(strategyId, trade);
                this.allTrades.push(trade);

                this.emit("trade", { strategyId, trade });
                console.log(`📄 [PAPER] Strategy "${strategy.label}" → ${direction} | delta=${snapshot.delta.toFixed(2)} | ${remainingSec.toFixed(1)}s left | $${amount}`);
            }
        }

        this.emit("tick", { snapshot, activeTrades: Object.fromEntries(this.activeTrades) });
    }

    private evaluateStrategy(
        strategy: StrategyConfig,
        snapshot: DeltaSnapshot
    ): { delta: number; remainingSec: number; upBid?: number; downBid?: number; tokenPrice?: number; amount: number; direction: TradeDirection | null } {
        const { delta, remainingSec, upBid, downBid } = snapshot;

        for (const rule of strategy.entries) {
            if (
                rule.entry_remaining_sec_down <= remainingSec &&
                rule.entry_remaining_sec_up > remainingSec &&
                Math.abs(delta) >= rule.min &&
                Math.abs(delta) < rule.max
            ) {
                const direction: TradeDirection = delta >= 0 ? "UP" : "DOWN";
                const tokenPrice = direction === "UP" ? upBid : downBid;
                return { delta, remainingSec, upBid, downBid, tokenPrice, amount: rule.amount, direction };
            }
        }

        return { delta, remainingSec, upBid, downBid, amount: 0, direction: null };
    }

    endRound(finalPrice: number, priceToBeat: number) {
        const actualWinner: TradeDirection = finalPrice > priceToBeat ? "UP" : "DOWN";
        const roundResults: RoundResult[] = [];

        for (const [strategyId, trade] of this.activeTrades) {
            const strategy = this.strategies.get(strategyId)!;

            if (trade === null) {
                roundResults.push({ strategyId, trade: null, outcome: "NO_TRADE", pnl: 0 });
                continue;
            }

            const won = trade.direction === actualWinner;
            const outcome: TradeOutcome = won ? "WIN" : "LOSS";

            // Polymarket binary outcome: win ~= 2x (roughly, simplified)
            // If token bought at price P (0-1), win pays 1.0, so profit = (1 - P) * amount - fee
            // Loss pays 0, so loss = P * amount
            const tokenP = trade.tokenPrice > 0 ? trade.tokenPrice : 0.5;
            const pnl = won
                ? (1 - tokenP) * trade.amount * 0.98 // 2% fee approx
                : -tokenP * trade.amount;

            trade.outcome = outcome;
            trade.pnl = pnl;

            roundResults.push({ strategyId, trade, outcome, pnl });
        }

        this.emit("round_end", {
            finalPrice,
            priceToBeat,
            actualWinner,
            results: roundResults,
            deltaHistory: this.deltaHistory,
        });

        this.roundStarted = false;
        return roundResults;
    }

    getStats(): StrategyStats[] {
        const stats: StrategyStats[] = [];

        for (const [strategyId, strategy] of this.strategies) {
            const trades = this.allTrades.filter(t => t.strategyId === strategyId && t.outcome !== "PENDING");
            const wins = trades.filter(t => t.outcome === "WIN").length;
            const losses = trades.filter(t => t.outcome === "LOSS").length;
            const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

            stats.push({
                strategyId,
                label: strategy.label,
                color: strategy.color,
                totalTrades: trades.length,
                wins,
                losses,
                winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
                totalPnl,
                avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
                trades: this.allTrades.filter(t => t.strategyId === strategyId),
            });
        }

        return stats;
    }

    getDeltaHistory() {
        return this.deltaHistory;
    }

    getAllTrades() {
        return this.allTrades;
    }
}