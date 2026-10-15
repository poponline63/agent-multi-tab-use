// Agent Multi Tab Use companion app. One process that:
// 1. Serves the agent API on 127.0.0.1:9223 (claim/release ports, tab groups, status).
//    Requests are forwarded to the extension, which owns the settings.
// 2. Runs a relay on every configured port (the extension can only dial out,
//    so something outside Chrome must listen for agents). The extension reaches
//    all of them over its one websocket to this app ({t:"lane", port, msg}).
// 3. Flags ports another app already uses so they are never handed out.
// 4. Shows a tray icon (tray/tray.cs, embedded in the exe) that restarts the app if it crashes.
// 5. Logs to %LOCALAPPDATA%\Agent Multi Tab Use\hub.log.
// Build: bun run build   ->   dist/AgentMultiTabUse.exe (no console window)
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isLocalHost, isLocalOrigin, startRelayServer } from "./relay/server.ts";
import trayExe from "./tray/tray.exe" with { type: "file" };

const VERSION = "1.6.5";
const HUB_PORT = Number(process.env.AMTU_HUB_PORT || 9223);
const SCAN_FROM = Number(process.env.AMTU_SCAN_FROM || 9224);
const SCAN_COUNT = 300;
const SCAN_CACHE_MS = 60_000;
const RUN_RELAYS = process.env.AMTU_NO_RELAYS !== "1";
const RPC_TIMEOUT_MS = 10000;
const READY_TIMEOUT_MS = Number(process.env.AMTU_READY_MS || 20000);
// A claimed port nobody has used for this long is released for its agent (agents
// often finish without releasing): tidied like a normal release, back in the pool.
const LEASE_IDLE_MS = Number(process.env.AMTU_LEASE_IDLE_MS || 30 * 60 * 1000);
const EXPIRY_CHECK_MS = 5 * 60 * 1000;
const IS_EXE = basename(process.execPath).toLowerCase() === "agentmultitabuse.exe";
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const DATA_DIR = join(process.env.LOCALAPPDATA || tmpdir(), "Agent Multi Tab Use");
const LOG_FILE = process.env.AMTU_LOG_FILE ?? (IS_EXE ? join(DATA_DIR, "hub.log") : "");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const STARTED = Date.now();

if (process.argv.includes("--quit")) {
	await fetch(`${HUB}/quit`, { method: "POST" }).catch(() => {});
	process.exit(0);
}

function log(message, data) {
	if (!LOG_FILE) return;
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.old`);
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`);
	} catch {}
}
process.on("uncaughtException", (err) => log("uncaught exception", { error: String(err?.stack ?? err) }));
process.on("unhandledRejection", (err) => log("unhandled rejection", { error: String(err?.stack ?? err) }));

let ext = null;
let nextId = 1;
let extVersion = null;
let scannedAt = 0;
let relaySync = Promise.resolve();
let reloadAsked = false;
const pending = new Map();
const relays = new Map();
const laneSockets = new Map();
const lastActive = new Map();
const foreign = new Set();

class NotConnected extends Error {}

const NOT_CONNECTED =
	"Chrome isn't connected right now. Retry in a few seconds. If it keeps failing: open Chrome, and check the Agent Multi Tab Use extension is enabled.";

// Chrome's service worker reconnects on its own after sleeping or a Chrome
// restart, so wait a bit before telling the agent anything is wrong.
async function waitForExt(ms = Number(process.env.AMTU_EXT_WAIT_MS || 15000)) {
	const until = Date.now() + ms;
	while (!ext && Date.now() < until) await Bun.sleep(250);
	return !!ext;
}

async function askExt(op, args = {}) {
	if (!ext && !(await waitForExt())) throw new NotConnected(NOT_CONNECTED);
	const id = nextId++;
	ext.send(JSON.stringify({ id, op, args }));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("extension did not answer"));
		}, RPC_TIMEOUT_MS);
		pending.set(id, { resolve, reject, timer });
	});
}

// The bridge's view of the extension for one port: writes go out over the one
// extension socket, tagged with the port. `text` is already JSON.
function laneSocket(port) {
	return { send: (text) => ext?.send(`{"t":"lane","port":${port},"msg":${text}}`), close() {} };
}

function openLane(port) {
	const relay = relays.get(port);
	if (!ext || !relay) return;
	const socket = laneSocket(port);
	laneSockets.set(port, socket);
	relay.bridge.extConnected(socket);
	ext.send(JSON.stringify({ t: "laneOpen", port }));
}

function closeLanes() {
	for (const [port, socket] of laneSockets) relays.get(port)?.bridge.extClosed(socket);
	laneSockets.clear();
}

// "relay" = one of ours (answers 426/401 on /ext), "foreign" = another app, "free" = nothing listening.
// Raw socket on purpose: Bun's fetch() to a real Chrome's debug port (e.g. an
// agent's private Chrome) crashes the process a few seconds later (Bun 1.3.14).
function portKind(port) {
	if (relays.has(port)) return Promise.resolve("relay");
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let connected = false;
		const done = (kind) => {
			socket.destroy();
			resolve(kind);
		};
		socket.setTimeout(1500, () => done("foreign"));
		socket.once("connect", () => {
			connected = true;
			socket.write(`GET /ext HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
		});
		socket.once("data", (chunk) => done(/^HTTP\/1\.[01] (426|401)/.test(String(chunk)) ? "relay" : "foreign"));
		socket.once("error", () => done(connected ? "foreign" : "free"));
		socket.once("end", () => done(connected ? "foreign" : "free"));
	});
}

function pushForeign() {
	ext?.send(JSON.stringify({ t: "foreign", ports: [...foreign] }));
}

async function scanForeign() {
	if (Date.now() - scannedAt < SCAN_CACHE_MS) return [...foreign];
	const ports = Array.from({ length: SCAN_COUNT }, (_, i) => SCAN_FROM + i);
	const kinds = await Promise.all(ports.map(portKind));
	foreign.clear();
	ports.forEach((port, i) => kinds[i] === "foreign" && foreign.add(port));
	scannedAt = Date.now();
	pushForeign();
	return [...foreign];
}

async function ensureRelay(port) {
	if (!RUN_RELAYS || port === HUB_PORT || relays.has(port)) return;
	const kind = await portKind(port);
	if (kind === "foreign") {
		if (!foreign.has(port)) foreign.add(port), pushForeign();
		return;
	}
	if (kind !== "free" || relays.has(port)) return;
	try {
		relays.set(
			port,
			startRelayServer({
				port,
				group: true,
				log: (message, data) => log(`[${port}] ${message}`, data),
				onActivity: () => lastActive.set(port, Date.now()),
			}),
		);
	} catch (err) {
		log("relay failed to start", { port, error: String(err) });
		foreign.add(port);
		pushForeign();
		return;
	}
	openLane(port);
}

// Serialized: a stale port list arriving mid-claim must never stop a relay the
// claim just started. Relays with agents still connected are never stopped.
function syncRelays(ports) {
	relaySync = relaySync.then(async () => {
		for (const [port, server] of relays) {
			if (ports.includes(port) || server.bridge.connections > 0) continue;
			server.stop();
			relays.delete(port);
			laneSockets.delete(port);
		}
		await Promise.all(ports.map(ensureRelay));
	}).catch((err) => log("relay sync failed", { error: String(err) }));
	return relaySync;
}

async function waitReady(port) {
	const until = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < until) {
		if (relays.get(port)?.bridge.ready) return true;
		await Bun.sleep(250);
	}
	return false;
}

async function startPorts(ports) {
	await Promise.all(ports.map(ensureRelay));
	const ready = await Promise.all(ports.map(waitReady));
	return Object.fromEntries(ports.map((port, i) => [port, ready[i]]));
}

function idleMs(port) {
	return relays.get(port)?.bridge.connections ? 0 : Date.now() - (lastActive.get(port) ?? STARTED);
}

// Releases ports no agent has touched for LEASE_IDLE_MS, closing the tabs they
// left behind (unless the user looked at them), so dead agents don't pile up.
async function expireLeases() {
	const idle = (port) => idleMs(port) > LEASE_IDLE_MS;
	const { ports } = await askExt("status");
	const byAgent = new Map();
	for (const p of ports) {
		if (p.agent && idle(p.port)) byAgent.set(p.agent, [...(byAgent.get(p.agent) ?? []), p.port]);
	}
	for (const [agent, list] of byAgent) {
		await askExt("release", { agent, ports: list });
		for (const port of list) relays.get(port)?.bridge.releaseLaneClaims();
		log("expired idle leases", { agent, ports: list });
	}
}

// An unpacked extension keeps running its old code after its files are updated.
// Ask it to reload, once per app run (if the files on disk are still old it comes
// back unchanged and the /status warning remains), and only while no agent is
// connected: a reload forgets which tabs belong to which agent.
function maybeReloadExtension() {
	if (!ext || reloadAsked || !extVersion || extVersion === VERSION) return;
	if ([...relays.values()].some((relay) => relay.bridge.connections > 0)) {
		setTimeout(maybeReloadExtension, 30_000);
		return;
	}
	reloadAsked = true;
	log("asking the extension to reload", { extension: extVersion, app: VERSION });
	ext.send(JSON.stringify({ t: "reload" }));
}

// Registers the exe to start at login (HKCU, no admin). Skipped when run from source.
function registerAutostart() {
	if (!IS_EXE || process.argv.includes("--no-autostart")) return;
	Bun.spawn(
		["reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Agent Multi Tab Use", "/d", `"${process.execPath}"`, "/f"],
		{ windowsHide: true, stdout: "ignore", stderr: "ignore" },
	);
}

// Runs before Bun.serve on purpose: children inherit open sockets on Windows,
// and a tray holding :9223 would block the next start. The tray is
// single-instance and exits when this process quits (restarts it if it crashes).
async function startTray() {
	if (!IS_EXE || process.argv.includes("--no-tray")) return;
	const bytes = await Bun.file(trayExe).arrayBuffer();
	const path = join(DATA_DIR, `tray-${Bun.hash(bytes).toString(36)}.exe`);
	if (!existsSync(path)) {
		mkdirSync(DATA_DIR, { recursive: true });
		await Bun.write(path, bytes);
	}
	// Detached: Bun.spawn children share a kill-on-close job with this process, and
	// the tray must outlive a crash to restart the app.
	spawn(path, [process.execPath, String(process.pid), HUB, LOG_FILE], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
}

const HELP = {
	name: "Agent Multi Tab Use",
	version: VERSION,
	endpoints: {
		"GET /status": "all ports, their tab group, which agent holds them, whether they are live, and ports other apps use",
		"POST /claim": '{"agent":"hermes","group":"Hermes"} -> your own port + CDP URL. "group" is the Chrome tab group your tabs go in (default "Agents"); agents claiming the same group share it. Claiming again with the same agent name returns the same port. Optional: "count" for several ports, "color", "parent":"Hermes" for a sub group titled "Hermes › <group>". Ports idle for 30 minutes are released automatically.',
		"POST /release": '{"agent":"hermes","all":true} -> give your ports back when done ("port" or "ports":[...] for specific ones; "agent" must match). Tabs you opened close, except ones the user has looked at, which are handed back open. "keepTabs":true keeps them all, "closeTabs":true closes them all.',
		"POST /group": '{"name":"Hermes","color":"yellow"} -> set a tab group\'s color',
		"POST /group/delete": '{"name":"Hermes"} -> forget a group\'s color (and its sub groups\')',
		"POST /adopt": '{"agent":"hermes","port":9236,"targetId":"4CD57B02A6B1B8D201AB0080C552A9F1"} -> take over a tab the user opened (needs shareTabs on); it moves into your tab group and other agents can no longer see it. Ids come from GET http://127.0.0.1:<port>/json/list. Release gives it back.',
		"POST /settings": '{"shareTabs":false} -> agents only see tabs they opened (applies at once). {"shareTabs":true} lets agents see the user\'s own tabs: ONLY when the user asks; it returns a confirmation message to show them, then repeat with "confirm":"<token>"',
		"POST /ports": '{"add":5} -> add more ports',
	},
	colors: ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"],
};

const ROUTES = {
	"GET /": async () => HELP,
	"GET /status": async () => {
		const connected = !!ext || (await waitForExt(3000));
		const base = connected ? await askExt("status") : { ports: [], groups: [] };
		// Agents can't see the extension page, so say it here when the two halves are out of step.
		const mismatch = connected && extVersion && extVersion !== VERSION;
		return {
			app: VERSION,
			extension: extVersion,
			...(mismatch ? { warning: `The Chrome extension (${extVersion}) and companion app (${VERSION}) versions differ. Ask the user to update the older one (then click reload on the extension in chrome://extensions).` } : {}),
			...(connected ? {} : { problem: NOT_CONNECTED }),
			chromeConnected: connected,
			...base,
			ports: (base.ports ?? []).map((p) => (p.agent ? { ...p, idleMinutes: Math.floor(idleMs(p.port) / 60000) } : p)),
			usedByOtherApps: [...foreign],
			log: LOG_FILE || null,
		};
	},
	"POST /claim": async (body) => {
		await expireLeases();
		const result = await askExt("claim", { ...body, avoid: await scanForeign() });
		const list = result.claimed ?? [result];
		for (const c of list) lastActive.set(c.port, Date.now());
		const ready = await startPorts(list.map((c) => c.port));
		if (!result.claimed) return { ...result, ready: ready[result.port] };
		return { ...result, claimed: list.map((c) => ({ ...c, ready: ready[c.port] })) };
	},
	"POST /release": async (body) => {
		const result = await askExt("release", body);
		for (const port of result.released) relays.get(port)?.bridge.releaseLaneClaims();
		return result;
	},
	"POST /settings": (body) => askExt("settings", body),
	"POST /adopt": async ({ agent, port, targetId } = {}) => {
		const status = await askExt("status");
		const lane = status.ports.find((p) => p.port === Number(port));
		if (!lane) throw new Error(`no port ${port}`);
		if (!agent || lane.agent !== agent) throw new Error(`claim port ${port} as "${agent}" first; it is held by ${lane.agent ?? "nobody"}`);
		if (!status.shareTabs) throw new Error('the user\'s tabs are private. Only if the user wants you to use their tabs: POST /settings {"shareTabs":true} (they must confirm)');
		const bridge = relays.get(lane.port)?.bridge;
		if (!bridge?.adoptTab(String(targetId))) throw new Error(`no tab ${targetId} on port ${port}; take the "id" from GET http://127.0.0.1:${port}/json/list`);
		return { adopted: String(targetId), port: lane.port, group: lane.group ?? `Port ${lane.port}` };
	},
	"POST /group": (body) => askExt("group", body),
	"POST /group/delete": (body) => askExt("deleteGroup", body),
	"POST /ports": async (body) => {
		const result = await askExt("addPorts", { ...body, avoid: await scanForeign() });
		await Promise.all(result.added.map(ensureRelay));
		return result;
	},
	"POST /quit": async () => {
		log("quit requested");
		setTimeout(() => process.exit(0), 100);
		return { quitting: true };
	},
};

await startTray().catch((err) => log("tray failed to start", { error: String(err) }));

try {
	Bun.serve({
		hostname: "127.0.0.1",
		port: HUB_PORT,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const origin = req.headers.get("origin");
			// Requests must be addressed to this machine by name: blocks DNS rebinding.
			if (!isLocalHost(req.headers.get("host"), HUB_PORT)) return Response.json({ error: `Forbidden: use ${HUB}` }, { status: 403 });
			if (url.pathname === "/ext") {
				if (!origin?.startsWith("chrome-extension://")) return new Response("Forbidden", { status: 403 });
				return srv.upgrade(req, { data: { origin } }) ? undefined : new Response("websocket upgrade required", { status: 426 });
			}
			// Web pages send their own Origin; local agents send none or this app's own address.
			// The connected extension's own pages (its dashboard) may call the API too.
			if (!isLocalOrigin(origin, HUB_PORT) && !(ext && origin === ext.data.origin)) return Response.json({ error: "Forbidden: web pages can't use this API." }, { status: 403 });
			const route = ROUTES[`${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`];
			if (!route) return Response.json({ error: "not found", help: HELP }, { status: 404 });
			try {
				const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
				const result = await route(body);
				return Response.json(result, { status: result?.confirmRequired ? 409 : 200 });
			} catch (err) {
				if (err instanceof NotConnected) return Response.json({ error: err.message, retry: true }, { status: 503, headers: { "Retry-After": "5" } });
				return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
			}
		},
		websocket: {
			idleTimeout: 0,
			// Screenshots travel base64-encoded through this socket.
			maxPayloadLength: 256 * 1024 * 1024,
			open(ws) {
				// One browser at a time: a second Chrome profile (or another extension)
				// can't take over while the first is connected. The same extension
				// reconnecting (worker restart) replaces its old socket.
				if (ext && ext.data.origin !== ws.data.origin) {
					log("refused a second browser connection", { origin: ws.data.origin, connected: ext.data.origin });
					ws.close(4009, "another browser is already connected");
					return;
				}
				if (ext) {
					closeLanes();
					ext.close();
				}
				ext = ws;
				log("extension connected", { origin: ws.data.origin });
				ws.send(JSON.stringify({ t: "hello", app: "Agent Multi Tab Use", version: VERSION }));
				scannedAt = 0;
				scanForeign();
				for (const port of relays.keys()) openLane(port);
			},
			message(ws, raw) {
				if (ws !== ext) return;
				let msg;
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (msg.t === "lane") {
					const socket = laneSockets.get(msg.port);
					if (socket) relays.get(msg.port)?.bridge.extMessage(socket, msg.msg);
					return;
				}
				if (msg.t === "ports") {
					if (typeof msg.extVersion === "string") extVersion = msg.extVersion;
					maybeReloadExtension();
					syncRelays(msg.ports);
					return;
				}
				if (msg.t) return;
				const call = pending.get(msg.id);
				if (!call) return;
				pending.delete(msg.id);
				clearTimeout(call.timer);
				msg.ok ? call.resolve(msg.result) : call.reject(new Error(msg.error));
			},
			close(ws) {
				if (ext !== ws) return;
				ext = null;
				closeLanes();
				for (const call of pending.values()) {
					clearTimeout(call.timer);
					call.reject(new NotConnected(NOT_CONNECTED));
				}
				pending.clear();
				log("extension disconnected");
			},
		},
	});
} catch {
	// Port 9223 taken: the app is already running. One instance is enough.
	process.exit(0);
}

registerAutostart();
setInterval(() => ext && expireLeases().catch((err) => log("lease expiry failed", { error: String(err) })), EXPIRY_CHECK_MS);
log(`Agent Multi Tab Use ${VERSION} started`, { hub: HUB, pid: process.pid });
