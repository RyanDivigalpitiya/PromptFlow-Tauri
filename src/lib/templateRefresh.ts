import type { PromptTemplatesRefresh } from "./api";

/** The Settings line after a Refresh. An edit changes nothing in the list, so this has to
 * say what was found. A skipped file is named with its reason, because otherwise it just
 * looks as if Refresh failed to notice it. */
export function describeTemplateRefresh(r: PromptTemplatesRefresh): string {
  const changes = [
    r.added > 0 && `${r.added} new`,
    r.edited > 0 && `${r.edited} edited`,
    r.removed > 0 && `${r.removed} removed`,
  ].filter(Boolean);
  const n = r.templates.length;
  const count = `${n} template${n === 1 ? "" : "s"}.`;
  const found =
    changes.length > 0 ? `${changes.join(", ")}. ${count}` : `No changes. ${count}`;
  if (r.skipped.length === 0) return found;
  const skipped = r.skipped.map((s) => `${s.file} (${s.reason})`).join(", ");
  return `${found} Skipped ${skipped}.`;
}
