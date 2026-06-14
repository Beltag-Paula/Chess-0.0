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

// ======================================
// EXPRESS
// ======================================

app.set("view engine", "pug");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// ======================================
// CHESS STATE
// ======================================

const playerGame = new Chess();
const botGame = new Chess();

let players = {
    white: null,
    black: null
};

// ======================================
// STOCKFISH ENGINE FACTORY (ELO HERE)
// ======================================

function createEngine(elo = 1000) {
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

// ======================================
// GET BEST MOVE
// ======================================

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

// ======================================
// ROUTES
// ======================================

app.get("/", (req, res) => {
    res.render("index");
});

app.get("/gameBot/:color", (req, res) => {
    res.render("gameBot", { color: req.params.color });
});

app.get("/gamePlayer/:color", (req, res) => {
    res.render("gamePlayer", { color: req.params.color });
});

// ======================================
// BOT FIRST MOVE
// ======================================

app.post("/bot-first-move", async (req, res) => {
    if (botGame.history().length > 0) {
        return res.json({ fen: botGame.fen() });
    }

    const engine = createEngine(1200); // default strength

    const bestMove = await getBestMove(engine, botGame.fen());

    if (!bestMove || bestMove === "(none)") {
        return res.json({ fen: botGame.fen() });
    }

    botGame.move({
        from: bestMove.slice(0, 2),
        to: bestMove.slice(2, 4),
        promotion: "q"
    });

    res.json({ fen: botGame.fen() });
});

// ======================================
// SOCKET.IO
// ======================================

io.on("connection", (socket) => {

    console.log("client connected");

    // ======================================
    // PLAYER VS PLAYER
    // ======================================

    socket.on("chooseColor", (color) => {

        if (color === "white") {
            if (players.white) {
                socket.emit("colorTaken");
                return;
            }
            players.white = socket.id;
        } else {
            if (players.black) {
                socket.emit("colorTaken");
                return;
            }
            players.black = socket.id;
        }

        socket.color = color;

        socket.emit("playerRole", color);
        socket.emit("playerBoardState", playerGame.fen());
    });

    socket.on("playerMove", (move) => {

        const currentTurn = playerGame.turn() === "w" ? "white" : "black";

        if (socket.color !== currentTurn) return;

        const result = playerGame.move(move);
        if (!result) return;

        io.emit("playerBoardState", playerGame.fen());
    });

    // ======================================
    // BOT GAME (PT MN DIN VIITOR, DE AICI SCHIMBI ELO LA BOT)
    // ======================================

    socket.on("setBotColor", (color) => {
        socket.botColor = color;

        // default bot strength (can be changed per user)
        socket.botElo = 1000;

        socket.emit("botBoardState", botGame.fen());
    });

    socket.on("setBotElo", (elo) => {
        socket.botElo = elo; // dynamic difficulty change
    });

    socket.on("botMove", async (move) => {

        const humanColor = socket.botColor;
        const botColor = humanColor === "white" ? "black" : "white";

        const result = botGame.move(move);
        if (!result) return;

        socket.emit("botBoardState", botGame.fen());

        const currentTurn = botGame.turn() === "w" ? "white" : "black";

        if (currentTurn === botColor) {

            const engine = createEngine(socket.botElo || 1200);

            const bestMove = await getBestMove(engine, botGame.fen());

            if (!bestMove || bestMove === "(none)") return;

            botGame.move({
                from: bestMove.slice(0, 2),
                to: bestMove.slice(2, 4),
                promotion: "q"
            });

            socket.emit("botBoardState", botGame.fen());
        }
    });

    // ======================================
    // DISCONNECT
    // ======================================

    socket.on("disconnect", () => {

        console.log("client disconnected");

        if (socket.id === players.white) players.white = null;
        if (socket.id === players.black) players.black = null;
    });
});

server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
});
