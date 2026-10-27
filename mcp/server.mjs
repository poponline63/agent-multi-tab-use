#!/usr/bin/env node
// Agent Multi Tab Use MCP server: browser tools for any MCP agent (Codex, OpenCode,
// Pi, Hermes, ...) without writing CDP code. Claims its own hub port on first use,
// drives tabs over that port's CDP socket, releases the port when the agent exits.
// Zero dependencies: Node 22+ (global fetch + WebSocket). MCP over stdio, one JSON
// message per line.
//
// Env: AMTU_AGENT (agent name, default "mcp"; the process id is appended so two
// sessions of one agent never share a port), AMTU_GROUP (Chrome tab group, default
// "Agents"), AMTU_HUB (default http://127.0.0.1:9223).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const HUB = process.env.AMTU_HUB || "http://127.0.0.1:9223";
const AGENT = `${process.env.AMTU_AGENT || "mcp"}-${process.pid}`;
const GROUP = process.env.AMTU_GROUP || "Agents";
const VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../companion/package.json", import.meta.url), "utf8")).version;
	} catch {
		return "0.0.0";
	}
})();
const HUB_EXE = String.raw`%USERPROFILE%\Downloads\Agent Multi Tab Use\AgentMultiTabUse.exe`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error("[amtu-mcp]", ...a);

let lease = null; // { port, cdpUrl, group }
let ws = null;
let nextId = 0;
const pending = new Map();
const sessions = new Map(); // targetId -> CDP sessionId (per websocket)
let current = null; // targetId the tools act on by default

async function hub(path, body) {
	for (let attempt = 0; attempt < 12; attempt++) {
		let res;
		try {
			res = await fetch(HUB + path, {
				method: body ? "POST" : "GET",
				headers: { "content-type": "application/json" },
				body: body && JSON.stringify(body),
			});
		} catch {
			throw new Error(`Agent Multi Tab Use hub is not running at ${HUB}. Start it: ${HUB_EXE}`);
		}
		const json = await res.json().catch(() => ({}));
		if (res.status === 503 && json.retry) {
			await sleep(5000);
			continue;
		}
		if (!res.ok) throw new Error(json.error || json.problem || `hub ${path} answered ${res.status}`);
		return json;
	}
	throw new Error("Chrome did not reconnect to the hub within a minute. Is Chrome open with the Agent Multi Tab Use extension enabled?");
}

async function claim() {
	if (lease) return lease;
	const r = await hub("/claim", { agent: AGENT, group: GROUP });
	for (let i = 0; !r.ready && i < 30; i++) {
		await sleep(500);
		const { ports = [] } = await hub("/status");
		r.ready = ports.find((p) => p.port === r.port)?.live;
	}
	if (!r.ready) throw new Error(`port ${r.port} never went live; check GET ${HUB}/status`);
	lease = { port: r.port, cdpUrl: r.cdpUrl, group: r.group };
	log("claimed", lease);
	return lease;
}

async function connect() {
	if (ws?.readyState === WebSocket.OPEN) return;
	const { port } = await claim();
	const sock = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
	await new Promise((resolve, reject) => {
		sock.onopen = resolve;
		sock.onerror = () => reject(new Error(`could not open the CDP socket on port ${port}`));
	});
	sock.onmessage = (e) => {
		const m = JSON.parse(e.data);
		const p = m.id && pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
	};
	sock.onclose = () => {
		if (ws === sock) ws = null;
		sessions.clear();
		for (const p of pending.values()) p.reject(new Error("CDP socket closed"));
		pending.clear();
	};
	ws = sock;
}

async function cdp(method, params = {}, sessionId, timeoutMs = 30_000) {
	await connect();
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, timeoutMs);
		pending.set(id, {
			resolve: (v) => (clearTimeout(timer), resolve(v)),
			reject: (e) => (clearTimeout(timer), reject(e)),
		});
		ws.send(JSON.stringify({ id, method, params, sessionId }));
	});
}

async function myTabs() {
	const { cdpUrl } = await claim();
	return (await fetch(`${cdpUrl}/json/list`).then((r) => r.json())).filter((t) => t.type === "page");
}

async function session(tab) {
	const targetId = tab || current;
	if (!targetId) throw new Error("No tab yet. Call browser_open first.");
	await connect();
	if (!sessions.has(targetId)) {
		const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
		await cdp("Runtime.enable", {}, sessionId);
		// Agent tabs open in the background; without this some pages stall or skip focus handlers.
		await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
		sessions.set(targetId, sessionId);
	}
	current = targetId;
	return sessions.get(targetId);
}

async function evaluate(sid, expression) {
	const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
	return r.result.value;
}

// leaving: a URL the page must have moved off (a fresh tab reports about:blank as "complete").
async function waitLoad(sid, leaving, ms = 15_000) {
	const end = Date.now() + ms;
	const expr = `document.readyState === "complete" && location.href !== ${JSON.stringify(leaving ?? "")}`;
	while (Date.now() < end) {
		// Throws while a navigation swaps the page out; just try again.
		if (await evaluate(sid, expr).catch(() => false)) return;
		await sleep(250);
	}
}

async function pageInfo(sid) {
	return evaluate(sid, "({ title: document.title, url: location.href })");
}

const INTERACTIVE =
	'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=""],[contenteditable=true],[onclick]';

// ponytail: top document only; iframes (embedded checkouts, captchas) are not read or numbered.
const READ_JS = (max) => `(() => {
	document.querySelectorAll('[data-amtu-ref]').forEach((e) => e.removeAttribute('data-amtu-ref'));
	const els = [];
	let n = 0;
	for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
		el.setAttribute('data-amtu-ref', ++n);
		const tag = el.tagName.toLowerCase();
		const type = el.getAttribute('type');
		const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
		const href = tag === 'a' ? ' -> ' + el.getAttribute('href').slice(0, 120) : '';
		els.push('[' + n + '] ' + tag + (type ? ':' + type : '') + ' ' + JSON.stringify(label) + href);
		if (n >= 300) break;
	}
	const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
	return { title: document.title, url: location.href, text: text.slice(0, ${max}), cut: text.length > ${max}, els };
})()`;

const FIND_JS = ({ ref, selector, text }) => `(() => {
	let el = null;
	if (${JSON.stringify(ref ?? null)} !== null) el = document.querySelector('[data-amtu-ref="${Number(ref)}"]');
	else if (${JSON.stringify(selector ?? null)}) el = document.querySelector(${JSON.stringify(selector ?? "")});
	else {
		const want = ${JSON.stringify((text ?? "").toLowerCase())};
		const all = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE)})].filter((e) => e.getBoundingClientRect().width);
		const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || '').trim().toLowerCase();
		el = all.find((e) => label(e) === want) || all.find((e) => label(e).includes(want));
	}
	if (!el) return null;
	el.scrollIntoView({ block: 'center', inline: 'center' });
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
})()`;

async function find(sid, args) {
	if (args.ref == null && !args.selector && !args.text) throw new Error("Give ref (from browser_read), selector, or text.");
	const hit = await evaluate(sid, FIND_JS(args));
	if (!hit) throw new Error("Element not found. Refs change when the page changes: call browser_read again.");
	return hit;
}

const tabArg = { tab: { type: "string", description: "Tab id from browser_open/browser_tabs. Default: the last tab you used." } };
const target = { ref: { type: "integer", description: "Element number from browser_read" }, selector: { type: "string", description: "CSS selector" }, text: { type: "string", description: "Visible text of a link/button" } };

const TOOLS = {
	browser_claim: {
		description: "Claim your own port in the user's real Chrome (done automatically by browser_open). Returns the port, CDP URL and tab group. Use the CDP URL directly if you prefer Playwright/Puppeteer.",
		inputSchema: { type: "object", properties: {} },
		run: async () => {
			const l = await claim();
			return `port ${l.port}, cdpUrl ${l.cdpUrl}, tab group "${l.group}", agent "${AGENT}"`;
		},
	},
	browser_open: {
		description: "Open a URL in the user's real, logged-in Chrome, in a new background tab in your own tab group (other agents cannot see it). Waits for the page to load. Set tab to navigate an existing tab instead.",
		inputSchema: { type: "object", properties: { url: { type: "string" }, ...tabArg }, required: ["url"] },
		run: async ({ url, tab }) => {
			let sid;
			if (tab) {
				sid = await session(tab);
				await cdp("Page.navigate", { url }, sid);
				await sleep(300);
			} else {
				await claim();
				const { targetId } = await cdp("Target.createTarget", { url });
				sid = await session(targetId);
			}
			await waitLoad(sid, url === "about:blank" ? null : "about:blank");
			const { title, url: now } = await pageInfo(sid);
			return `tab ${current}\ntitle: ${title}\nurl: ${now}\nNext: browser_read to see the page text and numbered elements.`;
		},
	},
	browser_read: {
		description: "Read the current page: title, URL, visible text, and a numbered list of clickable/typeable elements. Use the numbers as ref in browser_click and browser_type.",
		inputSchema: { type: "object", properties: { maxChars: { type: "integer", description: "Text limit, default 15000" }, ...tabArg } },
		run: async ({ tab, maxChars = 15000 }) => {
			const sid = await session(tab);
			const r = await evaluate(sid, READ_JS(Math.max(500, maxChars)));
			return `tab ${current}\ntitle: ${r.title}\nurl: ${r.url}\n\n${r.text}${r.cut ? "\n[text cut, raise maxChars for more]" : ""}\n\nELEMENTS\n${r.els.join("\n") || "(none)"}`;
		},
	},
	browser_click: {
		description: "Click an element with a real mouse click. Identify it by ref (from browser_read), CSS selector, or visible text. Reports navigation and any new tab it opened.",
		inputSchema: { type: "object", properties: { ...target, ...tabArg } },
		run: async (args) => {
			const sid = await session(args.tab);
			const before = new Set((await myTabs()).map((t) => t.id));
			const { x, y } = await find(sid, args);
			for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
				await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sid);
			}
			await sleep(700);
			await waitLoad(sid);
			const { title, url } = await pageInfo(sid);
			const opened = (await myTabs()).filter((t) => !before.has(t.id));
			const extra = opened.map((t) => `\nopened new tab ${t.id} (${t.url}); pass tab to use it`).join("");
			return `clicked. title: ${title}\nurl: ${url}${extra}`;
		},
	},
	browser_type: {
		description: "Type text into an input/textarea/editable element (replaces its current value). submit=true presses Enter afterwards.",
		inputSchema: { type: "object", properties: { ...target, value: { type: "string", description: "Text to type" }, submit: { type: "boolean" }, ...tabArg }, required: ["value"] },
		run: async (args) => {
			const sid = await session(args.tab);
			const { x, y } = await find(sid, args);
			for (const type of ["mousePressed", "mouseReleased"]) {
				await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sid);
			}
			await evaluate(sid, "(() => { const e = document.activeElement; if (e && 'select' in e) e.select(); else if (e?.isContentEditable) document.execCommand('selectAll'); })()");
			await cdp("Input.insertText", { text: args.value }, sid);
			if (args.submit) {
				const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
				await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key }, sid);
				await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sid);
				await sleep(700);
				await waitLoad(sid);
			}
			const { title, url } = await pageInfo(sid);
			return `typed ${args.value.length} characters${args.submit ? " and pressed Enter" : ""}. title: ${title}\nurl: ${url}`;
		},
	},
	browser_screenshot: {
		description: "Screenshot the tab (visible area, or the whole page with fullPage=true). Returns a PNG image.",
		inputSchema: { type: "object", properties: { fullPage: { type: "boolean" }, ...tabArg } },
		run: async ({ tab, fullPage }) => {
			const sid = await session(tab);
			const params = { format: "png" };
			if (fullPage) {
				const { cssContentSize: s } = await cdp("Page.getLayoutMetrics", {}, sid);
				Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: s.width, height: Math.min(s.height, 16000), scale: 1 } });
			}
			const { data } = await cdp("Page.captureScreenshot", params, sid, 60_000);
			return [{ type: "image", data, mimeType: "image/png" }];
		},
	},
	browser_eval: {
		description: "Run JavaScript in the page and return the JSON result (await is allowed). For anything the other tools don't cover.",
		inputSchema: { type: "object", properties: { js: { type: "string", description: "An expression, e.g. document.querySelectorAll('h2').length" }, ...tabArg }, required: ["js"] },
		run: async ({ js, tab }) => JSON.stringify(await evaluate(await session(tab), js), null, 1) ?? "undefined",
	},
	browser_tabs: {
		description: "List your tabs (only tabs you opened, plus popups they opened). * marks the current one.",
		inputSchema: { type: "object", properties: {} },
		run: async () => (await myTabs()).map((t) => `${t.id === current ? "*" : " "} ${t.id}  ${t.title} | ${t.url}`).join("\n") || "(no tabs)",
	},
	browser_close: {
		description: "Close one of your tabs (default: the current one).",
		inputSchema: { type: "object", properties: { ...tabArg } },
		run: async ({ tab }) => {
			const id = tab || current;
			if (!id) throw new Error("No tab to close.");
			await cdp("Target.closeTarget", { targetId: id });
			sessions.delete(id);
			if (current === id) current = null;
			return `closed ${id}`;
		},
	},
	browser_release: {
		description: "Give your port back when the browser work is done. Your tabs close, except ones the user looked at. keepTabs=true leaves them all open for the user.",
		inputSchema: { type: "object", properties: { keepTabs: { type: "boolean" } } },
		run: async ({ keepTabs }) => {
			if (!lease) return "nothing to release";
			const r = await release(keepTabs);
			return `released port(s) ${r.released?.join(", ")}; closed ${r.closedTabs ?? 0} tab(s)`;
		},
	},
};

async function release(keepTabs) {
	ws?.close();
	ws = null;
	current = null;
	lease = null;
	return hub("/release", { agent: AGENT, all: true, ...(keepTabs ? { keepTabs: true } : {}) });
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
	const { id, method, params = {} } = msg;
	if (id === undefined) return; // notifications (initialized, cancelled) need no reply
	try {
		let result;
		if (method === "initialize") {
			result = {
				protocolVersion: params.protocolVersion || "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "agent-multi-tab-use", version: VERSION },
				instructions: "Browser tools for the user's real, logged-in Chrome. Flow: browser_open -> browser_read -> browser_click/browser_type -> browser_release when done. Ask the user before purchases, sending messages or posts, or account changes.",
			};
		} else if (method === "tools/list") {
			result = { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
		} else if (method === "tools/call") {
			const tool = TOOLS[params.name];
			if (!tool) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
			try {
				const out = await tool.run(params.arguments ?? {});
				result = { content: typeof out === "string" ? [{ type: "text", text: out }] : out };
			} catch (err) {
				result = { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
			}
		} else if (method === "ping") {
			result = {};
		} else {
			throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
		}
		send({ jsonrpc: "2.0", id, result });
	} catch (err) {
		send({ jsonrpc: "2.0", id, error: { code: err.code ?? -32603, message: err.message } });
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
	}
	handle(msg);
});

// The agent closed us: hand the port back so it doesn't sit leased for an hour.
// A hard kill skips this; the hub's idle expiry (60 min) releases the port then.
let exiting = false;
async function shutdown() {
	if (exiting) return;
	exiting = true;
	if (lease) await Promise.race([release().catch(() => {}), sleep(3000)]);
	process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
