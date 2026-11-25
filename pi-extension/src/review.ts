const markers = { P1: "🔴", P2: "⚠️", P3: "🟡", Rollout: "🚦" } as const;
type Severity = keyof typeof markers;
export type InlineComment = { path: string; line: number; side: "RIGHT"; body: string };

export function parseReview(raw: string) {
  const invalid = { valid: false, body: raw.trim(), approve: false, comments: [] as InlineComment[], criticalComments: [] as InlineComment[], criticalSummary: "", contextGap: "" };
  try {
    const { summary, verdict, findings, criticalSummary = "", contextGap = "" } = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ""));
    if (typeof summary !== "string" || !summary.trim() || !["APPROVE", "COMMENT"].includes(verdict) ||
        !Array.isArray(findings) || typeof criticalSummary !== "string" || typeof contextGap !== "string") return invalid;
    const comments: InlineComment[] = [], criticalComments: InlineComment[] = [];
    let blocking = Boolean(criticalSummary.trim());
    for (const f of findings) {
      if (!f || !Object.hasOwn(markers, f.severity) || !Number.isSafeInteger(f.line) || f.line < 1 ||
          ![f.path, f.title, f.detail, f.suggestion].every((v) => typeof v === "string" && v.trim()) ||
          typeof f.blocking !== "boolean") return invalid;
      blocking ||= f.blocking || f.severity === "P1";
      const severity = f.severity as Severity;
      const comment: InlineComment = { path: f.path, line: f.line, side: "RIGHT",
        body: `${markers[severity]} **${severity} · ${f.title}**\n\n${f.detail}\n\n💡 ${f.suggestion}` };
      comments.push(comment);
      if (severity === "P1" || (severity === "P2" && f.blocking)) criticalComments.push(comment);
    }
    return { valid: true, body: summary.trim(), approve: verdict === "APPROVE" && !blocking && !contextGap.trim(), comments, criticalComments, criticalSummary: criticalSummary.trim(), contextGap: contextGap.trim() };
  } catch { return invalid; }
}
