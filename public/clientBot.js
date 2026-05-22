const socket = io();

const game = new Chess();

const playerColor = window.playerColor;

// ======================================
// SET COLOR
// ======================================

socket.emit("setBotColor", playerColor);

// ======================================
// BOARD
// ======================================

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

    onDragStart: function (source, piece) {

        const isWhite = piece.startsWith("w");
        const isBlack = piece.startsWith("b");

        if (playerColor === "white" && !isWhite) {
            return false;
        }

        if (playerColor === "black" && !isBlack) {
            return false;
        }

        return true;
    },

    onDrop: function (source, target) {

        const move = game.move({
            from: source,
            to: target,
            promotion: "q"
        });

        if (!move) {
            return "snapback";
        }

        socket.emit("botMove", {
            from: source,
            to: target,
            promotion: "q"
        });
    }
});

// ======================================
// ROTATE BOARD
// ======================================

if (playerColor === "black") {

    board.orientation("black");
}

// ======================================
// RECEIVE BOARD
// ======================================

socket.on("botBoardState", (fen) => {

    game.load(fen);

    board.position(fen);
});

// ======================================
// ENGINE FIRST MOVE
// ======================================

async function startBlackGame() {

    if (playerColor !== "black") {
        return;
    }

    const response = await fetch("/bot-first-move", {
        method: "POST"
    });

    const data = await response.json();

    game.load(data.fen);

    board.position(data.fen);
}

startBlackGame();