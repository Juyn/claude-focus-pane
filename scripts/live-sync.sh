#!/usr/bin/env bash
# Mirrors the live snapshots between this machine and one reached by SSH, every few seconds:
# theirs lands here in ~/.cache/focus-pane/hosts/<alias>.json, ours there in hosts/<hostname>.json.
# Runs on the machine that can reach the other (the PC). Touches nothing outside ~/.cache/focus-pane.
# Usage: live-sync.sh <ssh-alias> [local-label] [remote-label] [interval-seconds]
set -u

remote="${1:?usage: live-sync.sh <ssh-alias> [local-label] [remote-label] [interval]}"
local_label="${2:-PC}"
remote_label="${3:-VPS}"
interval="${4:-3}"
here="$(cd "$(dirname "$0")" && pwd)"
cache="$HOME/.cache/focus-pane"
local_host="$(hostname)"
ssh_cmd=(ssh -o BatchMode=yes -o ConnectTimeout=5 -o ControlMaster=auto -o ControlPersist=60
  -o "ControlPath=$cache/ssh-%C" "$remote")

mkdir -p "$cache/hosts" "$cache/live"
printf '%s\n' "$local_label" > "$cache/label"
"${ssh_cmd[@]}" "mkdir -p ~/.cache/focus-pane/hosts ~/.cache/focus-pane/live && printf '%s\n' '$remote_label' > ~/.cache/focus-pane/label" || true

while :; do
  # Ours, here and there.
  if python3 "$here/live_snapshot.py" > "$cache/hosts/$local_host.json.tmp" 2>/dev/null; then
    mv "$cache/hosts/$local_host.json.tmp" "$cache/hosts/$local_host.json"
    "${ssh_cmd[@]}" "cat > ~/.cache/focus-pane/hosts/$local_host.json.tmp && mv ~/.cache/focus-pane/hosts/$local_host.json.tmp ~/.cache/focus-pane/hosts/$local_host.json" \
      < "$cache/hosts/$local_host.json" 2>/dev/null || true
  fi
  # Theirs, here: only a complete answer replaces the last one.
  if "${ssh_cmd[@]}" 'python3 ~/.claude/mods/focus-pane/scripts/live_snapshot.py' > "$cache/hosts/$remote.json.tmp" 2>/dev/null \
    && [ -s "$cache/hosts/$remote.json.tmp" ]; then
    mv "$cache/hosts/$remote.json.tmp" "$cache/hosts/$remote.json"
  else
    rm -f "$cache/hosts/$remote.json.tmp"
  fi
  sleep "$interval"
done
