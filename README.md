ai-ops-agent-k8s/
├── agent/                          # Same as before
│   └── src/
│       └── services/
│           ├── kubernetes.ts       # NEW — replaces docker.ts
│           ├── claude.ts           # unchanged
│           ├── opsLoop.ts          # small change — import kubernetes.ts
│           ├── prometheus.ts       # unchanged
│           ├── incidentLog.ts      # unchanged
│           └── escalation.ts      # unchanged
├── k8s/
│   ├── namespace.yaml
│   ├── sample-app/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── hpa.yaml
│   ├── agent/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   ├── serviceaccount.yaml
│   │   ├── role.yaml
│   │   └── rolebinding.yaml
│   └── monitoring/
│       └── alertmanager-config.yaml
└── scripts/
    ├── setup-kind.sh
    └── trigger-spike.sh