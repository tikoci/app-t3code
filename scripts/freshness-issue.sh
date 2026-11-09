#!/usr/bin/env bash
# Keep one open `freshness` issue in step with the scheduled freshness run
# (.github/workflows/freshness.yml), so drift is a notification, not only a
# red run nobody opened:
#
#   red, no open issue        -> open one with the report
#   red, report changed       -> rewrite the body and comment with the run link
#   red, same report          -> nothing (no daily noise)
#   green, open issue         -> close it with the run link
#
#   scripts/freshness-issue.sh <success|failure> <report file> <run url>
#
# The report file is `bun scripts/freshness.ts all` output; in Actions its
# failures are `::error` annotations, turned back into plain lines here.
# Needs gh with issues: write (GH_TOKEN, GH_REPO).
set -euo pipefail

outcome="$1"
report_file="$2"
run_url="$3"
label=freshness

open="$(gh issue list --label "$label" --state open --json number --jq '.[0].number // empty')"

if [ "$outcome" = success ]; then
  if [ -n "$open" ]; then
    gh issue close "$open" --comment "Green again in $run_url."
  fi
  exit 0
fi

report="$(<"$report_file")"
report="${report//::error title=freshness::/}"
report="${report//%0A/$'\n'}"
fence='```'
body="$(printf '%s\n\n%stext\n%s\n%s\n\n%s\n' \
  "The scheduled freshness run (scripts/freshness.ts) found drift against upstream. Each failing line says what to bump; test/app-yaml.test.ts \"release sync\" lists the T3 pins." \
  "$fence" "$report" "$fence" \
  "This issue tracks the latest report: its body changes when the report does, and the next green run closes it.")"

if [ -z "$open" ]; then
  gh label create "$label" --color D93F0B \
    --description "Upstream drift found by the scheduled freshness run" --force >/dev/null
  open="$(gh issue create --title "Freshness: upstream drift" --label "$label" --body "$body" | sed 's#.*/##')"
  gh issue comment "$open" --body "First seen in $run_url."
  exit 0
fi

current="$(gh issue view "$open" --json body --jq .body | tr -d '\r')"
if [ "$current" != "$body" ]; then
  gh issue edit "$open" --body "$body" >/dev/null
  gh issue comment "$open" --body "The report changed in $run_url."
fi
