document.addEventListener("DOMContentLoaded", () => {

const socket = io();
const game = new Chess();
const playerColor = window.playerColor;

let gameOver = false;

socket.emit("chooseColor", playerColor);

// --------------------
// BOARD (SAFE INIT)
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
            bK: "blackKing.svg",
            bQ: "blackQueen.svg"
        };
        return `/public/imgPieces/${map[piece]}`;
    },

    onDragStart: (source, piece) => {
        if (gameOver) return false;

        const turn = game.turn(); // 'w' or 'b'
        const isPlayerTurn =
            (playerColor === "white" && turn === "w") ||
            (playerColor === "black" && turn === "b");
        if (!isPlayerTurn) return false;

        const pieceColor = piece[0] === "w" ? "white" : "black";
        return pieceColor === playerColor;
    },

    onDrop: (source, target) => {
        const move = game.move({ from: source, to: target, promotion: "q" });
        if (!move) return "snapback";

        socket.emit("playerMove", move);
    }
});

// Keep the board sized correctly on window/orientation changes
window.addEventListener("resize", board.resize);

if (playerColor === "black") board.orientation("black");

// --------------------
// BUTTONS (SAFE BINDING)
// --------------------
const resignBtn = document.getElementById("resign-btn");
const newGameBtn = document.getElementById("new-game-btn");
const status = document.getElementById("game-status");
const banner = document.getElementById("game-over-banner");
const bannerTitle = document.getElementById("banner-title");
const bannerSubtitle = document.getElementById("banner-subtitle");

if (resignBtn) {
    resignBtn.onclick = () => socket.emit("playerResign");
}

if (newGameBtn) {
    newGameBtn.onclick = () => {
        hideBanner();
        socket.emit("restartPlayerGame");
    };
}

// --------------------
// GAME-OVER BANNER
// --------------------
const REASON_LABEL = {
    checkmate: "Checkmate",
    stalemate: "Draw by stalemate",
    draw: "Draw",
    resign: "By resignation"
};

function showBanner(winner, reason) {
    const reasonLabel = REASON_LABEL[reason] || reason;
    let resultClass = "result-lose";
    let title = "You Lose";

    if (winner === "draw") {
        resultClass = "result-draw";
        title = "Draw";
    } else if (winner === playerColor) {
        resultClass = "result-win";
        title = "You Win!";
    }

    if (status) status.textContent = `${title} (${reasonLabel})`;

    if (banner && bannerTitle && bannerSubtitle) {
        bannerTitle.textContent = title;
        bannerTitle.className = `banner-title ${resultClass}`;
        bannerSubtitle.textContent = reasonLabel;
        banner.classList.add("is-visible");
    }
}

function hideBanner() {
    if (banner) banner.classList.remove("is-visible");
}

// --------------------
// SOCKET EVENTS
// --------------------
socket.on("playerBoardState", (fen) => {
    game.load(fen);
    board.position(fen);
});

socket.on("playerGameOver", (data) => {
    gameOver = true;
    showBanner(data.winner, data.reason);

    if (newGameBtn) newGameBtn.disabled = false;
});

socket.on("playerGameReset", () => {
    gameOver = false;
    game.reset();
    board.position("start", false); // false = no animation, snaps exactly to start
    hideBanner();

    if (status) status.textContent = "Game in progress...";
    if (newGameBtn) newGameBtn.disabled = true;
});

socket.on("colorTaken", (color) => {
    if (status) status.textContent = `${color} is already taken by another player.`;
});

});
