// Live check of the MCP server against the running hub + Chrome: node mcp/selfcheck.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], {
	env: { ...process.env, AMTU_AGENT: "selfcheck", AMTU_GROUP: "MCP selfcheck" },
	stdio: ["pipe", "pipe", "inherit"],
});
const waiting = new Map();
let id = 0;
createInterface({ input: child.stdout }).on("line", (l) => {
	const m = JSON.parse(l);
	waiting.get(m.id)?.(m);
});
const rpc = (method, params) =>
	new Promise((resolve) => {
		waiting.set(++id, resolve);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
const call = async (name, args = {}) => {
	const { result } = await rpc("tools/call", { name, arguments: args });
	assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
	return result.content;
};
const text = async (name, args) => (await call(name, args))[0].text;

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selfcheck", version: "1" } });
assert.equal(init.result.serverInfo.name, "agent-multi-tab-use");
const { result: list } = await rpc("tools/list", {});
const names = list.tools.map((t) => t.name);
for (const n of ["browser_claim", "browser_open", "browser_read", "browser_click", "browser_type", "browser_screenshot", "browser_release"]) assert.ok(names.includes(n), n);

assert.match(await text("browser_claim"), /port \d+/);
assert.match(await text("browser_open", { url: "https://example.com" }), /Example Domain/);
const page = await text("browser_read");
const ref = page.match(/\[(\d+)\] a /)?.[1];
assert.ok(ref, `no link numbered in:\n${page}`);
assert.match(await text("browser_click", { ref: Number(ref) }), /url: https:\/\/(www\.)?iana\.org/);

assert.match(await text("browser_open", { url: "https://duckduckgo.com/html/" }), /DuckDuckGo/i);
assert.match(await text("browser_type", { selector: "input[name=q]", value: "agent multi tab use", submit: true }), /agent multi tab use|q=agent/i);

const [shot] = await call("browser_screenshot");
assert.equal(shot.type, "image");
assert.equal(Buffer.from(shot.data, "base64").subarray(1, 4).toString(), "PNG");
assert.equal(await text("browser_eval", { js: "1 + 1" }), "2");
assert.equal((await text("browser_tabs")).split("\n").length, 2);
assert.match(await text("browser_release"), /released port/);
const err = (await rpc("tools/call", { name: "browser_read", arguments: {} })).result;
assert.ok(err.isError, "read after release must fail cleanly");

child.stdin.end();
console.log("selfcheck: all MCP tools passed against live Chrome");
