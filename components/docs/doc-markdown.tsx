"use client";

import { MarkdownView } from "@/components/ui/markdown";

export function DocMarkdown({ value }: { value: string }) {
  return <MarkdownView value={value} />;
}

