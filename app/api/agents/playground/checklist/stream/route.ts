import { listPlaygroundChecklistForUser } from "@/lib/playground/checklist";
import { subscribePlaygroundChecklistEvents } from "@/lib/playground/live";
import { toErrorResponse } from "@/lib/http";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  try {
    const session = await readSession();
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId")?.trim() ?? "";
    if (!agentId) {
      return new Response("agentId is required", { status: 400 });
    }

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let unsubscribe = () => {};
    let closed = false;

    const teardown = () => {
      if (closed) return;
      closed = true;
      request.signal.removeEventListener("abort", abort);
      unsubscribe();
    };

    const abort = () => {
      teardown();
      try {
        streamController?.close();
      } catch {
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        streamController = controller;
        const items = await listPlaygroundChecklistForUser(session.userId, agentId);
        controller.enqueue(encoder.encode(sseEvent("hello", { at: new Date().toISOString() })));
        controller.enqueue(encoder.encode(sseEvent("snapshot", { items })));

        unsubscribe = subscribePlaygroundChecklistEvents(session.userId, agentId, (event) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(sseEvent(event.type, event)));
          } catch {
            teardown();
            try {
              controller.close();
            } catch {
            }
          }
        });

        request.signal.addEventListener("abort", abort);
      },
      cancel() {
        teardown();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

