#!/bin/bash
# Create an R2 bucket if it isn't there yet. Needs CLOUDFLARE_API_TOKEN with R2 edit rights; without
# them it says what to run instead.
set -euo pipefail
bucket=$1
if npx wrangler r2 bucket info "$bucket" > /dev/null 2>&1; then
  echo "R2 bucket $bucket is there."
  exit 0
fi
if npx wrangler r2 bucket create "$bucket"; then
  echo "Made R2 bucket $bucket."
  exit 0
fi
echo "::error::Couldn't find or make the R2 bucket $bucket. Give the Cloudflare API token \"Workers R2 Storage: Edit\", or make it once with: npx wrangler r2 bucket create $bucket"
exit 1
