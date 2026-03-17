import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readRepoTextFile(filePath: string) {
  const full = path.join(process.cwd(), filePath);
  return readFile(full, "utf8");
}

