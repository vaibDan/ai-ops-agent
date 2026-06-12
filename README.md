

## Architecture

ai-ops-agent/
├── .env.example
├── .gitignore
├── README.md
├── docker-compose.yml
├── prometheus/
│   ├── prometheus.yml
│   └── alert.rules.yml
├── alertmanager/
│   └── alertmanager.yml
├── sample-app/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/index.ts
├── agent/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── types/index.ts
│       ├── utils/logger.ts
│       ├── routes/webhook.ts
│       ├── routes/incidents.ts
│       └── services/
│           ├── claude.ts
│           ├── docker.ts
│           ├── escalation.ts
│           ├── incidentLog.ts
│           ├── opsLoop.ts
│           └── prometheus.ts
└── scripts/
    ├── setup-ec2.sh
    ├── trigger-spike.sh
    └── send-alert.sh