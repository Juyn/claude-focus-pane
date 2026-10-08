#!/usr/bin/env sh
# Registers this folder as a Claude Code mod for every session of this user:
# adds it to CLAUDE_CODE_PLUGIN_DIRS in the env block of ~/.claude/settings.json.
# Idempotent; the previous settings.json is kept beside it as a dated backup.
set -eu

sync_alias=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sync) sync_alias="${2:?--sync needs an SSH alias}"; shift 2 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

command -v python3 >/dev/null || { echo "install.sh: python3 is required" >&2; exit 1; }
mkdir -p "$(dirname "$settings")"
[ -f "$settings" ] || echo '{}' > "$settings"

python3 - "$settings" "$here" <<'PY'
import json, os, shutil, sys, time

path, here = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as held:
    settings = json.load(held)

env = settings.setdefault('env', {})
dirs = [one for one in env.get('CLAUDE_CODE_PLUGIN_DIRS', '').split(os.pathsep) if one]
known = {os.path.realpath(os.path.expanduser(one)) for one in dirs}
if os.path.realpath(here) in known and env.get('CLAUDE_CODE_PLUGIN_DIR_WATCH') == '1':
    print(f'already installed: {here}')
    sys.exit(0)

shutil.copy2(path, f'{path}.bak-{time.strftime("%Y%m%d-%H%M%S")}')
if os.path.realpath(here) not in known:
    dirs.append(here)
env['CLAUDE_CODE_PLUGIN_DIRS'] = os.pathsep.join(dirs)
env['CLAUDE_CODE_PLUGIN_DIR_WATCH'] = '1'
with open(path, 'w', encoding='utf-8') as held:
    json.dump(settings, held, indent=2, ensure_ascii=False)
    held.write('\n')
print(f'installed: {here} -> {path}')
PY

for tool in magick xdg-open; do
  command -v "$tool" >/dev/null || echo "note: '$tool' not found (see README, optional features)"
done
found=""
for browser in brave chromium google-chrome-stable google-chrome chrome; do
  command -v "$browser" >/dev/null && found=$browser && break
done
[ -n "$found" ] || echo "note: no Chromium browser found (mockup thumbnails will be unavailable)"

if [ -n "$sync_alias" ]; then
  command -v systemctl >/dev/null || { echo "install.sh: systemctl is required for --sync" >&2; exit 1; }
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/focus-pane-sync.service" <<UNIT
[Unit]
Description=focus-pane: live sessions mirrored with $sync_alias
After=network-online.target

[Service]
ExecStart=$here/scripts/live-sync.sh $sync_alias
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  # The inbox: the folder files are dropped in, and two Nautilus bookmarks (here, and there over sftp).
  mkdir -p "$HOME/inbox"
  bookmarks="${XDG_CONFIG_HOME:-$HOME/.config}/gtk-3.0/bookmarks"
  mkdir -p "$(dirname "$bookmarks")"
  touch "$bookmarks"
  grep -q "^file://$HOME/inbox " "$bookmarks" || printf 'file://%s/inbox Vers VPS\n' "$HOME" >> "$bookmarks"
  remote_home=$(ssh -o BatchMode=yes -o ConnectTimeout=5 -o ForwardAgent=no "$sync_alias" 'printf %s "$HOME"' 2>/dev/null || true)
  if [ -n "$remote_home" ]; then
    grep -q "^sftp://$sync_alias$remote_home/inbox " "$bookmarks" || printf 'sftp://%s%s/inbox Inbox VPS\n' "$sync_alias" "$remote_home" >> "$bookmarks"
  else
    echo "note: $sync_alias unreachable, the sftp bookmark was not added (run install.sh --sync again later)"
  fi
  systemctl --user daemon-reload
  systemctl --user enable focus-pane-sync.service
  systemctl --user restart focus-pane-sync.service
  echo "sync: focus-pane-sync.service running against $sync_alias"
fi

echo "Start a NEW Claude Code session: plugin folders are read at process start."
