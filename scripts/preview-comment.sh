#!/usr/bin/env bash
# Post or update the one Preview comment on a pull request (found by its marker), so the link stays in
# one place as the PR changes. Usage: preview-comment.sh <pr-number> <markdown>. Needs GH_TOKEN.
set -euo pipefail
pr=$1
marker='<!-- common-ink-preview -->'
body="$marker
$2"
id=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" --paginate --jq ".[] | select(.body | contains(\"$marker\")) | .id" | head -1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" > /dev/null
else
  gh pr comment "$pr" --body "$body" > /dev/null
fi
