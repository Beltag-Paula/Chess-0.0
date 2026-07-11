const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const { spawn } = require("child_process");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.set("view engine", "pug");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// =====================
// STATE
// =====================
// Shared human-vs-human game (single lobby, as in the original design)
const playerGame = new Chess();

// Tracks which socket.id currently holds each color in the human game
let players = {
    white: null,
    black: null
};

// NOTE: bot games are now stored per-socket (socket.botGame / socket.engine),
// not globally, so multiple people can play the bot at once without
// stomping on each other's boards.

// =====================
// STOCKFISH ENGINE HELPERS
// =====================
function sendCommand(engine, cmd) {
    if (!engine || engine.killed) return;
    engine.stdin.write(cmd + "\n");
}

// Buffers stdout and resolves as soon as a line matching `predicate` arrives.
function waitForResponse(engine, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let buffer = "";

        const timer = setTimeout(() => {
            engine.stdout.off("data", onData);
            reject(new Error("Engine response timeout"));
        }, timeoutMs);

        function onData(data) {
            buffer += data.toString();
            const lines = buffer.split("\n");
            for (const line of lines) {
                if (predicate(line)) {
                    clearTimeout(timer);
                    engine.stdout.off("data", onData);
                    resolve(line.trim());
                    return;
                }
            }
        }

        engine.stdout.on("data", onData);
    });
}

async function setEngineElo(engine, elo) {
    sendCommand(engine, "setoption name UCI_LimitStrength value true");
    sendCommand(engine, `setoption name UCI_Elo value ${elo}`);
    sendCommand(engine, "isready");
    await waitForResponse(engine, (line) => line.trim() === "readyok");
}

async function createEngine(elo = 1200) {
    const enginePath = path.join(__dirname, "engine", "stockfish-bin");
    const engine = spawn(enginePath);

    engine.stdin.setEncoding("utf-8");
    engine.stdout.setEncoding("utf-8");
    engine.on("error", (err) => {
        console.error("Failed to start engine:", err);
    });

    sendCommand(engine, "uci");
    await waitForResponse(engine, (line) => line.trim() === "uciok");

    await setEngineElo(engine, elo);

    return engine;
}

async function getBestMove(engine, fen) {
    sendCommand(engine, `position fen ${fen}`);
    sendCommand(engine, "go movetime 800");

    const line = await waitForResponse(
        engine,
        (l) => l.startsWith("bestmove"),
        10000
    );

    const move = line.split(" ")[1];
    if (!move || move === "(none)") return null;
    return move;
}

function killEngine(socket) {
    if (socket.engine && !socket.engine.killed) {
        socket.engine.stdin.write("quit\n");
        socket.engine.kill();
    }
    socket.engine = null;
}

// =====================
// GAME-OVER HELPERS
// =====================
function getGameOverPayload(game) {
    if (game.isCheckmate()) {
        return {
            winner: game.turn() === "w" ? "black" : "white",
            reason: "checkmate"
        };
    }
    if (game.isStalemate()) {
        return { winner: "draw", reason: "stalemate" };
    }
    if (game.isDraw()) {
        return { winner: "draw", reason: "draw" };
    }
    return null;
}

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.render("index"));
app.get("/gameBot/:color", (req, res) => res.render("gameBot", { color: req.params.color }));
app.get("/gamePlayer/:color", (req, res) => res.render("gamePlayer", { color: req.params.color }));

// =====================
// SOCKET.IO
// =====================
io.on("connection", (socket) => {

    // =====================
    // PLAYER MOVE (human vs human)
    // =====================
    socket.on("playerMove", (move) => {
        const currentTurn = playerGame.turn() === "w" ? "white" : "black";
        if (socket.color !== currentTurn) return;

        const result = playerGame.move(move);
        if (!result) return;

        io.emit("playerBoardState", playerGame.fen());

        const over = getGameOverPayload(playerGame);
        if (over) io.emit("playerGameOver", over);
    });

    // =====================
    // CHOOSE COLOR (human vs human)
    // =====================
    socket.on("chooseColor", (color) => {
        if (color !== "white" && color !== "black") return;

        // Seat already taken by someone else
        if (players[color] && players[color] !== socket.id) {
            socket.emit("colorTaken", color);
            return;
        }

        // Release any seat this socket previously held
        if (players.white === socket.id) players.white = null;
        if (players.black === socket.id) players.black = null;

        players[color] = socket.id;
        socket.color = color;

        socket.emit("playerBoardState", playerGame.fen());
    });

    // =====================
    // RESIGN (PLAYER)
    // =====================
    socket.on("playerResign", () => {
        if (!socket.color) return;
        const winner = socket.color === "white" ? "black" : "white";

        io.emit("playerGameOver", { winner, reason: "resign" });
    });

    // =====================
    // NEW GAME (PLAYER)
    // =====================
    socket.on("restartPlayerGame", () => {
        playerGame.reset();
        io.emit("playerBoardState", playerGame.fen());
        io.emit("playerGameReset");
    });

    // =====================
    // BOT COLOR (sets up a fresh per-socket game + engine)
    // =====================
    socket.on("setBotColor", async (color) => {
        if (color !== "white" && color !== "black") return;

        socket.botColor = color;
        socket.botElo = socket.botElo || 1200;
        socket.botGame = new Chess();

        killEngine(socket);

        try {
            socket.engine = await createEngine(socket.botElo);
        } catch (err) {
            console.error("Engine failed to start:", err);
            socket.emit("botError", "The chess engine failed to start.");
            return;
        }

        socket.emit("botBoardState", socket.botGame.fen());

        // If the player chose black, the bot (white) must open.
        if (color === "black") {
            await makeBotMove(socket);
        }
    });

    socket.on("setBotElo", async (elo) => {
        const parsed = parseInt(elo, 10);
        if (Number.isNaN(parsed)) return;

        socket.botElo = parsed;
        if (socket.engine) {
            try {
                await setEngineElo(socket.engine, parsed);
            } catch (err) {
                console.error("Failed to update engine elo:", err);
            }
        }
    });

    // =====================
    // BOT MOVE
    // =====================
    socket.on("botMove", async (move) => {
        if (!socket.botGame || !socket.engine) return;

        const result = socket.botGame.move(move);
        if (!result) return;

        socket.emit("botBoardState", socket.botGame.fen());

        const over = getGameOverPayload(socket.botGame);
        if (over) {
            socket.emit("botGameOver", over);
            return;
        }

        await makeBotMove(socket);
    });

    async function makeBotMove(sock) {
        if (!sock.botGame || !sock.engine) return;
        if (sock.botGame.isGameOver()) return;

        // Guard against overlapping engine calls (e.g. rapid restarts)
        if (sock.engineBusy) return;
        sock.engineBusy = true;

        try {
            const bestMove = await getBestMove(sock.engine, sock.botGame.fen());
            if (!bestMove) return;

            sock.botGame.move({
                from: bestMove.slice(0, 2),
                to: bestMove.slice(2, 4),
                promotion: bestMove.length > 4 ? bestMove[4] : "q"
            });

            sock.emit("botBoardState", sock.botGame.fen());

            const over = getGameOverPayload(sock.botGame);
            if (over) sock.emit("botGameOver", over);
        } catch (err) {
            console.error("Engine move error:", err);
        } finally {
            sock.engineBusy = false;
        }
    }

    // =====================
    // RESIGN (BOT)
    // =====================
    socket.on("botResign", () => {
        if (!socket.botColor) return;
        const winner = socket.botColor === "white" ? "black" : "white";

        socket.emit("botGameOver", { winner, reason: "resign" });
    });

    // =====================
    // NEW GAME (BOT)
    // =====================
    socket.on("restartBotGame", async () => {
        if (!socket.botGame) return;

        socket.botGame.reset();
        socket.emit("botBoardState", socket.botGame.fen());
        socket.emit("botGameReset");

        if (socket.botColor === "black") {
            await makeBotMove(socket);
        }
    });

    // =====================
    // CLEANUP
    // =====================
    socket.on("disconnect", () => {
        if (players.white === socket.id) players.white = null;
        if (players.black === socket.id) players.black = null;
        killEngine(socket);
    });
});

server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
});