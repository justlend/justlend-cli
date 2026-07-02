#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT_DIR/dist/bin/cli.js"
ADDR="${JUSTLEND_DRY_RUN_OWNER:-TCrDi83pUoK17GbwxN1SckM3YNXzahWvoN}"
NETWORK="${JUSTLEND_TEST_NETWORK:-nile}"

if [ ! -f "$CLI" ]; then
  echo "dist/bin/cli.js not found; running npm run build first..." >&2
  (cd "$ROOT_DIR" && npm run build)
fi

CMDS=(
  "strx stake 0.000001"
  "strx claim"
  "stusdt wrap 0.000001"
  "stusdt unwrap 0.000001"
  "v1 deposit TRX 0.000001"
  "v1 borrow USDT 0.000001"
  "gov exchange 0.000001"
)

fail=0
pass=0
note=0

echo "JustLend CLI Nile dry-run smoke"
echo "root: $ROOT_DIR"
echo "network: $NETWORK"
echo "dry-run owner: $ADDR"
echo

for cmd in "${CMDS[@]}"; do
  echo "=== $cmd ==="
  # shellcheck disable=SC2086
  out=$(node "$CLI" --json --network "$NETWORK" --dry-run --dry-run-owner "$ADDR" $cmd 2>&1)
  ec=$?
  echo "$out"
  if OUT="$out" python3 - "$ec" <<'PY'
import json, os, sys
exit_code = int(sys.argv[1])
raw = os.environ.get('OUT', '').strip()
try:
    payload = json.loads(raw)
except Exception:
    print('CHECK: FAIL non-json output')
    raise SystemExit(1)
if exit_code != 0 or payload.get('success') is not True:
    print(f"CHECK: FAIL exit={exit_code} success={payload.get('success')} error={payload.get('error')}")
    raise SystemExit(1)
data = payload.get('data') or {}
if data.get('mode') != 'dry-run':
    print(f"CHECK: FAIL mode={data.get('mode')}")
    raise SystemExit(1)
if not data.get('selector'):
    print('CHECK: FAIL missing selector')
    raise SystemExit(1)
if data.get('energyUsed') is None:
    print('CHECK: FAIL missing energyUsed')
    raise SystemExit(1)
print(f"CHECK: PASS status={data.get('status')} selector={data.get('selector')} energyUsed={data.get('energyUsed')}")
PY
  then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
  echo
done

# V2 / Moolah surface (including `mining`) was removed in v1.0.0. Confirm those
# command names no longer parse as registered commands — this is a structural
# guard, not a business-data check.
for removed in market vault mining airdrop liquidate; do
  echo "=== removed command guard: $removed ==="
  out=$(node "$CLI" --json --network "$NETWORK" "$removed" 2>&1)
  ec=$?
  echo "$out"
  if OUT="$out" REMOVED="$removed" python3 - "$ec" <<'PY'
import json, os, sys
exit_code = int(sys.argv[1])
raw = os.environ.get('OUT', '').strip()
removed = os.environ.get('REMOVED', '')
# Commander writes the "unknown command" message to stderr; in --json mode the
# CLI's writeErr hook re-emits it as {success:false,error:...}. We only require
# that the exit code is non-zero and that the command was not silently treated
# as a real command.
if exit_code == 0:
    print(f"CHECK: FAIL {removed} exited 0 (should be non-zero)")
    raise SystemExit(1)
try:
    payload = json.loads(raw)
    if payload.get('success') is not False:
        print(f"CHECK: FAIL {removed} success={payload.get('success')}")
        raise SystemExit(1)
except json.JSONDecodeError:
    # Non-JSON err output is acceptable as long as exit != 0.
    pass
print(f"CHECK: PASS {removed} rejected with exit={exit_code}")
PY
  then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
  echo
done

echo
echo "Summary: pass=$pass fail=$fail notes=$note"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
