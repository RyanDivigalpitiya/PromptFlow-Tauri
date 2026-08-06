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
import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

/** Playwright is deliberately NOT a project dependency, so it is resolved from wherever
 * it happens to live. The npx cache can hold SEVERAL copies of different versions, each
 * pinned to a browser build that may or may not have been downloaded — so take the first
 * candidate whose WebKit is actually ON DISK, not merely the first that imports. Picking
 * blind (`find … | head -1`) made this script die with "Executable doesn't exist" or not,
 * depending on `find`'s directory order, on a machine where both copies were present. */
const require = createRequire(import.meta.url);
const candidates = [];
const consider = (spec) => {
  try {
    candidates.push(require(spec));
  } catch {
    // not installed there
  }
};
consider("playwright");
try {
  consider(`${execSync("npm root -g").toString().trim()}/playwright`);
} catch {
  // no global npm root
}
try {
  const found = execSync("find ~/.npm/_npx -maxdepth 3 -type d -name playwright")
    .toString()
    .trim();
  for (const p of found ? found.split("\n") : []) consider(p);
} catch {
  // no npx cache
}
const usable = candidates.find((pw) => {
  try {
    return existsSync(pw.webkit.executablePath());
  } catch {
    return false;
  }
});
if (!usable) {
  console.error(
    candidates.length
      ? "playwright found but its WebKit is not downloaded — run `npx playwright install webkit`"
      : "playwright not found — run `npx playwright install webkit`",
  );
  process.exit(1);
}
const { webkit } = usable;

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
 * this harness renders states, it does not exercise the store (that is `cargo test`).
 *
 * ONE exception: `toggle_completed` flips the flag on the local snapshot copy and
 * broadcasts a real `store://delta`, synchronously inside the invoke exactly as the Rust
 * command does. The completion glyph is an ANIMATION between two store states, so there
 * is nothing to look at unless the second state actually arrives — and going through the
 * delta path means the mirror, the row's re-render and `markCompleting` all run for real
 * rather than being simulated. Still no store semantics: no spawn-a-sibling, no undo.
 *
 * `window.__PF_QA_DELTA` is the same escape hatch opened up for a harness to drive: a
 * test hands it delta ops and they land on the tree and broadcast. Nothing in the app
 * calls it, so no section pays for it that doesn't ask. */
function tauriStub(snapshot) {
  const calls = [];
  window.__PF_QA_CALLS = calls;
  const cbs = new Map();
  let next = 1;
  // Mutable copy — the fixture the page was handed is the initial state, not the truth.
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, { ...n }]));
  let rev = snapshot.rev;
  /** event name -> transformCallback ids, so a delta can reach `api.ts`'s listener. */
  const subs = new Map();
  const emit = (event, payload) => {
    for (const id of subs.get(event) ?? []) window[`_${id}`]?.({ event, id, payload });
  };
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
      if (cmd === "snapshot")
        return { ...snapshot, rev, nodes: [...nodes.values()] };
      if (cmd === "get_settings") return { autoArchive: false };
      if (cmd === "log_msg") return null;
      if (cmd === "plugin:event|listen") {
        if (!subs.has(args.event)) subs.set(args.event, new Set());
        subs.get(args.event).add(args.handler);
        return args.handler;
      }
      if (cmd === "plugin:event|unlisten") {
        subs.get(args.event)?.delete(args.eventId);
        return null;
      }
      if (cmd.startsWith("plugin:event|")) return 0;
      if (cmd === "toggle_completed") {
        const n = nodes.get(args.node ?? args.nodeId ?? args.id);
        if (n) {
          n.isCompleted = !n.isCompleted;
          if (n.isCompleted) n.isHighlighted = false;
          n.completedAt = n.isCompleted ? Date.now() : null;
          emit("store://delta", {
            rev: ++rev,
            origin: "main",
            ops: [{ type: "upsert", node: { ...n } }],
            canUndo: true,
            canRedo: false,
          });
        }
      }
      return { newNode: null, expand: [], moved: false };
    },
  };
  // The event plugin's unlisten path reaches for this global directly, not through
  // invoke — without it every `listen()` teardown throws an unhandled rejection.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  /** Apply `ops` to the tree and broadcast them as a real `store://delta`. A LIVE-UPDATE
   * requirement has nothing to show unless a SECOND store state actually reaches the
   * mirror, and the commands that would produce one are recorded here, not applied — so
   * this is how a section stages an edit the harness cannot otherwise perform. `origin`
   * defaults to a PEER window, the stricter case: no echo guard drains it, and it is the
   * path a change made in another window travels. `rev` advances by exactly 1 so the
   * mirror adopts the ops instead of falling back to a full snapshot resync. */
  window.__PF_QA_DELTA = (ops, origin = "w1") => {
    for (const op of ops) {
      if (op.type === "upsert") nodes.set(op.node.id, { ...op.node });
      else nodes.delete(op.id);
    }
    emit("store://delta", { rev: ++rev, origin, ops, canUndo: true, canRedo: false });
  };
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

// ---- 1b. Divider: the cluster glyphs are INK-centred on the row --------------
// `align-items: center` centres a text glyph's LINE BOX, not its ink, and SF centres
// "+" on the math axis — below the font's ascent/descent midpoint — so the bar rendered
// low (1.33px at fontSize 16, measured off a 4x screenshot). The divider row is where it
// shows: its rule and handle ARE the row centre. Derived here rather than screenshotted,
// so the harness needs no image library: the exact baseline comes from the font's real
// ascent/descent (a zero-height inline-block sits ON the baseline, and with
// line-height:normal the line box IS the content area), and the glyph's ink offset from
// a 10x canvas rasterization. Cross-checked against pixel analysis of a 4x shot: this
// reports the ⋯ at +0.338px where the pixels say +0.33.
const inkOffsets = await topDivider.evaluate((el) => {
  const metrics = (cs) => {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;visibility:hidden;line-height:normal;white-space:nowrap;font:${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    d.textContent = "Hxg";
    const s = document.createElement("span");
    s.style.cssText = "display:inline-block;width:0;height:0";
    d.appendChild(s);
    document.body.appendChild(d);
    const db = d.getBoundingClientRect(), base = s.getBoundingClientRect().top;
    d.remove();
    return { A: base - db.top, D: db.bottom - base };
  };
  const inkAboveBaseline = (cs, ch) => {
    const K = 10, px = parseFloat(cs.fontSize) * K, S = Math.ceil(px * 3);
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const c = cv.getContext("2d");
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
    c.textBaseline = "alphabetic";
    c.fillStyle = "#fff";
    const bl = Math.round(S * 0.7);
    c.fillText(ch, Math.round(px * 0.5), bl);
    const d = c.getImageData(0, 0, S, S).data;
    let top = -1, bot = -1;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++)
        if (d[(y * S + x) * 4 + 3] > 8) { if (top < 0) top = y; bot = y; break; }
    return ((bl - top) + (bl - bot)) / 2 / K;
  };
  const inkCentreY = (node) => {
    const cs = getComputedStyle(node), b = node.getBoundingClientRect();
    const contentMid =
      (b.top + parseFloat(cs.paddingTop) + b.bottom - parseFloat(cs.paddingBottom)) / 2;
    const { A, D } = metrics(cs);
    // lineBoxCentre = baseline − (A−D)/2, independent of line-height.
    return contentMid + (A - D) / 2 - inkAboveBaseline(cs, node.textContent);
  };
  const btn = (l) =>
    [...el.querySelectorAll(".row-action")].find((b) => b.getAttribute("aria-label") === l);
  const inner = el.querySelector(".row-inner").getBoundingClientRect();
  const rowMid = (inner.top + inner.bottom) / 2;
  const rule = el.querySelector(".node-divider").getBoundingClientRect();
  return {
    plus: +(inkCentreY(btn("Add node")) - rowMid).toFixed(3),
    menu: +(inkCentreY(btn("Node menu")) - rowMid).toFixed(3),
    rule: +(rule.top + 0.5 - rowMid).toFixed(3),
  };
});

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

// ---- 4b. Ending a live selection --------------------------------------------
// A selection used to be somewhere the app could get stuck: nothing is first responder
// while one is live, so only ⇧/⌥/Tab/⌘-combos and Escape did anything at all. A press on
// any BUTTON left the tint behind with nothing acting on it, a bare arrow fell through to
// no one, and ⌫ deleted the block and then focused nothing. These pin the ways out.
//
// The stub records mutations without applying them, so where a check can only see the
// INVOKE that is what it asserts — the store semantics are `cargo test`'s job. The caret
// checks are real: focus is entirely frontend.

/** Sweep a range and LEAVE it live — `sweepSelect` above Escapes out of its own. */
async function selectRange(fromText, toText) {
  const a = await textBox(fromText);
  const bb = await rowOf(toText).boundingBox();
  await page.mouse.move(a.x + 8, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + 120, bb.y + bb.height / 2, { steps: 8 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(60);
  return await marked("selected");
}
const lastCall = () => page.evaluate(() => window.__PF_QA_CALLS.at(-1));
/** The two adjacent siblings the checks below sweep over, by their row text. */
const SEL_A = "Press the + at the bottom";
const SEL_B = "A checkbox child";

// A press on a row BUTTON (here the ⋯, whose menu is Rust-side and stubbed out) is still
// a press "elsewhere" — it must drop the selection like any other.
const selBeforeButton = await selectRange(SEL_A, SEL_B);
await rowOf("Tail node").locator('button[aria-label="Node menu"]').first().click();
await page.waitForTimeout(100);
const afterButtonPress = await marked("selected");

// …but a press on a MEMBER's glyph is the block DRAG, and must keep it (dragGesture reads
// selectionIds() at its 4px threshold, long after the outside-press handler has run).
await selectRange(SEL_A, SEL_B);
const memberGlyph = await rowOf(SEL_B).locator(".glyph-slot").first().boundingBox();
await page.mouse.move(
  memberGlyph.x + memberGlyph.width / 2,
  memberGlyph.y + memberGlyph.height / 2,
);
await page.mouse.down();
const dragTo = await rowOf("Tail node").boundingBox();
await page.mouse.move(dragTo.x + 120, dragTo.y + dragTo.height / 2, { steps: 8 });
await page.waitForTimeout(80);
const memberGlyphDrag = {
  selected: await marked("selected"),
  ghost: await page.locator(".drag-ghost").innerText(),
};
await page.keyboard.press("Escape");
await page.mouse.up();
await page.waitForTimeout(80);

// A bare ↓ / ↑ ends the selection and puts the caret just outside the block — past the
// whole TINTED span, and stepping over the divider that sits between here and n1d.
await selectRange(SEL_A, SEL_B);
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(160);
const afterArrowDown = {
  selected: (await marked("selected")).length,
  focused: await focusedRowText(),
};
await selectRange(SEL_A, SEL_B);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(160);
const afterArrowUp = {
  selected: (await marked("selected")).length,
  focused: await focusedRowText(),
};

// ⌘B over a block: whole-text bold, which only exists as a block command.
await selectRange(SEL_A, SEL_B);
await page.keyboard.press("Meta+b");
await page.waitForTimeout(140);
const boldCall = await lastCall();

// ⌘3 over a block of NON-prompt nodes FOLDS it into one prompt…
await selectRange(SEL_A, SEL_B);
await page.keyboard.press("Meta+3");
await page.waitForTimeout(140);
const foldCall = await lastCall();
// …but a range that already contains a prompt is a conversion, not a collection.
await selectRange("You are a helpful coding agent", "A prompt with children");
await page.keyboard.press("Meta+3");
await page.waitForTimeout(140);
const convertCall = await lastCall();

// ⌫ deletes the block and lands the caret ABOVE it. The stub doesn't actually delete, so
// what this pins is the caret TARGET (resolved before the invoke) and the deselect.
await selectRange(SEL_A, SEL_B);
await page.keyboard.press("Backspace");
await page.waitForTimeout(200);
const afterDelete = {
  selected: (await marked("selected")).length,
  focused: await focusedRowText(),
};

// ---- 5. Completion glyph: a parent's tick REPLACES its progress pie ----------
// A checkbox parent used to draw only the pie, so completing the node itself changed
// nothing inside the circle. Now it draws the same tick a leaf does, at its own circle's
// proportions, and the pie fades out from under it on drawCheck's clock.
//
// Its own page, with its own fixture: the sweep tests above anchor on "the last row" and
// on the empty background under the list, so growing the main fixture would break them.
const CHECK_NODES = [
  node("c1", null, 0, "Parent, half done", "checkbox"),
  node("c1a", "c1", 0, "done child", "checkbox", { isCompleted: true, completedAt: T }),
  node("c1b", "c1", 1024, "open child", "checkbox"),
  node("c2", null, 1024, "Parent, all done", "checkbox"),
  node("c2a", "c2", 0, "done child A", "checkbox", { isCompleted: true, completedAt: T }),
  node("c2b", "c2", 1024, "done child B", "checkbox", { isCompleted: true, completedAt: T }),
  node("c3", null, 2048, "Parent already completed", "checkbox", {
    isCompleted: true,
    completedAt: T,
  }),
  node("c3a", "c3", 0, "its child", "checkbox", { isCompleted: true, completedAt: T }),
  node("c4", null, 3072, "Leaf already completed", "checkbox", {
    isCompleted: true,
    completedAt: T,
  }),
  node("c5", null, 4096, "Leaf, open", "checkbox"),
];

const cp = await b.newPage({
  viewport: { width: 720, height: 620 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
cp.on("pageerror", (e) => errors.push(String(e)));
cp.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await cp.addInitScript(tauriStub, {
  rev: 1,
  nodes: CHECK_NODES,
  canUndo: false,
  canRedo: false,
});
await cp.addInitScript(() =>
  localStorage.setItem(
    "pf.win.main",
    JSON.stringify({
      collapsed: [],
      hideCompleted: false,
      fontSize: 16,
      drill: null,
      focusPaneExpanded: false,
      focusPaneLayout: "top",
      focusSidebarWidth: 260,
      focusTopHeight: "auto",
    }),
  ),
);
await cp.goto(URL_, { waitUntil: "domcontentloaded" });
await cp.waitForSelector(".node-row", { timeout: 15000 });
await cp.addStyleTag({ content: "html,body{background:#101014 !important}" });
await cp.waitForTimeout(300);

const cRow = (text) => cp.locator(".node-row", { hasText: text }).first();
/** The glyph's numbers: circle radius, the pie's opacity + fill, and the tick's own
 * geometry — measured from the rendered SVG, so it covers the path maths too. */
const glyphState = (text) =>
  cRow(text).evaluate((el) => {
    const circle = el.querySelector(".glyph-circle");
    const wedge = el.querySelector(".glyph-wedge");
    const check = el.querySelector(".glyph-check");
    const num = (v) => (v == null ? null : +parseFloat(v).toFixed(3));
    return {
      r: circle ? num(getComputedStyle(circle).r) : null,
      wedge: wedge
        ? {
            opacity: num(getComputedStyle(wedge).opacity),
            offset: num(getComputedStyle(wedge).strokeDashoffset),
          }
        : null,
      check: check
        ? {
            // Ink box in the svg's own user units == px (no viewBox), so this is
            // directly comparable between a leaf's circle and a parent's.
            w: num(check.getBBox().width),
            h: num(check.getBBox().height),
            cx: num(check.getBBox().x + check.getBBox().width / 2),
            cy: num(check.getBBox().y + check.getBBox().height / 2),
            offset: num(getComputedStyle(check).strokeDashoffset),
            stroke: getComputedStyle(check).stroke,
          }
        : null,
    };
  });

const restDoneParent = await glyphState("Parent already completed");
const restDoneLeaf = await glyphState("Leaf already completed");
const restOpenParent = await glyphState("Parent, all done");
await shot("complete-rest", cp.locator(".app-body"));

/** Click a row's glyph and sample the two interpolating numbers every frame. */
async function toggleAndSample(text, ms = 520) {
  const row = cRow(text);
  const sampling = row.evaluate(
    (el, ms) =>
      new Promise((res) => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
          const w = el.querySelector(".glyph-wedge");
          const c = el.querySelector(".glyph-check");
          out.push({
            t: Math.round(performance.now() - t0),
            w: w ? +parseFloat(getComputedStyle(w).opacity).toFixed(3) : null,
            c: c ? +parseFloat(getComputedStyle(c).strokeDashoffset).toFixed(3) : null,
          });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else res(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
  await row.locator(".glyph-slot").first().click();
  return await sampling;
}

const fullPie = await toggleAndSample("Parent, all done");
const partPie = await toggleAndSample("Parent, half done");
await cp.waitForTimeout(200);
const afterFull = await glyphState("Parent, all done");
const afterPart = await glyphState("Parent, half done");

// Un-checking runs the same transition backwards — the tick goes, the pie comes back.
const unchecked = await toggleAndSample("Parent already completed");
await cp.waitForTimeout(200);
const afterUncheck = await glyphState("Parent already completed");
await shot("complete-toggled", cp.locator(".app-body"));

// A DETERMINISTIC filmstrip: click, then pause every running animation/transition and
// scrub it. Screenshotting in real time perturbs the very timing it is sampling.
await cp.reload({ waitUntil: "domcontentloaded" });
await cp.waitForSelector(".node-row", { timeout: 15000 });
await cp.addStyleTag({ content: "html,body{background:#101014 !important}" });
await cp.waitForTimeout(250);
const filmRow = cRow("Parent, all done");
await filmRow.locator(".glyph-slot").first().click();
await cp.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
const paused = await cp.evaluate(() => document.getAnimations().length);
for (const t of [0, 60, 120, 180, 240, 350]) {
  await cp.evaluate((t) => {
    for (const a of document.getAnimations()) a.currentTime = t;
  }, t);
  await shot(`complete-frame-${String(t).padStart(3, "0")}`, filmRow);
}

// ---- 6. Parent glyphs: a full bullet pie must not read as a checkbox ---------
// At full progress the two parent glyphs used to paint the SAME thing — a solid green
// disc. A bullet parent's centre dot goes green at all-done too, so it vanished into its
// own fill and the glyph looked like a checkbox you could tick off. The bullet's pie is
// now translucent green at the same alpha its incomplete state already had, so the opaque
// dot reads through it and the two glyphs are told apart at a glance.
//
// Its own page and fixture, like section 5: the sweep tests anchor on the main tree.
const PARENT_NODES = [
  node("p1", null, 0, "Bullet parent, all done", "bulletPoint"),
  node("p1a", "p1", 0, "its done child", "checkbox", { isCompleted: true, completedAt: T }),
  node("p2", null, 1024, "Bullet parent, half done", "bulletPoint"),
  node("p2a", "p2", 0, "one done", "checkbox", { isCompleted: true, completedAt: T }),
  node("p2b", "p2", 1024, "one open", "checkbox"),
  node("p3", null, 2048, "Checkbox parent, all done", "checkbox"),
  node("p3a", "p3", 0, "the done child", "checkbox", { isCompleted: true, completedAt: T }),
];

const pp = await b.newPage({
  viewport: { width: 720, height: 520 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
pp.on("pageerror", (e) => errors.push(String(e)));
pp.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await pp.addInitScript(tauriStub, {
  rev: 1,
  nodes: PARENT_NODES,
  canUndo: false,
  canRedo: false,
});
await pp.goto(URL_, { waitUntil: "domcontentloaded" });
await pp.waitForSelector(".node-row", { timeout: 15000 });
await pp.addStyleTag({ content: "html,body{background:#101014 !important}" });
await pp.waitForTimeout(300);

/** The two colours that decide whether a parent glyph reads as a bullet or a checkbox:
 * the pie's stroke and (bullets only) the centre dot's fill, as WebKit resolved them. */
const parentGlyph = (text) =>
  pp
    .locator(".node-row", { hasText: text })
    .first()
    .evaluate((el) => {
      const wedge = el.querySelector(".glyph-wedge");
      const dot = el.querySelector(".glyph-ring .glyph-tint");
      return {
        wedge: wedge ? getComputedStyle(wedge).stroke : null,
        dot: dot ? getComputedStyle(dot).fill : null,
      };
    });

const bulletDone = await parentGlyph("Bullet parent, all done");
const bulletHalf = await parentGlyph("Bullet parent, half done");
const checkboxDone = await parentGlyph("Checkbox parent, all done");
await shot("parent-glyphs", pp.locator(".app-body"));

/** Alpha of a resolved CSS colour; 1 when it came back as an opaque rgb(). */
const alpha = (c) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(c ?? "");
  if (!m) return null;
  const parts = m[1].split(",").map((s) => parseFloat(s));
  return parts.length > 3 ? parts[3] : 1;
};

// ---- 7. Focus pane: a pinned node's CURRENT TASK -----------------------------
// The pane used to print each pinned node's ANCESTOR breadcrumb under its title — which
// says where the node lives, something the outline already shows. It now prints the
// node's Current Task: the first open leaf under it, found by descending the child lists
// and taking the first child that is neither completed nor a divider. `lib/currentTask.ts`
// owns that rule and `currentTask.test.ts` pins it, so what is left for this section is
// everything the pure walk cannot see — that the task reads WHITE against the accent
// title, that a row with nothing left to do is title-only, that clicking the row
// navigates to the TASK (expanding whatever was collapsed over it), and above all that
// the line stays LIVE: through the app's own completion gesture, and through deltas
// arriving from another window, which is what `__PF_QA_DELTA` exists to stage.
//
// Its own page and fixture — this is the screenshot's tree, whose whole point is that
// `Example`'s task is `Child 1` and NOT its first child `Parent 1`.
const FOCUS_NODES = [
  node("fx1", null, 0, "Example", "checkbox", { isHighlighted: true }),
  node("fx1a", "fx1", 0, "Parent 1", "checkbox"),
  node("fx1a1", "fx1a", 0, "Child 1", "checkbox"),
  node("fx1a2", "fx1a", 1024, "Parent 2", "checkbox"),
  node("fx1a2a", "fx1a2", 0, "Child 2", "checkbox"),
  node("fx1b", "fx1", 1024, "Parent 3", "checkbox"),
  node("fx1b1", "fx1b", 0, "Parent 4", "checkbox"),
  node("fx1b1a", "fx1b1", 0, "Child 3", "checkbox"),
  // A pinned LEAF — nothing under it, so its row is title-only.
  node("fx2", null, 1024, "A lone pinned node", "checkbox", { isHighlighted: true }),
  // Pinned with a child that is already done: also title-only, since nothing is left.
  node("fx3", null, 2048, "All done under here", "checkbox", { isHighlighted: true }),
  node("fx3a", "fx3", 0, "the done child", "checkbox", {
    isCompleted: true,
    completedAt: T,
  }),
  // A prompt can never BE the task, but the walk still descends INTO one: the task here
  // is the prompt's own child, not the plain sibling below it.
  node("fx4", null, 3072, "Work under a prompt", "checkbox", { isHighlighted: true }),
  node("fx4a", "fx4", 0, "You are a helpful coding agent. Refactor…", "promptDraft"),
  node("fx4a1", "fx4a", 0, "Refine the wording", "checkbox"),
  node("fx4b", "fx4", 1024, "A plain sibling task", "checkbox"),
  // …and a prompt with nothing open under it is BACKTRACKED out of, not stopped on.
  node("fx5", null, 4096, "Prompt, then a task", "checkbox", { isHighlighted: true }),
  node("fx5a", "fx5", 0, "A prompt with nothing to do", "promptDraft"),
  node("fx5a1", "fx5a", 0, "its done child", "checkbox", {
    isCompleted: true,
    completedAt: T,
  }),
  node("fx5b", "fx5", 1024, "The real next action", "checkbox"),
  // A prompt is ALL there is: no task at all, exactly as for a childless node.
  node("fx6", null, 5120, "Only a prompt under here", "checkbox", { isHighlighted: true }),
  node("fx6a", "fx6", 0, "Just a prompt, nothing to do", "promptDraft"),
];

const fp = await b.newPage({
  viewport: { width: 720, height: 620 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
fp.on("pageerror", (e) => errors.push(String(e)));
fp.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await fp.addInitScript(tauriStub, {
  rev: 1,
  nodes: FOCUS_NODES,
  canUndo: false,
  canRedo: false,
});
// The pane open, and BOTH ancestors of Child 1 collapsed, so a reveal has something to
// open. `pf.focusOrder` is seeded too — the numbering is device-local, not derived.
await fp.addInitScript(
  (seed) => {
    localStorage.setItem("pf.win.main", JSON.stringify(seed.win));
    localStorage.setItem("pf.focusOrder", JSON.stringify(seed.order));
  },
  {
    win: {
      collapsed: ["fx1", "fx1a"],
      hideCompleted: false,
      fontSize: 16,
      drill: null,
      focusPaneExpanded: true,
      focusPaneLayout: "top",
      focusSidebarWidth: 260,
      focusTopHeight: "auto",
    },
    order: ["fx1", "fx2", "fx3", "fx4", "fx5", "fx6"],
  },
);
await fp.goto(URL_, { waitUntil: "domcontentloaded" });
await fp.waitForSelector(".focus-row", { timeout: 15000 });
await fp.addStyleTag({ content: "html,body{background:#101014 !important}" });
await fp.waitForTimeout(400); // past the pane's open animation

/** Every focus row as the pane presents it: the pinned node's title and its Current Task
 * line — ABSENT as an element, not empty, when there is nothing left to do — plus the two
 * resolved colours that have to differ (accent title, white task). */
const focusRows = () =>
  fp.evaluate(() =>
    [...document.querySelectorAll(".focus-row")].map((r) => {
      const t = r.querySelector(".focus-title");
      const k = r.querySelector(".focus-task");
      return {
        title: t?.textContent ?? null,
        titleColor: t ? getComputedStyle(t).color : null,
        task: k?.textContent ?? null,
        taskColor: k ? getComputedStyle(k).color : null,
      };
    }),
  );
/** Just the task lines, which is what every live-update step below is watching. */
const focusTasks = async () => (await focusRows()).map((r) => r.task);
const fpFocusedRow = () =>
  fp.evaluate(() => {
    const row = document.activeElement?.closest?.(".node-row");
    return row ? row.innerText.trim().split("\n")[0] : null;
  });
/** Stage a change as if another window had made it. */
const fpDelta = async (ops) => {
  await fp.evaluate((o) => window.__PF_QA_DELTA(o), ops);
  await fp.waitForTimeout(120);
};
const fpRow = (text) => fp.locator(".node-row", { hasText: text }).first();

const focusRest = await focusRows();
const focusStrays = await fp.evaluate(
  () => document.querySelectorAll(".focus-breadcrumb, .crumb, .crumb-sep").length,
);
await shot("focus-pane", fp.locator(".focus-pane-shell"));

// Clicking the row navigates to the TASK, not to the pinned node — through two collapsed
// ancestors, which `revealNode`'s expandMany has to open on the way.
await fp.locator(".focus-row").first().locator(".focus-content").click();
await fp.waitForTimeout(250);
const afterReveal = {
  focused: await fpFocusedRow(),
  rowExists: (await fpRow("Child 1").count()) === 1,
};

// LIVE, through the app's own gesture: ticking Child 1 off in the outline advances the
// task to the first open leaf under the next open branch. `toggle_completed` is the one
// command the stub applies for real, so this runs the whole store→delta→mirror path.
await fpRow("Child 1").locator(".glyph-slot").first().click();
await fp.waitForTimeout(600); // past .just-completed
const afterComplete = await focusTasks();
await shot("focus-pane-advanced", fp.locator(".focus-pane-shell"));
await fpRow("Child 1").locator(".glyph-slot").first().click();
await fp.waitForTimeout(600);
const afterUncomplete = await focusTasks();

// LIVE, from another window: a text edit is not a structural delta, so the row's own
// per-node subscription is the only thing that can repaint this — the exact grain whose
// absence once left mirrored titles stale.
await fpDelta([
  { type: "upsert", node: node("fx1a1", "fx1a", 0, "Child 1, renamed", "checkbox") },
]);
const afterRename = await focusTasks();

// LIVE, structural: a new FIRST child under Parent 1 takes over as the task, and removing
// it hands the task back.
await fpDelta([
  { type: "upsert", node: node("fx1a0", "fx1a", -1024, "Brand new first child", "checkbox") },
]);
const afterInsert = await focusTasks();
await fpDelta([{ type: "delete", id: "fx1a0" }]);
const afterRemove = await focusTasks();

// A completed node is skipped WHOLESALE, never descended into: ticking Parent 1 skips its
// open Child 1 with it, so the task crosses to the next branch entirely.
await fpDelta([
  {
    type: "upsert",
    node: node("fx1a", "fx1", 0, "Parent 1", "checkbox", {
      isCompleted: true,
      completedAt: T,
    }),
  },
]);
const afterParentDone = await focusTasks();

// A pure KIND flip is deliberately NOT a structural delta (the flatten is unchanged), so
// the pane's structure subscription can't see it — `visited` is the only thing that
// repaints this. Turning the prompt's own child into a prompt leaves nothing open under
// `fx4a`, and the walk backtracks out of it to the plain sibling.
await fpDelta([
  {
    type: "upsert",
    node: node("fx4a1", "fx4a", 0, "Refine the wording", "promptDraft"),
  },
]);
const afterKindFlip = (await focusTasks())[3];

// The task line is now the row's PRIMARY content, so the narrow dock is where it is most
// at risk: give it text no 260px sidebar can hold and check it ellipsizes on ONE line
// rather than wrapping the row open. Dock through the app's own switcher.
await fpDelta([
  {
    type: "upsert",
    node: node("fx1b1a", "fx1b1", 0, "Child 3, whose text runs on well past anything a sidebar could hold", "checkbox"),
  },
]);
await fp.locator('button[aria-label="Switch focus pane layout"]').click();
await fp.waitForTimeout(450); // past --focus-pane-anim-dur
const sidebarTask = await fp.evaluate(() => {
  const k = document.querySelector(".focus-task");
  const t = document.querySelector(".focus-title");
  const line = parseFloat(getComputedStyle(k).fontSize) * 1.6; // a generous one-line box
  return {
    lines: +(k.getBoundingClientRect().height / line).toFixed(2),
    // Overflowing is the GEOMETRY (it stayed on one line and didn't fit); how that
    // overflow is PAINTED is a separate declaration, and `scrollWidth > clientWidth`
    // would hold just the same with the text hard-clipped mid-glyph — so pin both.
    clipped: k.scrollWidth > k.clientWidth,
    ellipsis: getComputedStyle(k).textOverflow,
    withinTitle: k.getBoundingClientRect().width <= t.getBoundingClientRect().width + 0.5,
  };
});
await shot("focus-pane-sidebar", fp.locator(".app-body"));

// ---- 8. Folding a HIERARCHICAL selection into one prompt ---------------------
// A selection is a sibling range with every member's SUBTREE tinted, so what the user
// sweeps spans levels — and ⌘3 now folds all of it, each descendant its own bullet two
// spaces deeper per level. Two halves, meeting where the harness can see them:
//   • the GESTURE, which is all the stub can watch a mutation do — that ⌘3 over a block
//     whose tint runs deeper still fires `merge_into_prompt`, with the MEMBER ids only
//     (the store owns the tree and expands them itself);
//   • the RESULT rendered, staged through `__PF_QA_DELTA` because the stub records
//     mutations without applying them. The text is the literal `cargo test`'s
//     `merge_into_prompt_nests_descendants_by_depth` asserts over the same tree — the two
//     suites meet at that string, exactly as ⌘B's meet at the command name.
// Worth rendering at all because the indent is LEADING WHITESPACE, which only survives if
// the prompt's text really is `white-space: pre-wrap` — a detail no Rust test can see.
//
// Its own page and fixture: the sweep sections above anchor on "the last row" and on the
// empty background under the list, so growing the main fixture would break them.
const FOLD_NODES = [
  node("g1", null, 0, "Alpha", "bulletPoint"),
  node("g1a", "g1", 0, "Child one", "checkbox"),
  node("g1a1", "g1a", 0, "Grandchild", "bulletPoint"),
  node("g1b", "g1", 1024, "Child two", "bulletPoint"),
  node("g2", null, 1024, "Beta", "bulletPoint"),
  node("g2a", "g2", 0, "Beta's child", "bulletPoint"),
  // Gamma parents a DRAFT: the "is this a conversion instead?" test is member-level, so a
  // draft buried in a member's subtree is content being collected, not a veto.
  node("g3", null, 2048, "Gamma", "bulletPoint"),
  node("g3a", "g3", 0, "a nested draft", "promptDraft"),
];
/** What `Store::merge_into_prompt` makes of [Alpha, Beta] — see the cargo test named above. */
const FOLDED = "- Alpha\n  - Child one\n    - Grandchild\n  - Child two\n- Beta\n  - Beta's child";

const gp = await b.newPage({
  viewport: { width: 720, height: 620 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
gp.on("pageerror", (e) => errors.push(String(e)));
gp.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await gp.addInitScript(tauriStub, {
  rev: 1,
  nodes: FOLD_NODES,
  canUndo: false,
  canRedo: false,
});
await gp.addInitScript(() =>
  localStorage.setItem(
    "pf.win.main",
    JSON.stringify({
      collapsed: [],
      hideCompleted: false,
      fontSize: 16,
      drill: null,
      focusPaneExpanded: false,
      focusPaneLayout: "top",
      focusSidebarWidth: 260,
      focusTopHeight: "auto",
    }),
  ),
);
await gp.goto(URL_, { waitUntil: "domcontentloaded" });
await gp.waitForSelector(".node-row", { timeout: 15000 });
await gp.addStyleTag({ content: "html,body{background:#101014 !important}" });
await gp.waitForTimeout(300);

const gRow = (text) => gp.locator(".node-row", { hasText: text }).first();
const gMarked = (cls) =>
  gp.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map(
        (r) =>
          r.querySelector(".node-text-wrap, .node-text-static")?.textContent.trim() ?? "",
      ),
    `.node-row.${cls}`,
  );
/** Sweep from `fromText`'s text out to `toText`'s row and LEAVE the selection live. */
async function gSweep(fromText, toText) {
  const a = await gRow(fromText).locator(".node-text-wrap").first().boundingBox();
  const bb = await gRow(toText).boundingBox();
  await gp.mouse.move(a.x + 8, a.y + a.height / 2);
  await gp.mouse.down();
  await gp.mouse.move(bb.x + 160, bb.y + bb.height / 2, { steps: 8 });
  await gp.waitForTimeout(60);
  await gp.mouse.up();
  await gp.waitForTimeout(60);
}

// Sweep root-level Alpha DOWN onto a grandchild-level row: the head resolves to Beta, so
// the members are two root siblings while the tint runs two levels deeper.
await gSweep("Alpha", "Beta's child");
const foldSel = { members: await gMarked("selected"), tinted: await gMarked("sel-tint") };
await shot("fold-selection", gp.locator(".app-body"));
await gp.keyboard.press("Meta+3");
await gp.waitForTimeout(140);
const foldInvoke = await gp.evaluate(() => window.__PF_QA_CALLS.at(-1));
await gp.keyboard.press("Escape");
await gp.waitForTimeout(80);

// A member whose SUBTREE holds a prompt still folds — the veto is member-level.
await gSweep("Beta", "a nested draft");
await gp.keyboard.press("Meta+3");
await gp.waitForTimeout(140);
const nestedDraftInvoke = await gp.evaluate(() => window.__PF_QA_CALLS.at(-1));
await gp.keyboard.press("Escape");
await gp.waitForTimeout(80);

// A LONE member is not a fold, however deep its tint runs: sweeping a parent onto its own
// grandchild resolves the head back to the parent, so the selection is one node — and ⌘3
// there is the ordinary conversion, which must never silently eat a subtree.
await gSweep("Alpha", "Grandchild");
const soloSel = await gMarked("selected");
await gp.keyboard.press("Meta+3");
await gp.waitForTimeout(140);
const soloInvoke = await gp.evaluate(() => window.__PF_QA_CALLS.at(-1));
await gp.keyboard.press("Escape");
await gp.waitForTimeout(80);

// Now stage what the store answers with: the head becomes the folded prompt and every
// node it swallowed — its OWN children included, since they are in its text now — goes.
// Sampled per frame while it lands: the head GROWS (one line → the whole folded list) in
// the same delta that removes six rows, and the rows below have to absorb both at once.
// The seam sends this down the `leave` path — `runKindReflow`'s remeasure fast-path is
// gated on `deleted.size === 0`, so the head's new height reaches the virtualizer only
// when its ResizeObserver reports it, and the slide below re-targets mid-flight. What
// this watches for is the teardown landing BEFORE that corrected slide finishes, which
// would drop `.rows-animating` and snap the remainder.
const foldTrace = await gp.evaluate(
  (folded) =>
    new Promise((resolve) => {
      const survivor = () =>
        [...document.querySelectorAll(".node-row")].find(
          (r) =>
            !r.closest(".collapse-ghosts") &&
            r.querySelector(".node-text-wrap, .node-text-static")?.textContent.trim() ===
              "Gamma",
        );
      const samples = [];
      const t0 = performance.now();
      const tick = () => {
        const el = survivor();
        samples.push({
          t: +(performance.now() - t0).toFixed(1),
          y: el ? +el.getBoundingClientRect().top.toFixed(1) : null,
          on: document.querySelector(".outline-inner")?.classList.contains("rows-animating"),
        });
        if (performance.now() - t0 < 800) requestAnimationFrame(tick);
        else resolve(samples);
      };
      window.__PF_QA_DELTA([
      {
        type: "upsert",
        node: {
          id: "g1",
          parent: null,
          position: 0,
          text: folded,
          note: "",
          kind: "promptDraft",
          isCompleted: false,
          isHighlighted: false,
          isCollapsed: false,
          boldRanges: [],
          italicRanges: [],
          underlineRanges: [],
          createdAt: 1700000000,
          updatedAt: 1700000000,
          completedAt: null,
        },
      },
        ...["g1a1", "g1a", "g1b", "g2a", "g2"].map((id) => ({ type: "delete", id })),
      ]);
      requestAnimationFrame(tick);
    }),
  FOLDED,
);
/** Every LIVE row's first line after the fold: the swallowed nodes are gone — the HEAD's
 * own children included, which is the half that would show every folded line twice —
 * while the untouched ones stand. Ghost clones are excluded (the leave animation owns
 * those and is deliberately left to finish), as is the trailing "+" placeholder. */
const foldSurvivors = await gp.evaluate(() =>
  [...document.querySelectorAll(".node-row")]
    .filter(
      (r) => !r.closest(".collapse-ghosts") && !r.classList.contains("add-child-row"),
    )
    .map(
      (r) =>
        (
          r.querySelector(".node-text-wrap, .node-text-static")?.textContent ?? ""
        ).split("\n")[0],
    ),
);

/** The folded prompt as the engine actually laid it out: the exact text it kept, and for
 * every line the x/y of its first INK (the bullet's dash — a leading space has no glyph to
 * measure, and the dash's x IS the indent a reader sees). */
const folded = await gp.evaluate(() => {
  const row = document.querySelector(".node-row.kind-promptDraft");
  const el = row.querySelector(".node-text-static, .node-text-wrap");
  // Map global text offsets onto the run spans, so a styled fold measures the same way.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts = [];
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    parts.push({ node: n, start: total });
    total += n.data.length;
  }
  const text = parts.map((p) => p.node.data).join("");
  const rectAt = (i) => {
    const p = [...parts].reverse().find((q) => q.start <= i);
    const r = document.createRange();
    r.setStart(p.node, i - p.start);
    r.setEnd(p.node, i - p.start + 1);
    return r.getBoundingClientRect();
  };
  const lines = [];
  let off = 0;
  for (const line of text.split("\n")) {
    const ink = line.search(/\S/);
    const r = ink < 0 ? null : rectAt(off + ink);
    lines.push({ text: line, x: r ? +r.left.toFixed(2) : null, y: r ? +r.top.toFixed(2) : null });
    off += line.length + 1;
  }
  return {
    text,
    lines,
    panelH: +row.querySelector(".prompt-panel").getBoundingClientRect().height.toFixed(2),
    lineH: parseFloat(getComputedStyle(el).fontSize) * 1.35,
  };
});
await shot("fold-result", gp.locator(".app-body"));
/** The landing, read off the trace: the first row BELOW the fold has to absorb six rows
 * leaving AND the head growing into a six-line panel, and the head's new height only
 * reaches the virtualizer through its ResizeObserver. `settled` is the whole point — the
 * distance still to travel at the last frame that had `.rows-animating` on. Anything but
 * ~0 means the teardown fired first and the rest of the slide was a snap. */
const foldFinalY = foldTrace[foldTrace.length - 1].y;
const foldLastOn = [...foldTrace].reverse().find((f) => f.on);
const foldSlide = {
  frames: new Set(foldTrace.map((f) => f.y)).size,
  travel: +(foldTrace[0].y - foldFinalY).toFixed(1),
  maxStep: +Math.max(
    ...foldTrace.slice(1).map((f, i) => Math.abs(f.y - foldTrace[i].y)),
  ).toFixed(1),
  settled: foldLastOn ? +Math.abs(foldLastOn.y - foldFinalY).toFixed(2) : null,
};
const foldX = folded.lines.map((l) => l.x);
// Indent STEP per level, measured off the rendered dashes: depth 0 → 1 → 2.
const foldStep = [foldX[1] - foldX[0], foldX[2] - foldX[1]];

// ---- Report ------------------------------------------------------------------
const eq = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const distinct = (xs) => new Set(xs.filter((v) => v != null)).size;
// The tick's ink as a fraction of its own circle's diameter — the one number that says
// "the same check mark" across two circle sizes.
const inkRatio = (g) => (g.check ? +(g.check.w / (2 * g.r + 2)).toFixed(3) : null);
/** Is a resolved colour white (whatever its alpha)? `--text` is white at 0.92. */
const white = (c) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(c ?? "");
  if (!m) return false;
  const [r, g, bl] = m[1].split(",").map((s) => parseFloat(s));
  return r === 255 && g === 255 && bl === 255;
};
const checks = [
  ["divider at rest: rule starts at the row's content edge", eq(rest.ruleLeft, rest.contentLeft)],
  ["divider at rest: actions clip is 0 wide", rest.clipW === 0],
  ["divider hovered: clip opens", hovered.clipW > 20],
  ["divider hovered: rule gives up exactly the clip's width", eq(hovered.ruleLeft - rest.ruleLeft, hovered.clipW)],
  ["divider hovered: actions are + then ⋯, no zoom", JSON.stringify(hovered.btns.map((b) => b.label)) === '["Add node","Node menu"]'],
  ["divider hovered: actions faded in", hovered.btns.every((b) => b.opacity === "1")],
  ["divider: clip width interpolates (>4 distinct frames)", new Set(sweep).size > 4],
  ["divider: the rule IS the row centre (the reference the glyphs align to)", Math.abs(inkOffsets.rule) <= 0.1],
  ["divider: the + is INK-centred on the row, not line-box centred", Math.abs(inkOffsets.plus) <= 0.35],
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
  // --- ending a selection ---
  ["end sel: the sweep left a two-node selection live", selBeforeButton.length === 2],
  ["end sel: pressing a row BUTTON drops it", afterButtonPress.length === 0],
  ["end sel: pressing a MEMBER's glyph keeps it", memberGlyphDrag.selected.length === 2],
  ["end sel: …and drags the whole block", memberGlyphDrag.ghost === "2 items"],
  ["end sel: ↓ clears it and focuses past the block (over the divider)", afterArrowDown.selected === 0 && afterArrowDown.focused === "After the nested divider"],
  ["end sel: ↑ clears it and focuses the row above", afterArrowUp.selected === 0 && afterArrowUp.focused === "Welcome to PromptFlow"],
  ["end sel: ⌘B runs the block bold over both members", boldCall.cmd === "toggle_bold_block" && boldCall.args.ids.length === 2],
  ["end sel: ⌘3 over non-prompts FOLDS them into one prompt", foldCall.cmd === "merge_into_prompt" && foldCall.args.ids.length === 2],
  ["end sel: ⌘3 over a range holding a prompt converts instead", convertCall.cmd === "set_kind_block" && convertCall.args.kind === "promptDraft"],
  ["end sel: ⌫ clears it and leaves the caret above the block", afterDelete.selected === 0 && afterDelete.focused === "Welcome to PromptFlow"],
  // --- completion glyph ---
  ["complete: a completed PARENT draws a check mark", restDoneParent.check !== null],
  ["complete: an incomplete parent draws none", restOpenParent.check === null],
  ["complete: its pie is mounted but invisible", restDoneParent.wedge?.opacity === 0],
  ["complete: an incomplete parent's pie is visible", restOpenParent.wedge?.opacity === 1],
  ["complete: the parent's circle stays the PARENT size", restDoneParent.r > restDoneLeaf.r],
  ["complete: the tick is bigger on the bigger circle", restDoneParent.check.w > restDoneLeaf.check.w],
  ["complete: …by the SAME proportion of its circle", eq(inkRatio(restDoneParent), inkRatio(restDoneLeaf), 0.02)],
  ["complete: the tick is centred in the glyph box", eq(restDoneParent.check.cx, restDoneLeaf.check.cx, 0.6) && eq(restDoneParent.check.cy, restDoneLeaf.check.cy, 0.6)],
  ["complete: the tick is the completion green", restDoneParent.check.stroke === restDoneLeaf.check.stroke],
  ["complete: a resting tick is fully drawn (no self-start)", restDoneParent.check.offset === 0],
  ["complete: checking a parent strokes the tick in (>4 frames)", distinct(fullPie.map((f) => f.c)) > 4],
  ["complete: …and fades the pie out under it (>4 frames)", distinct(fullPie.map((f) => f.w)) > 4],
  ["complete: the pie starts opaque and ends invisible", fullPie[0].w === 1 && afterFull.wedge.opacity === 0],
  ["complete: the tick ends fully drawn", afterFull.check?.offset === 0],
  ["complete: a PARTIAL pie fades the same way", distinct(partPie.map((f) => f.w)) > 4 && afterPart.wedge.opacity === 0],
  ["complete: un-checking removes the tick", afterUncheck.check === null],
  ["complete: …and brings the pie back, interpolated", distinct(unchecked.map((f) => f.w)) > 4 && afterUncheck.wedge.opacity === 1],
  ["complete: the pie and the tick are both live animations", paused >= 2],
  // --- parent glyph identity (bullet vs checkbox at full progress) ---
  ["parent glyph: an all-done BULLET's pie is translucent", alpha(bulletDone.wedge) < 1],
  ["parent glyph: its centre dot stays opaque", alpha(bulletDone.dot) === 1],
  ["parent glyph: so the dot is not lost in its own fill", bulletDone.wedge !== bulletDone.dot],
  ["parent glyph: an all-done CHECKBOX's pie is opaque", alpha(checkboxDone.wedge) === 1],
  ["parent glyph: the two all-done glyphs no longer paint the same fill", bulletDone.wedge !== checkboxDone.wedge],
  ["parent glyph: the bullet's last child is a pure HUE change (alpha unchanged)", alpha(bulletDone.wedge) === alpha(bulletHalf.wedge)],
  // --- focus pane: the Current Task line ---
  ["focus: the task is the first LEAF, not the first child", focusRest[0].task === "Child 1"],
  ["focus: …under the pinned node's own accent title", focusRest[0].title === "Example"],
  ["focus: the task is white, the title is not", white(focusRest[0].taskColor) && !white(focusRest[0].titleColor)],
  ["focus: a pinned node with no children has NO task element", focusRest[1].task === null],
  ["focus: …nor has one whose every child is done", focusRest[2].task === null],
  ["focus: a prompt is never the task, but is DESCENDED into", focusRest[3].task === "Refine the wording"],
  ["focus: a prompt with nothing open under it is backtracked out of", focusRest[4].task === "The real next action"],
  ["focus: a prompt alone leaves no task at all", focusRest[5].task === null],
  ["focus: the ancestor breadcrumb is gone entirely", focusStrays === 0],
  ["focus: clicking the row reveals the TASK through collapsed ancestors", afterReveal.focused === "Child 1" && afterReveal.rowExists],
  ["focus: ticking the task off in the outline advances it, live", afterComplete[0] === "Child 2"],
  ["focus: …and un-ticking it hands it back", afterUncomplete[0] === "Child 1"],
  ["focus: a remote text edit repaints the task line", afterRename[0] === "Child 1, renamed"],
  ["focus: a new first child takes over as the task", afterInsert[0] === "Brand new first child"],
  ["focus: …and deleting it hands the task back", afterRemove[0] === "Child 1, renamed"],
  ["focus: completing a parent skips its whole subtree", afterParentDone[0] === "Child 3"],
  ["focus: the other rows never moved", JSON.stringify(afterParentDone.slice(1)) === JSON.stringify(focusRest.slice(1).map((r) => r.task))],
  ["focus: converting the task to a prompt backtracks off it — on a KIND flip alone", afterKindFlip === "A plain sibling task"],
  ["focus: an over-long task stays on ONE line in the sidebar dock, overflowing", sidebarTask.lines <= 1 && sidebarTask.clipped],
  ["focus: …and that overflow is painted as an ellipsis, not a hard clip", sidebarTask.ellipsis === "ellipsis"],
  ["focus: …without pushing the row wider than the title above it", sidebarTask.withinTitle],
  // --- folding a hierarchical selection ---
  ["fold: a sweep onto a deeper row still selects two root members", JSON.stringify(foldSel.members) === '["Alpha","Beta"]'],
  ["fold: …with both subtrees, two levels deep, tinted", ["Child one", "Grandchild", "Child two", "Beta's child"].every((t) => foldSel.tinted.includes(t))],
  ["fold: ⌘3 folds the block rather than converting it", foldInvoke.cmd === "merge_into_prompt"],
  ["fold: it sends the MEMBERS, not the tint — the store expands them", JSON.stringify(foldInvoke.args.ids) === '["g1","g2"]'],
  ["fold: a draft nested inside a member does not veto the fold", nestedDraftInvoke.cmd === "merge_into_prompt"],
  ["fold: a LONE member with a deep tint is converted, not folded", soloSel.length === 1 && soloInvoke.cmd === "set_kind_block"],
  // textContent is CSS-blind, so this pins the STRING the store's literal produced, not
  // its rendering; the indent-step checks below are what prove the spaces actually paint.
  ["fold: the prompt's text is the folded list, verbatim", folded.text === FOLDED],
  ["fold: every folded node is gone, the untouched ones stand", JSON.stringify(foldSurvivors) === '["- Alpha","Gamma","a nested draft"]'],
  ["fold: each line is its own line box", distinct(folded.lines.map((l) => l.y)) === 6],
  ["fold: the panel is six lines tall", folded.panelH >= 6 * folded.lineH],
  ["fold: the leading spaces PAINT — depth 1 starts right of depth 0, depth 2 right of 1 (pre-wrap holds them)", foldStep[0] > 2 && foldStep[1] > 2],
  ["fold: …by the SAME step per level", eq(foldStep[0], foldStep[1], 0.2)],
  ["fold: siblings at one depth share an indent", eq(foldX[1], foldX[3]) && eq(foldX[0], foldX[4]) && eq(foldX[3], foldX[5])],
  ["fold: the rows below SLIDE up as the block leaves (>8 interpolated frames)", foldSlide.frames > 8 && foldSlide.travel > 40],
  ["fold: …and land before `.rows-animating` drops — the remainder is never snapped", foldSlide.settled !== null && foldSlide.settled <= 1],
  ["no page errors", errors.length === 0],
];
console.log("\nrest    :", JSON.stringify(rest));
console.log("hover   :", JSON.stringify(hovered));
console.log("sweep   :", sweep.join(" "));
console.log("prompt  :", JSON.stringify(prompt));
console.log("bullet  :", JSON.stringify(bullet));
console.log("ink     :", JSON.stringify(inkOffsets), "(px from the row centre; + was +1.33 before the padding fix)");
console.log("arrows  :", JSON.stringify(arrows));
console.log("sweep   :", JSON.stringify({ sweepSiblings, sweepClamp, sweepUp, sweepFromEditor, sweepFromBackground, glyphDrag }));
console.log("end sel :", JSON.stringify({ selBeforeButton, afterButtonPress, memberGlyphDrag, afterArrowDown, afterArrowUp, boldCall, foldCall, convertCall, afterDelete }));
console.log("complete:", JSON.stringify({ restDoneParent, restDoneLeaf, restOpenParent, afterFull, afterPart, afterUncheck }));
console.log("  ratio :", "parent", inkRatio(restDoneParent), "leaf", inkRatio(restDoneLeaf), "(tick ink / circle diameter)");
console.log("  pie   :", fullPie.map((f) => `${f.t}:${f.w}`).join(" "));
console.log("  tick  :", fullPie.map((f) => `${f.t}:${f.c}`).join(" "));
console.log("parents :", JSON.stringify({ bulletDone, bulletHalf, checkboxDone }));
console.log("focus   :", JSON.stringify(focusRest));
console.log("  live  :", JSON.stringify({ afterReveal, afterComplete, afterUncomplete, afterRename, afterInsert, afterRemove, afterParentDone, afterKindFlip }));
console.log("  dock  :", JSON.stringify(sidebarTask));
console.log("fold    :", JSON.stringify({ foldSel, foldInvoke, nestedDraftInvoke, soloSel, soloInvoke }));
console.log("  rows  :", JSON.stringify(foldSurvivors));
console.log("  lines :", JSON.stringify(folded.lines));
console.log("  indent:", foldStep.map((s) => s.toFixed(2)).join(" / "), "px per level");
console.log("  slide :", JSON.stringify(foldSlide));
console.log("  trace :", foldTrace.filter((f) => f.on).map((f) => `${f.t}:${f.y}`).join(" "), "| then", foldFinalY);
if (errors.length) console.log("errors  :", errors.slice(0, 5));
console.log();
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
await b.close();
process.exit(failed ? 1 : 0);
