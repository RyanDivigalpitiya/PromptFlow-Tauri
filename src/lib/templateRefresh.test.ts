import { describe, expect, it } from "vitest";
import type { PromptTemplatesRefresh } from "./api";
import { describeTemplateRefresh } from "./templateRefresh";

const row = (id: string) => ({ id, file: `${id}.md`, defaultName: id, name: id });

function refresh(over: Partial<PromptTemplatesRefresh>): PromptTemplatesRefresh {
  return { templates: [row("a")], added: 0, edited: 0, removed: 0, skipped: [], ...over };
}

describe("describeTemplateRefresh", () => {
  it("says so when nothing changed", () => {
    expect(describeTemplateRefresh(refresh({}))).toBe("No changes. 1 template.");
  });

  it("names only the kinds of change that happened", () => {
    expect(
      describeTemplateRefresh(refresh({ templates: [row("a"), row("b")], edited: 1 })),
    ).toBe("1 edited. 2 templates.");
    expect(
      describeTemplateRefresh(
        refresh({ templates: [row("a"), row("b")], added: 2, edited: 1, removed: 3 }),
      ),
    ).toBe("2 new, 1 edited, 3 removed. 2 templates.");
  });

  it("counts an emptied folder", () => {
    expect(describeTemplateRefresh(refresh({ templates: [], removed: 1 }))).toBe(
      "1 removed. 0 templates.",
    );
  });

  it("names every skipped file with its reason", () => {
    expect(
      describeTemplateRefresh(
        refresh({
          skipped: [
            { file: "big.md", reason: "larger than 256 KB" },
            { file: "blank.md", reason: "empty" },
          ],
        }),
      ),
    ).toBe("No changes. 1 template. Skipped big.md (larger than 256 KB), blank.md (empty).");
  });
});
