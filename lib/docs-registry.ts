export type DocItem = {
  slug: string;
  title: string;
  description: string;
  filePath: string;
  section: "Guide" | "Design";
};

export const DOCS: DocItem[] = [
  {
    slug: "workflow",
    title: "Workflow 教程：投票/角色/顺序（超详细）",
    description: "从 strategy 配置到开票/投票/封票，再到下一轮自动应用顺序。",
    filePath: "docs/WORKFLOW_TUTORIAL.md",
    section: "Guide"
  },
  {
    slug: "features",
    title: "当前功能清单",
    description: "项目当前已实现功能的总览。",
    filePath: "docs/FEATURES_CURRENT.md",
    section: "Guide"
  },
  {
    slug: "prompts",
    title: "Prompt 约定",
    description: "策略/运行时提示词相关约定与说明。",
    filePath: "docs/PROMPTS.md",
    section: "Guide"
  },
  {
    slug: "api",
    title: "API 设计",
    description: "后端 API 设计说明。",
    filePath: "docs/API_DESIGN.md",
    section: "Design"
  },
  {
    slug: "database",
    title: "数据库设计",
    description: "Postgres 表结构与设计原则。",
    filePath: "docs/DATABASE_DESIGN.md",
    section: "Design"
  },
  {
    slug: "implementation",
    title: "实现说明",
    description: "关键实现点与组织结构。",
    filePath: "docs/IMPLEMENTATION.md",
    section: "Design"
  },
  {
    slug: "deployment",
    title: "部署",
    description: "Docker/部署相关说明。",
    filePath: "docs/DEPLOYMENT.md",
    section: "Design"
  },
  {
    slug: "observability",
    title: "可观测性",
    description: "监控、日志与排障说明。",
    filePath: "docs/OBSERVABILITY.md",
    section: "Design"
  }
];

export function getDocBySlug(slug: string) {
  return DOCS.find((item) => item.slug === slug) ?? null;
}

