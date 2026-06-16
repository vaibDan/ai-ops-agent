#!/usr/bin/env bash
# Verifies every component of the AI Ops Agent on kind is working correctly.
# Run after: helm install + kubectl apply -f k8s/...
set -uo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local desc="$1"
  local cmd="$2"
  echo -ne "${BLU}[CHECK]${NC} $desc ... "
  if eval "$cmd" > /tmp/check_out 2>&1; then
    echo -e "${GRN}OK${NC}"
    PASS=$((PASS+1))
    return 0
  else
    echo -e "${RED}FAIL${NC}"
    sed 's/^/    /' /tmp/check_out
    FAIL=$((FAIL+1))
    return 1
  fi
}

info() { echo -e "${YLW}      → $1${NC}"; }

echo ""
echo "════════════════════════════════════════════════════"
echo " AI Ops Agent — Full System Check"
echo "════════════════════════════════════════════════════"
echo ""

# ── 1. Pods running ──────────────────────────────────────────────────────
echo "── Pod Status ──────────────────────────────────────"
kubectl get pods -n ai-ops -o wide
echo ""
kubectl get pods -n monitoring | grep -E "prometheus|alertmanager|grafana"
echo ""

check "sample-app pod is Running" \
  "kubectl get pods -n ai-ops -l app=sample-app -o jsonpath='{.items[0].status.phase}' | grep -q Running"

check "ai-ops-agent pod is Running" \
  "kubectl get pods -n ai-ops -l app=ai-ops-agent -o jsonpath='{.items[0].status.phase}' | grep -q Running"

check "Prometheus pod is Running" \
  "kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].status.phase}' | grep -q Running"

check "Alertmanager pod is Running" \
  "kubectl get pods -n monitoring -l app.kubernetes.io/name=alertmanager -o jsonpath='{.items[0].status.phase}' | grep -q Running"

echo ""

# ── 2. Service health endpoints ──────────────────────────────────────────
echo "── Service Health (via NodePort) ────────────────────"

check "sample-app /health responds" \
  "curl -sf http://localhost:3001/health | grep -q healthy"

check "ai-ops-agent /health responds" \
  "curl -sf http://localhost:3000/health | grep -q ok"

check "Prometheus is healthy" \
  "curl -sf http://localhost:9090/-/healthy"

check "Alertmanager is healthy" \
  "curl -sf http://localhost:9093/-/healthy"

check "Grafana responds" \
  "curl -sf http://localhost:3002/api/health | grep -q ok"

echo ""

# ── 3. Prometheus scrape targets ─────────────────────────────────────────
echo "── Prometheus Scrape Targets ────────────────────────"

check "sample-app is a known scrape target" \
  "curl -sf 'http://localhost:9090/api/v1/targets' | python3 -c \"
import sys,json
d = json.load(sys.stdin)
targets = [t for t in d['data']['activeTargets'] if 'sample-app' in t.get('labels',{}).get('pod','')]
assert len(targets) > 0, 'no sample-app target found'
print('found', len(targets), 'target(s)')
for t in targets:
    print('  health:', t['health'], '| pod:', t['labels'].get('pod'))
\""

cat /tmp/check_out | sed 's/^/      /'

check "ai-ops-agent is a known scrape target" \
  "curl -sf 'http://localhost:9090/api/v1/targets' | python3 -c \"
import sys,json
d = json.load(sys.stdin)
targets = [t for t in d['data']['activeTargets'] if 'ai-ops-agent' in t.get('labels',{}).get('pod','')]
assert len(targets) > 0, 'no ai-ops-agent target found'
print('found', len(targets), 'target(s)')
\""

echo ""

# ── 4. Alert rules loaded ────────────────────────────────────────────────
echo "── Alert Rules ──────────────────────────────────────"

check "ErrorSpike rule is loaded in Prometheus" \
  "curl -sf 'http://localhost:9090/api/v1/rules' | python3 -c \"
import sys,json
d = json.load(sys.stdin)
names = []
for g in d['data']['groups']:
    for r in g.get('rules', []):
        names.append(r.get('name'))
assert 'ErrorSpike' in names, f'ErrorSpike not found. Rules loaded: {names}'
print('all rules:', names)
\""

cat /tmp/check_out | sed 's/^/      /'

echo ""

# ── 5. app_error_spike metric exists ─────────────────────────────────────
echo "── Metric Availability ──────────────────────────────"

check "app_error_spike metric is queryable" \
  "curl -sf 'http://localhost:9090/api/v1/query?query=app_error_spike' | python3 -c \"
import sys,json
d = json.load(sys.stdin)
result = d['data']['result']
assert len(result) > 0, 'metric not found — Prometheus is not scraping it'
print('value:', result[0]['value'][1])
\""

cat /tmp/check_out | sed 's/^/      /'

check "http_requests_total metric is queryable" \
  "curl -sf 'http://localhost:9090/api/v1/query?query=http_requests_total' | python3 -c \"
import sys,json
d = json.load(sys.stdin)
result = d['data']['result']
assert len(result) > 0, 'metric not found'
print('found', len(result), 'series')
\""

echo ""

# ── 6. Alertmanager webhook config ───────────────────────────────────────
echo "── Alertmanager Configuration ───────────────────────"

check "Alertmanager points to ai-ops-agent webhook" \
  "kubectl get secret -n monitoring alertmanager-monitoring-kube-prometheus-alertmanager -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d | grep -q 'ai-ops-agent-service'"

echo ""

# ── 7. RBAC — agent can talk to k8s API ──────────────────────────────────
echo "── RBAC Permissions ─────────────────────────────────"

check "agent ServiceAccount can patch deployments" \
  "kubectl auth can-i patch deployments --as=system:serviceaccount:ai-ops:ai-ops-agent -n ai-ops | grep -q yes"

check "agent ServiceAccount can read pod logs" \
  "kubectl auth can-i get pods/log --as=system:serviceaccount:ai-ops:ai-ops-agent -n ai-ops | grep -q yes"

echo ""

# ── 8. Incident log endpoint ─────────────────────────────────────────────
echo "── Incident API ──────────────────────────────────────"

check "incidents endpoint responds" \
  "curl -sf http://localhost:3000/incidents | python3 -c \"
import sys,json
d = json.load(sys.stdin)
print('total incidents so far:', d['count'])
\""

cat /tmp/check_out | sed 's/^/      /'

echo ""

# ── Summary ───────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GRN} ALL CHECKS PASSED ($PASS/$((PASS+FAIL)))${NC}"
  echo ""
  echo " System is ready. To trigger an incident:"
  echo "   curl -X POST http://localhost:3001/spike/start"
  echo ""
  echo " Then watch:"
  echo "   kubectl logs -f -n ai-ops deployment/ai-ops-agent"
else
  echo -e "${RED} $FAIL CHECK(S) FAILED, $PASS PASSED${NC}"
  echo ""
  echo " Fix failed checks above before testing the full loop."
  echo " Common fixes:"
  echo "   - Scrape target missing → check podmonitor.yaml applied + named port 'http'"
  echo "   - Alert rule missing    → check prometheusrule.yaml applied"
  echo "   - RBAC failing          → check role.yaml / rolebinding.yaml applied"
  echo "   - Webhook URL wrong     → check values.yaml alertmanager.config"
fi
echo "════════════════════════════════════════════════════"
echo ""