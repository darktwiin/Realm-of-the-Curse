// Copie de sécurité de la base de données (lancée chaque nuit par cron).
// Garde les 14 dernières copies dans BACKUP_DIR.
const path = require('path'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'sauvegardes');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const d = new Date(), stamp = d.toISOString().slice(0, 16).replace(/[:T]/g, '-');
const cible = path.join(BACKUP_DIR, `jeu-${stamp}.db`);
const db = new DatabaseSync(path.join(DATA_DIR, 'jeu.db'));
db.exec(`VACUUM INTO '${cible.replace(/'/g, "''")}'`);
db.close();
for (const f of ['classement.json', 'guildes.json', 'raid.json', 'moderation.json']) {
  const src = path.join(__dirname, '..', f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BACKUP_DIR, `${f.replace('.json', '')}-${stamp}.json`));
}
const vieilles = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('jeu-')).sort().reverse().slice(14);
for (const f of vieilles) fs.unlinkSync(path.join(BACKUP_DIR, f));
console.log('Sauvegarde OK :', cible);
