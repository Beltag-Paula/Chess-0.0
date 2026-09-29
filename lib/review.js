"use strict";

/**
 * Game review: replay a finished game, ask Stockfish to evaluate EVERY position,
 * then compare "what was played" with "what the engine wanted" at each move.
 *
 * Positions 0..N are evaluated (N = number of plies). Move k goes from
 * position k to position k+1:
 *   before = eval of position k   (mover's point of view)
 *   after  = eval of position k+1 (opponent's point of view, so we flip it)
 *   loss   = how much win% the mover gave up
 *
 * Two passes:
 *   1. every position at a moderate depth (fast)
 *   2. positions next to suspicious moves (big loss, or "great") again at a higher
 *      depth. One shaky evaluation affects BOTH neighbouring moves, so re-checking
 *      the few positions that matter removes most engine-horizon noise cheaply.
 */

const os = require("os");
const { Chess } = require("chess.js");
const { UciEngine } = require("./uciEngine");
const A = require("./analysis");

const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;

const DEFAULTS = {
    depth: Number(process.env.REVIEW_DEPTH) || 13,
    movetime: Number(process.env.REVIEW_MOVETIME) || 2500, // safety cap per position (ms)
    verifyDepth: Number(process.env.REVIEW_VERIFY_DEPTH) || 16,
    verifyMovetime: Number(process.env.REVIEW_VERIFY_MOVETIME) || 5000,
    workers: Number(process.env.REVIEW_WORKERS) || Math.max(1, Math.min(4, cores - 1))
};

const BUCKETS = ["opening", "tactics", "strategy", "endgame"];

// ---------------------------------------------------------------------------
// Replaying the game record
// ---------------------------------------------------------------------------

function terminalOf(chess, isFinal, gameResult) {
    if (chess.isCheckmate()) return "checkmate";
    if (chess.isStalemate()) return "stalemate";
    if (isFinal && gameResult === "1/2-1/2" && chess.isDraw()) return "draw";
    return null;
}

function replayGame(game) {
    const chess = new Chess(game.startFen || undefined);
    const total = game.moves.length;

    const positions = [
        { fen: chess.fen(), turn: chess.turn(), terminal: terminalOf(chess, total === 0, game.result) }
    ];
    const moves = [];

    game.moves.forEach((uci, i) => {
        const fenBefore = chess.fen();
        let m;
        try {
            m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        } catch (_) {
            throw new Error(`Game record contains an illegal move at ply ${i + 1}: ${uci}`);
        }
        moves.push({
            uci,
            san: m.san,
            color: m.color === "w" ? "white" : "black",
            captured: m.captured || null,
            promotion: m.promotion || null,
            fenBefore
        });
        positions.push({
            fen: chess.fen(),
            turn: chess.turn(),
            terminal: terminalOf(chess, i === total - 1, game.result)
        });
    });

    return { positions, moves };
}

// ---------------------------------------------------------------------------
// Engine pool: N Stockfish processes, each pulling positions from a shared queue
// ---------------------------------------------------------------------------

class EnginePool {
    constructor(engines) {
        this.engines = engines;
    }

    static async create(count) {
        const engines = [];
        try {
            for (let i = 0; i < count; i++) {
                const engine = await UciEngine.start();
                engines.push(engine);
                engine.setOption("Threads", 1);
                engine.setOption("Hash", 64);
                await engine.setFullStrength();
            }
        } catch (err) {
            engines.forEach((e) => e.kill());
            throw err;
        }
        return new EnginePool(engines);
    }

    /**
     * Analyse the given position indices. Returns { [index]: { lines, terminalEval? } }.
     * lines = [{ uci, eval:{type,value} }] best first, evals from the side to move.
     */
    async evaluate(positions, indices, { depth, movetime, onProgress }) {
        const results = {};
        let next = 0;
        let done = 0;

        await Promise.all(
            this.engines.slice(0, Math.max(1, indices.length)).map(async (engine) => {
                for (;;) {
                    const n = next++;
                    if (n >= indices.length) return;
                    const i = indices[n];
                    const pos = positions[i];

                    if (pos.terminal) {
                        // Game-ending positions have no legal moves for the engine to analyse.
                        results[i] = {
                            lines: [],
                            terminalEval: pos.terminal === "checkmate" ? { type: "mate", value: 0 } : { type: "cp", value: 0 }
                        };
                    } else {
                        const lines = await engine.analyse(pos.fen, { depth, movetime, multipv: 2 });
                        if (lines.length === 0) throw new Error(`Engine returned no analysis for position ${i}`);
                        results[i] = { lines: lines.map((l) => ({ uci: l.pv[0], eval: l.score })) };
                    }

                    done++;
                    if (onProgress) onProgress({ done, total: indices.length });
                }
            })
        );
        return results;
    }

    close() {
        this.engines.forEach((e) => e.kill());
    }

    get engineName() {
        return this.engines[0].name;
    }
}

const evalFor = (r) => (r.lines.length ? r.lines[0].eval : r.terminalEval);

// ---------------------------------------------------------------------------
// Helpers for turning numbers into labels
// ---------------------------------------------------------------------------

/** Eval text from WHITE's point of view, e.g. "+0.3", "-1.2", "M3", "-M2", "1-0". */
function evalTextWhite(e, turn, terminal) {
    if (terminal === "checkmate") return turn === "w" ? "0-1" : "1-0";
    if (terminal) return "½-½";
    const sign = turn === "w" ? 1 : -1;
    if (e.type === "mate") {
        const v = e.value * sign;
        return v > 0 ? `M${v}` : `-M${-v}`;
    }
    const pawns = Math.round((e.value * sign) / 10) / 10;
    return pawns === 0 ? "0.0" : `${pawns > 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

/** opening / middlegame / endgame from the piece count (simple, Lichess-style). */
function phaseOf(fen, plyIndex) {
    const piecesLeft = (fen.split(" ")[0].match(/[nbrq]/gi) || []).length; // no pawns, no kings
    if (piecesLeft <= 6) return "endgame";
    if (plyIndex < 20) return "opening"; // first 10 moves each
    return "middlegame";
}

function tryMove(fen, uci) {
    if (!uci) return null;
    try {
        return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch (_) {
        return null;
    }
}

const isForcing = (m) => !!(m && (m.captured || m.promotion || /[+#]/.test(m.san || "")));

const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// ---------------------------------------------------------------------------
// evals -> per-move rows (pure: re-run after the verification pass)
// ---------------------------------------------------------------------------

function computeRows(positions, moves, evals) {
    const T = A.THRESHOLDS;

    // White-POV win% for every position (graph, eval bar, and move weights)
    const whiteWin = evals.map((r, i) => {
        const w = A.evalToWin(evalFor(r));
        return positions[i].turn === "w" ? w : 100 - w;
    });

    const rows = [];
    moves.forEach((mv, k) => {
        const before = evals[k];
        const after = evals[k + 1];
        const [best, second] = before.lines;

        const e0 = evalFor(before);
        const e1 = evalFor(after);
        const winBefore = A.evalToWin(e0);
        const winAfter = 100 - A.evalToWin(e1); // e1 is from the opponent's side
        const cpBefore = A.evalToCp(e0);
        const cpAfter = -A.evalToCp(e1);

        let loss = Math.max(0, winBefore - winAfter);
        let cpLoss = Math.max(0, cpBefore - cpAfter);
        const gap = best && second ? A.evalToWin(best.eval) - A.evalToWin(second.eval) : null;

        // Flawless = the engine's #1 move and the next position's eval doesn't contradict it.
        // (If it DOES contradict it, the engine was fooled at this depth: judge by the numbers.)
        const forced = gap === null; // only one legal move, nothing to choose
        const isTop = !!best && best.uci === mv.uci;
        const engineTop = forced || (isTop && loss <= T.topMoveTolerance);
        if (engineTop) {
            loss = 0;
            cpLoss = 0;
        }

        const cls = A.classifyMove({
            engineTop,
            loss,
            gap,
            prevOpponentLoss: k > 0 ? rows[k - 1].loss : 0
        });

        // Which "skill area" does this move count toward?
        const bestObj = tryMove(mv.fenBefore, best && best.uci);
        const phase = phaseOf(mv.fenBefore, k);
        const tactical =
            isForcing(mv) ||
            isForcing(bestObj) ||
            (gap !== null && gap >= T.greatMinGap) ||
            e0.type === "mate" ||
            e1.type === "mate";
        const bucket = phase === "opening" ? "opening" : phase === "endgame" ? "endgame" : tactical ? "tactics" : "strategy";

        rows.push({
            ply: k + 1,
            color: mv.color,
            san: mv.san,
            uci: mv.uci,
            class: cls,
            loss,
            cpLoss,
            accuracy: A.accuracyFromLoss(loss),
            weight: A.volatilityWeight(whiteWin, k),
            bestUci: best ? best.uci : mv.uci,
            bestSan: isTop ? mv.san : bestObj ? bestObj.san : null,
            forced,
            phase,
            bucket
        });
    });

    return { rows, whiteWin };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function reviewGame(game, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const { positions, moves } = replayGame(game);
    const T = A.THRESHOLDS;
    const all = positions.map((_, i) => i);

    const pool = await EnginePool.create(Math.max(1, Math.min(opts.workers, positions.length)));
    let evals;
    let engineName;
    let verifiedCount = 0;

    try {
        engineName = pool.engineName;

        // ---- pass 1: everything, moderate depth ----
        const first = await pool.evaluate(positions, all, {
            depth: opts.depth,
            movetime: opts.movetime,
            onProgress: (p) => opts.onProgress && opts.onProgress({ stage: "analyzing", ...p })
        });
        evals = all.map((i) => first[i]);

        // ---- pass 2: re-check the neighbourhood of suspicious moves at higher depth ----
        if (opts.verifyDepth > opts.depth) {
            const suspicious = new Set();
            computeRows(positions, moves, evals).rows.forEach((r, k) => {
                if (r.loss >= T.verifyMinLoss || r.class === "great") {
                    suspicious.add(k);
                    suspicious.add(k + 1);
                }
            });
            const indices = [...suspicious].filter((i) => !positions[i].terminal).sort((a, b) => a - b);

            if (indices.length) {
                const deeper = await pool.evaluate(positions, indices, {
                    depth: opts.verifyDepth,
                    movetime: opts.verifyMovetime,
                    onProgress: (p) => opts.onProgress && opts.onProgress({ stage: "verifying", ...p })
                });
                indices.forEach((i) => (evals[i] = deeper[i]));
                verifiedCount = indices.length;
            }
        }
    } finally {
        pool.close();
    }

    const { rows, whiteWin } = computeRows(positions, moves, evals);

    // ---- per-player summary -----------------------------------------------
    const summarize = (color) => {
        const mine = rows.filter((r) => r.color === color);
        const counts = A.emptyCounts();
        mine.forEach((r) => counts[r.class]++);

        const acpl = mean(mine.map((r) => r.cpLoss));
        const accuracy = A.gameAccuracy(mine.map((r) => ({ accuracy: r.accuracy, weight: r.weight })));

        const phases = {};
        for (const b of BUCKETS) {
            const inBucket = mine.filter((r) => r.bucket === b);
            const acc = mean(inBucket.map((r) => r.accuracy));
            phases[b] = {
                moves: inBucket.length,
                accuracy: round(acc, 1),
                acpl: round(mean(inBucket.map((r) => r.cpLoss)), 1),
                grade: A.gradeFromAccuracy(acc) // null when the player made no moves of this kind
            };
        }

        return {
            moves: mine.length,
            accuracy: round(accuracy, 1),
            acpl: round(acpl, 1),
            gameRating: A.estimateGameRating(acpl, mine.length),
            counts,
            phases
        };
    };

    return {
        version: 1,
        gameId: game.id,
        analyzedAt: new Date().toISOString(),
        engine: {
            name: engineName,
            depth: opts.depth,
            verifyDepth: opts.verifyDepth,
            verifiedPositions: verifiedCount,
            multipv: 2
        },
        game: {
            mode: game.mode,
            white: game.white,
            black: game.black,
            result: game.result,
            reason: game.reason,
            endedAt: game.endedAt,
            moveCount: moves.length
        },
        summary: { white: summarize("white"), black: summarize("black") },
        positions: positions.map((p, i) => ({
            fen: p.fen,
            winWhite: round(whiteWin[i], 1),
            evalText: evalTextWhite(evalFor(evals[i]), p.turn, p.terminal)
        })),
        moves: rows.map((r) => ({
            ply: r.ply,
            color: r.color,
            san: r.san,
            uci: r.uci,
            class: r.class,
            loss: round(r.loss, 2),
            cpLoss: Math.round(r.cpLoss),
            accuracy: round(r.accuracy, 1),
            bestUci: r.bestUci,
            bestSan: r.bestSan,
            forced: r.forced,
            phase: r.phase,
            bucket: r.bucket
        }))
    };
}

module.exports = { reviewGame, replayGame, computeRows, phaseOf, evalTextWhite, DEFAULTS };
