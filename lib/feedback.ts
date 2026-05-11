import { randomUUID } from "node:crypto";

import { z } from "zod";

import { query } from "@/lib/db";

const feedbackCategories = ["suggestion", "bug", "question", "other"] as const;

export type FeedbackStatus = "new" | "reviewed" | "closed";

export const createFeedbackSchema = z.object({
  category: z.enum(feedbackCategories).default("suggestion"),
  title: z.string().trim().min(2).max(120),
  message: z.string().trim().min(5).max(5000)
});

export type FeedbackView = {
  id: string;
  userId: string;
  userEmail: string;
  category: string;
  title: string;
  message: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
};

function toTimestampString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function createFeedback(userId: string, input: unknown) {
  const parsed = createFeedbackSchema.parse(input);
  const id = randomUUID();
  const now = new Date().toISOString();

  await query(
    `
      insert into user_feedback (
        id,
        user_id,
        category,
        title,
        message,
        status,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, 'new', $6, $6)
    `,
    [
      id,
      userId,
      parsed.category,
      parsed.title,
      parsed.message,
      now
    ]
  );

  return { id, status: "new" as const, createdAt: now };
}

export async function listFeedbackForAdmin(): Promise<FeedbackView[]> {
  const result = await query<{
    id: string;
    user_id: string;
    user_email: string;
    category: string;
    title: string;
    message: string;
    status: FeedbackStatus;
    created_at: unknown;
    updated_at: unknown;
  }>(`
    select
      f.id,
      f.user_id,
      u.email as user_email,
      f.category,
      f.title,
      f.message,
      f.status,
      f.created_at,
      f.updated_at
    from user_feedback f
    join users u on u.id = f.user_id
    order by f.created_at desc, f.id desc
  `);

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    category: row.category,
    title: row.title,
    message: row.message,
    status: row.status,
    createdAt: toTimestampString(row.created_at),
    updatedAt: toTimestampString(row.updated_at)
  }));
}

export function getFeedbackCategoryLabel(category: string) {
  if (category === "bug") return "问题反馈";
  if (category === "question") return "使用疑问";
  if (category === "other") return "其他";
  return "功能建议";
}

export function getFeedbackStatusLabel(status: FeedbackStatus) {
  if (status === "reviewed") return "已查看";
  if (status === "closed") return "已关闭";
  return "新反馈";
}
