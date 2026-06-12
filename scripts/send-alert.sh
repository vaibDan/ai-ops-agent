#!/usr/bin/env bash
# Usage: ./scripts/send-alert.sh [HighErrorRate|HighCpuUsage|AppDown|HighLatency]
set -euo pipefail

AGENT="http://localhost:3000"
ALERT=${1:-HighErrorRate}

case "$ALERT" in
  HighErrorRate)
    SEVERITY="critical"
    SERVICE="sample-app"
    ACTION_HINT="restart_or_rollback"
    SUMMARY="High error rate on sample-app"
    DESC="Error rate is 68% over the last 2 minutes"
    ;;
  HighCpuUsage)
    SEVERITY="warning"
    SERVICE="sample-app"
    ACTION_HINT="scale_up"
    SUMMARY="High CPU usage on sample-app"
    DESC="CPU usage above threshold for 2 minutes"
    ;;
  AppDown)
    SEVERITY="critical"
    SERVICE="sample-app"
    ACTION_HINT="restart"
    SUMMARY="sample-app is DOWN"
    DESC="Prometheus cannot scrape sample-app — it may be crashed"
    ;;
  HighLatency)
    SEVERITY="warning"
    SERVICE="sample-app"
    ACTION_HINT="scale_up"
    SUMMARY="High p95 latency on sample-app"
    DESC="p95 latency is 3.2s — above 2s threshold"
    ;;
  *)
    echo "Unknown alert: $ALERT"
    echo "Usage: $0 [HighErrorRate|HighCpuUsage|AppDown|HighLatency]"
    exit 1
    ;;
esac

echo "Sending $ALERT alert to $AGENT..."

curl -s -X POST "$AGENT/webhook/alert" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "4",
    "groupKey": "{}:{alertname=\"'"$ALERT"'\"}",
    "truncatedAlerts": 0,
    "status": "firing",
    "receiver": "ai-ops-agent",
    "groupLabels": {"alertname": "'"$ALERT"'"},
    "commonLabels": {
      "alertname": "'"$ALERT"'",
      "severity": "'"$SEVERITY"'",
      "service": "'"$SERVICE"'",
      "action_hint": "'"$ACTION_HINT"'"
    },
    "commonAnnotations": {
      "summary": "'"$SUMMARY"'",
      "description": "'"$DESC"'"
    },
    "externalURL": "http://alertmanager:9093",
    "alerts": [{
      "status": "firing",
      "labels": {
        "alertname": "'"$ALERT"'",
        "severity": "'"$SEVERITY"'",
        "service": "'"$SERVICE"'",
        "action_hint": "'"$ACTION_HINT"'"
      },
      "annotations": {
        "summary": "'"$SUMMARY"'",
        "description": "'"$DESC"'"
      },
      "startsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "http://prometheus:9090/graph",
      "fingerprint": "manual-'"$ALERT"'-'"$(date +%s)"'"
    }]
  }' | python3 -m json.tool 2>/dev/null || cat

echo ""
echo "Watch agent logs: docker compose logs -f agent"
