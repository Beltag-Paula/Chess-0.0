const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const game = new Chess();

let players = {
    white: null,
    black: null
};

app.set("view engine", "pug");
app.set("views", path.join(__dirname, "views"));

app.use("/public", express.static(path.join(__dirname, "public")));


//This is for the stupid Firefox with the CSP bullshit
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            "script-src 'self' https://code.jquery.com https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'",
            "script-src-elem 'self' https://code.jquery.com https://cdnjs.cloudflare.com https://unpkg.com",
            "style-src 'self' 'unsafe-inline' https://unpkg.com",
            "img-src 'self' data:",
            "connect-src 'self' ws: wss:"
        ].join("; ")
    );
    next();
});


// routes
app.get("/", (req, res) => {
    res.render("gamePage", { color: null });
});

app.get("/white", (req, res) => {
    res.render("gamePage", { color: "white" });
});

app.get("/black", (req, res) => {
    res.render("gamePage", { color: "black" });
});

// socket logic
io.on("connection", (socket) => {
    console.log("client connected");

    if (!players.white) {
        players.white = socket.id;
        socket.color = "white";
    } else if (!players.black) {
        players.black = socket.id;
        socket.color = "black";
    } else {
        socket.color = "spectator";
    }

    socket.emit("playerRole", socket.color);
    socket.emit("boardState", game.fen());

    socket.on("move", (move) => {
        const turn = game.turn(); // w or b
        const expected = turn === "w" ? "white" : "black";

        if (socket.color !== expected) return;

        const result = game.move(move);

        if (result) {
            io.emit("boardState", game.fen());
        }
    });

    socket.on("disconnect", () => {
        if (socket.id === players.white) players.white = null;
        if (socket.id === players.black) players.black = null;
    });
});

server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}/`);
});

