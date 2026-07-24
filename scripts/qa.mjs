/* Headless visual QA in the REAL engine (Playwright's WebKit — the same rendering
 * engine as the app's WKWebView), against the REAL app: it loads the Vite dev server
 * and boots `src/main.tsx` with a stubbed Tauri IPC, so every component, stylesheet and
 * layout constant under test is the shipping one. No window is driven, nothing touches
 * the user's session, and :hover/:focus states are reachable — which CGEvent hovers are
 * not unless the dev window happens to be frontmost.
 *
 * NOT a substitute for the app for: anything Rust-side (menus, the store, deltas),
 * WebKit-in-Cocoa behaviour (macOS text substitution — see CLAUDE.md), or ProMotion
 * compositing rates. It IS the fastest way to settle a CSS/layout/animation question.
 *
 * Usage:  scripts/dev.sh &                # or any server on :1420
 *         node scripts/qa.mjs [outDir]
 * Playwright is resolved from the npx cache (`npx playwright install webkit` once);
 * it is deliberately NOT a project dependency.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let webkit;
try {
  ({ webkit } = require("playwright"));
} catch {
  const root = execSync("npm root -g").toString().trim();
  try {
    ({ webkit } = require(`${root}/playwright`));
  } catch {
    const cached = execSync(
      "find ~/.npm/_npx -maxdepth 3 -type d -name playwright | head -1",
    )
      .toString()
      .trim();
    if (!cached) {
      console.error("playwright not found — run `npx playwright install webkit`");
      process.exit(1);
    }
    ({ webkit } = require(cached));
  }
}

const OUT = process.argv[2] ?? "/tmp/pf-qa";
const URL_ = process.env.PF_QA_URL ?? "http://localhost:1420";
mkdirSync(OUT, { recursive: true });

// ---- The fixture tree the stubbed `snapshot` command returns -----------------
// One of every kind, plus the two rows this harness exists for: a divider (its actions
// open between the handle and the rule) and a prompt (its cluster splits down the
// panel's trailing edge).
const T = 1700000000;
const node = (id, parent, position, text, kind, extra = {}) => ({
  id,
  parent,
  position,
  text,
  note: "",
  kind,
  isCompleted: false,
  isHighlighted: false,
  isCollapsed: false,
  boldRanges: [],
  italicRanges: [],
  underlineRanges: [],
  createdAt: T,
  updatedAt: T,
  completedAt: null,
  ...extra,
});

const NODES = [
  node("n1", null, 0, "Welcome to PromptFlow", "bulletPoint"),
  node("n1a", "n1", 0, "Press the + at the bottom to add a node", "bulletPoint"),
  node("n1b", "n1", 1024, "A checkbox child", "checkbox"),
  node("n1c", "n1", 2048, "", "line"),
  node("n1d", "n1", 3072, "After the nested divider", "bulletPoint"),
  node("n2", null, 1024, "", "line"),
  node("n3", null, 2048, "Prompt drafts", "bulletPoint"),
  node("n3a", "n3", 0, "You are a helpful coding agent. Refactor the function below…", "promptDraft"),
  node("n3b", "n3", 1024, "A prompt with children", "promptDraft"),
  node("n3b1", "n3b", 0, "child of the prompt", "bulletPoint"),
  node("n4", null, 3072, "Tail node", "bulletPoint"),
];

const SNAPSHOT = { rev: 1, nodes: NODES, canUndo: false, canRedo: false };

/** Runs BEFORE any app code: stands up just enough of `window.__TAURI_INTERNALS__` for
 * @tauri-apps/api (invoke + the event plugin's callback registry + window metadata).
 * Mutating commands are answered with an empty MutationOut and logged, never applied —
 * this harness renders states, it does not exercise the store (that is `cargo test`). */
function tauriStub(snapshot) {
  const calls = [];
  window.__PF_QA_CALLS = calls;
  const cbs = new Map();
  let next = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(cb, once) {
      const id = next++;
      cbs.set(id, { cb, once });
      window[`_${id}`] = (payload) => {
        const e = cbs.get(id);
        if (!e) return;
        if (e.once) cbs.delete(id);
        e.cb(payload);
      };
      return id;
    },
    unregisterCallback(id) {
      cbs.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === "snapshot") return snapshot;
      if (cmd === "get_settings") return { autoArchive: false };
      if (cmd === "log_msg") return null;
      if (cmd.startsWith("plugin:event|")) return 0;
      return { newNode: null, expand: [], moved: false };
    },
  };
  // The event plugin's unlisten path reaches for this global directly, not through
  // invoke — without it every `listen()` teardown throws an unhandled rejection.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

const b = await webkit.launch();
const page = await b.newPage({
  viewport: { width: 1100, height: 760 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.addInitScript(tauriStub, SNAPSHOT);
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".node-row", { timeout: 15000 });
// The window starts with the focus pane's placeholder open; close it so the outline
// owns the frame (⌥⇧F is the app's own toggle).
await page.evaluate(() => localStorage.setItem("pf.win.main", JSON.stringify({
  collapsed: [], hideCompleted: false, fontSize: 16, drill: null,
  focusPaneExpanded: false, focusPaneLayout: "top", focusSidebarWidth: 260,
  focusTopHeight: "auto",
})));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".node-row", { timeout: 15000 });
// The real window is transparent over a behind-window blur (Tauri windowEffects), which
// screenshots as white here — lay the dark wash in so the shots read like the app.
await page.addStyleTag({ content: "html,body{background:#101014 !important}" });
await page.waitForTimeout(300);

const shot = async (name, locator) => {
  const path = `${OUT}/${name}.png`;
  await (locator ?? page).screenshot({ path });
  console.log(path);
};

/** A row's DOM by its text, so the fixture can move without breaking the selectors. */
const rowOf = (text) =>
  page.locator(".node-row", { hasText: text }).first();
const dividerRows = page.locator(".node-row.kind-line");

// ---- 1. Divider: rest vs hover ---------------------------------------------
const topDivider = dividerRows.nth(1); // the root-level one
const rest = await topDivider.evaluate((el) => {
  const rule = el.querySelector(".node-divider").getBoundingClientRect();
  const content = el.querySelector(".line-content").getBoundingClientRect();
  const clip = el.querySelector(".line-actions").getBoundingClientRect();
  return { ruleLeft: rule.left, contentLeft: content.left, clipW: +clip.width.toFixed(2) };
});
await shot("divider-rest", topDivider);

await topDivider.hover();
await page.waitForTimeout(400); // past --divider-actions-dur
const hovered = await topDivider.evaluate((el) => {
  const rule = el.querySelector(".node-divider").getBoundingClientRect();
  const content = el.querySelector(".line-content").getBoundingClientRect();
  const clip = el.querySelector(".line-actions").getBoundingClientRect();
  const btns = [...el.querySelectorAll(".row-action")].map((b) => ({
    label: b.getAttribute("aria-label"),
    x: +b.getBoundingClientRect().left.toFixed(1),
    opacity: getComputedStyle(b.closest(".row-actions")).opacity,
  }));
  return {
    ruleLeft: rule.left,
    contentLeft: content.left,
    clipW: +clip.width.toFixed(2),
    btns,
  };
});
await shot("divider-hover", topDivider);

// Does the clip WIDTH interpolate, or jump? (The reveal rests on WebKit animating
// `grid-template-columns: 0fr↔1fr`; this is the regression guard for that assumption.)
// The sampler is ARMED BEFORE the pointer moves — :hover answers only to a real pointer,
// and a synthetic mouseover changes no computed style at all.
await page.mouse.move(5, 5);
await page.waitForTimeout(400);
const box = await topDivider.boundingBox();
const sampling = topDivider.evaluate(
  (el) =>
    new Promise((resolve) => {
      const clip = el.querySelector(".line-actions");
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        out.push(+clip.getBoundingClientRect().width.toFixed(1));
        if (performance.now() - t0 > 320) return resolve(out);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
const sweep = await sampling;

// ---- 2. Prompt: cluster split down the panel edge ---------------------------
const promptRow = rowOf("helpful coding agent");
await promptRow.hover();
await page.waitForTimeout(300);
const prompt = await promptRow.evaluate((el) => {
  const panel = el.querySelector(".prompt-panel").getBoundingClientRect();
  const groups = [...el.querySelectorAll(".cluster-line")].map((g) => {
    const r = g.getBoundingClientRect();
    return {
      top: +r.top.toFixed(1),
      bottom: +r.bottom.toFixed(1),
      left: +r.left.toFixed(1),
      buttons: [...g.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    };
  });
  return {
    panel: { top: +panel.top.toFixed(1), bottom: +panel.bottom.toFixed(1) },
    groups,
  };
});
await shot("prompt-hover", promptRow);
await page.mouse.move(5, 5);
await page.waitForTimeout(300);
await shot("prompt-rest", promptRow);

// A prompt WITH children — the chevron rides the top group.
const promptParent = rowOf("A prompt with children");
await promptParent.hover();
await page.waitForTimeout(300);
await shot("prompt-parent-hover", promptParent);

// A plain bullet is the untouched case: ONE horizontal run hugging the text.
const bulletRow = rowOf("Press the + at the bottom");
await bulletRow.hover();
await page.waitForTimeout(300);
const bullet = await bulletRow.evaluate((el) => {
  const btns = [...el.querySelectorAll(".trailing-cluster button")].map((b) => {
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute("aria-label"), top: +r.top.toFixed(1) };
  });
  const text = el.querySelector(".node-text-wrap").getBoundingClientRect();
  return { btns, textRight: +text.right.toFixed(1), groups: el.querySelectorAll(".cluster-line").length };
});
await shot("bullet-hover", bulletRow);

await page.mouse.move(5, 5);
await page.waitForTimeout(300);
await shot("outline", page.locator(".app-body"));

// ---- 3. Arrows step OVER a divider ------------------------------------------
// A divider renders no editor, so landing focus on one drops the caret out of the
// outline entirely. These press real keys through the real RowEditor handler.
const focusedRowText = () =>
  page.evaluate(() => {
    const row = document.activeElement?.closest?.(".node-row");
    return row ? row.innerText.trim().split("\n")[0] : null;
  });
const caretInto = async (text) => {
  await rowOf(text).locator(".node-text-wrap").first().click();
  await page.waitForTimeout(120);
};

await caretInto("A checkbox child");
const startedIn = await focusedRowText();
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(150);
const downOverNested = await focusedRowText();

await page.keyboard.press("ArrowUp");
await page.waitForTimeout(150);
const upOverNested = await focusedRowText();

// …and over a ROOT-level divider, which also has an add-child row between.
await caretInto("After the nested divider");
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(150);
const downOverRoot = await focusedRowText();
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(150);
const upOverRoot = await focusedRowText();
const arrows = { startedIn, downOverNested, upOverNested, downOverRoot, upOverRoot };

// ---- 4. Mouse multi-select sweep --------------------------------------------
// The pointer half of node multi-select: a press starts as TEXT selection inside the
// pressed row and only becomes a NODE selection once it crosses that row's edge.
const marked = (cls) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((r) =>
        r.classList.contains("kind-line")
          ? "(divider)"
          : (r
              .querySelector(".node-text-wrap, .node-text-static")
              ?.textContent.trim() ?? ""),
      ),
    `.node-row.${cls}`,
  );
const nativeSelection = () => page.evaluate(() => String(document.getSelection()));
const textBox = async (text) =>
  await rowOf(text).locator(".node-text-wrap").first().boundingBox();

/** Press on `fromText`'s text, drag sideways INSIDE the row (sampled), then out to
 * `toText`'s row (sampled), then release. */
async function sweepSelect(fromText, toText, shotName) {
  const a = await textBox(fromText);
  const bb = await rowOf(toText).boundingBox();
  await page.mouse.move(a.x + 8, a.y + a.height / 2);
  await page.mouse.down();
  // 24px sideways — well past the 4px threshold, but never out of the row's band.
  await page.mouse.move(a.x + 32, a.y + a.height / 2, { steps: 4 });
  await page.waitForTimeout(60);
  const insideRow = await marked("selected");
  await page.mouse.move(bb.x + 120, bb.y + bb.height / 2, { steps: 8 });
  await page.waitForTimeout(60);
  const members = await marked("selected");
  const tinted = await marked("sel-tint");
  const native = await nativeSelection();
  if (shotName) await shot(shotName, page.locator(".app-body"));
  await page.mouse.up();
  await page.keyboard.press("Escape"); // the key handler clears a live selection
  await page.waitForTimeout(80);
  const afterEscape = await marked("selected");
  return { insideRow, members, tinted, native, afterEscape };
}

// Down, between two siblings.
const sweepSiblings = await sweepSelect("Press the + at the bottom", "A checkbox child");
// Down, off the end of the anchor's parent: clamps to the last sibling (the range can
// never collapse to nothing mid-drag), and steps over the nested divider on the way.
const sweepClamp = await sweepSelect("A checkbox child", "Prompt drafts");
// Up, onto a row two levels deeper: maps to the anchor-level sibling containing it.
const sweepUp = await sweepSelect("Tail node", "child of the prompt", "multiselect-drag");

// The takeover from a LIVE editor — the case the Swift version needs a synthetic
// mouseUp for: put the caret in a row, then press INSIDE its contenteditable and drag
// out of it. The in-row samples must still be a plain text selection.
await caretInto("A checkbox child");
const sweepFromEditor = await sweepSelect(
  "A checkbox child",
  "Press the + at the bottom",
);

// A press on the BACKGROUND under the list has no row to anchor to — it adopts the row
// the projection would pick for it (the last one) and sweeps up from there.
const scrollBox = await page.locator(".outline-scroll").boundingBox();
await page.mouse.move(scrollBox.x + 400, scrollBox.y + scrollBox.height - 30);
await page.mouse.down();
const upTo = await rowOf("Prompt drafts").boundingBox();
await page.mouse.move(upTo.x + 400, upTo.y + upTo.height / 2, { steps: 8 });
await page.waitForTimeout(60);
const sweepFromBackground = {
  members: await marked("selected"),
  native: await nativeSelection(),
};
await page.mouse.up();
await page.keyboard.press("Escape");
await page.waitForTimeout(80);

// A press on the GLYPH still belongs to the reorder drag, never to the sweep.
const glyphBox = await rowOf("Tail node").locator(".glyph-slot").first().boundingBox();
await page.mouse.move(glyphBox.x + glyphBox.width / 2, glyphBox.y + glyphBox.height / 2);
await page.mouse.down();
const upRow = await rowOf("Prompt drafts").boundingBox();
await page.mouse.move(upRow.x + 120, upRow.y + upRow.height / 2, { steps: 8 });
await page.waitForTimeout(60);
const glyphDrag = {
  selected: (await marked("selected")).length,
  ghost: await page.locator(".drag-ghost").count(),
};
await page.keyboard.press("Escape");
await page.mouse.up();
await page.waitForTimeout(80);

// ---- Report ------------------------------------------------------------------
const eq = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const checks = [
  ["divider at rest: rule starts at the row's content edge", eq(rest.ruleLeft, rest.contentLeft)],
  ["divider at rest: actions clip is 0 wide", rest.clipW === 0],
  ["divider hovered: clip opens", hovered.clipW > 20],
  ["divider hovered: rule gives up exactly the clip's width", eq(hovered.ruleLeft - rest.ruleLeft, hovered.clipW)],
  ["divider hovered: actions are + then ⋯, no zoom", JSON.stringify(hovered.btns.map((b) => b.label)) === '["Add node","Node menu"]'],
  ["divider hovered: actions faded in", hovered.btns.every((b) => b.opacity === "1")],
  ["divider: clip width interpolates (>4 distinct frames)", new Set(sweep).size > 4],
  ["prompt: two cluster groups", prompt.groups.length === 2],
  ["prompt: top group is flush with the panel's top edge", eq(prompt.groups[0].top, prompt.panel.top, 1)],
  ["prompt: top group is zoom + ⋯", JSON.stringify(prompt.groups[0].buttons) === '["Zoom in","Node menu"]'],
  ["prompt: bottom group is the +", JSON.stringify(prompt.groups[1].buttons) === '["Add node"]'],
  ["prompt: + is flush with the panel's bottom edge", eq(prompt.groups[1].bottom, prompt.panel.bottom, 1)],
  ["prompt: + is LEFT-justified against the panel, not under the ⋯", eq(prompt.groups[1].left, prompt.groups[0].left)],
  ["bullet: one horizontal run, + then zoom then ⋯", JSON.stringify(bullet.btns.map((b) => b.label)) === '["Add node","Zoom in","Node menu"]'],
  ["bullet: the run is one line (all buttons share a top)", new Set(bullet.btns.map((b) => b.top)).size === 1],
  ["bullet: the run hugs the end of the text", bullet.btns[0].top >= 0 && bullet.groups === 0],
  ["arrows: a click puts the caret in the clicked row", arrows.startedIn === "A checkbox child"],
  ["arrows: ↓ steps over a nested divider", arrows.downOverNested === "After the nested divider"],
  ["arrows: ↑ steps back over it", arrows.upOverNested === "A checkbox child"],
  ["arrows: ↓ steps over a root divider", arrows.downOverRoot === "Prompt drafts"],
  ["arrows: ↑ steps back over it", arrows.upOverRoot === "After the nested divider"],
  ["sweep: a drag INSIDE the pressed row selects no node", sweepSiblings.insideRow.length === 0],
  ["sweep: crossing to the next sibling selects both", JSON.stringify(sweepSiblings.members) === '["Press the + at the bottom to add a node","A checkbox child"]'],
  ["sweep: no native text selection survives it", sweepSiblings.native === ""],
  ["sweep: Escape clears the selection", sweepSiblings.afterEscape.length === 0],
  ["sweep: past the parent's last child clamps there (over the divider)", JSON.stringify(sweepClamp.members) === '["A checkbox child","(divider)","After the nested divider"]'],
  ["sweep: upward, a deeper row maps to the anchor-level sibling", JSON.stringify(sweepUp.members) === '["Prompt drafts","Tail node"]'],
  ["sweep: the members' descendants are tinted", sweepUp.tinted.includes("child of the prompt")],
  ["sweep: dragging out of the LIVE editor takes the selection over", JSON.stringify(sweepFromEditor.members) === '["Press the + at the bottom to add a node","A checkbox child"]'],
  ["sweep: the editor's own text selection is gone with it", sweepFromEditor.native === ""],
  ["sweep: a background press anchors on the last row", JSON.stringify(sweepFromBackground.members) === '["Prompt drafts","Tail node"]' && sweepFromBackground.native === ""],
  ["sweep: a glyph press is still the reorder drag", glyphDrag.selected === 0 && glyphDrag.ghost === 1],
  ["no page errors", errors.length === 0],
];
console.log("\nrest    :", JSON.stringify(rest));
console.log("hover   :", JSON.stringify(hovered));
console.log("sweep   :", sweep.join(" "));
console.log("prompt  :", JSON.stringify(prompt));
console.log("bullet  :", JSON.stringify(bullet));
console.log("arrows  :", JSON.stringify(arrows));
console.log("sweep   :", JSON.stringify({ sweepSiblings, sweepClamp, sweepUp, sweepFromEditor, sweepFromBackground, glyphDrag }));
if (errors.length) console.log("errors  :", errors.slice(0, 5));
console.log();
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
await b.close();
process.exit(failed ? 1 : 0);
