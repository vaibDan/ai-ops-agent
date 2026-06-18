#!/usr/bin/env bash
# Full alert test suite for the AI Ops Agent on Kind/Kubernetes.
# Tests all 5 alert types sequentially, waits for each incident to be
# recorded, then prints a full summary.
#
# Usage:
#   ./scripts/test-alerts-k8s.sh              # run all 5 alerts
#   ./scripts/test-alerts-k8s.sh HighErrorRate # run one specific alert
#
set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
AGENT="${AGENT_URL:-http://localhost:3000}"
APP="${APP_URL:-http://localhost:3001}"
WAIT_SECS="${WAIT_SECS:-90}"      # max seconds to wait for each incident
POLL_INTERVAL=5

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
CYN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

passed=0
failed=0
declare -a results=()

log()  { echo -e "${BLU}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GRN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
warn() { echo -e "${YLW}[$(date +%H:%M:%S)] ⚠${NC}  $*"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*"; }
section() { echo -e "\n${BOLD}${CYN}══ $* ══${NC}"; }

# ── Prerequisites check ───────────────────────────────────────────────────────
check_prereqs() {
  section "Prerequisites"

  local fail=0

  if ! curl -sf "$AGENT/health" > /dev/null 2>&1; then
    err "Agent not reachable at $AGENT"
    err "Run: kubectl port-forward -n ai-ops svc/ai-ops-agent-service 3000:3000"
    fail=1
  else
    ok "Agent reachable ($AGENT)"
  fi

  if ! curl -sf "$APP/health" > /dev/null 2>&1; then
    err "sample-app not reachable at $APP"
    err "Run: kubectl port-forward -n ai-ops svc/sample-app-service 3001:3001"
    fail=1
  else
    ok "sample-app reachable ($APP)"
  fi

  if [ "$fail" -eq 1 ]; then
    echo ""
    err "Fix the above before running tests."
    exit 1
  fi
}

# ── Get current incident count ────────────────────────────────────────────────
incident_count() {
  curl -sf "$AGENT/incidents" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null \
    || echo "0"
}

# ── Get the most recent incident ──────────────────────────────────────────────
latest_incident() {
  curl -sf "$AGENT/incidents" 2>/dev/null \
    | python3 -c "
import sys,json
d = json.load(sys.stdin)
if d['count'] > 0:
    i = d['incidents'][0]
    print(json.dumps(i, indent=2))
" 2>/dev/null || echo "{}"
}

# ── Send a webhook payload to the agent ──────────────────────────────────────
send_webhook() {
  local alertname="$1" severity="$2" action_hint="$3" summary="$4" description="$5"
  local fingerprint="test-${alertname}-$(date +%s%N)"

  curl -sf -X POST "$AGENT/webhook/alert" \
    -H "Content-Type: application/json" \
    -d "{
      \"version\": \"4\",
      \"groupKey\": \"{}:{alertname=\\\"${alertname}\\\"}\",
      \"truncatedAlerts\": 0,
      \"status\": \"firing\",
      \"receiver\": \"ai-ops-agent\",
      \"groupLabels\": {\"alertname\": \"${alertname}\"},
      \"commonLabels\": {
        \"alertname\": \"${alertname}\",
        \"severity\": \"${severity}\",
        \"service\": \"sample-app\",
        \"namespace\": \"ai-ops\",
        \"action_hint\": \"${action_hint}\"
      },
      \"commonAnnotations\": {
        \"summary\": \"${summary}\",
        \"description\": \"${description}\"
      },
      \"externalURL\": \"http://alertmanager:9093\",
      \"alerts\": [{
        \"status\": \"firing\",
        \"labels\": {
          \"alertname\": \"${alertname}\",
          \"severity\": \"${severity}\",
          \"service\": \"sample-app\",
          \"namespace\": \"ai-ops\",
          \"action_hint\": \"${action_hint}\"
        },
        \"annotations\": {
          \"summary\": \"${summary}\",
          \"description\": \"${description}\"
        },
        \"startsAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"endsAt\": \"0001-01-01T00:00:00Z\",
        \"generatorURL\": \"http://prometheus:9090/graph\",
        \"fingerprint\": \"${fingerprint}\"
      }]
    }" > /dev/null 2>&1
  echo $?
}

# ── Wait for a new incident to appear ────────────────────────────────────────
wait_for_incident() {
  local label="$1"
  local baseline="$2"
  local elapsed=0

  echo -ne "    Waiting for incident"
  while [ "$elapsed" -lt "$WAIT_SECS" ]; do
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    local current
    current=$(incident_count)
    echo -ne "."
    if [ "$current" -gt "$baseline" ]; then
      echo ""
      return 0
    fi
  done
  echo ""
  return 1
}

# ── Print incident summary ────────────────────────────────────────────────────
print_incident() {
  local incident="$1"
  local status action confidence diagnosis
  status=$(echo "$incident"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null)
  action=$(echo "$incident"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('actionTaken','?'))" 2>/dev/null)
  confidence=$(echo "$incident" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('diagnosis',{}).get('confidence','?'))" 2>/dev/null)
  diagnosis=$(echo "$incident"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('diagnosis',{}).get('diagnosis','?'))" 2>/dev/null)
  result=$(echo "$incident"     | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('actionResult','?'))" 2>/dev/null)
  duration=$(echo "$incident"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(round(d.get('durationMs',0)/1000,1))+'s')" 2>/dev/null)

  echo "    Status:     $status"
  echo "    Action:     $action"
  echo "    Confidence: $confidence"
  echo "    Duration:   $duration"
  echo "    Diagnosis:  $diagnosis"
  echo "    Result:     $result"
}

# ── Run a single alert test ───────────────────────────────────────────────────
run_test() {
  local name="$1" severity="$2" hint="$3" summary="$4" desc="$5"
  local setup_fn="${6:-}"    # optional setup function to call before sending
  local teardown_fn="${7:-}" # optional teardown function to call after

  section "Test: $name"

  # Setup (e.g. start spike)
  if [ -n "$setup_fn" ]; then
    log "Setup: $setup_fn"
    $setup_fn
  fi

  local baseline
  baseline=$(incident_count)
  log "Baseline incident count: $baseline"

  log "Sending $name webhook..."
  local rc
  rc=$(send_webhook "$name" "$severity" "$hint" "$summary" "$desc")
  if [ "$rc" -ne 0 ]; then
    err "Webhook send failed (curl exit $rc)"
    results+=("${RED}FAIL${NC} $name — webhook not accepted")
    failed=$((failed + 1))
    [ -n "$teardown_fn" ] && $teardown_fn
    return
  fi
  ok "Webhook accepted by agent"

  if wait_for_incident "$name" "$baseline"; then
    local incident
    incident=$(latest_incident)
    ok "$name — incident recorded"
    print_incident "$incident"
    results+=("${GRN}PASS${NC} $name")
    passed=$((passed + 1))
  else
    err "$name — no incident recorded within ${WAIT_SECS}s"
    warn "Check agent logs: kubectl logs -n ai-ops deployment/ai-ops-agent --tail=50"
    results+=("${RED}FAIL${NC} $name — no incident within ${WAIT_SECS}s")
    failed=$((failed + 1))
  fi

  # Teardown (e.g. stop spike)
  if [ -n "$teardown_fn" ]; then
    log "Teardown: $teardown_fn"
    $teardown_fn
  fi

  # Brief pause between tests so Gemini rate limiter has breathing room
  log "Pausing 15s before next test..."
  sleep 15
}

# ── Setup / teardown helpers ──────────────────────────────────────────────────
start_error_spike() {
  curl -sf -X POST "$APP/spike/start" > /dev/null 2>&1
  ok "Error spike started (70% of requests will 500)"
}

stop_error_spike() {
  curl -sf -X POST "$APP/spike/stop" > /dev/null 2>&1
  ok "Error spike stopped"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  AI Ops Agent — Alert Test Suite (Kind/K8s)${NC}"
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"

  check_prereqs

  # If a specific alert name was passed, run only that one
  local target="${1:-ALL}"

  if [ "$target" != "ALL" ]; then
    case "$target" in
      HighErrorRate)
        run_test "HighErrorRate" "critical" "restart_or_rollback" \
          "High error rate on sample-app" \
          "Error rate is 72.3% over the last 2 minutes" \
          "start_error_spike" "stop_error_spike"
        ;;
      HighCpuUsage)
        run_test "HighCpuUsage" "warning" "scale_up" \
          "High CPU on sample-app" \
          "CPU rate above 0.5 cores for 2 minutes" \
          "" ""
        ;;
      AppDown)
        run_test "AppDown" "critical" "restart" \
          "sample-app is DOWN" \
          "Prometheus cannot scrape sample-app — target health=down" \
          "" ""
        ;;
      HighLatency)
        run_test "HighLatency" "warning" "scale_up" \
          "High p95 latency on sample-app" \
          "p95 latency is 3.4s — above 2s threshold for 2 minutes" \
          "" ""
        ;;
      ErrorSpike)
        run_test "ErrorSpike" "critical" "restart_or_rollback" \
          "Error spike detected (test trigger)" \
          "Manual spike injected via /spike endpoint" \
          "start_error_spike" "stop_error_spike"
        ;;
      *)
        err "Unknown alert: $target"
        echo "Valid: HighErrorRate | HighCpuUsage | AppDown | HighLatency | ErrorSpike"
        exit 1
        ;;
    esac
  else
    # Run all 5 in sequence

    run_test "HighErrorRate" "critical" "restart_or_rollback" \
      "High error rate on sample-app" \
      "Error rate is 72.3% over the last 2 minutes" \
      "start_error_spike" "stop_error_spike"

    run_test "HighCpuUsage" "warning" "scale_up" \
      "High CPU on sample-app" \
      "CPU rate above 0.5 cores for 2 minutes" \
      "" ""

    run_test "AppDown" "critical" "restart" \
      "sample-app is DOWN" \
      "Prometheus cannot scrape sample-app — target health=down" \
      "" ""

    run_test "HighLatency" "warning" "scale_up" \
      "High p95 latency on sample-app" \
      "p95 latency is 3.4s — above 2s threshold for 2 minutes" \
      "" ""

    run_test "ErrorSpike" "critical" "restart_or_rollback" \
      "Error spike detected (test trigger)" \
      "Manual spike injected via /spike endpoint" \
      "start_error_spike" "stop_error_spike"
  fi

  # ── Final summary ────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  Results${NC}"
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"

  for r in "${results[@]}"; do
    echo -e "  $r"
  done

  echo ""
  local total=$((passed + failed))
  if [ "$failed" -eq 0 ]; then
    echo -e "  ${GRN}${BOLD}ALL PASSED ($passed/$total)${NC}"
  else
    echo -e "  ${RED}${BOLD}$failed FAILED, $passed PASSED ($total total)${NC}"
  fi

  echo ""
  echo "  Full incident log:"
  echo "    curl -s $AGENT/incidents | python3 -m json.tool"
  echo ""
  echo "  Stats:"
  echo "    curl -s $AGENT/incidents/summary/stats | python3 -m json.tool"
  echo ""
  echo "  Agent logs:"
  echo "    kubectl logs -n ai-ops deployment/ai-ops-agent --tail=100"
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  echo ""

  [ "$failed" -gt 0 ] && exit 1
  exit 0
}

main "${1:-ALL}"