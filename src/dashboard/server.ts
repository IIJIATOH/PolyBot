import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import type { PaperTradingEngine } from "../paper-trading/engine";

export class DashboardServer {
    private wss: WebSocketServer;
    private httpServer: ReturnType<typeof createServer>;
    private clients: Set<WebSocket> = new Set();
    private engine: PaperTradingEngine;
    private port: number;

    constructor(engine: PaperTradingEngine, port = 4242) {
        this.engine = engine;
        this.port = port;

        this.httpServer = createServer((req, res) => {
            if (req.url === "/" || req.url === "/index.html") {
                try {
                    const html = readFileSync(join(process.cwd(), "dashboard", "index.html"), "utf-8");
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(html);
                } catch {
                    res.writeHead(404);
                    res.end("Dashboard not found. Make sure dashboard/index.html exists.");
                }
            } else if (req.url === "/api/stats") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(this.engine.getStats()));
            } else {
                res.writeHead(404);
                res.end("Not found");
            }
        });

        this.wss = new WebSocketServer({ server: this.httpServer });

        this.wss.on("connection", (ws) => {
            this.clients.add(ws);

            // Send current state on connect
            ws.send(JSON.stringify({
                type: "init",
                stats: this.engine.getStats(),
                trades: this.engine.getAllTrades(),
                deltaHistory: this.engine.getDeltaHistory(),
            }));

            ws.on("close", () => this.clients.delete(ws));
        });

        // Forward engine events to all dashboard clients
        engine.on("tick", (data) => this.broadcast({ type: "tick", ...data }));
        engine.on("trade", (data) => this.broadcast({ type: "trade", ...data }));
        engine.on("round_start", (data) => this.broadcast({ type: "round_start", ...data }));
        engine.on("round_end", (data) => {
            this.broadcast({
                type: "round_end",
                ...data,
                stats: this.engine.getStats(),
            });
        });
    }

    private broadcast(data: object) {
        const msg = JSON.stringify(data);
        for (const ws of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    start() {
        this.httpServer.listen(this.port, () => {
            console.log(`📊 Dashboard running at http://localhost:${this.port}`);
        });
    }
}