// Royaume Maudit — serveur multijoueur
// Sert la page du jeu et relaie l'état de chaque joueur (position, classe, monstres de l'hôte…)
// à tous les autres joueurs de la même salle, en temps réel, via WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_JOUEURS_PAR_SALLE = 16;
const MAX_OCTETS_ETAT = 8192;

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// ---- Classement : scores des joueurs, sauvegardés dans classement.json ----
// Sur Render gratuit, ce fichier est effacé à chaque redémarrage du serveur (disque non permanent).
const FICHIER_SCORES = path.join(__dirname, 'classement.json');
let scores = {};
try { scores = JSON.parse(fs.readFileSync(FICHIER_SCORES, 'utf8')) || {}; } catch { scores = {}; }
let scoresModifies = false;
const entier = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const CLASSES_OK = ['guerrier', 'mage', 'archer', 'pretre'];
function enregistrerScore(m) {
  const id = String(m.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (id.length < 8) return;
  const nom = String(m.n || 'Joueur').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 16) || 'Joueur';
  scores[id] = {
    n: nom, c: CLASSES_OK.includes(m.c) ? m.c : 'guerrier', l: entier(m.l, 20),
    gold: entier(m.gold, 1e9), pres: entier(m.pres, 1e9), kills: entier(m.kills, 1e9),
    shots: entier(m.shots, 1e10), hits: Math.min(entier(m.hits, 1e10), entier(m.shots, 1e10)),
    t: Date.now()
  };
  scoresModifies = true;
}
function top(demandeur) {
  const liste = Object.entries(scores);
  const ligne = (id, s, v) => ({ n: s.n, c: s.c, l: s.l, v, moi: id === demandeur });
  const tri = (f, filtre) => liste.filter(([, s]) => !filtre || filtre(s)).map(([id, s]) => ligne(id, s, f(s))).sort((a, b) => b.v - a.v).slice(0, 20);
  return {
    t: 'top',
    or: tri(s => s.gold),
    prestige: tri(s => s.pres),
    precision: tri(s => Math.round(s.hits / s.shots * 1000) / 10, s => s.shots >= 300),
    kills: tri(s => s.kills)
  };
}
setInterval(() => {
  if (!scoresModifies) return;
  scoresModifies = false;
  fs.writeFile(FICHIER_SCORES, JSON.stringify(scores), () => {});
}, 30000);

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(INDEX);
  } else if (url === '/sante') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Introuvable');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const salles = new Map(); // nom de salle -> Map(peer -> joueur)

// ---- Commandes développeur : vérifiées ici, jamais par le navigateur du joueur visé ----
function cyrb53(str, seed = 7) { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); }
const DEV_HASH = '2858b4huwnf';
function trouverJoueur(peer) { for (const s of salles.values()) { const j = s.get(peer); if (j) return j; } return null; }

function envoyer(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function diffuser(salle, msg, sauf) {
  const txt = JSON.stringify(msg);
  for (const j of salle.values()) if (j !== sauf && j.ws.readyState === 1) j.ws.send(txt);
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://local').searchParams;
  const nom = (params.get('salle') || 'principal').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'principal';
  let salle = salles.get(nom);
  if (!salle) { salle = new Map(); salles.set(nom, salle); }
  if (salle.size >= MAX_JOUEURS_PAR_SALLE) { ws.close(4001, 'Salle pleine'); return; }

  const peer = crypto.randomBytes(6).toString('hex');
  const moi = { ws, peer, etat: {}, vivant: true, msgs: 0 };
  salle.set(peer, moi);
  console.log(`[${nom}] connexion ${peer} (${salle.size} joueur(s))`);

  envoyer(ws, {
    t: 'hello', peer, salle: nom,
    peers: [...salle.values()].filter(j => j !== moi).map(j => ({ peer: j.peer, presence: j.etat }))
  });
  diffuser(salle, { t: 'join', peer }, moi);

  ws.on('message', data => {
    if (++moi.msgs > 60) return; // plus de 60 messages/seconde : ignorés
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && m.t === 'score') { enregistrerScore(m); moi.idJoueur = String(m.id || ''); return; }
    if (m && m.t === 'top') { envoyer(ws, top(moi.idJoueur || String(m.id || ''))); return; }
    if (m && m.t === 'dev') {
      if (cyrb53(String(m.pw || '')) !== DEV_HASH) { envoyer(ws, { t: 'devres', ok: false, msg: 'Mot de passe refusé par le serveur' }); return; }
      const cible = trouverJoueur(String(m.to || ''));
      const cmd = m.cmd === 'god' ? 'god' : m.cmd === 'cursite' ? 'cursite' : null;
      if (!cible || !cmd) { envoyer(ws, { t: 'devres', ok: false, msg: 'Joueur introuvable (déconnecté ?)' }); return; }
      const arg = cmd === 'god' ? (m.arg ? 1 : 0) : Math.max(0, Math.min(1000000, Math.floor(Number(m.arg) || 0)));
      envoyer(cible.ws, { t: 'dev', cmd, arg });
      envoyer(ws, { t: 'devres', ok: true, msg: cmd === 'god' ? (arg ? 'GOD donné' : 'GOD retiré') : arg + ' Cursite envoyée' });
      console.log(`[dev] ${cmd} ${arg} -> ${cible.peer}`);
      return;
    }
    if (!m || m.t !== 'p' || !m.patch || typeof m.patch !== 'object' || Array.isArray(m.patch)) return;
    for (const k of Object.keys(m.patch).slice(0, 40)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) continue;
      const v = m.patch[k];
      if (v === null) delete moi.etat[k]; else moi.etat[k] = v;
    }
    if (JSON.stringify(moi.etat).length > MAX_OCTETS_ETAT) moi.etat = {};
    diffuser(salle, { t: 'p', peer, presence: moi.etat }, moi);
  });

  ws.on('pong', () => { moi.vivant = true; });
  ws.on('close', () => {
    salle.delete(peer);
    diffuser(salle, { t: 'leave', peer });
    console.log(`[${nom}] départ ${peer} (${salle.size} joueur(s))`);
    if (!salle.size) salles.delete(nom);
  });
});

// Compteur anti-spam remis à zéro chaque seconde
setInterval(() => { for (const s of salles.values()) for (const j of s.values()) j.msgs = 0; }, 1000);
// Déconnecte les joueurs qui ne répondent plus
setInterval(() => {
  for (const s of salles.values()) for (const j of s.values()) {
    if (!j.vivant) { j.ws.terminate(); continue; }
    j.vivant = false;
    try { j.ws.ping(); } catch { /* ignoré */ }
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`Royaume Maudit en ligne sur http://localhost:${PORT}`);
});
