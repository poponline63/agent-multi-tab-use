// Agent Multi Tab Use companion app. One process that:
// 1. Serves the agent API on 127.0.0.1:9223 (claim ports, tab groups, /take...).
//    Requests are forwarded to the extension, which owns the settings.
// 2. Runs a relay on every configured port (the extension can only dial out,
//    so something outside Chrome must listen for agents).
// 3. Flags ports another app already uses so they are never handed out.
// 4. Shows a tray icon (tray/tray.cs, embedded in the exe).
// Build: bun run build   ->   dist/AgentMultiTabUse.exe (no console window)
import { existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isLocalOrigin, startRelayServer } from "./relay/server.ts";
import trayExe from "./tray/tray.exe" with { type: "file" };

const VERSION = "1.4.0";
const HUB_PORT = Number(process.env.AMTU_HUB_PORT || 9223);
const SCAN_FROM = Number(process.env.AMTU_SCAN_FROM || 9224);
const SCAN_COUNT = 300;
const RUN_RELAYS = process.env.AMTU_NO_RELAYS !== "1";
const RPC_TIMEOUT_MS = 10000;
const READY_TIMEOUT_MS = Number(process.env.AMTU_READY_MS || 20000);
const IS_EXE = basename(process.execPath).toLowerCase() === "agentmultitabuse.exe";
const HUB = `http://127.0.0.1:${HUB_PORT}`;

if (process.argv.includes("--quit")) {
	await fetch(`${HUB}/quit`, { method: "POST" }).catch(() => {});
	process.exit(0);
}

let ext = null;
let nextId = 1;
let token = "";
let extVersion = null;
const pending = new Map();
const relays = new Map();
const foreign = new Set();

class NotConnected extends Error {}

// Chrome's service worker reconnects on its own after sleeping or a Chrome
// restart, so wait a bit before telling the agent anything is wrong.
async function waitForExt(ms = Number(process.env.AMTU_EXT_WAIT_MS || 15000)) {
	const until = Date.now() + ms;
	while (!ext && Date.now() < until) await Bun.sleep(250);
	return !!ext;
}

async function askExt(op, args = {}) {
	if (!ext && !(await waitForExt()))
		throw new NotConnected(
			"Chrome isn't connected right now. Retry in a few seconds. If it keeps failing: open Chrome, and check the Agent Multi Tab Use extension is enabled.",
		);
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

// "relay" = a relay (answers 426/401 on /ext), "foreign" = another app, "free" = nothing listening.
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
	const ports = Array.from({ length: SCAN_COUNT }, (_, i) => SCAN_FROM + i);
	const kinds = await Promise.all(ports.map(portKind));
	foreign.clear();
	ports.forEach((port, i) => kinds[i] === "foreign" && foreign.add(port));
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
	// "relay" here means an older standalone relay still owns the port; leave it.
	if (kind !== "free" || relays.has(port)) return;
	try {
		relays.set(port, startRelayServer({ port, token: token || undefined, group: true }));
	} catch {
		foreign.add(port);
		pushForeign();
	}
}

async function syncRelays(ports, nextToken = "") {
	if (nextToken !== token) {
		token = nextToken;
		for (const server of relays.values()) server.stop();
		relays.clear();
	}
	for (const [port, server] of relays) {
		if (!ports.includes(port)) {
			server.stop();
			relays.delete(port);
		}
	}
	await Promise.all(ports.map(ensureRelay));
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

// Registers the exe to start at login (HKCU, no admin). Skipped when run from source.
function registerAutostart() {
	if (!IS_EXE || process.argv.includes("--no-autostart")) return;
	Bun.spawn(
		["reg", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Agent Multi Tab Use", "/d", `"${process.execPath}"`, "/f"],
		{ windowsHide: true, stdout: "ignore", stderr: "ignore" },
	);
}

// Runs before Bun.serve on purpose: Bun.spawn children inherit open sockets on
// Windows, and a tray holding :9223 would block the next start. The tray is
// single-instance and exits with this process.
async function startTray() {
	if (!IS_EXE || process.argv.includes("--no-tray")) return;
	const bytes = await Bun.file(trayExe).arrayBuffer();
	const dir = join(process.env.LOCALAPPDATA || tmpdir(), "Agent Multi Tab Use");
	const path = join(dir, `tray-${Bun.hash(bytes).toString(36)}.exe`);
	if (!existsSync(path)) {
		mkdirSync(dir, { recursive: true });
		await Bun.write(path, bytes);
	}
	Bun.spawn([path, process.execPath, String(process.pid), HUB], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
}

const HELP = {
	name: "Agent Multi Tab Use",
	version: VERSION,
	endpoints: {
		"GET /status": "all ports, their tab group, which agent holds them, whether they are live, and ports other apps use",
		"POST /claim": '{"agent":"hermes","group":"Hermes Tab Group","count":1} -> your own port(s) + CDP URL. Claiming again with the same agent name returns the same ports. Missing ports are created automatically (up to 250). Optional: "color", "port" for a specific one, "parent":"Hermes" to make/join a sub group titled "Hermes › <group>"',
		"POST /release": '{"agent":"hermes","port":9224} -> give a port back when you are done ("ports":[...] for several, "all":true for every port this agent holds). Your tabs stay open unless the user turned on "closeTabsOnRelease" (see GET /status); "closeTabs":true or "keepTabs":true overrides it when the user asks. Adopted tabs always go back to the user open.',
		"POST /take": '{"agent":"hermes","from":"Claude","to":"Hermes Tab Group","count":2} -> pull idle ports out of another group. First call returns a confirmation message: ASK THE USER, then repeat with "confirm":"<token>"',
		"POST /group": '{"name":"Hermes Tab Group","color":"yellow"} -> create or recolor a tab group ("ports":[...] to move ungrouped ports in)',
		"POST /group/delete": '{"name":"Hermes Tab Group"} -> delete a group and its sub groups (ports stay). A sub group can be named in full ("Hermes › Research") or by its short name ("Research", add "parent" if several match)',
		"POST /adopt": '{"agent":"hermes","port":9236,"targetId":"4CD57B02A6B1B8D201AB0080C552A9F1"} -> take over a tab the user opened (needs shareTabs on); it moves into your tab group and other agents can no longer see it. Ids come from GET http://127.0.0.1:<port>/json/list. Release gives it back.',
		"POST /settings": '{"closeTabsOnRelease":true|false} -> whether release closes the tabs an agent opened, by default (applies at once). {"shareTabs":false} -> agents only see tabs they opened (applies at once). {"shareTabs":true} lets agents see the user\'s own tabs: ONLY when the user asks; it returns a confirmation message to show them, then repeat with "confirm":"<token>"',
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
			...(mismatch ? { warning: `The Chrome extension (${extVersion}) and companion app (${VERSION}) versions differ. Ask the user to refresh the extension in chrome://extensions (or update whichever is older).` } : {}),
			chromeConnected: connected,
			...base,
			usedByOtherApps: [...foreign],
		};
	},
	"POST /claim": async (body) => {
		const result = await askExt("claim", { ...body, avoid: await scanForeign() });
		const list = result.claimed ?? [result];
		const ready = await startPorts(list.map((c) => c.port));
		if (!result.claimed) return { ...result, ready: ready[result.port] };
		return { ...result, claimed: list.map((c) => ({ ...c, ready: ready[c.port] })) };
	},
	"POST /release": async (body) => {
		const result = await askExt("release", body);
		for (const port of result.released) relays.get(port)?.bridge.releaseLaneClaims();
		return result;
	},
	"POST /take": async (body) => {
		const result = await askExt("take", body);
		if (result.moved) await startPorts(result.moved);
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
		setTimeout(() => process.exit(0), 100);
		return { quitting: true };
	},
};

await startTray().catch(() => {});

try {
	Bun.serve({
		hostname: "127.0.0.1",
		port: HUB_PORT,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const origin = req.headers.get("origin");
			if (url.pathname === "/ext") {
				if (!origin?.startsWith("chrome-extension://")) return new Response("Forbidden", { status: 403 });
				return srv.upgrade(req) ? undefined : new Response("websocket upgrade required", { status: 426 });
			}
			// Web pages send their own Origin; local agents send none or this app's own address.
			if (!isLocalOrigin(origin, HUB_PORT)) return Response.json({ error: "Forbidden: web pages can't use this API." }, { status: 403 });
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
			open(ws) {
				ext = ws;
				ws.send(JSON.stringify({ t: "hello", app: "Agent Multi Tab Use", version: VERSION }));
				scanForeign();
			},
			message(ws, raw) {
				let msg;
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (msg.t === "ports") {
					if (typeof msg.extVersion === "string") extVersion = msg.extVersion;
					syncRelays(msg.ports, typeof msg.token === "string" ? msg.token : "");
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
				if (ext === ws) ext = null;
			},
		},
	});
} catch {
	// Port 9223 taken: the app is already running. One instance is enough.
	process.exit(0);
}

registerAutostart();
console.log(`Agent Multi Tab Use ${VERSION} on ${HUB}`);
