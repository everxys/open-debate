const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const isWindows = process.platform === "win32";
const rootDir = path.resolve(__dirname, "..");
const binExt = isWindows ? ".cmd" : "";
const nextBin = path.join(rootDir, "node_modules", ".bin", `next${binExt}`);
const tsxBin = path.join(rootDir, "node_modules", ".bin", `tsx${binExt}`);
const devDistDir = path.join(rootDir, ".next-dev");

const children = new Set();
let shuttingDown = false;
let startupCleaned = false;

function quoteWindowsArg(value) {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function startProcess(label, command, args, env) {
  console.log(`[dev] starting ${label}: ${command} ${args.join(" ")}`);
  const child = isWindows
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `${quoteWindowsArg(command)} ${args.map(quoteWindowsArg).join(" ")}`], {
        cwd: rootDir,
        env,
        stdio: "inherit"
      })
    : spawn(command, args, {
        cwd: rootDir,
        env,
        stdio: "inherit"
      });

  children.add(child);

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[dev] ${label} failed to start`, error);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    console.error(`[dev] ${label} exited`, { code, signal });
    shutdown(code ?? 1);
  });

  return child;
}

function killProcess(child) {
  if (!child.pid || child.killed) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killProcess(child);
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function removeNextArtifacts() {
  for (const targetDir of [devDistDir, path.join(rootDir, ".next")]) {
    if (!fs.existsSync(targetDir)) continue;
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`[dev] removed stale build artifacts: ${targetDir}`);
  }
}

function cleanupWindowsRepoProcesses() {
  const repoPattern = rootDir.replace(/\\/g, "\\\\");
  const psScript = `
$ErrorActionPreference='SilentlyContinue'
$repoPattern='${repoPattern}'
$self=${process.pid}
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object {
    $_.ProcessId -ne $self -and
    $_.CommandLine -and
    $_.CommandLine -match $repoPattern -and
    (
      $_.CommandLine -match 'next\\\\dist\\\\bin\\\\next.* dev' -or
      $_.CommandLine -match 'next\\\\dist\\\\server\\\\lib\\\\start-server\\\\.js' -or
      $_.CommandLine -match 'scripts\\\\summary-worker\\\\.ts' -or
      $_.CommandLine -match 'scripts\\\\dev-with-summary-worker\\\\.cjs'
    )
  } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      Write-Output ("[dev] stopped stale repo node process " + $_.ProcessId)
    } catch {}
  }
`.trim();
  const cleaner = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit"
  });
  if (cleaner.error) {
    console.error("[dev] failed to clean stale repo processes", cleaner.error);
  }
  if (cleaner.status && cleaner.status !== 0) {
    console.error("[dev] stale repo process cleanup exited non-zero", { status: cleaner.status });
  }
}

function cleanupBeforeStart() {
  if (startupCleaned) return;
  startupCleaned = true;
  if (isWindows) {
    cleanupWindowsRepoProcesses();
  }
  removeNextArtifacts();
}

cleanupBeforeStart();

startProcess("Next.js", nextBin, ["dev"], {
  ...process.env,
  OPEN_DEBATE_NEXT_DIST_DIR: ".next-dev",
  OPEN_DEBATE_DISABLE_EMBEDDED_SUMMARY_WORKER: "1"
});
startProcess("summary worker", tsxBin, ["scripts/summary-worker.ts"], process.env);
