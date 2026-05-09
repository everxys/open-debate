import { randomUUID } from "crypto";

import { sql, type Kysely } from "kysely";

import { requireSessionUser } from "@/lib/auth";
import type { OpenDebateDb } from "@/lib/db-schema";
import { ensureDb } from "@/lib/db";
import { AppError } from "@/lib/http";
import { normalizeNullableTimestampString, normalizeTimestampString } from "@/lib/timestamps";
import type { AgentCategoryRecord } from "@/lib/types";
import { createAgentCategorySchema, updateAgentCategorySchema } from "@/lib/validation";

type Row = Record<string, unknown>;

export type AgentCategoryView = AgentCategoryRecord & {
  referencedAgentCount: number;
};

function parseCategoryRow(row: Row): AgentCategoryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    createdAt: normalizeTimestampString(row.created_at),
    updatedAt: normalizeTimestampString(row.updated_at),
    deletedAt: normalizeNullableTimestampString(row.deleted_at)
  };
}

async function loadCategoryById(executor: Kysely<OpenDebateDb>, id: string, userId: string) {
  const row = await executor
    .selectFrom("ai_agent_categories")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row ? parseCategoryRow(row as Row) : null;
}

async function findActiveCategoryByName(executor: Kysely<OpenDebateDb>, userId: string, name: string) {
  const result = await executor.executeQuery<Row>(sql`
    select *
      from ai_agent_categories
     where user_id = ${userId}
       and deleted_at is null
       and lower(name) = lower(${name})
     limit 1
  `.compile(executor));
  return result.rows[0] ? parseCategoryRow(result.rows[0]) : null;
}

async function getReferencedAgentCounts(executor: Kysely<OpenDebateDb>, userId: string) {
  const result = await executor.executeQuery<{ category_id: string | null; ref_count: number }>(sql`
    select category_id, count(*)::int as ref_count
      from ai_agents
     where user_id = ${userId}
       and deleted_at is null
       and category_id is not null
     group by category_id
  `.compile(executor));
  return new Map(
    result.rows
      .filter((row) => typeof row.category_id === "string")
      .map((row) => [String(row.category_id), Number(row.ref_count ?? 0)])
  );
}

async function getReferencedAgentCount(executor: Kysely<OpenDebateDb>, userId: string, categoryId: string) {
  const result = await executor
    .selectFrom("ai_agents")
    .select((eb) => eb.fn.countAll<number>().as("ref_count"))
    .where("user_id", "=", userId)
    .where("category_id", "=", categoryId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(result?.ref_count ?? 0);
}

async function toCategoryView(
  executor: Kysely<OpenDebateDb>,
  category: AgentCategoryRecord,
  referencedCounts?: Map<string, number>
): Promise<AgentCategoryView> {
  if (!referencedCounts) {
    return {
      ...category,
      referencedAgentCount: await getReferencedAgentCount(executor, category.userId, category.id)
    };
  }
  return {
    ...category,
    referencedAgentCount: referencedCounts.get(category.id) ?? 0
  };
}

export async function listAgentCategories() {
  const session = await requireSessionUser();
  const db = await ensureDb();
  const rows = await db
    .selectFrom("ai_agent_categories")
    .selectAll()
    .where("user_id", "=", session.userId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  const categories = rows.map((row) => parseCategoryRow(row as Row));
  const counts = await getReferencedAgentCounts(db, session.userId);
  return Promise.all(categories.map((category) => toCategoryView(db, category, counts)));
}

export async function createAgentCategory(input: unknown) {
  const data = createAgentCategorySchema.parse(input);
  const session = await requireSessionUser();
  const db = await ensureDb();
  const existing = await findActiveCategoryByName(db, session.userId, data.name);
  if (existing) {
    throw new AppError("CONFLICT", 409, "同名 AI 分类已存在");
  }

  const now = new Date().toISOString();
  const inserted = await db
    .insertInto("ai_agent_categories")
    .values({
      id: randomUUID(),
      user_id: session.userId,
      name: data.name,
      created_at: now,
      updated_at: now,
      deleted_at: null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    ...parseCategoryRow(inserted as Row),
    referencedAgentCount: 0
  };
}

async function getCategoryForSession(id: string) {
  const session = await requireSessionUser();
  const db = await ensureDb();
  const category = await loadCategoryById(db, id, session.userId);
  if (!category) {
    throw new AppError("NOT_FOUND", 404, "AI 分类不存在");
  }
  return { session, db, category };
}

export async function updateAgentCategory(id: string, input: unknown) {
  const data = updateAgentCategorySchema.parse(input);
  const { db, category, session } = await getCategoryForSession(id);
  const existing = await findActiveCategoryByName(db, session.userId, data.name);
  if (existing && existing.id !== id) {
    throw new AppError("CONFLICT", 409, "同名 AI 分类已存在");
  }

  const updated = await db
    .updateTable("ai_agent_categories")
    .set({
      name: data.name,
      updated_at: new Date().toISOString()
    })
    .where("id", "=", category.id)
    .where("user_id", "=", session.userId)
    .where("deleted_at", "is", null)
    .returningAll()
    .executeTakeFirstOrThrow();
  return toCategoryView(db, parseCategoryRow(updated as Row));
}

export async function deleteAgentCategory(id: string) {
  const { db, category, session } = await getCategoryForSession(id);
  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("ai_agents")
      .set({
        category_id: null,
        updated_at: now
      })
      .where("user_id", "=", session.userId)
      .where("category_id", "=", category.id)
      .where("deleted_at", "is", null)
      .execute();

    await trx
      .updateTable("ai_agent_categories")
      .set({
        deleted_at: now,
        updated_at: now
      })
      .where("id", "=", category.id)
      .where("user_id", "=", session.userId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  });
}

export async function ensureAgentCategoryBindingForUser(userId: string, categoryId: string | null | undefined) {
  if (!categoryId) return null;
  const db = await ensureDb();
  const category = await loadCategoryById(db, categoryId, userId);
  if (!category) {
    throw new AppError("VALIDATION_ERROR", 400, "AI 分类不存在或无权访问");
  }
  return category.id;
}

export async function getOrCreateAgentCategoryByNameForUser(input: {
  executor: Kysely<OpenDebateDb>;
  userId: string;
  name: string | null | undefined;
  now: string;
}) {
  const parsed = createAgentCategorySchema.safeParse({ name: input.name });
  if (!parsed.success) return null;

  const existing = await findActiveCategoryByName(input.executor, input.userId, parsed.data.name);
  if (existing) return existing;

  const inserted = await input.executor
    .insertInto("ai_agent_categories")
    .values({
      id: randomUUID(),
      user_id: input.userId,
      name: parsed.data.name,
      created_at: input.now,
      updated_at: input.now,
      deleted_at: null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return parseCategoryRow(inserted as Row);
}
