#!/usr/bin/env bash
# Deploy Forge to Akash via the CLI.
# Prereqs: akash CLI installed, key funded (~5 AKT), SDL image field set.
#   Usage: KEY_NAME=default bash deploy/akash-deploy.sh
set -euo pipefail

KEY="${KEY_NAME:-default}"
SDL="${SDL:-deploy/forge.sdl.yaml}"
DSEQ=""

need() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
need akash; need jq

echo "==> using key: $KEY"
ADDR=$(akash keys show "$KEY" -a)
echo "    address: $ADDR"

echo "==> ensuring certificate"
if ! akash certs query owner "$ADDR" 2>/dev/null | grep -q cert; then
  akash tx cert create server --from "$KEY" -y
fi

echo "==> creating deployment"
ak_tx=$(akash tx deployment create "$SDL" --from "$KEY" -y -o json)
DSEQ=$(echo "$ak_tx" | jq -r '.["@type"] // empty' >/dev/null; echo "$ak_tx" | jq -r 'if has("dseq") then .dseq else (."txhash"|capture("(?<d>[0-9]+)").d) end' 2>/dev/null || true)
# Fallback: read dseq from the deployment list.
DSEQ=$(akash query deployment list --owner "$ADDR" --output json | jq -r '."deployments"[0]."deployment"."dseq"')
echo "    dseq: $DSEQ"

echo "==> waiting for bids (up to 60s)..."
for i in $(seq 1 12); do
  BID=$(akash query market bid list --owner "$ADDR" --dseq "$DSEQ" --output json | jq -r '."bids"[0] // empty')
  [ -n "$BID" ] && break
  sleep 5
done
GSEQ=$(echo "$BID" | jq -r '."bid"."gseq"')
OSEQ=$(echo "$BID" | jq -r '."bid"."oseq"')
PROVIDER=$(echo "$BID" | jq -r '."bid"."provider"')
echo "    provider: $PROVIDER (gseq=$GSEQ oseq=$OSEQ)"

echo "==> creating lease"
akash tx market lease create --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER" --from "$KEY" -y

echo "==> sending manifest"
akash provider send-manifest "$SDL" --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER" --from "$KEY"

sleep 10
echo "==> deployment status"
akash provider lease-status --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER" --from "$KEY"
URI=$(akash provider lease-status --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER" --from "$KEY" 2>/dev/null | jq -r '."forwarded_ports"."forge"[0]."host" // empty')
echo ""
echo "Done. Forge is live at: ${URI:-<see lease-status forwarded_ports>}"
echo "  logs:   akash provider service-logs --dseq $DSEQ --gseq $GSEQ --oseq $OSEQ --provider $PROVIDER --from $KEY"
echo "  close:  akash tx deployment close --dseq $DSEQ --from $KEY -y"
