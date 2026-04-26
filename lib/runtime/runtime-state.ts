import { sql } from "kysely";

import { ensureDb, ensureDebateAutoRecoverColumns } from "@/lib/db";
import { describeRuntimeError } from "@/lib/runtime/provider-shared";
import { normalizeDebateRow } from "@/lib/runtime/runtime-parsing";
import type { DebateRecord } from "@/lib/types";

type DebatePhaseSnapshot = Pick<DebateRecord, "workflowPhaseKind" | "workflowPhaseTitle" | "workflowPhaseRound"> | null;
type DebateRuntimeNotice = Pick<DebateRecord, "runtimeNoticeKind" | "runtimeNoticeMessage" | "runtimeNoticeAt"> | null;

export async function finishDebate(
  id: string,
  status: "completed" | "stopped" | "failed",
  reason?: string,
  options?: {
    phase?: DebatePhaseSnapshot;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  }
) {
  const db = await ensureDb();
  const now = new Date().toISOString();
  const lastErrorCode = options?.lastErrorCode ?? null;
  const lastErrorMessage = options?.lastErrorMessage ?? null;
  const hasRuntimeError = lastErrorCode !== null || lastErrorMessage !== null;

  const row = await db
    .updateTable("debates")
    .set({
      status,
      finished_at: now,
      stopped_reason: reason ?? null,
      workflow_phase_kind: options?.phase?.workflowPhaseKind ?? null,
      workflow_phase_title: options?.phase?.workflowPhaseTitle ?? null,
      workflow_phase_round: options?.phase?.workflowPhaseRound ?? null,
      runtime_notice_kind: null,
      runtime_notice_message: null,
      runtime_notice_at: null,
      ...(lastErrorCode !== null ? { last_error_code: lastErrorCode } : {}),
      ...(lastErrorMessage !== null ? { last_error_message: lastErrorMessage } : {}),
      ...(hasRuntimeError
        ? {
            ignored_runtime_error_signature: null,
            ignored_runtime_error_at: null
          }
        : {}),
      updated_at: now
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  return row ? normalizeDebateRow(row as Record<string, unknown>) : null;
}

export async function autoRecoverFailedDebateOnce(input: {
  debateId: string;
  userId: string;
  phase?: DebatePhaseSnapshot;
}) {
  const now = new Date().toISOString();

  async function executeRecover() {
    const db = await ensureDb();
    return db
      .updateTable("debates")
      .set({
        status: "running",
        finished_at: null,
        stopped_reason: null,
        workflow_phase_kind: input.phase?.workflowPhaseKind ?? null,
        workflow_phase_title: input.phase?.workflowPhaseTitle ?? null,
        workflow_phase_round: input.phase?.workflowPhaseRound ?? null,
        runtime_notice_kind: "recovered",
        runtime_notice_message: "已按一次性自动恢复设置自动重试；如果再次失败，将停留在 failed",
        runtime_notice_at: now,
        last_error_code: null,
        last_error_message: null,
        ignored_runtime_error_signature: null,
        ignored_runtime_error_at: null,
        auto_recover_once_on_failed: false,
        auto_recover_once_used_at: now,
        updated_at: now
      })
      .where("id", "=", input.debateId)
      .where("user_id", "=", input.userId)
      .where("status", "=", "failed")
      .where("auto_recover_once_on_failed", "=", true)
      .returningAll()
      .executeTakeFirst();
  }

  let row;
  try {
    row = await executeRecover();
  } catch (error) {
    const details = describeRuntimeError(error);
    if (String(details.code ?? "") === "42703" && String(details.message ?? "").toLowerCase().includes("auto_recover_once_on_failed")) {
      await ensureDebateAutoRecoverColumns();
      row = await executeRecover();
    } else {
      throw error;
    }
  }
  return row ? normalizeDebateRow(row as Record<string, unknown>) : null;
}

export async function setDebateRuntimeNotice(id: string, notice: DebateRuntimeNotice) {
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debates
        set runtime_notice_kind = ${notice?.runtimeNoticeKind ?? null},
            runtime_notice_message = ${notice?.runtimeNoticeMessage ?? null},
            runtime_notice_at = ${notice?.runtimeNoticeAt ?? null}
      where id = ${id}
  `.compile(db));
}

export function isRecoverableRuntimeInterruption(details: { code?: string | null; message?: string | null }) {
  const code = String(details.code ?? "").toUpperCase();
  const message = String(details.message ?? "").toLowerCase();
  if (code === "AI_NETWORK_ERROR") return true;
  const patterns = [
    "fetch failed",
    "network",
    "socket hang up",
    "econnreset",
    "etimedout",
    "timeout",
    "timed out",
    "aborted",
    "aborterror",
    "terminated",
    "eai_again",
    "enotfound",
    "connection closed",
    "other side closed",
    "client network socket disconnected"
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

export function isNonRetryableSummaryJobError(error: unknown) {
  const details =
    typeof error === "string"
      ? {
          code: "",
          message: error
        }
      : describeRuntimeError(error);
  const code = String(details.code ?? "").toUpperCase();
  const message = String(details.message ?? "").toLowerCase();
  if (code === "AI_DEMO_KEY_DISABLED" || code === "AI_INVALID_API_KEY" || code === "AI_AUTH_ERROR") {
    return true;
  }
  const patterns = [
    "invalid_api_key",
    "invalid access token",
    "token expired",
    "incorrect api key",
    "unauthorized",
    "authentication failed"
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

export async function pauseDebateAfterRuntimeInterruption(
  id: string,
  reason: string,
  options?: {
    phase?: DebatePhaseSnapshot;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  }
) {
  const now = new Date().toISOString();
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debates
        set status = case
              when status = 'running' then 'paused'
              else status
            end,
            stopped_reason = ${reason},
            workflow_phase_kind = ${options?.phase?.workflowPhaseKind ?? null},
            workflow_phase_title = ${options?.phase?.workflowPhaseTitle ?? null},
            workflow_phase_round = ${options?.phase?.workflowPhaseRound ?? null},
            runtime_notice_kind = ${"interrupted"},
            runtime_notice_message = ${"检测到运行时中断或网络断开，系统已自动暂停这场辩论；恢复设备或网络后可继续运行"},
            runtime_notice_at = ${now},
            last_error_code = coalesce(${options?.lastErrorCode ?? null}, last_error_code),
            last_error_message = coalesce(${options?.lastErrorMessage ?? null}, last_error_message),
            ignored_runtime_error_signature = case
              when ${options?.lastErrorCode ?? null} is not null or ${options?.lastErrorMessage ?? null} is not null then null
              else ignored_runtime_error_signature
            end,
            ignored_runtime_error_at = case
              when ${options?.lastErrorCode ?? null} is not null or ${options?.lastErrorMessage ?? null} is not null then null
              else ignored_runtime_error_at
            end,
            updated_at = ${now}
      where id = ${id}
  `.compile(db));
}

export async function persistDebatePhaseSnapshot(id: string, phase: DebatePhaseSnapshot) {
  const db = await ensureDb();
  await db.executeQuery(sql`
    update debates
        set workflow_phase_kind = ${phase?.workflowPhaseKind ?? null},
            workflow_phase_title = ${phase?.workflowPhaseTitle ?? null},
            workflow_phase_round = ${phase?.workflowPhaseRound ?? null}
      where id = ${id}
  `.compile(db));
}
