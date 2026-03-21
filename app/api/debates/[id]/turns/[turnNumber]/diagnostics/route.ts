import { NextResponse } from "next/server";

import { readDebateFile } from "@/lib/debates";
import { toErrorResponse } from "@/lib/http";

type GenerationDiagnosticEntry = {
  turnNumber: number;
};

const DIAGNOSTICS_PATH = "context/generation_diagnostics.jsonl";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; turnNumber: string }> }
) {
  try {
    const { id, turnNumber } = await context.params;
    const safeTurnNumber = Number(turnNumber);
    const file = await readDebateFile(id, DIAGNOSTICS_PATH);
    const entry =
      String(file.content ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as GenerationDiagnosticEntry;
          } catch {
            return null;
          }
        })
        .filter((item): item is GenerationDiagnosticEntry => Boolean(item))
        .reverse()
        .find((item) => Number(item.turnNumber) === safeTurnNumber) ?? null;
    return NextResponse.json({ success: true, data: entry });
  } catch (error) {
    return toErrorResponse(error);
  }
}
