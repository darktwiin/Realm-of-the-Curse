// Prévient les joueurs connectés qu'une mise à jour arrive (compte à rebours à l'écran).
// Utilisation : DATA_DIR=/var/lib/royaume node deploy/annoncer.js 30
// Sortie 0 si l'annonce est partie, 1 sinon (ancien serveur, serveur arrêté…).
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const sec = Math.max(5, Math.min(300, Math.floor(Number(process.argv[2]) || 30)));
let conf;
try { conf = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'annonce.json'), 'utf8')); }
catch { console.log('Pas d\'annonce possible (le serveur ne la gère pas encore).'); process.exit(1); }
const req = http.request({ host: '127.0.0.1', port: conf.port, path: '/__annonce?s=' + sec + '&cle=' + conf.cle, method: 'POST', timeout: 4000 }, res => {
  let t = ''; res.on('data', d => t += d); res.on('end', () => { const ok = res.statusCode === 200; console.log(ok ? 'Annonce envoyée aux joueurs : mise à jour dans ' + sec + ' s.' : 'Annonce refusée (' + res.statusCode + ').'); process.exit(ok ? 0 : 1); });
});
req.on('timeout', () => { req.destroy(); });
req.on('error', () => { console.log('Serveur injoignable : pas d\'annonce.'); process.exit(1); });
req.end();
