#!/bin/bash
# Create an R2 bucket if it isn't there yet. Needs CLOUDFLARE_API_TOKEN with R2 edit rights; without
# them it says what to run instead.
#
# It looks for the bucket in `wrangler r2 bucket list` (matching the whole name), not `bucket info`:
# Cloudflare's rate limit (error 10429) hits the per-bucket call first. A call that hits the limit is
# tried again after a pause, and a failed create counts as fine if the bucket is in the list afterwards
# (it was made by someone else a moment ago, or the create worked but its answer didn't get back).
#   ENSURE_BUCKET_PAUSE: seconds to wait before the first retry; each retry waits one more (default 5).
set -uo pipefail
bucket=$1
pause=${ENSURE_BUCKET_PAUSE:-5}
tries=4
output=""

# Runs wrangler, retrying while Cloudflare says 10429. The last attempt's output is left in $output.
wrangler_retrying() {
  local attempt
  for ((attempt = 1; attempt <= tries; attempt++)); do
    if output=$(npx wrangler "$@" 2>&1); then
      return 0
    fi
    if [[ $attempt -lt $tries && $output == *10429* ]]; then
      echo "Cloudflare is rate limiting (10429); trying again in $((pause * attempt))s." >&2
      sleep $((pause * attempt))
      continue
    fi
    return 1
  done
}

# 0 if the bucket's name is a whole line of the list, so common-ink-v2-uploads-preview isn't common-ink-v2-uploads.
in_list() {
  wrangler_retrying r2 bucket list || return 1
  local names
  names=$(printf '%s\n' "$output" | sed -n 's/^name:[[:space:]]*//p' | sed 's/[[:space:]]*$//')
  grep -Fxq -- "$bucket" <<<"$names"
}

if in_list; then
  echo "R2 bucket $bucket is there."
  exit 0
fi
if wrangler_retrying r2 bucket create "$bucket"; then
  printf '%s\n' "$output"
  echo "Made R2 bucket $bucket."
  exit 0
fi
create_output=$output
if in_list; then
  echo "R2 bucket $bucket is there (the create said: $(printf '%s' "$create_output" | tail -n 1))."
  exit 0
fi
printf '%s\n' "$create_output" >&2
echo "::error::Couldn't find or make the R2 bucket $bucket. Give the Cloudflare API token \"Workers R2 Storage: Edit\", or make it once with: npx wrangler r2 bucket create $bucket"
exit 1
