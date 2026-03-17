import { query } from "@/lib/db";
import { subscribeDebateLiveEvents, getDebateLiveProgress } from "@/lib/debate-live";
import { toErrorResponse } from "@/lib/http";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";

function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function requireDebateOwnership(debateId: string, userId: string) {
  const result = await query<{ user_id: string; is_shared: boolean }>(
    "select user_id, is_shared from debates where id = $1",
    [debateId]
  );
  if ((result.rowCount ?? 0) !== 1) return false;
  const row = result.rows[0];
  return String(row.user_id) === userId || Boolean(row.is_shared);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await readSession();
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { id } = await context.params;
    const ok = await requireDebateOwnership(id, session.userId);
    if (!ok) {
      return new Response("Not found", { status: 404 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let unsubscribe = () => {};
        const abort = () => {
          controller.close();
          request.signal.removeEventListener("abort", abort);
          unsubscribe();
        };

        const initial = getDebateLiveProgress(id);
        if (initial) {
          controller.enqueue(encoder.encode(sseEvent("turn_start", { progress: initial })));
        }
        controller.enqueue(encoder.encode(sseEvent("hello", { at: new Date().toISOString() })));

        unsubscribe = subscribeDebateLiveEvents(id, (evt) => {
          controller.enqueue(encoder.encode(sseEvent(evt.type, evt)));
        });

        request.signal.addEventListener("abort", abort);
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
