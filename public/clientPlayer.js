const socket = io();

const game = new Chess();

const playerColor = window.playerColor;

// ======================================
// CHOOSE COLOR
// ======================================

socket.emit("chooseColor", playerColor);

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

        socket.emit("playerMove", {
            from: source,
            to: target,
            promotion: "q"
        });
    }
});

// ======================================
// ROTATE
// ======================================

if (playerColor === "black") {

    board.orientation("black");
}

// ======================================
// RECEIVE ROLE
// ======================================

socket.on("playerRole", (color) => {

    console.log("role:", color);
});

// ======================================
// RECEIVE BOARD
// ======================================

socket.on("playerBoardState", (fen) => {

    game.load(fen);

    board.position(fen);
});

// ======================================
// COLOR TAKEN
// ======================================

socket.on("colorTaken", () => {

    alert("Color already taken.");
});