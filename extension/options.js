const HUB_API = "http://127.0.0.1:9223";
const $ = (id) => document.getElementById(id);

let shareTabs = false;
let hubOnline = false;

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
	toast.timer = setTimeout(() => t.classList.remove("show"), 1600);
}
function api(path, body) {
	return fetch(HUB_API + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
}
function idleText(minutes) {
	if (!minutes) return "active";
	return minutes < 60 ? `idle ${minutes} min` : `idle ${Math.floor(minutes / 60)} h`;
}

function renderAgents(status) {
	const held = (status?.ports ?? []).filter((p) => p.agent);
	const colorOf = new Map((status?.groups ?? []).map((g) => [g.name, g.color]));
	$("live").textContent = (status?.ports ?? []).filter((p) => p.live).length;
	$("total").textContent = held.length;
	$("claimed").textContent = held.reduce((sum, p) => sum + p.tabs, 0);
	if (!status) {
		$("agents").replaceChildren(el("p", { className: "empty", textContent: "Start the companion app to see agents here." }));
		return;
	}
	const rows = held
		.sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.agent.localeCompare(b.agent))
		.map((p) => {
			const release = el("button", { className: "btn ghost", type: "button", textContent: "Release", title: "Free this port. Tabs the agent opened close, except ones you've looked at." });
			release.addEventListener("click", async () => {
				release.disabled = true;
				const result = await api("/release", { agent: p.agent, port: p.port }).catch((err) => ({ error: String(err) }));
				toast(result.error ? result.error : `Released ${p.agent}${result.closedTabs ? `, closed ${result.closedTabs} tab${result.closedTabs === 1 ? "" : "s"}` : ""}`);
				refresh();
			});
			const row = el(
				"div",
				{ className: `agent${p.idleMinutes ? " idle" : ""}` },
				el("span", { className: "swatch-dot" }),
				el("div", { className: "who" }, el("b", { textContent: p.agent }), el("span", { textContent: `${p.group ?? `Port ${p.port}`} · port ${p.port}` })),
				el("span", { className: "stat", textContent: `${p.tabs} ${p.tabs === 1 ? "tab" : "tabs"}` }),
				el("span", { className: "stat", textContent: idleText(p.idleMinutes) }),
				release,
			);
			row.style.setProperty("--c", `var(--${colorOf.get(p.group) ?? "grey"})`);
			return row;
		});
	const free = status.ports.length - held.length;
	const foot = el("p", { className: "empty", textContent: `${free} free ${free === 1 ? "port" : "ports"} ready for the next agent.` });
	$("agents").replaceChildren(...(rows.length ? rows : [el("p", { className: "empty", textContent: "No agents right now." })]), foot);
}

function renderPrompt() {
	const group = $("promptGroup").value.trim() || "Agents";
	$("prompt").textContent = buildAgentPrompt({ claimBody: { agent: "your-name", group }, groupName: group, shareTabs });
}

async function refresh() {
	const { hubOnline: online = false, appVersion } = await chrome.storage.session.get(["hubOnline", "appVersion"]).catch(() => ({}));
	hubOnline = online;
	$("hub").className = hubOnline ? "on" : "off";
	$("hub").lastChild.textContent = hubOnline ? " online" : " offline";
	$("appCard").className = `card app-card ${hubOnline ? "online" : "offline"}`;
	$("appBanner").hidden = hubOnline;
	$("appTitle").textContent = hubOnline ? "Companion app is running" : "Companion app not detected";
	const extVersion = chrome.runtime.getManifest().version;
	const mismatch = hubOnline && appVersion && appVersion !== extVersion;
	$("appSub").textContent = hubOnline
		? `App ${appVersion ?? "?"} · Extension ${extVersion} · on 127.0.0.1:9223, starts with Windows.${mismatch ? " Versions differ: update whichever is older." : ""}`
		: `Extension ${extVersion}. Install the app, or open AgentMultiTabUse.exe if it's already installed. Agents can't connect until it runs.`;
	$("appSub").classList.toggle("warn", !!mismatch);
	renderAgents(hubOnline ? await api("/status").catch(() => null) : null);
}

$("download").href = DOWNLOAD_URL;
$("shareTabs").addEventListener("change", (e) => {
	chrome.storage.local.set({ shareTabs: e.target.checked });
	toast(e.target.checked ? "Agents can now see your own tabs" : "Agents only see tabs they opened");
});
$("promptGroup").addEventListener("input", renderPrompt);
$("copyPrompt").addEventListener("click", async () => {
	await navigator.clipboard.writeText($("prompt").textContent);
	toast("Agent instructions copied");
});

async function loadSettings() {
	({ shareTabs = false } = await chrome.storage.local.get({ shareTabs: false }));
	$("shareTabs").checked = shareTabs;
	renderPrompt();
}
chrome.storage.onChanged.addListener((_changes, area) => {
	if (area === "local") loadSettings();
	refresh();
});
setInterval(() => document.visibilityState === "visible" && refresh(), 5000);
loadSettings()
	.then(refresh)
	.then(() => setTimeout(() => document.body.classList.add("settled"), 900));
