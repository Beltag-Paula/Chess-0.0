"use strict";
// Talks to a real server over real WebSockets, with the real Stockfish binary.
// Run:  npm test      (skipped automatically if engine/stockfish-bin is missing)

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Chess } = require("chess.js");
const WebSocket = require("ws"); // works on any Node version (the global WebSocket only exists on Node 22+)

const ROOT = path.join(__dirname, "..");
const hasEngine = fs.existsSync(path.join(ROOT, "engine", "stockfish-bin"));
const PORT = 3900 + Math.floor(Math.random() * 90);
let server;
let dataDir;

before(async () => {
    if (!hasEngine) return;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chess-test-"));
    server = spawn("node", ["server.js"], { cwd: ROOT, env: { ...process.env, PORT, DATA_DIR: dataDir } });
    await new Promise((resolve, reject) => {
        server.stdout.on("data", (d) => String(d).includes("localhost") && resolve());
        server.on("exit", reject);
    });
});
after(() => server && server.kill());

/** Minimal client: send(type,data), next(type) resolves with the next message of that type. */
function connect(headers) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${PORT}/ws`, headers ? { headers } : undefined);
        const queue = [];
        const waiters = [];
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            const i = waiters.findIndex((w) => w.type === msg.type);
            if (i >= 0) waiters.splice(i, 1)[0].resolve(msg.data);
            else queue.push(msg);
        };
        ws.onopen = () =>
            resolve({
                ws,
                send: (type, data) => ws.send(JSON.stringify({ type, data })),
                next: (type, ms = 60000) => {
                    const i = queue.findIndex((m) => m.type === type);
                    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0].data);
                    return new Promise((res, rej) => {
                        const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
                        waiters.push({ type, resolve: (d) => (clearTimeout(t), res(d)) });
                    });
                },
                close: () => ws.close()
            });
        ws.onerror = reject;
    });
}

test("bot game -> resign -> review with progress", { skip: !hasEngine, timeout: 120000 }, async () => {
    const c = await connect();
    c.send("setBotColor", { color: "white", name: "Nicole", playerId: "11111111-aaaa", elo: 1400 });
    const cfg = await c.next("botConfig");
    assert.strictEqual(cfg.effectiveElo, 1400);
    await c.next("botBoardState");

    // Play 6 legal moves (first legal move each time); the bot answers each one.
    const game = new Chess();
    for (let i = 0; i < 6; i++) {
        const move = game.moves({ verbose: true })[0];
        game.move(move);
        c.send("botMove", { from: move.from, to: move.to, promotion: move.promotion });
        await c.next("botBoardState"); // echo of our move
        game.load((await c.next("botBoardState")).fen); // bot reply
    }

    // 800 Elo is below Stockfish's minimum: must be clamped, not silently wrong
    c.send("setBotElo", 800);
    assert.strictEqual((await c.next("botConfig")).effectiveElo, 1320);

    c.send("botResign");
    const over = await c.next("botGameOver");
    assert.strictEqual(over.winner, "black");
    assert.match(over.gameId, /^[0-9a-f-]{36}$/);

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "games", `${over.gameId}.json`)));
    assert.strictEqual(saved.white.name, "Nicole");
    assert.strictEqual(saved.white.playerId, "11111111-aaaa");
    assert.strictEqual(saved.black.isBot, true);
    assert.strictEqual(saved.moves.length, 12);

    // Review, from a NEW connection (as the review page does)
    const r = await connect();
    r.send("reviewGame", { gameId: over.gameId });
    const progress = await r.next("reviewProgress");
    assert.ok(["queued", "analyzing"].includes(progress.stage));
    const review = await r.next("reviewResult");

    assert.strictEqual(review.positions.length, 13);
    assert.strictEqual(review.moves.length, 12);
    for (const side of ["white", "black"]) {
        const s = review.summary[side];
        assert.ok(s.accuracy >= 0 && s.accuracy <= 100);
        assert.strictEqual(Object.values(s.counts).reduce((a, b) => a + b, 0), 6);
        assert.deepStrictEqual(Object.keys(s.phases), ["opening", "tactics", "strategy", "endgame"]);
    }
    assert.ok(fs.existsSync(path.join(dataDir, "reviews", `${over.gameId}.json`)), "review persisted");

    // Second request is served from the cache
    const r2 = await connect();
    r2.send("reviewGame", { gameId: over.gameId });
    assert.strictEqual((await r2.next("reviewResult")).gameId, over.gameId);
    [c, r, r2].forEach((x) => x.close());
});

test("two human players, illegal moves, resync", { skip: !hasEngine }, async () => {
    const w = await connect();
    const b = await connect();
    w.send("chooseColor", { color: "white", name: "Ann" });
    b.send("chooseColor", { color: "black", name: "Bob" });
    await w.next("playerBoardState");
    await b.next("playerBoardState");

    const third = await connect();
    third.send("chooseColor", { color: "white" });
    assert.strictEqual(await third.next("colorTaken"), "white");

    // Black moving on white's turn -> rejected with a resync, server keeps running
    b.send("playerMove", { from: "e7", to: "e5" });
    assert.ok((await b.next("playerBoardState")).startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP"));

    w.send("playerMove", { from: "e2", to: "e5" }); // illegal: would have CRASHED the old server (chess.js v1 throws)
    await w.next("playerBoardState");

    w.send("playerMove", { from: "e2", to: "e4" });
    assert.ok((await b.next("playerBoardState")).includes("4P3"));

    w.send("playerResign");
    const over = await b.next("playerGameOver");
    assert.strictEqual(over.winner, "black");
    [w, b, third].forEach((x) => x.close());
});

test("hostile input is ignored", { skip: !hasEngine }, async () => {
    const c = await connect();
    c.ws.send("not json");
    c.ws.send(JSON.stringify({ type: "constructor", data: 1 }));
    c.ws.send(JSON.stringify({ type: "__proto__" }));
    c.send("reviewGame", { gameId: "../../etc/passwd" });
    assert.strictEqual((await c.next("reviewError")).code, "bad_id");
    c.send("reviewGame", { gameId: "00000000-0000-4000-8000-000000000000" });
    assert.strictEqual((await c.next("reviewError")).code, "not_found");
    c.close();
});

test("cross-site WebSocket is refused", { skip: !hasEngine }, async () => {
    await assert.rejects(connect({ Origin: "http://evil.example" }));
});
