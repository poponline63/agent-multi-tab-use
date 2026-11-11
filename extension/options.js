const HUB_API = "http://127.0.0.1:9223";
const $ = (id) => document.getElementById(id);

let shareTabs = true;

function el(tag, props = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}
function toast(text) {
	const t = $("toast");
	t.textContent = text;
	t.classList.add("show");
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}
function api(path, body) {
	return fetch(HUB_API + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function idleText(minutes) {
	if (!minutes) return "active";
	return minutes < 60 ? `idle ${minutes}m` : `idle ${Math.floor(minutes / 60)}h`;
}

function setStatus(kind, text) {
	$("status").className = `pill ${kind}`;
	$("status").lastChild.textContent = text;
}

function renderAgents(status) {
	const ports = status?.ports ?? [];
	const held = ports.filter((p) => p.agent);
	const colorOf = new Map((status?.groups ?? []).map((g) => [g.name, g.color]));
	$("total").textContent = held.length;
	$("claimed").textContent = ports.reduce((sum, p) => sum + p.tabs, 0);
	$("free").textContent = ports.filter((p) => !p.agent && !p.tabs).length;
	if (!status) {
		$("agents").replaceChildren(el("p", { className: "empty", textContent: "Start the companion app to see agents here." }));
		return;
	}
	const rows = held
		.sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.agent.localeCompare(b.agent))
		.map((p) => {
			const release = el("button", { className: "btn ghost", type: "button", textContent: "Release", title: "Free this port. Its tabs close, except ones you looked at." });
			release.addEventListener("click", async () => {
				release.disabled = true;
				const result = await api("/release", { agent: p.agent, port: p.port }).catch((err) => ({ error: String(err) }));
				toast(result.error ?? `Released ${p.agent}${result.closedTabs ? `, closed ${plural(result.closedTabs, "tab")}` : ""}`);
				refresh();
			});
			const row = el(
				"div",
				{ className: "agent" },
				el("span", { className: "dot" }),
				el("div", {}, el("b", { textContent: p.agent }), el("small", { textContent: `${p.group ?? "Agents"} · :${p.port}` })),
				el("span", { className: "meta", textContent: `${plural(p.tabs, "tab")} · ${idleText(p.idleMinutes)}` }),
				release,
			);
			row.style.setProperty("--c", `var(--${colorOf.get(p.group) ?? "grey"})`);
			return row;
		});
	$("agents").replaceChildren(...(rows.length ? rows : [el("p", { className: "empty", textContent: "No agents right now." })]));
}

function renderPrompt() {
	const group = $("promptGroup").value.trim() || "Agents";
	$("prompt").textContent = buildAgentPrompt({ claimBody: { agent: "your-name", group }, groupName: group, shareTabs });
}

async function refresh() {
	const { hubOnline = false, appVersion } = await chrome.storage.session.get(["hubOnline", "appVersion"]).catch(() => ({}));
	const extVersion = chrome.runtime.getManifest().version;
	const mismatch = hubOnline && appVersion && appVersion !== extVersion;
	$("appBanner").hidden = hubOnline;
	$("cleanup").disabled = !hubOnline;
	if (!hubOnline) setStatus("off", "App not running");
	else if (mismatch) setStatus("warn", `Update needed: app ${appVersion}, extension ${extVersion}`);
	else setStatus("on", `Running · v${extVersion}`);
	renderAgents(hubOnline ? await api("/status").catch(() => null) : null);
}

$("download").href = DOWNLOAD_URL;
$("shareTabs").addEventListener("change", (e) => {
	chrome.storage.local.set({ shareTabs: e.target.checked });
	toast(e.target.checked ? "Agents can see your tabs" : "Agents only see tabs they opened");
});
$("promptGroup").addEventListener("input", renderPrompt);
$("copyPrompt").addEventListener("click", async () => {
	await navigator.clipboard.writeText($("prompt").textContent);
	toast("Copied. Paste it into your agent.");
});
$("cleanup").addEventListener("click", async () => {
	$("cleanup").disabled = true;
	const r = await api("/groups/cleanup", {}).catch((err) => ({ error: String(err) }));
	toast(r.error ?? (r.removed?.length ? `Removed ${plural(r.removed.length, "group")}, closed ${plural(r.closedTabs, "tab")}` : "Nothing to clean up"));
	refresh();
});

async function loadSettings() {
	({ shareTabs = true } = await chrome.storage.local.get({ shareTabs: true }));
	$("shareTabs").checked = shareTabs;
	renderPrompt();
}
chrome.storage.onChanged.addListener((_changes, area) => {
	if (area === "local") loadSettings();
	refresh();
});
setInterval(() => document.visibilityState === "visible" && refresh(), 5000);
loadSettings().then(refresh);
