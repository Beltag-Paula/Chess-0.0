"use strict";

/**
 * Pure functions only (no engine, no I/O) so every number in a review can be
 * unit-tested and tuned in one place.
 *
 * Everything works in "win percentage" (0-100, from the mover's point of view)
 * rather than raw centipawns. Losing 100cp when you're already +10 is a
 * disaster; losing 100cp when you're +9 is nothing. Win% captures that.
 */

// ---------------------------------------------------------------------------
// TUNABLE CONSTANTS - change these to change how strict the review is.
// All "loss" values are in win-percentage points (0-100 scale).
// ---------------------------------------------------------------------------
const THRESHOLDS = {
    bestMax: 0.3, // <= this counts as "Best" even if it isn't the engine's exact first choice
    excellentMax: 2,
    goodMax: 5,
    inaccuracyMax: 10,
    mistakeMax: 20, // above this = blunder
    opportunityMin: 10, // opponent's previous move lost at least this much -> you were handed a chance
    greatMinGap: 15, // played the top move AND the 2nd-best move was >= this much worse
    topMoveTolerance: 3, // engine's #1 move whose "after" eval is within this of "before" counts as flawless
    verifyMinLoss: 10 // moves that lose this much (or are "great") get re-checked at higher depth
};

// Per-category "grade" from average move accuracy (the icons in the Opening/Tactics/... rows)
const GRADE_CUTOFFS = [
    [95, "best"],
    [88, "excellent"],
    [75, "good"],
    [60, "inaccuracy"],
    [45, "mistake"],
    [0, "blunder"]
];

const CP_CAP = 1000; // clamp centipawns so a mate-vs-huge-advantage swing doesn't dominate ACPL
const MIN_MOVES_FOR_RATING = 5;

// ---------------------------------------------------------------------------
// Evaluation -> win probability
// ---------------------------------------------------------------------------

/** Win% for the side the eval is from. Constant from Lichess' published model. */
function cpToWin(cp) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Engine score {type:'cp'|'mate', value} -> capped centipawns. */
function evalToCp(e) {
    if (e.type === "mate") return e.value > 0 ? CP_CAP : -CP_CAP; // mate 0 = side to move IS mated
    return Math.max(-CP_CAP, Math.min(CP_CAP, e.value));
}

/** Engine score -> win% (mate is a certain win/loss). */
function evalToWin(e) {
    if (e.type === "mate") return e.value > 0 ? 100 : 0;
    return cpToWin(evalToCp(e));
}

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

/**
 * Accuracy of ONE move from the win% it cost. Curve from Lichess' open-source
 * accuracy metric: 0 loss = 100, and it decays fast for bigger losses.
 */
function accuracyFromLoss(winLoss) {
    const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winLoss) - 3.166924740191411;
    return Math.max(0, Math.min(100, raw + 1)); // +1 = "uncertainty bonus", same as Lichess
}

/**
 * How swingy the game is around ply k. Sharp positions get more weight: one
 * slip in a tense position matters more than one in a dead-drawn shuffle.
 */
function volatilityWeight(whiteWinSeries, k) {
    const from = Math.max(0, k - 2);
    const to = Math.min(whiteWinSeries.length, k + 4);
    const slice = whiteWinSeries.slice(from, to);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    return Math.max(0.5, Math.min(12, Math.sqrt(variance)));
}

/**
 * Whole-game accuracy for one side: average of a volatility-weighted mean and a
 * harmonic mean (the harmonic mean punishes a single terrible move harder).
 * `items` = [{ accuracy, weight }]
 */
function gameAccuracy(items) {
    if (items.length === 0) return null;
    const totalW = items.reduce((s, i) => s + i.weight, 0);
    const weighted = items.reduce((s, i) => s + i.accuracy * i.weight, 0) / totalW;
    const harmonic = items.length / items.reduce((s, i) => s + 1 / Math.max(i.accuracy, 0.5), 0);
    return (weighted + harmonic) / 2;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * @param engineTop         played the engine's #1 move AND the next position's eval agrees (loss ~ 0)
 * @param loss              win% the mover gave up (0 if engineTop)
 * @param gap               win% gap between engine's #1 and #2 move (null if only one legal move)
 * @param prevOpponentLoss  win% the opponent's previous move lost (0 if none)
 */
function classifyMove({ engineTop, loss, gap, prevOpponentLoss }) {
    const T = THRESHOLDS;

    if (engineTop) {
        // "Great" = you found the only good move (everything else was much worse)
        return gap !== null && gap >= T.greatMinGap ? "great" : "best";
    }
    if (loss <= T.bestMax) return "best";
    if (loss <= T.excellentMax) return "excellent";
    if (loss <= T.goodMax) return "good";
    if (loss <= T.inaccuracyMax) return "inaccuracy";
    if (loss > T.mistakeMax) return "blunder";

    // Mistake-sized loss. If the opponent had just slipped, we let the chance go: "Miss".
    return prevOpponentLoss >= T.opportunityMin ? "miss" : "mistake";
}

function gradeFromAccuracy(accuracy) {
    if (accuracy === null || accuracy === undefined) return null;
    for (const [min, grade] of GRADE_CUTOFFS) if (accuracy >= min) return grade;
    return "blunder";
}

// ---------------------------------------------------------------------------
// Rating estimate
// ---------------------------------------------------------------------------

/**
 * Rough "performance rating" from average centipawn loss.
 * Rating ~= 3100 * e^(-0.01 * ACPL): a widely used empirical fit, NOT chess.com's
 * proprietary Game Rating. Treat it as a consistent yardstick between your own
 * games, not an official rating. Rounded to the nearest 50 to avoid false precision.
 */
function estimateGameRating(acpl, moveCount) {
    if (acpl === null || moveCount < MIN_MOVES_FOR_RATING) return null;
    const raw = 3100 * Math.exp(-0.01 * acpl);
    return Math.max(200, Math.min(3200, Math.round(raw / 50) * 50));
}

const CLASSES = [
    "great",
    "best",
    "excellent",
    "good",
    "inaccuracy",
    "mistake",
    "miss",
    "blunder"
];

function emptyCounts() {
    return Object.fromEntries(CLASSES.map((c) => [c, 0]));
}

module.exports = {
    THRESHOLDS,
    CLASSES,
    CP_CAP,
    MIN_MOVES_FOR_RATING,
    cpToWin,
    evalToCp,
    evalToWin,
    accuracyFromLoss,
    volatilityWeight,
    gameAccuracy,
    classifyMove,
    gradeFromAccuracy,
    estimateGameRating,
    emptyCounts
};
