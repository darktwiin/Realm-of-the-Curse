# Royaume Maudit — version multijoueur autonome

Ce dossier contient le jeu (`public/index.html`) et un petit serveur (`server.js`) qui relie les joueurs entre eux.
Tes amis n'ont besoin que d'un lien et d'un navigateur. Pas de compte, rien à installer de leur côté.

```
royaume-maudit-serveur/
├── server.js          le serveur (sert la page + synchronise les joueurs)
├── package.json       la liste des dépendances (juste « ws »)
├── package-lock.json
└── public/
    └── index.html     le jeu
```

Deux façons de jouer : **en ligne avec Render** (tes amis jouent de chez eux), ou **sur ton PC** (amis sur le même Wi-Fi).

---

## Option 1 — En ligne, gratuit, avec Render (recommandé)

Compte environ 15 minutes la première fois.

### 1. Mettre les fichiers sur GitHub
1. Crée un compte sur **github.com** (gratuit).
2. En haut à droite : **+** → **New repository**. Nom : `royaume-maudit`. Laisse-le en **Public**, puis **Create repository**.
3. Sur la page du dépôt vide, clique sur **uploading an existing file**.
4. Glisse-dépose **le contenu** du dossier : `server.js`, `package.json`, `package-lock.json`, `LISEZMOI.md` et le dossier `public` entier.
   Ne mets pas de dossier `node_modules` s'il existe.
5. Clique sur **Commit changes**.

### 2. Lancer le serveur sur Render
1. Va sur **render.com** et inscris-toi avec **ton compte GitHub** (bouton « GitHub »).
2. **New +** → **Web Service** → choisis le dépôt `royaume-maudit` (autorise Render à y accéder si on te le demande).
3. Remplis :
   - **Runtime** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : `Free`
4. **Create Web Service**. Attends 2–3 minutes que le journal affiche `Royaume Maudit en ligne`.
5. Ton adresse apparaît en haut, du genre `https://royaume-maudit-xxxx.onrender.com`. **C'est le lien à envoyer à tes amis.**

### Bon à savoir
- **Mise en veille** : l'offre gratuite endort le serveur après 15 minutes sans joueur. Le premier qui ouvre le lien attend environ une minute (la liste des joueurs affiche « Connexion au serveur… »), puis tout repart.
- **Mettre le jeu à jour** : remplace `public/index.html` sur GitHub (Add file → Upload files). Render redéploie tout seul en 1 à 2 minutes. Rechargez la page.
- **Salles séparées** : ajoute `?salle=nom` à la fin du lien (ex. `https://…onrender.com/?salle=vendredi`). Seuls ceux qui ont le même nom de salle jouent ensemble. Sans rien, tout le monde est dans la salle « principal ».

---

## Option 2 — Sur ton PC (même Wi-Fi)

1. Installe **Node.js** (version LTS) depuis **nodejs.org**.
2. Décompresse le dossier, puis ouvre un terminal dedans
   (Windows : dans l'Explorateur, clic droit dans le dossier → « Ouvrir dans le Terminal »).
3. Tape, une seule fois :
   ```
   npm install
   ```
4. Puis, à chaque partie :
   ```
   npm start
   ```
5. Ouvre **http://localhost:3000** dans ton navigateur.
6. Pour tes amis sur le même Wi-Fi : trouve l'adresse IP de ton PC (Windows : tape `ipconfig`, ligne « Adresse IPv4 », par ex. `192.168.1.24`) et donne-leur **http://192.168.1.24:3000**.
   Si Windows demande d'autoriser Node.js dans le pare-feu, accepte pour les réseaux privés.
7. Pour arrêter : `Ctrl + C` dans le terminal.

---

## Comment marche le multijoueur

- Le serveur relaie l'état de chaque joueur (position, classe, niveau, tirs, chat) à tous les autres, environ 15 fois par seconde.
- **Les monstres** sont simulés par le navigateur du premier joueur entré dans le Royaume (marqué ★ dans la liste des joueurs), qui envoie leur position aux autres.
  S'il quitte le Royaume, ferme l'onglet ou le laisse en arrière-plan, un autre joueur prend le relais automatiquement.
- **Les dégâts** de chaque joueur sont additionnés sur les monstres.
- **L'XP** va à tous ceux qui ont touché le monstre ou qui étaient à moins de 12 cases.
- **Le butin** est personnel : chacun voit ses propres sacs.
- **La sauvegarde** (niveau, équipement) reste dans le navigateur de chaque joueur.
- Jusqu'à 16 joueurs par salle.

## Problèmes fréquents

| Ce que tu vois | Solution |
|---|---|
| « Page ouverte sans serveur : tu joues en solo » | Tu as ouvert `index.html` directement. Ouvre l'adresse du serveur (`http://localhost:3000` ou le lien Render). |
| « Connexion… » qui ne passe pas à « En ligne » | Serveur en veille (Render gratuit) : patiente une minute. Sinon, vérifie que `npm start` tourne toujours. |
| Vous êtes connectés mais ne vous voyez pas | Vérifiez que vous êtes dans la même salle (même `?salle=`) et au même endroit : le Nexus et le Royaume sont séparés. |
| Les monstres saccadent | Le joueur ★ a une connexion lente ou un PC chargé. Il peut repasser par le Nexus (R) pour laisser la place à un autre. |
