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
const CLASSES_OK = ['guerrier', 'mage', 'archer', 'pretre', 'trickster', 'assassin'];
function enregistrerScore(m) {
  const id = String(m.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (id.length < 8) return;
  const nom = filtrer(String(m.n || 'Joueur').replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 16) || 'Joueur';
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

// ---- Modération : bannissements et sourdines par adresse IP, gardés dans moderation.json ----
// Sur Render gratuit, ce fichier est effacé au redémarrage : les bannissements repartent alors de zéro.
const FICHIER_MODO = path.join(__dirname, 'moderation.json');
let modo = { bans: {}, mutes: {} };
try { const m = JSON.parse(fs.readFileSync(FICHIER_MODO, 'utf8')); modo = { bans: m.bans || {}, mutes: m.mutes || {} }; } catch { /* pas encore de fichier */ }
function sauverModo() { fs.writeFile(FICHIER_MODO, JSON.stringify(modo), () => {}); }
function ipDe(req) {
  // Derrière le proxy de Render, la vraie adresse est la dernière de x-forwarded-for
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return (xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}
const masquer = ip => ip.includes('.') ? ip.split('.').slice(0, 2).join('.') + '.•.•' : ip.slice(0, 9) + '…';

// ---- Filtre de langage (même liste que dans le jeu) ----
const MOTS_RACINES = ['connard', 'connass', 'salope', 'salaud', 'putain', 'encul', 'batard', 'merde', 'couill', 'tapette', 'gouine', 'negre', 'negro', 'bougnoul', 'youpin', 'bicot', 'abruti', 'cretin', 'gogol', 'attarde', 'branleu', 'suceu', 'fuck', 'shit', 'bitch', 'asshole', 'nigg', 'fagg', 'whore'];
const MOTS_EXACTS = ['con', 'conne', 'cons', 'pute', 'putes', 'fdp', 'ntm', 'tg', 'pd', 'pede', 'pedes', 'bite', 'chier', 'debile', 'mongol', 'nique', 'niquer', 'niquez', 'nik', 'salop', 'retard', 'dick', 'cunt'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '€': 'e' };
function normaliser(m) { return m.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[013457@$€]/g, c => LEET[c]).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1'); }
const RACINES_N = MOTS_RACINES.map(normaliser), EXACTS_N = MOTS_EXACTS.map(normaliser);
function filtrer(txt) {
  return String(txt).replace(/[^\s.,;:!?'"()|\-_/]+/g, mot => {
    const n = normaliser(mot);
    if (!n) return mot;
    if (EXACTS_N.includes(n) || RACINES_N.some(r => n.includes(r))) return '*'.repeat(mot.length);
    return mot;
  });
}

function envoyer(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function diffuser(salle, msg, sauf) {
  const txt = JSON.stringify(msg);
  for (const j of salle.values()) if (j !== sauf && j.ws.readyState === 1) j.ws.send(txt);
}

wss.on('connection', (ws, req) => {
  const ip = ipDe(req);
  if (modo.bans[ip]) { ws.close(4003, 'Banni'); return; }
  const params = new URL(req.url, 'http://local').searchParams;
  const nom = (params.get('salle') || 'principal').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'principal';
  let salle = salles.get(nom);
  if (!salle) { salle = new Map(); salles.set(nom, salle); }
  if (salle.size >= MAX_JOUEURS_PAR_SALLE) { ws.close(4001, 'Salle pleine'); return; }

  const peer = crypto.randomBytes(6).toString('hex');
  const moi = { ws, peer, ip, etat: {}, vivant: true, msgs: 0 };
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
    // Échanges entre joueurs : relayés uniquement vers un joueur de la même salle
    if (m && m.t === 'tr') {
      const cible = salle.get(String(m.to || ''));
      if (!cible || cible === moi) return;
      const out = { t: 'tr', from: peer, k: String(m.k || '').slice(0, 10) };
      if (m.ok !== undefined) out.ok = !!m.ok;
      if (typeof m.h === 'string') out.h = m.h.slice(0, 64);
      if (Array.isArray(m.items)) out.items = m.items.slice(0, 8);
      if (JSON.stringify(out).length > 8000) return;
      envoyer(cible.ws, out);
      return;
    }
    if (m && m.t === 'dev') {
      const res = (ok, msg, extra) => envoyer(ws, Object.assign({ t: 'devres', ok, msg }, extra || {}));
      if (cyrb53(String(m.pw || '')) !== DEV_HASH) { res(false, 'Mot de passe refusé par le serveur'); return; }
      const cmd = String(m.cmd || '');
      if (cmd === 'bans') { res(true, '', { bans: Object.entries(modo.bans).map(([ip, b]) => ({ id: ip, ip: masquer(ip), n: b.n, t: b.t })) }); return; }
      if (cmd === 'unban') { const id = String(m.to || ''); if (!modo.bans[id]) { res(false, 'Déjà débanni'); return; } const n = modo.bans[id].n; delete modo.bans[id]; sauverModo(); res(true, n + ' est débanni', { bans: Object.entries(modo.bans).map(([ip, b]) => ({ id: ip, ip: masquer(ip), n: b.n, t: b.t })) }); console.log(`[modo] débanni ${n}`); return; }
      if (cmd === 'infos') { const out = []; for (const s of salles.values()) for (const j of s.values()) out.push({ peer: j.peer, muet: !!modo.mutes[j.ip] }); res(true, '', { infos: out }); return; }
      const cible = trouverJoueur(String(m.to || ''));
      if (!cible) { res(false, 'Joueur introuvable (déconnecté ?)'); return; }
      const nom = String((cible.etat && cible.etat.n) || 'Joueur').slice(0, 16);
      if (cmd === 'item') {
        const it = m.arg;
        if (!it || typeof it !== 'object' || JSON.stringify(it).length > 2000) { res(false, 'Objet invalide'); return; }
        envoyer(cible.ws, { t: 'dev', cmd: 'item', arg: it });
        res(true, String(it.name || 'Objet').slice(0, 40) + ' envoyé à ' + nom);
      } else if (cmd === 'god' || cmd === 'cursite') {
        const arg = cmd === 'god' ? (m.arg ? 1 : 0) : Math.max(0, Math.min(1000000, Math.floor(Number(m.arg) || 0)));
        envoyer(cible.ws, { t: 'dev', cmd, arg });
        res(true, cmd === 'god' ? (arg ? 'GOD donné à ' : 'GOD retiré à ') + nom : arg + ' Cursite envoyée à ' + nom);
      } else if (cmd === 'mute' || cmd === 'unmute') {
        if (cmd === 'mute') modo.mutes[cible.ip] = { n: nom, t: Date.now() }; else delete modo.mutes[cible.ip];
        sauverModo(); envoyer(cible.ws, { t: 'dev', cmd, arg: 0 });
        res(true, nom + (cmd === 'mute' ? ' ne peut plus écrire dans le chat' : ' peut de nouveau écrire'));
      } else if (cmd === 'kick' || cmd === 'ban') {
        if (cible.ws === ws) { res(false, 'Tu ne peux pas te viser toi-même'); return; }
        if (cmd === 'ban') {
          if (cible.ip === moi.ip) { res(false, 'Ce joueur a la même adresse IP que toi : bannissement annulé'); return; }
          modo.bans[cible.ip] = { n: nom, t: Date.now() }; sauverModo();
          // tous les joueurs connectés depuis cette adresse partent
          for (const s of salles.values()) for (const j of s.values()) if (j.ip === cible.ip) { envoyer(j.ws, { t: 'dev', cmd: 'ban', arg: 0 }); setTimeout(() => j.ws.close(4003, 'Banni'), 150); }
        } else { envoyer(cible.ws, { t: 'dev', cmd: 'kick', arg: 0 }); setTimeout(() => cible.ws.close(4002, 'Expulsé'), 150); }
        res(true, nom + (cmd === 'ban' ? ' est banni' : ' est expulsé'));
      } else { res(false, 'Commande inconnue'); return; }
      console.log(`[admin] ${cmd} -> ${nom}`);
      return;
    }
    if (!m || m.t !== 'p' || !m.patch || typeof m.patch !== 'object' || Array.isArray(m.patch)) return;
    for (const k of Object.keys(m.patch).slice(0, 40)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) continue;
      let v = m.patch[k];
      if (k === 'm' && typeof v === 'string') { if (modo.mutes[moi.ip]) { if (!moi.averti) { moi.averti = true; envoyer(ws, { t: 'dev', cmd: 'mute', arg: 0 }); } continue; } v = filtrer(v).slice(0, 140); }
      if (k === 'n' && typeof v === 'string') v = filtrer(v).slice(0, 16);
      if (v === null) delete moi.etat[k]; else moi.etat[k] = v;
    }
    if (!modo.mutes[moi.ip]) moi.averti = false;
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
