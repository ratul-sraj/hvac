#!/usr/bin/env bash
# infra/50-deploy-site.sh — upload the static site to S3 and refresh CloudFront.
#
#   bash infra/50-deploy-site.sh                     # build the file set, then sync
#   bash infra/50-deploy-site.sh --from _site        # sync a folder you built yourself
#   bash infra/50-deploy-site.sh --with-samples      # also publish tests/samples/ as /samples/
#   bash infra/50-deploy-site.sh --prune             # also delete objects that are gone
#
# The file set is exactly the one the GitHub Pages workflow publishes:
#     *.html  favicon.svg  css/  js/  vendor/
# and nothing else. tests/, node_modules/, infra/, .git/ and dotfiles are never
# uploaded. (--with-samples is the one exception, and it mirrors what Pages does
# with tests/samples/.)
#
# Caching rules:
#     *.html      no-cache                        (so a deploy is visible at once)
#     favicon.svg public, max-age=86400
#     css/ js/    public, max-age=31536000, immutable
#     vendor/     public, max-age=31536000, immutable
# Then: CloudFront invalidation of / , /index.html and /*.html
#
# Environment: SITE_BUCKET, DISTRIBUTION_ID, AWS_REGION, SKIP_INVALIDATION=1
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
FROM_DIR=""
WITH_SAMPLES=0
PRUNE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from)         FROM_DIR="${2:-}"; shift 2 ;;
    --with-samples) WITH_SAMPLES=1; shift ;;
    --prune)        PRUNE=1; shift ;;
    -h|--help)      sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

log_title "Publish the site to S3 + CloudFront"

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
BUCKET="$(resolve_site_bucket)"
save_state ACCOUNT_ID "$ACCOUNT_ID" SITE_BUCKET "$BUCKET"
print_context

# ---------------------------------------------------------------------------
# 1. the file set to upload
# ---------------------------------------------------------------------------
CACHE_HTML="no-cache"
CACHE_SHORT="public, max-age=86400"
CACHE_LONG="public, max-age=31536000, immutable"
# Code that CHANGES between deploys must not be immutable: these filenames are not content-hashed,
# so a 1-year immutable cache means a fixed js/app.js never reaches a browser that already has the
# old copy (it did exactly that to the sample-drawing fix). Revalidate quickly instead.
CACHE_CODE="public, max-age=300, must-revalidate"
CT_HTML="text/html; charset=utf-8"
CT_CSS="text/css; charset=utf-8"
CT_JS="text/javascript; charset=utf-8"
CT_SVG="image/svg+xml"
CT_GZIP="application/gzip"

if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR" ] || die "--from '$FROM_DIR' is not a directory"
  SRC="$(cd "$FROM_DIR" && pwd)"
  log_step "Using the folder you gave me"
else
  SRC="$STAGE_DIR"
  log_step "Building the publishable file set in $STAGE_DIR"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cd "$REPO_ROOT" || die "cannot cd to $REPO_ROOT"

  # Same file set as .github/workflows/pages.yml.
  COPIED=0
  for item in *.html favicon.svg css js vendor; do
    [ -e "$item" ] || { log_warn "missing from the repo: $item"; continue; }
    cp -r "$item" "$STAGE_DIR/" && COPIED=$((COPIED + 1))
  done
  [ "$COPIED" -gt 0 ] || die "nothing to upload — are you in the right repository?"
  # .nojekyll is a GitHub Pages artefact and meaningless on S3; not copied.
  log_ok "staged $COPIED item(s)"

  if [ "$WITH_SAMPLES" = "1" ]; then
    if [ -d "$REPO_ROOT/tests/samples" ]; then
      mkdir -p "$STAGE_DIR/samples"
      cp "$REPO_ROOT"/tests/samples/*.pdf "$STAGE_DIR/samples/" 2>/dev/null || true
      cp "$REPO_ROOT"/tests/samples/*.csv "$STAGE_DIR/samples/" 2>/dev/null || true
      cp "$REPO_ROOT"/tests/samples/*.xlsx "$STAGE_DIR/samples/" 2>/dev/null || true
      log_ok "samples: $(ls "$STAGE_DIR/samples" | wc -l | tr -d ' ') file(s) -> /samples/"
      log_warn "these drawings become PUBLIC. Leave the flag off unless you want that."
    else
      log_warn "tests/samples/ does not exist — nothing to copy"
    fi
  fi
fi

FILE_COUNT="$(find "$SRC" -type f | wc -l | tr -d ' ')"
BYTES="$(find "$SRC" -type f -exec wc -c {} + 2>/dev/null | tail -n 1 | awk '{print $1}')"
log_info "files: $FILE_COUNT   size: $(( ${BYTES:-0} / 1024 )) KiB"

# Safety net: refuse to publish a set that contains anything private.
if find "$SRC" \( -name "node_modules" -o -name ".git" -o -name "tests" -o -name "infra" -o -name ".*" \) \
     -not -path "$SRC/." -print 2>/dev/null | grep -q .; then
  log_warn "the folder contains something that looks private:"
  find "$SRC" \( -name "node_modules" -o -name ".git" -o -name "tests" -o -name "infra" \) -print 2>/dev/null | sed 's/^/     /'
  die "refusing to upload — use the default file set or a clean --from folder"
fi

# ---------------------------------------------------------------------------
# 2. upload
# ---------------------------------------------------------------------------
log_step "Uploading to s3://$BUCKET"

# aws.exe is a NATIVE program: it cannot read an MSYS path like /d/webhvac/..., so the sync sources
# are handed to it in native form while the shell keeps using $SRC.
SRC_NATIVE="$(nativepath "$SRC")"

# html at the root
aws s3 sync "$SRC_NATIVE" "s3://$BUCKET" --exclude "*" --include "*.html" \
  --content-type "$CT_HTML" --cache-control "$CACHE_HTML" --no-progress
log_ok "*.html -> cache-control: $CACHE_HTML"

# favicon
if [ -f "$SRC/favicon.svg" ]; then
  aws s3 sync "$SRC_NATIVE" "s3://$BUCKET" --exclude "*" --include "favicon.svg" \
    --content-type "$CT_SVG" --cache-control "$CACHE_SHORT" --no-progress
  log_ok "favicon.svg -> cache-control: $CACHE_SHORT"
fi

# css/
if [ -d "$SRC/css" ]; then
  aws s3 sync "$SRC_NATIVE/css" "s3://$BUCKET/css" \
    --content-type "$CT_CSS" --cache-control "$CACHE_CODE" --no-progress
  log_ok "css/ -> $CACHE_CODE"
fi

# js/  (content type matters: these are ES modules, a wrong MIME type makes the
# browser refuse to import them)
if [ -d "$SRC/js" ]; then
  aws s3 sync "$SRC_NATIVE/js" "s3://$BUCKET/js" \
    --content-type "$CT_JS" --cache-control "$CACHE_CODE" --no-progress
  log_ok "js/ -> $CACHE_CODE"
fi

# vendor/ : pdf.js + tesseract. Three passes because the MIME type of a .mjs
# ES module must be a JavaScript type or the import fails, and the CLI's guess
# is not reliable for .mjs or .gz on every platform.
if [ -d "$SRC/vendor" ]; then
  aws s3 sync "$SRC_NATIVE/vendor" "s3://$BUCKET/vendor" \
    --exclude "*" --include "*.mjs" --include "*.js" \
    --content-type "$CT_JS" --cache-control "$CACHE_LONG" --no-progress
  aws s3 sync "$SRC_NATIVE/vendor" "s3://$BUCKET/vendor" \
    --exclude "*" --include "*.gz" \
    --content-type "$CT_GZIP" --cache-control "$CACHE_LONG" --no-progress
  aws s3 sync "$SRC_NATIVE/vendor" "s3://$BUCKET/vendor" \
    --exclude "*.mjs" --exclude "*.js" --exclude "*.gz" \
    --cache-control "$CACHE_LONG" --no-progress
  log_ok "vendor/ -> immutable (mjs/js forced to $CT_JS, no Content-Encoding set on .gz)"
fi

if [ -d "$SRC/samples" ]; then
  aws s3 sync "$SRC_NATIVE/samples" "s3://$BUCKET/samples" \
    --cache-control "$CACHE_SHORT" --no-progress
  log_ok "samples/ uploaded"
fi

# ---------------------------------------------------------------------------
# 3. optional: delete objects that are no longer part of the site
# ---------------------------------------------------------------------------
if [ "$PRUNE" = "1" ]; then
  log_step "Looking for removed files (--prune)"
  require_cmd node
  KEYS_FILE="$TMP_DIR/local-keys.txt"
  REMOTE_FILE="$TMP_DIR/remote-keys.json"
  mkdir -p "$TMP_DIR"
  ( cd "$SRC" && find . -type f | sed 's|^\./||' | sort ) > "$KEYS_FILE"
  aws s3api list-objects-v2 --bucket "$BUCKET" --no-cli-pager > "$REMOTE_FILE" 2>/dev/null || : > "$REMOTE_FILE"

  DIRS_ARG="css/,js/,vendor/"
  [ -d "$SRC/samples" ] && DIRS_ARG="css/,js/,vendor/,samples/"
  STALE="$(node "$INFRA_DIR/lib-prune.mjs" --local "$KEYS_FILE" --remote "$REMOTE_FILE" --dirs "$DIRS_ARG")"

  if [ -z "$STALE" ]; then
    log_ok "nothing stale"
  else
    printf '%s\n' "$STALE" | sed 's/^/     delete /'
    if confirm "Delete these $(printf '%s\n' "$STALE" | wc -l | tr -d ' ') object(s) from s3://$BUCKET?"; then
      printf '%s\n' "$STALE" | while IFS= read -r key; do
        [ -n "$key" ] || continue
        aws s3api delete-object --bucket "$BUCKET" --key "$key" --no-cli-pager >/dev/null
      done
      log_ok "deleted"
    else
      log_warn "left them in place (they are still being served!)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 4. CloudFront invalidation
# ---------------------------------------------------------------------------
if [ "${SKIP_INVALIDATION:-0}" = "1" ]; then
  log_warn "SKIP_INVALIDATION=1 — html is uploaded as no-cache, so it is refreshed anyway"
else
  DIST_ID="$(resolve_distribution_id)"
  if [ -z "$DIST_ID" ]; then
    log_warn "no CloudFront distribution known — skipping the invalidation"
    log_info "If 30-cloudfront.sh has not been run yet, that is expected."
    log_info "Set DISTRIBUTION_ID=... or run:  bash infra/30-cloudfront.sh"
  else
    log_step "Invalidating / , /index.html , /*.html on $DIST_ID"
    INVALIDATION_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
      --paths "/" "/index.html" "/*.html" \
      --query 'Invalidation.Id' --output text --no-cli-pager)"
    log_ok "invalidation $INVALIDATION_ID requested (3 paths)"
    log_info "The first 1,000 invalidation paths each month are free; this uses 3."
  fi
fi

# ---------------------------------------------------------------------------
log_title "Done"
log_ok "uploaded $FILE_COUNT file(s) to s3://$BUCKET"
if [ -n "${DISTRIBUTION_DOMAIN:-}" ]; then
  log_info "Open: https://$DISTRIBUTION_DOMAIN/"
else
  log_info "The site is private in S3 — it is only reachable through CloudFront."
fi
[ "$WITH_SAMPLES" = "1" ] && log_warn "samples/ is public on the site"
