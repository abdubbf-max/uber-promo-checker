// Serveur local — reçoit les comptes de l'extension et met à jour local-config.json
const http = require('http');
const fs   = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, 'local-config.json');
const PORT   = 3001;

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const accounts = JSON.parse(body);
        if (!Array.isArray(accounts)) throw new Error('JSON doit être un tableau');
        fs.writeFileSync(CONFIG, JSON.stringify(accounts, null, 2), 'utf8');
        console.log(`[sync] ✅ local-config.json mis à jour — ${accounts.length} compte(s)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: accounts.length }));
      } catch (e) {
        console.error('[sync] ❌ Erreur:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();

}).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  Sync server démarré sur localhost:${PORT}         ║`);
  console.log('║  Clique "💾 Sync" dans l\'extension → auto-sync  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
