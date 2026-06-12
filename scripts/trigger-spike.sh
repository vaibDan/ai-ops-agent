#!/usr/bin/env bash
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
SAMPLE_APP="http://localhost:3001"
AGENT="http://localhost:3000"
ALERTMANAGER="http://localhost:9093"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLU}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GRN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
warn() { echo -e "${YLW}[$(date +%H:%M:%S)] ⚠${NC}  $*"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*"; }

echo ""
echo -e "${RED}╔══════════════════════════════════════════════╗${NC}"
echo -e "${RED}║     AI Ops Agent — Full Loop Test             ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Check services are up ─────────────────────────────────────────
log "Checking service health..."

check_service() {
  local name=$1 url=$2
  if curl -sf "$url" > /dev/null 2>&1; then
    ok "$name is up ($url)"
  else
    err "$name is NOT responding at $url"
    err "Run: docker compose up -d --build"
    exit 1
  fi
}

check_service "sample-app" "$SAMPLE_APP/health"
check_service "ai-ops-agent" "$AGENT/health"
check_service "alertmanager" "$ALERTMANAGER/-/healthy"
echo ""

# ── Step 2: Generate background traffic ───────────────────────────────────
log "Starting background traffic (20 req/s for 2 minutes)..."
(
  for _ in $(seq 1 240); do
    curl -sf "$SAMPLE_APP/" > /dev/null 2>&1 &
    sleep 0.05
  done
  wait
) &
TRAFFIC_PID=$!
ok "Background traffic started (PID $TRAFFIC_PID)"

# ── Step 3: Trigger error spike ───────────────────────────────────────────
echo ""
log "Injecting error spike into sample-app..."
SPIKE_RESP=$(curl -sf -X POST "$SAMPLE_APP/spike/start")
ok "Spike started: $SPIKE_RESP"
echo ""
warn "sample-app will now return 500 on ~70% of requests"
warn "Prometheus will detect the error rate in ~1 minute"
warn "Alertmanager will fire the webhook after the 'for' duration"
echo ""

# ── Step 4: Also send a manual webhook to skip the Prometheus wait ─────────
log "Sending manual webhook to agent (bypasses Prometheus wait time)..."
MANUAL_PAYLOAD='{
  "version": "4",
  "groupKey": "{}:{alertname=\"HighErrorRate\"}",
  "truncatedAlerts": 0,
  "status": "firing",
  "receiver": "ai-ops-agent",
  "groupLabels": {"alertname": "HighErrorRate"},
  "commonLabels": {
    "alertname": "HighErrorRate",
    "severity": "critical",
    "service": "sample-app",
    "action_hint": "restart_or_rollback"
  },
  "commonAnnotations": {
    "summary": "High error rate on sample-app",
    "description": "Error rate is 72.3% over the last 2 minutes (test spike)"
  },
  "externalURL": "http://alertmanager:9093",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "HighErrorRate",
        "severity": "critical",
        "service": "sample-app",
        "action_hint": "restart_or_rollback"
      },
      "annotations": {
        "summary": "High error rate on sample-app",
        "description": "Error rate is 72.3% over the last 2 minutes (test spike)"
      },
      "startsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "http://prometheus:9090/graph",
      "fingerprint": "test-spike-'"$(date +%s)"'"
    }
  ]
}'

HTTP_STATUS=$(curl -s -o /tmp/agent_response.json -w "%{http_code}" \
  -X POST "$AGENT/webhook/alert" \
  -H "Content-Type: application/json" \
  -d "$MANUAL_PAYLOAD")

if [ "$HTTP_STATUS" = "200" ]; then
  ok "Webhook accepted by agent (HTTP $HTTP_STATUS)"
  cat /tmp/agent_response.json
else
  err "Webhook failed (HTTP $HTTP_STATUS)"
  cat /tmp/agent_response.json
fi

echo ""
echo -e "${YLW}════════════════════════════════════════════════${NC}"
log "Agent is now running the ops loop. Watch logs with:"
echo -e "  ${GRN}docker compose logs -f agent${NC}"
echo ""
log "Expected sequence:"
echo "  1. Agent fetches metrics from Prometheus"
echo "  2. Agent gets container logs from Docker"
echo "  3. Agent calls Claude API for diagnosis"
echo "  4. Claude returns { action, confidence, reasoning }"
echo "  5. If confidence >= 0.8 → restart/scale/rollback"
echo "  6. If confidence < 0.8 → escalate (Slack or log)"
echo "  7. Post-mortem generated and saved"
echo ""

# ── Step 5: Poll for incident ──────────────────────────────────────────────
log "Polling for incident record (up to 90 seconds)..."
for i in $(seq 1 18); do
  sleep 5
  INCIDENTS=$(curl -sf "$AGENT/incidents" 2>/dev/null || echo '{"count":0}')
  COUNT=$(echo "$INCIDENTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null || echo "0")

  if [ "$COUNT" -gt "0" ]; then
    echo ""
    ok "Incident recorded!"
    curl -sf "$AGENT/incidents" | python3 -m json.tool 2>/dev/null || \
      curl -sf "$AGENT/incidents"
    echo ""
    break
  else
    echo -n "."
  fi
done

# ── Step 6: Stop the spike ─────────────────────────────────────────────────
echo ""
log "Stopping error spike..."
curl -sf -X POST "$SAMPLE_APP/spike/stop" | cat
ok "Error spike stopped — app returning to normal"

# Cleanup background traffic
kill $TRAFFIC_PID 2>/dev/null || true

echo ""
echo -e "${GRN}════════════════════════════════════════════════${NC}"
ok "Test complete. View full incident log:"
echo -e "  ${GRN}curl http://localhost:3000/incidents | python3 -m json.tool${NC}"
echo ""
ok "View incident stats:"
echo -e "  ${GRN}curl http://localhost:3000/incidents/summary/stats | python3 -m json.tool${NC}"
echo ""
