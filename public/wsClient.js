/**
 * GameSocket - a tiny wrapper around the browser's native WebSocket.
 *
 * Socket.io gave us three things for free that a bare WebSocket does not:
 *   1. named events         -> we send JSON  { type, data }  and dispatch on `type`
 *   2. automatic reconnect  -> exponential backoff below
 *   3. buffering while offline -> we deliberately DON'T; send() returns false instead,
 *      because replaying a stale move after a reconnect could corrupt the game.
 *
 * Usage:
 *   const socket = new GameSocket();
 *   socket.onOpen(({ reconnect }) => socket.send("chooseColor", {...}));
 *   socket.onClose(() => showOffline());
 *   socket.on("playerBoardState", (fen) => ...);
 *   if (!socket.send("playerMove", move)) undoTheMove();
 */
(function (global) {
    "use strict";

    function GameSocket(path) {
        this.path = path || "/ws";
        this.handlers = new Map(); // type -> [fn]
        this.openHandlers = [];
        this.closeHandlers = [];
        this.attempt = 0;
        this.hasConnectedBefore = false;
        this.ws = null;
        this._connect();
    }

    GameSocket.prototype._url = function () {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        return scheme + "://" + location.host + this.path;
    };

    GameSocket.prototype._connect = function () {
        const ws = new WebSocket(this._url());
        this.ws = ws;

        ws.onopen = () => {
            const reconnect = this.hasConnectedBefore;
            this.hasConnectedBefore = true;
            this.attempt = 0;
            this.openHandlers.forEach((fn) => fn({ reconnect }));
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            const list = this.handlers.get(msg && msg.type);
            if (list) list.forEach((fn) => fn(msg.data));
        };

        ws.onclose = () => {
            this.closeHandlers.forEach((fn) => fn());
            // 1s, 2s, 4s ... capped at 10s, with jitter so a server restart doesn't get a stampede.
            const delay = Math.min(1000 * 2 ** this.attempt, 10000) + Math.random() * 300;
            this.attempt++;
            setTimeout(() => this._connect(), delay);
        };

        ws.onerror = () => ws.close(); // onclose does the reconnecting
    };

    GameSocket.prototype.on = function (type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type).push(fn);
    };
    GameSocket.prototype.onOpen = function (fn) {
        this.openHandlers.push(fn);
    };
    GameSocket.prototype.onClose = function (fn) {
        this.closeHandlers.push(fn);
    };

    /** Returns true if the message was handed to the network, false if we're offline. */
    GameSocket.prototype.send = function (type, data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify({ type: type, data: data }));
        return true;
    };

    global.GameSocket = GameSocket;
})(window);
