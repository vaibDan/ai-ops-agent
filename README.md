# AI Ops Agent

The AI Ops Agent is an automated, LLM-powered operations agent designed to autonomously diagnose and remediate production incidents. It listens to monitoring alerts (via Prometheus & Alertmanager), gathers contextual data (metrics and logs), uses an LLM (Google Gemini) to determine the root cause, and executes remediation actions without human intervention.

## Features

- **Automated Diagnosis**: Leverages Gemini to analyze metrics, application logs, and pod restart information.
- **Autonomous Remediation**: Can automatically execute actions like restarting containers, scaling up deployments, or rolling back versions based on LLM recommendations.
- **Alert Deduplication**: Prevents alert storms and rate-limiting by deduplicating in-flight alerts and enforcing cooldowns.
- **Escalation**: Falls back to human escalation (e.g., via Slack) when confidence is below a configured threshold or when an action fails.
- **Post-Mortem Generation**: Automatically generates detailed incident records and post-mortems stored in a PostgreSQL database (if configured) or standard persistent logs.

## Architecture & Components

The repository is structured as follows:

- `agent/`: The core NodeJS/Express application built with TypeScript. It exposes a webhook endpoint for Alertmanager and handles the observation-diagnosis-action-record loop.
- `sample-app/`: A sample application that generates Prometheus metrics, useful for testing the agent's response to latency or error spikes.
- `prometheus/`: Configuration files and alert rules for Prometheus.
- `alertmanager/`: Alertmanager configuration to route alerts to the AI Ops Agent's webhook.
- `k8s/`: Kubernetes manifests (Deployments, Services, RBAC, etc.) to deploy the agent, sample app, and monitoring stack on a Kubernetes cluster.
- `scripts/`: Utility scripts to provision environments (e.g., kind, EC2), trigger test alerts, and verify the setup.

## Getting Started

### Prerequisites
- Docker & Docker Compose (for local testing)
- A Kubernetes cluster (e.g., kind, minikube, EKS)
- Google Gemini API Key (`GOOGLE_API_KEY`)
- OpenRouter API Key (optional as a fallback) (`OPENROUTER_API_KEY`)
- Slack Webhook URL (optional, for escalation) (`SLACK_WEBHOOK_URL`)

### Running Locally with Docker Compose

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Update the `.env` file to include your API keys and webhook URL.
3. Start the stack:
   ```bash
   docker-compose up --build
   ```

### Running on Kubernetes

You can use the provided helper scripts to set up a local `kind` cluster and deploy the stack:

1. Setup the cluster in kind:
   ```bash
   ./k8s/kind-config.yml
   ```
2. Verify the deployment:
   ```bash
   ./scripts/verify-k8s.sh
   ```
3. Trigger all alert:
    ```bash
   ./scripts/test-alerts-k8s.sh
   ```

### Simulating an Incident

To test the agent, you can trigger a spike in the sample app:
```bash
./scripts/trigger-spike.sh
```
This will cause Prometheus to fire an alert, which Alertmanager forwards to the agent. Check the agent logs to see the AI diagnosis and remediation in action!

## Environment Variables

- `GOOGLE_API_KEY`: API key for Google Gemini.
- `SLACK_WEBHOOK_URL`: Optional webhook for escalations.
- `CONFIDENCE_THRESHOLD`: Minimum confidence (0.0 - 1.0) required before the agent takes an autonomous action. Default is `0.8`.
- `ALERT_COOLDOWN_MS`: Minimum time in milliseconds before reprocessing the same alert type. Default is `600000` (10 minutes).
- `PROMETHEUS_URL`: URL to the Prometheus server (e.g. `http://prometheus:9090`).
- `LOG_LEVEL`: Application logging level. Default is `info`.