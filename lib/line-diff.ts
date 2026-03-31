/** Maximum number of context lines to display before folding */
const MAX_CONTEXT_LINES_BEFORE_FOLD = 60;

/** Number of context lines to keep at head and tail when folding */
const CONTEXT_LINES_TO_KEEP = 18;

/** Starting line number for display (1-based, matching user expectations) */
const INITIAL_LINE_NUMBER = 1;

export type LineDiffRow =
  | { kind: "skip"; leftSkip: number; rightSkip: number }
  | {
      kind: "row";
      type: "same" | "add" | "del" | "change";
      leftNo: number | null;
      rightNo: number | null;
      leftText: string;
      rightText: string;
    };

/**
 * Build line-by-line diff rows between two texts.
 * Uses prefix/suffix matching to identify common head/tail,
 * then compares the middle section line by line.
 * Long common sections are folded with skip markers.
 */
export function buildLineDiffRows(oldText: string, newText: string): LineDiffRow[] {
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  // Split lines into common head, differing middle, and common tail
  const commonHeadOld = oldLines.slice(0, prefix);
  const commonHeadNew = newLines.slice(0, prefix);
  const differingOld = oldLines.slice(prefix, oldLines.length - suffix);
  const differingNew = newLines.slice(prefix, newLines.length - suffix);
  const commonTailOld = oldLines.slice(oldLines.length - suffix);
  const commonTailNew = newLines.slice(newLines.length - suffix);

  const rows: LineDiffRow[] = [];

  let oldLineNumber = INITIAL_LINE_NUMBER;
  let newLineNumber = INITIAL_LINE_NUMBER;

  function pushSameLines(lines: string[]) {
    for (const line of lines) {
      rows.push({
        kind: "row",
        type: "same",
        leftNo: oldLineNumber,
        rightNo: newLineNumber,
        leftText: line,
        rightText: line
      });
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  function pushContext(lines: string[]) {
    if (lines.length <= MAX_CONTEXT_LINES_BEFORE_FOLD) {
      pushSameLines(lines);
      return;
    }
    const head = lines.slice(0, CONTEXT_LINES_TO_KEEP);
    const tail = lines.slice(lines.length - CONTEXT_LINES_TO_KEEP);
    pushSameLines(head);
    const skipped = lines.length - head.length - tail.length;
    rows.push({ kind: "skip", leftSkip: skipped, rightSkip: skipped });
    oldLineNumber += skipped;
    newLineNumber += skipped;
    pushSameLines(tail);
  }

  pushContext(commonHeadOld);

  const maxDiffering = Math.max(differingOld.length, differingNew.length);
  for (let lineIndex = 0; lineIndex < maxDiffering; lineIndex += 1) {
    const left = differingOld[lineIndex];
    const right = differingNew[lineIndex];
    if (typeof left === "string" && typeof right === "string") {
      rows.push({
        kind: "row",
        type: left === right ? "same" : "change",
        leftNo: oldLineNumber,
        rightNo: newLineNumber,
        leftText: left,
        rightText: right
      });
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (typeof left === "string") {
      rows.push({
        kind: "row",
        type: "del",
        leftNo: oldLineNumber,
        rightNo: null,
        leftText: left,
        rightText: ""
      });
      oldLineNumber += 1;
    } else if (typeof right === "string") {
      rows.push({
        kind: "row",
        type: "add",
        leftNo: null,
        rightNo: newLineNumber,
        leftText: "",
        rightText: right
      });
      newLineNumber += 1;
    }
  }

  pushContext(commonTailOld);
  // NOTE: commonHeadNew and commonTailNew are intentionally unused - they mirror
  // commonHeadOld/commonTailOld for symmetry in the diff algorithm but don't need
  // separate handling since their content is identical to the old version.

  return rows;
}

/**
 * Summarize line diff rows into counts of added, deleted, and changed lines.
 * Skip markers are not counted.
 */
export function summarizeLineDiffRows(rows: LineDiffRow[]) {
  let added = 0;
  let deleted = 0;
  let changed = 0;
  for (const row of rows) {
    if (row.kind !== "row") continue;
    if (row.type === "add") added += 1;
    if (row.type === "del") deleted += 1;
    if (row.type === "change") changed += 1;
  }
  return { added, deleted, changed };
}
