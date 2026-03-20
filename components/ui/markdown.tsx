"use client";

import React from "react";

type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string };

function isSafeHref(href: string) {
  return href.startsWith("http://") || href.startsWith("https://");
}

function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  function pushText(text: string) {
    if (!text) return;
    tokens.push({ type: "text", text });
  }

  while (i < input.length) {
    const rest = input.slice(i);

    const codeIdx = rest.indexOf("`");
    const strongIdx = rest.indexOf("**");
    const emIdx = rest.indexOf("*");
    const linkIdx = rest.indexOf("[");

    const candidates = [codeIdx, strongIdx, emIdx, linkIdx]
      .filter((x) => x >= 0)
      .map((x) => x + i);
    const next = candidates.length === 0 ? -1 : Math.min(...candidates);

    if (next === -1) {
      pushText(input.slice(i));
      break;
    }

    if (next > i) {
      pushText(input.slice(i, next));
      i = next;
      continue;
    }

    // code: `...`
    if (input[i] === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i + 1) {
        tokens.push({ type: "code", text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // strong: **...**
    if (input.startsWith("**", i)) {
      const end = input.indexOf("**", i + 2);
      if (end > i + 2) {
        tokens.push({ type: "strong", text: input.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // link: [text](href)
    if (input[i] === "[") {
      const closeText = input.indexOf("]", i + 1);
      const openHref = closeText >= 0 ? input.indexOf("(", closeText + 1) : -1;
      const closeHref = openHref >= 0 ? input.indexOf(")", openHref + 1) : -1;
      if (closeText > i + 1 && openHref === closeText + 1 && closeHref > openHref + 1) {
        const text = input.slice(i + 1, closeText);
        const href = input.slice(openHref + 1, closeHref).trim();
        if (isSafeHref(href)) {
          tokens.push({ type: "link", text, href });
          i = closeHref + 1;
          continue;
        }
      }
    }

    // em: *...* (avoid **)
    if (input[i] === "*" && !input.startsWith("**", i)) {
      const end = input.indexOf("*", i + 1);
      if (end > i + 1) {
        tokens.push({ type: "em", text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // fallback: treat as text
    pushText(input[i]);
    i += 1;
  }

  return tokens;
}

function renderInline(text: string) {
  return tokenizeInline(text).map((t, idx) => {
    if (t.type === "text") return <React.Fragment key={idx}>{t.text}</React.Fragment>;
    if (t.type === "code") return <code key={idx}>{t.text}</code>;
    if (t.type === "strong") return <strong key={idx}>{t.text}</strong>;
    if (t.type === "em") return <em key={idx}>{t.text}</em>;
    return (
      <a key={idx} href={t.href} target="_blank" rel="noreferrer">
        {t.text}
      </a>
    );
  });
}

type Block =
  | { type: "hr" }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; text: string }
  | { type: "quote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "p"; lines: string[] };

function parseBlocks(input: string): Block[] {
  const lines = String(input ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  function isHr(line: string) {
    const t = line.trim();
    return t === "---" || t === "***" || t === "___";
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // fenced code
    if (line.trimStart().startsWith("```")) {
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    // hr
    if (isHr(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // heading
    const mHeading = line.match(/^(#{1,6})\s+(.*)$/);
    if (mHeading) {
      blocks.push({ type: "heading", level: mHeading[1].length, text: mHeading[2] });
      i += 1;
      continue;
    }

    // blockquote
    if (line.trimStart().startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        q.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", lines: q });
      continue;
    }

    // ul
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // ol
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // paragraph
    const p: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (
        l.trimStart().startsWith("```") ||
        isHr(l) ||
        /^(#{1,6})\s+/.test(l) ||
        l.trimStart().startsWith(">") ||
        /^\s*[-*]\s+/.test(l) ||
        /^\s*\d+\.\s+/.test(l)
      ) {
        break;
      }
      p.push(l);
      i += 1;
    }
    blocks.push({ type: "p", lines: p });
  }

  return blocks;
}

export function MarkdownView({ value, className }: { value: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(value), [value]);
  const rootClassName = className ? `md ${className}` : "md";
  return (
    <div className={rootClassName}>
      {blocks.map((b, idx) => {
        if (b.type === "hr") return <hr key={idx} />;
        if (b.type === "heading") {
          const level = Math.min(6, Math.max(1, b.level));
          const Tag = (`h${level}` as unknown) as "h1";
          return <Tag key={idx}>{renderInline(b.text)}</Tag>;
        }
        if (b.type === "code") {
          return (
            <pre key={idx} className="md-code">
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.type === "quote") {
          return (
            <blockquote key={idx} className="md-quote">
              {b.lines.map((line, i) => (
                <div key={i}>{renderInline(line)}</div>
              ))}
            </blockquote>
          );
        }
        if (b.type === "ul") {
          return (
            <ul key={idx}>
              {b.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === "ol") {
          return (
            <ol key={idx}>
              {b.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        const text = b.lines.join("\n");
        return (
          <p key={idx} style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {renderInline(text)}
          </p>
        );
      })}
    </div>
  );
}
