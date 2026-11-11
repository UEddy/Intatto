#!/usr/bin/env bash
# Deploys the site to Cloudflare Pages (https://intatto.pages.dev), production only. Dry run by
# default: it builds and checks everything, prints the deploy command, and deploys nothing.
#
#   web/scripts/pages-deploy.sh            dry run
#   web/scripts/pages-deploy.sh --send     deploy (asks you to confirm)
#
# Production only, because passkeys are bound to the domain (THREAT_MODEL.md, "Passkey sign-in"):
# a preview at <branch>.intatto.pages.dev could claim the same rpId and ask for the same passkeys.
# Cloudflare makes a preview whenever the deploy branch is not the project's production branch,
# and inside a git checkout wrangler takes the current git branch unless --branch is given. So
# every deploy here names the production branch explicitly, and the script refuses anything else.
#
# One-time setup (Direct Upload; it cannot be switched to Git integration later):
#   npx wrangler@4.152.0 login
#   npx wrangler@4.152.0 pages project create intatto --production-branch master
set -euo pipefail
shopt -s inherit_errexit

PROJECT=intatto
PRODUCTION_BRANCH=master
WRANGLER=wrangler@4.152.0 # the newest release at least two weeks old on 2026-11-09
EXECUTOR=dist/wallets/passkey-executor-798e9e5.js
EXECUTOR_SHA256=2d289931d4dcefbbe84ab486616b5002d460cc9dae71f0de99c5aad74fd1a3b9

MODE=dry-run
for arg in "$@"; do
  case "$arg" in
  --send) MODE=send ;;
  --dry-run) MODE=dry-run ;;
  *) echo "unknown argument $arg (use --dry-run, the default, or --send)" >&2; exit 2 ;;
  esac
done
die() { echo "ABORT: $*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "== Preflight ($MODE)"
# --send deploys only a clean, pushed commit; a dry run just warns, so it can check a work in progress.
refuse() { if [ "$MODE" = send ]; then die "$1"; else echo "    WARNING:   $1 (--send would stop here)"; fi; }
[ -z "$(git status --porcelain)" ] || refuse "the working tree has changes; deploy a committed state only"
COMMIT=$(git rev-parse HEAD)
if git fetch -q origin "$PRODUCTION_BRANCH" 2>/dev/null; then
  git merge-base --is-ancestor "$COMMIT" "origin/$PRODUCTION_BRANCH" ||
    refuse "$COMMIT is not on origin/$PRODUCTION_BRANCH; push it first, so the site matches public code"
else
  refuse "cannot fetch origin/$PRODUCTION_BRANCH to check $COMMIT is pushed"
fi
echo "    commit:    $COMMIT"

echo "== Build for the site root"
INTATTO_BASE=/ npm run build >/dev/null
[ -f dist/_headers ] || die "dist/_headers is missing"
grep -q "frame-ancestors 'none'" dist/_headers || die "dist/_headers has no frame-ancestors"
awk 'length($0) > 2000 { exit 1 }' dist/_headers || die "a line of dist/_headers exceeds Cloudflare's 2,000 characters"
[ "$(sha256sum "$EXECUTOR" | cut -d' ' -f1)" = "$EXECUTOR_SHA256" ] || die "$EXECUTOR is not the pinned passkey executor"
grep -q '"/boot.js"\|src="/boot.js"\|src="./boot.js"' dist/index.html || die "dist/index.html does not load boot.js"
echo "    dist:      $(find dist -type f | wc -l) files; _headers and the pinned passkey executor checked"

CMD=(npx "$WRANGLER" pages deploy dist --project-name "$PROJECT" --branch "$PRODUCTION_BRANCH"
  --commit-hash "$COMMIT" --commit-dirty=false)
echo
echo "== Deploy command (production: branch $PRODUCTION_BRANCH)"
printf ' %q' "${CMD[@]}"
echo
if [ "$MODE" != send ]; then
  echo
  echo "Dry run: nothing was deployed. Run again with --send to deploy."
  exit 0
fi
read -r -p "Type 'deploy $PROJECT' to deploy $COMMIT to https://$PROJECT.pages.dev: " answer </dev/tty
[ "$answer" = "deploy $PROJECT" ] || die "not confirmed; nothing was deployed"
"${CMD[@]}"
echo
echo "After the first deploy, check the headers are served:"
echo "  curl -sI https://$PROJECT.pages.dev/ | grep -iE 'content-security-policy|x-frame-options|permissions-policy'"
