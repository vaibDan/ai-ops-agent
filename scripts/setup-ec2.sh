#!/usr/bin/env bash
# Run once on a fresh EC2 t2.micro (Ubuntu 24)
# sudo bash scripts/setup-ec2.sh
set -euo pipefail

echo "==> Updating apt..."
apt-get update -qq && apt-get upgrade -y -qq

echo "==> Installing Docker..."
apt-get install -y -qq ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable docker
systemctl start docker

# Add ubuntu user to docker group (so you don't need sudo)
usermod -aG docker ubuntu

echo "==> Installing Python3 (for json.tool in scripts)..."
apt-get install -y -qq python3

echo "==> Creating project directory..."
mkdir -p /home/ubuntu/ai-ops-agent
chown ubuntu:ubuntu /home/ubuntu/ai-ops-agent

echo ""
echo "✓ Setup complete."
echo ""
echo "Next steps:"
echo "  1. Copy project files to /home/ubuntu/ai-ops-agent"
echo "  2. cd /home/ubuntu/ai-ops-agent"
echo "  3. cp .env.example .env && nano .env   # add ANTHROPIC_API_KEY"
echo "  4. docker compose up -d --build"
echo "  5. ./scripts/trigger-spike.sh"
echo ""
echo "Open these ports in your EC2 Security Group:"
echo "  3000  — AI Ops Agent"
echo "  3001  — sample-app"
echo "  3002  — Grafana"
echo "  9090  — Prometheus"
echo "  9093  — Alertmanager"
echo ""
echo "Log out and back in (or run: newgrp docker) to activate docker group."
