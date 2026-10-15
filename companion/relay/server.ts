/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint so the omp browser tool (and
 * any puppeteer client) can connect with a plain `browserURL`:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the extension
 *   is connected, 503 before that (clients like `waitForCdp` keep polling).
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients (puppeteer).
 *
 * The extension side arrives through the companion app's single websocket
 * (see main.js), not through this server.
 *
 * Binds loopback only, and only answers requests addressed to a loopback Host
 * (blocks DNS rebinding): anything that can reach this port can drive the
 * user's logged-in browser.
 */
import { RelayBridge } from "./bridge";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	port: number;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Called whenever an agent connects, sends a command, or disconnects. */
	onActivity?: () => void;
}

/** A running relay server. */
export interface RelayServer {
	bridge: RelayBridge;
	port: number;
	stop(): void;
}

interface SocketData {
	connId?: number;
}

type RelayWebSocket = Bun.ServerWebSocket<SocketData>;

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Default appearance of the omp tab group. */
const DEFAULT_GROUP = { title: "Agent", color: "cyan" } as const;
/** True when `raw` can serve as the authority of a `ws://` URL: no whitespace,
 *  slashes, userinfo, fragments, or control characters, and URL-parseable. */
function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?]|[\x00-\x1f]/.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}

/**
 * No Origin (native client) or a localhost Origin on any port (native clients
 * often send "http://127.0.0.1" or their own address). Refused: any real web
 * site and "null" (sandboxed/file pages), so a web page can't drive the browser.
 */
export function isLocalOrigin(origin: string | null, _port: number): boolean {
	if (!origin) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
	} catch {
		return false;
	}
}

/**
 * True when the request is addressed to this machine's loopback by name or IP.
 * A web page that rebinds its own domain to 127.0.0.1 still sends its domain as
 * Host, so this refuses it even though the socket is local.
 */
export function isLocalHost(host: string | null, port: number): boolean {
	return !!host && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.trim().toLowerCase());
}

/** Start the relay server on 127.0.0.1. Throws if the port is taken. */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const log = opts.log ?? (() => {});
	const activity = opts.onActivity ?? (() => {});
	const group =
		opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group;
	const bridge = new RelayBridge({ log, group });
	const sockets = new Set<RelayWebSocket>();

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port,
		async fetch(req, srv): Promise<Response | undefined> {
			if (!isLocalHost(req.headers.get("host"), opts.port)) {
				return Response.json({ error: `Forbidden: connect to 127.0.0.1:${opts.port} or localhost:${opts.port}.` }, { status: 403 });
			}
			const fallback = `127.0.0.1:${opts.port}`;
			const rawHost = req.headers.get("host")?.trim();
			const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
			const requestUrl =
				rawHost && rawHost !== host && req.url.startsWith(`http://${rawHost}`)
					? req.url.slice(`http://${rawHost}`.length)
					: req.url;
			const url = new URL(requestUrl, `http://${fallback}`);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (path === "/cdp") {
				// Web pages always send their own Origin on websocket upgrades, so any
				// Origin other than this relay itself is refused: a site can't drive the
				// browser. Native clients either send none or echo the relay's own address
				// (Python websocket-client does), and those are allowed.
				if (!isLocalOrigin(req.headers.get("origin"), opts.port)) {
					return Response.json(
						{
							error:
								"Forbidden: the Origin header says this is a web page. Connect from a local program and either send no Origin header or Origin http://127.0.0.1.",
						},
						{ status: 403 },
					);
				}
				const data: SocketData = {};
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (!isLocalOrigin(req.headers.get("origin"), opts.port)) {
				return Response.json({ error: "Forbidden: web pages can't use this relay." }, { status: 403 });
			}
			const notReady = () =>
				Response.json(
					{
						error: "Chrome isn't connected to this port yet. Retry in a few seconds; if it persists, open Chrome and check the Agent Multi Tab Use extension is enabled.",
					},
					{ status: 503, headers: { "Retry-After": "3" } },
				);
			if (path === "/json/new") {
				if (req.method !== "PUT" && req.method !== "GET") return new Response("Method not allowed", { status: 405 });
				if (!(await bridge.waitReady())) return notReady();
				const target = url.search.length > 1 ? decodeURIComponent(url.search.slice(1)) : "about:blank";
				try {
					return Response.json({ ...(await bridge.createTabForHttp(target)), webSocketDebuggerUrl: `ws://${host}/cdp` });
				} catch (err) {
					return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
				}
			}
			if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (path === "/json/version") {
				// Ride out a reconnect (extension worker restart, app restart) instead of failing the agent.
				if (!(await bridge.waitReady(5000))) return notReady();
				return Response.json(bridge.versionInfo(`ws://${host}/cdp`));
			}
			if (path === "/json" || path === "/json/list") {
				return Response.json(bridge.listTargets(`ws://${host}/cdp`));
			}
			return Response.json(
				{ error: "Not found. Endpoints: GET /json/version, GET /json/list, PUT /json/new?<url>, WS /cdp" },
				{ status: 404 },
			);
		},
		websocket: {
			maxPayloadLength: MAX_PAYLOAD_BYTES,
			// Disabled: Bun caps idleTimeout at 255s, and the keepalive pings
			// below already detect dead peers via the websocket close path.
			idleTimeout: 0,
			open(ws: RelayWebSocket): void {
				sockets.add(ws);
				ws.data.connId = bridge.cdpConnected(ws);
				activity();
			},
			message(ws: RelayWebSocket, message: string | Buffer): void {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				if (ws.data.connId !== undefined) bridge.cdpMessage(ws.data.connId, text);
				activity();
			},
			close(ws: RelayWebSocket): void {
				sockets.delete(ws);
				if (ws.data.connId !== undefined) bridge.cdpClosed(ws.data.connId);
				activity();
			},
		},
	});

	// Puppeteer connections go silent while the agent is idle; protocol-level
	// pings count as activity and keep them under the idle timeout.
	const keepalive = setInterval(() => {
		for (const ws of sockets) ws.ping();
	}, WS_KEEPALIVE_MS);
	keepalive.unref();

	log("relay listening", { port: opts.port });
	return {
		bridge,
		port: opts.port,
		stop() {
			clearInterval(keepalive);
			server.stop(true);
		},
	};
}
