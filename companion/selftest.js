// Self-check: runs the real hub (on test port 9299 and test ports 9724+, so it never\n// touches the live extension or relays) + the extension's hub-client.js against an in-memory
// chrome.storage, then drives the agent API. Usage: bun selftest.js (from companion/)
// "--lease" runs only the idle-lease check, on its own hub (the main run calls it).
import { join } from "node:path";

const LEASE = process.argv.includes("--lease");
const TEST_HUB = LEASE ? 9298 : 9299;
const SCAN_FROM = LEASE ? 9824 : 9724;
const FOREIGN = 9729;
const store = { ports: LEASE ? [9824] : [9724, 9725, 9726], leases: {}, groupColors: {} };
const removedTabs = [];
// A stand-in for Chrome behind the extension: tabs per port, answers attach/send/createTab.
const fakeTabs = new Map();
let nextTab = 100;
function sendHello(port) {
	const tabs = (fakeTabs.get(port) ?? []).map((tab) => ({ ...tab, claimed: true }));
	hubSend({ t: "lane", port, msg: { t: "hello", userAgent: "selftest", browserVersion: "Chrome/selftest", tabs, attachedTabIds: [] } });
}
function fakeExtension(port, msg) {
	if (msg?.t !== "rpc") return;
	const reply = (result) => hubSend({ t: "lane", port, msg: { t: "rpcResult", id: msg.id, ok: true, result } });
	if (msg.op === "createTab") {
		const tab = { tabId: nextTab++, url: msg.url, title: "", active: false, windowId: 1, pinned: false, groupId: -1 };
		fakeTabs.set(port, [...(fakeTabs.get(port) ?? []), tab]);
		return reply({ tab });
	}
	if (msg.op === "send" && msg.method === "Runtime.evaluate") return reply({ result: { type: "string", value: `tab ${msg.tabId} says hi` } });
	if (msg.op === "group") return reply({ grouped: {} });
	reply({});
}
Object.assign(globalThis, {
	COLORS: ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"],
	MAX_PORTS: 250,
	validPort: (p) => Number.isInteger(p) && p > 0 && p <= 65535,
	settings: store,
	// Every port is a lane; the fake extension below answers the relays' RPCs.
	lanes: { get: (port) => ({ port }), values: () => [] },
	laneOpened: (port) => sendHello(port),
	lanesClosed: () => {},
	handleRelayMessage: (lane, msg) => fakeExtension(lane.port, msg),
	claims: new Map(),
	createdTabs: new Map(),
	seenTabs: new Set(),
	// Mirrors background.js: unclaim the port's tabs and tell its relay they're gone.
	releasePortTabs: async (port) => {
		for (const [tabId, owner] of [...claims]) {
			if (owner !== port) continue;
			claims.delete(tabId);
			hubSend({ t: "lane", port, msg: { t: "tabRemoved", tabId } });
		}
	},
	loadSettings: async () => ({ ports: [...store.ports], leases: structuredClone(store.leases), groupColors: structuredClone(store.groupColors), shareTabs: store.shareTabs === true }),
	chrome: {
		runtime: { getManifest: () => ({ version: "0.0.1-test" }), reload: () => {} },
		tabs: { remove: async (id) => void removedTabs.push(id) },
		storage: {
			local: { get: async (d) => ({ ...d, ...Object.fromEntries(Object.keys(d).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])) }), set: async (p) => Object.assign(store, structuredClone(p)) },
			session: { get: async () => ({ laneStatus: [] }), set: async () => {} },
		},
	},
});
const RealWS = WebSocket;
globalThis.WebSocket = class extends RealWS {
	constructor(url) {
		super(url, { headers: { Origin: "chrome-extension://selftest" } });
	}
};

// Stands in for another app (e.g. an agent's private Chrome) on a port we'd otherwise hand out.
const other = LEASE ? null : Bun.serve({ hostname: "127.0.0.1", port: FOREIGN, fetch: () => new Response("not a relay", { status: 404 }) });
const hub = Bun.spawn(["bun", join(import.meta.dir, "main.js")], {
	env: {
		...process.env,
		AMTU_HUB_PORT: String(TEST_HUB),
		AMTU_READY_MS: "1000",
		AMTU_SCAN_FROM: String(SCAN_FROM),
		AMTU_NO_AUTOSTART: "1",
		AMTU_EXT_WAIT_MS: "1500",
		AMTU_LEASE_IDLE_MS: LEASE ? "800" : "3600000",
	},
	stdout: "ignore",
	stderr: "inherit",
});
await Bun.sleep(800);
const api = (path, body) =>
	fetch(`http://127.0.0.1:${TEST_HUB}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then(
		async (r) => ({ status: r.status, ...(await r.json()) }),
	);
const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok  ${msg}`);
};

if (LEASE) {
	try {
		(0, eval)(await Bun.file(join(import.meta.dir, "..", "extension", "hub-client.js")).text());
		globalThis.HUB_URL = `ws://127.0.0.1:${TEST_HUB}/ext`;
		connectHub();
		await Bun.sleep(800);
		const first = await api("/claim", { agent: "forgetful" });
		const sticky = await api("/claim", { agent: "other" });
		assert(sticky.port !== first.port, "a fresh lease is not handed to another agent");
		await api("/release", { agent: "other", port: sticky.port });
		await Bun.sleep(1200);
		const next = await api("/claim", { agent: "newcomer" });
		assert(next.port === first.port && !store.ports.includes(first.port + 2), `a lease idle past the limit goes back to the pool (got ${next.port}, wanted ${first.port})`);
	} finally {
		hub.kill();
	}
	process.exit(0);
}

try {
	// Before the extension connects: the "Chrome is down" path, without touching a real browser.
	const down = await api("/claim", { agent: "early" });
	assert(down.status === 503 && down.retry === true && /Retry in a few seconds/.test(down.error), "no Chrome yet: claim returns 503 + retry, not a scary 400");
	assert((await api("/status")).chromeConnected === false, "GET /status says chromeConnected:false");
	(0, eval)(await Bun.file(join(import.meta.dir, "..", "extension", "hub-client.js")).text());
	globalThis.HUB_URL = `ws://127.0.0.1:${TEST_HUB}/ext`;
	connectHub();
	await Bun.sleep(800);
	assert((await api("/")).endpoints["POST /claim"], "GET / lists endpoints");
	const a = await api("/claim", { agent: "hermes", group: "Hermes" });
	assert(a.port === 9724 && a.group === "Hermes", "hermes gets 9724 in its group");
	const b = await api("/claim", { agent: "codex" });
	assert(b.port === 9725 && b.group === "Agents", "codex (no group given) gets 9725 in the default Agents group");
	const c = await api("/claim", { agent: "hermes-2", group: "hermes" });
	assert(c.port === 9726 && c.group === "Hermes", "a second agent claiming the same group (any case) shares it");
	const d = await api("/claim", { agent: "claude", group: "Claude", count: 4 });
	const got = d.claimed.map((x) => x.port);
	assert(got.join() === "9727,9728,9730,9731", `count:4 adds ports when the pool is empty, skipping ${FOREIGN} (another app): ${got}`);
	assert(!store.ports.includes(FOREIGN), "the other app's port was never added");
	const again = await api("/claim", { agent: "hermes", group: "Hermes" });
	assert(again.port === 9724, "an agent that claims again gets its same port back");
	const again4 = await api("/claim", { agent: "claude", group: "Claude", count: 4 });
	assert(again4.claimed.map((x) => x.port).join() === got.join() && store.ports.length === 7, "count claims are sticky too, no extra ports created");
	const e = await api("/claim", { agent: "thief", port: 9724 });
	assert(/held by hermes/.test(e.error), "can't take a port another agent holds");
	const wrongRelease = await api("/release", { port: 9726, agent: "codex" });
	assert(/held by hermes-2/.test(wrongRelease.error), "can't release someone else's port");
	await api("/release", { agent: "claude", ports: [9730, 9731] });
	const reuse = await api("/claim", { agent: "newbie", group: "Hermes" });
	assert(reuse.port === 9730 && store.ports.length === 7, "a released port goes back to the pool: the next agent gets it, no new port");
	const relayUp = await fetch("http://127.0.0.1:9724/json/version").then((r) => r.status, () => 0);
	assert(relayUp === 200, "a relay listens on claimed port 9724 and reaches Chrome over the one extension socket");
	const add = await api("/ports", { add: 10 });
	assert(add.added.length === 10 && store.ports.length === 17, "POST /ports adds ports");
	const st = await api("/status");
	assert(st.ports.find((p) => p.port === 9726).agent === "hermes-2" && st.usedByOtherApps.includes(FOREIGN), "GET /status shows holders and other apps' ports");
	assert(st.groups.find((g) => g.name === "Hermes")?.ports.join() === "9724,9726,9730", "GET /status lists each group with its ports");
	await api("/release", { agent: "newbie", all: true });
	assert(store.ports.length === 10, `free ports beyond the spare pool are removed again (${store.ports.length} ports)`);

	// release tidies: closes tabs the agent opened unless the user looked at them
	claims.set(501, 9725).set(502, 9725).set(503, 9725);
	createdTabs.set(501, 9725).set(502, 9725);
	seenTabs.add(502);
	hubSend({ t: "lane", port: 9725, msg: { t: "tabCreated", tab: { tabId: 502, url: "https://x.com/i/history", title: "History", active: false, windowId: 1, pinned: false, groupId: -1, claimed: true } } });
	await Bun.sleep(100);
	const listed = async () => (await fetch("http://127.0.0.1:9725/json/list").then((r) => r.json())).map((t) => t.url);
	assert((await listed()).includes("https://x.com/i/history"), "the agent's tab is listed on its port while it holds the lease");
	const tidy = await api("/release", { agent: "codex", port: 9725 });
	assert(tidy.closedTabs === 1 && removedTabs.join() === "501", "release closes the agent's unseen tab, keeps the one the user looked at and the adopted one");
	await Bun.sleep(100);
	assert(![...claims.values()].includes(9725) && (await listed()).length === 0, "kept tabs go back to the user: unclaimed and no longer listed to the port's next agent");
	claims.clear();

	const sub = await api("/claim", { agent: "hermes-research", group: "Research", parent: "Hermes" });
	assert(sub.group === "Hermes › Research", "claim with parent makes a sub group titled 'Parent › Name'");
	assert(store.groupColors["Hermes › Research"] === store.groupColors.Hermes, "sub group starts in its parent's color");
	const again2 = await api("/claim", { agent: "hermes-research", group: "Hermes › Research" });
	assert(again2.port === sub.port, "the full 'Parent › Name' finds the same sub group");
	const nested = await api("/group", { name: "Deeper", parent: "Hermes › Research" });
	assert(/can't have their own sub groups/.test(nested.error), "sub groups are one level deep");
	const recolor = await api("/group", { name: "hermes", color: "green" });
	assert(recolor.name === "Hermes" && store.groupColors.Hermes === "green", "POST /group recolors a group");
	await api("/group/delete", { name: "Hermes" });
	assert(!Object.keys(store.groupColors).some((n) => n.startsWith("Hermes")), "deleting a group forgets it and its sub groups");
	await api("/release", { agent: "hermes-research", all: true });
	const pref = await api("/settings", { closeTabsOnRelease: true });
	assert(/Nothing to set/.test(pref.message ?? ""), "the old closeTabsOnRelease setting explains the new tidy rule");
	const take = await api("/take", { agent: "hermes", from: "Claude", to: "Hermes", count: 1 });
	assert(take.status === 404, "/take is gone (ports aren't tied to groups any more)");
	const warn = await api("/status");
	assert(warn.extension === "0.0.1-test" && /versions differ/.test(warn.warning ?? ""), "GET /status warns agents when extension and app versions differ");
	const off = await api("/settings", { agent: "hermes", shareTabs: false });
	assert(off.shareTabs === false && store.shareTabs === false, "shareTabs:false applies at once");
	const askShare = await api("/settings", { agent: "hermes", shareTabs: true });
	assert(askShare.status === 409 && /Confirm you want to let every agent see/.test(askShare.message) && store.shareTabs === false, "shareTabs:true asks the user first and changes nothing yet");
	const fakeShare = await api("/settings", { agent: "hermes", shareTabs: true, confirm: "nope1234" });
	assert(/invalid or expired/.test(fakeShare.error), "a made-up confirmation token is refused");
	const share = await api("/settings", { agent: "hermes", shareTabs: true, confirm: askShare.confirmToken });
	assert(share.shareTabs === true && store.shareTabs === true, "confirmed shareTabs:true turns sharing on");
	const web = await fetch(`http://127.0.0.1:${TEST_HUB}/status`, { headers: { Origin: "https://evil.example" } });
	assert(web.status === 403, "web pages are refused");
	// ---- one socket carries every port; agents ride out an extension reconnect ----
	const cdpPort = (await api("/claim", { agent: "cdp-test" })).port;
	const cdp = new RealWS(`ws://127.0.0.1:${cdpPort}/cdp`);
	await new Promise((resolve) => (cdp.onopen = resolve));
	let cdpId = 0;
	const cdpWaits = new Map();
	cdp.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.id) cdpWaits.get(m.id)?.(m);
	};
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve) => {
			const id = ++cdpId;
			cdpWaits.set(id, resolve);
			cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	const created = await send("Target.createTarget", { url: "https://example.com" });
	const attached = await send("Target.attachToTarget", { targetId: created.result?.targetId, flatten: true });
	const said = await send("Runtime.evaluate", { expression: "1" }, attached.result?.sessionId);
	assert(/says hi/.test(said.result?.result?.value ?? ""), `CDP create, attach, evaluate work through the shared socket: ${JSON.stringify(said.result ?? said.error)}`);
	globalThis.hub.ws.close();
	const during = await send("Runtime.evaluate", { expression: "1" }, attached.result?.sessionId);
	assert(/says hi/.test(during.result?.result?.value ?? ""), `a command sent while the extension reconnects waits and succeeds, same session: ${JSON.stringify(during.result ?? during.error)}`);
	cdp.close();

	// ---- safety ----
	const rebound = await new Promise((resolve) => {
		const sock = require("node:net").createConnection({ host: "127.0.0.1", port: TEST_HUB }, () => sock.write("GET /status HTTP/1.0\r\nHost: evil.example:9299\r\n\r\n"));
		sock.once("data", (chunk) => (resolve(String(chunk).split("\r\n")[0]), sock.destroy()));
	});
	assert(/ 403 /.test(rebound), `a request for another Host name (DNS rebinding) is refused: ${rebound}`);
	const intruder = new RealWS(`ws://127.0.0.1:${TEST_HUB}/ext`, { headers: { Origin: "chrome-extension://someone-else" } });
	const intruderCode = await new Promise((resolve) => (intruder.onclose = (e) => resolve(e.code)));
	assert(intruderCode === 4009, "a second browser/extension can't take over while one is connected");
	assert((await api("/status")).chromeConnected === true, "and the first one stays connected");
	const held = (await api("/claim", { agent: "holder" })).port;
	const anon = await api("/release", { port: held });
	assert(/held by holder; send "agent"/.test(anon.error ?? ""), "release without the holder's agent name is refused");
	await api("/release", { port: held, agent: "holder" });

	// ---- idle leases go back to the pool (separate hub with a short idle time) ----
	const lease = Bun.spawnSync(["bun", import.meta.path, "--lease"], { stdout: "inherit", stderr: "inherit" });
	assert(lease.exitCode === 0, "idle lease expiry check passed");
	console.log("\nall hub checks passed");
} finally {
	hub.kill();
	other?.stop(true);
	process.exit(0);
}


