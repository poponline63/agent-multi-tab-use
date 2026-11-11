// Tests the extension's tab-group and port logic against a fake Chrome: one group per
// agent (never duplicates), reserved ports, shareTabs default, and cleaning up leftover
// agent groups. Run: bun extension/test/extension.test.js
import { join } from "node:path";
import { makeFakeChrome } from "./fake-chrome.js";

const dir = join(import.meta.dir, "..");
const assert = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok  ${msg}`);
};

async function boot(local) {
	const fake = makeFakeChrome({ local });
	globalThis.chrome = fake.chrome;
	globalThis.importScripts = () => {};
	globalThis.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
	globalThis.WebSocket.OPEN = 1;
	globalThis.WebSocket.CONNECTING = 0;
	// background.js then hub-client.js, the way Chrome's importScripts shares one global scope.
	const code = (await Bun.file(join(dir, "hub-client.js")).text()) + "\n" + (await Bun.file(join(dir, "background.js")).text());
	(0, eval)(code);
	await ready;
	return fake;
}

let failed = false;
try {
	// ---- defaults and reserved ports ----
	let fake = await boot({ ports: [9224, 9225, 9226, 9227, 9229, 9524], leases: { 9226: { agent: "old", group: "Port 9226", since: 1 } } });
	assert(settings.shareTabs === true, "\"Let agents see my own tabs\" is on by default");
	assert(!settings.ports.includes(9226) && !settings.ports.includes(9229) && !settings.leases[9226], "reserved ports (9226 = the user's Chrome debug port) are dropped from the pool");
	assert(!DEFAULT_PORTS.includes(9226) && !DEFAULT_PORTS.includes(9222) && DEFAULT_PORTS.length === 10, "default ports skip reserved ones");
	await chrome.storage.local.set({ shareTabs: false });
	await applySettings();
	assert(settings.shareTabs === false, "a user who turns sharing off keeps it off");

	// ---- claims: same agent, same port and group; low port numbers ----
	fake = await boot({});
	const a = await hubOps.claim({ agent: "claude", group: "Claude" });
	const a2 = await hubOps.claim({ agent: "claude" });
	assert(a.port === a2.port && a2.group === "Claude", `the same agent claiming again (no group given) keeps its port and group (${a.port}, ${a2.group})`);
	const b = await hubOps.claim({ agent: "hermes", group: "Hermes", avoid: [9224, 9225, 9226] });
	assert(b.port !== 9226 && b.port < 9240, `a claim never lands on a reserved port and stays low (${b.port})`);
	let threw = "";
	await hubOps.claim({ agent: "x", port: 9226 }).catch((e) => (threw = e.message));
	assert(/reserved/.test(threw), "claiming 9226 by number is refused");
	await settingsSync();

	// ---- one tab group per agent, reused ----
	const lane = { port: a.port, open: true };
	lanes.set(a.port, lane);
	const t1 = await chrome.tabs.create({ url: "https://a.example" });
	const t2 = await chrome.tabs.create({ url: "https://b.example" });
	claims.set(t1.id, a.port).set(t2.id, a.port);
	const g1 = await groupTabs([t1.id], "Claude", "blue");
	const g2 = await groupTabs([t2.id], "Claude", "blue");
	assert(g1.grouped[t1.id] === g2.grouped[t2.id] && fake.groups.size === 1, "a second batch of an agent's tabs joins its existing group");
	// Chrome's title query is a pattern: "Claude" also matches "Claude › Research". It must not be reused.
	const t3 = await chrome.tabs.create({ url: "https://c.example" });
	await groupTabs([t3.id], "Claude › Research", "blue");
	const t4 = await chrome.tabs.create({ url: "https://d.example" });
	await groupTabs([t4.id], "Claude", "blue");
	assert((await chrome.tabs.get(t4.id)).groupId === g1.grouped[t1.id], "group lookup matches the exact title, not a pattern");
	// Leftover duplicates (from older versions) are folded into one.
	const d1 = await chrome.tabs.create({ url: "https://e.example" });
	const d2 = await chrome.tabs.create({ url: "https://f.example" });
	const dupA = await chrome.tabs.group({ tabIds: [d1.id] });
	await chrome.tabGroups.update(dupA, { title: "Agents" });
	const dupB = await chrome.tabs.group({ tabIds: [d2.id] });
	await chrome.tabGroups.update(dupB, { title: "Agents" });
	await dedupeGroups();
	const agentsGroups = [...fake.groups.values()].filter((g) => g.title === "Agents");
	assert(agentsGroups.length === 1, "duplicate groups with one title in a window are merged into one");
	assert(laneLook(9999).title === "Agents", "a port used without a claim shares the \"Agents\" group, not a new \"Port <n>\" group");

	// ---- cleanup of leftover agent groups ----
	fake = await boot({ groupColors: { Claude: "blue", Hermes: "yellow" } });
	const mk = async (url, title, { agentPort, seen, active } = {}) => {
		const t = await chrome.tabs.create({ url, active });
		if (agentPort) createdTabs.set(t.id, agentPort), claims.set(t.id, agentPort);
		if (seen) seenTabs.add(t.id);
		let g = [...fake.groups.values()].find((x) => x.title === title && x.windowId === 1);
		const gid = await chrome.tabs.group(g ? { tabIds: [t.id], groupId: g.id } : { tabIds: [t.id] });
		await chrome.tabGroups.update(gid, { title });
		return t.id;
	};
	const closeMe = await mk("https://agent-only.example", "Port 9226", { agentPort: 9230 });
	const lookedAt = await mk("https://looked.example", "Port 9226", { agentPort: 9230, seen: true });
	const usersTab = await mk("https://mail.example", "Claude");
	const agentClaude = await mk("https://agent.example", "Claude", { agentPort: 9231 });
	const otherAgents = await mk("https://x.example", "Agents", { agentPort: 9232 });
	const dupAgents = await mk("https://y.example", "Agents", { agentPort: 9232, active: true });
	const personal = await mk("https://bank.example", "Taxes");
	const hung = await mk("https://leave-site.example", "Hermes", { agentPort: 9233 });
	fake.hang.add(hung);
	const before = fake.groups.size;
	const dry = await hubOps.cleanupGroups({ dryRun: true });
	assert(dry.groupsAfter === before && fake.tabs.has(closeMe), "dryRun only reports");
	const started = Date.now();
	const res = await hubOps.cleanupGroups({});
	assert(Date.now() - started < 8000, `a tab stuck closing doesn't hang the cleanup (${Date.now() - started} ms)`);
	assert(!fake.tabs.has(closeMe) && !fake.tabs.has(otherAgents) && !fake.tabs.has(agentClaude), "agent-opened tabs the user never looked at close");
	assert(fake.tabs.has(lookedAt) && fake.tabs.get(lookedAt).groupId === -1, "an agent tab the user looked at stays open, ungrouped");
	assert(fake.tabs.has(dupAgents) && fake.tabs.get(dupAgents).groupId === -1, "the user's active tab stays open, ungrouped");
	assert(fake.tabs.has(usersTab) && fake.tabs.get(usersTab).groupId === -1, "a tab the user opened in an agent-named group is only ungrouped");
	assert(fake.tabs.get(personal).groupId >= 0 && [...fake.groups.values()].map((g) => g.title).join() === "Taxes" || [...fake.groups.values()].every((g) => g.title === "Taxes" || g.title === "Hermes"), "the user's own groups are untouched");
	assert(res.groupsBefore === before && res.groupsAfter <= 2, `groups before ${res.groupsBefore}, after ${res.groupsAfter}`);
	assert(fake.saved.length === 0, `cleanup leaves no saved-group chips behind (saved: ${fake.saved.join(", ") || "none"})`);
	const extra = await hubOps.cleanupGroups({ titles: ["Taxes"], dryRun: true });
	assert(extra.removed.some((r) => r.title === "Taxes"), "extra titles can be named explicitly");
	// Releasing an agent closes its tabs without leaving a saved-group chip.
	fake = await boot({ leases: { 9250: { agent: "temp", group: "Temp", since: 1 } }, groupColors: { Temp: "green" }, ports: [9250] });
	lanes.set(9250, { port: 9250, open: true });
	const r1 = await chrome.tabs.create({ url: "https://r1.example" });
	const r2 = await chrome.tabs.create({ url: "https://r2.example" });
	for (const t of [r1, r2]) createdTabs.set(t.id, 9250), claims.set(t.id, 9250);
	await groupTabs([r1.id, r2.id], "Temp", "green");
	const rel = await hubOps.release({ agent: "temp", all: true });
	assert(rel.closedTabs === 2 && fake.groups.size === 0 && fake.saved.length === 0, `release closes the agent's tabs and its group with no saved chip (saved: ${fake.saved.join(", ") || "none"})`);
	// An agent closing its own last tab (Target.closeTarget) leaves no chip either.
	const r3 = await chrome.tabs.create({ url: "https://r3.example" });
	claims.set(r3.id, 9250);
	await groupTabs([r3.id], "Temp", "green");
	await runRpc(lanes.get(9250), { op: "removeTab", tabId: r3.id });
	assert(fake.saved.length === 0 && !fake.tabs.has(r3.id), "an agent closing its last tab leaves no saved-group chip");
	// A group an agent holds a lease on right now is left alone.
	fake = await boot({ leases: { 9240: { agent: "live", group: "Live", since: Date.now() } }, groupColors: { Live: "red" }, ports: [9240] });
	const live = await chrome.tabs.create({ url: "https://live.example" });
	createdTabs.set(live.id, 9240);
	claims.set(live.id, 9240);
	const lg = await chrome.tabs.group({ tabIds: [live.id] });
	await chrome.tabGroups.update(lg, { title: "Live" });
	await hubOps.cleanupGroups({});
	assert(fake.tabs.has(live.id) && fake.tabs.get(live.id).groupId === lg, "an agent's group in active use is kept");
	console.log("\nall extension checks passed");
} catch (err) {
	console.error(err.stack ?? err.message);
	failed = true;
}
process.exit(failed ? 1 : 0);

async function settingsSync() {
	settings = await loadSettings();
}
