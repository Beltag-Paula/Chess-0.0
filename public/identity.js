/**
 * Who is playing? There are no accounts yet, so identity is two values kept in
 * localStorage: a display name and a random anonymous id. The id is what lets
 * you group one person's games together later (for personal training data).
 * It is NOT authentication: anyone can edit their own localStorage.
 */
(function (global) {
    "use strict";

    const NAME_KEY = "pixel-chess-player-name";
    const ID_KEY = "pixel-chess-player-id";

    function randomId() {
        if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
        // randomUUID only exists on https/localhost; fall back to getRandomValues
        const bytes = global.crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function read(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null; // storage blocked (private mode etc.)
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (_) {}
    }

    global.ChessIdentity = {
        get: function () {
            let playerId = read(ID_KEY);
            if (!playerId) {
                playerId = randomId();
                write(ID_KEY, playerId);
            }
            return { name: (read(NAME_KEY) || "").trim(), playerId: playerId };
        },
        setName: function (name) {
            write(NAME_KEY, String(name || "").trim().slice(0, 20));
        }
    };
})(window);
