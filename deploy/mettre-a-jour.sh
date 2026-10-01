#!/usr/bin/env bash
# Récupère la dernière version depuis GitHub et redémarre le jeu (quelques secondes de coupure, les joueurs se reconnectent tout seuls).
set -euo pipefail
cd /opt/royaume
sudo -u royaume git pull --ff-only
sudo -u royaume npm ci --omit=dev
sudo systemctl restart royaume
echo "Mise à jour faite : $(git log -1 --format='%h %s')"
