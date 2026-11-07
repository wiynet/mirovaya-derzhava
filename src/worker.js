// ============================================================================
//  Cloudflare Worker: раздаёт сайт, распределяет игроков по серверам (комнатам)
//  и держит саму игру в Durable Objects.
//
//  /api/join            → Lobby выбирает комнату, где меньше 50 человек
//  /api/rooms           → список комнат и сколько в них игроков
//  /ws/<room>           → WebSocket в конкретную комнату (Room)
//  всё остальное        → файлы из папки public/
// ============================================================================
import {DurableObject} from 'cloudflare:workers';
import {RoomCore, prepareData, RULES} from '../public/game.js';
import RAW from '../public/data/game.json';

const DATA = prepareData(RAW);
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if (url.pathname === '/api/join' || url.pathname === '/api/rooms'){
      return env.LOBBY.get(env.LOBBY.idFromName('main')).fetch(req);
    }
    const m = url.pathname.match(/^\/ws\/([a-z0-9-]{1,24})$/);
    if (m){
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Нужен WebSocket', {status: 426});
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};

// ---------- Lobby: кто в какой комнате ----------
export class Lobby extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.rooms = {};      // id -> {n, ts}
    this.next = 1;
    ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await ctx.storage.get('rooms')) || {};
      this.next = (await ctx.storage.get('next')) || 1;
    });
  }
  async fetch(req){
    const url = new URL(req.url);
    const now = Date.now();
    // counts older than 2 minutes without a report are not trusted
    for (const id in this.rooms) if (now - this.rooms[id].ts > 120e3 && this.rooms[id].n > 0) this.rooms[id].n = 0;

    if (url.pathname === '/api/report' && req.method === 'POST'){
      const {room, n} = await req.json();
      if (typeof room === 'string') this.rooms[room] = {n: Math.max(0, n | 0), ts: now};
      await this.ctx.storage.put('rooms', this.rooms);
      return json({ok: true});
    }
    if (url.pathname === '/api/rooms'){
      return json({cap: RULES.CAP, rooms: Object.entries(this.rooms).map(([id, r]) => ({id, n: r.n})).sort((a, b) => a.id.localeCompare(b.id, 'en', {numeric: true}))});
    }
    // /api/join?exclude=r1,r2 — fill the fullest room that still has space, otherwise open a new one
    const exclude = new Set((url.searchParams.get('exclude') || '').split(',').filter(Boolean));
    let pick = null;
    for (const [id, r] of Object.entries(this.rooms)){
      if (exclude.has(id) || r.n >= RULES.CAP) continue;
      if (!pick || r.n > this.rooms[pick].n) pick = id;
    }
    if (!pick){ pick = 'r' + this.next++; await this.ctx.storage.put('next', this.next); }
    // reserve a place so a burst of players doesn't overfill one room before it reports back
    this.rooms[pick] = {n: (this.rooms[pick]?.n || 0) + 1, ts: now};
    await this.ctx.storage.put('rooms', this.rooms);
    return json({room: pick, cap: RULES.CAP});
  }
}

// ---------- Room: одна игра до 50 человек ----------
export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.env = env;
    this.wrap = new WeakMap();
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('state');
      this.roomName = (await ctx.storage.get('name')) || 'room';
      this.core = new RoomCore(DATA, saved, {name: this.roomName, onChange: () => this.save()});
      // after hibernation: put the sockets that are still open back into the game
      for (const ws of ctx.getWebSockets()){
        const att = ws.deserializeAttachment() || {};
        const conn = this.conn(ws);
        if (att.pid) this.core.restore(conn, att.pid); else this.core.conns.add(conn);
      }
    });
  }
  conn(ws){
    let c = this.wrap.get(ws);
    if (!c){
      c = {ws, send: o => ws.send(JSON.stringify(o)), close: () => { try { ws.close(1000, 'full'); } catch {} }};
      this.wrap.set(ws, c);
    }
    return c;
  }
  async fetch(req){
    const name = (new URL(req.url).pathname.match(/^\/ws\/([a-z0-9-]{1,24})$/) || [])[1] || 'room';
    if (name !== this.roomName){ this.roomName = name; this.core.name = name; await this.ctx.storage.put('name', name); }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const conn = this.conn(server);
    this.core.connect(conn);   // if the room already has 50 players the client gets {t:'full'} and moves to another room
    await this.report();
    await this.schedule();
    return new Response(null, {status: 101, webSocket: client});
  }
  async webSocketMessage(ws, raw){
    let msg; try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const conn = this.conn(ws);
    if (!this.core.conns.has(conn)) return;
    this.core.message(conn, msg);
    if (msg.t === 'hello' && conn.pid) ws.serializeAttachment({pid: conn.pid});
    await this.schedule();
  }
  // wake up exactly when the next army arrives / war is justified / revolt check is due
  async alarm(){ this.core.tick(Date.now()); await this.schedule(); }
  async schedule(){
    const t = this.core.nextDue();
    if (!isFinite(t)) return;
    const at = Math.max(Date.now() + 250, t);
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > at || cur < Date.now()) await this.ctx.storage.setAlarm(at);
  }
  async webSocketClose(ws){ this.core.close(this.conn(ws)); await this.report(); }
  async webSocketError(ws){ this.core.close(this.conn(ws)); await this.report(); }
  save(){ this.ctx.storage.put('state', this.core.s); }
  async report(){
    const n = this.core.online();
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('main'));
    try { await stub.fetch('https://lobby/api/report', {method: 'POST', body: JSON.stringify({room: this.roomName, n})}); } catch {}
  }
}
