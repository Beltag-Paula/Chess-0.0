"use strict";

/**
 * Tiny file-based store:
 *   data/games/<id>.json    - a finished game (players, moves, result)
 *   data/reviews/<id>.json  - the Stockfish review of that game
 *
 * Plain JSON on purpose: easy to inspect, easy to load into pandas / a
 * database later when you build the per-player training profiles.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const GAMES_DIR = path.join(DATA_DIR, "games");
const REVIEWS_DIR = path.join(DATA_DIR, "reviews");

fs.mkdirSync(GAMES_DIR, { recursive: true });
fs.mkdirSync(REVIEWS_DIR, { recursive: true });

// The id ends up in a file path, so it MUST be validated first. Only strict UUIDs pass;
// anything with "..", slashes, etc. is rejected before it gets near the filesystem.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidId(id) {
    return typeof id === "string" && ID_RE.test(id);
}

async function writeJsonAtomic(file, data) {
    // Write to a temp file, then rename: readers never see a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data));
    await fs.promises.rename(tmp, file);
}

async function readJson(file) {
    try {
        return JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
    }
}

const gameFile = (id) => path.join(GAMES_DIR, `${id}.json`);
const reviewFile = (id) => path.join(REVIEWS_DIR, `${id}.json`);

module.exports = {
    DATA_DIR,
    isValidId,
    saveGame: (game) => writeJsonAtomic(gameFile(game.id), game),
    loadGame: (id) => (isValidId(id) ? readJson(gameFile(id)) : Promise.resolve(null)),
    saveReview: (review) => writeJsonAtomic(reviewFile(review.gameId), review),
    loadReview: (id) => (isValidId(id) ? readJson(reviewFile(id)) : Promise.resolve(null))
};
