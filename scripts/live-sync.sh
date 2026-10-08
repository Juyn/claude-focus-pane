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
ssh_opts=(-o BatchMode=yes -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o ConnectTimeout=5
  -o ControlMaster=auto -o ControlPersist=60 -o "ControlPath=$cache/ssh-%C" -o ServerAliveInterval=5 -o ServerAliveCountMax=2)
ssh_cmd=(ssh "${ssh_opts[@]}" "$remote")

mkdir -p "$cache/hosts" "$cache/live"
printf '%s\n' "$local_label" > "$cache/label"
remote_ready=0

while :; do
  # Remote init (retried until ready): mkdir and label.
  if [ "$remote_ready" = 0 ]; then
    "${ssh_cmd[@]}" "mkdir -p ~/.cache/focus-pane/hosts ~/.cache/focus-pane/live && printf '%s\n' '$remote_label' > ~/.cache/focus-pane/label" && remote_ready=1 || true
  fi
  # Ours, here and there.
  if python3 "$here/live_snapshot.py" > "$cache/hosts/$local_host.json.tmp" 2>/dev/null; then
    mv "$cache/hosts/$local_host.json.tmp" "$cache/hosts/$local_host.json"
    "${ssh_cmd[@]}" "mkdir -p ~/.cache/focus-pane/hosts && cat > ~/.cache/focus-pane/hosts/$local_host.json.tmp && mv ~/.cache/focus-pane/hosts/$local_host.json.tmp ~/.cache/focus-pane/hosts/$local_host.json" \
      < "$cache/hosts/$local_host.json" 2>/dev/null || true
  fi
  # Theirs, here: only a complete answer replaces the last one.
  if "${ssh_cmd[@]}" 'python3 ~/.claude/mods/focus-pane/scripts/live_snapshot.py' > "$cache/hosts/$remote.json.tmp" 2>/dev/null \
    && [ -s "$cache/hosts/$remote.json.tmp" ]; then
    mv "$cache/hosts/$remote.json.tmp" "$cache/hosts/$remote.json"
  else
    rm -f "$cache/hosts/$remote.json.tmp"
  fi
  # The inbox: only files that held still for 10 s (never one still being written), never temp downloads,
  # never empty; sent in the background under a lock, so a large upload never stalls the loop.
  if [ -d "$HOME/inbox" ]; then
    (
      flock -n 9 || exit 0
      touch -d "@$(( $(date +%s) - 10 ))" "$cache/inbox.ref"
      # rsync and its ssh get no fd 9: a ControlMaster born here would otherwise hold the lock for its whole life.
      if find "$HOME/inbox" -type f ! -path '*/.*' ! -name '*.part' ! -name '*.crdownload' ! -name '*.tmp' -size +0 \
           ! -newer "$cache/inbox.ref" -printf '%P\0' 2>/dev/null \
         | rsync -rl --from0 --files-from=- --ignore-existing --partial-dir=.rsync-partial --timeout=30 \
             -e "ssh ${ssh_opts[*]}" "$HOME/inbox/" "$remote:inbox/" >/dev/null 2>"$cache/inbox-sync.err.new" 9>&-; then
        rm -f "$cache/inbox-sync.err" "$cache/inbox-sync.err.new"
      else
        # Said once in the journal, each time the error changes.
        cmp -s "$cache/inbox-sync.err.new" "$cache/inbox-sync.err" 2>/dev/null || cat "$cache/inbox-sync.err.new" >&2
        mv -f "$cache/inbox-sync.err.new" "$cache/inbox-sync.err"
      fi
    ) 9>"$cache/inbox.lock" &
  fi
  sleep "$interval"
done
