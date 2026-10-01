// Royaume Maudit — le Gardien des Plaines (anti-triche, étape 3).
// Le serveur fait tourner une copie du jeu, sans affichage, qui reste en permanence dans les
// Plaines Sauvages et en est l'hôte : les monstres, leurs tirs, les boss et les portails
// continuent de vivre même quand aucun joueur n'est là, et c'est lui (donc le serveur) qui
// décide quand un monstre meurt. Il est invisible et invulnérable.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WebSocket = require('ws');

// ---------- un faux navigateur : tout ce qui touche à l'écran ou au son ne fait rien ----------
const noop = new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : k === Symbol.iterator ? undefined : k === 'length' ? 0 : k === 'then' ? undefined : noop,
  apply: () => noop, construct: () => noop, set: () => true, has: () => true,
});
function element(tag) {
  const vals = { tagName: String(tag || 'div').toUpperCase(), hidden: false, value: '', textContent: '', innerHTML: '', className: '', checked: false, disabled: false, width: 300, height: 150, children: [], childNodes: [], dataset: {}, offsetWidth: 0, offsetHeight: 0, clientWidth: 1280, clientHeight: 720, scrollTop: 0 };
  vals.style = new Proxy({}, { get: (t, k) => k in t ? t[k] : '', set: (t, k, v) => { t[k] = v; return true; } });
  vals.classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
  vals.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0 });
  vals.querySelector = () => element(); vals.querySelectorAll = () => []; vals.getElementsByTagName = () => [];
  vals.appendChild = c => c; vals.insertBefore = c => c; vals.removeChild = c => c; vals.append = () => {}; vals.prepend = () => {}; vals.remove = () => {};
  vals.addEventListener = () => {}; vals.removeEventListener = () => {}; vals.focus = () => {}; vals.blur = () => {}; vals.click = () => {};
  vals.setAttribute = () => {}; vals.getAttribute = () => null; vals.closest = () => null; vals.contains = () => false;
  vals.getContext = () => contexte(vals);
  vals.toDataURL = () => 'data:,';
  vals.toBlob = () => {};
  return new Proxy(vals, { get: (t, k) => k in t ? t[k] : noop, set: (t, k, v) => { t[k] = v; return true; } });
}
function contexte(cv) {
  const vals = {
    canvas: cv, measureText: s => ({ width: String(s || '').length * 6 }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, (w | 0) * (h | 0) * 4)) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, (w | 0) * (h | 0) * 4)) }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), isPointInPath: () => false,
  };
  return new Proxy(vals, { get: (t, k) => k in t ? t[k] : noop, set: (t, k, v) => { t[k] = v; return true; } });
}
function stockage(init) { const m = new Map(Object.entries(init || {})); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } }; }

// ---------- démarrage ----------
// port : celui du serveur ; cle : secret qui permet au serveur de reconnaître le Gardien
// cible : 'realm' (Plaines), 'pool' (attend au Village) ou une scène de donjon ('d' + type + id en base 36)
function demarrer({ port, cle, salle = 'principal', log = console.log, cible = 'realm' }) {
  // minuteries et connexion propres à cette copie du jeu, pour pouvoir l'arrêter proprement
  let mort = false; const minuteries = new Set(), intervalles = new Set(), sockets = new Set();
  const sT = (f, ms, ...a) => { if (mort) return 0; const id = setTimeout(() => { minuteries.delete(id); if (!mort) f(...a); }, ms); minuteries.add(id); return id; };
  const sI = (f, ms, ...a) => { if (mort) return 0; const id = setInterval(() => { if (!mort) f(...a); }, ms); intervalles.add(id); return id; };
  const cT = id => { clearTimeout(id); minuteries.delete(id); }, cI = id => { clearInterval(id); intervalles.delete(id); };
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const a = html.indexOf('<script>'), b = html.indexOf('</script>', a);
  const code = html.slice(a + 8, b);
  // sauvegarde du Gardien : un héros au hasard, déjà passé par le tutoriel
  const save0 = { current: 'mage', pseudo: 'Gardien', gold: 0, cursite: 0, prestige: 0, chars: {}, tuto: 1, tutoDone: true, seenTuto: true };
  const doc = element('document');
  Object.assign(doc, {
    body: element('body'), documentElement: element('html'), head: element('head'),
    getElementById: () => element(), querySelector: () => element(), querySelectorAll: () => [], getElementsByClassName: () => [],
    createElement: t => element(t), createElementNS: (n, t) => element(t), createTextNode: () => element(), createDocumentFragment: () => element(),
    addEventListener: () => {}, removeEventListener: () => {}, hidden: false, visibilityState: 'visible', fonts: { ready: Promise.resolve(), load: () => Promise.resolve() },
    pointerLockElement: null, exitPointerLock: () => {}, fullscreenElement: null, title: '',
  });
  const debut = Date.now();
  const ctx = {
    console: { log: () => {}, warn: () => {}, info: () => {}, debug: () => {}, error: (...x) => { const s = x.map(v => v && v.stack ? v.stack.split('\n').slice(0, 3).join(' ') : String(v)).join(' '); if (!/ERR_|Failed to load/.test(s)) log('[gardien] erreur du jeu : ' + s.slice(0, 300)); } },
    document: doc, navigator: { userAgent: 'Gardien', language: 'fr-FR', languages: ['fr-FR'], maxTouchPoints: 0, getGamepads: () => [], clipboard: { writeText: () => Promise.resolve() }, vibrate: () => false, onLine: true },
    location: { protocol: 'http:', host: 'localhost:' + port, hostname: 'localhost', port: String(port), search: '?salle=' + salle + '&gardien=' + cle, href: 'http://localhost:' + port + '/', pathname: '/', reload: () => {}, origin: 'http://localhost:' + port },
    localStorage: stockage({ 'royaume-maudit-v1': JSON.stringify(save0) }), sessionStorage: stockage(),
    performance: { now: () => Date.now() - debut }, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, screen: { width: 1280, height: 720 },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), getComputedStyle: () => new Proxy({}, { get: () => '' }),
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, alert: () => {}, confirm: () => true, prompt: () => null, open: () => null, scrollTo: () => {}, focus: () => {},
    requestAnimationFrame: f => sT(() => f(Date.now() - debut), 33), cancelAnimationFrame: cT,
    setTimeout: sT, clearTimeout: cT, setInterval: sI, clearInterval: cI, queueMicrotask,
    Image: function () { return element('img'); }, Audio: function () { return element('audio'); }, AudioContext: function () { return noop; }, webkitAudioContext: undefined, OffscreenCanvas: undefined,
    WebSocket: function (url) { const ws = new WebSocket(url.replace(/^ws:\/\/[^/]+/, 'ws://127.0.0.1:' + port) + (url.includes('?') ? '&' : '?') + 'gardien=' + encodeURIComponent(cle)); sockets.add(ws); ws.on('error', () => {}); return ws; },
    URL: Object.assign(function (u, b) { return new URL(u, b); }, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }), URLSearchParams, TextEncoder, TextDecoder, Blob: function () {}, FileReader: function () { return noop; },
    fetch: () => Promise.reject(new Error('pas de réseau')), crypto: globalThis.crypto, structuredClone, atob, btoa,
    Math, JSON, Date, Object, Array, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet, Promise, Proxy, Reflect, RegExp, Error, TypeError, RangeError,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, Intl,
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; }, MutationObserver: function () { return { observe() {}, disconnect() {} }; }, IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
    ImageData: function (d, w, h) { this.data = d; this.width = w; this.height = h; }, Event: function () {}, KeyboardEvent: function () {}, MouseEvent: function () {}, CustomEvent: function () {}, HTMLElement: function () {}, HTMLCanvasElement: function () {}, Path2D: function () { return noop; }, DOMMatrix: function () { return noop; },
    speechSynthesis: undefined, history: { replaceState() {}, pushState() {} }, getSelection: () => ({ removeAllRanges() {} }),
    GARDIEN_MODE: true,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // le jeu est enveloppé dans (()=>{ … })(); : on glisse la mise en place du Gardien juste avant la fin
  const fin = code.lastIndexOf('})();');
  if (fin < 0) throw new Error('fin du jeu introuvable');
  // mise en place : invisible, invulnérable, toujours dans les Plaines, sans affichage
  const init = `
    render=function(){};updHUD=function(){};renderPlayers=function(){};drawMini=function(){};sfx=function(){};setSong=function(){};
    note=function(){};showBanner=function(){};ft=function(){};burst=function(){};pushChat=function(){};sendScore=function(){};
    if(!save.current||!save.chars[save.current]){save.chars.mage=newChar('mage');save.current='mage';}
    pseudo='Gardien';admInv=true;P.god=true;godMode=true;paused=false;
    window.__cible=${JSON.stringify(cible)};
    function gardienPlace(){
      const c=window.__cible;
      if(c==='realm'){ if(scene!=='realm'){ enterRealm(); P.x=RPORT.x; P.y=RPORT.y-6; } }
      else if(typeof c==='string'&&c[0]==='d'){ const t=c[1],id=parseInt(c.slice(2),36); if(DTYPES[t]&&id>0&&(scene!=='dungeon'||sceneKey()!==c)){ enterDungeon(id,t); } }
      P.hp=99999; P.god=true; admInv=true; paused=false;
    }
    window.__aller=c=>{window.__cible=c;gardienPlace();sendPresence();};
    gardienPlace();
    setInterval(()=>{try{ gardienPlace(); P.hp=S().tot.vie; P.god=true; P.o2=15; admInv=true; paused=false; if(!deathEl.hidden){deathEl.hidden=true;} keys.clear&&keys.clear(); mouse.down=false; }catch(e){}},1000);
    // ménage régulier (le Gardien tourne des jours) : joueurs partis, monstres morts
    setInterval(()=>{try{const vivants=new Set(monsters.filter(m=>m.hp>0).map(m=>m.id));for(const [peer,mp] of applied){if(!remotes.has(peer)){applied.delete(peer);G_SEAU.delete(peer);continue;}for(const id of mp.keys())if(!vivants.has(id))mp.delete(id);}chatHist.length=0;chatLog.length=0;texts.length=0;parts.length=0;vfx.length=0;}catch(e){}},60000);
    // suivi des joueurs : secondes passées près d'un boss vivant sans jamais perdre de vie
    setInterval(()=>{try{const k=sceneKey();for(const r of remotes.values()){if(!r.p||r.p.gd||!activeIn(r,k))continue;const v=gSuivi(r.peer);const boss=monsters.some(m=>m.hp>0&&m.d.boss&&m.key!=='dragon'&&!m.inv&&Math.hypot(m.x-r.x,m.y-r.y)<8);if(num(r.p.hp,100)<100)v.serie=0;else if(boss)v.serie=(v.serie||0)+1;v.invul=Math.max(v.invul,v.serie||0);}}catch(e){}},1000);
    window.__gsuivi=()=>{const o={};for(const [p,v] of G_SUIVI){if(v.clip||v.loin||v.invul)o[p]={clip:Math.round(v.clip),loin:v.loin,invul:v.invul};v.clip=0;v.loin=0;v.invul=v.serie||0;if(!remotes.has(p))G_SUIVI.delete(p);}return o;};
    window.__gardien={etat:()=>({scene,host:amHost,monstres:monsters.length,vivants:monsters.filter(m=>m.hp>0).length,joueurs:[...remotes.values()].filter(r=>r.p&&!r.p.gd&&r.p.s===sceneKey()).length,sc:sceneKey(),tues:realmKills,peer:myPeer})};
  `;
  new vm.Script(code.slice(0, fin) + '\n' + init + '\n' + code.slice(fin), { filename: 'index.html' }).runInContext(ctx);
  if (cible === 'realm') log('[gardien] en place dans les Plaines Sauvages');
  return {
    ctx, etat: () => ctx.__gardien ? ctx.__gardien.etat() : null,
    aller: c => ctx.__aller(c),
    arreter: () => { mort = true; for (const id of minuteries) clearTimeout(id); for (const id of intervalles) clearInterval(id); minuteries.clear(); intervalles.clear(); for (const ws of sockets) { try { ws.onclose = null; ws.close(); } catch {} } sockets.clear(); },
  };
}

module.exports = { demarrer };

// lancé par server.js (processus séparé) : pour chaque serveur (salle), une copie pour les Plaines
// et une par donjon occupé ; une copie d'avance attend au Village pour aller vite
if (require.main === module) {
  const port = +process.env.GARDIEN_PORT || 3000, cle = process.env.GARDIEN_CLE || '';
  const caps = new Map(), clip = new Map();
  const lancer = (cible, salle) => { const G = demarrer({ port, cle, cible, salle }); G.salle = salle; for (const [p, c] of caps) try { G.ctx.__gcap(p, c); } catch {} return G; };
  const plaines = new Map(), donjons = new Map(); // salle -> copie · 'salle|scène' -> copie
  const reserves = new Map(); // salle -> copie qui attend au Village
  const toutes = () => [...plaines.values(), ...reserves.values(), ...donjons.values()];
  const ouvrirSalle = salle => {
    if (!/^[a-z0-9_-]{1,32}$/.test(salle) || plaines.has(salle)) return;
    try { plaines.set(salle, lancer('realm', salle)); console.log('[gardien] Plaines gardées : ' + salle); } catch (e) { console.error('[gardien] échec du démarrage :', e.stack || e.message); if (salle === 'principal') process.exit(1); }
    preparer(salle);
  };
  const preparer = salle => { if (reserves.has(salle)) return; setTimeout(() => { if (reserves.has(salle) || !plaines.has(salle)) return; try { reserves.set(salle, lancer('pool', salle)); } catch (e) { console.error('[gardien] réserve :', e.message); } }, 1500); };
  ouvrirSalle('principal');
  const MAX_DONJONS = +process.env.GARDIEN_MAX_DONJONS || 12;
  process.on('message', m => {
    try {
      if (!m) return;
      if (m.t === 'cap') { const c = Math.max(1000, +m.cap || 25000); caps.set(String(m.peer), c); for (const G of toutes()) if (G.ctx.__gcap) G.ctx.__gcap(String(m.peer), c); }
      else if (m.t === 'capfin') caps.delete(String(m.peer));
      else if (m.t === 'salle') ouvrirSalle(String(m.salle || ''));
      else if (m.t === 'sallefin') {
        const salle = String(m.salle || ''); if (salle === 'principal') return;
        for (const [k, G] of donjons) if (G.salle === salle) { G.arreter(); donjons.delete(k); }
        const r = reserves.get(salle); if (r) { r.arreter(); reserves.delete(salle); }
        const G = plaines.get(salle); if (G) { G.arreter(); plaines.delete(salle); console.log('[gardien] Plaines libérées : ' + salle); }
      }
      else if (m.t === 'donjon') {
        const salle = String(m.salle || 'principal'), sc = String(m.s || ''), k = salle + '|' + sc;
        if (!/^d[a-z][0-9a-z]{1,10}$/.test(sc) || donjons.has(k) || !plaines.has(salle)) return;
        if (donjons.size >= MAX_DONJONS) { console.log('[gardien] trop de donjons ouverts, ' + sc + ' sans Gardien'); return; }
        let G = reserves.get(salle); reserves.delete(salle);
        if (G) G.aller(sc); else G = lancer(sc, salle);
        donjons.set(k, G); preparer(salle);
      } else if (m.t === 'fin') {
        const k = String(m.salle || 'principal') + '|' + String(m.s || ''), G = donjons.get(k); if (!G) return;
        donjons.delete(k); G.arreter();
      }
    } catch (e) { console.error('[gardien]', e.message); }
  });
  // surveillance : dégâts rognés, coups de loin, joueurs qui ne perdent jamais de vie près d'un boss
  setInterval(() => {
    const rap = new Map();
    for (const G of toutes()) { let r = null; try { r = G.ctx.__gsuivi && G.ctx.__gsuivi(); } catch {} if (!r) continue;
      for (const [peer, v] of Object.entries(r)) { const a = rap.get(peer) || { clip: 0, loin: 0, invul: 0 }; a.clip += v.clip || 0; a.loin += v.loin || 0; a.invul = Math.max(a.invul, v.invul || 0); rap.set(peer, a); } }
    if (rap.size && process.send) try { process.send({ t: 'suivi', rap: Object.fromEntries(rap) }); } catch {}
  }, 10000).unref();
  process.on('disconnect', () => process.exit(0));
  // garde-fou mémoire : le serveur le relance aussitôt
  setInterval(() => { if (process.memoryUsage().rss > 1200e6) { console.log('[gardien] mémoire trop haute, redémarrage'); process.exit(2); } }, 60000).unref();
  setInterval(() => { try { const t = [...plaines].map(([s, G]) => { const e = G.etat(); return s + ' : ' + (e ? e.vivants + ' monstres, ' + e.joueurs + ' joueur(s)' : '?'); }).join(' · '); console.log(`[gardien] ${t} · ${donjons.size} donjon(s) gardé(s) · ${Math.round(process.memoryUsage().rss / 1e6)} Mo`); } catch {} }, 10 * 60000).unref();
}
