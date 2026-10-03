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
function demarrer({ port, cle, salle = 'principal', log = console.log, cible = 'realm', bot = null }) {
  // minuteries et connexion propres à cette copie du jeu, pour pouvoir l'arrêter proprement
  let mort = false; const minuteries = new Set(), intervalles = new Set(), sockets = new Set();
  const sT = (f, ms, ...a) => { if (mort) return 0; const id = setTimeout(() => { minuteries.delete(id); if (!mort) f(...a); }, ms); minuteries.add(id); return id; };
  const sI = (f, ms, ...a) => { if (mort) return 0; const id = setInterval(() => { if (!mort) f(...a); }, ms); intervalles.add(id); return id; };
  const cT = id => { clearTimeout(id); minuteries.delete(id); }, cI = id => { clearInterval(id); intervalles.delete(id); };
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const a = html.indexOf('<script>'), b = html.indexOf('</script>', a);
  const code = html.slice(a + 8, b);
  // sauvegarde du Gardien : un héros au hasard, déjà passé par le tutoriel
  const save0 = { current: 'mage', pseudo: bot ? bot.nom : 'Gardien', gold: 0, cursite: 0, prestige: 0, chars: {}, tuto: 1, tutoDone: true, seenTuto: true };
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
    location: { protocol: 'http:', host: 'localhost:' + port, hostname: 'localhost', port: String(port), search: '?salle=' + salle + (bot ? '&bot=' : '&gardien=') + cle, href: 'http://localhost:' + port + '/', pathname: '/', reload: () => {}, origin: 'http://localhost:' + port },
    localStorage: stockage({ 'royaume-maudit-v1': JSON.stringify(save0) }), sessionStorage: stockage(),
    performance: { now: () => Date.now() - debut }, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, screen: { width: 1280, height: 720 },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), getComputedStyle: () => new Proxy({}, { get: () => '' }),
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, alert: () => {}, confirm: () => true, prompt: () => null, open: () => null, scrollTo: () => {}, focus: () => {},
    requestAnimationFrame: f => sT(() => f(Date.now() - debut), 33), cancelAnimationFrame: cT,
    setTimeout: sT, clearTimeout: cT, setInterval: sI, clearInterval: cI, queueMicrotask,
    Image: function () { return element('img'); }, Audio: function () { return element('audio'); }, AudioContext: function () { return noop; }, webkitAudioContext: undefined, OffscreenCanvas: undefined,
    WebSocket: function (url) { const ws = new WebSocket(url.replace(/^ws:\/\/[^/]+/, 'ws://127.0.0.1:' + port) + (url.includes('?') ? '&' : '?') + (bot ? 'bot=' : 'gardien=') + encodeURIComponent(cle)); sockets.add(ws); ws.on('error', () => {}); return ws; },
    URL: Object.assign(function (u, b) { return new URL(u, b); }, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }), URLSearchParams, TextEncoder, TextDecoder, Blob: function () {}, FileReader: function () { return noop; },
    fetch: () => Promise.reject(new Error('pas de réseau')), crypto: globalThis.crypto, structuredClone, atob, btoa,
    Math, JSON, Date, Object, Array, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet, Promise, Proxy, Reflect, RegExp, Error, TypeError, RangeError,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, Intl,
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; }, MutationObserver: function () { return { observe() {}, disconnect() {} }; }, IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
    ImageData: function (d, w, h) { this.data = d; this.width = w; this.height = h; }, Event: function () {}, KeyboardEvent: function () {}, MouseEvent: function () {}, CustomEvent: function () {}, HTMLElement: function () {}, HTMLCanvasElement: function () {}, Path2D: function () { return noop; }, DOMMatrix: function () { return noop; },
    speechSynthesis: undefined, history: { replaceState() {}, pushState() {} }, getSelection: () => ({ removeAllRanges() {} }),
    GARDIEN_MODE: !bot, BOT_MODE: !!bot,
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
  new vm.Script(code.slice(0, fin) + '\n' + (bot ? initBot(bot) : init) + '\n' + code.slice(fin), { filename: 'index.html' }).runInContext(ctx);
  if (bot) log('[bots] ' + bot.nom + ' entre en jeu'); else if (cible === 'realm') log('[gardien] en place dans les Plaines Sauvages');
  return {
    ctx, etat: () => ctx.__gardien ? ctx.__gardien.etat() : null,
    aller: c => ctx.__aller(c),
    arreter: () => { mort = true; for (const id of minuteries) clearTimeout(id); for (const id of intervalles) clearInterval(id); minuteries.clear(); intervalles.clear(); for (const ws of sockets) { try { ws.onclose = null; ws.close(); } catch {} } sockets.clear(); },
  };
}

// ---------- les bots : de faux joueurs qui se promènent au Village, vont se battre dans les Plaines et saluent les vrais joueurs ----------
// Chaque bot est une copie du jeu sans affichage, pilotée par ce petit programme. Il n'a pas de compte : il ne gagne ni butin ni expérience.
const NOMS_BOTS = ['Kaelis', 'Morwen', 'Tybalt', 'Lysandre', 'Zephyr', 'Nox', 'Eldrin', 'Sorya', 'Baldur', 'Ysolde', 'Fenrir', 'Maëlle', 'Orion', 'Thalia', 'Gauvain', 'Liora', 'Ragnar', 'Elowen', 'Darius', 'Naïa'];
function initBot(bot) {
  return `
    render=function(){};updHUD=function(){};renderPlayers=function(){};drawMini=function(){};sfx=function(){};setSong=function(){};
    note=function(){};showBanner=function(){};ft=function(){};burst=function(){};pushChat=function(){};sendScore=function(){};
    const BN=${JSON.stringify(bot.noms)},BOTNOM=${JSON.stringify(bot.nom)};
    const B={mode:'village',until:0,path:null,pi:0,wait:0,tgt:null,salue:new Map(),parle:0,strafe:1,strafeT:0,bloque:0,lx:0,ly:0,evite:0,ea:0,capa:0,zi:0};
    function botHero(){const cl=pick(['guerrier','mage','archer','pretre','guerrier','mage','archer','pretre','assassin','bouclier']),lv=3+Math.floor(Math.random()*18),c=CLASSES[cl],t=Math.min(6,Math.max(0,Math.floor(lv/3.2)+(Math.random()<0.3?1:0)));
      const ch=newChar(cl);ch.lvl=lv;ch.equip=[mkItem(c.arme,t),mkItem(c.capa,Math.max(0,t-(Math.random()<0.5?1:0))),mkItem(c.armure,t),Math.random()<0.7?mkItem('anneau',Math.max(0,t-1)):null];
      save.chars={};save.chars[cl]=ch;save.current=cl;pseudo=BOTNOM;save.pseudo=BOTNOM;statsDirty=true;B.zi=lv<5?0:lv<8?1:lv<11?2:lv<14?3:4;const st=S();P.hp=st.tot.vie;P.mp=st.tot.mana;}
    botHero();paused=false;
    aimWorld=function(){return B.aim||{x:P.x+P.face,y:P.y};};
    die=function(){keys.clear();P.auto=false;B.mode='village';B.path=null;B.until=time+rnd(60,200);enterNexus();const st=S();P.hp=st.tot.vie;P.mp=st.tot.mana;paused=false;if(Math.random()<0.4)botHero();};
    const vers=(dx,dy)=>{keys.clear();if(Math.abs(dx)>0.2)keys.add(dx>0?'KeyD':'KeyA');if(Math.abs(dy)>0.2)keys.add(dy>0?'KeyS':'KeyW');};
    const libre=(x,y)=>x>=-11&&!MAP.sol[y*MAP.stride+x+MAP.ox];
    // chemin dans le Village : parcours en largeur sur les cases libres
    function chemin(tx,ty){const W=MAP.stride,H=MAP.h,sx0=Math.floor(P.x),sy0=Math.floor(P.y),prev=new Map(),q=[[sx0,sy0]];prev.set(sy0*W+sx0+MAP.ox,-1);
      for(let h=0;h<q.length&&h<6000;h++){const [x,y]=q[h];if(x===tx&&y===ty){const out=[];let k=y*W+x+MAP.ox;while(k!==-1&&k!=null){out.push([(k%W)-MAP.ox,Math.floor(k/W)]);k=prev.get(k);}return out.reverse();}
        for(const [a,b] of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+a,ny=y+b;if(ny<1||ny>=H-1||nx<-11||nx>=NW-1||!libre(nx,ny))continue;const k=ny*W+nx+MAP.ox;if(prev.has(k))continue;prev.set(k,y*W+x+MAP.ox);q.push([nx,ny]);}}
      return null;}
    const LIEUX=[[16,21],[13,13],[19,13],[20,20],[12,21],[28,16],[36,17],[38,19],[4,16],[-5,17],[-8,19],[8,29],[16,26],[22,29],[16,7],[10,8],[22,8],[15,36],[12,40],[8,42],[24,41],[33,44],[38,44],[26,38],[5,24],[27,24]];
    function botVillage(){if(scene!=='nexus'){enterNexus();B.path=null;return;}
      if(time>B.until&&!B.path){const p=chemin(16,5);if(p){B.path=p;B.pi=0;B.vaPlaines=true;}else B.until=time+20;}
      if(B.wait>time){keys.clear();return;}
      if(!B.path){const [tx,ty]=pick(LIEUX);const p=libre(tx,ty)?chemin(tx,ty):null;if(p&&p.length>1){B.path=p;B.pi=0;}else{B.wait=time+1;}return;}
      const n=B.path[B.pi];if(!n){B.path=null;keys.clear();if(B.vaPlaines){B.vaPlaines=false;B.mode='plaines';B.until=time+rnd(180,420);B.tgt=null;enterRealm();return;}B.wait=time+rnd(2,11);return;}
      const dx=n[0]+.5-P.x,dy=n[1]+.5-P.y;if(Math.hypot(dx,dy)<0.35){B.pi++;return;}vers(dx,dy);}
    function botPlaines(){if(scene!=='realm'){B.mode='village';B.until=time+rnd(90,300);B.path=null;keys.clear();P.auto=false;return;}
      const st=S();if(time>B.until||P.hp<st.tot.vie*0.22){keys.clear();P.auto=false;B.mode='village';B.until=time+rnd(90,300);B.path=null;enterNexus();P.hp=st.tot.vie;return;}
      if(P.hp<st.tot.vie*0.5&&time>(B.pot||0)){B.pot=time+6;P.hp=Math.min(st.tot.vie,P.hp+120);}   // une potion de temps en temps
      const w=C().equip[0],rng=w&&WB[w.kind]?WB[w.kind].range:5;let m=null,md=1e9;for(const q of monsters){if(q.hp<=0)continue;const d=Math.hypot(q.x-P.x,q.y-P.y);if(d<md){md=d;m=q;}}
      if(m&&md<Math.max(8,rng+2)){B.aim={x:m.x,y:m.y};P.auto=md<rng*1.05;const ux=(m.x-P.x)/(md||1),uy=(m.y-P.y)/(md||1);if(time>B.strafeT){B.strafeT=time+rnd(0.7,2);B.strafe=Math.random()<0.5?-1:1;}
        let k=md>rng*0.85?1:md<Math.min(rng*0.5,3)?-1:0;if(P.hp<st.tot.vie*0.4)k=-1;vers(ux*k-uy*B.strafe*0.8,uy*k+ux*B.strafe*0.8);
        if(time>B.capa&&P.mp>=(C().equip[1]?C().equip[1].cost||40:999)){B.capa=time+rnd(4,9);try{useAbility();}catch(e){}}
      }else{P.auto=false;B.aim=null;
        if(!B.tgt||Math.hypot(B.tgt.x-P.x,B.tgt.y-P.y)<3||time>B.tgtT){const z=ZONES[B.zi].r,a0=Math.atan2(P.y-RC,P.x-RC),a=a0+rnd(-0.35,0.35),rr=rnd(z[0]+2,z[1]-2);B.tgt={x:RC+Math.cos(a)*rr,y:RC+Math.sin(a)*rr};B.tgtT=time+40;}
        let dx=B.tgt.x-P.x,dy=B.tgt.y-P.y;if(time<B.evite){const l=Math.hypot(dx,dy)||1,c=Math.cos(B.ea),s2=Math.sin(B.ea);const x2=dx/l*c-dy/l*s2,y2=dx/l*s2+dy/l*c;dx=x2;dy=y2;}vers(dx,dy);}
      // coincé contre un obstacle : on contourne
      if(time>B.bloque){B.bloque=time+0.8;if(Math.hypot(P.x-B.lx,P.y-B.ly)<0.5&&keys.size){B.evite=time+rnd(0.8,1.6);B.ea=(Math.random()<0.5?-1:1)*rnd(1.2,1.9);}B.lx=P.x;B.ly=P.y;}}
    function botSalue(){if(time<B.parle)return;const k=sceneKey();for(const r of remotes.values()){if(!r.p||r.p.gd||r.p.s!==k||!r.p.n||BN.includes(r.p.n))continue;if(Math.hypot(r.x-P.x,r.y-P.y)>5)continue;if((B.salue.get(r.p.n)||0)>Date.now())continue;
        B.salue.set(r.p.n,Date.now()+15*60000);if(Math.random()>0.2)return;B.parle=time+25;setTimeout(()=>{try{sendChat(pick(['salut','coucou','bonjour','salut !','coucou !','bonjour !','yo','cc','hello','salut '+String(r.p.n).slice(0,16)]));}catch(e){}},700+Math.random()*2200);return;}}
    // de temps en temps, quand un vrai joueur est dans le coin, le bot parle des évènements en cours
    function botSujets(){const l=[],now=Date.now(),j=ms=>Math.max(0,Math.ceil(ms/86400000)),h=ms=>Math.max(1,Math.round(ms/3600000));
      if(typeof CONC!=='undefined'&&CONC&&!CONC.g){const d=CONC.debut-now;
        if(d>0)l.push(d<3600000?'le concours commence dans moins d une heure !':d<86400000?'concours dans '+h(d)+' h, vous y serez ?':'vous faites le concours du premier donjon ?','500 cursite pour le premier qui finit le donjon du concours, ça motive','on sait toujours pas quel donjon ce sera pour le concours','je m entraine pour le concours, faut être rapide');
        else l.push('le concours est lancé ! '+(CONC.dn?'c est '+CONC.dn:'foncez'),'quelqu un a déjà fini le donjon du concours ?','le portail du concours est au village, près de la fontaine');}
      else if(typeof CONC!=='undefined'&&CONC&&CONC.g)l.push('gg à '+String(CONC.g.n||'').slice(0,16)+' pour le concours','500 cursite le concours, bien joué au gagnant');
      if(typeof RAIDEV!=='undefined'&&RAIDEV){if(RAIDEV.fin&&now<RAIDEV.fin)l.push('le raid du dragon est ouvert !','qui a une guilde pour le dragon ?');else if(RAIDEV.spawn&&RAIDEV.spawn>now)l.push('raid du dragon dans '+(RAIDEV.spawn-now<86400000?h(RAIDEV.spawn-now)+' h':j(RAIDEV.spawn-now)+' jours')+', faut une guilde','quelqu un recrute pour le raid du dragon ?','3 par guilde pour le raid, qui est chaud ?');}
      l.push('quelqu un a déjà eu une clef du temps ?','chronos est vraiment dur','vous avez vu la table à dessin au village ?','le pêcheur donne un titre si on attrape tout','pensez au cadeau de connexion du jour','j ai enfin fait évoluer mon familier','le wiki est pratique pour les taux de drop (touche B)','qui vient dans les plaines ?','un boss au centre tous les 20 monstres, à plusieurs ça passe mieux','le tier 7 tombe que dans les deux derniers donjons','faut le niveau 15 pour débloquer le héros suivant');
      return l;}
    function botParle(){if(time<B.sujetT||time<B.parle)return;const k=sceneKey();let vu=false;for(const r of remotes.values()){if(r.p&&!r.p.gd&&r.p.s===k&&r.p.n&&!BN.includes(r.p.n)&&Math.hypot(r.x-P.x,r.y-P.y)<12){vu=true;break;}}
      if(!vu){B.sujetT=time+15;return;}B.sujetT=time+rnd(750,2100);B.parle=time+25;const l=botSujets().filter(t=>t!==B.dernier);const t=pick(l);B.dernier=t;try{sendChat(t);}catch(e){}}
    B.sujetT=time+rnd(200,800);
    setInterval(()=>{try{paused=false;if(!deathEl.hidden)deathEl.hidden=true;mouse.down=false;if(B.mode==='village')botVillage();else botPlaines();botSalue();botParle();}catch(e){console.error('bot',e);}},120);
    B.until=time+rnd(30,240);
    window.__bot={etat:()=>({nom:pseudo,cls:save.current,lvl:C().lvl,mode:B.mode,scene,x:Math.round(P.x),y:Math.round(P.y),hp:Math.round(P.hp)})};
  `;
}

module.exports = { demarrer, NOMS_BOTS };

// lancé par server.js (processus séparé) : pour chaque serveur (salle), une copie pour les Plaines
// et une par donjon occupé ; une copie d'avance attend au Village pour aller vite
if (require.main === module) {
  // une erreur dans une copie du jeu ne doit jamais arrêter tout le Gardien (le monde entier repartirait de zéro)
  process.on('uncaughtException', e => { console.error('[gardien] erreur ignorée :', (e && e.stack || e).toString().split('\n').slice(0, 4).join(' | ')); });
  process.on('unhandledRejection', e => { console.error('[gardien] promesse rejetée :', e && e.message || e); });
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
  // les bots (serveur principal seulement) : BOTS=0 pour les couper, 4 par défaut
  const NB_BOTS = Math.max(0, Math.min(12, process.env.BOTS == null ? 4 : (+process.env.BOTS || 0))), bots = [];
  if (NB_BOTS) { const noms = NOMS_BOTS.slice().sort(() => Math.random() - 0.5).slice(0, NB_BOTS);
    noms.forEach((nom, i) => setTimeout(() => { try { bots.push(demarrer({ port, cle, salle: 'principal', bot: { nom, noms }, log: m => console.log(m) })); } catch (e) { console.error('[bots] échec :', e.stack || e.message); } }, 6000 + i * 5000)); }
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
