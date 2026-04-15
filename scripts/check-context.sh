#!/usr/bin/env bash
# check-context.sh — show Claude Code context window usage from local session files
# No AI tokens consumed — reads disk only.
#
# Usage:
#   check-context.sh                  # active session for current working directory
#   check-context.sh --all            # all sessions across all projects
#   check-context.sh <session-id>     # specific session by ID

set -euo pipefail
# Prevent SIGPIPE from ls|head killing the script under pipefail
trap '' PIPE

SESSIONS_DIR="$HOME/.claude/sessions"
PROJECTS_DIR="$HOME/.claude/projects"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

# Context limits by model prefix (tokens)
context_limit() {
  local model="$1"
  case "$model" in
    claude-opus-4*|claude-sonnet-4*|claude-haiku-4*) echo 200000 ;;
    claude-3-5*|claude-3-opus*) echo 200000 ;;
    claude-3-haiku*) echo 200000 ;;
    *) echo 200000 ;;  # safe default
  esac
}

# Convert cwd path to project slug
cwd_to_slug() {
  echo "$1" | sed 's|/|-|g'
}

# Render a progress bar (width 30)
progress_bar() {
  local pct="$1"
  local width=30
  local filled=$(( pct * width / 100 ))
  local empty=$(( width - filled ))
  local bar=""
  for (( i=0; i<filled; i++ )); do bar+="█"; done
  for (( i=0; i<empty; i++ )); do bar+="░"; done
  echo "$bar"
}

# Colour for percentage
pct_colour() {
  local pct="$1"
  if   (( pct >= 85 )); then echo "$RED"
  elif (( pct >= 60 )); then echo "$YELLOW"
  else                       echo "$GREEN"
  fi
}

# Print stats for one JSONL session file
print_session() {
  local jsonl="$1"
  local label="$2"

  if [[ ! -f "$jsonl" ]]; then
    echo -e "${RED}✗${RESET} Session file not found: $jsonl"
    return 1
  fi

  # Extract last usage block using python3 (available on all systems)
  local usage
  usage=$(python3 - "$jsonl" <<'EOF'
import json, sys

path = sys.argv[1]
last_usage = None
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            u = obj.get("message", {}).get("usage")
            if u:
                last_usage = u
                # also grab model while we're here
                m = obj.get("message", {}).get("model")
                if m:
                    last_usage["_model"] = m
        except json.JSONDecodeError:
            pass

if last_usage is None:
    print("NO_USAGE")
else:
    print(json.dumps(last_usage))
EOF
)

  if [[ "$usage" == "NO_USAGE" ]]; then
    echo -e "${DIM}  $label — no usage data (session may not have made any API calls yet)${RESET}"
    return 0
  fi

  local input cache_read cache_create model total limit pct bar col
  input=$(echo "$usage"      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('input_tokens',0))")
  cache_read=$(echo "$usage" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cache_read_input_tokens',0))")
  cache_create=$(echo "$usage" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cache_creation_input_tokens',0))")
  model=$(echo "$usage"      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('_model','unknown'))")

  total=$(( input + cache_read + cache_create ))
  limit=$(context_limit "$model")
  pct=$(( total * 100 / limit ))
  bar=$(progress_bar "$pct")
  col=$(pct_colour "$pct")

  printf "%b%s%b\n" "$CYAN" "$label" "$RESET"
  printf "  Model : %s (limit %'d tokens)\n" "$model" "$limit"
  printf "  Used  : %'d tokens\n" "$total"
  printf "          input=%'d  cache_read=%'d  cache_create=%'d\n" "$input" "$cache_read" "$cache_create"
  printf "  %b[%s] %d%%%b\n" "$col" "$bar" "$pct" "$RESET"
  echo ""
}

# ── Modes ──────────────────────────────────────────────────────────────────────

mode="${1:-}"

if [[ "$mode" == "--all" ]]; then
  # All sessions, most recent first
  echo -e "${CYAN}All Claude Code sessions (most recent first)${RESET}\n"
  found=0
  while IFS= read -r session_json; do
    sid=$(python3 -c "import json; d=json.load(open('$session_json')); print(d.get('sessionId',''))" 2>/dev/null)
    cwd=$(python3 -c "import json; d=json.load(open('$session_json')); print(d.get('cwd',''))" 2>/dev/null)
    [[ -z "$sid" || -z "$cwd" ]] && continue
    slug=$(cwd_to_slug "$cwd")
    jsonl="$PROJECTS_DIR/$slug/$sid.jsonl"
    [[ -f "$jsonl" ]] || continue
    print_session "$jsonl" "$sid  ($cwd)"
    found=$(( found + 1 ))
  done < <(python3 -c "
import os, glob
files = glob.glob(os.path.join('$SESSIONS_DIR', '*.json'))
files.sort(key=os.path.getmtime, reverse=True)
print('\n'.join(files))
" 2>/dev/null)
  [[ $found -eq 0 ]] && echo "No sessions found."

elif [[ -n "$mode" && "$mode" != --* ]]; then
  # Specific session ID
  sid="$mode"
  # Find cwd for this session
  cwd=""
  for f in "$SESSIONS_DIR"/*.json; do
    s=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('sessionId',''))" 2>/dev/null)
    if [[ "$s" == "$sid" ]]; then
      cwd=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cwd',''))" 2>/dev/null)
      break
    fi
  done
  if [[ -z "$cwd" ]]; then
    echo -e "${RED}Session ID not found: $sid${RESET}"
    exit 1
  fi
  slug=$(cwd_to_slug "$cwd")
  jsonl="$PROJECTS_DIR/$slug/$sid.jsonl"
  print_session "$jsonl" "$sid  ($cwd)"

else
  # Default: active session for current directory
  cwd="$(pwd)"
  slug=$(cwd_to_slug "$cwd")
  project_dir="$PROJECTS_DIR/$slug"

  if [[ ! -d "$project_dir" ]]; then
    echo -e "${RED}No Claude Code project found for: $cwd${RESET}"
    echo "Expected: $project_dir"
    exit 1
  fi

  # Find the most recently modified JSONL for this project
  # (ls glob would exceed ARG_MAX with many sessions, use python instead)
  latest=$(python3 -c "
import os, glob
files = glob.glob(os.path.join('$project_dir', '*.jsonl'))
files.sort(key=os.path.getmtime, reverse=True)
print(files[0] if files else '')
")
  if [[ -z "$latest" ]]; then
    echo -e "${RED}No session files found in $project_dir${RESET}"
    exit 1
  fi

  sid=$(basename "$latest" .jsonl)
  echo -e "${CYAN}Active session for: $cwd${RESET}\n"
  print_session "$latest" "$sid"
fi
