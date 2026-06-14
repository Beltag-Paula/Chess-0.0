const socket = io();
const game = new Chess();
const playerColor = window.playerColor;

socket.emit("setBotColor", playerColor);

// Handle Elo Dropdown Updates
document.addEventListener("DOMContentLoaded", () => {
    const diffSelect = document.getElementById("difficulty-select");
    if (diffSelect) {
        // Broadcast the initial choice
        socket.emit("setBotElo", parseInt(diffSelect.value));

        diffSelect.addEventListener("change", (e) => {
            const selectedElo = parseInt(e.target.value);
            socket.emit("setBotElo", selectedElo);
        });
    }
});

const board = Chessboard("board", {
    draggable: true,
    position: "start",
    moveSpeed: "fast",       // Fast animations like Lichess
    snapbackSpeed: 200,      // Smooth handling for illegal drop attempts
    snapSpeed: 100,

    pieceTheme: function (piece) {
        const map = {
            wP: "whitePawn.svg", wR: "whiteRook.svg", wN: "whiteKnight.svg",
            wB: "whiteBishop.svg", wQ: "whiteQueen.svg", wK: "whiteKing.svg",
            bP: "blackPawn.svg", bR: "blackRook.svg", bN: "blackKnight.svg",
            bB: "blackBishop.svg", bQ: "blackQueen.svg", bK: "blackKing.svg"
        };
        return `/public/imgPieces/${map[piece]}`;
    },

    onDragStart: function (source, piece) {
        if (game.game_over()) return false;

        // Freeze pieces completely if it's the Bot's turn to play
        const turn = game.turn();
        if ((playerColor === "white" && turn !== "w") || (playerColor === "black" && turn !== "b")) {
            return false;
        }

        const isWhite = piece.startsWith("w");
        const isBlack = piece.startsWith("b");
        if (playerColor === "white" && !isWhite) return false;
        if (playerColor === "black" && !isBlack) return false;

        return true;
    },

    onDrop: function (source, target) {
        const move = game.move({
            from: source,
            to: target,
            promotion: "q"
        });

        if (!move) return "snapback";

        socket.emit("botMove", {
            from: source,
            to: target,
            promotion: "q"
        });
    }
});

if (playerColor === "black") {
    board.orientation("black");
}

socket.on("botBoardState", (fen) => {
    game.load(fen);
    board.position(fen);
});

async function startBlackGame() {
    if (playerColor !== "black") return;

    const diffSelect = document.getElementById("difficulty-select");
    const currentElo = diffSelect ? parseInt(diffSelect.value) : 1400;

    const response = await fetch("/bot-first-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elo: currentElo })
    });

    const data = await response.json();
    game.load(data.fen);
    board.position(data.fen);
}

startBlackGame();