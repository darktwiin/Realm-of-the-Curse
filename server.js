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
const MAX_MEMBRES_GUILDE = 3; // compétition de raid à 3 (les guildes déjà plus grandes gardent leurs membres mais ne recrutent plus)
// Les serveurs proposés par le Passeur des mondes (PNJ du Village) : une salle chacun, sur la même machine
const SERVEURS = [['principal', 'Roi Bouffon'], ['leviathan', 'Léviathan'], ['devoreur', "Dévoreur d'Étoiles"]];
const SERVEURS_IDS = new Set(SERVEURS.map(s => s[0]));
const MAX_OCTETS_ETAT = 8192;

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
// graine du Royaume : une nouvelle carte à chaque lancement du serveur, la même pour tous les joueurs
const REALM_SEED = 1 + Math.floor(Math.random() * 999999999);

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
    n: nom, c: CLASSES_OK.includes(m.c) ? m.c : 'guerrier', l: entier(m.l, 25),
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
  } else if (url === '/__annonce' && req.method === 'POST') {
    // appelé par deploy/annoncer.js juste avant un redémarrage : compte à rebours chez tous les joueurs
    const q = new URL(req.url, 'http://local').searchParams;
    if (!req.headers['x-forwarded-for'] && q.get('cle') === CLE_ANNONCE) { const sec = Math.max(5, Math.min(300, Math.floor(Number(q.get('s')) || 30))); annoncerMaj(sec); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok ' + sec); }
    else { res.writeHead(403); res.end('non'); }
  } else if (url === '/sante') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Introuvable');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
const salles = new Map(); // nom de salle -> Map(peer -> joueur)

// ---- Commandes développeur : vérifiées ici, jamais par le navigateur du joueur visé ----
function cyrb53(str, seed = 7) { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); }
// ---- Comptes joueurs (base SQLite intégrée à Node 22) ----
// Les admins sont désignés par la variable d'environnement ADMIN_COMPTES (noms de comptes séparés par des virgules).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(DATA_DIR, 'jeu.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS comptes (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL UNIQUE COLLATE NOCASE, sel TEXT NOT NULL, hash TEXT NOT NULL, cree INTEGER NOT NULL, vu INTEGER, save TEXT, maj INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, compte INTEGER NOT NULL, cree INTEGER NOT NULL);`);
const ADMINS = new Set(String(process.env.ADMIN_COMPTES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const sql = {
  parNom: db.prepare('SELECT * FROM comptes WHERE nom = ?'),
  parId: db.prepare('SELECT * FROM comptes WHERE id = ?'),
  creer: db.prepare('INSERT INTO comptes (nom, sel, hash, cree) VALUES (?, ?, ?, ?)'),
  vu: db.prepare('UPDATE comptes SET vu = ? WHERE id = ?'),
  save: db.prepare('UPDATE comptes SET save = ?, maj = ? WHERE id = ?'),
  sessIns: db.prepare('INSERT INTO sessions (token, compte, cree) VALUES (?, ?, ?)'),
  sessGet: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  sessDel: db.prepare('DELETE FROM sessions WHERE token = ?'),
  sessVieilles: db.prepare('DELETE FROM sessions WHERE cree < ?'),
};
const arbitre = require('./arbitre');
const butin = require('./butin');
db.exec(`CREATE TABLE IF NOT EXISTS anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, compte INTEGER, nom TEXT, quand INTEGER, raisons TEXT)`);
sql.anoIns = db.prepare('INSERT INTO anomalies (compte, nom, quand, raisons) VALUES (?, ?, ?, ?)');
sql.anoListe = db.prepare('SELECT nom, quand, raisons FROM anomalies ORDER BY id DESC LIMIT 60');
for (const r of db.prepare('SELECT save FROM comptes WHERE save IS NOT NULL').all()) { try { arbitre.apprendre(JSON.parse(r.save)); } catch {} }
const DONS0 = () => ({ cursite: 0, or: 0, prestige: 0, objets: 0, xp: 0, kills: 0, boss: 0, liste: {} });
// état anti-triche par compte (survit aux reconnexions tant que le serveur tourne)
const etatsComptes = new Map();
function etatCompte(id) { let e = etatsComptes.get(id); if (!e) { e = { dons: DONS0(), seaux: arbitre.nouveauxSeaux(), rythme: {}, aPerdre: [] }; etatsComptes.set(id, e); } return e; }
// retire n exemplaires d'un objet (sac d'abord, puis coffres, puis équipement)
function retirerObjets(save, sig, n) {
  const zones = []; for (const ch of Object.values(save.chars || {})) zones.push(ch.inv || []); for (const c of ((save.vault && save.vault.c) || [])) zones.push(c || []); for (const ch of Object.values(save.chars || {})) zones.push(ch.equip || []);
  for (const z of zones) for (let i = 0; i < z.length && n > 0; i++) if (z[i] && butin.signature(z[i]) === sig) { z[i] = null; n--; }
}
const hacher = (mdp, sel) => crypto.scryptSync(String(mdp), sel, 64).toString('hex');
const essais = new Map(); // anti force brute : 8 essais par minute et par IP
function tropDEssais(ip) { const t = Date.now(), e = (essais.get(ip) || []).filter(x => t - x < 60000); e.push(t); essais.set(ip, e); return e.length > 8; }
setInterval(() => { try { sql.sessVieilles.run(Date.now() - 60 * 86400000); } catch {} essais.clear(); }, 3600000);
const enLigne = new Map(); // id de compte -> connexion (un seul appareil à la fois)
function connecter(moi, c, ws) {
  const ancien = enLigne.get(c.id);
  if (ancien && ancien !== moi) { try { envoyer(ancien.ws, { t: 'authout', msg: 'Ce compte vient de se connecter ailleurs' }); ancien.ws.close(4004, 'Connecté ailleurs'); } catch {} }
  moi.compte = { id: c.id, nom: c.nom, admin: ADMINS.has(String(c.nom).toLowerCase()) };
  moi.admin = 0; enLigne.set(c.id, moi); sql.vu.run(Date.now(), c.id);
  moi.cpt = etatCompte(c.id); moi.seaux = moi.cpt.seaux; moi.dons = moi.cpt.dons; moi.refus = 0; moi.tues = null;
  const token = crypto.randomBytes(24).toString('hex'); sql.sessIns.run(token, c.id, Date.now());
  let save = null; try { save = c.save ? JSON.parse(c.save) : null; } catch { save = null; }
  envoyer(ws, { t: 'authres', ok: true, token, nom: c.nom, admin: moi.compte.admin, save });
  if (save) { envoyerCapGardien(moi, save); moi.cpt.boost = +save.boostXP || 0; }
  console.log(`[compte] ${c.nom} connecté${moi.compte.admin ? ' (admin)' : ''}`);
}
function actionCompte(moi, ws, m) {
  const non = msg => envoyer(ws, { t: 'authres', ok: false, msg });
  if (m.a === 'token') { const s = sql.sessGet.get(String(m.token || '')); if (!s) { non('Session expirée, reconnecte-toi'); return; } const c = sql.parId.get(s.compte); if (!c) { non('Compte introuvable'); return; } sql.sessDel.run(s.token); connecter(moi, c, ws); return; }
  if (m.a === 'logout') { if (m.token) sql.sessDel.run(String(m.token)); if (moi.compte) enLigne.delete(moi.compte.id); moi.compte = null; moi.admin = 0; return; }
  if (tropDEssais(moi.ip)) { non('Trop d\'essais, attends une minute'); return; }
  const nom = String(m.nom || '').trim(), mdp = String(m.mdp || '');
  if (!/^[A-Za-z0-9_-]{3,16}$/.test(nom)) { non('Nom de compte : 3 à 16 lettres, chiffres, _ ou -'); return; }
  if (mdp.length < 6 || mdp.length > 100) { non('Mot de passe : 6 caractères minimum'); return; }
  if (m.a === 'register') {
    if (filtrer(nom) !== nom) { non('Ce nom n\'est pas autorisé'); return; }
    if (sql.parNom.get(nom)) { non('Ce nom de compte est déjà pris'); return; }
    const sel = crypto.randomBytes(16).toString('hex'); sql.creer.run(nom, sel, hacher(mdp, sel), Date.now());
    console.log(`[compte] création ${nom}`); connecter(moi, sql.parNom.get(nom), ws); return;
  }
  if (m.a === 'login') {
    const c = sql.parNom.get(nom);
    if (!c || !crypto.timingSafeEqual(Buffer.from(hacher(mdp, c.sel), 'hex'), Buffer.from(c.hash, 'hex'))) { non('Nom ou mot de passe incorrect'); return; }
    connecter(moi, c, ws); return;
  }
  non('Action inconnue');
}
function sauverCompte(moi, m) {
  if (!moi.compte || !m.data || typeof m.data !== 'object' || Array.isArray(m.data)) return;
  const txt = JSON.stringify(m.data); if (txt.length > 1500000) return;
  const row = sql.parId.get(moi.compte.id); let ancien = null; try { ancien = row && row.save ? JSON.parse(row.save) : null; } catch { ancien = null; }
  // les admins ne sont pas contrôlés (outils de test)
  const cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id)); moi.dons = cpt.dons; moi.seaux = cpt.seaux;
  if (!moi.compte.admin) {
    let v; try { v = arbitre.verifier(ancien, m.data, { seaux: cpt.seaux, dons: cpt.dons, aPerdre: cpt.aPerdre }); } catch (e) { console.error('[arbitre] erreur', e); v = { ok: true }; }
    if (!v.ok) {
      moi.refus = (moi.refus || 0) + 1;
      sql.anoIns.run(moi.compte.id, moi.compte.nom, Date.now(), JSON.stringify(v.raisons));
      console.log(`[arbitre] sauvegarde refusée pour ${moi.compte.nom} : ${v.raisons.join(' · ')}`);
      noterSuspect(moi, 'save', 1, 'Sauvegarde refusée : ' + v.raisons.join(' · '));
      // objets donnés lors d'un échange mais gardés : on les retire aussi de la sauvegarde du serveur
      if (ancien && v.enTrop && v.enTrop.length) {
        for (const e of v.enTrop) { const n = butin.compterSig(ancien, e.sig) - e.max; if (n > 0) retirerObjets(ancien, e.sig, n); }
        cpt.aPerdre = cpt.aPerdre.filter(e => !v.enTrop.includes(e));
        sql.save.run(JSON.stringify(ancien), Date.now(), moi.compte.id);
      }
      envoyer(moi.ws, { t: 'savefix', save: ancien, raisons: v.raisons });
      return;
    }
    // ce qui n'a pas encore servi reste disponible (butin pas encore ramassé…), modifié sur place
    const D = cpt.dons, r = v.reste || DONS0();
    D.or = r.or; D.cursite = r.cursite; D.prestige = r.prestige; D.objets = r.objets; D.xp = r.xp; D.kills = r.kills; D.boss = r.boss; D.liste = r.liste || {};
    cpt.aPerdre = [];
  } else { Object.assign(cpt.dons, DONS0()); cpt.aPerdre = []; }
  arbitre.apprendre(m.data);
  cpt.boost = +m.data.boostXP || 0;
  sql.save.run(txt, Date.now(), moi.compte.id);
  envoyerCapGardien(moi, m.data);
}
// ---- échanges : à la conclusion, le serveur note ce que chacun reçoit et ce que chacun doit perdre ----
function conclureEchange(A, B) {
  const notes = [];
  for (const [X, Y] of [[A, B], [B, A]]) {
    if (!X.compte || !Y.compte || !X.offre || X.offre.to !== Y.peer) continue;
    let sx = null; try { const row = sql.parId.get(X.compte.id); sx = row && row.save ? JSON.parse(row.save) : null; } catch { sx = null; }
    if (!sx) continue;
    const prep = butin.preparerEchange(sx, X.offre.items), parSig = new Map();
    const YC = Y.cpt || (Y.cpt = etatCompte(Y.compte.id)), XC = X.cpt || (X.cpt = etatCompte(X.compte.id));
    for (const p of prep) { butin.noter(YC.dons, p.recu); parSig.set(p.sigDonneur, (parSig.get(p.sigDonneur) || 0) + 1); notes.push({ YC, sig: butin.signature(p.recu) }); }
    for (const [sig, n] of parSig) { const e = { sig, max: butin.compterSig(sx, sig) - n, t: Date.now() }; XC.aPerdre.push(e); notes.push({ XC, e }); }
  }
  // si l'échange est annulé juste après (sac plein…), on efface ce qui a été noté
  const annuler = () => { for (const n of notes) { if (n.e) n.XC.aPerdre = n.XC.aPerdre.filter(x => x !== n.e); else { const L = n.YC.dons.liste[n.sig]; if (L && L.length) L.pop(); } } };
  A.dernierEchange = B.dernierEchange = { t: Date.now(), annuler };
  A.offre = B.offre = A.trOk = B.trOk = null;
}
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
const RAID_DUREE = 5 * 60 * 1000, RAID_ATTENTE = 30 * 1000; // le portail s'ouvre, le Dragon arrive 30 s plus tard
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
    if (Object.keys(g.membres).length >= MAX_MEMBRES_GUILDE) { rep({ a: 'err', msg: 'Guilde complète (' + MAX_MEMBRES_GUILDE + ' membres)' }); return; }
    invitesGuilde.set(cible.peer, { gid, t: Date.now() });
    envoyer(cible.ws, { t: 'g', a: 'invite', gid, nom: g.nom, tag: g.tag, from: moi.peer });
    rep({ a: 'ok', msg: 'Invitation de guilde envoyée' }); return;
  }
  if (a === 'join') {
    if (g) { rep({ a: 'err', msg: 'Quitte d\'abord ta guilde actuelle' }); return; }
    const inv = invitesGuilde.get(moi.peer), cg = guildes[String(m.gid || '')];
    if (!inv || inv.gid !== String(m.gid || '') || Date.now() - inv.t > 120000 || !cg) { rep({ a: 'err', msg: 'Invitation expirée' }); return; }
    if (Object.keys(cg.membres).length >= MAX_MEMBRES_GUILDE) { rep({ a: 'err', msg: 'Guilde complète' }); return; }
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
    let dmg = Math.max(0, Math.min(40000, Math.floor(Number(m.dmg) || 0))); if (!dmg) return;
    // dégâts plafonnés selon l'équipement du joueur (anti-triche)
    { const cap = moi.capDps || 25000, now = Date.now(), b = moi.raidSeau || (moi.raidSeau = { v: cap * 10, t: now }); b.v = Math.min(cap * 10, b.v + cap * (now - b.t) / 1000); b.t = now; dmg = Math.min(dmg, Math.floor(b.v)); b.v -= dmg; if (!dmg) return; }
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
    raidEv.recu[pid] = true; sauverRaid(); { const G = gainRang(i + 1); if (moi.dons) { moi.dons.or += G.or; moi.dons.cursite += G.cu; moi.dons.objets += G.oeufs + G.cro; } } rep({ a: 'reward', rang: i + 1, gain: gainRang(i + 1) }); diffuserGuilde(gid, true); return;
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
  const estGardien = params.get('gardien') === CLE_GARDIEN && (ip === '127.0.0.1' || ip === '::1');
  if (!estGardien && [...salle.values()].filter(j => !j.gardien).length >= MAX_JOUEURS_PAR_SALLE) { ws.close(4001, 'Salle pleine'); return; }

  const peer = crypto.randomBytes(6).toString('hex');
  const moi = { ws, peer, ip, etat: {}, vivant: true, msgs: 0, gardien: estGardien };
  moi.salleNom = nom;
  if (estGardien) console.log(`[gardien] connecté à la salle ${nom}`);
  else if (SERVEURS_IDS.has(nom) && nom !== 'principal' && gardienProc) { salleVue.set(nom, Date.now()); try { gardienProc.send({ t: 'salle', salle: nom }); } catch {} }
  salle.set(peer, moi);
  console.log(`[${nom}] connexion ${peer} (${salle.size} joueur(s))`);

  envoyer(ws, {
    t: 'hello', peer, salle: nom, seed: REALM_SEED,
    peers: [...salle.values()].filter(j => j !== moi).map(j => ({ peer: j.peer, presence: j.etat }))
  });
  diffuser(salle, { t: 'join', peer }, moi);

  ws.on('message', data => {
    if (++moi.msgs > 60) return; // plus de 60 messages/seconde : ignorés
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && m.t === 'auth') { actionCompte(moi, ws, m); return; }
    if (m && m.t === 'save') { sauverCompte(moi, m); return; }
    if (m && m.t === 'score') { enregistrerScore(m); moi.idJoueur = String(m.id || ''); return; }
    if (m && m.t === 'top') { envoyer(ws, top(moi.idJoueur || String(m.id || ''))); return; }
    if (m && m.t === 'g') { actionGuilde(moi, salle, m); return; }
    if (m && m.t === 'serveurs') { envoyer(ws, { t: 'serveurs', ici: nom, l: SERVEURS.map(([id, n]) => ({ id, n, j: salles.get(id) ? [...salles.get(id).values()].filter(j => !j.gardien).length : 0 })) }); return; }
    if (m && m.t === 'kill') { if (moi.compte) reclamerKill(moi, m, nom, salle, 0); return; }
    // Échanges entre joueurs : relayés uniquement vers un joueur de la même salle
    if (m && m.t === 'tr') {
      const cible = salle.get(String(m.to || ''));
      if (!cible || cible === moi) return;
      const out = { t: 'tr', from: peer, k: String(m.k || '').slice(0, 10) };
      if (out.k === 'offer') { moi.offre = { to: cible.peer, items: Array.isArray(m.items) ? m.items.slice(0, 8) : [] }; moi.trOk = cible.trOk = null; }
      else if (out.k === 'ok') {
        moi.trOk = m.ok ? { to: cible.peer, h: String(m.h || ''), t: Date.now() } : null;
        const a = moi.trOk, b = cible.trOk;
        if (a && b && b.to === peer && Date.now() - b.t < 120000 && a.h.split('/').reverse().join('/') === b.h) conclureEchange(moi, cible);
      } else if (out.k === 'cancel') { moi.trOk = cible.trOk = null; moi.offre = cible.offre = null; const de = moi.dernierEchange; if (de && Date.now() - de.t < 5000) { de.annuler(); moi.dernierEchange = cible.dernierEchange = null; } }
      if (m.ok !== undefined) out.ok = !!m.ok;
      if (typeof m.h === 'string') out.h = m.h.slice(0, 64);
      if (Array.isArray(m.items)) out.items = m.items.slice(0, 8);
      if (m.info && typeof m.info === 'object' && !Array.isArray(m.info)) out.info = m.info; // fiche « Inspecter »
      if (JSON.stringify(out).length > 8000) return;
      envoyer(cible.ws, out);
      return;
    }
    if (m && m.t === 'dev') {
      const res = (ok, msg, extra) => envoyer(ws, Object.assign({ t: 'devres', ok, msg }, extra || {}));
      if (!(moi.compte && moi.compte.admin)) { res(false, 'Réservé aux comptes admin'); return; }
      const cmd = String(m.cmd || '');
      // suivi des admins connectés (onglet « Admins » du panneau)
      if (cmd === 'bye') { moi.admin = 0; res(true, ''); console.log(`[admin] ${(moi.etat && moi.etat.n) || '?'} quitte le mode admin`); return; }
      if (!moi.admin) { moi.admin = Date.now(); console.log(`[admin] ${(moi.etat && moi.etat.n) || '?'} (${masquer(moi.ip)}) passe admin`); }
      if (cmd === 'hello') { res(true, ''); return; }
      if (cmd === 'annonce') { const sec = Math.max(5, Math.min(300, Math.floor(Number(m.arg) || 30))); annoncerMaj(sec); res(true, 'Annonce envoyée : compte à rebours de ' + sec + ' s (le serveur ne redémarre pas tout seul)'); return; }
      if (cmd === 'suspects') { res(true, '', { suspects: listeSuspects() }); return; }
      if (cmd === 'anomalies') { res(true, '', { anomalies: sql.anoListe.all().map(r => ({ n: r.nom, t: r.quand, r: JSON.parse(r.raisons || '[]') })) }); return; }
      if (cmd === 'admins') { const out = []; for (const s of salles.values()) for (const j of s.values()) if (j.admin) out.push({ n: String((j.etat && j.etat.n) || 'Joueur').slice(0, 16), ip: masquer(j.ip), t: j.admin, s: String((j.etat && j.etat.s) || ''), moi: j === moi }); res(true, '', { admins: out }); return; }
      if (cmd === 'bans') { res(true, '', { bans: Object.entries(modo.bans).map(([ip, b]) => ({ id: ip, ip: masquer(ip), n: b.n, t: b.t })) }); return; }
      if (cmd === 'unban') { const id = String(m.to || ''); if (!modo.bans[id]) { res(false, 'Déjà débanni'); return; } const n = modo.bans[id].n; delete modo.bans[id]; sauverModo(); res(true, n + ' est débanni', { bans: Object.entries(modo.bans).map(([ip, b]) => ({ id: ip, ip: masquer(ip), n: b.n, t: b.t })) }); console.log(`[modo] débanni ${n}`); return; }
      if (cmd === 'raid') { lancerRaid(); res(true, 'Raid lancé : portail ouvert, le Dragon arrive dans 30 secondes (5 minutes de combat)'); console.log('[raid] lancé'); return; }
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
        cible.tpT = Date.now(); envoyer(cible.ws, { t: 'dev', cmd: 'summon', arg });
        res(true, nom + ' est téléporté vers toi');
      } else if (cmd === 'item') {
        const it = m.arg;
        if (!it || typeof it !== 'object' || JSON.stringify(it).length > 2000) { res(false, 'Objet invalide'); return; }
        if (cible.dons) cible.dons.objets += 1;
        envoyer(cible.ws, { t: 'dev', cmd: 'item', arg: it });
        res(true, String(it.name || 'Objet').slice(0, 40) + ' envoyé à ' + nom);
      } else if (cmd === 'god' || cmd === 'cursite' || cmd === 'gold') {
        const arg = cmd === 'god' ? (m.arg ? 1 : 0) : Math.max(0, Math.min(10000000, Math.floor(Number(m.arg) || 0)));
        if (cible.dons) { if (cmd === 'gold') cible.dons.or += arg; if (cmd === 'cursite') cible.dons.cursite += arg; }
        envoyer(cible.ws, { t: 'dev', cmd, arg });
        res(true, cmd === 'god' ? (arg ? 'GOD donné à ' : 'GOD retiré à ') + nom : arg + (cmd === 'gold' ? ' pièces envoyées à ' : ' Cursite envoyée à ') + nom);
      } else if (cmd === 'eff') {
        const a = m.arg || {}, e = String(a.e || ''), t = Math.max(0.5, Math.min(60, Number(a.t) || 5));
        if (!['par', 'poi', 'slow', 'blind', 'burn', 'rage', 'invul', 'sonic', 'clear'].includes(e)) { res(false, 'État inconnu'); return; }
        envoyer(cible.ws, { t: 'dev', cmd: 'eff', arg: { e, t } });
        res(true, 'État appliqué à ' + nom);
      } else if (cmd === 'fp') {
        envoyer(cible.ws, { t: 'dev', cmd: 'fp', arg: m.arg ? 1 : 0 });
        res(true, (m.arg ? 'Vue 1re personne activée pour ' : 'Vue 1re personne retirée à ') + nom);
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
    if (m.patch.s !== undefined && m.patch.s !== moi.etat.s) { moi.sAvant = moi.etat.s; moi.sT = Date.now(); }
    // déplacements impossibles (téléportation) dans une même scène, hors arrivée près d'un autre joueur
    if (!moi.gardien && moi.compte && !moi.compte.admin && typeof m.patch.x === 'number' && typeof m.patch.y === 'number') {
      const sc = m.patch.s !== undefined ? m.patch.s : moi.etat.s, now = Date.now(), pp = moi.posPrec;
      if (pp && pp.s === sc && now - (moi.sT || 0) > 3000 && now - (moi.tpT || 0) > 3000) {
        const dist = Math.hypot(m.patch.x - pp.x, m.patch.y - pp.y) / 10, dt = Math.max(0.05, (now - pp.t) / 1000);
        if (dist > 3 && dist / dt > 30) {
          let presDAutre = false; for (const j of salle.values()) if (j !== moi && j.etat && j.etat.s === sc && Math.hypot((j.etat.x || 0) - m.patch.x, (j.etat.y || 0) - m.patch.y) / 10 < 4) presDAutre = true;
          if (!presDAutre) noterSuspect(moi, 'vitesse', 1, 'Déplacement impossible : ' + dist.toFixed(1) + ' cases en ' + dt.toFixed(2) + ' s');
        }
      }
      moi.posPrec = { x: m.patch.x, y: m.patch.y, s: sc, t: now };
    }
    // dans les Plaines, le Gardien reste l'hôte : personne ne peut annoncer une arrivée plus ancienne que lui
    if (!moi.gardien && (m.patch.s === 'r' || (m.patch.s === undefined && moi.etat.s === 'r')) && gardienDe(salle, 'r')) m.patch.rt = 9e15;
    for (const k of Object.keys(m.patch).slice(0, 96)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) continue;
      let v = m.patch[k];
      if (k === 'ti' && v === 'admin' && !moi.admin) v = null; // titre ADMIN réservé aux admins vérifiés
      if (k === 'gd' && !moi.gardien) v = null; // seul le vrai Gardien peut s'annoncer
      if (k === 'm' && typeof v === 'string') { if (modo.mutes[moi.ip]) { if (!moi.averti) { moi.averti = true; envoyer(ws, { t: 'dev', cmd: 'mute', arg: 0 }); } continue; } v = filtrer(v).slice(0, 140); }
      if (k === 'n' && typeof v === 'string') v = filtrer(v).slice(0, 16);
      if (v === null) delete moi.etat[k]; else moi.etat[k] = v;
    }
    if (!modo.mutes[moi.ip]) moi.averti = false;
    if (JSON.stringify(moi.etat).length > MAX_OCTETS_ETAT) moi.etat = {};
    try { butin.observer(nom, moi, m.patch); } catch (e) { console.error('[butin] témoin', e.message); }
    if (!moi.gardien && SERVEURS_IDS.has(nom) && typeof moi.etat.s === 'string' && moi.etat.s[0] === 'd') demanderDonjon(nom, moi.etat.s);
    diffuser(salle, { t: 'p', peer, presence: moi.etat }, moi);
  });

  ws.on('pong', () => { moi.vivant = true; });
  ws.on('close', () => {
    if (moi.compte && enLigne.get(moi.compte.id) === moi) enLigne.delete(moi.compte.id);
    if (gardienProc && !moi.gardien) try { gardienProc.send({ t: 'capfin', peer }); } catch {}
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

// ---- Annonce de mise à jour : la clé est écrite dans le dossier des données, lisible seulement sur le serveur ----
const CLE_ANNONCE = crypto.randomBytes(16).toString('hex');
try { fs.writeFileSync(path.join(DATA_DIR, 'annonce.json'), JSON.stringify({ port: PORT, cle: CLE_ANNONCE }), { mode: 0o600 }); } catch (e) { console.error('[annonce]', e.message); }
function annoncerMaj(sec) {
  console.log(`[annonce] mise à jour dans ${sec} s`);
  for (const j of tousLesSockets()) if (!j.gardien) envoyer(j.ws, { t: 'maj', s: sec });
}
server.listen(PORT, () => {
  console.log(`Royaume Maudit en ligne sur http://localhost:${PORT}`);
  lancerGardien();
});

// ---- Le Gardien des Plaines : une copie du jeu sans affichage, hôte permanent des Plaines Sauvages ----
// (processus séparé : s'il plante, il est relancé ; GARDIEN=0 pour le couper)
const { fork } = require('child_process');
const CLE_GARDIEN = crypto.randomBytes(12).toString('hex');
let gardienProc = null;
function lancerGardien() {
  if (process.env.GARDIEN === '0') return;
  try {
    gardienProc = fork(path.join(__dirname, 'gardien.js'), [], { env: Object.assign({}, process.env, { GARDIEN_PORT: String(PORT), GARDIEN_CLE: CLE_GARDIEN }) });
    gardienProc.on('exit', code => { console.log(`[gardien] arrêté (${code}), relance dans 5 s`); gardienProc = null; donjonsGardes.clear(); setTimeout(lancerGardien, 5000); });
    gardienProc.on('error', e => console.error('[gardien]', e.message));
    gardienProc.on('message', m => { if (m && m.t === 'suivi' && m.rap) for (const [peer, v] of Object.entries(m.rap)) { const j = trouverJoueur(peer); if (!j || j.gardien) continue;
      if (v.clip > 0) noterSuspect(j, 'clip', v.clip, v.clip > 50000 ? 'Dégâts au-delà du possible (' + v.clip + ' rognés)' : null);
      if (v.loin > 0) noterSuspect(j, 'loin', v.loin, 'Coups sur des monstres trop loin (' + v.loin + ')');
      if (v.invul >= 90) noterSuspect(j, 'invul', v.invul, v.invul + ' s près d\'un boss sans perdre de vie'); } });
    for (const [nomS, salle] of salles) if (nomS !== 'principal' && SERVEURS_IDS.has(nomS) && [...salle.values()].some(j => !j.gardien)) gardienProc.send({ t: 'salle', salle: nomS });
  } catch (e) { console.error('[gardien] impossible de démarrer :', e.message); }
}
// le Gardien plafonne les dégâts de chaque joueur : on lui donne le maximum possible avec son équipement
function envoyerCapGardien(moi, save) {
  if (!moi.peer) return;
  let cap = 25000; try { cap = arbitre.degatsMax(save); } catch {}
  moi.capDps = cap;
  if (gardienProc) try { gardienProc.send({ t: 'cap', peer: moi.peer, cap }); } catch {}
}
process.on('exit', () => { try { gardienProc && gardienProc.kill(); } catch {} });
// ---- Joueurs suspects : indices collectés en continu (onglet admin « Suspects ») ----
const suspects = new Map(); // id de compte -> fiche
function fiche(moi) {
  if (!moi || !moi.compte || moi.compte.admin) return null;
  let f = suspects.get(moi.compte.id);
  if (!f) { f = { nom: moi.compte.nom, save: 0, kill: 0, clip: 0, loin: 0, invul: 0, vitesse: 0, raisons: [], alerte: false }; suspects.set(moi.compte.id, f); }
  f.vu = Date.now(); f.srv = moi.salleNom; return f;
}
function scoreDe(f) { return f.save * 10 + f.kill * 1 + Math.floor(f.clip / 20000) + f.loin * 2 + (f.invul >= 150 ? 30 : f.invul >= 90 ? 10 : 0) + f.vitesse * 5; }
function noterSuspect(moi, champ, n, raison) {
  const f = fiche(moi); if (!f) return;
  if (champ === 'invul') f.invul = Math.max(f.invul, n); else f[champ] += n;
  if (raison) { f.raisons.unshift({ t: Date.now(), r: String(raison).slice(0, 120) }); f.raisons.length = Math.min(f.raisons.length, 8); }
  // première alerte rouge de la session : gardée dans l'historique (onglet Triche)
  if (!f.alerte && scoreDe(f) >= 30) { f.alerte = true; try { sql.anoIns.run(moi.compte.id, moi.compte.nom, Date.now(), JSON.stringify(['Suspect (score ' + scoreDe(f) + ') : ' + (f.raisons[0] ? f.raisons[0].r : champ)])); } catch {} console.log(`[suspect] ${moi.compte.nom} : score ${scoreDe(f)}`); }
}
function listeSuspects() {
  const enLigneIds = new Set(); for (const j of tousLesSockets()) if (j.compte) enLigneIds.add(j.compte.id);
  return [...suspects.entries()].map(([id, f]) => ({ n: f.nom, s: scoreDe(f), on: enLigneIds.has(id), vu: f.vu, srv: (SERVEURS.find(x => x[0] === f.srv) || [0, f.srv || '?'])[1],
    d: { save: f.save, kill: f.kill, clip: f.clip, loin: f.loin, invul: f.invul, vitesse: f.vitesse }, r: f.raisons.slice(0, 4) }))
    .filter(x => x.s > 0).sort((a, b) => (b.on - a.on) || (b.s - a.s)).slice(0, 50);
}
function gardienDe(salle, sc) { for (const j of salle.values()) if (j.gardien && j.etat && j.etat.s === (sc || 'r')) return j; return null; }
// ---- Donjons gardés : une copie du jeu héberge chaque donjon occupé (salle principale) ----
const donjonsGardes = new Map(); // 'salle|scène' -> { t: demande, vu: dernier joueur présent }
function demanderDonjon(salle, sc) {
  if (!gardienProc || !/^d[a-z][0-9a-z]{1,10}$/.test(sc)) return;
  const k = salle + '|' + sc, d = donjonsGardes.get(k); if (d) { d.vu = Date.now(); return; }
  donjonsGardes.set(k, { t: Date.now(), vu: Date.now(), salle, sc });
  try { gardienProc.send({ t: 'donjon', salle, s: sc }); } catch {}
}
const salleVue = new Map(); // salle -> dernier moment où un joueur y était
setInterval(() => {
  const occ = new Set();
  for (const [nomS, salle] of salles) for (const j of salle.values()) if (!j.gardien) { salleVue.set(nomS, Date.now()); if (j.etat && typeof j.etat.s === 'string') occ.add(nomS + '|' + j.etat.s); }
  for (const [k, d] of donjonsGardes) {
    if (occ.has(k)) { d.vu = Date.now(); continue; }
    if (Date.now() - d.vu > 45000) { donjonsGardes.delete(k); try { gardienProc && gardienProc.send({ t: 'fin', salle: d.salle, s: d.sc }); } catch {} }
  }
  // un serveur secondaire vide depuis 10 minutes libère son Gardien des Plaines
  for (const [nomS, t] of salleVue) if (nomS !== 'principal' && Date.now() - t > 600000) { salleVue.delete(nomS); try { gardienProc && gardienProc.send({ t: 'sallefin', salle: nomS }); } catch {} }
}, 5000);
// un monstre tué : dans un donjon qui attend son Gardien, on patiente quelques secondes avant de juger
function reclamerKill(moi, m, nom, salle, essai) {
  const sc = String(m.s || ''), d = donjonsGardes.get(nom + '|' + sc);
  const G = gardienDe(salle, sc || 'r');
  if (!G && d && Date.now() - d.t < 8000 && essai < 25) { setTimeout(() => { if (moi.ws.readyState === 1) reclamerKill(moi, m, nom, salle, essai + 1); }, 400); return; }
  butin.reclamer(moi, m, { salle: nom, membres: salle, gardien: G, boost: moi.cpt.boost || 0, onRefus: r => noterSuspect(moi, 'kill', 1, 'Monstre refusé : ' + r), dons: moi.dons, rythme: moi.cpt.rythme, envoyer, signaler: r => { try { sql.anoIns.run(moi.compte.id, moi.compte.nom, Date.now(), JSON.stringify(r)); } catch {} } });
}
