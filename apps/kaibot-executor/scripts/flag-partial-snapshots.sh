#!/usr/bin/env bash
# Flag balance-snapshot ticks that missed a connected session (curve gaps).
#
#   KAIBOT_EXECUTOR_URL=http://host:3401 KAIBOT_EXECUTOR_TOKEN=... \
#     scripts/flag-partial-snapshots.sh [--apply] [--window-hours N]
#
# Dry run by default: reports the ticks it would flag without writing. --apply
# writes. Nothing is deleted; a rerun after --apply reports zero.
set -euo pipefail

url="${KAIBOT_EXECUTOR_URL:-http://127.0.0.1:3401}"
token="${KAIBOT_EXECUTOR_TOKEN:-}"
dry=1
window=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) dry=0 ;;
    --window-hours) window="$2"; shift ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

body="{\"dryRun\":$([ "$dry" = 1 ] && echo true || echo false)"
[ -n "$window" ] && body="$body,\"windowHours\":$window"
body="$body}"

auth=()
[ -n "$token" ] && auth=(-H "Authorization: Bearer $token")

curl -sS -f -X POST "$url/api/ops/balance-snapshots/flag-partial" \
  -H 'Content-Type: application/json' "${auth[@]}" \
  -d "$body"
echo
