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
// STATE (UNCHANGED STYLE)
// =====================
const playerGame = new Chess();
const botGame = new Chess();

let players = {
    white: null,
    black: null
};

// =====================
// STOCKFISH
// =====================
function createEngine(elo = 1200) {
    const enginePath = path.join(__dirname, "engine", "stockfish-bin");
    const engine = spawn(enginePath);

    engine.stdin.setEncoding("utf-8");
    engine.stdout.setEncoding("utf-8");

    engine.stdin.write("uci\n");
    engine.stdin.write("setoption name UCI_LimitStrength value true\n");
    engine.stdin.write(`setoption name UCI_Elo value ${elo}\n`);
    engine.stdin.write("isready\n");

    return engine;
}

function parseBestMove(data) {
    const lines = data.toString().split("\n");
    for (const line of lines) {
        if (line.startsWith("bestmove")) {
            return line.split(" ")[1];
        }
    }
    return null;
}

function getBestMove(engine, fen) {
    return new Promise((resolve) => {
        let buffer = "";

        const handler = (data) => {
            buffer += data.toString();
            const move = parseBestMove(buffer);

            if (move) {
                engine.stdout.off("data", handler);
                resolve(move);
            }
        };

        engine.stdout.on("data", handler);

        engine.stdin.write(`position fen ${fen}\n`);
        engine.stdin.write("go movetime 800\n");
    });
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
    // PLAYER MOVE
    // =====================
    socket.on("playerMove", (move) => {

        const currentTurn = playerGame.turn() === "w" ? "white" : "black";
        if (socket.color !== currentTurn) return;

        const result = playerGame.move(move);
        if (!result) return;

        io.emit("playerBoardState", playerGame.fen());
    });

    // =====================
    // BOT COLOR
    // =====================
    socket.on("setBotColor", (color) => {
        socket.botColor = color;
        socket.botElo = 1200;

        socket.emit("botBoardState", botGame.fen());
    });

    socket.on("setBotElo", (elo) => {
        socket.botElo = elo;
    });

    // =====================
    // BOT MOVE
    // =====================
socket.on("botMove", async (move) => {

    const result = botGame.move(move);
    if (!result) return;

    socket.emit("botBoardState", botGame.fen());

    // BOT ALWAYS RESPONDS AFTER HUMAN MOVE
    const botColor = socket.botColor === "white" ? "black" : "white";

    const engine = createEngine(socket.botElo || 1200);
    const bestMove = await getBestMove(engine, botGame.fen());

    if (!bestMove) return;

    botGame.move({
        from: bestMove.slice(0, 2),
        to: bestMove.slice(2, 4),
        promotion: "q"
    });

    socket.emit("botBoardState", botGame.fen());
});

    // =====================
    // RESIGN (PLAYER)
    // =====================
    socket.on("playerResign", () => {
        const winner = socket.color === "white" ? "black" : "white";

        io.emit("playerGameOver", {
            winner,
            reason: "resign"
        });
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
    // RESIGN (BOT)
    // =====================
    socket.on("botResign", () => {
        const winner = socket.botColor === "white" ? "black" : "white";

        socket.emit("botGameOver", {
            winner,
            reason: "resign"
        });
    });

    // =====================
    // NEW GAME (BOT)
    // =====================
    socket.on("restartBotGame", () => {
        botGame.reset();
        socket.emit("botBoardState", botGame.fen());
        socket.emit("botGameReset");
    });
});

server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
});