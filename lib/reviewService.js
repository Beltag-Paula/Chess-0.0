"use strict";

/**
 * Wraps reviewGame() with the things a real server needs:
 *  - cache:       a game that was already reviewed is served from disk instantly
 *  - dedupe:      two people opening the same review share ONE analysis job
 *  - concurrency: Stockfish is CPU-hungry, so only N reviews run at once; the rest queue
 *  - limits:      absurdly short / long games are rejected up front
 */

const store = require("./store");
const { reviewGame } = require("./review");

const MAX_CONCURRENT = Number(process.env.REVIEW_CONCURRENCY) || 1;
const MIN_PLIES = 2;
const MAX_PLIES = 400;

class ReviewError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// --- tiny semaphore --------------------------------------------------------
let running = 0;
const waiters = [];

async function acquire() {
    if (running < MAX_CONCURRENT) {
        running++;
        return;
    }
    await new Promise((resolve) => waiters.push(resolve)); // slot is handed over on release
}

function release() {
    const next = waiters.shift();
    if (next) next(); // hand our slot straight to the next in line
    else running--;
}

// --- job registry ----------------------------------------------------------
const inflight = new Map(); // gameId -> { listeners:Set<fn>, promise }

/**
 * @param {string}   gameId
 * @param {function} onProgress  called with { stage:'queued'|'analyzing', done?, total? }
 * @returns {Promise<object>} the finished review
 */
async function getReview(gameId, onProgress) {
    if (!store.isValidId(gameId)) throw new ReviewError("bad_id", "Invalid game id.");

    // The job is registered synchronously (before any await) so that two simultaneous
    // requests for the same game can never both start an analysis.
    let job = inflight.get(gameId);
    if (!job) {
        job = { listeners: new Set() };
        const emit = (p) => job.listeners.forEach((fn) => fn(p));

        job.promise = (async () => {
            const cached = await store.loadReview(gameId);
            if (cached) return cached;

            const game = await store.loadGame(gameId);
            if (!game) throw new ReviewError("not_found", "Game not found.");
            if (game.moves.length < MIN_PLIES) {
                throw new ReviewError("too_short", "This game is too short to review.");
            }
            if (game.moves.length > MAX_PLIES) {
                throw new ReviewError("too_long", "This game is too long to review.");
            }

            if (running >= MAX_CONCURRENT) emit({ stage: "queued" });
            await acquire();
            try {
                const review = await reviewGame(game, {
                    onProgress: ({ done, total }) => emit({ stage: "analyzing", done, total })
                });
                await store.saveReview(review);
                return review;
            } finally {
                release();
            }
        })().finally(() => inflight.delete(gameId));

        inflight.set(gameId, job);
    }

    if (onProgress) job.listeners.add(onProgress);
    try {
        return await job.promise;
    } finally {
        if (onProgress) job.listeners.delete(onProgress);
    }
}

module.exports = { getReview, ReviewError };
