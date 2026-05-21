const socket = io();

const game = new Chess();

let playerColor = null;

socket.on("playerRole", (color) => {
    playerColor = color;

    if (color === "black") {
        board.orientation("black");
    }
});

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
        if (playerColor === "spectator") return false;

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

        if (move === null) return "snapback";

        socket.emit("move", {
            from: source,
            to: target,
            promotion: "q"
        });
    }
});

socket.on("boardState", (fen) => {
    game.load(fen);
    board.position(fen);
});