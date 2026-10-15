// Builds dist/AgentMultiTabUse.exe: the tray helper (csc.exe from Windows' .NET
// Framework), then the bun exe with the helper embedded, then marks the exe as a
// GUI program so Windows never opens a console window for it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "./package.json";
const run = (cmd) => {
	const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
	if (r.exitCode !== 0) throw new Error(`failed: ${cmd[0]}`);
};

run([
	join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
	"/nologo", "/target:winexe", "/optimize", "/out:tray\\tray.exe", "/win32icon:icon.ico", "/resource:icon.ico,AppIcon.ico",
	"/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "tray\\tray.cs", // csc reads "/" as a switch prefix
]);
run([
	process.execPath, "build", "main.js", "--compile", "--windows-icon=icon.ico", "--windows-title=Agent Multi Tab Use",
	"--windows-description=Companion app for the Agent Multi Tab Use Chrome extension", `--windows-version=${VERSION}.0`,
	"--outfile=dist/AgentMultiTabUse.exe",
]);

// ponytail: Bun 1.3's --windows-hide-console still leaves the console subsystem (a cmd
// window flashes at login), so patch the PE header: IMAGE_SUBSYSTEM_WINDOWS_GUI = 2.
const exe = readFileSync("dist/AgentMultiTabUse.exe");
exe.writeUInt16LE(2, exe.readUInt32LE(0x3c) + 24 + 68);
writeFileSync("dist/AgentMultiTabUse.exe", exe);
console.log(`built dist/AgentMultiTabUse.exe ${VERSION} (GUI subsystem, tray embedded)`);
