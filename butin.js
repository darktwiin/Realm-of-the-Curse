// Royaume Maudit — le butin tiré par le serveur (anti-triche, étape 2).
// Quand un joueur tue un monstre, son jeu envoie { t:'kill' } ; le serveur vérifie que c'est
// plausible, tire lui-même l'XP, l'or et les objets, les note comme « dons » du compte, puis
// renvoie le résultat au joueur. L'arbitre refuse ensuite tout équipement, XP ou monstre
// tué que le serveur n'a pas donné.
'use strict';
const arbitre = require('./arbitre');

const ri = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = x => x[Math.floor(Math.random() * x.length)];
const DUN_POT = { s: ['vdep', 0.2], o: ['mana', 0.15], p: ['puissance', 0.15], e: ['vatt', 0.2], g: ['vie', 0.1], c: ['*', 0.4] };
const GARANTIS = ['liche', 'pharaon', 'leviathan', 'archange', 'abysses', 'reine', 'devoreur', 'chronos'];
const DONJONS_A_CLEF = 'csopeg'; // les boss de ces 6 donjons peuvent lâcher une Clef du Temps (1 %)
const signature = it => it.kind + '|' + it.tier + '|' + JSON.stringify(Object.keys(it.stats || {}).sort().map(k => [k, it.stats[k]])) + (it.up ? '|+' + (it.up | 0) : '');

// ---------- tirage (copie fidèle de handleDeath / statDrops / randomItem du jeu) ----------
function objetAuHasard(R, t, cls) {
  const c = R.CLASSES[cls] || R.CLASSES[Object.keys(R.CLASSES)[0]], r = Math.random(), mien = Math.random() < 0.55;
  let k;
  if (r < 0.4) k = mien ? c.arme : pick(['epee', 'baton', 'arc', 'baguette', 'dague', 'mandoline']);
  else if (r < 0.6) k = mien ? c.capa : pick(['casque', 'sort', 'carquois', 'tome', 'prisme', 'voile', 'bouclier', 'totem']);
  else if (r < 0.85) k = mien ? c.armure : pick(['lourde', 'cuir', 'robe']);
  else k = 'anneau';
  return R.mkItem(k, t);
}
// objet Tier 7 (obsidienne) : seulement dans les deux derniers donjons
function objetT7(R, cls) {
  const c = R.CLASSES[cls] || R.CLASSES[Object.keys(R.CLASSES)[0]], r = Math.random(), mien = Math.random() < 0.55;
  let k;
  if (r < 0.4) k = mien ? c.arme : pick(['epee', 'baton', 'arc', 'baguette', 'dague', 'mandoline']);
  else if (r < 0.6) k = mien ? c.capa : pick(['casque', 'sort', 'carquois', 'tome', 'prisme', 'voile', 'bouclier', 'totem']);
  else if (r < 0.85) k = mien ? c.armure : pick(['lourde', 'cuir', 'robe']);
  else k = 'anneau';
  return R.KINDS[k + '7'] ? R.mkItem(k + '7', 6) : null;
}
const TAUX_RESSOURCE = 0.2; // ressource de talisman sur un boss de donjon
const DONJONS_T7 = 'ah', TAUX_T7 = 0.05; // Observatoire Céleste et Horloge Brisée : 5 % par monstre tué
function potionsCarac(R, key, d, scene) {
  if (d.tuto) return [];
  for (const t in DUN_POT) if (R.DTYPES[t] && R.DTYPES[t].bk === key) { const [st, ch] = DUN_POT[t]; return Math.random() < ch ? [st === '*' ? pick(R.SK) : st] : []; }
  if (key === 'chronos') { const n = ri(2, 3), o = []; for (let i = 0; i < n; i++) o.push(pick(R.SK)); return o; }
  if (d.star != null || key === 'devoreur') { const n = ri(1, 2), o = []; for (let i = 0; i < n; i++) o.push(pick(R.SK)); return o; }
  if (key === 'dieu_fou' || key === 'colosse') return Math.random() < 0.2 ? [pick(R.SK)] : [];
  // avant-dernière zone 0,8 %, dernière zone 1,1 % d'une potion de caractéristique au hasard
  if (scene === 'realm') { if (R.ZONES[5].pool.includes(key) && Math.random() < 0.008) return [pick(R.SK)]; if (R.ZONES[6].pool.includes(key) && Math.random() < 0.011) return [pick(R.SK)]; }
  return [];
}
function tirer(R, key, cls, scene, sc) {
  const d = R.MON[key], out = { xp: d.xp | 0, b: d.boss ? 1 : 0, it: [], rel: -1, oeuf: 0, spg: [], sp: [], or: 0 };
  if (d.tuto) { out.xp *= 2; out.tuto = 1; return out; }
  if (Math.random() < d.drop) { const n = d.n && d.boss ? d.n : 1; for (let i = 0; i < n; i++) { let t = ri(d.loot[0], d.loot[1]); if (Math.random() < 0.08) t = Math.min(6, t + 1); out.it.push(objetAuHasard(R, t, cls)); } }
  if (d.rel && (key === 'devoreur' || Math.random() < d.rel)) { out.rel = out.it.length; out.it.push(objetAuHasard(R, 7, cls)); }
  if (Math.random() < (d.boss ? 1 : 0.12)) out.it.push(R.mkItem(Math.random() < 0.6 ? 'pvie' : 'pmana', 0));
  if (Math.random() < 0.005) { out.oeuf = 1; out.it.push(R.mkItem('egg', 0)); }
  // Clef du Temps : 1 % sur le boss des 6 grands donjons, 10 % sur chacun des 4 gardiens de l'Observatoire (jamais sur le Dévoreur)
  if (R.KINDS.cle && typeof sc === 'string' && sc[0] === 'd') {
    const t = sc[1], grand = DONJONS_A_CLEF.includes(t) && R.DTYPES[t] && R.DTYPES[t].bk === key;
    if ((grand && Math.random() < 0.01) || (d.star != null && Math.random() < 0.10)) { out.cle = 1; out.it.push(R.mkItem('cle', 0)); }
  }
  if (typeof sc === 'string' && sc[0] === 'd' && DONJONS_T7.includes(sc[1]) && Math.random() < TAUX_T7) { const o7 = objetT7(R, cls); if (o7) { out.t7 = 1; out.it.push(o7); } }
  // Chronos : une Relique de Chronos à chaque fois (une chance sur deux qu'elle soit pour la classe du joueur)
  if (key === 'chronos') { const tous = Object.keys(R.KINDS).filter(k => R.KINDS[k].alt), miens = tous.filter(k => (R.KINDS[k].cls || []).includes(cls));
    if (tous.length) out.it.push(R.mkItem(pick(miens.length && Math.random() < 0.5 ? miens : tous), 7)); }
  // ressource de boss (talismans) : 20 % sur le boss du donjon où l'on se trouve
  if (d.boss && typeof sc === 'string' && sc[0] === 'd' && R.TALIS && R.TALIS[sc[1]]) { const T = R.DTYPES[sc[1]]; if (T && (T.bk === key || T.bk2 === key) && Math.random() < TAUX_RESSOURCE) out.res = sc[1]; }
  if (d.midBoss || GARANTIS.includes(key)) out.spg.push(R.mkItem('sp_' + pick(R.SK), 0));
  out.sp = potionsCarac(R, key, d, scene).map(k => R.mkItem('sp_' + k, 0));
  if (d.or && Math.random() < d.or[0]) out.or = Math.max(1, Math.round(ri(d.or[1], d.or[2]) * 1.3)); // pièces +30 %
  return out;
}

// ---------- témoins : les morts annoncées par l'hôte de chaque scène ----------
const temoins = new Map(); // `${salle}|${scene}|${id}` -> { peer, k, t }
const hotes = new Map();   // `${salle}|${scene}` -> { peer, t }
function observer(salle, moi, patch) {
  const s = String((moi.etat && moi.etat.s) || ''); if (!s) return;
  const R = arbitre.regles(); if (!R || !R.MKEYS) return;
  if (typeof patch.M === 'string') hotes.set(salle + '|' + s, { peer: moi.peer, t: Date.now() });
  if (typeof patch.D === 'string') {
    for (const e of patch.D.split(';').slice(0, 40)) {
      const f = e.split(','); if (f.length < 4) continue;
      const id = parseInt(f[0], 36), k = R.MKEYS[+f[1]]; if (!(id > 0) || !k) continue;
      const cle = salle + '|' + s + '|' + id; if (!temoins.has(cle)) temoins.set(cle, { peer: moi.peer, k, t: Date.now() });
    }
  }
}
setInterval(() => { const lim = Date.now() - 90000; for (const [k, v] of temoins) if (v.t < lim) temoins.delete(k); for (const [k, v] of hotes) if (v.t < lim) hotes.delete(k); }, 30000).unref();

// ---------- zones des Plaines (même calcul que le jeu : distance au centre, zones mises à l'échelle ×3) ----------
const ZCACHE = {};
function zonesDu(R, key) { if (ZCACHE[key]) return ZCACHE[key]; const o = []; R.ZONES.forEach((z, i) => { if (z.pool.includes(key)) o.push(i); }); return (ZCACHE[key] = o); }
function zoneA(R, d) { for (let i = R.ZONES.length - 1; i >= 0; i--) { const r = R.ZONES[i].r; if (d < r[1] * 3 && d >= r[0] * 3) return i; } return 0; }

// ---------- rythme par compte ----------
const SEAUX = { tues: { debit: 70, max: 100 }, boss: { debit: 4, max: 10 } };
function seau(c, k) { const S = SEAUX[k], now = Date.now(); const s = c[k] || (c[k] = { v: S.max, t: now }); s.v = Math.min(S.max, s.v + S.debit * (now - s.t) / 60000); s.t = now; return s; }

// ---------- dons notés pour l'arbitre ----------
function noter(dons, it) { const k = signature(it); (dons.liste[k] || (dons.liste[k] = [])).push(Date.now()); }
function nettoyer(dons) { const lim = Date.now() - 20 * 60000; for (const k in dons.liste) { dons.liste[k] = dons.liste[k].filter(t => t > lim); if (!dons.liste[k].length) delete dons.liste[k]; } }

// ---------- une réclamation de monstre tué ----------
// ctx : { salle (nom), membres (Map de la salle), dons, rythme, envoyer }
function reclamer(moi, m, ctx) {
  const R = arbitre.regles(); if (!R || !R.MON || !moi.compte) return;
  const non = raison => { if (ctx.onRefus) try { ctx.onRefus(raison); } catch {} moi.killRefus = (moi.killRefus || 0) + 1; if (moi.killRefus <= 5 || moi.killRefus % 50 === 0) console.log(`[butin] refusé pour ${moi.compte.nom} : ${raison} (${moi.killRefus})`); if (moi.killRefus === 25 && ctx.signaler) ctx.signaler(['25 monstres réclamés refusés (dernier : ' + raison + ')']); ctx.envoyer(moi.ws, { t: 'butin', id: m.id, refus: 1 }); };
  const id = Math.floor(Number(m.id)), key = String(m.k || ''), s = String(m.s || ''), d = R.MON[key];
  if (!(id > 0) || !d) return non('monstre inconnu');
  if (!s || /^[nvhGx]/.test(s)) return non('scène sans monstres');
  if (!!d.tuto !== (s[0] === 'u')) return non('monstre hors de sa zone');
  if (ctx.sansClef) return non('donjon à clef sans clef');
  // la scène annoncée doit être celle où se trouve le joueur (ou celle qu'il vient de quitter)
  const ici = String((moi.etat && moi.etat.s) || '');
  if (s !== ici && !(moi.sAvant === s && Date.now() - (moi.sT || 0) < 8000)) return non('pas dans cette scène');
  // position : le monstre doit être près du joueur, et dans une zone où il peut vivre
  const x0 = Number(m.x), y0 = Number(m.y);
  if (!isFinite(x0) || !isFinite(y0) || x0 < 0 || y0 < 0 || x0 > 2000 || y0 > 2000) return non('position illisible');
  const px = Number(moi.etat && moi.etat.x) / 10, py = Number(moi.etat && moi.etat.y) / 10;
  if (s === ici && isFinite(px) && isFinite(py) && Math.hypot(px - x0, py - y0) > 30) return non('monstre trop loin du joueur');
  if (s === 'r') {
    const zs = zonesDu(R, key);
    if (zs.length) { const dist = Math.hypot(x0 - 360, y0 - 360), lo = zoneA(R, dist + 16), hi = zoneA(R, Math.max(0, dist - 16)); if (!zs.some(z => z >= lo - 1 && z <= hi + 1)) return non('monstre hors de sa zone (' + key + ', zones ' + zs.join('/') + ' vs ' + lo + '-' + hi + ')'); }
  } else if (s[0] === 'd') {
    // le boss d'un autre donjon ne peut pas mourir ici
    const t = s[1]; for (const k in R.DTYPES) if (k !== t && R.DTYPES[k].bk === key && !(R.DTYPES[t] && R.DTYPES[t].bk === key)) return non('boss d\'un autre donjon');
  }
  // un monstre ne rapporte qu'une fois
  const vus = moi.tues || (moi.tues = new Set()), cle = s + '|' + id;
  if (vus.has(cle)) return non('déjà compté');
  // à plusieurs : la mort doit avoir été annoncée par l'hôte (sauf si c'est lui l'hôte)
  let autres = 0; for (const j of ctx.membres.values()) if (j !== moi && !j.gardien && j.etat && j.etat.s === s) autres++;
  const G = ctx.gardien && ctx.gardien.etat && ctx.gardien.etat.s === s ? ctx.gardien : null;
  if (G) {
    // Plaines tenues par le Gardien du serveur : seule sa parole compte
    const w = temoins.get(ctx.salle + '|' + cle);
    if (!w || w.peer !== G.peer) return non('mort non confirmée par le Gardien');
    if (w.k !== key) return non('mauvais monstre');
  } else if (autres) {
    const w = temoins.get(ctx.salle + '|' + cle);
    if (w) { if (w.k !== key) return non('mauvais monstre'); }
    else { const h = hotes.get(ctx.salle + '|' + s); if (h && h.peer !== moi.peer && Date.now() - h.t < 4000) return non('mort non annoncée par l\'hôte'); }
  }
  // rythme humain
  const st = seau(ctx.rythme, 'tues'); if (st.v < 1) return non('trop de monstres d\'un coup');
  if (d.boss) { const sb = seau(ctx.rythme, 'boss'), dern = ctx.rythme.dernierBoss || (ctx.rythme.dernierBoss = {});
    if (sb.v < 1) return non('trop de boss d\'un coup');
    if (Date.now() - (dern[key] || 0) < 12000) return non('même boss trop vite');
    sb.v -= 1; dern[key] = Date.now(); }
  st.v -= 1;
  vus.add(cle); if (vus.size > 3000) { const a = [...vus].slice(-1500); vus.clear(); a.forEach(v => vus.add(v)); }
  // tirage
  const cls = R.CLASSES[m.c] ? String(m.c) : String((moi.etat && moi.etat.c) || '');
  const r = tirer(R, key, cls, s === 'r' ? 'realm' : 'dungeon', s);
  if (ctx.boost && Date.now() < ctx.boost) r.xp = Math.round(r.xp * 1.3); // boost d'expérience (Cursite)
  if (ctx.boostServeur > 1) r.xp = Math.round(r.xp * ctx.boostServeur);     // objectif commun de la semaine atteint
  const dons = ctx.dons; nettoyer(dons);
  dons.xp += r.xp; dons.kills += 1; dons.boss += r.b; dons.or += r.or;
  for (const it of [...r.it, ...r.spg, ...r.sp]) noter(dons, it);
  if (r.res) { dons.res = dons.res || {}; dons.res[r.res] = (dons.res[r.res] || 0) + 1; }
  const x = Math.round((Number(m.x) || 0) * 10) / 10, y = Math.round((Number(m.y) || 0) * 10) / 10;
  ctx.envoyer(moi.ws, Object.assign({ t: 'butin', id, k: key, x, y }, r));
  if (ctx.onTue) try { ctx.onTue(key, s); } catch (e) { console.error('[butin] onTue', e.message); }
}

// ---------- échanges : ce qui change de main est noté (et doit disparaître chez celui qui donne) ----------
function sigEchange(R, o) {
  if (!o || typeof o !== 'object' || !R.KINDS[o.kind]) return null;
  const tier = Math.max(0, Math.min(7, Math.floor(+o.tier) || 0)), it = R.mkItem(o.kind, tier);
  if (it.slot === 'anneau' && o.stats && typeof o.stats === 'object') { const st = {}; for (const k of R.SK) { const v = Math.floor(+o.stats[k] || 0); if (v > 0) st[k] = Math.min(v, (k === 'vie' || k === 'mana') ? 160 : 14); } if (Object.keys(st).length) it.stats = st; }
  if (o.up && it.slot !== 'conso') it.up = Math.max(0, Math.min(2, o.up | 0)); // niveau de forge
  return it;
}
// donneur : sauvegarde du donneur (en base), objets offerts → [{ recu (objet tel que le receveur le fabrique), sigDonneur }]
function preparerEchange(saveDonneur, items) {
  const R = arbitre.regles(); if (!R || !saveDonneur) return [];
  const possede = []; for (const ch of Object.values(saveDonneur.chars || {})) for (const it of [...(ch.equip || []), ...(ch.inv || [])]) if (it) possede.push(it);
  const out = [], pris = new Set();
  for (const o of (items || []).slice(0, 8)) {
    const recu = sigEchange(R, o); if (!recu) continue;
    // le donneur doit vraiment posséder un objet de ce type et de ce tier (mêmes stats pour un anneau)
    const i = possede.findIndex((it, j) => !pris.has(j) && it.kind === recu.kind && it.tier === recu.tier && (it.up | 0) === (recu.up | 0) && (recu.slot !== 'anneau' || signature(it) === signature(recu)));
    if (i < 0) continue;
    pris.add(i); out.push({ recu, sigDonneur: signature(possede[i]) });
  }
  return out;
}
function compterSig(save, sig) { let n = 0; for (const ch of Object.values(save.chars || {})) for (const it of [...(ch.equip || []), ...(ch.inv || [])]) if (it && signature(it) === sig) n++; for (const c of ((save.vault && save.vault.c) || [])) for (const it of c || []) if (it && signature(it) === sig) n++; return n; }

module.exports = { reclamer, observer, tirer, preparerEchange, compterSig, noter, signature };
