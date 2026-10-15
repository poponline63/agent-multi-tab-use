// Renders extension/icons/logo.svg (and art/logo-small.svg for tiny sizes) to the
// extension PNGs and companion/icon.ico, using headless Chrome's canvas.
// Run: node art/make-icons.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const big = readFileSync(join(root, "extension/icons/logo.svg"), "utf8");
const small = readFileSync(join(root, "art/logo-small.svg"), "utf8");
const svgFor = (size) => (size <= 24 ? small : big);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const profile = mkdtempSync(join(tmpdir(), "amtu-icons-"));
const port = 9500 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore", windowsHide: true });
try {
	let page;
	for (let i = 0; i < 60 && !page; i++) {
		await new Promise((r) => setTimeout(r, 250));
		page = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let id = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		pending.get(m.id)?.(m);
	};
	const evaluate = (expression) =>
		new Promise((resolve, reject) => {
			const i = ++id;
			pending.set(i, (m) => (m.result?.exceptionDetails ? reject(new Error(m.result.exceptionDetails.text)) : resolve(m.result.result.value)));
			ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
		});
	const render = (size) =>
		evaluate(`(async () => {
			const img = new Image();
			img.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svgFor(size)).toString("base64"))};
			await img.decode();
			const c = document.createElement("canvas");
			c.width = c.height = ${size};
			const g = c.getContext("2d");
			g.drawImage(img, 0, 0, ${size}, ${size});
			return { png: c.toDataURL("image/png").split(",")[1], rgba: Array.from(g.getImageData(0, 0, ${size}, ${size}).data) };
		})()`);

	for (const size of [16, 32, 48, 128]) writeFileSync(join(root, `extension/icons/icon${size}.png`), Buffer.from((await render(size)).png, "base64"));

	// ICO: 32-bit DIB frames up to 64px (System.Drawing and old shells read these reliably), PNG for 256.
	const frames = [];
	for (const size of [16, 20, 24, 32, 40, 48, 64, 256]) {
		const { png, rgba } = await render(size);
		if (size === 256) {
			frames.push({ size, data: Buffer.from(png, "base64") });
			continue;
		}
		const maskRow = Math.ceil(size / 32) * 4;
		const dib = Buffer.alloc(40 + size * size * 4 + maskRow * size);
		dib.writeUInt32LE(40, 0);
		dib.writeInt32LE(size, 4);
		dib.writeInt32LE(size * 2, 8);
		dib.writeUInt16LE(1, 12);
		dib.writeUInt16LE(32, 14);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const s = ((size - 1 - y) * size + x) * 4;
				const d = 40 + (y * size + x) * 4;
				dib[d] = rgba[s + 2];
				dib[d + 1] = rgba[s + 1];
				dib[d + 2] = rgba[s];
				dib[d + 3] = rgba[s + 3];
			}
		frames.push({ size, data: dib });
	}
	const header = Buffer.alloc(6 + 16 * frames.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(frames.length, 4);
	let offset = header.length;
	frames.forEach(({ size, data }, i) => {
		const e = 6 + 16 * i;
		header[e] = header[e + 1] = size >= 256 ? 0 : size;
		header.writeUInt16LE(1, e + 4);
		header.writeUInt16LE(32, e + 6);
		header.writeUInt32LE(data.length, e + 8);
		header.writeUInt32LE(offset, e + 12);
		offset += data.length;
	});
	writeFileSync(join(root, "companion/icon.ico"), Buffer.concat([header, ...frames.map((f) => f.data)]));
	ws.close();
	console.log("icons written");
} finally {
	chrome.kill();
	setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
