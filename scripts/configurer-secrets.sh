#!/bin/bash
# Envoie à Vercel la session Obsidian de ce Mac (jeton créé par « ob login »,
# pas le mot de passe), génère la clé secrète du connecteur, redéploie et
# teste. L'adresse finale est copiée dans le presse-papiers, jamais affichée.
set -euo pipefail
cd "$(dirname "$0")/.."

H="$HOME/.obsidian-headless"
VAULT_ID="1b54d97be654180f073866147f4e9b16"
[ -s "$H/auth_token" ] || { echo "Pas de session Obsidian : lance d'abord « ob login »."; exit 1; }

echo "1/4 Envoi des secrets à Vercel…"
tr -d '\n' < "$H/auth_token" | vercel env add OBSIDIAN_AUTH_TOKEN production --force --yes >/dev/null
base64 < "$H/sync/$VAULT_ID/config.json" | tr -d '\n' | vercel env add OB_SYNC_CONFIG production --force --yes >/dev/null
KEY="$(openssl rand -hex 24)"
printf %s "$KEY" | vercel env add CONNECTOR_KEY production --force --yes >/dev/null

echo "2/4 Redéploiement…"
vercel deploy --prod --yes >/dev/null 2>&1

URL="https://connecteur-obsidian.vercel.app/$KEY/mcp"
echo "3/4 Test du connecteur (premier chargement du coffre, ~20 s)…"
RES="$(curl -s -m 280 -X POST "$URL" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"etat_crm","arguments":{"jours":7}}}')"
if echo "$RES" | grep -q '\\"totaux\\"'; then
  echo "    OK : le connecteur lit ton CRM."
else
  echo "    ÉCHEC du test. Début de la réponse :"; echo "$RES" | head -c 600; echo
fi

if command -v claude >/dev/null; then
  claude mcp remove obsidian --scope user >/dev/null 2>&1 || true
  claude mcp add --transport http --scope user obsidian "$URL" >/dev/null && echo "    Connecteur « obsidian » ajouté à Claude Code sur ce Mac."
fi

printf %s "$URL" | pbcopy
echo "4/4 Adresse du connecteur (aussi copiée dans le presse-papiers) :"
echo
echo "    $URL"
echo
echo "    Colle-la dans Claude : Réglages → Connecteurs → Ajouter un connecteur personnalisé."
