// The Curse — génère public/wiki.html à partir du jeu lui-même (objets, monstres, zones, donjons, butin, poissons).
// À relancer à chaque mise à jour du jeu :  PW=/chemin/vers/playwright node outils/generer-wiki.js
// Le jeu est ouvert sans réseau dans un navigateur invisible ; les chiffres et les images viennent donc du vrai code.
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const racine = path.join(__dirname, '..');
(async () => {
  let html = fs.readFileSync(path.join(racine, 'public', 'index.html'), 'utf8');
  const ancre = 'function installDebug(){';
  if (!html.includes(ancre)) throw new Error('ancre introuvable dans index.html');
  html = html.replace(ancre, 'window.__W=src=>eval(src);\n' + ancre);
  const police = (html.match(/@font-face\{[^}]*DotGothic16[^}]*\}/) || [''])[0];
  const b = await chromium.launch(), p = await b.newPage();
  await p.route('**/*', r => r.request().url() === 'http://wiki.local/' ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort());
  await p.goto('http://wiki.local/'); await p.waitForTimeout(1500);
  const D = await p.evaluate(() => window.__W(`(()=>{
    const url=c=>{try{return c.toDataURL();}catch(e){return '';}};
    const ver=(document.body.textContent.match(/ver\\.0\\.0\\.\\d+/)||[''])[0];
    const classes=Object.keys(CLASSES).map(k=>{const c=CLASSES[k];return{k,nom:c.nom,role:c.role,arme:KINDS[c.arme].type,capa:KINDS[c.capa].type,armure:KINDS[c.armure].type,base:c.base,gain:c.gain,req:c.req?CLASSES[c.req].nom:null,ic:url(heroSprite(k,null,c.arme,3,'idle'))};});
    const objets=[];
    for(const k of Object.keys(KINDS)){const K=KINDS[k],tiers=K.slot==='conso'?[0]:K.alt?[7]:K.t7?[6]:[0,1,2,3,4,5,6,7];
      const l=tiers.map(t=>{const it=mkItem(k,t);return{n:it.name,ic:icon(it),tip:itemTipHTML(it),col:K.slot==='conso'?'#dcd8e4':itemCol(it),tag:K.slot==='conso'?'':K.alt?'Chronos':K.t7?'T7':t>=7?'Relique':'T'+t};});
      objets.push({k,type:K.type||'Consommable',slot:K.slot,fam:K.alt?'alt':K.t7?'t7':K.slot==='conso'?'conso':'base',base:K.base||k.replace(/7$/,''),cls:K.cls&&K.slot!=='anneau'?K.cls.map(c=>CLASSES[c].nom):[],l});}
    const ou=k=>{const o=[];ZONES.forEach((z,i)=>{if(z.pool.includes(k))o.push(z.nom);});for(const t in DTYPES){const T=DTYPES[t];if((T.pool||[]).includes(k)||T.bk===k||T.bk2===k)o.push(T.nom);}
      if(CENTRAL.includes(k))o.push('Centre des Plaines (boss)');if(DUNGEON_POOL.includes(k))o.push('Donjons (renforts)');if(typeof ASTRAL_POOL!=='undefined'&&(ASTRAL_POOL.includes(k)||GARDIENS.includes(k)))o.push(DTYPES.a.nom);if(MON[k].tuto)o.push('Tutoriel');if(k==='dragon')o.push('Raid de guilde');return o;};
    const monstres=Object.keys(MON).map(k=>{const d=MON[k];return{k,nom:d.nom,hp:d.hp,xp:d.xp,dmg:d.dmg,arm:d.arm||0,boss:!!d.boss,loot:d.loot||null,drop:d.drop||0,n:d.n||1,rel:d.rel||0,or:d.or||null,ou:ou(k),ic:url(MSPR[k]),dun2:d.dun2||0,mid:!!d.midBoss,z:ZONES.findIndex(z=>z.pool.includes(k))};});
    const zones=ZONES.map((z,i)=>({nom:z.nom,niv:z.niv,pool:z.pool,col:z.col[0],dun:i>=5?DUN_RATE[i]:0}));
    const donjons=Object.keys(DTYPES).map(t=>{const T=DTYPES[t];return{t,nom:T.nom,boss:T.boss,niv:T.niv,mech:T.mech||'',pool:T.pool||[],bk:T.bk,bk2:T.bk2||null,col:T.col[1]};});
    const poissons=FISHES.map(f=>({nom:f.nom,site:f.site,r:FISH_RAR[f.r].nom,col:FISH_RAR[f.r].col,min:f.min,max:f.max,ic:fishURL(f.id)}));
    return JSON.stringify({ver,classes,objets,monstres,zones,donjons,poissons,REG_DUN,MID_DUN,stats:SL});})()`));
  await b.close();
  const data = JSON.parse(D);
  // règles de butin : lues dans butin.js pour rester fidèles au serveur
  const butin = fs.readFileSync(path.join(racine, 'butin.js'), 'utf8');
  const num = (re, d) => { const m = butin.match(re); return m ? +m[1] : d; };
  data.taux = { oeuf: num(/Math\.random\(\) < ([\d.]+)\) \{ out\.oeuf/, 0.005), t7: num(/TAUX_T7 = ([\d.]+)/, 0.05), potion: 0.12, plus1: 0.08 };
  data.date = new Date().toISOString().slice(0, 10);
  const page = fs.readFileSync(path.join(__dirname, 'wiki-modele.html'), 'utf8').replace('/*POLICE*/', police).replace('"__DONNEES__"', JSON.stringify(data).replace(/</g, '\\u003c'));
  fs.writeFileSync(path.join(racine, 'public', 'wiki.html'), page);
  console.log('wiki :', data.ver, '·', data.objets.length, 'types d\'objets ·', data.monstres.length, 'monstres ·', Math.round(page.length / 1024), 'Ko');
})().catch(e => { console.error(e); process.exit(1); });
