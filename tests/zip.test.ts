import test from "node:test";
import assert from "node:assert/strict";

import { buildZipStream, toAsciiDownloadName, type ZipEntry } from "@/lib/zip";

async function streamToBuffer(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

async function* asyncEntries(entries: ZipEntry[]) {
  for (const entry of entries) yield entry;
}

test("toAsciiDownloadName normalizes non-ascii and whitespace names", () => {
  assert.equal(toAsciiDownloadName(" 策略 包.zip ", "fallback.zip"), ".zip");
  assert.equal(toAsciiDownloadName("Strategy Export.zip", "fallback.zip"), "Strategy-Export.zip");
  assert.equal(toAsciiDownloadName("   ", "fallback.zip"), "fallback.zip");
});

test("buildZipStream writes valid local and central directory records from sync entries", async () => {
  const buffer = await streamToBuffer(
    buildZipStream([
      { path: "folder/a.txt", content: "alpha", updatedAt: "2026-04-23T00:00:00.000Z" },
      { path: "b.txt", content: "beta", updatedAt: "2026-04-23T00:00:00.000Z" }
    ])
  );

  const eocdOffset = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(buffer.readUInt32LE(eocdOffset), 0x06054b50);
  assert.equal(buffer.readUInt16LE(eocdOffset + 10), 2);
  assert.match(buffer.toString("utf8"), /folder\/a\.txt/);
  assert.match(buffer.toString("utf8"), /alpha/);
  assert.match(buffer.toString("utf8"), /b\.txt/);
  assert.match(buffer.toString("utf8"), /beta/);
});

test("buildZipStream accepts async entry sources", async () => {
  const buffer = await streamToBuffer(
    buildZipStream(asyncEntries([{ path: "async.txt", content: "loaded", updatedAt: null }]))
  );

  const eocdOffset = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(buffer.readUInt32LE(eocdOffset), 0x06054b50);
  assert.equal(buffer.readUInt16LE(eocdOffset + 10), 1);
  assert.match(buffer.toString("utf8"), /async\.txt/);
  assert.match(buffer.toString("utf8"), /loaded/);
});
