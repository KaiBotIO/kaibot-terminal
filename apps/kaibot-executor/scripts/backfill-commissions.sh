#!/usr/bin/env bash
# Fill in venue commissions on the executor's fill ledger.
#
#   KAIBOT_EXECUTOR_URL=http://host:3401 KAIBOT_EXECUTOR_TOKEN=... \
#     scripts/backfill-commissions.sh [--apply] [--only-zero] [--limit N]
#
# Dry run by default: prints the per-fill report without writing. --apply
# writes. The token is a session token (POST /api/auth/login returns one); a
# desktop build trusts the local caller and needs none.
set -euo pipefail

url="${KAIBOT_EXECUTOR_URL:-http://127.0.0.1:3401}"
token="${KAIBOT_EXECUTOR_TOKEN:-}"
dry=1
only_zero=0
limit=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) dry=0 ;;
    --only-zero) only_zero=1 ;;
    --limit) limit="$2"; shift ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

body="{\"dryRun\":$([ "$dry" = 1 ] && echo true || echo false),\"onlyZero\":$([ "$only_zero" = 1 ] && echo true || echo false)"
[ -n "$limit" ] && body="$body,\"limit\":$limit"
body="$body}"

auth=()
[ -n "$token" ] && auth=(-H "Authorization: Bearer $token")

curl -sS -f -X POST "$url/api/ops/fills/backfill-commissions" \
  -H 'Content-Type: application/json' "${auth[@]}" \
  -d "$body"
echo
