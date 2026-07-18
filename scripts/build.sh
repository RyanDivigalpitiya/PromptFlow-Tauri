#!/bin/zsh
# Release build -> src-tauri/target/release/bundle/macos/PromptFlow.app
cd "$(dirname "$0")/.."
npm run tauri build
