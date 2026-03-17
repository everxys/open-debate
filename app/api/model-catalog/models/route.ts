import { NextResponse } from "next/server";

import { listCatalogModels } from "@/lib/model-catalog";
import { toErrorResponse } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const source = url.searchParams.get("source") ?? "openrouter";
    if (source !== "openrouter") {
      return NextResponse.json({ success: true, data: [] });
    }
    const models = await listCatalogModels("openrouter");
    return NextResponse.json({ success: true, data: models });
  } catch (error) {
    return toErrorResponse(error);
  }
}

