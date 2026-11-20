// A compact unified line diff for the chat's edit_script / write_script chips. Computed on the
// server and stored with the tool output (the model never sees it). No dependencies: part
// scripts are a few hundred lines, so an LCS table is cheap.

export type DiffStat = { added: number; removed: number };

/** Unified diff of `a` → `b` with `context` lines around each change ("" when equal). Long
 *  diffs are cut after `maxLines` output lines. */
export function unifiedDiff(a: string, b: string, { context = 3, maxLines = 400, name = "script.js" } = {}): { diff: string; stat: DiffStat } {
  if (a === b) return { diff: "", stat: { added: 0, removed: 0 } };
  const x = a.split("\n");
  const y = b.split("\n");
  // Trim the common head and tail first: most edits touch a few lines.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);

  // Edit script over the middle: " " keep, "-" remove, "+" add, with 0-based line numbers.
  type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ t: " ", s: x[i], ai: i, bi: i });
  const n = xs.length;
  const m = ys.length;
  if (n * m > 4_000_000) {
    // Too big for the table: show it as a replacement.
    xs.forEach((s, i) => ops.push({ t: "-", s, ai: head + i, bi: head }));
    ys.forEach((s, j) => ops.push({ t: "+", s, ai: head + n, bi: head + j }));
  } else {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * w + j] = xs[i] === ys[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) {
        ops.push({ t: " ", s: xs[i], ai: head + i++, bi: head + j++ });
      } else if (j < m && (i === n || L[i * w + j + 1] > L[(i + 1) * w + j])) {
        ops.push({ t: "+", s: ys[j], ai: head + i, bi: head + j++ });
      } else {
        ops.push({ t: "-", s: xs[i], ai: head + i++, bi: head + j });
      }
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ t: " ", s: x[x.length - tail + k], ai: x.length - tail + k, bi: y.length - tail + k });

  const stat = { added: ops.filter((o) => o.t === "+").length, removed: ops.filter((o) => o.t === "-").length };

  // Group the changes into hunks with `context` lines around them.
  const out: string[] = [`--- a/${name}`, `+++ b/${name}`];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].t === " ") k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    let end = k;
    // Extend while the next change is within 2 × context of the last one.
    for (;;) {
      while (end < ops.length && ops[end].t !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next].t === " ") next++;
      if (next < ops.length && next - end <= 2 * context) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, stop);
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    const aStart = hunk[0].ai + (aLen ? 1 : 0);
    const bStart = hunk[0].bi + (bLen ? 1 : 0);
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.s);
    k = stop;
    if (out.length > maxLines) break;
  }
  let diff = out.slice(0, maxLines).join("\n");
  if (out.length > maxLines) diff += `\n… (${out.length - maxLines} more diff lines)`;
  return { diff, stat };
}
