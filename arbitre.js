// Royaume Maudit — l'arbitre : le serveur vérifie chaque sauvegarde envoyée par un joueur.
// Étape 1 de l'anti-triche : rien n'entre dans la base de données sans être cohérent avec
// la sauvegarde précédente (objets valides, monnaies justifiées, progression à un rythme humain).
// Les règles du jeu (objets, classes, potions…) sont lues directement dans public/index.html :
// elles restent toujours synchronisées avec la version du jeu en ligne.
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- lecture des règles du jeu depuis index.html ----------
function chargerRegles(html) {
  const a = html.indexOf('/* ================= données de jeu ================= */');
  const b = html.indexOf('/* ---------- monstres ----------');
  if (a < 0 || b < 0) throw new Error('Règles introuvables dans index.html');
  // bac à sable permissif : tout ce qui touche au dessin est remplacé par une fonction vide
  const noop = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : k === 'length' ? 0 : noop, apply: () => noop, construct: () => noop, set: () => true });
  const bac = () => {
    const base = { Math, JSON, Object, Array, String, Number, Set, Map, Symbol, parseInt, parseFloat, isFinite, console,
      pick: x => x[Math.floor(Math.random() * x.length)], clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)), rnd: (lo, hi) => lo + Math.random() * (hi - lo), ri: (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1)) };
    return new Proxy(base, { has: () => true, get: (t, k) => k in t ? t[k] : (k === Symbol.unscopables ? undefined : noop), set: (t, k, v) => { t[k] = v; return true; } });
  };
  const code = html.slice(a, b);
  let R;
  // étape 2 : on lit aussi les monstres, les zones et les donjons (butin tiré par le serveur)
  try {
    const c = html.indexOf('const MKEYS=Object.keys(MON);'), z0 = html.indexOf('const ZONES=['), z1 = html.indexOf('const DUNGEON_POOL='), d0 = html.indexOf('const DTYPES={'), d1 = html.indexOf('const REG_DUN=');
    if (c < 0 || z0 < 0 || z1 < 0 || d0 < 0 || d1 < 0) throw new Error('monstres introuvables');
    const code2 = code + '\n' + html.slice(b, c) + '\nconst MKEYS=Object.keys(MON);\n' + html.slice(z0, z1) + '\n' + html.slice(d0, d1);
    R = new Function('__G', 'with(__G){' + code2 + '\n;return {KINDS,CLASSES,SK,SP_DEF,mkItem,MON,MKEYS,ZONES,DTYPES,WB};}')(bac());
  } catch (e) {
    console.error('[arbitre] monstres non chargés (butin serveur désactivé) :', e.message);
    R = new Function('__G', 'with(__G){' + code + '\n;return {KINDS,CLASSES,SK,SP_DEF,mkItem,WB};}')(bac());
  }
  const nombres = (re, def) => { const m = html.match(re); if (!m) return def; try { return JSON.parse(m[1].replace(/(\d+):/g, '"$1":')); } catch { return def; } };
  R.VAULT_PRICES = nombres(/const VAULT_PRICES=(\[[^\]]*\])/, [0, 50, 40, 60, 80, 100, 150, 200, 300, 500]);
  R.CAP_COST = nombres(/const CAP_COST=(\{[^}]*\})/, { 21: 1000, 22: 2500, 23: 3500, 24: 5000, 25: 6000 });
  R.SELL_PRICE = nombres(/SELL_PRICE=(\[[^\]]*\])/, [0, 0, 0, 1, 3, 5, 10, 25]);
  { const m = html.match(/const need=l=>([^;\n]+);/); try { R.need = new Function('l', 'return ' + (m ? m[1] : '(40+l*l*8+l*20)*(l>=20?2:1)')); } catch { R.need = l => (40 + l * l * 8 + l * 20) * (l >= 20 ? 2 : 1); } }
  { const m = html.match(/GLORY_XP=(\d+)/); R.GLORY_XP = m ? +m[1] : 4000; }
  { const m = html.match(/BOOST_PRIX=(\d+)/); R.BOOST_PRIX = m ? +m[1] : 100; }
  { const m = html.match(/WQ_BONUS=(\d+)/); R.WQ_BONUS = m ? +m[1] : 150; }
  R.PET_KEYS = ['vie', 'mana', 'puissance', 'vatt', 'vdep', 'armure'];
  return R;
}

let R = null;
try { R = chargerRegles(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')); }
catch (e) { console.error('[arbitre] règles non chargées :', e.message); }

// objets déjà vus dans des sauvegardes acceptées (ex. un vieil objet reçu par échange reste valable)
const CONNUS = new Set();
function apprendre(s) { try { for (const it of objets(s)) CONNUS.add(signature(it)); } catch {} }

// ---------- outils ----------
const estEntier = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const estNombre = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
const memeStats = (a, b) => { const ka = Object.keys(a || {}).filter(k => a[k]), kb = Object.keys(b || {}).filter(k => b[k]); if (ka.length !== kb.length) return false; for (const k of ka) if (Math.abs((a[k] || 0) - (b[k] || 0)) > 0.051) return false; return true; };
const signature = it => it.kind + '|' + it.tier + '|' + JSON.stringify(Object.keys(it.stats || {}).sort().map(k => [k, it.stats[k]]));
const prestigeGain = ch => { const spT = Object.values(ch.sp || {}).reduce((a, v) => a + (v | 0), 0); return (ch.lvl | 0) + Math.floor((ch.kills | 0) / 25) + 2 * spT + 3 * (ch.bosses | 0) + 2 * (ch.gp | 0); };

// objet valide ? (comparé à ce que le jeu fabrique pour le même type et le même tier)
function objetValide(it) {
  if (it === null) return null;
  if (!it || typeof it !== 'object') return 'objet illisible';
  const K = R.KINDS[it.kind];
  if (!K) return 'type d\'objet inconnu : ' + String(it.kind).slice(0, 20);
  if (!estEntier(it.tier, 0, 7)) return 'tier impossible';
  if (it.slot !== K.slot) return 'emplacement incohérent';
  if (it.stats && typeof it.stats !== 'object') return 'statistiques illisibles';
  if (K.slot === 'conso') { if (Object.keys(it.stats || {}).some(k => it.stats[k])) return 'consommable avec statistiques'; return null; }
  const ref = R.mkItem(it.kind, it.tier);
  if (K.slot === 'anneau') {
    const amt = k => (k === 'vie' || k === 'mana') ? 15 + 15 * it.tier : 1 + it.tier;
    for (const k of Object.keys(it.stats || {})) {
      if (!R.SK.includes(k)) return 'anneau : statistique inconnue';
      const max = amt(k) + (it.tier >= 7 ? ((k === 'vie' || k === 'mana') ? 40 : 3) : 0);
      if (!estNombre(it.stats[k], 0, max + 0.01)) return 'anneau trop puissant';
    }
    return null;
  }
  if (!memeStats(it.stats, ref.stats)) return 'statistiques modifiées (' + it.kind + ' T' + it.tier + ')';
  if (ref.dmg && (!Array.isArray(it.dmg) || it.dmg[0] !== ref.dmg[0] || it.dmg[1] !== ref.dmg[1])) return 'dégâts modifiés';
  return null;
}

// reprise d'une ancienne sauvegarde : les formules ont pu changer depuis, on vérifie seulement des plafonds
let MAXS = null;
function objetBorne(it) {
  if (!it || typeof it !== 'object' || !R.KINDS[it.kind] || !estEntier(it.tier, 0, 7)) return 'objet impossible';
  if (!MAXS) { MAXS = {}; for (const k in R.KINDS) for (let t = 0; t <= 7; t++) for (let r = 0; r < 25; r++) { let x; try { x = R.mkItem(k, t); } catch { continue; } for (const s in x.stats) MAXS[s] = Math.max(MAXS[s] || 0, x.stats[s]); if (x.dmg) MAXS.dmg = Math.max(MAXS.dmg || 0, x.dmg[1]); } }
  for (const s of Object.keys(it.stats || {})) if (!estNombre(it.stats[s], 0, (MAXS[s] || 0) * 1.25 + 1)) return 'objet trop puissant';
  if (it.dmg && (!Array.isArray(it.dmg) || it.dmg[1] > MAXS.dmg * 1.25)) return 'arme trop puissante';
  return null;
}

// tous les objets d'une sauvegarde (héros + coffres)
function objets(s) {
  const out = [];
  for (const ch of Object.values(s.chars || {})) for (const it of [...(ch.equip || []), ...(ch.inv || [])]) if (it) out.push(it);
  for (const c of ((s.vault && s.vault.c) || [])) for (const it of c || []) if (it) out.push(it);
  return out;
}
const compter = list => { const m = new Map(); for (const it of list) { const k = signature(it); m.set(k, (m.get(k) || 0) + 1); } return m; };
const nbKind = (list, f) => list.filter(f).length;

// ---------- seaux de rythme (par compte, en mémoire) ----------
// chaque seau se remplit avec le temps ; une sauvegarde qui demande plus que le seau ne contient est refusée
const SEAUX = {
  or: { debit: 450, max: 4000 },          // pièces par minute
  niveaux: { debit: 1.5, max: 6 },        // niveaux gagnés (tous héros) par minute
  objets: { debit: 14, max: 45 },         // nouveaux objets par minute
  t6: { debit: 0.5, max: 6 },             // nouveaux objets tier 6
  reliques: { debit: 1 / 20, max: 3 },    // nouvelles reliques
  monstres: { debit: 60, max: 250 },      // monstres tués
  boss: { debit: 3, max: 12 },            // boss tués
  gloire: { debit: 2, max: 6 },           // points de gloire
};
function nouveauxSeaux() { const s = { t: Date.now() }; for (const k in SEAUX) s[k] = SEAUX[k].max; return s; }
function remplir(sx) { const now = Date.now(), dt = (now - sx.t) / 60000; sx.t = now; for (const k in SEAUX) sx[k] = Math.min(SEAUX[k].max, sx[k] + SEAUX[k].debit * dt); }

// jour serveur (même calcul que le jeu : un nombre par jour)
const jourDe = d => d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate();

// ---------- la vérification ----------
// ctx : { seaux, dons:{cursite,or,prestige,objets}, premiere (migration depuis le navigateur) }
function verifier(ancien, nouveau, ctx) {
  const pb = [];
  if (!R) return { ok: true };
  const deja = ancien && ancien.chars ? new Set(objets(ancien).map(signature)) : null;
  const ctrl = it => { if (it === null) return null; if (it && typeof it === 'object' && it.kind && (deja && deja.has(signature(it)) || CONNUS.has(signature(it)))) return null; return deja ? objetValide(it) : objetBorne(it); };
  if (!nouveau || typeof nouveau !== 'object' || !nouveau.chars || typeof nouveau.chars !== 'object') return { ok: false, raisons: ['sauvegarde illisible'] };
  // --- structure et objets ---
  for (const [cls, ch] of Object.entries(nouveau.chars)) {
    if (!R.CLASSES[cls]) { pb.push('classe inconnue'); continue; }
    if (!ch || typeof ch !== 'object') { pb.push('héros illisible'); continue; }
    const cap = Math.max(20, Math.min(25, nouveau.capLvl | 0 || 20));
    if (!estEntier(ch.lvl, 1, cap)) pb.push('niveau impossible (' + ch.lvl + ')');
    if (!Array.isArray(ch.equip) || ch.equip.length !== 4) pb.push('équipement illisible');
    if (!Array.isArray(ch.inv) || ![8, 16, 24].includes(ch.inv.length)) pb.push('sac illisible');
    for (const k of Object.keys(ch.sp || {})) { if (!R.SP_DEF[k] || !estEntier(ch.sp[k], 0, R.SP_DEF[k].n)) pb.push('potions de caractéristique impossibles'); }
    for (const it of [...(ch.equip || []), ...(ch.inv || [])]) { const e = ctrl(it); if (e) pb.push(e); }
  }
  if (nouveau.vault) {
    if (!estEntier(nouveau.vault.n, 1, 10) || !Array.isArray(nouveau.vault.c) || nouveau.vault.c.length > 10) pb.push('coffres illisibles');
    else for (const c of nouveau.vault.c) { if (!Array.isArray(c) || c.length > 8) { pb.push('coffre illisible'); continue; } for (const it of c) { const e = ctrl(it); if (e) pb.push(e); } }
  }
  for (const k of ['gold', 'cursite', 'prestige']) if (!estNombre(nouveau[k] ?? 0, 0, 1e9)) pb.push(k + ' impossible');
  if (nouveau.capLvl != null && !estEntier(nouveau.capLvl, 20, 25)) pb.push('niveau maximum impossible');
  for (const p of (nouveau.pets || [])) if (!p || !R.PET_KEYS.includes(p.k) || !estEntier(p.t | 0, 0, 3)) pb.push('familier impossible');
  if ((nouveau.titles || []).includes('admin')) pb.push('titre admin');
  if (pb.length) return { ok: false, raisons: [...new Set(pb)].slice(0, 6) };

  // une sauvegarde sans aucun héros ne remplace jamais des héros existants
  if (ancien && ancien.chars && Object.keys(ancien.chars).length && !Object.keys(nouveau.chars).length) return { ok: false, raisons: ['sauvegarde vide'] };
  // --- première sauvegarde (reprise depuis le navigateur) : plafonds raisonnables ---
  if (!ancien || !ancien.chars) {
    if ((nouveau.gold || 0) > 60000) pb.push('trop d\'or pour une reprise');
    if ((nouveau.cursite || 0) > 4000) pb.push('trop de Cursite pour une reprise');
    if ((nouveau.prestige || 0) > 30000) pb.push('trop de prestige pour une reprise');
    return pb.length ? { ok: false, raisons: pb } : { ok: true };
  }

  const sx = ctx.seaux; remplir(sx);
  const dons = ctx.dons || {};
  const today = jourDe(new Date());
  const d = (k) => (nouveau[k] || 0) - (ancien[k] || 0);

  // --- récompense de connexion du jour (jamais deux fois par jour serveur) ---
  let bonusCursite = 0, bonusObjets = 0, bonusReliques = 0, bonusT6 = 0;
  const L0 = ancien.login || { day: -9, n: 0 }, L1 = nouveau.login || L0;
  if (L1.day !== L0.day) {
    if (L1.day > today + 1 || L1.day < L0.day) pb.push('date de connexion trafiquée');
    else if ((L1.n | 0) > (L0.n | 0) + 1) pb.push('série de connexion trafiquée');
    else {
      const idx = L0.day === L1.day - 1 ? (L0.n | 0) % 7 : 0;
      if (idx === 0) bonusObjets += 4; if (idx === 1) bonusObjets += 5;
      if (idx === 2) bonusCursite += 100; if (idx === 4) bonusCursite += 150; if (idx === 5) bonusCursite += 75;
      if (idx === 3) { bonusObjets += 1; bonusT6 += 1; }
      if (idx === 6) { bonusObjets += 4; bonusReliques += 4; }
    }
  }
  // --- bonus des 3 quêtes du jour (+50 Cursite, une fois par jour) ---
  if (nouveau.quests && nouveau.quests.bonus && !(ancien.quests && ancien.quests.bonus && ancien.quests.day === nouveau.quests.day)) {
    if (Math.abs((nouveau.quests.day | 0) - today) > 1) pb.push('quêtes d\'un autre jour'); else bonusCursite += 50;
  }

  // --- bonus des 3 quêtes de la semaine (+150 Cursite, une fois par semaine) ---
  if (nouveau.wquests && nouveau.wquests.bonus && !(ancien.wquests && ancien.wquests.bonus && ancien.wquests.week === nouveau.wquests.week)) {
    const d0 = new Date(), sem = Math.floor((Math.floor((d0.getTime() - d0.getTimezoneOffset() * 60000) / 86400000) + 3) / 7);
    if (Math.abs((nouveau.wquests.week | 0) - sem) > 1) pb.push('quêtes d\'une autre semaine'); else bonusCursite += R.WQ_BONUS;
  }

  // --- prestige : seulement par une mort définitive (calcul exact) ou un don du serveur ---
  let presOk = (dons.prestige || 0);
  for (const [cls, ch0] of Object.entries(ancien.chars)) { const ch1 = nouveau.chars[cls]; if (!ch1 || ((ch1.lvl | 0) === 1 && (ch1.kills | 0) < (ch0.kills | 0))) presOk += prestigeGain(ch0); }
  // niveaux max achetés au Gardien du Prestige
  let presDepense = 0;
  for (let l = (ancien.capLvl | 0 || 20) + 1; l <= (nouveau.capLvl | 0 || 20); l++) presDepense += R.CAP_COST[l] || 99999;
  if (d('prestige') > presOk - presDepense + 0.5) pb.push(presDepense > 0 ? 'niveau maximum non payé' : 'prestige injustifié (+' + Math.round(d('prestige')) + ')');

  // --- Cursite : jamais créée par le joueur ---
  const skins0 = Object.keys(ancien.skins || {}).length, skins1 = Object.keys(nouveau.skins || {}).length;
  let cursiteDepenseMin = Math.max(0, skins1 - skins0) * 100;
  // boost d'expérience acheté en Cursite (1 h)
  if ((+nouveau.boostXP || 0) > (+ancien.boostXP || 0) + 1000) {
    cursiteDepenseMin += R.BOOST_PRIX;
    if (!(+nouveau.boostXP <= Date.now() + 3600000 + 10 * 60000)) pb.push('boost d\'XP trafiqué');
  }
  if (d('cursite') > (dons.cursite || 0) + bonusCursite - cursiteDepenseMin + 0.5) pb.push('Cursite injustifiée (+' + Math.round(d('cursite')) + ')');
  if ((nouveau.titles || []).includes('beta') && !(ancien.titles || []).includes('beta') && (L1.n | 0) < 6 && !(L1.day !== L0.day)) pb.push('titre bêta injustifié');

  // --- or : achats obligatoires (coffres, sacs), pièces tirées par le serveur, ventes, quêtes ---
  const o0 = objets(ancien), o1 = objets(nouveau), c0 = compter(o0), c1 = compter(o1);
  const etape2 = !!R.MON;
  let orDepenseMin = 0;
  for (let n = (ancien.vault && ancien.vault.n) || 1; n < ((nouveau.vault && nouveau.vault.n) || 1); n++) orDepenseMin += R.VAULT_PRICES[n] || 0;
  for (const [cls, ch1] of Object.entries(nouveau.chars)) { const ch0 = ancien.chars[cls]; const n0 = ch0 ? ch0.inv.length : 8; if (ch1.inv.length > n0) orDepenseMin += (n0 < 16 && ch1.inv.length >= 16 ? 250 : 0) + (ch1.inv.length >= 24 && n0 < 24 ? 1500 : 0); }
  // valeur de revente des équipements disparus (vendus au marchand ou jetés)
  let ventes = 0;
  for (const [k, n] of c0) { const moins = n - (c1.get(k) || 0); if (moins > 0) { const t = +k.split('|')[1], K = R.KINDS[k.split('|')[0]]; if (K && K.slot !== 'conso') ventes += moins * (R.SELL_PRICE[t] || 0); } }
  const gainBrut = d('gold') + orDepenseMin;
  const orServeur = Math.min(Math.max(0, gainBrut), dons.or || 0);
  const gainOr = gainBrut - (dons.or || 0) - (etape2 ? ventes : 0);
  if (gainOr > sx.or + 0.5) pb.push('or gagné trop vite (+' + Math.round(gainOr) + ')'); else if (gainOr > 0) sx.or -= gainOr;

  // --- progression des héros ---
  let gainNiv = 0, gainKills = 0, gainBoss = 0, gainGloire = 0, gainXP = 0, kits = 0;
  const xpTot = ch => { let x = 0; for (let l = 1; l < (ch.lvl | 0); l++) x += R.need(l); return x + Math.max(0, +ch.xp || 0) + Math.max(0, +ch.gxp || 0) + (ch.gp | 0) * R.GLORY_XP; };
  for (const [cls, ch1] of Object.entries(nouveau.chars)) {
    let ch0 = ancien.chars[cls];
    // héros neuf ou mort définitive : il repart de zéro avec son équipement de départ
    if (!ch0 || ((ch1.lvl | 0) <= (ch0.lvl | 0) && (ch1.kills | 0) < (ch0.kills | 0))) { kits++; ch0 = { lvl: 1, xp: 0, gxp: 0, gp: 0, kills: 0, bosses: 0 }; }
    if ((ch1.lvl | 0) > (ch0.lvl | 0)) gainNiv += ch1.lvl - ch0.lvl;
    gainKills += Math.max(0, (ch1.kills | 0) - (ch0.kills | 0)); gainBoss += Math.max(0, (ch1.bosses | 0) - (ch0.bosses | 0)); gainGloire += Math.max(0, (ch1.gp | 0) - (ch0.gp | 0));
    gainXP += Math.max(0, xpTot(ch1) - xpTot(ch0));
  }
  if (!etape2) { // étape 1 seulement : sans butin serveur, on limite le rythme
    if (gainNiv > sx.niveaux + 0.01) pb.push('niveaux gagnés trop vite (+' + gainNiv + ')'); else sx.niveaux -= gainNiv;
    if (gainKills > sx.monstres + 0.5) pb.push('monstres tués trop vite (+' + gainKills + ')'); else sx.monstres -= gainKills;
    if (gainBoss > sx.boss + 0.5) pb.push('boss tués trop vite (+' + gainBoss + ')'); else sx.boss -= gainBoss;
    if (gainGloire > sx.gloire + 0.5) pb.push('gloire gagnée trop vite (+' + gainGloire + ')'); else sx.gloire -= gainGloire;
  } else {
    // XP, monstres et boss : seulement ce que le serveur a compté
    if (gainXP > (dons.xp || 0) + 2) pb.push('XP non donnée par le serveur (+' + Math.round(gainXP - (dons.xp || 0)) + ')');
    if (gainKills > (dons.kills || 0)) pb.push('monstres non comptés par le serveur (+' + (gainKills - (dons.kills || 0)) + ')');
    if (gainBoss > (dons.boss || 0)) pb.push('boss non comptés par le serveur (+' + (gainBoss - (dons.boss || 0)) + ')');
  }

  // --- objets : apparitions comptées (les déplacements entre héros et coffres ne comptent pas) ---
  const liste = {}; for (const k in (dons.liste || {})) liste[k] = (dons.liste[k] || []).slice();
  let donsObj = dons.objets || 0, kitT0 = kits * 3, libT6 = bonusT6, libRel = bonusReliques, libConso = Math.max(0, bonusObjets - bonusT6 - bonusReliques);
  let nConso = 0, horsListe = 0, nT6 = 0, nRel = 0, nouveaux = 0;
  for (const [k, n] of c1) {
    let plus = n - (c0.get(k) || 0); if (plus <= 0) continue;
    nouveaux += plus;
    const L = liste[k]; while (plus > 0 && L && L.length) { L.shift(); plus--; } // donné par le serveur (butin, échange)
    if (!plus) continue;
    const kind = k.split('|')[0], t = +k.split('|')[1], conso = R.KINDS[kind] && R.KINDS[kind].slot === 'conso';
    for (; plus > 0; plus--) {
      if (conso) { if (libConso > 0) libConso--; else if (donsObj > 0) donsObj--; else nConso++; continue; }
      if (t === 0 && kitT0 > 0) { kitT0--; continue; }
      if (t === 6 && libT6 > 0) { libT6--; continue; }
      if (t >= 7 && libRel > 0) { libRel--; continue; }
      if (donsObj > 0) { donsObj--; continue; }
      if (etape2) horsListe++; else { nConso++; if (t === 6) nT6++; if (t >= 7) nRel++; }
    }
  }
  if (horsListe) pb.push('équipement non donné par le serveur (+' + horsListe + ')');
  if (nConso > sx.objets + 0.5) pb.push('trop d\'objets d\'un coup (+' + nConso + ')'); else sx.objets -= nConso;
  if (nT6 > sx.t6 + 0.01) pb.push('trop d\'objets tier 6 (+' + nT6 + ')'); else sx.t6 -= nT6;
  if (nRel > sx.reliques + 0.01) pb.push('trop de reliques (+' + nRel + ')'); else sx.reliques -= nRel;
  // --- objets donnés lors d'un échange : celui qui donne doit bien les perdre (anti-duplication) ---
  const aPerdre = (ctx.aPerdre || []).filter(e => Date.now() - e.t < 30 * 60000);
  const enTrop = [];
  for (const e of aPerdre) { const n = c1.get(e.sig) || 0; if (n > e.max) enTrop.push(e); }
  if (enTrop.length) pb.push('objet échangé toujours dans le sac (duplication)');

  // --- potions de caractéristique bues : chaque point demande une potion disparue ---
  for (const k of Object.keys(R.SP_DEF)) {
    let bu = 0; for (const [cls, ch1] of Object.entries(nouveau.chars)) { const ch0 = ancien.chars[cls]; if (ch0 && (ch1.lvl | 0) >= 1) bu += Math.max(0, ((ch1.sp || {})[k] | 0) - ((ch0.sp || {})[k] | 0)); }
    if (!bu) continue;
    const avant = nbKind(o0, it => it.kind === 'sp_' + k), apres = nbKind(o1, it => it.kind === 'sp_' + k);
    if (bu > Math.max(0, avant - apres) + (dons.objets || 0)) pb.push('potions de ' + k + ' bues sans potion');
  }

  // --- familiers : un œuf pour chaque nouveau familier commun, 3 identiques + 1 croquette pour monter d'un rang ---
  if (Array.isArray(nouveau.pets)) {
    const ids0 = new Map((ancien.pets || []).map(p => [p.id, p])), ids1 = new Set(nouveau.pets.map(p => p.id));
    const neufs = nouveau.pets.filter(p => !ids0.has(p.id)), partis = (ancien.pets || []).filter(p => !ids1.has(p.id));
    const oeufs = Math.max(0, nbKind(o0, it => R.KINDS[it.kind] && R.KINDS[it.kind].egg) - nbKind(o1, it => R.KINDS[it.kind] && R.KINDS[it.kind].egg));
    const croq = Math.max(0, nbKind(o0, it => it.kind === 'croquette') - nbKind(o1, it => it.kind === 'croquette'));
    let communs = 0, evos = 0;
    for (const p of neufs) { if ((p.t | 0) === 0) communs++; else { const meme = partis.filter(q => q.k === p.k && (q.t | 0) === (p.t | 0) - 1).length; if (meme >= 3) evos++; else pb.push('familier de rang supérieur injustifié'); } }
    if (communs > oeufs + (dons.objets || 0)) pb.push('familier sans œuf');
    if (evos > croq + (dons.objets || 0)) pb.push('évolution sans croquette');
  }

  if (pb.length) return { ok: false, raisons: [...new Set(pb)].slice(0, 6), enTrop };
  // ce qui reste des dons du serveur après cette sauvegarde (butin pas encore ramassé, etc.)
  const reste = { cursite: 0, prestige: 0, objets: 0, or: Math.max(0, (dons.or || 0) - orServeur),
    xp: Math.max(0, (dons.xp || 0) - gainXP), kills: Math.max(0, (dons.kills || 0) - gainKills), boss: Math.max(0, (dons.boss || 0) - gainBoss), liste };
  return { ok: true, reste, aPerdre: [] };
}

// dégâts par seconde maximum d'un héros (avec rage, autel, familier et une bonne marge pour les zones et capacités)
function degatsMax(s) {
  const ch = s && s.chars && s.chars[s.current], c = ch && R.CLASSES[s.current]; if (!ch || !c) return 25000;
  const lvl = Math.max(1, ch.lvl | 0), w = (ch.equip || [])[0];
  const stat = k => c.base[k] + c.gain[k] * (lvl - 1) + (((ch.sp || {})[k] | 0) * ((R.SP_DEF[k] || {}).step || 1)) + (ch.equip || []).reduce((a, it) => a + ((it && it.stats && it.stats[k]) || 0), 0) + 30;
  if (!w || !Array.isArray(w.dmg) || !R.WB || !R.WB[w.kind]) return 25000;
  const mult = (0.5 + stat('puissance') / 50) * 1.45 * 1.3, cadence = (1.5 + 6.5 * stat('vatt') / 75) * 1.5;
  const tirs = R.WB[w.kind].shots + (w.extra || 0);
  return Math.round(Math.max(3000, w.dmg[1] * mult * tirs * cadence * 3));
}

module.exports = { degatsMax, verifier, nouveauxSeaux, regles: () => R, objetValide, apprendre };
