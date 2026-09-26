#!/usr/bin/env bash
# Mise à jour sûre de Rydar Drive depuis GitHub puis déploiement.
# Usage : bash deploy/update-production.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${RYDAR_BRANCH:-claude/confident-clarke-rpfwmo}"
REMOTE="${RYDAR_REMOTE:-origin}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="backup/auto-deploy-$STAMP"
STASHED=0

cd "$ROOT"

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "✗ Un merge/rebase est déjà en cours. Termine-le ou annule-le avant de relancer."
  exit 1
fi

CURRENT="$(git branch --show-current)"
if [ "$CURRENT" != "$BRANCH" ]; then
  echo "✗ Branche actuelle : $CURRENT"
  echo "  Branche attendue : $BRANCH"
  exit 1
fi

echo "→ sauvegarde de sécurité : $BACKUP"
git branch "$BACKUP" HEAD

echo "→ récupération de GitHub"
git fetch "$REMOTE" "$BRANCH"

# Rend les futurs git pull manuels moins surprenants.
git config pull.rebase true
git config rebase.autoStash true

if [ -n "$(git status --porcelain)" ]; then
  echo "→ mise de côté temporaire des fichiers locaux"
  git stash push -u -m "auto-deploy-$STAMP" >/dev/null
  STASHED=1
fi

echo "→ synchronisation avec $REMOTE/$BRANCH"
if ! git rebase "$REMOTE/$BRANCH"; then
  echo "✗ Conflit pendant le rebase : retour à l'état précédent."
  git rebase --abort || true
  if [ "$STASHED" -eq 1 ]; then
    git stash pop || true
  fi
  echo "  Sauvegarde disponible : $BACKUP"
  exit 1
fi

if [ "$STASHED" -eq 1 ]; then
  echo "→ restauration des fichiers locaux"
  if ! git stash pop; then
    echo "✗ Conflit en restaurant les fichiers locaux."
    echo "  Rien n'est déployé. Corrige le conflit puis relance."
    echo "  Sauvegarde disponible : $BACKUP"
    exit 1
  fi
fi

echo "→ déploiement"
sudo bash "$ROOT/deploy/install.sh"

echo
echo "✓ Mise à jour terminée"
echo "  Commit déployé : $(git rev-parse --short HEAD)"
echo "  Sauvegarde locale : $BACKUP"
