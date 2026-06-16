document.addEventListener("DOMContentLoaded", () => {

const socket = io();
const game = new Chess();
const playerColor = window.playerColor;

let gameOver = false;

socket.emit("setBotColor", playerColor);

// --------------------
// BOARD SAFE INIT
// --------------------
const boardElement = document.getElementById("board");
if (!boardElement) return;

const board = Chessboard("board", {
    draggable: true,
    position: "start",

    pieceTheme: function (piece) {
        const map = {
            wP: "whitePawn.svg",
            wR: "whiteRook.svg",
            wN: "whiteKnight.svg",
            wB: "whiteBishop.svg",
            wQ: "whiteQueen.svg",
            wK: "whiteKing.svg",
            bP: "blackPawn.svg",
            bR: "blackRook.svg",
            bN: "blackKnight.svg",
            bB: "blackBishop.svg",
            bQ: "blackQueen.svg",
            bK: "blackKing.svg"
        };
        return `/public/imgPieces/${map[piece]}`;
    },

    onDragStart: () => !gameOver,

    onDrop: (source, target) => {
        const move = game.move({ from: source, to: target, promotion: "q" });
        if (!move) return "snapback";

        socket.emit("botMove", move);
    }
});

if (playerColor === "black") board.orientation("black");

// --------------------
// BUTTONS
// --------------------
const resignBtn = document.getElementById("resign-btn");
const newGameBtn = document.getElementById("new-game-btn");

if (resignBtn) {
    resignBtn.onclick = () => socket.emit("botResign");
}

if (newGameBtn) {
    newGameBtn.onclick = () => socket.emit("restartBotGame");
}

// --------------------
// SOCKET EVENTS
// --------------------
socket.on("botBoardState", (fen) => {
    game.load(fen);
    board.position(fen);
});

socket.on("botGameOver", (data) => {
    gameOver = true;

    const status = document.getElementById("game-status");
    if (status) {
        status.textContent = `${data.winner} wins (${data.reason})`;
    }

    if (newGameBtn) newGameBtn.disabled = false;
});

socket.on("botGameReset", () => {
    gameOver = false;
    game.reset();
    board.position("start");

    if (newGameBtn) newGameBtn.disabled = true;
});

});