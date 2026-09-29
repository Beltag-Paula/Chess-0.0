"use strict";

document.addEventListener("DOMContentLoaded", () => {
    const gameId = window.gameId;
    const $ = (id) => document.getElementById(id);

    // Everything that shows user-supplied text (player names) goes through textContent,
    // never innerHTML, so a name can't inject markup.
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // -----------------------------------------------------------------------
    // Look & feel of each move classification
    // -----------------------------------------------------------------------
    const CLASS_META = {
        great: { label: "Great", glyph: "!", color: "#5c8bb0" },
        best: { label: "Best", glyph: "★", color: "#7fa650" },
        excellent: { label: "Excellent", glyph: "👍", color: "#7fa650" },
        good: { label: "Good", glyph: "✓", color: "#95a37a" },
        inaccuracy: { label: "Inaccuracy", glyph: "?!", color: "#e6b422" },
        mistake: { label: "Mistake", glyph: "?", color: "#e58f2a" },
        miss: { label: "Miss", glyph: "✕", color: "#e8665a" },
        blunder: { label: "Blunder", glyph: "??", color: "#ca3431" }
    };

    const MAIN_ROWS = ["great", "best", "excellent", "mistake", "miss", "blunder"];
    const EXTRA_ROWS = ["good", "inaccuracy"]; // behind the chevron, like chess.com
    const PHASES = [
        ["opening", "Opening"],
        ["tactics", "Tactics"],
        ["strategy", "Strategy"],
        ["endgame", "Endgame"]
    ];
    const KEY_CLASSES = new Set(["great", "mistake", "miss", "blunder"]);
    const NOTABLE = new Set(["great", "inaccuracy", "mistake", "miss", "blunder"]);
    const HINT_CLASSES = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
    const REASON_LABEL = { checkmate: "Checkmate", stalemate: "Stalemate", draw: "Draw", resign: "Resignation" };

    const VERDICT = {
        great: " is a great move! Everything else was much worse.",
        best: " is the best move.",
        excellent: " is an excellent move.",
        good: " is a good move.",
        inaccuracy: " is an inaccuracy.",
        mistake: " is a mistake.",
        miss: " lets a good chance slip.",
        blunder: " is a blunder."
    };

    function icon(cls, small) {
        const meta = CLASS_META[cls];
        const node = el("span", "cls-icon" + (small ? " small" : ""), meta.glyph);
        node.style.background = meta.color;
        node.title = meta.label;
        return node;
    }

    // -----------------------------------------------------------------------
    // State + board
    // -----------------------------------------------------------------------
    let review = null;
    let current = 0; // 0 = start position, k = after ply k
    let orientation = "white"; // whose side is at the bottom
    let keyPlies = [];
    let failed = false;
    let cursorLine = null;

    const board = Chessboard("board", {
        draggable: false,
        position: "start",
        pieceTheme: (piece) => {
            const map = {
                wP: "whitePawn.svg", wR: "whiteRook.svg", wN: "whiteKnight.svg",
                wB: "whiteBishop.svg", wQ: "whiteQueen.svg", wK: "whiteKing.svg",
                bP: "blackPawn.svg", bR: "blackRook.svg", bN: "blackKnight.svg",
                bB: "blackBishop.svg", bQ: "blackQueen.svg", bK: "blackKing.svg"
            };
            return `/public/imgPieces/${map[piece]}`;
        }
    });

    window.addEventListener("resize", () => {
        board.resize(); // redraws the squares, which wipes our highlights, so re-apply them
        if (review) {
            markBoard();
            renderGraph();
        }
    });

    // -----------------------------------------------------------------------
    // WebSocket: ask for the review, show progress, receive the result
    // -----------------------------------------------------------------------
    const socket = new GameSocket();

    socket.onOpen(() => {
        if (review || failed) return;
        setLoading("Connecting...", 3);
        socket.send("reviewGame", { gameId });
    });
    socket.onClose(() => {
        if (!review && !failed) setLoading("Connection lost. Reconnecting...");
    });

    socket.on("reviewProgress", (p) => {
        if (review) return;
        if (p.stage === "queued") setLoading("Another review is running. You're next in line...", 3);
        else if (p.stage === "analyzing") setLoading(`Analyzing positions (${p.done}/${p.total})...`, 5 + (75 * p.done) / p.total);
        else if (p.stage === "verifying") setLoading(`Double-checking key moments (${p.done}/${p.total})...`, 80 + (18 * p.done) / p.total);
    });
    socket.on("reviewResult", onResult);
    socket.on("reviewError", (err) => {
        failed = true;
        $("review-loading").hidden = true;
        $("review-error").hidden = false;
        $("error-text").textContent = (err && err.message) || "Something went wrong.";
    });

    function setLoading(text, percent) {
        $("loading-text").textContent = text;
        if (percent !== undefined) $("progress-bar").style.width = `${percent}%`;
    }

    // -----------------------------------------------------------------------
    // Rendering the finished review
    // -----------------------------------------------------------------------
    function onResult(r) {
        review = r;
        const G = r.game;
        orientation = G.white.isBot ? "black" : "white"; // the human sits at the bottom

        $("review-loading").hidden = true;
        $("review-content").hidden = false;

        board.orientation(orientation);
        $("eval-bar").classList.toggle("flipped", orientation === "black");
        $("download-json").href = `/api/reviews/${encodeURIComponent(gameId)}`;

        const other = orientation === "white" ? "black" : "white";
        fillTag($("player-top"), other);
        fillTag($("player-bottom"), orientation);

        $("review-meta").textContent =
            `${G.white.name} vs ${G.black.name} · ${G.result} · ${REASON_LABEL[G.reason] || G.reason}`;

        keyPlies = r.moves.filter((m) => KEY_CLASSES.has(m.class)).map((m) => m.ply);
        $("btn-key").disabled = keyPlies.length === 0;

        renderReport();
        renderMoveList();
        renderGraph(); // needs the (now visible) container's real width
        goTo(0, false);
    }

    function fillTag(node, color) {
        node.textContent = "";
        node.append(el("span", `dot ${color}`), el("span", "who", review.game[color].name));
    }

    function renderReport() {
        const box = $("report");
        box.textContent = "";

        const G = review.game;
        const S = review.summary;
        const sides = orientation === "white" ? ["white", "black"] : ["black", "white"];

        const cell = (child) => {
            const c = el("div", "rcell");
            if (child) c.append(child);
            return c;
        };
        function addRow(label, left, mid, right, extraClass) {
            const row = el("div", "rrow" + (extraClass ? ` ${extraClass}` : ""));
            row.append(el("div", "rlabel", label), cell(left), cell(mid), cell(right));
            box.append(row);
            return row;
        }
        const statBox = (value, isLeft, title) => {
            const b = el("div", "stat-box" + (isLeft ? " is-you" : "") + (value === "–" ? " na" : ""), String(value));
            if (title) b.title = title;
            return b;
        };

        // Players
        const playerCell = (color, isLeft) => {
            const p = G[color];
            const wrap = el("div", "player-cell");
            const avatar = el("div", "avatar" + (isLeft && !p.isBot ? " is-you" : ""), p.isBot ? "♞" : (p.name[0] || "?").toUpperCase());
            wrap.append(avatar, el("div", "name", p.name));
            return wrap;
        };
        addRow("Players", playerCell(sides[0], true), null, playerCell(sides[1], false));

        // Accuracy
        const acc = (color, isLeft) => statBox(S[color].accuracy === null ? "–" : S[color].accuracy.toFixed(1), isLeft);
        addRow("Accuracy", acc(sides[0], true), null, acc(sides[1], false), "section-start");

        // Move counts
        const countCell = (color, cls) => {
            const n = el("span", "rcount", String(S[color].counts[cls]));
            n.style.color = CLASS_META[cls].color;
            return n;
        };
        const countRow = (cls, extra) => addRow(CLASS_META[cls].label, countCell(sides[0], cls), icon(cls), countCell(sides[1], cls), extra);

        MAIN_ROWS.forEach((cls, i) => countRow(cls, i === 0 ? "section-start" : ""));
        const extraRows = EXTRA_ROWS.map((cls) => {
            const row = countRow(cls, "extra");
            row.hidden = true;
            return row;
        });

        const chevronRow = el("div", "chevron-row");
        const chevron = el("button", "chevron", "⌄");
        chevron.type = "button";
        chevron.setAttribute("aria-expanded", "false");
        chevron.setAttribute("aria-label", "Show more move types");
        chevron.onclick = () => {
            const open = chevron.getAttribute("aria-expanded") !== "true";
            chevron.setAttribute("aria-expanded", String(open));
            extraRows.forEach((r) => (r.hidden = !open));
        };
        chevronRow.append(chevron);
        box.append(chevronRow);

        // Game rating (estimate)
        const rating = (color, isLeft) => {
            const v = S[color].gameRating;
            return statBox(v === null ? "–" : v, isLeft, v === null ? "Too few moves to estimate" : "Estimated from average centipawn loss");
        };
        addRow("Game Rating", rating(sides[0], true), null, rating(sides[1], false), "section-start");

        // Opening / Tactics / Strategy / Endgame
        const gradeCell = (color, key) => {
            const ph = S[color].phases[key];
            if (!ph.grade) {
                const n = el("span", "na-mark", "–");
                n.title = "No moves in this phase";
                return n;
            }
            const i = icon(ph.grade);
            i.title = `${CLASS_META[ph.grade].label} · ${ph.accuracy}% accuracy over ${ph.moves} move${ph.moves === 1 ? "" : "s"}`;
            return i;
        };
        PHASES.forEach(([key, label], idx) => {
            addRow(label, gradeCell(sides[0], key), null, gradeCell(sides[1], key), idx === 0 ? "section-start" : "");
        });

        const e = review.engine;
        box.append(
            el(
                "p",
                "report-foot",
                `${e.name} · depth ${e.depth}` +
                    (e.verifiedPositions ? ` (${e.verifyDepth} on ${e.verifiedPositions} critical positions)` : "") +
                    `. Accuracy, Game Rating and the four phase grades are engine-based estimates, most reliable in longer games. ` +
                    `Hover an icon for details.`
            )
        );
    }

    function renderMoveList() {
        const list = $("move-list");
        list.textContent = "";

        const button = (m) => {
            const b = el("button", "mv");
            b.type = "button";
            b.dataset.ply = String(m.ply);
            b.append(el("span", "", m.san));
            if (NOTABLE.has(m.class)) b.append(icon(m.class, true));
            b.onclick = () => goTo(m.ply);
            return b;
        };

        for (let i = 0; i < review.moves.length; i += 2) {
            list.append(el("div", "move-num", `${i / 2 + 1}.`));
            list.append(button(review.moves[i]));
            list.append(review.moves[i + 1] ? button(review.moves[i + 1]) : el("div", "mv-empty"));
        }
    }

    // ---- evaluation graph (white's winning chances over the whole game) ----
    const SVG_NS = "http://www.w3.org/2000/svg";
    function svgEl(tag, attrs) {
        const n = document.createElementNS(SVG_NS, tag);
        for (const k in attrs) n.setAttribute(k, attrs[k]);
        return n;
    }

    function renderGraph() {
        const svg = $("eval-graph");
        const W = svg.clientWidth || 400;
        const H = 90;
        const N = review.positions.length - 1;
        const x = (i) => (N === 0 ? 0 : (i / N) * W);
        const y = (i) => H - (review.positions[i].winWhite / 100) * H;

        svg.textContent = "";
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.append(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "#403d39" }));

        const pts = review.positions.map((_, i) => `${x(i).toFixed(1)},${y(i).toFixed(1)}`).join(" ");
        svg.append(svgEl("polygon", { points: `0,${H} ${pts} ${W},${H}`, fill: "#f4f4f4" }));
        svg.append(svgEl("line", { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: "rgba(128,128,128,0.7)", "stroke-width": 1 }));

        review.moves.forEach((m) => {
            if (!KEY_CLASSES.has(m.class)) return;
            svg.append(svgEl("circle", { cx: x(m.ply), cy: y(m.ply), r: 4, fill: CLASS_META[m.class].color, stroke: "#222", "stroke-width": 1 }));
        });

        cursorLine = svgEl("line", { x1: 0, x2: 0, y1: 0, y2: H, stroke: "#e1006f", "stroke-width": 2 });
        svg.append(cursorLine);

        svg.onclick = (ev) => {
            const rect = svg.getBoundingClientRect();
            goTo(Math.round(((ev.clientX - rect.left) / rect.width) * N));
        };
        updateCursor();
    }

    function updateCursor() {
        if (!cursorLine) return;
        const svg = $("eval-graph");
        const W = svg.clientWidth || 400;
        const N = review.positions.length - 1;
        const cx = N === 0 ? 0 : (current / N) * W;
        cursorLine.setAttribute("x1", cx);
        cursorLine.setAttribute("x2", cx);
    }

    // -----------------------------------------------------------------------
    // Moving through the game
    // -----------------------------------------------------------------------
    function goTo(ply, animate = true) {
        const last = review.positions.length - 1;
        const previous = current;
        current = Math.max(0, Math.min(last, ply));
        const pos = review.positions[current];

        board.position(pos.fen, animate && Math.abs(current - previous) === 1);
        updateEvalBar(pos);
        markBoard();
        updateCoach();
        updateCursor();
        updateActiveMove();
    }

    function updateEvalBar(pos) {
        $("eval-fill").style.height = `${pos.winWhite}%`;
        const label = $("eval-label");
        label.textContent = pos.evalText;
        label.style.color = pos.winWhite > 12 ? "#222" : "#eee"; // readable on white fill or dark bar
    }

    /** Highlight the last move's squares and pin its classification badge on the destination. */
    function markBoard() {
        document.querySelectorAll("#board .hl-move").forEach((n) => n.classList.remove("hl-move"));
        document.querySelectorAll("#board .sq-badge").forEach((n) => n.remove());
        if (current === 0) return;

        const m = review.moves[current - 1];
        const from = document.querySelector(`#board .square-${m.uci.slice(0, 2)}`);
        const to = document.querySelector(`#board .square-${m.uci.slice(2, 4)}`);
        if (from) from.classList.add("hl-move");
        if (to) {
            to.classList.add("hl-move");
            const badge = el("span", "sq-badge", CLASS_META[m.class].glyph);
            badge.style.background = CLASS_META[m.class].color;
            to.append(badge);
        }
    }

    function updateCoach() {
        const text = $("coach-text");
        const sub = $("coach-sub");
        text.textContent = "";
        sub.textContent = "";

        if (current === 0) {
            text.textContent = "Let's review some key moments from this game.";
            sub.textContent = "Use the arrows, click the graph, or press ⚡ to jump to key moments.";
            return;
        }

        const m = review.moves[current - 1];
        text.append(el("strong", "", m.san), document.createTextNode(m.forced ? " is the only legal move." : VERDICT[m.class]));
        if (HINT_CLASSES.has(m.class) && m.bestSan) {
            text.append(document.createTextNode(" Best was "), el("strong", "", m.bestSan), document.createTextNode("."));
        }
        sub.textContent = `${review.game[m.color].name} · Eval ${review.positions[current].evalText}`;
    }

    function updateActiveMove() {
        const list = $("move-list");
        list.querySelectorAll(".mv.active").forEach((n) => n.classList.remove("active"));
        const btn = list.querySelector(`.mv[data-ply="${current}"]`);
        if (!btn) return;
        btn.classList.add("active");

        // Keep the active move visible by scrolling the LIST only (scrollIntoView could scroll the page)
        const top = btn.offsetTop;
        const bottom = top + btn.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }

    function goToNextKeyMoment() {
        if (keyPlies.length === 0) return;
        goTo(keyPlies.find((p) => p > current) || keyPlies[0]); // wraps around
    }

    // Controls
    $("btn-first").onclick = () => review && goTo(0);
    $("btn-prev").onclick = () => review && goTo(current - 1);
    $("btn-next").onclick = () => review && goTo(current + 1);
    $("btn-last").onclick = () => review && goTo(review.positions.length - 1);
    $("btn-key").onclick = () => review && goToNextKeyMoment();

    document.addEventListener("keydown", (e) => {
        if (!review || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === "ArrowLeft") goTo(current - 1);
        else if (e.key === "ArrowRight") goTo(current + 1);
        else if (e.key === "Home") goTo(0);
        else if (e.key === "End") goTo(review.positions.length - 1);
        else return;
        e.preventDefault();
    });
});
