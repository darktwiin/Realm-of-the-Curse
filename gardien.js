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
function demarrer({ port, cle, salle = 'principal', log = console.log }) {
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
    requestAnimationFrame: f => setTimeout(() => f(Date.now() - debut), 33), cancelAnimationFrame: id => clearTimeout(id),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Image: function () { return element('img'); }, Audio: function () { return element('audio'); }, AudioContext: function () { return noop; }, webkitAudioContext: undefined, OffscreenCanvas: undefined,
    WebSocket: function (url) { return new WebSocket(url.replace(/^ws:\/\/[^/]+/, 'ws://127.0.0.1:' + port) + (url.includes('?') ? '&' : '?') + 'gardien=' + encodeURIComponent(cle)); },
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
    function gardienRealm(){ if(scene!=='realm'){ enterRealm(); } P.x=RPORT.x; P.y=RPORT.y-6; P.hp=99999; P.god=true; admInv=true; paused=false; }
    gardienRealm();
    setInterval(()=>{try{ if(scene!=='realm')gardienRealm(); P.hp=S().tot.vie; P.god=true; admInv=true; paused=false; keys.clear&&keys.clear(); mouse.down=false; }catch(e){}},1000);
    // ménage régulier (le Gardien tourne des jours) : joueurs partis, monstres morts
    setInterval(()=>{try{const vivants=new Set(monsters.filter(m=>m.hp>0).map(m=>m.id));for(const [peer,mp] of applied){if(!remotes.has(peer)){applied.delete(peer);G_SEAU.delete(peer);continue;}for(const id of mp.keys())if(!vivants.has(id))mp.delete(id);}chatHist.length=0;chatLog.length=0;texts.length=0;parts.length=0;vfx.length=0;}catch(e){}},60000);
    window.__gardien={etat:()=>({scene,host:amHost,monstres:monsters.length,vivants:monsters.filter(m=>m.hp>0).length,joueurs:[...remotes.values()].filter(r=>r.p&&r.p.s==='r').length,tues:realmKills,peer:myPeer})};
  `;
  new vm.Script(code.slice(0, fin) + '\n' + init + '\n' + code.slice(fin), { filename: 'index.html' }).runInContext(ctx);
  log('[gardien] en place dans les Plaines Sauvages');
  return { ctx, etat: () => ctx.__gardien ? ctx.__gardien.etat() : null };
}

module.exports = { demarrer };

// lancé par server.js (processus séparé)
if (require.main === module) {
  let G = null;
  try { G = demarrer({ port: +process.env.GARDIEN_PORT || 3000, cle: process.env.GARDIEN_CLE || '' }); }
  catch (e) { console.error('[gardien] échec du démarrage :', e.stack || e.message); process.exit(1); }
  process.on('message', m => { try { if (m && m.t === 'cap' && G.ctx.__gcap) G.ctx.__gcap(String(m.peer), Math.max(1000, +m.cap || 25000)); } catch {} });
  process.on('disconnect', () => process.exit(0));
  // garde-fou : au-delà de 700 Mo de mémoire, il redémarre (le serveur le relance aussitôt)
  setInterval(() => { if (process.memoryUsage().rss > 700e6) { console.log('[gardien] mémoire trop haute, redémarrage'); process.exit(2); } }, 60000).unref();
  setInterval(() => { try { const e = G.etat(); if (e) console.log(`[gardien] ${e.vivants} monstres, ${e.joueurs} joueur(s) dans les Plaines, hôte : ${e.host ? 'oui' : 'non'}`); } catch {} }, 10 * 60000).unref();
}
