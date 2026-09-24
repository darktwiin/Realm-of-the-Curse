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
