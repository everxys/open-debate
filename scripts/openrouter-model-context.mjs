#!/usr/bin/env node
/**
 * Fetch model context length metadata from OpenRouter.
 *
 * Uses the official Models API instead of HTML scraping:
 *   GET https://openrouter.ai/api/v1/models
 *
 * Examples:
 *   node scripts/openrouter-model-context.mjs --model openai/gpt-5.1
 *   node scripts/openrouter-model-context.mjs --match "claude|gpt" --pretty
 *   node scripts/openrouter-model-context.mjs --out data/openrouter-models.json
 */

import fs from "node:fs";

function parseArgs(argv) {
  const args = {
    models: [],
    match: null,
    out: null,
    pretty: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--model" || token === "-m") {
      const value = argv[i + 1] ?? "";
      if (value) args.models.push(String(value));
      i += 1;
      continue;
    }
    if (token === "--match" || token === "-r") {
      const value = argv[i + 1] ?? "";
      if (value) args.match = String(value);
      i += 1;
      continue;
    }
    if (token === "--out" || token === "-o") {
      const value = argv[i + 1] ?? "";
      if (value) args.out = String(value);
      i += 1;
      continue;
    }
    if (token === "--pretty") {
      args.pretty = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { ...args, help: true };
    }
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/openrouter-model-context.mjs [--model <id> ...] [--match <regex>] [--out <path>] [--pretty]",
    "",
    "Options:",
    "  --model, -m   Filter by exact model id (repeatable)",
    "  --match, -r   Filter by regex (applies to id + name)",
    "  --out, -o     Write JSON output to a file",
    "  --pretty      Pretty-print JSON",
    ""
  ].join("\n");
}

function toInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v > 0 ? v : null;
}

async function fetchModels() {
  const url = "https://openrouter.ai/api/v1/models";
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter models fetch failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const payload = await response.json();
  const list = payload && Array.isArray(payload.data) ? payload.data : [];
  return list;
}

function extractContextLength(model) {
  // OpenRouter schema includes provider context in top_provider.context_length.
  // Some provider integrations use context_length at top-level.
  const topProvider = model && typeof model.top_provider === "object" && model.top_provider ? model.top_provider : null;
  return (
    toInt(topProvider?.context_length) ??
    toInt(model?.context_length) ??
    toInt(model?.contextLength) ??
    null
  );
}

function buildOutput(models) {
  const out = [];
  for (const m of models) {
    const id = typeof m?.id === "string" ? m.id : "";
    const name = typeof m?.name === "string" ? m.name : "";
    if (!id) continue;
    const contextLength = extractContextLength(m);
    out.push({ id, name, context_length: contextLength });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function applyFilters(rows, args) {
  let filtered = rows.slice();

  if (args.models.length > 0) {
    const allow = new Set(args.models);
    filtered = filtered.filter((row) => allow.has(row.id));
  }

  if (args.match) {
    let re = null;
    try {
      re = new RegExp(args.match, "i");
    } catch (err) {
      throw new Error(`Invalid --match regex: ${String(err instanceof Error ? err.message : err)}`);
    }
    filtered = filtered.filter((row) => re.test(row.id) || re.test(row.name));
  }

  return filtered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const models = await fetchModels();
  const rows = buildOutput(models);
  const filtered = applyFilters(rows, args);

  const json = JSON.stringify(filtered, null, args.pretty ? 2 : 0);
  if (args.out) {
    fs.writeFileSync(args.out, json + "\n", "utf8");
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\n");
  process.exitCode = 1;
});

