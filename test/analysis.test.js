"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const A = require("../lib/analysis");
const { parseInfo } = require("../lib/uciEngine");

test("win% is symmetric and bounded", () => {
    assert.ok(Math.abs(A.cpToWin(0) - 50) < 1e-9);
    assert.ok(Math.abs(A.cpToWin(300) + A.cpToWin(-300) - 100) < 1e-9);
    assert.strictEqual(A.evalToWin({ type: "mate", value: 3 }), 100);
    assert.strictEqual(A.evalToWin({ type: "mate", value: 0 }), 0); // side to move is mated
    assert.strictEqual(A.evalToCp({ type: "cp", value: 5000 }), A.CP_CAP);
});

test("accuracy: 100 for a perfect move, falls with loss", () => {
    assert.ok(A.accuracyFromLoss(0) > 99.9);
    assert.ok(A.accuracyFromLoss(10) < A.accuracyFromLoss(2));
    assert.ok(A.accuracyFromLoss(100) >= 0);
});

test("classification ladder", () => {
    const c = (loss, extra = {}) => A.classifyMove({ engineTop: false, loss, gap: 5, prevOpponentLoss: 0, ...extra });
    assert.strictEqual(c(0.1), "best");
    assert.strictEqual(c(1), "excellent");
    assert.strictEqual(c(4), "good");
    assert.strictEqual(c(8), "inaccuracy");
    assert.strictEqual(c(15), "mistake");
    assert.strictEqual(c(30), "blunder");
    assert.strictEqual(c(15, { prevOpponentLoss: 25 }), "miss"); // opponent slipped, we didn't punish
    assert.strictEqual(c(30, { prevOpponentLoss: 25 }), "blunder");
    assert.strictEqual(A.classifyMove({ engineTop: true, loss: 0, gap: 20, prevOpponentLoss: 0 }), "great");
    assert.strictEqual(A.classifyMove({ engineTop: true, loss: 0, gap: 3, prevOpponentLoss: 0 }), "best");
    assert.strictEqual(A.classifyMove({ engineTop: true, loss: 0, gap: null, prevOpponentLoss: 0 }), "best"); // forced
});

test("rating estimate needs enough moves", () => {
    assert.strictEqual(A.estimateGameRating(30, 3), null);
    assert.strictEqual(A.estimateGameRating(null, 30), null);
    assert.ok(A.estimateGameRating(30, 30) > A.estimateGameRating(80, 30));
});

test("grades and game accuracy", () => {
    assert.strictEqual(A.gradeFromAccuracy(null), null);
    assert.strictEqual(A.gradeFromAccuracy(97), "best");
    assert.strictEqual(A.gradeFromAccuracy(30), "blunder");
    assert.strictEqual(A.gameAccuracy([]), null);
    const acc = A.gameAccuracy([
        { accuracy: 100, weight: 1 },
        { accuracy: 50, weight: 1 }
    ]);
    assert.ok(acc > 50 && acc < 100);
});

test("UCI info parsing ignores bounds and strings", () => {
    assert.strictEqual(parseInfo("info string NNUE evaluation"), null);
    assert.strictEqual(parseInfo("info depth 5 multipv 1 score cp 20 lowerbound pv e2e4"), null);
    const l = parseInfo("info depth 12 seldepth 25 multipv 2 score mate -3 nodes 5 pv d8h4 g2g3");
    assert.deepStrictEqual(l, { depth: 12, multipv: 2, score: { type: "mate", value: -3 }, pv: ["d8h4", "g2g3"] });
});
