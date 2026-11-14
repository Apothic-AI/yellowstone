#!/usr/bin/env bash
# smoke.sh exercises every subrouterctl command group against a live account.
#
#   ./scripts/smoke.sh [binary]
#
# The script creates and then removes a few throwaway API keys, so it needs a
# real system access token. It restores the account to its original state.
set -uo pipefail

BIN="${1:-./subrouterctl}"
BASE="${SUBROUTER_BASE_URL:-https://subrouter.ai}"
PASS=0
FAIL=0
CREATED_KEYS=()

# The names the suite gives to the keys it creates. They are the only names
# the pre-flight sweep is allowed to delete.
SMOKE_NAMES=(smoke-smart smoke-fixed smoke-shared smoke-official smoke-renamed)

if [[ ! -x "$BIN" ]]; then
  echo "smoke: binary not found or not executable: $BIN" >&2
  exit 2
fi

# check <name> <command...>
check() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    PASS=$((PASS + 1))
    printf '  \033[32m✓\033[0m %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  \033[31m✗\033[0m %s\n     %s\n' "$name" "$(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  fi
}

# check_fail <name> <command...>  — expects a non-zero exit
check_fail() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    printf '  \033[31m✗\033[0m %s (expected an error, got success)\n' "$name"
  else
    PASS=$((PASS + 1))
    printf '  \033[32m✓\033[0m %s\n' "$name"
  fi
}

# ids_named prints the ids of the keys whose name is exactly the one asked
# for. The platform search is a substring match, so the names are compared
# here to make sure a key of the user is never caught by the sweep.
ids_named() {
  local want="$1"
  "$BIN" -o json token list --search "$want" --limit 100 2>/dev/null | python3 -c '
import json, sys

want = sys.argv[1]
try:
    items = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
if isinstance(items, dict):
    items = items.get("items", [])
for item in items:
    if isinstance(item, dict) and item.get("name") == want and item.get("id"):
        print(item["id"])
' "$want"
}

# sweep_leftovers removes the keys an earlier interrupted run left behind.
# Only the names this suite uses are touched.
sweep_leftovers() {
  if ! command -v python3 >/dev/null 2>&1; then
    printf '  python3 is missing, so the leftover keys cannot be swept\n'
    return 0
  fi
  local ids=() name id
  for name in "${SMOKE_NAMES[@]}"; do
    while read -r id; do
      [[ -n "$id" ]] && ids+=("$id")
    done < <(ids_named "$name")
  done
  if (( ${#ids[@]} == 0 )); then
    printf '  nothing to sweep\n'
    return 0
  fi
  printf '  found %d leftover key(s) from an earlier run: %s\n' "${#ids[@]}" "${ids[*]}"
  if "$BIN" token delete-batch "${ids[@]}" --yes >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m removed them\n'
  else
    printf '  \033[31m✗\033[0m could not remove them: %s token delete-batch %s --yes\n' \
      "$BIN" "${ids[*]}"
    FAIL=$((FAIL + 1))
  fi
}

# cleanup removes the keys the run created. A key that is left behind is a
# live credential on the account, so a failed cleanup is reported and the
# script exits with a failure.
CLEANED=0
cleanup() {
  (( CLEANED )) && return
  CLEANED=1
  if (( ${#CREATED_KEYS[@]} )); then
    if ! "$BIN" token delete-batch "${CREATED_KEYS[@]}" --yes >/dev/null 2>&1; then
      printf '  \033[31m✗\033[0m could not delete %d throwaway keys (%s)\n' \
        "${#CREATED_KEYS[@]}" "${CREATED_KEYS[*]}" >&2
      printf '     remove them with: %s token delete-batch %s --yes\n' "$BIN" "${CREATED_KEYS[*]}" >&2
      exit 1
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo
echo "subrouterctl smoke test against $BASE"
echo "───────────────────────────────────────────────────────────────────────────"

echo
echo "credentials"
check "auth status" "$BIN" auth status

echo
echo "leftovers"
sweep_leftovers

# A provider the account is subscribed to, so the fixed and smart keys below
# have something to point at. Resolved at runtime, so the script works on any
# account without naming a provider here.
SUB_SLUG=$("$BIN" -o json provider subs --limit 1 2>/dev/null | grep -oE '"slug": *"[^"]+"' | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
if [[ -z "$SUB_SLUG" ]]; then
  FAIL=$((FAIL + 1))
  printf '  \033[31m✗\033[0m could not resolve a subscribed provider slug\n'
fi

echo
echo "account"
check "account info" "$BIN" account info
check "account groups" "$BIN" account groups
check "account models" "$BIN" account models
check "account subrouter-models" "$BIN" account subrouter-models
check "account topup-info" "$BIN" account topup-info
check "account topups" "$BIN" account topups
check "account balance" "$BIN" account balance
check "account notifications" "$BIN" account notifications
check "account aff" "$BIN" account aff
check "account status" "$BIN" account status

echo
echo "usage"
check "usage stats" "$BIN" usage stats
check "usage data" "$BIN" usage data --from 7d --to now
check "usage logs" "$BIN" usage logs --limit 5
check "usage logs by model" "$BIN" usage logs --model deepseek --limit 5
check "usage logs sorted by cost" "$BIN" usage logs --sort cost --order desc --limit 5
check "usage logs sorted by tps" "$BIN" usage logs --sort tps --order desc --limit 5
check "usage logs sorted by ttft" "$BIN" usage logs --sort ttft --order asc --limit 5
check "usage export url" "$BIN" usage export --from 1d --to now

request_id=$("$BIN" -o json usage logs --limit 1 2>/dev/null | grep -oE '"request_id": *"[^"]+"' | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
if [[ -n "$request_id" ]]; then
  check "usage logs by request id" "$BIN" usage logs --request "$request_id" --limit 1
  check "usage log detail" "$BIN" usage log "$request_id"
  check "usage log detail json" "$BIN" -o json usage log "$request_id"
else
  FAIL=$((FAIL + 1))
  printf '  \033[31m\u2717\033[0m could not resolve a request id\n'
fi

echo
echo "token lifecycle"
for kind in smart fixed shared official; do
  args=(token create --type "$kind" --name "smoke-$kind" --unlimited)
  [[ "$kind" == fixed ]] && args+=(--provider "$SUB_SLUG")
  [[ "$kind" == smart ]] && args+=(--providers "$SUB_SLUG")
  if out=$("$BIN" "${args[@]}" 2>&1); then
    PASS=$((PASS + 1))
    printf '  \033[32m✓\033[0m create %s key\n' "$kind"
    id=$(printf '%s' "$out" | grep -oE 'id [0-9]+' | head -1 | grep -oE '[0-9]+')
    [[ -n "$id" ]] && CREATED_KEYS+=("$id")
    # The platform must classify the key under the kind we asked for.
    classified=0
    for _ in 1 2 3 4 5; do
      if "$BIN" token list --kind "$kind" --search "smoke-$kind" 2>&1 | grep -q "smoke-$kind"; then
        classified=1
        break
      fi
      sleep 1
    done
    if (( classified )); then
      PASS=$((PASS + 1))
      printf '  \033[32m\u2713\033[0m %s key is classified as %s\n' "$kind" "$kind"
    else
      FAIL=$((FAIL + 1))
      printf '  \033[31m\u2717\033[0m %s key is not classified as %s\n' "$kind" "$kind"
    fi
  else
    FAIL=$((FAIL + 1))
    printf '  \033[31m✗\033[0m create %s key: %s\n' "$kind" "$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
  fi
done
if (( ${#CREATED_KEYS[@]} )); then
  first="${CREATED_KEYS[0]}"
  check "token show" "$BIN" token show "$first"
  check "token update" "$BIN" token update "$first" --name "smoke-renamed"
  check "token list by kind" "$BIN" token list --kind fixed --limit 5
  check "token list search" "$BIN" token list --search smoke --limit 5
  check "token list sorted" "$BIN" token list --sort used --order desc --limit 5
  check "token types" "$BIN" token types
fi

echo
echo "model directory"
check "model list" "$BIN" model list --limit 5
check "model list search" "$BIN" model list --search gpt --limit 5
check "model list sorted by price" "$BIN" model list --sort price --order desc --limit 5
check "model routing" "$BIN" model routing --limit 5
check "model pricing" "$BIN" model pricing
check "model options" "$BIN" model options

echo
echo "single listings"
model_id=$("$BIN" -o json model list --limit 1 2>/dev/null | grep -oE '"id": *"?[0-9]+' | head -1 | grep -oE '[0-9]+')
if [[ -n "$model_id" ]]; then
  check "model show <id>" "$BIN" model show "$model_id"
  check "model show json" "$BIN" -o json model show "$model_id"
else
  FAIL=$((FAIL + 1))
  printf '  \033[31m\u2717\033[0m could not resolve a model id\n'
fi
provider_slug=$("$BIN" -o json provider list --limit 1 2>/dev/null | grep -oE '"slug": *"[^"]+"' | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
if [[ -n "$provider_slug" ]]; then
  check "provider show <slug>" "$BIN" provider show "$provider_slug"
  check "provider models <slug>" "$BIN" provider models "$provider_slug"
  check "provider models searched" "$BIN" provider models "$provider_slug" --search gpt
else
  FAIL=$((FAIL + 1))
  printf '  \033[31m\u2717\033[0m could not resolve a provider slug\n'
fi

echo
echo "provider directory"
check "provider list" "$BIN" provider list --limit 5
check "provider list search" "$BIN" provider list --search "$SUB_SLUG" --limit 5
check "provider list sorted" "$BIN" provider list --sort rating --order desc --limit 5
check "provider subs" "$BIN" provider subs --limit 5
check "provider sub-config" "$BIN" provider sub-config
check "provider shared" "$BIN" provider shared

echo
echo "subscriptions"
check "shared list" "$BIN" shared list
check "subscription list" "$BIN" subscription list
check "subscription plans" "$BIN" subscription plans

echo
echo "tasks"
check "task list" "$BIN" task list
check "task list filtered" "$BIN" task list --search x --limit 5

echo
echo "cache"
CACHE_DIR=$(mktemp -d)
check "cache write through" "$BIN" --cache-dir "$CACHE_DIR" account status
check "cache read with ttl" "$BIN" --cache-dir "$CACHE_DIR" --cache-ttl 1m account status
# The proxy sends the request nowhere, which is what an outage looks like.
check "cache offline fallback" env HTTPS_PROXY=http://127.0.0.1:9 "$BIN" --cache-dir "$CACHE_DIR" account status
check "cache clear" "$BIN" --cache-dir "$CACHE_DIR" --cache-clear
rm -rf "$CACHE_DIR"

echo
echo "output formats"
check "json output" "$BIN" -o json account info
check "yaml output" "$BIN" -o yaml token list --limit 3

echo
echo "error handling"
check_fail "missing credentials rejected" env SUBROUTER_CREDENTIALS=/nonexistent/creds.json "$BIN" account info
check_fail "unknown token id rejected" "$BIN" token show 999999999
check_fail "bad flag rejected" "$BIN" token create --type nonsense --name x

echo
echo "───────────────────────────────────────────────────────────────────────────"
printf 'passed \033[32m%d\033[0m, failed \033[31m%d\033[0m\n\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
