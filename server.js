"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { Chess } = require("chess.js");

const { UciEngine } = require("./lib/uciEngine");
const store = require("./lib/store");
const { getReview, ReviewError } = require("./lib/reviewService");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;

app.set("view engine", "pug");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// =====================
// SMALL HELPERS
// =====================
const isColor = (c) => c === "white" || c === "black";
const otherColor = (c) => (c === "white" ? "black" : "white");
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** Player-supplied names end up in the stored game record and in PGN headers: keep them tame. */
function cleanName(name, fallback) {
    if (typeof name !== "string") return fallback;
    const cleaned = name
        .replace(/["\\\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 20);
    return cleaned || fallback;
}

/** Anonymous per-browser id (generated client-side). Lets you group one person's games later. */
function cleanPlayerId(id) {
    return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

/** Never trust the client's move object: rebuild it from the three fields chess.js needs. */
function parseMove(m) {
    if (!m || typeof m.from !== "string" || typeof m.to !== "string") return null;
    const move = { from: m.from, to: m.to };
    if (typeof m.promotion === "string" && m.promotion) move.promotion = m.promotion.slice(0, 1).toLowerCase();
    return move;
}

/**
 * chess.js v1 THROWS on an illegal move (v0.x returned null). Every call to .move() that
 * handles outside input goes through here so one bad message can never crash the server.
 */
function tryMove(game, move) {
    try {
        return game.move(move);
    } catch (_) {
        return null;
    }
}

function getGameOverPayload(game) {
    if (game.isCheckmate()) {
        return { winner: game.turn() === "w" ? "black" : "white", reason: "checkmate" };
    }
    if (game.isStalemate()) return { winner: "draw", reason: "stalemate" };
    if (game.isDraw()) return { winner: "draw", reason: "draw" };
    return null;
}

// =====================
// GAME RECORDS (what gets saved when a game ends)
// =====================
function buildRecord({ mode, chess, white, black, winner, reason }) {
    const history = chess.history({ verbose: true });
    const moves = history.map((m) => m.from + m.to + (m.promotion || ""));
    const result = winner === "white" ? "1-0" : winner === "black" ? "0-1" : "1/2-1/2";
    const endedAt = new Date().toISOString();

    // A standard PGN too, so the game can be pasted into Lichess / chess.com / any GUI.
    let pgn = null;
    try {
        const pgnGame = new Chess();
        for (const uci of moves) pgnGame.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        pgnGame.setHeader("Event", "Chess Arena");
        pgnGame.setHeader("Date", endedAt.slice(0, 10).replace(/-/g, "."));
        pgnGame.setHeader("White", white.name);
        pgnGame.setHeader("Black", black.name);
        pgnGame.setHeader("Result", result);
        pgn = pgnGame.pgn();
    } catch (err) {
        console.error("Could not build PGN:", err.message);
    }

    return {
        id: crypto.randomUUID(),
        version: 1,
        mode, // "bot" | "player"
        endedAt,
        startFen: new Chess().fen(),
        white, // { name, playerId, isBot, elo }
        black,
        result,
        reason,
        moves, // UCI, e.g. ["e2e4", "e7e5", ...]
        pgn
    };
}

/** Saves the record; returns its id, or null if saving failed (game still ends normally). */
async function persistGame(args) {
    const record = buildRecord(args);
    try {
        await store.saveGame(record);
        return record.id;
    } catch (err) {
        console.error("Could not save game:", err);
        return null;
    }
}

// =====================
// WEBSOCKET PLUMBING
// =====================
// Protocol: every message is JSON  { "type": "<name>", "data": <anything> }
// (Socket.io did this framing for us: emit("playerMove", move) -> send("playerMove", move))
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

function send(ws, type, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

/** Replaces io.emit(): send to every connection that passes `filter`. */
function broadcast(filter, type, data) {
    const payload = JSON.stringify({ type, data });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && filter(client)) client.send(payload);
    }
}
const inLobby = (client) => client.ctx && client.ctx.mode === "player";

// Browsers can open a WebSocket to ANY host, and same-origin policy doesn't apply to
// WebSockets. So we check the Origin header ourselves ("Cross-Site WebSocket Hijacking").
const extraOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (tests, curl) don't send one
    if (extraOrigins.includes(origin)) return true;
    try {
        return new URL(origin).host === req.headers.host;
    } catch (_) {
        return false;
    }
}

server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/ws") return socket.destroy();

    if (!originAllowed(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Dead connections (laptop lid closed, wifi dropped) never fire "close" on their own.
// Ping everyone; whoever didn't answer the previous ping gets terminated.
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

// =====================
// HUMAN vs HUMAN (single shared lobby, as in the original design)
// =====================
const lobby = {
    game: new Chess(),
    over: false,
    lastResult: null, // { winner, reason, gameId } - so a reloaded page can still show "Review"
    seats: { white: null, black: null }, // the ws holding each colour
    identities: { white: null, black: null } // last known { name, playerId } per colour
};

function releaseSeats(ws) {
    for (const color of ["white", "black"]) if (lobby.seats[color] === ws) lobby.seats[color] = null;
}

async function finishPlayerGame(winner, reason) {
    if (lobby.over) return;
    lobby.over = true; // set BEFORE awaiting so a second trigger can't finish the game twice

    const identity = (color) => ({
        name: (lobby.identities[color] && lobby.identities[color].name) || `${cap(color)} player`,
        playerId: (lobby.identities[color] && lobby.identities[color].playerId) || null,
        isBot: false,
        elo: null
    });

    const gameId = await persistGame({
        mode: "player",
        chess: lobby.game,
        white: identity("white"),
        black: identity("black"),
        winner,
        reason
    });

    lobby.lastResult = { winner, reason, gameId };
    broadcast(inLobby, "playerGameOver", lobby.lastResult);
}

// =====================
// VS STOCKFISH (state lives on each connection's ctx, so many people can play at once)
// =====================
const BOT_DEFAULT_ELO = 1400;

function killEngine(ctx) {
    if (ctx.engine) ctx.engine.kill();
    ctx.engine = null;
}

/**
 * The client's chess.js (0.10) forgets the move list whenever it loads a FEN, so we send the
 * PGN alongside. The client keeps the latest one and hands it back after a reconnect.
 */
function sendBotState(ws, game) {
    send(ws, "botBoardState", { fen: game.fen(), pgn: game.pgn() });
}

async function applyBotElo(ws, ctx) {
    if (!ctx.engine) return;
    ctx.botEloEffective = await ctx.engine.setElo(ctx.botElo);
    send(ws, "botConfig", { requestedElo: ctx.botElo, effectiveElo: ctx.botEloEffective });
}

async function finishBotGame(ws, ctx, winner, reason) {
    if (ctx.over) return;
    ctx.over = true;

    const human = { name: ctx.name, playerId: ctx.playerId, isBot: false, elo: null };
    const bot = { name: `Stockfish ${ctx.botEloEffective}`, playerId: null, isBot: true, elo: ctx.botEloEffective };

    const gameId = await persistGame({
        mode: "bot",
        chess: ctx.game,
        white: ctx.playerColor === "white" ? human : bot,
        black: ctx.playerColor === "white" ? bot : human,
        winner,
        reason
    });

    send(ws, "botGameOver", { winner, reason, gameId });
}

async function makeBotMove(ws, ctx) {
    if (!ctx.game || !ctx.engine || ctx.over || ctx.thinking || ctx.game.isGameOver()) return;

    ctx.thinking = true;
    const { game, engine } = ctx;
    const generation = ctx.generation;

    try {
        const uci = await engine.bestMove(game.fen(), { movetime: 800 });

        // The game may have been restarted / resigned while the engine was thinking.
        if (generation !== ctx.generation || ctx.over || !uci) return;

        const move = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
        if (uci.length > 4) move.promotion = uci[4];
        if (!tryMove(game, move)) return;

        sendBotState(ws, game);

        const over = getGameOverPayload(game);
        if (over) await finishBotGame(ws, ctx, over.winner, over.reason);
    } catch (err) {
        if (generation === ctx.generation) console.error("Engine move error:", err.message);
    } finally {
        // Only touch shared flags if this search still belongs to the current game
        // (a restart / reconnect may have started a newer one while we were awaiting).
        if (generation === ctx.generation) {
            ctx.thinking = false;
            // An Elo change that arrived mid-search is applied now (UCI options must not change during a search).
            if (ctx.eloDirty && ctx.engine) {
                ctx.eloDirty = false;
                applyBotElo(ws, ctx).catch((err) => console.error("Failed to update engine elo:", err.message));
            }
        }
    }
}

// =====================
// MESSAGE HANDLERS
// One function per message type; replaces the socket.on("...") blocks.
// Object.create(null): so a message with type "constructor" or "__proto__" can't hit Object.prototype.
// =====================
const handlers = Object.create(null);

// ---- human vs human ----
handlers.chooseColor = async (ws, ctx, data) => {
    const color = data && data.color;
    if (!isColor(color)) return;

    const holder = lobby.seats[color];
    if (holder && holder !== ws && holder.readyState === WebSocket.OPEN) {
        send(ws, "colorTaken", color);
        return;
    }

    releaseSeats(ws); // free any seat this connection held before
    lobby.seats[color] = ws;

    ctx.mode = "player";
    ctx.color = color;
    ctx.name = cleanName(data.name, `${cap(color)} player`);
    ctx.playerId = cleanPlayerId(data.playerId);
    lobby.identities[color] = { name: ctx.name, playerId: ctx.playerId };

    send(ws, "playerBoardState", lobby.game.fen());
    if (lobby.over && lobby.lastResult) send(ws, "playerGameOver", lobby.lastResult);
};

handlers.playerMove = async (ws, ctx, data) => {
    if (!ctx.color || lobby.over) return;

    const turn = lobby.game.turn() === "w" ? "white" : "black";
    const move = parseMove(data);

    // Wrong turn / malformed / illegal: don't just ignore it. Send the true position back
    // so the sender's board snaps back into sync.
    if (ctx.color !== turn || !move || !tryMove(lobby.game, move)) {
        send(ws, "playerBoardState", lobby.game.fen());
        return;
    }

    broadcast(inLobby, "playerBoardState", lobby.game.fen());

    const over = getGameOverPayload(lobby.game);
    if (over) await finishPlayerGame(over.winner, over.reason);
};

handlers.playerResign = async (ws, ctx) => {
    if (!ctx.color || lobby.over) return;
    await finishPlayerGame(otherColor(ctx.color), "resign");
};

handlers.restartPlayerGame = async (ws, ctx) => {
    if (!ctx.color) return;
    // Only after the game ended (or before any move): otherwise one player could wipe a game in progress.
    if (!lobby.over && lobby.game.history().length > 0) return;

    lobby.game.reset();
    lobby.over = false;
    lobby.lastResult = null;
    broadcast(inLobby, "playerBoardState", lobby.game.fen());
    broadcast(inLobby, "playerGameReset");
};

// ---- vs Stockfish ----
handlers.setBotColor = async (ws, ctx, data) => {
    const color = data && data.color;
    if (!isColor(color)) return;

    ctx.mode = "bot";
    ctx.playerColor = color; // the HUMAN's colour (the bot plays the other one)
    ctx.name = cleanName(data.name, "You");
    ctx.playerId = cleanPlayerId(data.playerId);
    ctx.over = false;
    ctx.thinking = false;
    ctx.eloDirty = false;
    const generation = (ctx.generation = (ctx.generation || 0) + 1);

    const requested = parseInt(data.elo, 10);
    ctx.botElo = Number.isNaN(requested) ? ctx.botElo || BOT_DEFAULT_ELO : requested;

    ctx.game = new Chess();
    // After a dropped connection the client re-sends its moves so the game can continue.
    if (typeof data.pgn === "string" && data.pgn && data.pgn.length < 20000) {
        try {
            ctx.game.loadPgn(data.pgn);
        } catch (_) {
            ctx.game = new Chess();
        }
    }

    killEngine(ctx);
    try {
        const engine = await UciEngine.start();
        if (generation !== ctx.generation) return engine.kill(); // a newer setBotColor superseded us
        ctx.engine = engine;
        await applyBotElo(ws, ctx);
    } catch (err) {
        console.error("Engine failed to start:", err.message);
        send(ws, "botError", "The chess engine failed to start.");
        return;
    }

    sendBotState(ws, ctx.game);

    const over = getGameOverPayload(ctx.game);
    if (over) return finishBotGame(ws, ctx, over.winner, over.reason);

    // The bot moves first when the human plays black (or when resuming on the bot's turn).
    const botsTurn = (ctx.game.turn() === "w" ? "white" : "black") !== ctx.playerColor;
    if (botsTurn) await makeBotMove(ws, ctx);
};

handlers.setBotElo = async (ws, ctx, data) => {
    const requested = parseInt(data, 10);
    if (Number.isNaN(requested)) return;

    ctx.botElo = requested;
    if (ctx.thinking) ctx.eloDirty = true;
    else await applyBotElo(ws, ctx);
};

handlers.botMove = async (ws, ctx, data) => {
    if (!ctx.game || ctx.over) return;

    const turn = ctx.game.turn() === "w" ? "white" : "black";
    const move = parseMove(data);

    // Not the human's turn, engine not ready yet, or an illegal move: resync the client.
    if (!ctx.engine || turn !== ctx.playerColor || !move || !tryMove(ctx.game, move)) {
        sendBotState(ws, ctx.game);
        return;
    }

    sendBotState(ws, ctx.game);

    const over = getGameOverPayload(ctx.game);
    if (over) return finishBotGame(ws, ctx, over.winner, over.reason);

    await makeBotMove(ws, ctx);
};

handlers.botResign = async (ws, ctx) => {
    if (!ctx.game || ctx.over || !ctx.playerColor) return;
    await finishBotGame(ws, ctx, otherColor(ctx.playerColor), "resign");
};

handlers.restartBotGame = async (ws, ctx) => {
    if (!ctx.game || !ctx.engine) return;
    if (!ctx.over && ctx.game.history().length > 0) return; // only after game over

    ctx.generation++; // invalidates any engine search still in flight
    ctx.thinking = false;
    ctx.over = false;
    ctx.game.reset();
    await ctx.engine.newGame();

    sendBotState(ws, ctx.game);
    send(ws, "botGameReset");

    if (ctx.playerColor === "black") await makeBotMove(ws, ctx);
};

// ---- game review ----
handlers.reviewGame = async (ws, ctx, data) => {
    if (ctx.reviewing) {
        send(ws, "reviewError", { code: "busy", message: "A review is already running." });
        return;
    }

    ctx.reviewing = true;
    try {
        const review = await getReview(data && data.gameId, (progress) => send(ws, "reviewProgress", progress));
        send(ws, "reviewResult", review);
    } catch (err) {
        if (err instanceof ReviewError) {
            send(ws, "reviewError", { code: err.code, message: err.message });
        } else {
            console.error("Review failed:", err);
            send(ws, "reviewError", { code: "failed", message: "The analysis failed. Please try again." });
        }
    } finally {
        ctx.reviewing = false;
    }
};

// =====================
// CONNECTION LIFECYCLE
// =====================
wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    // Per-connection state (what Socket.io code used to hang on `socket.xxx`)
    const ctx = (ws.ctx = { mode: null });

    ws.on("message", async (raw, isBinary) => {
        if (isBinary) return;

        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (_) {
            return; // not JSON: ignore
        }
        if (!msg || typeof msg.type !== "string" || !(msg.type in handlers)) return;

        try {
            await handlers[msg.type](ws, ctx, msg.data);
        } catch (err) {
            console.error(`Error in "${msg.type}" handler:`, err);
        }
    });

    ws.on("error", (err) => console.error("WebSocket error:", err.message));

    ws.on("close", () => {
        releaseSeats(ws);
        ctx.generation = (ctx.generation || 0) + 1; // any search in flight is now moot; its cancellation isn't an error
        killEngine(ctx);
    });
});

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.render("index"));

// The colour goes straight into a <script> block in the page, so anything but the two
// real values is rejected here instead of being echoed back (that would be reflected XSS).
app.get("/gameBot/:color", (req, res) => {
    if (!isColor(req.params.color)) return res.status(404).send("Not found");
    res.render("gameBot", { color: req.params.color });
});

app.get("/gamePlayer/:color", (req, res) => {
    if (!isColor(req.params.color)) return res.status(404).send("Not found");
    res.render("gamePlayer", { color: req.params.color });
});

app.get("/review/:id", (req, res) => {
    if (!store.isValidId(req.params.id)) return res.status(404).send("Not found");
    res.render("review", { gameId: req.params.id });
});

// The finished review as JSON (handy for your future player-profile / training tooling).
app.get("/api/reviews/:id", async (req, res) => {
    const review = await store.loadReview(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });
    res.json(review);
});

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
});
