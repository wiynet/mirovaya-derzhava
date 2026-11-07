// Локальный сервер для проверки без Cloudflare: `node dev/server.mjs` → http://localhost:8787
// Повторяет то же поведение, что и Worker: /api/join, /api/rooms, /ws/<room>, раздача public/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {RoomCore, prepareData, RULES} from '../public/game.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
const DATA = prepareData(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8')));
const PORT = +process.env.PORT || 8787;
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css'};

const rooms = new Map();        // name -> RoomCore
const lobby = {counts: {}, next: 1};
const room = name => { if (!rooms.has(name)) rooms.set(name, new RoomCore(DATA, null, {name, onChange(){}})); return rooms.get(name); };
const report = name => { lobby.counts[name] = room(name).online(); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/join'){
    const ex = new Set((url.searchParams.get('exclude') || '').split(',').filter(Boolean));
    let pick = null;
    for (const [id, n] of Object.entries(lobby.counts)) if (!ex.has(id) && n < RULES.CAP && (!pick || n > lobby.counts[pick])) pick = id;
    if (!pick) pick = 'r' + lobby.next++;
    lobby.counts[pick] = (lobby.counts[pick] || 0) + 1;
    res.writeHead(200, {'content-type': 'application/json'}); return res.end(JSON.stringify({room: pick, cap: RULES.CAP}));
  }
  if (url.pathname === '/api/rooms'){
    res.writeHead(200, {'content-type': 'application/json'});
    return res.end(JSON.stringify({cap: RULES.CAP, rooms: Object.entries(lobby.counts).map(([id, n]) => ({id, n}))}));
  }
  let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (err, buf) => {
    if (err){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'content-type': TYPES[path.extname(p)] || 'application/octet-stream'}); res.end(buf);
  });
});

// --- minimal WebSocket (RFC 6455), text frames only ---
server.on('upgrade', (req, socket) => {
  const m = req.url.match(/^\/ws\/([a-z0-9-]{1,24})$/);
  if (!m) return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const r = room(m[1]);
  let open = true;
  const conn = {
    send(o){ if (!open) return; const data = Buffer.from(JSON.stringify(o)); let head;
      if (data.length < 126) head = Buffer.from([0x81, data.length]);
      else if (data.length < 65536){ head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
      socket.write(Buffer.concat([head, data])); },
    close(){ if (!open) return; open = false; try { socket.end(Buffer.from([0x88, 0])); } catch {} }
  };
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2){
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
      if (len === 126){ if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 0x80; const mask = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len); buf = buf.slice(off + len);
      if (mask) payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      if (op === 8){ finish(); return; }
      if (op === 9){ socket.write(Buffer.from([0x8a, 0])); continue; }
      if (op === 1){ try { r.message(conn, JSON.parse(payload.toString('utf8'))); } catch {} }
    }
  });
  const finish = () => { if (!open && !r.conns.has(conn)) return; open = false; r.close(conn); report(m[1]); try { socket.destroy(); } catch {} };
  socket.on('close', finish); socket.on('error', finish);
  r.connect(conn); report(m[1]);
});

setInterval(() => { for (const r of rooms.values()) r.tick(Date.now()); }, 500);
server.listen(PORT, () => console.log(`Мировая держава: http://localhost:${PORT}`));
