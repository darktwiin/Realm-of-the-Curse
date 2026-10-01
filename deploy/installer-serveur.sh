#!/usr/bin/env bash
# Installation du serveur Royaume Maudit sur un VPS Ubuntu 24.04 (à lancer une seule fois, en root).
# Usage : bash installer-serveur.sh <URL du dépôt GitHub> <nom de domaine> <ton nom de compte admin>
# Exemple : bash installer-serveur.sh https://github.com/mano/royaume-maudit-serveur.git jeu.royaumemaudit.fr Mano
set -euo pipefail
REPO="${1:?URL du dépôt GitHub manquante}"; DOMAINE="${2:?nom de domaine manquant}"; ADMIN="${3:?nom du compte admin manquant}"
APP=/opt/royaume; DATA=/var/lib/royaume; USER_APP=royaume

echo "== Mises à jour du système"
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git ufw debian-keyring debian-archive-keyring apt-transport-https ca-certificates gnupg

echo "== Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "== Caddy (HTTPS automatique)"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy

echo "== Utilisateur et dossiers"
id -u $USER_APP >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin $USER_APP
mkdir -p $DATA && chown -R $USER_APP:$USER_APP $DATA
if [ ! -d $APP/.git ]; then git clone "$REPO" $APP; fi
chown -R $USER_APP:$USER_APP $APP
cd $APP && sudo -u $USER_APP npm ci --omit=dev

echo "== Service du jeu"
cat > /etc/systemd/system/royaume.service <<UNIT
[Unit]
Description=Serveur Royaume Maudit
After=network.target
[Service]
User=$USER_APP
WorkingDirectory=$APP
Environment=PORT=3000
Environment=DATA_DIR=$DATA
Environment=ADMIN_COMPTES=$ADMIN
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now royaume

echo "== HTTPS avec Caddy"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAINE {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl reload caddy

echo "== Pare-feu"
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

echo "== Sauvegarde automatique chaque nuit (4 h)"
echo "0 4 * * * $USER_APP cd $APP && DATA_DIR=$DATA /usr/bin/node --disable-warning=ExperimentalWarning deploy/sauvegarde.js >> $DATA/sauvegarde.log 2>&1" > /etc/cron.d/royaume-sauvegarde

echo "== Droit de redémarrer le jeu pour les mises à jour automatiques"
echo "$USER_APP ALL=(root) NOPASSWD: /bin/systemctl restart royaume" > /etc/sudoers.d/royaume && chmod 440 /etc/sudoers.d/royaume

echo
echo "Terminé ! Le jeu tourne sur https://$DOMAINE"
echo "Journal du serveur : journalctl -u royaume -f"
