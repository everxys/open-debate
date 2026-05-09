import { sql } from "kysely";

import { requireSessionUser } from "@/lib/auth";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";

type ManagedFileScope = "debate" | "agent";

type ActivityRow = {
  id: string;
  action: string;
  scope: ManagedFileScope;
  path: string;
  target_debate_agent_id: string | null;
  created_at: string;
  turn_number: number;
  round_number: number;
  before_version: number | null;
  after_version: number | null;
  target_heading: string | null;
  reason: string | null;
  actor_display: string | null;
  actor_role_type: string | null;
};

type BaseFileRow = {
  scope: ManagedFileScope;
  path: string;
  debate_agent_id: string | null;
  created_at: string;
  updated_at: string;
  version: number | null;
  content: string;
};

type BaseFileMetadataRow = Omit<BaseFileRow, "content">;

type ActivitySummaryRow = {
  scope: ManagedFileScope;
  path: string;
  target_debate_agent_id: string | null;
  read_count: number;
  write_count: number;
  last_read_at: string | null;
  last_read_by: string | null;
  last_write_at: string | null;
  last_write_by: string | null;
  last_event_at: string | null;
};

export type DebateManagedFileStatus = {
  scope: ManagedFileScope;
  path: string;
  debateAgentId: string | null;
  version: number | null;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  lastReadBy: string | null;
  lastWrittenAt: string | null;
  lastWrittenBy: string | null;
  readCount: number;
  writeCount: number;
  lastEventType: "read" | "write" | null;
  lastEventAt: string | null;
};

export type DebateManagedFileInfo = {
  scope: ManagedFileScope;
  path: string;
  debateAgentId: string | null;
  charCount: number;
  byteSize: number;
  version: number | null;
  totalVersions: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  lastWrittenAt: string | null;
  lastWrittenBy: string | null;
  lastReadAt: string | null;
  lastReadBy: string | null;
  readCount: number;
  writeCount: number;
  versions: Array<{
    version: number | null;
    at: string;
    actorName: string | null;
    actorRoleType: string | null;
    baseVersion: number | null;
    mode: string | null;
    reason: string | null;
  }>;
  events: Array<{
    id: string;
    type: "created" | "written" | "read";
    at: string;
    actorName: string | null;
    actorRoleType: string | null;
    roundNumber: number | null;
    turnNumber: number | null;
    beforeVersion: number | null;
    afterVersion: number | null;
    targetHeading: string | null;
    reason: string | null;
  }>;
};

function normalizeManagedPath(path: string) {
  return String(path ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function toManagedKey(scope: ManagedFileScope, path: string, debateAgentId: string | null) {
  return `${scope}|${debateAgentId ?? ""}|${normalizeManagedPath(path)}`;
}

async function requireDebateOwner(debateId: string, userId: string) {
  const db = await ensureDb();
  const row = await db
    .selectFrom("debates")
    .select("id")
    .where("id", "=", debateId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("NOT_FOUND", 404, "Debate not found");
  }
}

async function loadBaseManagedFiles(debateId: string) {
  const db = await ensureDb();
  const result = await db.executeQuery<BaseFileMetadataRow>(sql`
    select
      scope,
      path,
      debate_agent_id,
      created_at,
      updated_at,
      version
    from (
      select
        0 as sort_order,
        'debate'::text as scope,
        f.path,
        null::uuid as debate_agent_id,
        f.created_at,
        f.updated_at,
        f.version
      from debate_files f
      where f.debate_id = ${debateId}
      union all
      select
        1 as sort_order,
        'agent'::text as scope,
        f.path,
        f.debate_agent_id,
        f.created_at,
        f.updated_at,
        null::int as version
      from debate_agent_files f
      join debate_agents da on da.id = f.debate_agent_id
      where da.debate_id = ${debateId}
    ) managed_files
    order by sort_order asc, debate_agent_id asc nulls first, path asc
  `.compile(db));
  return result.rows;
}

async function loadManagedFileActivitySummaries(debateId: string) {
  const db = await ensureDb();
  const actorDisplay = sql<string>`
    case
      when l.reason like 'summarizer:%' then '独立总结器'
      else coalesce(da.display_name, a.name, 'Unknown')
    end
  `;
  const result = await db.executeQuery<ActivitySummaryRow>(sql`
    select
      l.scope,
      l.path,
      l.target_debate_agent_id,
      count(*) filter (where l.action <> 'write')::int as read_count,
      count(*) filter (where l.action = 'write')::int as write_count,
      (array_agg(l.created_at order by l.created_at desc, l.id desc) filter (where l.action <> 'write'))[1] as last_read_at,
      (array_agg(${actorDisplay} order by l.created_at desc, l.id desc) filter (where l.action <> 'write'))[1] as last_read_by,
      (array_agg(l.created_at order by l.created_at desc, l.id desc) filter (where l.action = 'write'))[1] as last_write_at,
      (array_agg(${actorDisplay} order by l.created_at desc, l.id desc) filter (where l.action = 'write'))[1] as last_write_by,
      (array_agg(l.created_at order by l.created_at desc, l.id desc))[1] as last_event_at
    from debate_file_activity_logs l
    join debate_agents da on da.id = l.debate_agent_id
    join ai_agents a on a.id = da.ai_agent_id
    where l.debate_id = ${debateId}
    group by l.scope, l.path, l.target_debate_agent_id
  `.compile(db));
  return result.rows;
}

function pickSummary(
  summariesByKey: Map<string, ActivitySummaryRow>,
  scope: ManagedFileScope,
  path: string,
  debateAgentId: string | null
) {
  return summariesByKey.get(toManagedKey(scope, path, debateAgentId)) ?? null;
}

function toSummaryMap(rows: ActivitySummaryRow[]) {
  return new Map(rows.map((row) => [toManagedKey(row.scope, row.path, row.target_debate_agent_id ?? null), row]));
}

export async function listDebateManagedFileStatuses(debateId: string): Promise<DebateManagedFileStatus[]> {
  const session = await requireSessionUser();
  await requireDebateOwner(debateId, session.userId);

  const [baseRows, activitySummaryRows] = await Promise.all([
    loadBaseManagedFiles(debateId),
    loadManagedFileActivitySummaries(debateId)
  ]);

  const summariesByKey = toSummaryMap(activitySummaryRows);

  return baseRows.map((row) => {
    const scope = row.scope;
    const path = normalizeManagedPath(row.path);
    const debateAgentId = row.debate_agent_id ? String(row.debate_agent_id) : null;
    const summary = pickSummary(summariesByKey, scope, path, debateAgentId);
    const latestEventType =
      summary?.last_event_at === summary?.last_write_at
        ? ("write" as const)
        : summary?.last_event_at === summary?.last_read_at
          ? ("read" as const)
          : null;

    return {
      scope,
      path,
      debateAgentId,
      version: row.version === null ? null : Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastReadAt: summary?.last_read_at ? String(summary.last_read_at) : null,
      lastReadBy: summary?.last_read_by ? String(summary.last_read_by) : null,
      lastWrittenAt: summary?.last_write_at ? String(summary.last_write_at) : null,
      lastWrittenBy: summary?.last_write_by ? String(summary.last_write_by) : null,
      readCount: Number(summary?.read_count ?? 0),
      writeCount: Number(summary?.write_count ?? 0),
      lastEventType: latestEventType,
      lastEventAt: summary?.last_event_at ? String(summary.last_event_at) : null
    };
  });
}

async function loadManagedFileActivityRows(input: {
  debateId: string;
  scope: ManagedFileScope;
  path: string;
  debateAgentId: string | null;
}) {
  const db = await ensureDb();
  const result = await db.executeQuery<ActivityRow>(sql`
    select
      l.id,
      l.action,
      l.scope,
      l.path,
      l.target_debate_agent_id,
      l.created_at,
      l.turn_number,
      l.round_number,
      l.before_version,
      l.after_version,
      l.target_heading,
      l.reason,
      case
        when l.reason like 'summarizer:%' then '独立总结器'
        else coalesce(da.display_name, a.name, 'Unknown')
      end as actor_display,
      case
        when l.reason like 'summarizer:%' then 'Summarizer'
        else 'Participant'
      end as actor_role_type
    from debate_file_activity_logs l
    join debate_agents da on da.id = l.debate_agent_id
    join ai_agents a on a.id = da.ai_agent_id
    where l.debate_id = ${input.debateId}
      and l.scope = ${input.scope}
      and l.path = ${input.path}
      and (
        (${input.scope} = 'debate' and l.target_debate_agent_id is null)
        or (${input.scope} = 'agent' and l.target_debate_agent_id = ${input.debateAgentId}::uuid)
      )
    order by l.created_at asc, l.id asc
    limit 400
  `.compile(db));
  return result.rows;
}

async function loadManagedFileBase(input: {
  debateId: string;
  scope: ManagedFileScope;
  path: string;
  debateAgentId: string | null;
}) {
  const db = await ensureDb();
  if (input.scope === "debate") {
    const row = await db.executeQuery<BaseFileRow>(sql`
      select
        'debate'::text as scope,
        f.path,
        null::uuid as debate_agent_id,
        f.created_at,
        f.updated_at,
        f.version,
        f.content
      from debate_files f
      where f.debate_id = ${input.debateId}
        and f.path = ${input.path}
      limit 1
    `.compile(db));
    return row.rows[0] ?? null;
  }

  if (!input.debateAgentId) {
    throw new AppError("VALIDATION_ERROR", 400, "debateAgentId is required for agent files");
  }

  const row = await db.executeQuery<BaseFileRow>(sql`
    select
      'agent'::text as scope,
      f.path,
      f.debate_agent_id,
      f.created_at,
      f.updated_at,
      null::int as version,
      f.content
    from debate_agent_files f
    join debate_agents da on da.id = f.debate_agent_id
    where da.debate_id = ${input.debateId}
      and f.debate_agent_id = ${input.debateAgentId}::uuid
      and f.path = ${input.path}
    limit 1
  `.compile(db));
  return row.rows[0] ?? null;
}

function buildManagedFileVersions(
  scope: ManagedFileScope,
  base: BaseFileRow,
  activityRows: ActivityRow[]
): DebateManagedFileInfo["versions"] {
  const writes = activityRows.filter((row) => row.action === "write");
  if (writes.length === 0) {
    return scope === "debate" && base.version !== null
      ? [
          {
            version: Number(base.version),
            at: String(base.updated_at),
            actorName: null,
            actorRoleType: null,
            baseVersion: null,
            mode: null,
            reason: null
          }
        ]
      : [];
  }

  const deduped = new Map<number, DebateManagedFileInfo["versions"][number]>();
  for (const row of writes) {
    const version = row.after_version === null ? null : Number(row.after_version);
    if (version === null) continue;
    deduped.set(version, {
      version,
      at: String(row.created_at),
      actorName: row.actor_display ? String(row.actor_display) : null,
      actorRoleType: row.actor_role_type ? String(row.actor_role_type) : null,
      baseVersion: row.before_version === null ? null : Number(row.before_version),
      mode: row.action === "write" ? "write" : null,
      reason: row.reason ? String(row.reason) : null
    });
  }
  return [...deduped.values()].sort((left, right) => (left.version ?? 0) - (right.version ?? 0));
}

function buildManagedFileEvents(
  base: BaseFileRow,
  activityRows: ActivityRow[]
): DebateManagedFileInfo["events"] {
  const events: DebateManagedFileInfo["events"] = [];
  const firstWrite = activityRows.find(
    (row) =>
      row.action === "write" &&
      (row.before_version === null || Number(row.before_version) === 0) &&
      (row.after_version === null || Number(row.after_version) === 1)
  );
  const shouldAddSyntheticCreate =
    !firstWrite || String(firstWrite.created_at) !== String(base.created_at);

  if (shouldAddSyntheticCreate) {
    events.push({
      id: `created:${base.scope}:${base.debate_agent_id ?? ""}:${base.path}`,
      type: "created",
      at: String(base.created_at),
      actorName: null,
      actorRoleType: null,
      roundNumber: null,
      turnNumber: null,
      beforeVersion: null,
      afterVersion: base.version === null ? null : Number(base.version) > 0 ? 1 : null,
      targetHeading: null,
      reason: null
    });
  }

  for (const row of activityRows) {
    events.push({
      id: String(row.id),
      type: row.action === "write" ? "written" : "read",
      at: String(row.created_at),
      actorName: row.actor_display ? String(row.actor_display) : null,
      actorRoleType: row.actor_role_type ? String(row.actor_role_type) : null,
      roundNumber: Number.isFinite(Number(row.round_number)) ? Number(row.round_number) : null,
      turnNumber: Number.isFinite(Number(row.turn_number)) ? Number(row.turn_number) : null,
      beforeVersion: row.before_version === null ? null : Number(row.before_version),
      afterVersion: row.after_version === null ? null : Number(row.after_version),
      targetHeading: row.target_heading ? String(row.target_heading) : null,
      reason: row.reason ? String(row.reason) : null
    });
  }
  return events;
}

export async function getDebateManagedFileInfo(input: {
  debateId: string;
  scope: ManagedFileScope;
  path: string;
  debateAgentId?: string | null;
}): Promise<DebateManagedFileInfo> {
  const session = await requireSessionUser();
  await requireDebateOwner(input.debateId, session.userId);

  const path = normalizeManagedPath(input.path);
  if (!path) {
    throw new AppError("VALIDATION_ERROR", 400, "File path is required");
  }

  const debateAgentId = input.scope === "agent" ? String(input.debateAgentId ?? "").trim() || null : null;
  const base = await loadManagedFileBase({
    debateId: input.debateId,
    scope: input.scope,
    path,
    debateAgentId
  });
  if (!base) {
    throw new AppError("NOT_FOUND", 404, "File not found");
  }

  const activityRows = await loadManagedFileActivityRows({
    debateId: input.debateId,
    scope: input.scope,
    path,
    debateAgentId
  });

  const writes = activityRows.filter((row) => row.action === "write");
  const reads = activityRows.filter((row) => row.action !== "write");
  const createdBy = writes[0]?.actor_display ? String(writes[0].actor_display) : null;
  const lastWrite = writes.at(-1) ?? null;
  const lastRead = reads.at(-1) ?? null;

  return {
    scope: input.scope,
    path,
    debateAgentId,
    charCount: String(base.content ?? "").length,
    byteSize: Buffer.byteLength(String(base.content ?? ""), "utf8"),
    version: base.version === null ? null : Number(base.version),
    totalVersions:
      input.scope === "debate"
        ? base.version === null
          ? null
          : Number(base.version)
        : null,
    createdAt: String(base.created_at),
    updatedAt: String(base.updated_at),
    createdBy,
    lastWrittenAt: lastWrite?.created_at ? String(lastWrite.created_at) : null,
    lastWrittenBy: lastWrite?.actor_display ? String(lastWrite.actor_display) : null,
    lastReadAt: lastRead?.created_at ? String(lastRead.created_at) : null,
    lastReadBy: lastRead?.actor_display ? String(lastRead.actor_display) : null,
    readCount: reads.length,
    writeCount: writes.length,
    versions: buildManagedFileVersions(input.scope, base, activityRows),
    events: buildManagedFileEvents(base, activityRows)
  };
}
