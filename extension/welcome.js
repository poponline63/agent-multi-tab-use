document.getElementById("download").href = DOWNLOAD_URL;

async function showStatus() {
	const { hubOnline = false } = await chrome.storage.session.get("hubOnline").catch(() => ({}));
	const status = document.getElementById("status");
	status.className = `status${hubOnline ? " on" : ""}`;
	status.textContent = hubOnline ? "Connected" : "Waiting for the app";
	document.getElementById("step1").classList.toggle("done", hubOnline);
	document.getElementById("step2").classList.toggle("done", hubOnline);
}

chrome.storage.onChanged.addListener((_changes, area) => area === "session" && showStatus());
showStatus();
