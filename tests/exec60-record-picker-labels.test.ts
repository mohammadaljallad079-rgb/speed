import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Every .tsx file under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

/**
 * Execution 60, Section 4 — the inline (+) create must be reachable.
 *
 * `<RecordSelect />` renders the (+) create button *beside the field label*, not
 * inside the dropdown, precisely so the user can see it without opening the
 * list. The button is therefore rendered only when a `label` is supplied. Four
 * pickers (the HR attendance check-in/check-out and the expense-row account
 * pickers on `cars/new` and `rentals/new`) omitted it, so those fields silently
 * lost the inline-create affordance the Smart Forms work promised.
 *
 * A static test is the right guard here: the defect is an omitted prop, and only
 * a browser run would otherwise notice. This scans every page and component.
 */
describe("Exec 60 — every creatable record picker exposes its (+) create", () => {
  const files = [...walk("src/app"), ...walk("src/components")];

  test("every <RecordSelect> that can create carries a label", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      // Each self-closing <RecordSelect ... /> element, as written in the tree.
      for (const match of source.matchAll(/<RecordSelect\b([\s\S]*?)\/>/g)) {
        const props = match[1];
        // `createMode="none"` is a read-only reference field and needs no (+).
        const readOnly = /createMode\s*=\s*["']none["']/.test(props);
        if (readOnly) continue;
        if (!/\blabel\s*=/.test(props)) {
          const line = source.slice(0, match.index).split("\n").length;
          const kind = /kind\s*=\s*["'](\w+)["']/.exec(props)?.[1] ?? "?";
          offenders.push(`${file}:${line} (kind=${kind})`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these record pickers render no (+) create button because they omit \`label\`:\n  ${offenders.join("\n  ")}`,
    );
  });

  test("the picker really does gate the (+) on the label", () => {
    // If this ever changes, the guard above stops meaning anything.
    const picker = fs.readFileSync(path.join(ROOT, "src/components/records/RecordSelect.tsx"), "utf8");
    assert.match(picker, /\{label && \(/, "the (+) button must be rendered inside the `label &&` block");
    assert.match(picker, /createMode !== "none"/, "createMode=none must be the only way to suppress the (+)");
  });
});
