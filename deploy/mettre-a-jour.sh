#!/usr/bin/env bash
# Récupère la dernière version depuis GitHub et redémarre le jeu (quelques secondes de coupure, les joueurs se reconnectent tout seuls).
set -euo pipefail
cd /opt/royaume
sudo -u royaume git pull --ff-only
sudo -u royaume npm ci --omit=dev
# Prévient les joueurs : compte à rebours à l'écran (30 s par défaut), puis redémarrage.
DELAI="${DELAI_MAJ:-30}"
if sudo -u royaume env DATA_DIR=/var/lib/royaume node deploy/annoncer.js "$DELAI"; then
  sleep $((DELAI + 2))
fi
sudo systemctl restart royaume
echo "Mise à jour faite : $(git log -1 --format='%h %s')"
