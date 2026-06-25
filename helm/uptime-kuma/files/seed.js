"use strict";

/*
 * Headless monitor seeder for Uptime Kuma.
 *
 * Runs as a Kubernetes Job using the SAME Uptime Kuma image, so it reuses the
 * bundled socket.io-client (version-matched to the server) and talks to the
 * native Socket.io API. It will:
 *   1. create the first admin user if the instance is brand new ("setup"),
 *   2. log in,
 *   3. create every monitor in /seed/monitors.json that does not already exist
 *      (idempotent: existing monitors are matched by "name" and skipped).
 *
 * Env:
 *   KUMA_URL                  e.g. http://my-release-uptime-kuma:3001
 *   KUMA_USERNAME             admin username to create / log in with
 *   KUMA_PASSWORD             admin password
 *   KUMA_CONNECT_RETRIES      how many times to retry the initial connect
 *   KUMA_CONNECT_RETRY_DELAY  seconds between connect attempts
 *   NODE_PATH=/app/node_modules  so require("socket.io-client") resolves
 */

const { io } = require("socket.io-client");
const fs = require("fs");

const URL = process.env.KUMA_URL || "http://localhost:3001";
const USERNAME = process.env.KUMA_USERNAME;
const PASSWORD = process.env.KUMA_PASSWORD;
const RETRIES = parseInt(process.env.KUMA_CONNECT_RETRIES || "60", 10);
const RETRY_DELAY = parseInt(process.env.KUMA_CONNECT_RETRY_DELAY || "5", 10) * 1000;

// Mirrors the dashboard's "Add Monitor" defaults (src/pages/EditMonitor.vue).
// The server's "add" handler requires accepted_statuscodes to be an array for
// every monitor type, so it is always provided here.
const MONITOR_DEFAULTS = {
    type: "http",
    name: "",
    parent: null,
    url: "https://",
    method: "GET",
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    maxretries: 0,
    retryOnlyOnStatusCodeFailure: false,
    notificationIDList: {},
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: false,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    saveResponse: false,
    saveErrorResponse: true,
    responseMaxLength: 1024,
    dns_resolve_type: "A",
    dns_resolve_server: "",
    proxyId: null,
    conditions: [],
    active: true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Emit an event and resolve with the server's ack (rejects when ack.ok === false). */
function emit(socket, event, ...args) {
    return new Promise((resolve, reject) => {
        socket.emit(event, ...args, (res) => {
            if (res && res.ok === false) {
                reject(new Error(res.msg || `${event} failed`));
            } else {
                resolve(res);
            }
        });
    });
}

/** Connect once; rejects on connect_error. */
function connectOnce() {
    return new Promise((resolve, reject) => {
        const socket = io(URL, {
            transports: ["websocket"],
            reconnection: false,
            timeout: 10000,
        });
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (e) => {
            socket.close();
            reject(e);
        });
    });
}

async function main() {
    if (!USERNAME || !PASSWORD) {
        throw new Error("KUMA_USERNAME and KUMA_PASSWORD must be set");
    }

    const desired = JSON.parse(fs.readFileSync("/seed/monitors.json", "utf8"));
    if (!Array.isArray(desired)) {
        throw new Error("/seed/monitors.json must contain a JSON array");
    }

    // 1. Connect, retrying until the Uptime Kuma pod is reachable.
    let socket;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            socket = await connectOnce();
            break;
        } catch (e) {
            console.log(`[seed] connect ${attempt}/${RETRIES} failed (${e.message}); retrying in ${RETRY_DELAY / 1000}s`);
            if (attempt === RETRIES) {
                throw new Error(`could not connect to ${URL} after ${RETRIES} attempts`);
            }
            await sleep(RETRY_DELAY);
        }
    }
    console.log(`[seed] connected to ${URL}`);

    // The server pushes the current monitors via a "monitorList" event after login.
    let existingNames = null;
    socket.on("monitorList", (list) => {
        existingNames = new Set(Object.values(list || {}).map((m) => m.name));
    });

    // 2. First-run setup (creates the admin) only if the instance is brand new.
    const needSetup = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("needSetup timed out")), 15000);
        socket.emit("needSetup", (res) => {
            clearTimeout(t);
            resolve(res);
        });
    });
    if (needSetup) {
        console.log("[seed] fresh instance -> creating admin user");
        await emit(socket, "setup", USERNAME, PASSWORD);
    }

    // 3. Log in. (emit() rejects on {ok:false}, e.g. wrong password. A 2FA-enabled
    // account instead returns {tokenRequired:true}, which we surface clearly.)
    const login = await emit(socket, "login", { username: USERNAME, password: PASSWORD, token: "" });
    if (login && login.tokenRequired) {
        throw new Error("admin account has 2FA enabled; headless seeding is not supported (disable 2FA, or seed before enabling it)");
    }
    if (!login || login.ok !== true) {
        throw new Error(`login failed: ${(login && login.msg) || "unexpected response"}`);
    }
    console.log(`[seed] logged in as ${USERNAME}`);

    // 4. Briefly wait for the pushed monitor list so we can skip existing ones.
    const waitStart = Date.now();
    while (existingNames === null && Date.now() - waitStart < 10000) {
        await sleep(250);
    }
    if (existingNames === null) {
        existingNames = new Set();
    }
    console.log(`[seed] ${existingNames.size} monitor(s) already present`);

    // 5. Create the monitors that are missing.
    let created = 0;
    let skipped = 0;
    for (const m of desired) {
        if (!m || !m.name) {
            console.log("[seed] skipping an entry with no 'name'");
            continue;
        }
        if (existingNames.has(m.name)) {
            skipped++;
            continue;
        }
        const payload = { ...MONITOR_DEFAULTS, ...m };
        const res = await emit(socket, "add", payload);
        created++;
        console.log(`[seed] created "${m.name}" (id=${res && res.monitorID})`);
    }

    console.log(`[seed] done. created=${created} skipped=${skipped}`);
    socket.close();
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(`[seed] ERROR: ${e.message}`);
        process.exit(1);
    });
