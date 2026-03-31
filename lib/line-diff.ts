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

  const headOld = oldLines.slice(0, prefix);
  const headNew = newLines.slice(0, prefix);
  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const tailOld = oldLines.slice(oldLines.length - suffix);
  const tailNew = newLines.slice(newLines.length - suffix);

  const rows: LineDiffRow[] = [];
  const MAX_CONTEXT = 60;
  const KEEP = 18;

  let oldNo = 1;
  let newNo = 1;

  function pushSameLines(lines: string[]) {
    for (const line of lines) {
      rows.push({
        kind: "row",
        type: "same",
        leftNo: oldNo,
        rightNo: newNo,
        leftText: line,
        rightText: line
      });
      oldNo += 1;
      newNo += 1;
    }
  }

  function pushContext(lines: string[]) {
    if (lines.length <= MAX_CONTEXT) {
      pushSameLines(lines);
      return;
    }
    const head = lines.slice(0, KEEP);
    const tail = lines.slice(lines.length - KEEP);
    pushSameLines(head);
    const skipped = lines.length - head.length - tail.length;
    rows.push({ kind: "skip", leftSkip: skipped, rightSkip: skipped });
    oldNo += skipped;
    newNo += skipped;
    pushSameLines(tail);
  }

  pushContext(headOld);

  const maxMid = Math.max(midOld.length, midNew.length);
  for (let index = 0; index < maxMid; index += 1) {
    const left = midOld[index];
    const right = midNew[index];
    if (typeof left === "string" && typeof right === "string") {
      rows.push({
        kind: "row",
        type: left === right ? "same" : "change",
        leftNo: oldNo,
        rightNo: newNo,
        leftText: left,
        rightText: right
      });
      oldNo += 1;
      newNo += 1;
    } else if (typeof left === "string") {
      rows.push({
        kind: "row",
        type: "del",
        leftNo: oldNo,
        rightNo: null,
        leftText: left,
        rightText: ""
      });
      oldNo += 1;
    } else if (typeof right === "string") {
      rows.push({
        kind: "row",
        type: "add",
        leftNo: null,
        rightNo: newNo,
        leftText: "",
        rightText: right
      });
      newNo += 1;
    }
  }

  pushContext(tailOld);
  void headNew;
  void tailNew;

  return rows;
}

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
