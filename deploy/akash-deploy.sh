#!/usr/bin/env bash
# Deploy Forge to Akash via the CLI — flow per the official quickstart and
# awesome-akash conventions.
#
# Prereqs:
#   - akash CLI installed + key funded (~5 AKT):  akash keys add default
#   - SDL image field set to a published, tagged image
# Usage:
#   KEY_NAME=default bash deploy/akash-deploy.sh
# Env overrides:
#   AKASH_NODE (default mainnet RPC), SDL, KEY_NAME
set -euo pipefail

KEY="${KEY_NAME:-default}"
SDL="${SDL:-deploy/forge.sdl.yaml}"
export AKASH_NODE="${AKASH_NODE:-https://rpc.akashnet.net:443}"
export AKASH_CHAIN_ID="${AKASH_CHAIN_ID:-akashnet-2}"
GAS="${GAS:-auto}"
GAS_ADJUSTMENT="${GAS_ADJUSTMENT:-1.5}"

need() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
need akash; need jq

echo "==> key: $KEY @ $AKASH_NODE"
ADDR=$(akash keys show "$KEY" -a)
echo "    address: $ADDR"

tx() { akash tx "$@" --node "$AKASH_NODE" --chain-id "$AKASH_CHAIN_ID" --from "$KEY" -y --gas "$GAS" --gas-adjustment "$GAS_ADJUSTMENT" -o json; }
q()  { akash query "$@" --node "$AKASH_NODE" -o json; }

echo "==> ensuring published client certificate (manifest auth)"
CERTS=$(akash query cert list --owner "$ADDR" --state valid --node "$AKASH_NODE" -o json 2>/dev/null | jq -r '.certificates | length')
if [ "${CERTS:-0}" -eq 0 ]; then
  akash tx cert generate client --from "$KEY" --overwrite
  tx cert publish client > /dev/null
  echo "    created + published client cert; waiting for propagation (20s)"
  sleep 20
else
  echo "    found $CERTS valid cert(s)"
fi

echo "==> creating deployment from $SDL"
tx deployment create "$SDL" > /tmp/akash-create.json
sleep 8
# dseq from the most recent deployment owned by this address.
DSEQ=$(q deployment list --owner "$ADDR" --state active | jq -r '."deployments" | map(."deployment".dseq) | sort_by(tonumber) | last')
[ -n "$DSEQ" ] || { echo "could not read dseq"; exit 1; }
echo "    dseq: $DSEQ"

cleanup() { echo "!! failed — cleaning up deployment $DSEQ"; akash tx deployment close --node "$AKASH_NODE" --chain-id "$AKASH_CHAIN_ID" --owner "$ADDR" --dseq "$DSEQ" --from "$KEY" -y 2>/dev/null || true; }
trap cleanup ERR

echo "==> waiting for bids (up to 90s)..."
BIDS=""
for i in $(seq 1 18); do
  BIDS=$(q market bid list --owner "$ADDR" --dseq "$DSEQ" --state open | jq -c '."bids" // []')
  [ "$(echo "$BIDS" | jq length)" -gt 0 ] && break
  sleep 5
done
[ -n "$BIDS" ] && [ "$(echo "$BIDS" | jq length)" -gt 0 ] || { echo "no bids received"; exit 1; }
# Take the cheapest open bid.
CHEAPEST=$(echo "$BIDS" | jq -c 'sort_by(.price.amount | tonumber) | first')
GSEQ=$(echo "$CHEAPEST" | jq -r '."bid".gseq')
OSEQ=$(echo "$CHEAPEST" | jq -r '."bid".oseq')
PROVIDER=$(echo "$CHEAPEST" | jq -r '."bid".provider')
PRICE=$(echo "$CHEAPEST" | jq -r '.price.amount')
echo "    provider: $PROVIDER @ ${PRICE}uakt (gseq=$GSEQ oseq=$OSEQ)"

echo "==> creating lease"
tx market lease create --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER" > /dev/null
sleep 6

echo "==> sending manifest"
akash provider send-manifest "$SDL" --node "$AKASH_NODE" --from "$KEY" --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER"
trap - ERR

echo "==> waiting for workload to come up (30s)..."
sleep 30
STATUS=$(akash provider lease-status --node "$AKASH_NODE" --from "$KEY" --dseq "$DSEQ" --gseq "$GSEQ" --oseq "$OSEQ" --provider "$PROVIDER" 2>/dev/null || true)
echo "$STATUS" | jq '{services, forwarded_ports}' 2>/dev/null || echo "$STATUS"
URI=$(echo "$STATUS" | jq -r '[.services[].uris[]?] | first // empty')
echo ""
echo "✅ Forge is live at: ${URI:-<check lease-status uris>}"
echo "  logs:  akash provider service-logs --node $AKASH_NODE --from $KEY --dseq $DSEQ --gseq $GSEQ --oseq $OSEQ --provider $PROVIDER"
echo "  shell: akash provider lease-shell --node $AKASH_NODE --from $KEY --dseq $DSEQ --gseq $GSEQ --oseq $OSEQ --provider $PROVIDER forge /bin/sh"
echo "  close: akash tx deployment close --node $AKASH_NODE --owner $ADDR --dseq $DSEQ --from $KEY -y"
