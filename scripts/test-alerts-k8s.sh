#!/usr/bin/env bash
# Full alert test suite for the AI Ops Agent on Kind/Kubernetes.
# Tests all 6 alert types sequentially, waits for each incident to be
# recorded, then prints a full summary.
#
# Usage:
#   ./scripts/test-alerts-k8s.sh                # run all 6 alerts
#   ./scripts/test-alerts-k8s.sh HighErrorRate  # run one specific alert
#   ./scripts/test-alerts-k8s.sh PodCrashLooping
#
set -uo pipefail

# ── Cleanup trap ──────────────────────────────────────────────────────────────
# Runs on Ctrl+C or any exit — ensures the cluster is always left in a
# clean state even if the test is interrupted mid-run.
CLEANUP_NEEDED=false

cleanup() {
  if [ "$CLEANUP_NEEDED" = true ]; then
    echo ""
    warn "Interrupted — running cleanup to restore cluster state..."
    stop_error_spike    2>/dev/null || true
    restore_good_image  2>/dev/null || true
    warn "Cleanup done. Re-run verify-k8s.sh to confirm cluster is healthy."
  fi
  exit 0
}

trap cleanup INT TERM EXIT

# ── Config ────────────────────────────────────────────────────────────────────
AGENT="${AGENT_URL:-http://localhost:3000}"
APP="${APP_URL:-http://localhost:3001}"
WAIT_SECS="${WAIT_SECS:-90}"
POLL_INTERVAL=5
NAMESPACE="${NAMESPACE:-ai-ops}"
# The last known-good image tag — used to roll back after crash loop test.
# Change this to match whatever image tag you loaded into kind.
GOOD_IMAGE="${GOOD_IMAGE:-sample-app:local}"

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

log()     { echo -e "${BLU}[$(date +%H:%M:%S)]${NC} $*"; }
ok()      { echo -e "${GRN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
warn()    { echo -e "${YLW}[$(date +%H:%M:%S)] ⚠${NC}  $*"; }
err()     { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*"; }
section() { echo -e "\n${BOLD}${CYN}══ $* ══${NC}"; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
check_prereqs() {
  section "Prerequisites"
  local fail=0

  if ! curl -sf "$AGENT/health" > /dev/null 2>&1; then
    err "Agent not reachable at $AGENT"
    err "Run: kubectl port-forward -n $NAMESPACE svc/ai-ops-agent-service 3000:3000"
    fail=1
  else
    ok "Agent reachable ($AGENT)"
  fi

  if ! curl -sf "$APP/health" > /dev/null 2>&1; then
    err "sample-app not reachable at $APP"
    err "Run: kubectl port-forward -n $NAMESPACE svc/sample-app-service 3001:3001"
    fail=1
  else
    ok "sample-app reachable ($APP)"
  fi

  if ! kubectl get pods -n "$NAMESPACE" > /dev/null 2>&1; then
    err "kubectl cannot reach cluster — check your kubeconfig"
    fail=1
  else
    ok "kubectl connected to cluster"
  fi

  [ "$fail" -eq 1 ] && { echo ""; err "Fix the above before running tests."; exit 1; }
}

# ── Helpers ───────────────────────────────────────────────────────────────────
incident_count() {
  curl -sf "$AGENT/incidents" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null \
    || echo "0"
}

latest_incident() {
  curl -sf "$AGENT/incidents" 2>/dev/null \
    | python3 -c "
import sys,json
d = json.load(sys.stdin)
if d['count'] > 0:
    print(json.dumps(d['incidents'][0], indent=2))
" 2>/dev/null || echo "{}"
}

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
        \"namespace\": \"${NAMESPACE}\",
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
          \"namespace\": \"${NAMESPACE}\",
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

wait_for_incident() {
  local baseline="$1"
  local elapsed=0
  echo -ne "    Waiting for incident"
  while [ "$elapsed" -lt "$WAIT_SECS" ]; do
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
    local current
    current=$(incident_count)
    echo -ne "."
    if [ "$current" -gt "$baseline" ]; then
      echo ""; return 0
    fi
  done
  echo ""; return 1
}

print_incident() {
  local incident="$1"
  python3 - << PYEOF
import json
d = json.loads('''${incident}''')
print(f"    Status:     {d.get('status','?')}")
print(f"    Action:     {d.get('actionTaken','?')}")
print(f"    Confidence: {d.get('diagnosis',{}).get('confidence','?')}")
print(f"    Duration:   {round(d.get('durationMs',0)/1000,1)}s")
print(f"    Diagnosis:  {d.get('diagnosis',{}).get('diagnosis','?')}")
print(f"    Result:     {d.get('actionResult','?')}")
PYEOF
}

# ── Generic test runner ───────────────────────────────────────────────────────
run_test() {
  local name="$1" severity="$2" hint="$3" summary="$4" desc="$5"
  local setup_fn="${6:-}" teardown_fn="${7:-}"

  section "Test: $name"

  [ -n "$setup_fn" ] && { log "Setup: $setup_fn"; $setup_fn; }

  local baseline
  baseline=$(incident_count)
  log "Baseline incident count: $baseline"

  log "Sending $name webhook..."
  local rc
  rc=$(send_webhook "$name" "$severity" "$hint" "$summary" "$desc")
  if [ "$rc" -ne 0 ]; then
    err "Webhook send failed (curl exit $rc)"
    results+=("${RED}FAIL${NC} $name — webhook not accepted")
    failed=$((failed+1))
    [ -n "$teardown_fn" ] && $teardown_fn
    return
  fi
  ok "Webhook accepted by agent"

  if wait_for_incident "$baseline"; then
    local incident
    incident=$(latest_incident)
    ok "$name — incident recorded"
    print_incident "$incident"
    results+=("${GRN}PASS${NC} $name")
    passed=$((passed+1))
  else
    err "$name — no incident recorded within ${WAIT_SECS}s"
    warn "Check: kubectl logs -n $NAMESPACE deployment/ai-ops-agent --tail=50"
    results+=("${RED}FAIL${NC} $name — no incident within ${WAIT_SECS}s")
    failed=$((failed+1))
  fi

  [ -n "$teardown_fn" ] && { log "Teardown: $teardown_fn"; $teardown_fn; }
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

# ── PodCrashLooping test ──────────────────────────────────────────────────────
# Deploys a broken image (busybox that exits immediately) to simulate a
# real crash loop. The agent should detect the exit codes in pod status,
# diagnose bad image/config, and either rollback or restart.
# After the test, we restore the working image regardless of outcome.
test_pod_crash_loop() {
  section "Test: PodCrashLooping"
  CLEANUP_NEEDED=true   # ensure restore_good_image runs even on Ctrl+C

  log "Deploying broken image to trigger crash loop..."
  kubectl set image deployment/sample-app \
    sample-app=busybox:latest \
    -n "$NAMESPACE" > /dev/null 2>&1

  # busybox with no command exits immediately → CrashLoopBackOff
  kubectl patch deployment sample-app -n "$NAMESPACE" \
    --type='json' \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo crash && exit 1"]}]' \
    > /dev/null 2>&1

  ok "Broken image deployed — waiting 20s for crash loop to develop..."
  sleep 20

  # Show current pod state so you can see the CrashLoopBackOff
  echo ""
  kubectl get pods -n "$NAMESPACE" -l app=sample-app
  echo ""

  local restart_count
  restart_count=$(kubectl get pods -n "$NAMESPACE" -l app=sample-app \
    -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}' 2>/dev/null || echo "0")
  log "Current restart count: $restart_count"

  local baseline
  baseline=$(incident_count)
  log "Baseline incident count: $baseline"

  log "Sending PodCrashLooping webhook..."
  local rc
  rc=$(send_webhook \
    "PodCrashLooping" \
    "critical" \
    "rollback_or_restart" \
    "sample-app pod is crash looping" \
    "Pod sample-app has restarted ${restart_count} times in the last 10 minutes. Last exit code: 1 (Error). Container command failed immediately.")

  if [ "$rc" -ne 0 ]; then
    err "Webhook send failed"
    results+=("${RED}FAIL${NC} PodCrashLooping — webhook not accepted")
    failed=$((failed+1))
    restore_good_image
    return
  fi
  ok "Webhook accepted by agent"

  if wait_for_incident "$baseline"; then
    local incident
    incident=$(latest_incident)
    ok "PodCrashLooping — incident recorded"
    print_incident "$incident"
    results+=("${GRN}PASS${NC} PodCrashLooping")
    passed=$((passed+1))
  else
    err "PodCrashLooping — no incident within ${WAIT_SECS}s"
    results+=("${RED}FAIL${NC} PodCrashLooping — no incident within ${WAIT_SECS}s")
    failed=$((failed+1))
  fi

  restore_good_image
  CLEANUP_NEEDED=false
  log "Pausing 15s before next test..."
  sleep 15
}

restore_good_image() {
  log "Restoring working image ($GOOD_IMAGE)..."
  # Remove the crash command patch first
  kubectl patch deployment sample-app -n "$NAMESPACE" \
    --type='json' \
    -p='[{"op":"remove","path":"/spec/template/spec/containers/0/command"}]' \
    > /dev/null 2>&1 || true

  # Restore original image
  kubectl set image deployment/sample-app \
    sample-app="$GOOD_IMAGE" \
    -n "$NAMESPACE" > /dev/null 2>&1

  # Wait for rollout
  kubectl rollout status deployment/sample-app -n "$NAMESPACE" --timeout=60s > /dev/null 2>&1
  ok "sample-app restored to $GOOD_IMAGE"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  AI Ops Agent — Alert Test Suite (Kind/K8s)${NC}"
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"

  check_prereqs

  local target="${1:-ALL}"

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
        "CPU rate above 0.5 cores for 2 minutes" "" ""
      ;;
    AppDown)
      run_test "AppDown" "critical" "restart" \
        "sample-app is DOWN" \
        "Prometheus cannot scrape sample-app — target health=down" "" ""
      ;;
    HighLatency)
      run_test "HighLatency" "warning" "scale_up" \
        "High p95 latency on sample-app" \
        "p95 latency is 3.4s — above 2s threshold for 2 minutes" "" ""
      ;;
    ErrorSpike)
      run_test "ErrorSpike" "critical" "restart_or_rollback" \
        "Error spike detected (test trigger)" \
        "Manual spike injected via /spike endpoint" \
        "start_error_spike" "stop_error_spike"
      ;;
    PodCrashLooping)
      test_pod_crash_loop
      ;;
    ALL)
      run_test "HighErrorRate" "critical" "restart_or_rollback" \
        "High error rate on sample-app" \
        "Error rate is 72.3% over the last 2 minutes" \
        "start_error_spike" "stop_error_spike"

      run_test "HighCpuUsage" "warning" "scale_up" \
        "High CPU on sample-app" \
        "CPU rate above 0.5 cores for 2 minutes" "" ""

      run_test "AppDown" "critical" "restart" \
        "sample-app is DOWN" \
        "Prometheus cannot scrape sample-app — target health=down" "" ""

      run_test "HighLatency" "warning" "scale_up" \
        "High p95 latency on sample-app" \
        "p95 latency is 3.4s — above 2s threshold for 2 minutes" "" ""

      run_test "ErrorSpike" "critical" "restart_or_rollback" \
        "Error spike detected (test trigger)" \
        "Manual spike injected via /spike endpoint" \
        "start_error_spike" "stop_error_spike"

      test_pod_crash_loop
      ;;
    *)
      err "Unknown alert: $target"
      echo "Valid: HighErrorRate | HighCpuUsage | AppDown | HighLatency | ErrorSpike | PodCrashLooping | ALL"
      exit 1
      ;;
  esac

  # ── Summary ───────────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  Results${NC}"
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  for r in "${results[@]}"; do echo -e "  $r"; done
  echo ""
  local total=$((passed+failed))
  if [ "$failed" -eq 0 ]; then
    echo -e "  ${GRN}${BOLD}ALL PASSED ($passed/$total)${NC}"
  else
    echo -e "  ${RED}${BOLD}$failed FAILED, $passed PASSED ($total total)${NC}"
  fi
  echo ""
  echo "  Incidents:  curl -s $AGENT/incidents | python3 -m json.tool"
  echo "  Stats:      curl -s $AGENT/incidents/summary/stats | python3 -m json.tool"
  echo "  Logs:       kubectl logs -n $NAMESPACE deployment/ai-ops-agent --tail=100"
  echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
  echo ""
  [ "$failed" -gt 0 ] && exit 1; exit 0
}

main "${1:-ALL}"