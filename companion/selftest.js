// Self-check: runs the real hub (on test port 9299 and test ports 9724+, so it never\n// touches the live extension or relays) + the extension's hub-client.js against an in-memory
// chrome.storage, then drives the agent API. Usage: bun selftest.js (from companion/)
import { join } from "node:path";

const TEST_HUB = 9299;
const FOREIGN = 9729;
const store = { ports: [9724, 9725, 9726], groups: [], leases: {} };
Object.assign(globalThis, {
	COLORS: ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"],
	MAX_PORTS: 250,
	validPort: (p) => Number.isInteger(p) && p > 0 && p <= 65535,
	settings: store,
	lanes: new Map(),
	claims: new Map(),
	createdTabs: new Map(),
	connect: () => {},
	loadSettings: async () => ({ ports: [...store.ports], groups: structuredClone(store.groups), token: "" }),
	chrome: {
		runtime: { getManifest: () => ({ version: "0.0.1-test" }) },
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
const other = Bun.serve({ hostname: "127.0.0.1", port: FOREIGN, fetch: () => new Response("not a relay", { status: 404 }) });
const hub = Bun.spawn(["bun", join(import.meta.dir, "main.js")], {
	env: { ...process.env, AMTU_HUB_PORT: String(TEST_HUB), AMTU_READY_MS: "1000", AMTU_SCAN_FROM: "9724", AMTU_NO_AUTOSTART: "1", AMTU_EXT_WAIT_MS: "1500" },
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

try {
	// Before the extension connects: the "Chrome is down" path, without touching a real browser.
	const down = await api("/claim", { agent: "early" });
	assert(down.status === 503 && down.retry === true && /Retry in a few seconds/.test(down.error), "no Chrome yet: claim returns 503 + retry, not a scary 400");
	assert((await api("/status")).chromeConnected === false, "GET /status says chromeConnected:false");
	(0, eval)(await Bun.file(join(import.meta.dir, "..", "extension", "hub-client.js")).text());
	globalThis.HUB_URL = `ws://127.0.0.1:${TEST_HUB}/ext`;
	connectHub();
	await Bun.sleep(800);
	assert((await api("/")).endpoints["POST /take"], "GET / lists endpoints");
	const a = await api("/claim", { agent: "hermes", group: "Hermes Tab Group" });
	assert(a.port === 9724 && a.group === "Hermes Tab Group", "hermes gets 9724 in its new group");
	const b = await api("/claim", { agent: "codex" });
	assert(b.port === 9725, "codex gets the next free ungrouped port 9725");
	const c = await api("/claim", { agent: "hermes-2", group: "hermes tab group" });
	assert(c.port === 9726 && store.groups[0].ports.includes(9726), "second hermes agent joins the same group (case-insensitive)");
	const d = await api("/claim", { agent: "claude", group: "Claude", count: 4 });
	const got = d.claimed.map((x) => x.port);
	assert(got.join() === "9727,9728,9730,9731", `count:4 creates 4 new ports and skips ${FOREIGN} (another app): ${got}`);
	assert(!store.ports.includes(FOREIGN), "the other app's port was never added");
	const again = await api("/claim", { agent: "hermes", group: "Hermes Tab Group" });
	assert(again.port === 9724, "an agent that claims again gets its same port back (no leak)");
	const again4 = await api("/claim", { agent: "claude", group: "Claude", count: 4 });
	assert(again4.claimed.map((x) => x.port).join() === got.join() && store.ports.length === 7, "count claims are sticky too, no extra ports created");
	const e = await api("/claim", { agent: "thief", port: 9724 });
	assert(/belongs to group|held by/.test(e.error), "can't take a port another agent holds");
	const f = await api("/claim", { agent: "hermes", group: "Hermes Tab Group", port: 9730 });
	assert(/belongs to group "Claude".*\/take/.test(f.error), "can't grab another group's port by number; told to use /take");
	const g = await api("/group", { name: "Hermes Tab Group", ports: [9731] });
	assert(/belongs to group "Claude"/.test(g.error), "POST /group can't move another group's ports");
	const busy = await api("/take", { agent: "hermes", from: "Claude", to: "Hermes Tab Group", count: 2 });
	assert(/only 0 idle/.test(busy.error), "/take refuses ports that are in use");
	await api("/release", { agent: "claude", ports: [9730, 9731] });
	const wrongRelease = await api("/release", { port: 9726, agent: "codex" });
	assert(/held by hermes-2/.test(wrongRelease.error), "can't release someone else's port");
	const ask = await api("/take", { agent: "hermes", from: "Claude", to: "Hermes Tab Group", count: 2 });
	assert(ask.status === 409 && ask.confirmRequired && /Confirm you want to pull 2 ports \(9730, 9731\) out of the "Claude" group for "Hermes Tab Group"/.test(ask.message), "/take asks for confirmation first");
	assert(store.groups.find((x) => x.name === "Claude").ports.includes(9730), "nothing moves before confirmation");
	const forged = await api("/take", { agent: "hermes", from: "Claude", to: "Hermes Tab Group", count: 2, confirm: "nope1234" });
	assert(/invalid or expired/.test(forged.error), "a made-up confirmation token is refused");
	const done = await api("/take", { agent: "hermes", from: "Claude", to: "Hermes Tab Group", count: 2, confirm: ask.confirmToken });
	assert(done.moved?.join() === "9730,9731" && store.groups[0].ports.includes(9731), "confirmed /take moves the ports");
	const reuse = await api("/take", { agent: "hermes", from: "Claude", to: "Hermes Tab Group", count: 2, confirm: ask.confirmToken });
	assert(reuse.error, "a confirmation token works only once");
	const relayUp = await fetch("http://127.0.0.1:9724/json/version").then((r) => r.status, () => 0);
	assert(relayUp === 503, "a relay listens on claimed port 9724 inside the app (503 = waiting for Chrome)");
	const add = await api("/ports", { add: 2 });
	assert(add.added.join() === "9732,9733", "POST /ports adds 9732-9733");
	const st = await api("/status");
	assert(st.ports.find((p) => p.port === 9726).agent === "hermes-2" && st.usedByOtherApps.includes(FOREIGN), "GET /status shows holders and other apps' ports");
	const sub = await api("/claim", { agent: "hermes-research", group: "Research", parent: "Hermes Tab Group" });
	const subGroup = store.groups.find((x) => x.name === "Hermes Tab Group › Research");
	assert(sub.group === "Hermes Tab Group › Research" && subGroup?.parent === "Hermes Tab Group", "claim with parent makes a sub group titled 'Parent › Name'");
	assert(subGroup.color === store.groups.find((x) => x.name === "Hermes Tab Group").color, "sub group inherits its parent's color");
	const again2 = await api("/claim", { agent: "hermes-research", group: "Hermes Tab Group › Research" });
	assert(again2.port === sub.port, "the full 'Parent › Name' finds the same sub group");
	const nested = await api("/group", { name: "Deeper", parent: "Hermes Tab Group › Research" });
	assert(/can't have their own sub groups/.test(nested.error), "sub groups are one level deep");
	const shortDel = await api("/group/delete", { name: "Research" });
	assert(shortDel.deleted === "Hermes Tab Group › Research", "a sub group can be deleted by its short name");
	await api("/group", { name: "Scratch", parent: "Codex" });
	await api("/group/delete", { name: "Codex" });
	assert(!store.groups.some((x) => x.name.startsWith("Codex")), "deleting a group deletes its sub groups too");
	await api("/release", { agent: "hermes-research", all: true });
	const pref = await api("/settings", { closeTabsOnRelease: true });
	assert(pref.closeTabsOnRelease === true && store.closeTabsOnRelease === true && (await api("/status")).closeTabsOnRelease === true, "closeTabsOnRelease can be switched on, no confirmation needed");
	await api("/settings", { closeTabsOnRelease: false });
	assert((await api("/status")).closeTabsOnRelease === false, "and back off");
	const warn = await api("/status");
	assert(warn.extension === "0.0.1-test" && /versions differ/.test(warn.warning ?? ""), "GET /status warns agents when extension and app versions differ");
	const off = await api("/settings", { agent: "hermes", shareTabs: false });
	assert(off.shareTabs === false && store.shareTabs === false, "shareTabs:false applies at once");
	const askShare = await api("/settings", { agent: "hermes", shareTabs: true });
	assert(askShare.status === 409 && /Confirm you want to let every agent see/.test(askShare.message) && store.shareTabs === false, "shareTabs:true asks the user first and changes nothing yet");
	const fakeShare = await api("/settings", { agent: "hermes", shareTabs: true, confirm: ask.confirmToken });
	assert(/invalid or expired/.test(fakeShare.error), "a /take token can't be reused to turn sharing on");
	const share = await api("/settings", { agent: "hermes", shareTabs: true, confirm: askShare.confirmToken });
	assert(share.shareTabs === true && store.shareTabs === true, "confirmed shareTabs:true turns sharing on");
	const web = await fetch(`http://127.0.0.1:${TEST_HUB}/status`, { headers: { Origin: "https://evil.example" } });
	assert(web.status === 403, "web pages are refused");
	console.log("\nall hub checks passed");
} finally {
	hub.kill();
	other.stop(true);
	process.exit(0);
}


