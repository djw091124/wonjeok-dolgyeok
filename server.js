const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocket.Server({ server });
let waiting = null;
let nextRoom = 1;
const rooms = new Map();
function send(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room, from, data) { for (const p of room.players) if (p !== from) send(p, data); }
wss.on('connection', ws => {
  ws.alive = true; ws.room = null;
  ws.on('pong', () => ws.alive = true);
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join') {
      if (ws.room) return;
      ws.name = String(msg.name || '플레이어').slice(0, 16);
      ws.fighter = ['spider','hammer','vampire','poojizik'].includes(msg.fighter) ? msg.fighter : 'spider';
      ws.fighterHp = Number(msg.hp) || (ws.fighter === 'hammer' ? 105 : ws.fighter === 'vampire' ? 90 : ws.fighter === 'poojizik' ? 95 : 100);
      if (waiting && waiting.readyState === WebSocket.OPEN && waiting !== ws) {
        const a = waiting; waiting = null;
        const room = { id: String(nextRoom++), players: [a, ws] };
        rooms.set(room.id, room); a.room = ws.room = room;
        send(a, { type: 'matched', slot: 0, opponent: ws.name, fighter: ws.fighter, hp: ws.fighterHp, room: room.id });
        send(ws, { type: 'matched', slot: 1, opponent: a.name, fighter: a.fighter, hp: a.fighterHp, room: room.id });
      } else {
        waiting = ws; send(ws, { type: 'waiting', message: '상대를 찾는 중입니다…' });
      }
    } else if (msg.type === 'cancel') {
      if (waiting === ws) waiting = null;
      send(ws, { type: 'cancelled' });
    } else if (ws.room && ['state', 'damage', 'heal', 'attack', 'pull', 'pooDamage', 'result', 'ready'].includes(msg.type)) {
      broadcast(ws.room, ws, { ...msg, sender: ws.name });
    }
  });
  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.room) {
      const room = ws.room; rooms.delete(room.id);
      broadcast(room, ws, { type: 'opponent_left' });
      for (const p of room.players) { p.room = null; if (p !== ws) send(p, { type: 'opponent_left' }); }
    }
  });
});
const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 30000);
server.listen(PORT, '0.0.0.0', () => console.log(`원격돌격 온라인 서버 실행: ${PORT}`));
process.on('SIGTERM', () => { clearInterval(heartbeat); server.close(() => process.exit(0)); });
