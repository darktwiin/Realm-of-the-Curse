// The Curse (ex Royaume Maudit) — serveur multijoueur
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
let MENTIONS = Buffer.from('<meta charset="utf-8"><p>Conditions indisponibles.</p>'); try { MENTIONS = fs.readFileSync(path.join(__dirname, 'public', 'mentions.html')); } catch (e) { console.error('[mentions] fichier public/mentions.html absent'); }
let WIKI = Buffer.from('<meta charset="utf-8"><p>Wiki indisponible.</p>'); try { WIKI = fs.readFileSync(path.join(__dirname, 'public', 'wiki.html')); } catch (e) { console.error('[wiki] fichier public/wiki.html absent'); }
// graine du Royaume : une nouvelle carte à chaque lancement du serveur, la même pour tous les joueurs
const REALM_SEED = 1 + Math.floor(Math.random() * 999999999);

// ---- Classement : scores des joueurs, sauvegardés dans classement.json ----
// Sur Render gratuit, ce fichier est effacé à chaque redémarrage du serveur (disque non permanent).
const FICHIER_SCORES = path.join(__dirname, 'classement.json');
let scores = {};
try { scores = JSON.parse(fs.readFileSync(FICHIER_SCORES, 'utf8')) || {}; } catch { scores = {}; }
let scoresModifies = false;
const entier = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const CLASSES_OK = ['guerrier', 'mage', 'archer', 'pretre', 'trickster', 'assassin', 'bouclier', 'invocateur'];
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
function top(demandeur, demandeurCompte) {
  const liste = Object.entries(scores);
  const ligne = (id, s, v) => ({ n: s.n, c: s.c, l: s.l, v, moi: id === demandeur });
  const tri = (f, filtre) => liste.filter(([, s]) => !filtre || filtre(s)).map(([id, s]) => ligne(id, s, f(s))).sort((a, b) => b.v - a.v).slice(0, 20);
  return {
    t: 'top',
    or: tri(s => s.gold),
    prestige: tri(s => s.pres),
    maisons: (() => { try { return MAISON.top20.all().map(r => ({ id: r.id, n: r.nom, v: r.n, moi: !!(demandeurCompte && r.id === demandeurCompte) })); } catch { return []; } })(),
    precision: tri(s => Math.round(s.hits / s.shots * 1000) / 10, s => s.shots >= 300),
    kills: tri(s => s.kills)
  };
}
setInterval(() => {
  if (!scoresModifies) return;
  scoresModifies = false;
  fs.writeFile(FICHIER_SCORES, JSON.stringify(scores), () => {});
}, 30000);

let popCache = null, popT = 0;
function popularite() {
  if (popCache && Date.now() - popT < 300000) return popCache;
  const niv = {}, heros = {}; let comptes = 0;
  try { for (const r of db.prepare('SELECT save FROM comptes WHERE save IS NOT NULL').all()) { let sv; try { sv = JSON.parse(r.save); } catch { continue; } if (!sv || !sv.chars) continue; comptes++;
      for (const [c, ch] of Object.entries(sv.chars)) { if (!CLASSES_OK.includes(c) || !ch) continue; const l = Math.max(1, Math.min(25, ch.lvl | 0)); niv[c] = (niv[c] || 0) + l; heros[c] = (heros[c] || 0) + 1; } } } catch (e) { console.error('[classes]', e.message); }
  popT = Date.now(); return (popCache = { t: popT, comptes, niv, heros });
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(INDEX);
  } else if (url === '/mentions' || url === '/mentions.html' || url === '/cgu' || url === '/confidentialite') {
    // conditions d'utilisation, confidentialité et mentions légales (aussi affichées dans le jeu)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(MENTIONS);
  } else if (url === '/wiki' || url === '/wiki/' || url === '/wiki.html') {
    // wiki du jeu : page générée par outils/generer-wiki.js
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(WIKI);
  } else if (url === '/classes') {
    // popularité des héros pour le wiki : somme des niveaux de chaque héros sur tous les comptes (recalculée au plus toutes les 5 minutes)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(popularite()));
  } else if (url === '/top') {
    // classement, lu par le wiki
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(top('')));
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
const ALPHAS = new Set(String(process.env.ALPHA_COMPTES || 'Heartless,Foxy').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)); // titre « Alpha testeur »
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
// acceptation des conditions d'utilisation : une ligne par compte et par version du texte
db.exec(`CREATE TABLE IF NOT EXISTS consentements (compte INTEGER NOT NULL, version TEXT NOT NULL, quand INTEGER NOT NULL, PRIMARY KEY (compte, version))`);
sql.cguIns = db.prepare('INSERT OR IGNORE INTO consentements (compte, version, quand) VALUES (?, ?, ?)');
sql.cguDernier = db.prepare('SELECT version FROM consentements WHERE compte = ? ORDER BY quand DESC LIMIT 1');
sql.anoIns = db.prepare('INSERT INTO anomalies (compte, nom, quand, raisons) VALUES (?, ?, ?, ?)');
sql.anoListe = db.prepare('SELECT nom, quand, raisons FROM anomalies ORDER BY id DESC LIMIT 60');
for (const r of db.prepare('SELECT save FROM comptes WHERE save IS NOT NULL').all()) { try { arbitre.apprendre(JSON.parse(r.save)); } catch {} }
const DONS0 = () => ({ cursite: 0, or: 0, prestige: 0, objets: 0, xp: 0, kills: 0, boss: 0, liste: {}, sol: [], res: {} });
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
  let cgu = null; try { const r = sql.cguDernier.get(c.id); cgu = r ? r.version : null; } catch {}
  envoyer(ws, { t: 'authres', ok: true, token, nom: c.nom, id: c.id, admin: moi.compte.admin, save, cgu });
  if (save) { envoyerCapGardien(moi, save); moi.cpt.boost = +save.boostXP || 0; }
  if (concoursVisible()) envoyer(ws, etatConcours());
  envoyer(ws, etatObjectif()); tournoiCloture(); envoyer(ws, etatTournoi(moi)); if (ALPHAS.has(String(c.nom).toLowerCase())) envoyer(ws, { t: 'titres', l: ['alpha'] });
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
    console.log(`[compte] création ${nom}`); connecter(moi, sql.parNom.get(nom), ws); moi.nouveau = true; return;
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
    let v; try { v = arbitre.verifier(ancien, m.data, { seaux: cpt.seaux, dons: cpt.dons, aPerdre: cpt.aPerdre, aPayer: hvAPayer(cpt, ancien, m.data) }); } catch (e) { console.error('[arbitre] erreur', e); v = { ok: true }; }
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
    D.or = r.or; D.cursite = r.cursite; D.prestige = r.prestige; D.objets = r.objets; D.xp = r.xp; D.kills = r.kills; D.boss = r.boss; D.liste = r.liste || {}; D.sol = r.sol || []; D.res = r.res || {};
    cpt.aPerdre = cpt.aPerdre.filter(e => Date.now() - e.t < 3000); // les plus récents seront vérifiés à la sauvegarde suivante
    if (cpt.achats) cpt.achats = cpt.achats.filter(a => !a.vu);                // achats de l'hôtel des ventes payés
  } else { Object.assign(cpt.dons, DONS0()); cpt.aPerdre = []; }
  arbitre.apprendre(m.data);
  cpt.boost = +m.data.boostXP || 0;
  sql.save.run(txt, Date.now(), moi.compte.id);
  envoyerCapGardien(moi, m.data); parrPaliers(moi, m.data);
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
  const estBot = !estGardien && params.get('bot') === CLE_GARDIEN && (ip === '127.0.0.1' || ip === '::1'); // faux joueurs lancés par le Gardien
  if (!estGardien && !estBot && [...salle.values()].filter(j => !j.gardien && !j.bot).length >= MAX_JOUEURS_PAR_SALLE) { ws.close(4001, 'Salle pleine'); return; }

  const peer = crypto.randomBytes(6).toString('hex');
  const moi = { ws, peer, ip, etat: {}, vivant: true, msgs: 0, gardien: estGardien, bot: estBot };
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
    if (m && m.t === 'top') { envoyer(ws, top(moi.idJoueur || String(m.id || ''), moi.compte && moi.compte.id)); return; }
    if (m && m.t === 'g') { actionGuilde(moi, salle, m); return; }
    if (m && m.t === 'serveurs') { envoyer(ws, { t: 'serveurs', ici: nom, l: SERVEURS.map(([id, n]) => ({ id, n, j: salles.get(id) ? [...salles.get(id).values()].filter(j => !j.gardien).length : 0 })) }); return; }
    if (m && m.t === 'cle') { utiliserCle(moi, nom); return; }
    if (m && m.t === 'peche') { pecher(moi, nom, m); return; }
    if (m && (m.t === 'dessin' || m.t === 'px')) { dessiner(moi, m); return; }
    if (m && m.t === 'tournoi') { tournoiPrise(moi, m); return; }
    if (m && m.t === 'hv') { hotelDesVentes(moi, m); return; }
    if (m && m.t === 'parr') { parrainage(moi, m); return; }
    if (m && m.t === 'maison') { maison(moi, m, salle); return; }
    if (m && m.t === 'cgu') { const v = String(m.v || ''); if (moi.compte && /^\d{4}-\d{2}-\d{2}$/.test(v)) { try { sql.cguIns.run(moi.compte.id, v, Date.now()); console.log(`[cgu] ${moi.compte.nom} accepte la version ${v}`); } catch (e) { console.error('[cgu]', e.message); } } return; }
    // nouveau compte : son premier héros vient d'être choisi, on souhaite la bienvenue à tout le monde (une seule fois)
    if (m && m.t === 'bienvenue') { if (moi.compte && moi.nouveau) { moi.nouveau = false; const n = filtrer(String(m.n || moi.compte.nom)).replace(/[<>]/g, '').slice(0, 16) || moi.compte.nom; console.log(`[compte] bienvenue à ${n}`); envoyer(ws, { t: 'bienvenue', n, moi: 1 }); diffuserPartout({ t: 'bienvenue', n }, moi); } return; }
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
      // concours : « etat », « reset » (efface le vainqueur), ou un nombre = départ dans N minutes (0 = tout de suite)
      if (cmd === 'concours') { const a = String(m.arg == null ? 'etat' : m.arg);
        if (a === 'reset') { CONCOURS.gagnant = null; sauverConcours(); diffuserPartout(etatConcours({ live: 1 })); }
        else if (/^\d+$/.test(a)) { CONCOURS.debut = Date.now() + (+a) * 60000; CONCOURS.gagnant = null; sauverConcours(); armerConcours(); diffuserPartout(etatConcours({ live: 1 })); }
        res(true, 'Concours : départ ' + new Date(CONCOURS.debut).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) + (CONCOURS.gagnant ? ' · gagnant : ' + CONCOURS.gagnant.n + ' (' + Math.round(CONCOURS.gagnant.d / 1000) + ' s)' : ' · pas encore de gagnant')); return; }
      if (cmd === 'suspects') { res(true, '', { suspects: listeSuspects() }); return; }
      if (cmd === 'anomalies') { res(true, '', { anomalies: sql.anoListe.all().map(r => ({ n: r.nom, t: r.quand, r: JSON.parse(r.raisons || '[]') })) }); return; }
      if (cmd === 'admins') { const out = []; for (const s of salles.values()) for (const j of s.values()) if (j.admin) out.push({ n: String((j.etat && j.etat.n) || 'Joueur').slice(0, 16), ip: masquer(j.ip), t: j.admin, s: String((j.etat && j.etat.s) || ''), moi: j === moi }); res(true, '', { admins: out }); return; }
      if (cmd === 'bans') { res(true, '', { bans: Object.entries(modo.bans).map(([ip, b]) => ({ id: ip, ip: masquer(ip), n: b.n, t: b.t })) }); return; }
      if (cmd === 'unban') { const id = String(m.to || ''); if (!modo.bans[id]) { res(false, 'Déjà débanni'); return; } const n = modo.bans[id].n; delete modo.bans[id]; sauverModo(); res(true, n + ' est débanni', { bans: Object.entries(modo.bans).map(([ip, b]) => ({ id: ip, ip: masquer(ip), n: b.n, t: b.t })) }); console.log(`[modo] débanni ${n}`); return; }
      if (cmd === 'raid') { lancerRaid(); res(true, 'Raid lancé : portail ouvert, le Dragon arrive dans 30 secondes (5 minutes de combat)'); console.log('[raid] lancé'); return; }
      if (cmd === 'raidstop') { if (!raidEv || !raidEv.actif) { res(false, 'Aucun raid en cours'); return; } finirRaid(); res(true, 'Raid terminé, classement envoyé'); return; }
      if (cmd === 'infos') { const out = []; for (const s of salles.values()) for (const j of s.values()) out.push({ peer: j.peer, muet: !!modo.mutes[j.ip], bot: j.bot ? 1 : 0 }); res(true, '', { infos: out }); return; }
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
      if (k === 'ti' && v === 'admin' && !(moi.compte && moi.compte.admin)) v = null; // titre ADMIN réservé aux comptes admin
      if (k === 'gd' && !moi.gardien) v = null; // seul le vrai Gardien peut s'annoncer
      if (k === 'ti' && v === 'alpha' && !(moi.compte && ALPHAS.has(String(moi.compte.nom).toLowerCase()))) v = null; // titre réservé aux premiers testeurs
      if (k === 'ti' && v === 'roipeche' && !(moi.compte && roiPeche() && roiPeche().compte === moi.compte.nom)) v = null; // titre du vainqueur du tournoi de pêche
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
  console.log(`The Curse en ligne sur http://localhost:${PORT}`);
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
// ---- Clef du Temps : le serveur vérifie que le joueur possède une clef, la marque « à perdre » et délivre le donjon ----
const ticketsCle = new Map(); // 'salle|scène' -> fin de validité
setInterval(() => { const n = Date.now(); for (const [k, t] of ticketsCle) if (t < n) ticketsCle.delete(k); }, 60000);
// donjons qui demandent un ticket du serveur : Horloge Brisée (clef) et Vengeance sous-marine (pêche)
const ticketOk = (salle, sc) => (sc[1] !== 'h' && sc[1] !== 'v') || (ticketsCle.get(salle + '|' + sc) || 0) > Date.now();
// pêche dans les Plaines : très rarement, un portail vers La Vengeance sous-marine (tirage côté serveur)
const VENGEANCE_TAUX = 1 / 250;
function pecher(moi, salle, m) {
  if (!moi.compte || !moi.etat || moi.etat.s !== 'r') return;
  const force = !!(m && m.force) && moi.compte.admin;
  if (!force) { if (Date.now() - (moi.pecheT || 0) < 2500) return; moi.pecheT = Date.now(); if (Math.random() >= VENGEANCE_TAUX) return; }
  const id = 1 + crypto.randomInt(2000000000);
  ticketsCle.set(salle + '|dv' + id.toString(36), Date.now() + 2 * 3600000);
  console.log(`[pêche] ${moi.compte.nom} ouvre La Vengeance sous-marine (${salle})`);
  envoyer(moi.ws, { t: 'vengeance', id });
}

// ---------- concours du premier donjon : le premier à terminer le donjon désigné, commencé après le départ, gagne 500 Cursite ----------
const CONCOURS = { debut: Number(process.env.CONCOURS_DEBUT) || Date.UTC(2026, 9, 3, 16, 0, 0) /* samedi 3 octobre 2026, 18 h à Paris */, prix: 500, gagnant: null, donjon: process.env.CONCOURS_DONJON || 'c' };
const FICHIER_CONCOURS = path.join(DATA_DIR, 'concours.json');
try { const c = JSON.parse(fs.readFileSync(FICHIER_CONCOURS, 'utf8')); if (c && c.debut === CONCOURS.debut && c.gagnant) CONCOURS.gagnant = c.gagnant; } catch {}
const sauverConcours = () => { try { fs.writeFileSync(FICHIER_CONCOURS, JSON.stringify({ debut: CONCOURS.debut, gagnant: CONCOURS.gagnant })); } catch (e) { console.error('[concours]', e.message); } };
// annoncé à l'avance (sans dire quel donjon), puis visible jusqu'à 24 h après la victoire (7 jours sans vainqueur)
const concoursVisible = () => { const n = Date.now(); return CONCOURS.gagnant ? n < CONCOURS.gagnant.t + 24 * 3600000 : n < CONCOURS.debut + 7 * 24 * 3600000; };
const concoursParti = () => Date.now() >= CONCOURS.debut;
// le type et le nom du donjon ne partent vers les joueurs qu'une fois le chronomètre lancé
const etatConcours = extra => { const R = arbitre.regles(), T = R && R.DTYPES && R.DTYPES[CONCOURS.donjon];
  return Object.assign({ t: 'concours', debut: CONCOURS.debut, prix: CONCOURS.prix, gagnant: CONCOURS.gagnant ? { n: CONCOURS.gagnant.n, d: CONCOURS.gagnant.d } : null }, concoursParti() && T ? { dt: CONCOURS.donjon, dn: T.nom } : {}, extra || {}); };
function diffuserPartout(msg, sauf) { for (const salle of salles.values()) diffuser(salle, msg, sauf); }
let minuteurConcours = null;
function armerConcours() {
  clearTimeout(minuteurConcours); const dans = CONCOURS.debut - Date.now();
  if (dans > 0 && dans < 2000000000) minuteurConcours = setTimeout(() => { console.log('[concours] départ du chronomètre'); diffuserPartout(etatConcours({ live: 1 })); }, dans);
}
armerConcours();
function concoursTue(moi, key, sc) {
  const R = arbitre.regles(), T = R && R.DTYPES && R.DTYPES[CONCOURS.donjon];
  if (!T || key !== T.bk || sc.slice(0, 2) !== 'd' + CONCOURS.donjon || CONCOURS.gagnant || !concoursParti() || !concoursVisible()) return;
  if (!moi.compte || moi.compte.admin) return;                                  // les admins ne concourent pas
  if (!(moi.etat && moi.etat.s === sc && (moi.sT || 0) >= CONCOURS.debut)) return; // donjon commencé avant le départ : ne compte pas
  // tous les joueurs présents dans ce donjon gagnent ensemble : la récompense est partagée entre eux
  const equipe = [moi]; for (const s of salles.values()) for (const j of s.values()) if (j !== moi && j.ws.readyState === 1 && j.compte && !j.compte.admin && !j.bot && !j.gardien && j.etat && j.etat.s === sc && s.get(moi.peer) === moi && !equipe.some(e => e.compte.id === j.compte.id)) equipe.push(j);
  const part = Math.max(1, Math.floor(CONCOURS.prix / equipe.length)), noms = equipe.map(j => String((j.etat && j.etat.n) || j.compte.nom).slice(0, 16));
  CONCOURS.gagnant = { n: noms.join(', ').slice(0, 80), compte: moi.compte.nom, comptes: equipe.map(j => j.compte.nom), part, t: Date.now(), d: Date.now() - CONCOURS.debut }; sauverConcours();
  console.log(`[concours] ${equipe.map(j => j.compte.nom).join(', ')} gagne(nt) en ${Math.round(CONCOURS.gagnant.d / 1000)} s : ${part} Cursite chacun`);
  for (const j of equipe) { const c = j.cpt || (j.cpt = etatCompte(j.compte.id)); c.dons.cursite += part; envoyer(j.ws, etatConcours({ gain: part })); }
  for (const s of salles.values()) for (const j of s.values()) if (!equipe.includes(j)) envoyer(j.ws, etatConcours({ live: 1 }));
}
// ---------- table à dessin du Village : une toile commune de 100 × 100, un pixel par minute et par compte ----------
const DESSIN_N = 100, DESSIN_COULEURS = 24, DESSIN_DELAI = 60000;
const FICHIER_DESSIN = path.join(DATA_DIR, 'dessin.json');
let DESSIN = Buffer.alloc(DESSIN_N * DESSIN_N, 0);
try { const d = JSON.parse(fs.readFileSync(FICHIER_DESSIN, 'utf8')); const b = Buffer.from(String(d.d || ''), 'base64'); if (b.length === DESSIN_N * DESSIN_N) DESSIN = b; } catch {}
const dessinPose = new Map();   // nom du compte -> heure du dernier pixel
let dessinSale = null;
const sauverDessin = () => { clearTimeout(dessinSale); dessinSale = setTimeout(() => { try { fs.writeFileSync(FICHIER_DESSIN, JSON.stringify({ d: DESSIN.toString('base64') })); } catch (e) { console.error('[dessin]', e.message); } }, 5000); };
const dessinAttente = moi => !moi.compte || moi.compte.admin ? 0 : Math.max(0, DESSIN_DELAI - (Date.now() - (dessinPose.get(moi.compte.nom) || 0)));
function dessiner(moi, m) {
  if (!moi.compte) return;
  if (m.t === 'dessin') { envoyer(moi.ws, { t: 'dessin', d: DESSIN.toString('base64'), att: dessinAttente(moi) }); return; }
  if (m.raz) {                                                                      // tout effacer : admins seulement
    if (!moi.compte.admin) return;
    DESSIN.fill(0); sauverDessin(); console.log(`[dessin] ${moi.compte.nom} efface la toile`);
    diffuserPartout({ t: 'dessin', d: DESSIN.toString('base64') }); return;
  }
  const x = m.x | 0, y = m.y | 0, c = m.c | 0;
  if (!(x >= 0 && x < DESSIN_N && y >= 0 && y < DESSIN_N && c >= 0 && c < DESSIN_COULEURS && Number.isInteger(m.x) && Number.isInteger(m.y) && Number.isInteger(m.c))) return;
  const att = dessinAttente(moi);
  if (att > 0) { envoyer(moi.ws, { t: 'px', non: 1, att }); return; }
  if (!moi.compte.admin) dessinPose.set(moi.compte.nom, Date.now());
  DESSIN[y * DESSIN_N + x] = c; sauverDessin();
  envoyer(moi.ws, { t: 'px', x, y, c, moi: 1, att: dessinAttente(moi) });
  diffuserPartout({ t: 'px', x, y, c }, moi);
}
// ---------- hôtel des ventes : les joueurs vendent leurs objets entre eux, contre des pièces ----------
// Le serveur garde l'objet en dépôt (il doit disparaître du sac du vendeur), le donne à l'acheteur (qui doit payer), puis verse l'or au vendeur, moins la taxe.
db.exec(`CREATE TABLE IF NOT EXISTS ventes (id INTEGER PRIMARY KEY AUTOINCREMENT, vendeur INTEGER NOT NULL, nom TEXT NOT NULL, objet TEXT NOT NULL, prix INTEGER NOT NULL, quand INTEGER NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS ventes_dus (id INTEGER PRIMARY KEY AUTOINCREMENT, compte INTEGER NOT NULL, ors INTEGER NOT NULL DEFAULT 0, objet TEXT, quand INTEGER NOT NULL)`);
const HV = { TAXE: 0.05, MAX: 10, DUREE: 7 * 86400000,
  liste: db.prepare('SELECT id, vendeur, nom, objet, prix, quand FROM ventes ORDER BY id DESC LIMIT 300'), une: db.prepare('SELECT * FROM ventes WHERE id = ?'), de: db.prepare('SELECT * FROM ventes WHERE vendeur = ?'),
  ins: db.prepare('INSERT INTO ventes (vendeur, nom, objet, prix, quand) VALUES (?, ?, ?, ?, ?)'), del: db.prepare('DELETE FROM ventes WHERE id = ?'),
  duIns: db.prepare('INSERT INTO ventes_dus (compte, ors, objet, quand) VALUES (?, ?, ?, ?)'), duDe: db.prepare('SELECT * FROM ventes_dus WHERE compte = ?'), duDel: db.prepare('DELETE FROM ventes_dus WHERE id = ?') };
function hvListe(moi) { const l = HV.liste.all().map(v => { let it = null; try { it = JSON.parse(v.objet); } catch {} return it ? { id: v.id, n: v.nom, it, prix: v.prix, moi: v.vendeur === moi.compte.id ? 1 : 0, j: Math.max(0, Math.ceil((v.quand + HV.DUREE - Date.now()) / 86400000)) } : null; }).filter(Boolean);
  return { t: 'hv', a: 'liste', l, taxe: HV.TAXE, max: HV.MAX }; }
function hvRendre(moi, it) { const cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id)); butin.noter(cpt.dons, it); envoyer(moi.ws, { t: 'hv', a: 'retour', it }); }
// à la connexion : or des ventes conclues pendant l'absence, objets invendus depuis 7 jours
function hvConnexion(moi) {
  try { const cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id)); let or = 0, n = 0;
    for (const d of HV.duDe.all(moi.compte.id)) { HV.duDel.run(d.id); if (d.objet) { try { hvRendre(moi, JSON.parse(d.objet)); } catch {} } else { or += d.ors | 0; n++; } }
    if (or > 0) { cpt.dons.or += or; envoyer(moi.ws, { t: 'hv', a: 'paye', or, n }); }
    for (const v of HV.de.all(moi.compte.id)) if (Date.now() - v.quand > HV.DUREE) { HV.del.run(v.id); try { hvRendre(moi, JSON.parse(v.objet)); } catch {} }
  } catch (e) { console.error('[ventes] connexion', e.message); } }
function hotelDesVentes(moi, m) {
  if (!moi.compte) return; const rep = o => envoyer(moi.ws, Object.assign({ t: 'hv' }, o)), R = arbitre.regles();
  if (m.a === 'dus') { if (Date.now() - (moi.dusT || 0) < 3000) return; moi.dusT = Date.now(); hvConnexion(moi); return parrConnexion(moi); } // demandé par le jeu une fois le héros chargé
  if (Date.now() - (moi.hvT || 0) < 400) return; moi.hvT = Date.now();
  const cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id));
  try {
    if (m.a === 'liste') return envoyer(moi.ws, hvListe(moi));
    if (m.a === 'vendre') {
      const prix = Math.floor(+m.prix); if (!(prix >= 1 && prix <= 10000000)) return rep({ a: 'depot', ok: 0, msg: 'Prix entre 1 et 10 000 000 pièces' });
      if (HV.de.all(moi.compte.id).length >= HV.MAX) return rep({ a: 'depot', ok: 0, msg: HV.MAX + ' ventes au maximum à la fois' });
      let sv = null; try { const row = sql.parId.get(moi.compte.id); sv = row && row.save ? JSON.parse(row.save) : null; } catch {}
      if (!sv || !R) return rep({ a: 'depot', ok: 0, msg: 'Sauvegarde introuvable, réessaie' });
      const prep = butin.preparerEchange(sv, [m.it]); if (!prep.length) return rep({ a: 'depot', ok: 0, msg: 'Objet pas encore enregistré : réessaie dans deux secondes' });
      if (prep[0].recu.slot === 'conso') return rep({ a: 'depot', ok: 0, msg: 'Les potions ne se vendent pas ici' });
      const { recu, sigDonneur } = prep[0], e = cpt.aPerdre.find(x => x.sig === sigDonneur), dispo = e ? e.max : butin.compterSig(sv, sigDonneur);
      if (dispo < 1) return rep({ a: 'depot', ok: 0, msg: 'Objet pas encore enregistré : réessaie dans deux secondes' });
      if (e) { e.max = dispo - 1; e.t = Date.now(); } else cpt.aPerdre.push({ sig: sigDonneur, max: dispo - 1, t: Date.now() });
      HV.ins.run(moi.compte.id, String((moi.etat && moi.etat.n) || moi.compte.nom).slice(0, 16), JSON.stringify(recu), prix, Date.now());
      console.log(`[ventes] ${moi.compte.nom} met en vente ${recu.kind} T${recu.tier} pour ${prix}`);
      rep({ a: 'depot', ok: 1, i: m.i | 0 }); return envoyer(moi.ws, hvListe(moi));
    }
    if (m.a === 'retirer') { const v = HV.une.get(m.id | 0); if (!v || v.vendeur !== moi.compte.id) return rep({ a: 'retour', ok: 0, msg: 'Vente introuvable' }); HV.del.run(v.id); hvRendre(moi, JSON.parse(v.objet)); return envoyer(moi.ws, hvListe(moi)); }
    if (m.a === 'acheter') {
      const v = HV.une.get(m.id | 0); if (!v) { rep({ a: 'achat', ok: 0, msg: 'Trop tard : cet objet vient d\'être vendu' }); return envoyer(moi.ws, hvListe(moi)); }
      if (v.vendeur === moi.compte.id) return rep({ a: 'achat', ok: 0, msg: 'C\'est ta propre vente' });
      let sv = null; try { const row = sql.parId.get(moi.compte.id); sv = row && row.save ? JSON.parse(row.save) : null; } catch {}
      const du = (cpt.achats || []).reduce((a, x) => a + x.prix, 0); if (!sv || (sv.gold | 0) - du < v.prix) return rep({ a: 'achat', ok: 0, msg: 'Pas assez de pièces' });
      const it = JSON.parse(v.objet); HV.del.run(v.id);
      butin.noter(cpt.dons, it); (cpt.achats || (cpt.achats = [])).push({ sig: butin.signature(it), prix: v.prix, t: Date.now() });
      rep({ a: 'achat', ok: 1, it, prix: v.prix });
      const net = Math.max(1, Math.floor(v.prix * (1 - HV.TAXE))), vend = enLigne.get(v.vendeur);
      if (vend && vend.ws.readyState === 1) { (vend.cpt || (vend.cpt = etatCompte(v.vendeur))).dons.or += net; envoyer(vend.ws, { t: 'hv', a: 'paye', or: net, n: 1, nom: it.name }); } else HV.duIns.run(v.vendeur, net, null, Date.now());
      console.log(`[ventes] ${moi.compte.nom} achète ${it.kind} T${it.tier} à ${v.nom} pour ${v.prix}`);
      return envoyer(moi.ws, hvListe(moi));
    }
  } catch (e) { console.error('[ventes]', e.message); }
}
// à chaque sauvegarde : un objet acheté qui apparaît doit avoir été payé
function hvAPayer(cpt, ancien, nouveau) { let tot = 0; for (const a of (cpt.achats || [])) { a.vu = butin.compterSig(nouveau, a.sig) > butin.compterSig(ancien, a.sig); if (a.vu) tot += a.prix; } return tot; }

// ---------- parrainage : un nouveau joueur désigne son parrain, les deux sont récompensés quand le filleul progresse ----------
db.exec(`CREATE TABLE IF NOT EXISTS parrainage (filleul INTEGER PRIMARY KEY, parrain INTEGER NOT NULL, quand INTEGER NOT NULL, palier INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE IF NOT EXISTS parrainage_dus (id INTEGER PRIMARY KEY AUTOINCREMENT, compte INTEGER NOT NULL, cursite INTEGER NOT NULL, nom TEXT, niv INTEGER)`);
const PARR = { PALIERS: [], // récompenses de niveau retirées : le parrain gagnera de la Cursite sur les achats de ses filleuls quand la boutique sera en place
  MAX: 10, DELAI: 7 * 86400000,
  get: db.prepare('SELECT * FROM parrainage WHERE filleul = ?'), de: db.prepare('SELECT p.filleul, p.palier, c.nom, c.save FROM parrainage p JOIN comptes c ON c.id = p.filleul WHERE p.parrain = ? ORDER BY p.quand'),
  ins: db.prepare('INSERT INTO parrainage (filleul, parrain, quand) VALUES (?, ?, ?)'), maj: db.prepare('UPDATE parrainage SET palier = ? WHERE filleul = ?'),
  duIns: db.prepare('INSERT INTO parrainage_dus (compte, cursite, nom, niv) VALUES (?, ?, ?, ?)'), duDe: db.prepare('SELECT * FROM parrainage_dus WHERE compte = ?'), duDel: db.prepare('DELETE FROM parrainage_dus WHERE id = ?') };
const nivMax = sv => { let n = 0; try { for (const ch of Object.values((sv && sv.chars) || {})) n = Math.max(n, (ch && ch.lvl) | 0); } catch {} return Math.min(25, n); };
function etatParrainage(moi) {
  const c = sql.parId.get(moi.compte.id), lien = PARR.get.get(moi.compte.id), par = lien ? sql.parId.get(lien.parrain) : null;
  const fl = PARR.de.all(moi.compte.id).map(f => { let sv = null; try { sv = f.save ? JSON.parse(f.save) : null; } catch {} return { n: f.nom, niv: nivMax(sv), p: f.palier }; });
  return { t: 'parr', a: 'etat', parrain: par ? par.nom : null, palier: lien ? lien.palier : 0, peut: !lien && !!c && Date.now() - c.cree < PARR.DELAI ? 1 : 0, filleuls: fl, paliers: PARR.PALIERS, max: PARR.MAX };
}
function parrainage(moi, m) {
  if (!moi.compte) return; if (Date.now() - (moi.parrT || 0) < 500) return; moi.parrT = Date.now();
  try {
    if (m.a === 'etat') return envoyer(moi.ws, etatParrainage(moi));
    if (m.a === 'choisir') {
      const non = msg => envoyer(moi.ws, { t: 'parr', a: 'choix', ok: 0, msg }), c = sql.parId.get(moi.compte.id), p = sql.parNom.get(String(m.nom || '').trim().slice(0, 16));
      if (PARR.get.get(moi.compte.id)) return non('Tu as déjà un parrain');
      if (!c || Date.now() - c.cree > PARR.DELAI) return non('Le parrain se choisit pendant les 7 premiers jours du compte');
      if (!p) return non('Aucun compte ne porte ce nom');
      if (p.id === c.id) return non('Tu ne peux pas te parrainer toi-même');
      if (p.cree >= c.cree) return non('Ton parrain doit avoir un compte plus ancien que le tien');
      if (PARR.de.all(p.id).length >= PARR.MAX) return non('Ce joueur a déjà ' + PARR.MAX + ' filleuls');
      PARR.ins.run(c.id, p.id, Date.now()); console.log(`[parrainage] ${c.nom} choisit ${p.nom} comme parrain`);
      envoyer(moi.ws, { t: 'parr', a: 'choix', ok: 1, nom: p.nom }); envoyer(moi.ws, etatParrainage(moi));
      const P = enLigne.get(p.id); if (P && P.ws.readyState === 1) { envoyer(P.ws, { t: 'parr', a: 'nouveau', nom: c.nom }); envoyer(P.ws, etatParrainage(P)); }
      let sv = null; try { sv = c.save ? JSON.parse(c.save) : null; } catch {} if (sv) parrPaliers(moi, sv);
    }
  } catch (e) { console.error('[parrainage]', e.message); }
}
// à chaque sauvegarde acceptée : le filleul a-t-il franchi un palier de niveau ?
function parrPaliers(moi, sv) {
  try { const lien = PARR.get.get(moi.compte.id); if (!lien || lien.palier >= PARR.PALIERS.length) return; const niv = nivMax(sv); let p = lien.palier;
    while (p < PARR.PALIERS.length && niv >= PARR.PALIERS[p][0]) { const [seuil, cu] = PARR.PALIERS[p]; p++; PARR.maj.run(p, moi.compte.id);
      const cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id)); cpt.dons.cursite += cu; envoyer(moi.ws, { t: 'parr', a: 'gain', cursite: cu, niv: seuil, moi: 1 });
      const P = enLigne.get(lien.parrain);
      if (P && P.ws.readyState === 1) { (P.cpt || (P.cpt = etatCompte(lien.parrain))).dons.cursite += cu; envoyer(P.ws, { t: 'parr', a: 'gain', cursite: cu, niv: seuil, nom: moi.compte.nom }); envoyer(P.ws, etatParrainage(P)); }
      else PARR.duIns.run(lien.parrain, cu, moi.compte.nom, seuil);
      console.log(`[parrainage] ${moi.compte.nom} atteint le niveau ${seuil} : +${cu} Cursite pour lui et son parrain`); }
  } catch (e) { console.error('[parrainage] palier', e.message); }
}
function parrConnexion(moi) { try { const cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id)); for (const d of PARR.duDe.all(moi.compte.id)) { PARR.duDel.run(d.id); cpt.dons.cursite += d.cursite; envoyer(moi.ws, { t: 'parr', a: 'gain', cursite: d.cursite, niv: d.niv, nom: d.nom }); } } catch (e) { console.error('[parrainage] connexion', e.message); } }

// ---------- maisons : on visite la maison meublée des autres joueurs et on y laisse un cœur ----------
db.exec(`CREATE TABLE IF NOT EXISTS maison_coeurs (maison INTEGER NOT NULL, de INTEGER NOT NULL, quand INTEGER NOT NULL, PRIMARY KEY (maison, de))`);
const MAISON = { nb: db.prepare('SELECT COUNT(*) AS n FROM maison_coeurs WHERE maison = ?'), a: db.prepare('SELECT 1 AS x FROM maison_coeurs WHERE maison = ? AND de = ?'), ins: db.prepare('INSERT OR IGNORE INTO maison_coeurs (maison, de, quand) VALUES (?, ?, ?)'),
  top20: db.prepare('SELECT m.maison AS id, COUNT(*) AS n, c.nom AS nom FROM maison_coeurs m JOIN comptes c ON c.id = m.maison GROUP BY m.maison ORDER BY n DESC, m.maison LIMIT 20') };
function planMaison(c, moi) {
  let sv = null; try { sv = c.save ? JSON.parse(c.save) : null; } catch {} sv = sv || {};
  const h = (sv.house && typeof sv.house === 'object') ? sv.house : {}, vus = new Set(), m = [];
  const salle = h.salle ? 1 : 0;
  for (const e of (Array.isArray(h.m) ? h.m : []).slice(0, salle ? 140 : 80)) { if (!Array.isArray(e)) continue; const id = String(e[0] || ''), x = e[1] | 0, y = e[2] | 0; if (!/^[a-zA-Z0-9]{1,12}$/.test(id) || x < (salle ? -15 : 1) || x > 25 || y < 1 || y > 16 || vus.has(x + ',' + y)) continue; vus.add(x + ',' + y); m.push([id, x, y, e[3] & 3]); }
  const pets = (Array.isArray(sv.pets) ? sv.pets : []).filter(q => q && q.id !== sv.petEq).slice(0, 12).map(q => ({ k: String(q.k || '').slice(0, 16), t: Math.max(0, Math.min(3, q.t | 0)) }));
  const lig = enLigne.get(c.id);
  return { t: 'maison', a: 'plan', ok: 1, id: c.id, n: String((lig && lig.etat && lig.etat.n) || c.nom).slice(0, 16), skin: String(h.skin || 'bois').slice(0, 12), salle, m, coffres: Math.max(1, Math.min(10, (sv.vault && sv.vault.n) | 0 || 1)), pets,
    coeurs: MAISON.nb.get(c.id).n, aime: MAISON.a.get(c.id, moi.compte.id) ? 1 : 0, moi: c.id === moi.compte.id ? 1 : 0 };
}
function maison(moi, m, salle) {
  if (!moi.compte) return; if (Date.now() - (moi.maisT || 0) < 500) return; moi.maisT = Date.now();
  try {
    const nomDe = j => String((j.etat && j.etat.n) || j.compte.nom).slice(0, 16);
    if (m.a === 'voir') {
      let c = null; if (m.peer) { const j = salle && salle.get(String(m.peer)); if (j && j.compte) c = sql.parId.get(j.compte.id); } else if (m.id) c = sql.parId.get(m.id | 0); else if (m.nom) c = sql.parNom.get(String(m.nom).trim().slice(0, 16));
      if (!c) return envoyer(moi.ws, { t: 'maison', a: 'plan', ok: 0, msg: m.peer ? 'Ce joueur n\'a pas de compte' : 'Aucune maison à ce nom' });
      envoyer(moi.ws, planMaison(c, moi));
      const P = enLigne.get(c.id); if (P && P !== moi && P.ws.readyState === 1 && Date.now() - ((moi.visites || (moi.visites = {}))[c.id] || 0) > 120000) { moi.visites[c.id] = Date.now(); envoyer(P.ws, { t: 'maison', a: 'visite', n: nomDe(moi) }); }
      return;
    }
    if (m.a === 'coeur') {
      const c = sql.parId.get(m.id | 0); if (!c || c.id === moi.compte.id) return envoyer(moi.ws, { t: 'maison', a: 'coeur', ok: 0, msg: c ? 'C\'est ta propre maison' : 'Maison introuvable' });
      const r = MAISON.ins.run(c.id, moi.compte.id, Date.now()), n = MAISON.nb.get(c.id).n;
      if (!r.changes) return envoyer(moi.ws, { t: 'maison', a: 'coeur', ok: 0, n, msg: 'Tu as déjà laissé un cœur dans cette maison' });
      envoyer(moi.ws, { t: 'maison', a: 'coeur', ok: 1, n, id: c.id });
      const P = enLigne.get(c.id); if (P && P.ws.readyState === 1) envoyer(P.ws, { t: 'maison', a: 'aime', n: nomDe(moi), c: n });
    }
  } catch (e) { console.error('[maison]', e.message); }
}

// ---------- heure de Paris (semaine d'objectif, dimanche de pêche) ----------
function paris() { const t = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }), [d, h] = t.split(' '), [y, m, j] = d.split('-').map(Number);
  const jr = new Date(Date.UTC(y, m - 1, j)), js = process.env.FAUX_DIMANCHE ? 0 : jr.getUTCDay(), /* FAUX_DIMANCHE : pour les essais */ lundi = new Date(jr.getTime() - ((js + 6) % 7) * 86400000);
  return { jour: d, js, semaine: lundi.toISOString().slice(0, 10), heure: +h.slice(0, 2) }; }

// ---------- objectif commun de la semaine : tous les monstres tués sur le serveur ; une fois atteint, +10 % d'expérience pour tout le monde jusqu'à dimanche soir ----------
const OBJECTIF = { semaine: paris().semaine, n: 0, but: Math.max(100, +process.env.OBJECTIF_SEMAINE || 5000), atteint: 0 }, OBJECTIF_BONUS = 1.10;
const FICHIER_OBJECTIF = path.join(DATA_DIR, 'objectif.json');
try { const o = JSON.parse(fs.readFileSync(FICHIER_OBJECTIF, 'utf8')); if (o && o.semaine === OBJECTIF.semaine) { OBJECTIF.n = o.n | 0; OBJECTIF.atteint = +o.atteint || 0; } } catch {}
let objectifSale = false, objectifVu = -1;
const etatObjectif = () => ({ t: 'objectif', n: OBJECTIF.n, but: OBJECTIF.but, ok: OBJECTIF.atteint ? 1 : 0, bonus: Math.round((OBJECTIF_BONUS - 1) * 100) });
function objectifTue() {
  const sem = paris().semaine; if (sem !== OBJECTIF.semaine) { OBJECTIF.semaine = sem; OBJECTIF.n = 0; OBJECTIF.atteint = 0; }
  OBJECTIF.n++; objectifSale = true;
  if (!OBJECTIF.atteint && OBJECTIF.n >= OBJECTIF.but) { OBJECTIF.atteint = Date.now(); console.log('[objectif] atteint : ' + OBJECTIF.n + ' monstres'); diffuserPartout(Object.assign(etatObjectif(), { bravo: 1 })); objectifVu = OBJECTIF.n; }
}
const bonusObjectif = () => OBJECTIF.atteint && paris().semaine === OBJECTIF.semaine ? OBJECTIF_BONUS : 1;
setInterval(() => { if (objectifSale) { objectifSale = false; try { fs.writeFileSync(FICHIER_OBJECTIF, JSON.stringify({ semaine: OBJECTIF.semaine, n: OBJECTIF.n, atteint: OBJECTIF.atteint })); } catch (e) { console.error('[objectif]', e.message); } }
  if (paris().semaine !== OBJECTIF.semaine) { OBJECTIF.semaine = paris().semaine; OBJECTIF.n = 0; OBJECTIF.atteint = 0; objectifSale = true; }
  if (objectifVu !== OBJECTIF.n) { objectifVu = OBJECTIF.n; diffuserPartout(etatObjectif()); } }, 20000).unref();

// ---------- tournoi de pêche du dimanche : le plus gros poisson de la journée ; le vainqueur porte le titre « Roi de la pêche » toute la semaine ----------
const POISSONS = {}; { const re = /\['(lac|mer)','(\w+)','(?:[^'\\]|\\.)*',(\d),([\d.]+),([\d.]+),/g, txt = INDEX.toString('utf8'); let m; while ((m = re.exec(txt))) POISSONS[m[2]] = { r: +m[3], min: +m[4], max: +m[5] }; }
const TOURNOI = { jour: '', best: {}, roi: null };
const FICHIER_TOURNOI = path.join(DATA_DIR, 'peche.json');
try { const o = JSON.parse(fs.readFileSync(FICHIER_TOURNOI, 'utf8')); if (o) { TOURNOI.jour = String(o.jour || ''); TOURNOI.best = o.best || {}; TOURNOI.roi = o.roi || null; } } catch {}
const sauverTournoi = () => { try { fs.writeFileSync(FICHIER_TOURNOI, JSON.stringify(TOURNOI)); } catch (e) { console.error('[pêche]', e.message); } };
const tournoiActif = () => paris().js === 0;
function tournoiCloture() { // le dimanche est passé : on couronne le vainqueur
  const P = paris(); if (!TOURNOI.jour || TOURNOI.jour === P.jour) return;
  const l = Object.entries(TOURNOI.best).sort((a, b) => b[1].w - a[1].w);
  if (l.length) { TOURNOI.roi = { compte: l[0][0], n: l[0][1].n, w: l[0][1].w, f: l[0][1].f, jour: TOURNOI.jour }; console.log(`[pêche] roi de la pêche : ${l[0][0]} (${l[0][1].w} kg)`); }
  TOURNOI.jour = ''; TOURNOI.best = {}; sauverTournoi(); diffuserPartout(etatTournoi());
}
// le titre ne dure qu'une semaine : il tombe au dimanche suivant
const roiPeche = () => TOURNOI.roi && (Date.now() - Date.parse(TOURNOI.roi.jour + 'T00:00:00Z') < 8 * 86400000) ? TOURNOI.roi : null;
const etatTournoi = moi => { const r = roiPeche(); return { t: 'tournoi', actif: tournoiActif() ? 1 : 0, top: Object.values(TOURNOI.best).sort((a, b) => b.w - a.w).slice(0, 10).map(e => ({ n: e.n, w: e.w, f: e.f })), roi: r ? { n: r.n, w: r.w, f: r.f } : null, roiMoi: !!(moi && moi.compte && r && r.compte === moi.compte.nom) }; };
function tournoiPrise(moi, m) {
  if (!moi.compte) return; tournoiCloture(); if (!tournoiActif()) return;
  const f = POISSONS[String(m.f || '')], w = Math.round((+m.w || 0) * 1000) / 1000; if (!f || !(w >= f.min && w <= f.max)) return;
  const now = Date.now(); if (now - (moi.tournoiT || 0) < 4000 || (f.r >= 3 && now - (moi.tournoiR || 0) < 45000)) return; moi.tournoiT = now; if (f.r >= 3) moi.tournoiR = now;
  const P = paris(); if (TOURNOI.jour !== P.jour) { TOURNOI.jour = P.jour; TOURNOI.best = {}; }
  const cur = TOURNOI.best[moi.compte.nom]; if (cur && cur.w >= w) return;
  const avant = Object.values(TOURNOI.best).reduce((a, e) => Math.max(a, e.w), 0);
  TOURNOI.best[moi.compte.nom] = { n: String((moi.etat && moi.etat.n) || moi.compte.nom).slice(0, 16), w, f: String(m.f) }; sauverTournoi();
  if (w > avant) diffuserPartout(Object.assign(etatTournoi(), { tete: TOURNOI.best[moi.compte.nom].n })); else envoyer(moi.ws, etatTournoi(moi));
}
setInterval(tournoiCloture, 60000).unref();

function utiliserCle(moi, salle) {
  if (!moi.compte) return;
  const rep = (ok, msg, id) => envoyer(moi.ws, { t: 'cle', ok, msg, id });
  if (Date.now() - (moi.cleT || 0) < 2000) return rep(false, 'Patiente un instant');
  moi.cleT = Date.now();
  if (!moi.compte.admin) {
    let sv = null; try { const row = sql.parId.get(moi.compte.id); sv = row && row.save ? JSON.parse(row.save) : null; } catch { sv = null; }
    const R = arbitre.regles(); if (!sv || !R || !R.KINDS.cle) return rep(false, 'Clef indisponible');
    const sig = butin.signature(R.mkItem('cle', 0)), cpt = moi.cpt || (moi.cpt = etatCompte(moi.compte.id));
    const e = cpt.aPerdre.find(x => x.sig === sig), dispo = e ? e.max : butin.compterSig(sv, sig);
    if (dispo < 1) return rep(false, 'Clef pas encore enregistrée : réessaie dans deux secondes');
    if (e) { e.max = dispo - 1; e.t = Date.now(); } else cpt.aPerdre.push({ sig, max: dispo - 1, t: Date.now() });
  }
  const id = 1 + crypto.randomInt(2000000000);
  ticketsCle.set(salle + '|dh' + id.toString(36), Date.now() + 2 * 3600000);
  console.log(`[clef] ${moi.compte.nom} ouvre l'Horloge Brisée (${salle})`);
  rep(true, '', id);
}
function demanderDonjon(salle, sc) {
  if (!gardienProc || !/^d[a-z][0-9a-z]{1,10}$/.test(sc) || !ticketOk(salle, sc)) return;
  const k = salle + '|' + sc, d = donjonsGardes.get(k); if (d) { d.vu = Date.now(); return; }
  donjonsGardes.set(k, { t: Date.now(), vu: Date.now(), salle, sc });
  try { gardienProc.send({ t: 'donjon', salle, s: sc }); } catch {}
}
const salleVue = new Map(); // salle -> dernier moment où un joueur y était
setInterval(() => {
  const occ = new Set();
  for (const [nomS, salle] of salles) for (const j of salle.values()) if (!j.gardien && !j.bot) { salleVue.set(nomS, Date.now()); if (j.etat && typeof j.etat.s === 'string') occ.add(nomS + '|' + j.etat.s); }
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
  butin.reclamer(moi, m, { salle: nom, membres: salle, gardien: G, sansClef: sc[0] === 'd' && !ticketOk(nom, sc) && !moi.compte.admin, boost: moi.cpt.boost || 0, onRefus: r => noterSuspect(moi, 'kill', 1, 'Monstre refusé : ' + r), dons: moi.dons, rythme: moi.cpt.rythme, envoyer, boostServeur: bonusObjectif(), onTue: (key, s) => { concoursTue(moi, key, s); objectifTue(); }, signaler: r => { try { sql.anoIns.run(moi.compte.id, moi.compte.nom, Date.now(), JSON.stringify(r)); } catch {} } });
}
