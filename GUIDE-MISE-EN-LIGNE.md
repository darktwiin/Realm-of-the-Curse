# Royaume Maudit — mise en ligne sur un serveur à toi + lanceur .exe

Ce guide part de zéro. Compte environ 1 h la première fois, puis plus rien à faire : chaque envoi sur GitHub met le jeu à jour tout seul.

> ⚠️ **Ne mets pas cette version sur Render gratuit.** Les comptes et les sauvegardes sont maintenant dans une base de données sur le disque du serveur, et le disque de Render gratuit est effacé à chaque redémarrage : tout le monde perdrait sa progression. Garde l'ancienne version sur Render le temps d'installer le VPS.

---

## Ce qui change avec cette version

- **Comptes joueurs** : au lancement, chacun crée un compte (nom + mot de passe) ou se connecte. Toute la progression est enregistrée sur le serveur. On la retrouve sur n'importe quel PC ou navigateur, et un compte ne peut être connecté qu'à un seul endroit à la fois.
- **Admin lié à ton compte** : `/god` marche seulement pour les comptes listés dans `ADMIN_COMPTES` (ton nom de compte). L'ancien mot de passe ne sert plus à rien en ligne. Tape `/god` pour activer le mode admin, `/god off` pour le couper.
- **Migration** : la première fois qu'un testeur se connecte sur son navigateur habituel, sa sauvegarde locale actuelle part sur son compte. Il ne perd rien.

---

## Étape 1 — Louer un VPS (4 à 8 €/mois)

1. Crée un compte chez **Hetzner Cloud** (le moins cher, serveurs en Allemagne et en Finlande) ou chez **OVHcloud** (serveurs en France).
2. Crée un serveur :
   - Hetzner : un modèle **CX22/CX23** (2 vCPU, 4 Go de RAM), soit environ 4 à 5 €/mois.
   - OVH : un **VPS-1**.
   - Système : **Ubuntu 24.04**. Emplacement : le plus proche de tes joueurs.
3. **Clé SSH** (pour te connecter sans mot de passe). Sur ton PC Windows, ouvre **PowerShell** et tape :
   ```
   ssh-keygen -t ed25519
   ```
   Appuie sur Entrée à chaque question. Affiche ensuite ta clé publique :
   ```
   type $env:USERPROFILE\.ssh\id_ed25519.pub
   ```
   Copie la ligne entière (elle commence par `ssh-ed25519`) et colle-la dans le champ « SSH key » quand tu crées le serveur.
4. Note l'**adresse IP** du serveur (par exemple `95.217.12.34`).

## Étape 2 — Une adresse pour le jeu

Deux possibilités :

- **Gratuit, tout de suite** : utilise `sslip.io`. Si ton IP est `95.217.12.34`, ton adresse sera **`95-217-12-34.sslip.io`**. Elle marche immédiatement, avec HTTPS.
- **Plus pro, environ 5 à 12 €/an** : achète un nom de domaine (OVH, Gandi, Cloudflare…), par exemple `royaumemaudit.fr`. Dans sa zone DNS, crée un enregistrement **A** `jeu` → l'IP du VPS. Ton adresse sera `jeu.royaumemaudit.fr`.

Tu peux commencer avec sslip.io et passer à un vrai domaine plus tard. Dans ce cas, envoie-moi le nouveau domaine pour que je recompile le lanceur.

## Étape 3 — Mettre le code sur GitHub

Remplace le contenu de ton dépôt par le contenu du zip `royaume-maudit-serveur.zip` (fichiers et dossiers `deploy/` et `.github/` compris), puis envoie-le sur GitHub.

> Si ton dépôt est **privé**, le VPS ne pourra pas le télécharger. Le plus simple pour commencer est de le passer en **public** (Settings → Danger Zone → Change visibility). Sinon, dis-le-moi et je t'explique les clés de déploiement.

## Étape 4 — Installer le serveur (une seule commande)

Dans PowerShell :
```
ssh ubuntu@95.217.12.34
```
(Chez OVH l'utilisateur s'appelle `ubuntu` ; chez Hetzner c'est `root`.) Tape `yes` la première fois. Une fois connecté au VPS, lance (en remplaçant les 3 valeurs) :
```
curl -fsSL https://raw.githubusercontent.com/TON-PSEUDO-GITHUB/TON-DEPOT/main/deploy/installer-serveur.sh -o installer.sh
sudo bash installer.sh https://github.com/TON-PSEUDO-GITHUB/TON-DEPOT.git 95-217-12-34.sslip.io Mano
```
- 1er paramètre : l'adresse de ton dépôt GitHub.
- 2e paramètre : ton adresse de l'étape 2.
- 3e paramètre : **le nom de compte que tu vas créer dans le jeu** (c'est lui qui sera admin).

Le script installe tout : Node.js, le jeu en service qui redémarre tout seul, HTTPS, le pare-feu et une sauvegarde automatique chaque nuit. À la fin, il affiche « Terminé ! ».

Ouvre ensuite `https://95-217-12-34.sslip.io` dans ton navigateur et **crée ton compte avec exactement le nom donné en 3e paramètre**. Choisis un vrai mot de passe. Tape `/god` dans le chat : le mode admin s'active.

Commandes utiles sur le VPS :
- `journalctl -u royaume -f` : voir ce qui se passe en direct (Ctrl+C pour quitter).
- `systemctl restart royaume` : redémarrer le jeu.

## Étape 5 — Mises à jour automatiques depuis GitHub

Le but : tu envoies un changement sur GitHub et, 30 secondes plus tard, il est en ligne. Les joueurs sont reconnectés tout seuls.

1. **Sur ton PC**, crée une clé réservée à GitHub :
   ```
   ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\deploiement_royaume -N '""'
   ```
2. **Autorise cette clé sur le VPS** : affiche la clé publique avec
   ```
   type $env:USERPROFILE\.ssh\deploiement_royaume.pub
   ```
   puis, sur le VPS (connecté en ssh), tape (en collant la ligne copiée entre les guillemets) :
   ```
   echo "COLLE-ICI-LA-LIGNE-ssh-ed25519" >> ~/.ssh/authorized_keys
   ```
3. **Dans GitHub**, ouvre ton dépôt → **Settings → Secrets and variables → Actions → New repository secret** et crée :
   - `VPS_HOTE` : l'IP du VPS ;
   - `VPS_UTILISATEUR` : `ubuntu` chez OVH (inutile de le créer chez OVH, c'est la valeur par défaut ; mets `root` chez Hetzner) ;
   - `VPS_CLE` : le contenu complet de la **clé privée**. Affiche-la avec `type $env:USERPROFILE\.ssh\deploiement_royaume` et copie tout, lignes BEGIN et END comprises.
4. C'est tout. À chaque envoi sur la branche `main`, l'onglet **Actions** de GitHub montre la mise en ligne. Une coche verte veut dire que c'est en ligne.

> Tu peux aussi mettre à jour à la main : connecte-toi au VPS et tape `sudo bash /opt/royaume/deploy/mettre-a-jour.sh`.

## Étape 6 — Le lanceur .exe

Le lanceur est une petite application Windows qui ouvre le jeu dans sa propre fenêtre (sans navigateur). Il charge le jeu depuis ton serveur à chaque lancement : **tes mises à jour arrivent chez les joueurs sans qu'ils réinstallent quoi que ce soit.**

- **Envoie-moi ton adresse définitive** (étape 2). Je recompile alors `RoyaumeMaudit-Portable.exe` avec cette adresse, et c'est ce fichier que tu donnes à tes joueurs (Discord, Google Drive, itch.io…).
- **Pour tester avant**, avec le .exe que je t'ai envoyé : mets à côté de lui un fichier texte nommé `serveur.txt` qui contient ton adresse complète, par exemple `https://95-217-12-34.sslip.io`.
- **Touches du lanceur** : **F11** pour le plein écran, **F5** pour recharger le jeu (dernière version).
- **Avertissement Windows « Windows a protégé votre ordinateur »** : c'est normal pour un .exe non signé. Clique sur « Informations complémentaires », puis « Exécuter quand même ». Le faire disparaître demande un certificat de signature de code (une centaine d'euros par an ou plus). On en reparlera au moment de Steam.
- **Le compiler toi-même (facultatif)** :
  1. Installe Node.js 22 (nodejs.org) et dézippe `royaume-maudit-lanceur.zip`.
  2. Mets ton adresse dans `config.json`.
  3. Dans le dossier, lance `npm install` puis `npm run dist`.
  4. Les .exe (version portable et version installateur) sont dans `dist/`.

Le jeu reste aussi jouable dans un navigateur à la même adresse, avec le même compte et la même progression.

## Étape 7 — Sauvegardes

- Une copie de la base de données est faite **chaque nuit à 4 h** dans `/var/lib/royaume/sauvegardes/`. Les 14 dernières sont gardées.
- Pour en faire une tout de suite : `cd /opt/royaume && DATA_DIR=/var/lib/royaume node deploy/sauvegarde.js`.
- Pour en restaurer une :
  ```
  systemctl stop royaume
  cp /var/lib/royaume/sauvegardes/jeu-AAAA-MM-JJ-HH-MM.db /var/lib/royaume/jeu.db
  rm -f /var/lib/royaume/jeu.db-wal /var/lib/royaume/jeu.db-shm
  systemctl start royaume
  ```
- Conseil : récupère de temps en temps une copie sur ton PC (avec WinSCP, par exemple) au cas où le VPS aurait un problème.

---

## La suite : le serveur autoritaire (anti-triche niveau 3)

Aujourd'hui, la progression est **gardée** sur le serveur, mais c'est encore le jeu du joueur qui **décide** du butin, des dégâts et de l'XP. Un tricheur motivé peut donc encore mentir au serveur. Les prochaines étapes passent cette logique côté serveur, une partie à la fois, en gardant le jeu jouable entre chaque étape :

1. ✅ **Économie** (ver.0.0.13) : chaque sauvegarde est vérifiée par l'arbitre (`arbitre.js`). Toute modification incohérente est refusée.
2. ✅ **Butin et XP** (ver.0.0.14) : le serveur tire le butin, l'XP et les pièces à la mort de chaque monstre (`butin.js`) et refuse tout ce qu'il n'a pas donné.
3. ✅ **Plaines Sauvages** (ver.0.0.15) : le Gardien (`gardien.js`), une copie du jeu sans affichage lancée par le serveur, est l'hôte permanent des Plaines. Il décide de la mort des monstres et plafonne les dégâts des joueurs. Reste à faire : vérifier les dégâts que les joueurs *reçoivent*.
4. **Donjons et raid** : même chose pour chaque donjon et pour le Dragon.
5. **Plusieurs serveurs** au choix (« Europe 1 », « Europe 2 »…) quand il y aura du monde.
