#!/usr/bin/env bash
# Deploys the site to Cloudflare Pages (https://intatto.pages.dev), production only. Dry run by
# default: it builds and checks everything, prints the deploy command, and deploys nothing.
#
#   web/scripts/pages-deploy.sh                    dry run
#   web/scripts/pages-deploy.sh --send             deploy (asks you to confirm)
#   web/scripts/pages-deploy.sh --create-project   one-time: create the Pages project, then stop
#
# Cloudflare credentials come only from ~/.config/intatto/cloudflare.env, outside the repo:
#   CLOUDFLARE_API_TOKEN=...    (Account > Cloudflare Pages > Edit)
#   CLOUDFLARE_ACCOUNT_ID=...
# The script refuses to run if that file is missing, not yours, or not mode 600. It parses the file
# rather than sourcing it, and the token never goes to stdout or onto a command line.
#
# Every mode checks with the Cloudflare API that the project's hostname is exactly
# intatto.pages.dev and its production branch is master. Cloudflare gives a project a suffixed
# hostname (intatto-xyz.pages.dev) when the name is taken; passkeys created there would be bound
# to that hostname for good, so the script stops instead.
#
# Production only, because passkeys are bound to the domain (THREAT_MODEL.md, "Passkey sign-in"):
# a preview at <branch>.intatto.pages.dev could claim the same rpId and ask for the same passkeys.
# Cloudflare makes a preview whenever the deploy branch is not the project's production branch,
# and inside a git checkout wrangler takes the current git branch unless --branch is given. So
# every deploy here names the production branch explicitly, and the script refuses anything else.
#
# One-time setup: --create-project, which runs
#   wrangler pages project create intatto --production-branch master
# (Direct Upload; a project cannot be switched to Git integration later).
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
  --create-project) MODE=create-project ;;
  *) echo "unknown argument $arg (use --dry-run, the default, --send or --create-project)" >&2; exit 2 ;;
  esac
done
die() { echo "ABORT: $*" >&2; exit 1; }

CF_ENV="$HOME/.config/intatto/cloudflare.env"
# Reads exactly CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from $CF_ENV; values already in the
# environment are ignored. Error messages name the file and variable, never a value.
load_cloudflare_env() {
  [ -e "$CF_ENV" ] || die "$CF_ENV is missing; it must hold CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, mode 600"
  [ -f "$CF_ENV" ] && [ ! -L "$CF_ENV" ] || die "$CF_ENV is not a regular file"
  [ -O "$CF_ENV" ] || die "$CF_ENV is not owned by you"
  local mode
  mode=$(stat -c %a "$CF_ENV" 2>/dev/null || stat -f %Lp "$CF_ENV")
  [ "$mode" = 600 ] || die "$CF_ENV has mode $mode, not 600; run: chmod 600 $CF_ENV"
  CLOUDFLARE_API_TOKEN='' CLOUDFLARE_ACCOUNT_ID=''
  local line name value
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in '' | '#'*) continue ;; esac
    name=${line%%=*}
    value=${line#*=}
    [ "$name" != "$line" ] || die "$CF_ENV: a line is not NAME=value"
    case "$value" in \"*\" | \'*\') value=${value:1:${#value}-2} ;; esac
    case "$name" in
    CLOUDFLARE_API_TOKEN) CLOUDFLARE_API_TOKEN=$value ;;
    CLOUDFLARE_ACCOUNT_ID) CLOUDFLARE_ACCOUNT_ID=$value ;;
    *) die "$CF_ENV: unexpected variable $name (only CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)" ;;
    esac
  done <"$CF_ENV"
  [ -n "$CLOUDFLARE_API_TOKEN" ] || die "$CF_ENV has no CLOUDFLARE_API_TOKEN"
  [[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || die "CLOUDFLARE_ACCOUNT_ID in $CF_ENV is not a 32-character hex id"
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
}

# GET on the account's API. The token goes to curl on stdin (-H @-), not in its arguments.
cf_get() {
  printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" |
    curl -sS --max-time 30 -H @- "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$1"
}

# Prints the project's hostname and production branch. Exits 3 if the project does not exist,
# 1 if the API fails or the hostname or branch is not the expected one.
check_project() {
  local body
  body=$(cf_get "/pages/projects/$PROJECT") || die "the Cloudflare API did not answer"
  node -e '
    const [host, branch] = process.argv.slice(1);
    let r; try { r = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { console.error("ABORT: the Cloudflare API returned no JSON"); process.exit(1); }
    if (!r.success) {
      const errs = (r.errors || []).map((e) => `${e.code}: ${e.message}`);
      if ((r.errors || []).some((e) => e.code === 8000007)) { console.error("    project:   none yet"); process.exit(3); }
      console.error("ABORT: Cloudflare API: " + (errs.join("; ") || "unknown error")); process.exit(1);
    }
    const p = r.result;
    console.log(`    project:   ${p.name}, hostname ${p.subdomain}, production branch ${p.production_branch}`);
    if (p.subdomain !== host) { console.error(`ABORT: the hostname is ${p.subdomain}, not ${host}. Passkeys bind to the hostname for good; do not deploy.`); process.exit(1); }
    if (p.production_branch !== branch) { console.error(`ABORT: the production branch is ${p.production_branch}, not ${branch}; a deploy would be a preview.`); process.exit(1); }
  ' "$PROJECT.pages.dev" "$PRODUCTION_BRANCH" <<<"$body"
}

cd "$(dirname "${BASH_SOURCE[0]}")/.."
load_cloudflare_env

if [ "$MODE" = create-project ]; then
  echo "== Create the Pages project $PROJECT (production branch $PRODUCTION_BRANCH)"
  status=0
  check_project 2>&1 || status=$?
  [ "$status" = 3 ] || die "the project exists already (or the check failed); nothing was created"
  # When wrangler detects it is run by an AI agent and the project does not exist yet, it turns
  # `pages project create` into a Workers deploy (a *.workers.dev hostname, not intatto.pages.dev)
  # and autoconfigures the current directory: it rewrote package.json and vite.config.ts and
  # installed packages here once. --force (hidden in 4.152.0, src/pages/delegate-to-workers.ts)
  # creates the Pages project directly, and an empty working directory gives it nothing to rewrite.
  # Deploys are not delegated: wrangler skips delegation for a project that exists, which
  # check_project confirms before every deploy.
  scratch=$(mktemp -d)
  (cd "$scratch" && npx "$WRANGLER" pages project create "$PROJECT" --production-branch "$PRODUCTION_BRANCH" --force)
  rmdir "$scratch" 2>/dev/null || true
  echo "== Check what Cloudflare assigned"
  check_project
  echo "Created. Nothing was deployed."
  exit 0
fi

echo "== Preflight ($MODE)"
check_project
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
