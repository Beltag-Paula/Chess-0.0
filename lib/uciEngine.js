"use strict";

/**
 * Thin wrapper around a Stockfish (UCI) child process.
 *
 * Why a class instead of the old sendCommand/waitForResponse pair:
 *  - stdout is read line-by-line (readline), so a chunk that contains several
 *    lines, or half a line, can never make us miss "bestmove".
 *  - analysis needs every "info ... pv ..." line, not just the last one.
 *  - if the process dies, every pending wait rejects immediately instead of
 *    sitting there until its timeout.
 */

const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");

const DEFAULT_ENGINE_PATH =
    process.env.STOCKFISH_PATH || path.join(__dirname, "..", "engine", "stockfish-bin");

/** Parse one "info ..." line. Returns null for lines we don't care about. */
function parseInfo(line) {
    if (!line.startsWith("info ") || line.startsWith("info string")) return null;
    if (!line.includes(" pv ")) return null;

    const t = line.split(/\s+/);
    let depth = 0;
    let multipv = 1;
    let score = null;
    let isBound = false;
    let pv = [];

    for (let i = 1; i < t.length; i++) {
        switch (t[i]) {
            case "depth":
                depth = Number(t[++i]);
                break;
            case "multipv":
                multipv = Number(t[++i]);
                break;
            case "score": {
                const type = t[++i]; // "cp" | "mate"
                const value = Number(t[++i]);
                score = { type, value };
                break;
            }
            case "lowerbound":
            case "upperbound":
                isBound = true;
                break;
            case "pv":
                pv = t.slice(i + 1);
                i = t.length;
                break;
        }
    }

    // Bound scores aren't exact evaluations, so we skip them and keep the last exact one.
    if (!score || isBound || pv.length === 0) return null;
    return { depth, multipv, score, pv };
}

class UciEngine {
    constructor(proc) {
        this.proc = proc;
        this.dead = false;
        this.name = "Stockfish";
        this.options = {}; // name -> { type, default, min, max }
        this.listeners = new Set();
        this.pending = new Set();

        proc.stdin.on("error", () => {}); // EPIPE when the process is already gone
        proc.on("error", (err) => this._die(err));
        proc.on("exit", () => this._die(new Error("Engine process exited")));

        this.rl = readline.createInterface({ input: proc.stdout });
        this.rl.on("line", (line) => {
            const trimmed = line.trim();
            for (const listener of [...this.listeners]) listener(trimmed);
        });
    }

    static async start(enginePath = DEFAULT_ENGINE_PATH) {
        const proc = spawn(enginePath, [], { stdio: ["pipe", "pipe", "ignore"] });
        const engine = new UciEngine(proc);

        await engine._roundtrip(
            "uci",
            (l) => l === "uciok",
            10000,
            (l) => engine._parseUciLine(l)
        );
        return engine;
    }

    _parseUciLine(line) {
        if (line.startsWith("id name ")) this.name = line.slice(8);
        const m = line.match(
            /^option name (.+?) type (\w+)(?: default (\S*))?(?: min (-?\d+))?(?: max (-?\d+))?/
        );
        if (m) {
            this.options[m[1]] = {
                type: m[2],
                default: m[3],
                min: m[4] !== undefined ? Number(m[4]) : undefined,
                max: m[5] !== undefined ? Number(m[5]) : undefined
            };
        }
    }

    _die(err) {
        if (this.dead) return;
        this.dead = true;
        for (const p of [...this.pending]) p.reject(err);
        this.pending.clear();
        this.listeners.clear();
    }

    send(cmd) {
        if (this.dead) return;
        this.proc.stdin.write(cmd + "\n");
    }

    /** Resolves with the first line for which predicate(line) is true. */
    _waitFor(predicate, timeoutMs, onLine) {
        return new Promise((resolve, reject) => {
            if (this.dead) return reject(new Error("Engine is not running"));

            const entry = {};
            const cleanup = () => {
                clearTimeout(timer);
                this.listeners.delete(listener);
                this.pending.delete(entry);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("Engine response timeout"));
            }, timeoutMs);

            const listener = (line) => {
                if (onLine) onLine(line);
                if (predicate(line)) {
                    cleanup();
                    resolve(line);
                }
            };
            entry.reject = (err) => {
                cleanup();
                reject(err);
            };

            this.pending.add(entry);
            this.listeners.add(listener);
        });
    }

    /** Register the listener FIRST, then send, so a fast reply can't slip past us. */
    _roundtrip(cmd, predicate, timeoutMs, onLine) {
        const waiting = this._waitFor(predicate, timeoutMs, onLine);
        this.send(cmd);
        return waiting;
    }

    async ready() {
        await this._roundtrip("isready", (l) => l === "readyok", 10000);
    }

    setOption(name, value) {
        this.send(`setoption name ${name} value ${value}`);
    }

    /**
     * Limit playing strength. Stockfish ignores values outside its UCI_Elo range
     * (18.x: 1320-3190), so we clamp and return the Elo it will really play at.
     */
    async setElo(elo) {
        const opt = this.options.UCI_Elo || {};
        const min = opt.min ?? 1320;
        const max = opt.max ?? 3190;
        const effective = Math.max(min, Math.min(max, Math.round(elo)));

        this.setOption("UCI_LimitStrength", "true");
        this.setOption("UCI_Elo", effective);
        await this.ready();
        return effective;
    }

    async setFullStrength() {
        this.setOption("UCI_LimitStrength", "false");
        await this.ready();
    }

    async newGame() {
        this.send("ucinewgame");
        await this.ready();
    }

    /** Best move (UCI notation like "e2e4") for the bot to play, or null if none. */
    async bestMove(fen, { movetime = 800 } = {}) {
        this.setOption("MultiPV", 1);
        this.send(`position fen ${fen}`);
        const line = await this._roundtrip(`go movetime ${movetime}`, (l) => l.startsWith("bestmove"), movetime + 10000);
        const move = line.split(" ")[1];
        return !move || move === "(none)" ? null : move;
    }

    /**
     * Analyse a position. Returns the best `multipv` lines, scores from the
     * point of view of the side to move.
     *   [{ multipv, depth, score: {type:'cp'|'mate', value}, pv: ['e2e4', ...] }, ...]
     */
    async analyse(fen, { depth = 13, movetime = 2500, multipv = 2 } = {}) {
        this.setOption("MultiPV", multipv);
        this.send(`position fen ${fen}`);

        const lines = new Map();
        const onLine = (l) => {
            const info = parseInfo(l);
            if (info) lines.set(info.multipv, info);
        };

        // depth + movetime together: Stockfish stops at whichever limit hits first.
        await this._roundtrip(
            `go depth ${depth} movetime ${movetime}`,
            (l) => l.startsWith("bestmove"),
            movetime + 10000,
            onLine
        );

        return [...lines.values()].sort((a, b) => a.multipv - b.multipv);
    }

    kill() {
        if (this.dead) return;
        try {
            this.proc.stdin.write("quit\n");
        } catch (_) {}
        this._die(new Error("Engine was shut down"));
        this.proc.kill();
    }
}

module.exports = { UciEngine, parseInfo };
