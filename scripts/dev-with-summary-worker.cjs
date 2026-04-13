const { spawn } = require("node:child_process");
const path = require("node:path");

const isWindows = process.platform === "win32";
const rootDir = path.resolve(__dirname, "..");
const binExt = isWindows ? ".cmd" : "";
const nextBin = path.join(rootDir, "node_modules", ".bin", `next${binExt}`);
const tsxBin = path.join(rootDir, "node_modules", ".bin", `tsx${binExt}`);

const children = new Set();
let shuttingDown = false;

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

startProcess("Next.js", nextBin, ["dev"], {
  ...process.env,
  OPEN_DEBATE_DISABLE_EMBEDDED_SUMMARY_WORKER: "1"
});
startProcess("summary worker", tsxBin, ["scripts/summary-worker.ts"], process.env);
