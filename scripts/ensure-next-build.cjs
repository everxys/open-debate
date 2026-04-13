const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const nextDir = path.join(projectRoot, ".next");
const requiredFiles = ["BUILD_ID", "prerender-manifest.json", "routes-manifest.json"];

function hasCompleteBuildOutput() {
  try {
    return requiredFiles.every((file) => fs.existsSync(path.join(nextDir, file)));
  } catch {
    return false;
  }
}

function runBuild() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, ["run", "build"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!hasCompleteBuildOutput()) {
  console.warn("[ensure-next-build] Incomplete .next output detected, rebuilding before start...");
  runBuild();
}
