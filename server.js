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

// ---- Guildes : sauvegardées dans guildes.json (effacé au redémarrage sur Render gratuit, comme le classement) ----
const FICHIER_GUILDES = path.join(__dirname, 'guildes.json');
let guildes = {};
try { guildes = JSON.parse(fs.readFileSync(FICHIER_GUILDES, 'utf8')) || {}; } catch { guildes = {}; }
let guildesModif = false;
setInterval(() => { if (!guildesModif) return; guildesModif = false; fs.writeFile(FICHIER_GUILDES, JSON.stringify(guildes), () => {}); }, 5000);
const invitesGuilde = new Map(); // peer invité -> { gid, t }
// ---- Raid de guilde : le Dragon apparaît 10 minutes (lancé par un admin), il est invulnérable et compte les dégâts de chaque guilde ----
const FICHIER_RAID = path.join(__dirname, 'raid.json');
const RAID_DUREE = 10 * 60 * 1000, RAID_ATTENTE = 30 * 1000; // le portail s'ouvre, le Dragon arrive 30 s plus tard
let raidEv = null; // { id, actif, fin, g: { gid: { dmg, c: { pid: dmg } } }, res: [...], recu: { pid: true } }
try { raidEv = JSON.parse(fs.readFileSync(FICHIER_RAID, 'utf8')); } catch { raidEv = null; }
const sauverRaid = () => fs.writeFile(FICHIER_RAID, JSON.stringify(raidEv), () => {});
const RAID_GAINS = [{ or: 1000, cu: 100, oeufs: 2, cro: 2 }, { or: 700, cu: 70, oeufs: 1, cro: 2 }, { or: 500, cu: 50, oeufs: 1, cro: 1 }, { or: 250, cu: 25, oeufs: 0, cro: 1 }];
const gainRang = r => RAID_GAINS[Math.min(r, 4) - 1];
function classementRaid() {
  if (!raidEv) return [];
  return Object.entries(raidEv.g).map(([gid, x]) => ({ gid, tag: (guildes[gid] || {}).tag || '?', nom: (guildes[gid] || {}).nom || 'Guilde dissoute', dmg: x.dmg, nb: Object.keys(x.c).length })).sort((a, b) => b.dmg - a.dmg);
}
function tousLesSockets() { const out = []; for (const s of salles.values()) for (const j of s.values()) out.push(j); return out; }
function lancerRaid() {
  const spawn = Date.now() + RAID_ATTENTE;
  raidEv = { id: Date.now(), actif: true, spawn, fin: spawn + RAID_DUREE, g: {}, res: null, recu: {} }; sauverRaid();
  for (const j of tousLesSockets()) envoyer(j.ws, { t: 'g', a: 'raidstart', reste: RAID_ATTENTE + RAID_DUREE, spawn: RAID_ATTENTE });
  for (const gid of Object.keys(guildes)) diffuserGuilde(gid, true);
}
function finirRaid() {
  if (!raidEv || !raidEv.actif) return;
  raidEv.actif = false; raidEv.res = classementRaid().map(({ gid, tag, nom, dmg, nb }) => ({ gid, tag, nom, dmg, nb }));
  raidEv.res.forEach((r, i) => { const g = guildes[r.gid]; if (g) { g.niv = (g.niv || 1) + 1; guildesModif = true; } });
  sauverRaid();
  const pub = raidEv.res.slice(0, 10).map(({ tag, nom, dmg, nb }) => ({ tag, nom, dmg, nb }));
  for (const j of tousLesSockets()) envoyer(j.ws, { t: 'g', a: 'raidend', res: pub });
  for (const gid of Object.keys(guildes)) diffuserGuilde(gid, true);
}
setInterval(() => { if (raidEv && raidEv.actif && Date.now() >= raidEv.fin) finirRaid(); }, 1000);
function vueRaid(gid, pid) {
  if (!raidEv) return { actif: false, reste: 0, top: [], guilde: 0, part: 0, dernier: null };
  const x = raidEv.g[gid] || { dmg: 0, c: {} }, cl = raidEv.actif ? classementRaid() : raidEv.res || [];
  const top = cl.slice(0, 5).map(({ tag, nom, dmg }) => ({ tag, nom, dmg }));
  let dernier = null;
  if (!raidEv.actif && raidEv.res) { const i = raidEv.res.findIndex(r => r.gid === gid); dernier = { rang: i >= 0 ? i + 1 : 0, nb: raidEv.res.length, part: x.c[pid] || 0, recu: !!raidEv.recu[pid], gain: i >= 0 ? gainRang(i + 1) : null, top }; }
  return { actif: !!raidEv.actif, reste: raidEv.actif ? Math.max(0, raidEv.fin - Date.now()) : 0, spawn: raidEv.actif ? Math.max(0, (raidEv.spawn || 0) - Date.now()) : 0, top, guilde: x.dmg, part: x.c[pid] || 0, dernier };
}
const cle = pid => cyrb53('m' + pid).slice(0, 8);
function guildeDe(pid) { for (const [gid, g] of Object.entries(guildes)) if (g.membres[pid]) return [gid, g]; return [null, null]; }
function vueGuilde(gid, g, pid) {
  const x = raidEv && raidEv.g[gid] ? raidEv.g[gid].c : {};
  return { id: gid, nom: g.nom, tag: g.tag, niv: g.niv || 1, chef: g.chef === pid,
    membres: Object.entries(g.membres).map(([id, m]) => ({ k: cle(id), n: m.n, c: m.c, l: m.l, chef: id === g.chef, moi: id === pid, dmg: x[id] || 0 })),
    raid: vueRaid(gid, pid) };
}
function socketsDe(pids) { const out = []; for (const s of salles.values()) for (const j of s.values()) if (j.idJoueur && pids.includes(j.idJoueur)) out.push(j); return out; }
const derniereDiffusion = new Map();
function diffuserGuilde(gid, force) {
  const g = guildes[gid]; if (!g) return;
  const now = Date.now(); if (!force && now - (derniereDiffusion.get(gid) || 0) < 900) { if (!derniereDiffusion.has('p' + gid)) { derniereDiffusion.set('p' + gid, 1); setTimeout(() => { derniereDiffusion.delete('p' + gid); diffuserGuilde(gid, true); }, 950); } return; }
  derniereDiffusion.set(gid, now);
  for (const j of socketsDe(Object.keys(g.membres))) envoyer(j.ws, { t: 'g', a: 'info', g: vueGuilde(gid, g, j.idJoueur) });
}
function actionGuilde(moi, salle, m) {
  const pid = String(m.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (pid.length < 8) return;
  moi.idJoueur = pid;
  const rep = (o) => envoyer(moi.ws, Object.assign({ t: 'g' }, o));
  const [gid, g] = guildeDe(pid);
  const infosMembre = () => ({ n: filtrer(String(m.n || 'Joueur').replace(/[\u0000-\u001f]/g, '')).slice(0, 16) || 'Joueur', c: String(m.c || '').slice(0, 12), l: Math.max(1, Math.min(20, Math.floor(Number(m.l) || 1))) });
  const a = String(m.a || '');
  if (a === 'info') { if (g) { g.membres[pid] = infosMembre(); guildesModif = true; rep({ a: 'info', g: vueGuilde(gid, g, pid) }); } else rep({ a: 'info', g: null }); return; }
  if (a === 'create') {
    if (g) { rep({ a: 'err', msg: 'Tu es déjà dans une guilde' }); return; }
    const nom = filtrer(String(m.nom || '').replace(/[^\p{L}\p{N} '\-]/gu, '').trim()).slice(0, 20);
    const tag = String(m.tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (nom.length < 3 || tag.length < 2) { rep({ a: 'err', msg: 'Nom (3 à 20 caractères) et tag (2 à 4 lettres) obligatoires' }); return; }
    if (nom.includes('*') || filtrer(tag).includes('*')) { rep({ a: 'err', msg: 'Ce nom n\'est pas autorisé' }); return; }
    if (Object.values(guildes).some(x => x.nom.toLowerCase() === nom.toLowerCase() || x.tag === tag)) { rep({ a: 'err', msg: 'Ce nom ou ce tag est déjà pris' }); return; }
    const id = crypto.randomBytes(5).toString('hex');
    guildes[id] = { nom, tag, chef: pid, niv: 1, membres: { [pid]: infosMembre() }, cree: Date.now() };
    guildesModif = true; rep({ a: 'created' }); diffuserGuilde(id, true); return;
  }
  if (a === 'invite') {
    if (!g) return;
    const cible = salle.get(String(m.to || ''));
    if (!cible || cible === moi) return;
    if (Object.keys(g.membres).length >= 20) { rep({ a: 'err', msg: 'Guilde complète (20 membres)' }); return; }
    invitesGuilde.set(cible.peer, { gid, t: Date.now() });
    envoyer(cible.ws, { t: 'g', a: 'invite', gid, nom: g.nom, tag: g.tag, from: moi.peer });
    rep({ a: 'ok', msg: 'Invitation de guilde envoyée' }); return;
  }
  if (a === 'join') {
    if (g) { rep({ a: 'err', msg: 'Quitte d\'abord ta guilde actuelle' }); return; }
    const inv = invitesGuilde.get(moi.peer), cg = guildes[String(m.gid || '')];
    if (!inv || inv.gid !== String(m.gid || '') || Date.now() - inv.t > 120000 || !cg) { rep({ a: 'err', msg: 'Invitation expirée' }); return; }
    if (Object.keys(cg.membres).length >= 20) { rep({ a: 'err', msg: 'Guilde complète' }); return; }
    invitesGuilde.delete(moi.peer); cg.membres[pid] = infosMembre(); guildesModif = true; diffuserGuilde(inv.gid, true); return;
  }
  if (!g) return;
  if (a === 'leave') {
    delete g.membres[pid];
    if (!Object.keys(g.membres).length) delete guildes[gid];
    else { if (g.chef === pid) g.chef = Object.keys(g.membres)[0]; diffuserGuilde(gid, true); }
    guildesModif = true; rep({ a: 'info', g: null }); return;
  }
  if (a === 'kick') {
    if (g.chef !== pid) return;
    const cible = Object.keys(g.membres).find(id => cle(id) === String(m.k || ''));
    if (!cible || cible === pid) return;
    delete g.membres[cible]; guildesModif = true;
    for (const j of socketsDe([cible])) envoyer(j.ws, { t: 'g', a: 'info', g: null, msg: 'Tu as été exclu de la guilde' });
    diffuserGuilde(gid, true); return;
  }
  if (a === 'raid') {
    if (!raidEv || !raidEv.actif || Date.now() > raidEv.fin || Date.now() < (raidEv.spawn || 0)) return;
    const dmg = Math.max(0, Math.min(40000, Math.floor(Number(m.dmg) || 0))); if (!dmg) return;
    const x = raidEv.g[gid] || (raidEv.g[gid] = { dmg: 0, c: {} });
    x.dmg += dmg; x.c[pid] = (x.c[pid] || 0) + dmg;
    if (!raidEv.ts || Date.now() - raidEv.ts > 5000) { raidEv.ts = Date.now(); sauverRaid(); }
    diffuserGuilde(gid); return;
  }
  if (a === 'claim') {
    if (!raidEv || raidEv.actif || !raidEv.res) { rep({ a: 'err', msg: 'Pas de récompense de raid pour le moment' }); return; }
    const i = raidEv.res.findIndex(r => r.gid === gid), x = raidEv.g[gid];
    if (i < 0 || !x || !x.c[pid]) { rep({ a: 'err', msg: 'Tu n\'as pas participé au dernier raid' }); return; }
    if (raidEv.recu[pid]) { rep({ a: 'err', msg: 'Récompense déjà récupérée' }); return; }
    raidEv.recu[pid] = true; sauverRaid(); rep({ a: 'reward', rang: i + 1, gain: gainRang(i + 1) }); diffuserGuilde(gid, true); return;
  }
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
    if (m && m.t === 'g') { actionGuilde(moi, salle, m); return; }
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
      if (cmd === 'raid') { lancerRaid(); res(true, 'Raid lancé : portail ouvert, le Dragon arrive dans 30 secondes (10 minutes de combat)'); console.log('[raid] lancé'); return; }
      if (cmd === 'raidstop') { if (!raidEv || !raidEv.actif) { res(false, 'Aucun raid en cours'); return; } finirRaid(); res(true, 'Raid terminé, classement envoyé'); return; }
      if (cmd === 'infos') { const out = []; for (const s of salles.values()) for (const j of s.values()) out.push({ peer: j.peer, muet: !!modo.mutes[j.ip] }); res(true, '', { infos: out }); return; }
      const cible = trouverJoueur(String(m.to || ''));
      if (!cible) { res(false, 'Joueur introuvable (déconnecté ?)'); return; }
      const nom = String((cible.etat && cible.etat.n) || 'Joueur').slice(0, 16);
      if (cmd === 'party') {
        const a = m.arg || {};
        const arg = { c: String(a.c || '').slice(0, 12), sk: String(a.sk || '').slice(0, 12), n: String(a.n || '').slice(0, 16), w: String(a.w || '').slice(0, 12), wt: Math.max(0, Math.min(7, Math.floor(Number(a.wt) || 0))) };
        envoyer(cible.ws, { t: 'dev', cmd: 'party', arg });
        res(true, 'Fête lancée chez ' + nom);
      } else if (cmd === 'kill') {
        envoyer(cible.ws, { t: 'dev', cmd: 'kill', arg: 0 });
        res(true, nom + ' a été tué par un admin');
      } else if (cmd === 'summon') {
        const a = m.arg || {};
        const arg = { s: String(a.s || '').slice(0, 40), x: Number(a.x) || 0, y: Number(a.y) || 0, hs: Math.floor(Number(a.hs) || 0) };
        envoyer(cible.ws, { t: 'dev', cmd: 'summon', arg });
        res(true, nom + ' est téléporté vers toi');
      } else if (cmd === 'item') {
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
