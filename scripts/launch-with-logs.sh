#!/usr/bin/env bash
# Run the source checkout with visible logs. Used by the Linux desktop entry.
# Invoke with bash so a fresh clone does not depend on executable file modes.

run_studio() {
  local repo_dir
  repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)" || return
  cd -- "$repo_dir" || return
  bun run dev
}

run_studio
studio_status=$?
printf '\nVoiceStudio stopped (exit code %s).\n' "$studio_status"
if [[ -t 0 ]]; then
  read -r -p 'Press Enter to close this terminal...' _
fi
exit "$studio_status"
