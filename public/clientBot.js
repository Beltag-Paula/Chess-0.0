document.addEventListener("DOMContentLoaded", () => {

const socket = new GameSocket();
const game = new Chess();
const playerColor = window.playerColor;

let gameOver = false;
let lastPgn = ""; // the server's latest move list, replayed to it after a reconnect

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

        // If we're offline the server never sees this move, so take it back locally too.
        if (!socket.send("botMove", { from: move.from, to: move.to, promotion: move.promotion })) {
            game.undo();
            return "snapback";
        }
    }
});

// Keep the board sized correctly on window/orientation changes
window.addEventListener("resize", board.resize);

if (playerColor === "black") board.orientation("black");

// --------------------
// BUTTONS
// --------------------
const resignBtn = document.getElementById("resign-btn");
const newGameBtn = document.getElementById("new-game-btn");
const difficultySelect = document.getElementById("difficulty-select");
const status = document.getElementById("game-status");
const banner = document.getElementById("game-over-banner");
const bannerTitle = document.getElementById("banner-title");
const bannerSubtitle = document.getElementById("banner-subtitle");
const engineInfo = document.getElementById("engine-info");

// Review links (banner + sidebar) appear once the server has saved the finished game
const reviewLinks = [document.getElementById("banner-review"), document.getElementById("review-btn")];

function setReviewLinks(gameId) {
    reviewLinks.forEach((link) => {
        if (!link) return;
        if (gameId) {
            link.href = `/review/${gameId}`;
            link.hidden = false;
        } else {
            link.hidden = true;
        }
    });
}

if (resignBtn) {
    resignBtn.onclick = () => socket.send("botResign");
}

if (newGameBtn) {
    newGameBtn.onclick = () => {
        hideBanner();
        socket.send("restartBotGame");
    };
}

if (difficultySelect) {
    difficultySelect.addEventListener("change", () => {
        socket.send("setBotElo", parseInt(difficultySelect.value, 10));
    });
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
socket.on("botBoardState", ({ fen, pgn }) => {
    game.load(fen);
    board.position(fen);
    lastPgn = pgn; // chess.js forgets the move list on load(), so remember the server's copy
});

socket.on("botGameOver", (data) => {
    gameOver = true;
    showBanner(data.winner, data.reason);
    setReviewLinks(data.gameId);

    if (newGameBtn) newGameBtn.disabled = false;
});

socket.on("botGameReset", () => {
    gameOver = false;
    game.reset();
    board.position("start", false); // false = no animation, snaps exactly to start
    hideBanner();
    setReviewLinks(null);

    if (status) status.textContent = "Game in progress...";
    if (newGameBtn) newGameBtn.disabled = true;
});

socket.on("botError", (message) => {
    if (status) status.textContent = message;
});

// The server tells us the Elo the engine REALLY plays at (Stockfish can't go below 1320)
socket.on("botConfig", ({ requestedElo, effectiveElo }) => {
    if (!engineInfo) return;
    engineInfo.textContent =
        effectiveElo === requestedElo
            ? `Engine strength: ${effectiveElo} Elo`
            : `Engine strength: ${effectiveElo} Elo (Stockfish's supported range is 1320-3190)`;
});

// --------------------
// CONNECTION LIFECYCLE
// --------------------
// Runs on the first connect AND after every automatic reconnect. On a reconnect the server
// has lost this game (its engine process died with the old connection), so we hand it the
// moves so far and it carries on from there.
socket.onOpen(({ reconnect }) => {
    const resume = reconnect && !gameOver && lastPgn !== "";
    const identity = ChessIdentity.get();

    socket.send("setBotColor", {
        color: playerColor,
        elo: difficultySelect ? parseInt(difficultySelect.value, 10) : undefined,
        name: identity.name,
        playerId: identity.playerId,
        pgn: resume ? lastPgn : undefined
    });

    if (reconnect && status && !gameOver) status.textContent = "Game in progress...";
});

socket.onClose(() => {
    if (status && !gameOver) status.textContent = "Connection lost. Reconnecting...";
});

});
