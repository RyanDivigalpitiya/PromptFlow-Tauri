---
name: release
description: Build the Tauri PromptFlow release bundle and deploy it to /Applications, replacing the installed PromptFlow.app. Use when the user asks to release, deploy, install, or "ship" the app to /Applications.
---

# /release — build and deploy PromptFlow to /Applications

Builds the release bundle and installs it over `/Applications/PromptFlow.app`.
Follow these steps in order. Stop and report if any step fails.

## 0. Preflight

- Work from the repo root (`/Users/ryandiv/Code/PromptFlow-Tauri`). All paths below are relative to it.
- The release bundle lands at `src-tauri/target/release/bundle/macos/PromptFlow.app`
  (`productName` is `PromptFlow`, identifier `com.ryandiv.promptflow-tauri`).
- Optional but recommended before a real release: `npm test && (cd src-tauri && cargo test) && npx tsc --noEmit`.
  Skip only if the user asked for a quick/dirty deploy.

## 1. Build (slow — run in background and wait)

`npm run tauri build` compiles the Rust release binary and can take several minutes.
Run it in the background and monitor for completion rather than blocking:

```sh
scripts/build.sh
```

Watch for `Finished` / a printed `.app` path, or a compile error. On error, stop and
surface it — do NOT touch `/Applications`.

Confirm the bundle exists and is newer than the run:

```sh
ls -ld src-tauri/target/release/bundle/macos/PromptFlow.app
```

## 2. Safety guard — never clobber the SwiftUI daily-driver

The user's **real SwiftUI PromptFlow** ships with the same product name `PromptFlow`.
Only replace the installed app if it is the Tauri port (or absent). Check its identifier:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "/Applications/PromptFlow.app/Contents/Info.plist" 2>/dev/null
```

- `com.ryandiv.promptflow-tauri` → it's a prior Tauri deploy. Proceed.
- No such file → nothing installed. Proceed (fresh install).
- **Any other identifier** (e.g. a SwiftUI bundle id) → **STOP** and ask the user to
  confirm before overwriting; it may be their daily driver.

If a `PromptFlow` process with identifier `com.ryandiv.promptflow-tauri` is running, note
that the swap takes effect on its next launch (a running bundle can be replaced on disk;
the live process keeps running). Do not force-quit anything unless the user asks — a
force-quit could hit their SwiftUI app, which shares the process name.

## 3. Deploy (backup-first, then replace)

Keep a one-deep backup so a bad build is reversible, then copy with `ditto` (preserves the
bundle's metadata/permissions better than `cp -R`):

```sh
SRC="src-tauri/target/release/bundle/macos/PromptFlow.app"
DST="/Applications/PromptFlow.app"
if [ -d "$DST" ]; then rm -rf "$DST.prev" && mv "$DST" "$DST.prev"; fi
ditto "$SRC" "$DST"
```

If `ditto`/`rm`/`mv` fails on permissions, retry the failing command with `sudo` and tell
the user you needed elevated permissions (they'll be prompted).

## 4. Verify

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier'      "/Applications/PromptFlow.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/PromptFlow.app/Contents/Info.plist"
ls -ld /Applications/PromptFlow.app
```

Confirm the identifier is `com.ryandiv.promptflow-tauri` and the timestamp is fresh.
Report the installed version and the path. Do NOT auto-launch it unless the user asks.
Once verified, the `.prev` backup can be removed (`rm -rf /Applications/PromptFlow.app.prev`)
or left for one cycle — mention it.
