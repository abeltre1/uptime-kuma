"use strict";

/*
 * Headless seeder for Uptime Kuma (monitors + status pages).
 *
 * Runs as a Kubernetes Job using the SAME Uptime Kuma image, so it reuses the
 * bundled socket.io-client (version-matched to the server) and talks to the
 * native Socket.io API. It will:
 *   1. create the first admin user if the instance is brand new ("setup"),
 *   2. log in,
 *   3. create every monitor in /seed/monitors.json that does not already exist
 *      (idempotent: existing monitors are matched by "name" and skipped),
 *   4. create/update every status page in /seed/status-pages.json (the
 *      /status/<slug> pages), wiring their groups to monitors by name.
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

// The "config" object the server's saveStatusPage handler expects. domainNameList
// must be an array (it is iterated), and analyticsType must be null or a known type.
const STATUS_PAGE_CONFIG_DEFAULTS = {
    description: "",
    theme: "auto",
    autoRefreshInterval: 300,
    showTags: false,
    footerText: "",
    customCSS: "",
    showPoweredBy: true,
    rssTitle: "",
    showOnlyLastHeartbeat: false,
    showCertificateExpiry: false,
    analyticsId: "",
    analyticsScriptUrl: "",
    analyticsType: null,
    domainNameList: [],
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

function readJsonArray(path) {
    if (!fs.existsSync(path)) {
        return [];
    }
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) {
        throw new Error(`${path} must contain a JSON array`);
    }
    return parsed;
}

async function seedMonitors(socket, desired, monitorIdByName) {
    let created = 0;
    let skipped = 0;
    for (const m of desired) {
        if (!m || !m.name) {
            console.log("[seed] skipping a monitor entry with no 'name'");
            continue;
        }
        if (monitorIdByName[m.name] != null) {
            skipped++;
            continue;
        }
        const payload = { ...MONITOR_DEFAULTS, ...m };
        const res = await emit(socket, "add", payload);
        monitorIdByName[m.name] = res && res.monitorID;
        created++;
        console.log(`[seed] created monitor "${m.name}" (id=${res && res.monitorID})`);
    }
    console.log(`[seed] monitors: created=${created} skipped=${skipped}`);
}

async function seedStatusPages(socket, pages, monitorIdByName) {
    let created = 0;
    let updated = 0;
    for (const sp of pages) {
        if (!sp || !sp.slug || !sp.title) {
            console.log("[seed] skipping a status page entry without 'slug' and 'title'");
            continue;
        }
        const slug = String(sp.slug).toLowerCase();

        // Resolve each group's monitor names to ids (skip unknown names with a warning).
        const publicGroupList = (sp.groups || []).map((g, gi) => ({
            name: g.name || `Group ${gi + 1}`,
            weight: gi + 1,
            monitorList: (g.monitors || [])
                .map((name) => {
                    const id = monitorIdByName[name];
                    if (id == null) {
                        console.log(`[seed] WARN status page "${slug}": unknown monitor "${name}" (skipped)`);
                        return null;
                    }
                    return { id };
                })
                .filter(Boolean),
        }));

        const config = {
            ...STATUS_PAGE_CONFIG_DEFAULTS,
            slug,
            title: sp.title,
            description: sp.description ?? STATUS_PAGE_CONFIG_DEFAULTS.description,
            theme: sp.theme ?? STATUS_PAGE_CONFIG_DEFAULTS.theme,
            autoRefreshInterval: sp.autoRefreshInterval ?? STATUS_PAGE_CONFIG_DEFAULTS.autoRefreshInterval,
            showTags: sp.showTags ?? STATUS_PAGE_CONFIG_DEFAULTS.showTags,
            footerText: sp.footerText ?? STATUS_PAGE_CONFIG_DEFAULTS.footerText,
            customCSS: sp.customCSS ?? STATUS_PAGE_CONFIG_DEFAULTS.customCSS,
            showPoweredBy: sp.showPoweredBy ?? STATUS_PAGE_CONFIG_DEFAULTS.showPoweredBy,
            showOnlyLastHeartbeat: sp.showOnlyLastHeartbeat ?? STATUS_PAGE_CONFIG_DEFAULTS.showOnlyLastHeartbeat,
            showCertificateExpiry: sp.showCertificateExpiry ?? STATUS_PAGE_CONFIG_DEFAULTS.showCertificateExpiry,
        };

        // Idempotent: getStatusPage throws "No slug?" when the page does not exist.
        let exists = false;
        try {
            await emit(socket, "getStatusPage", slug);
            exists = true;
        } catch (e) {
            exists = false;
        }
        if (!exists) {
            await emit(socket, "addStatusPage", sp.title, slug);
        }
        // imgDataUrl = "" -> no custom logo (keeps the default icon).
        await emit(socket, "saveStatusPage", slug, config, "", publicGroupList);

        const monitorCount = publicGroupList.reduce((n, g) => n + g.monitorList.length, 0);
        if (exists) {
            updated++;
        } else {
            created++;
        }
        console.log(
            `[seed] status page "${slug}" ${exists ? "updated" : "created"} ` +
                `(${publicGroupList.length} group(s), ${monitorCount} monitor(s)) -> /status/${slug}`
        );
    }
    console.log(`[seed] status pages: created=${created} updated=${updated}`);
}

async function main() {
    if (!USERNAME || !PASSWORD) {
        throw new Error("KUMA_USERNAME and KUMA_PASSWORD must be set");
    }

    const desiredMonitors = readJsonArray("/seed/monitors.json");
    const desiredStatusPages = readJsonArray("/seed/status-pages.json");

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

    // The server pushes the current monitors via "monitorList" after login.
    // Keep a name -> id map so we can both skip existing monitors and wire them
    // into status page groups.
    const monitorIdByName = {};
    let gotList = false;
    socket.on("monitorList", (list) => {
        if (list) {
            for (const [id, m] of Object.entries(list)) {
                if (m && m.name) {
                    monitorIdByName[m.name] = m.id != null ? m.id : Number(id);
                }
            }
            gotList = true;
        }
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

    // 4. Briefly wait for the pushed monitor list so we can skip/resolve existing ones.
    const waitStart = Date.now();
    while (!gotList && Date.now() - waitStart < 10000) {
        await sleep(250);
    }
    console.log(`[seed] ${Object.keys(monitorIdByName).length} monitor(s) already present`);

    // 5. Create monitors, then 6. create/update status pages.
    await seedMonitors(socket, desiredMonitors, monitorIdByName);
    if (desiredStatusPages.length) {
        await seedStatusPages(socket, desiredStatusPages, monitorIdByName);
    }

    console.log("[seed] done.");
    socket.close();
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((e) => {
            console.error(`[seed] ERROR: ${e.message}`);
            process.exit(1);
        });
}

module.exports = { seedMonitors, seedStatusPages, MONITOR_DEFAULTS, STATUS_PAGE_CONFIG_DEFAULTS };
