// ============================================================================
//  «Мировая держава» — общая игровая логика.
//  Один и тот же файл работает и на сервере (Cloudflare Durable Object),
//  и в браузере (офлайн-игра с ботами, а также расчёт денег «вживую»).
// ============================================================================

export const RULES = {
  CAP: 50,                    // максимум игроков на одном сервере (комнате)
  START_MONEY: 1500,
  MAX_ECON: 10,
  ARMY_COST: 5,               // цена одного солдата
  RANGE_KM: 800,              // дальность атаки и переброски войск
  COOLDOWN_MS: 6000,          // пауза между атаками из одного города
  NUKE_STAGES: 5,
  WARHEAD_COST: 8000,
  WARHEAD_MS: 30000,
  NEWS_KEEP: 60,
};
export const nukeStageCost = s => 2500 * s;          // s = 1..5
export const nukeStageMs = s => 20000 * s;
const cityScale = pop => 0.5 + Math.sqrt(pop / 1e5) * 0.5;
export const baseIncome = pop => 0.4 + Math.sqrt(pop / 1000) * 0.08;   // в секунду при уровне экономики 1
export const econCost = (pop, e) => Math.round(80 * e * e * cityScale(pop));
export const armyCap = (pop, e) => Math.round(100 + pop / 600 * e);
export const neutralArmy = pop => Math.max(5, Math.round(pop / 8000));
export const startArmy = pop => Math.max(10, Math.round(pop / 15000));

export function distKm(a, b){
  const R = 6371, r = Math.PI / 180;
  const dLa = (b.la - a.la) * r, dLo = (b.lo - a.lo) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.la * r) * Math.cos(b.la * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const PALETTE = Array.from({length: 60}, (_, i) => `hsl(${Math.round((i * 137.508 + 8) % 360)} 68% 50%)`);

// game.json → удобные индексы
export function prepareData(raw){
  const byId = new Map(), byCc = new Map();
  for (const [id, cc, pop, la, lo, cap, n] of raw.c){
    const c = {id, cc, pop, la, lo, cap, n};
    byId.set(id, c);
    if (!byCc.has(cc)) byCc.set(cc, []);
    byCc.get(cc).push(c);
  }
  return {byId, byCc, names: raw.n};
}

// ---------- чистые функции над состоянием (одинаковые на сервере и в браузере) ----------
export function cityView(s, data, id){
  const base = data.byId.get(id); if (!base) return null;
  const e = s.cities[id];
  if (e) return {id, o: e.o ?? null, a: e.a, e: e.e, pf: e.pf ?? 1, nk: e.nk || 0, cd: e.cd || 0, base};
  return {id, o: null, a: neutralArmy(base.pop), e: 1, pf: 1, nk: 0, cd: 0, base};
}
export function moneyAt(p, now){ return p.m + p.rate * Math.max(0, now - p.t) / 1000; }
export function nukeStage(p, now){ return (p.nu && now >= p.nu) ? p.nt : p.ns; }
export function warheads(p, now){ return p.wh + ((p.wb && now >= p.wb) ? 1 : 0); }

export class RoomCore {
  constructor(data, saved, opts = {}){
    this.data = data;
    this.s = saved && saved.v === 1 ? saved : RoomCore.fresh();
    this.conns = new Set();
    this.name = opts.name || 'room';
    this.onChange = opts.onChange || (() => {});
    this.now = opts.now || (() => Date.now());
  }
  static fresh(){ return {v: 1, created: Date.now(), players: {}, tokens: {}, cities: {}, taken: {}, news: [], seq: 0, lastActive: Date.now()}; }

  online(){ let n = 0; for (const c of this.conns) if (!c.bot) n++; return n; }
  isFull(){ return this.online() >= RULES.CAP; }

  // ---- connections ----
  connect(conn){
    if (!conn.bot && this.isFull()){ conn.send({t: 'full'}); conn.close && conn.close(); return false; }
    // reset a world nobody has played in for 12 hours
    if (this.online() === 0 && this.now() - (this.s.lastActive || 0) > 12 * 3600e3 && Object.keys(this.s.players).length){ this.s = RoomCore.fresh(); }
    this.conns.add(conn);
    return true;
  }
  restore(conn, pid){ conn.pid = pid; this.conns.add(conn); }
  close(conn){
    this.conns.delete(conn);
    const p = conn.pid && this.s.players[conn.pid];
    if (p && ![...this.conns].some(c => c.pid === p.id)){ p.on = 0; p.seen = this.now(); this.broadcast({players: {[p.id]: this.pub(p)}}); }
    this.broadcastOnline();
    this.onChange();
  }

  // ---- messages ----
  message(conn, msg){
    const now = this.now();
    try {
      if (msg.t === 'hello') return this.hello(conn, msg, now);
      if (!conn.pid) return conn.send({t: 'err', msg: 'Сначала войдите'});
      const p = this.s.players[conn.pid];
      if (msg.t === 'claim') return this.claim(conn, p, msg.cc, now);
      if (msg.t === 'act') return this.act(conn, p, msg.a || {}, now);
      if (msg.t === 'ping') return conn.send({t: 'pong', now});
    } catch (e){ conn.send({t: 'err', msg: 'Ошибка сервера'}); }
  }
  hello(conn, msg, now){
    const s = this.s;
    let pid = msg.token && s.tokens[msg.token];
    let p = pid && s.players[pid];
    const name = String(msg.name || '').trim().slice(0, 20) || 'Игрок';
    if (!p){
      pid = 'p' + (++s.seq).toString(36);
      const token = msg.token && /^[a-z0-9]{16,40}$/i.test(msg.token) ? msg.token : randToken();
      s.tokens[token] = pid;
      p = s.players[pid] = {id: pid, name, color: PALETTE[(s.seq - 1) % PALETTE.length], cc: null, m: RULES.START_MONEY, t: now, rate: 0,
        ns: 0, nt: 0, nu: 0, wh: 0, wb: 0, on: 1, seen: now, nc: 0, army: 0};
      conn.token = token;
    } else {
      p.name = name || p.name;
    }
    p.on = 1; p.seen = now; conn.pid = pid; s.lastActive = now;
    conn.send({t: 'welcome', you: pid, token: conn.token || msg.token, room: this.name, cap: RULES.CAP, now, online: this.online(), ...this.snapshot()});
    this.broadcast({players: {[pid]: this.pub(p)}}, conn);
    this.broadcastOnline();
    this.onChange();
  }
  claim(conn, p, cc, now){
    const s = this.s, list = this.data.byCc.get(cc);
    if (p.cc) return conn.send({t: 'err', msg: 'Страна уже выбрана'});
    if (!list) return conn.send({t: 'err', msg: 'В этой стране нет городов для игры'});
    if (s.taken[cc]) return conn.send({t: 'err', msg: 'Эту страну уже занял другой игрок'});
    // cities of that country already captured by others stay theirs
    s.taken[cc] = p.id; p.cc = cc; p.t = now;
    const cities = {};
    for (const c of list){
      const e = s.cities[c.id];
      if (e && e.o) continue;
      s.cities[c.id] = {o: p.id, a: startArmy(c.pop), e: 1, pf: e ? e.pf : 1, nk: e ? e.nk : 0};
      cities[c.id] = s.cities[c.id];
    }
    this.recalc(p.id, now);
    this.news(now, `${this.data.names[cc] || cc}: новый правитель — ${p.name}`, 'claim', p.id);
    this.broadcast({players: {[p.id]: this.pub(p)}, cities, taken: {[cc]: p.id}});
    this.onChange();
  }
  act(conn, p, a, now){
    if (!p.cc) return conn.send({t: 'err', msg: 'Сначала выберите страну'});
    const s = this.s, D = this.data, err = m => conn.send({t: 'err', msg: m});
    this.settle(p, now);
    const own = id => { const e = s.cities[id]; return e && e.o === p.id; };
    const C = id => D.byId.get(id);
    const touched = new Set([p.id]), cities = {};
    const spend = cost => { if (p.m < cost) { err('Не хватает денег'); return false; } p.m -= cost; return true; };

    if (a.type === 'econ'){
      const c = C(a.city); if (!c || !own(c.id)) return err('Это не ваш город');
      const e = s.cities[c.id];
      if (e.e >= RULES.MAX_ECON) return err('Экономика уже максимальная');
      if (!spend(econCost(c.pop * (e.pf ?? 1), e.e))) return;
      e.e++; cities[c.id] = e;
    }
    else if (a.type === 'recruit'){
      const c = C(a.city); if (!c || !own(c.id)) return err('Это не ваш город');
      const e = s.cities[c.id], cap = armyCap(c.pop * (e.pf ?? 1), e.e);
      let n = Math.max(1, Math.min(10000, Math.floor(+a.n || 0)));
      n = Math.min(n, cap - e.a);
      if (n <= 0) return err('В городе нет места для армии — поднимите экономику');
      const affordable = Math.floor(p.m / RULES.ARMY_COST); n = Math.min(n, affordable);
      if (n <= 0) return err('Не хватает денег');
      p.m -= n * RULES.ARMY_COST; e.a += n; cities[c.id] = e;
    }
    else if (a.type === 'attack' || a.type === 'move'){
      const f = C(a.from), t = C(a.to); if (!f || !t) return err('Нет такого города');
      if (!own(f.id)) return err('Атаковать можно только из своего города');
      const fe = s.cities[f.id];
      const d = distKm(f, t), range = RULES.RANGE_KM * (a.type === 'move' ? 1.5 : 1);
      if (d > range) return err(`Слишком далеко: ${Math.round(d)} км (можно до ${range} км)`);
      let n = Math.floor(+a.n || 0); n = Math.min(n, fe.a - 1);
      if (n <= 0) return err('Мало войск: в городе должен остаться хотя бы 1 солдат');
      if (a.type === 'move'){
        if (!own(t.id)) return err('Перебросить войска можно только в свой город');
        const te = s.cities[t.id], cap = armyCap(t.pop * (te.pf ?? 1), te.e);
        n = Math.min(n, cap - te.a); if (n <= 0) return err('В целевом городе нет места');
        fe.a -= n; te.a += n; cities[f.id] = fe; cities[t.id] = te;
      } else {
        if (own(t.id)) return err('Это ваш город');
        if ((fe.cd || 0) > now) return err('Войска ещё не готовы к новой атаке');
        const tv = cityView(s, D, t.id);
        const prev = tv.o;
        const def = tv.a * (t.cap && prev && D.byCc.get(t.cc) && s.taken[t.cc] === prev ? 1.25 : 1);   // столица защищается сильнее
        fe.a -= n; fe.cd = now + RULES.COOLDOWN_MS; cities[f.id] = fe;
        if (n > def){
          const left = Math.max(1, Math.round(n - def * 0.6));
          s.cities[t.id] = {o: p.id, a: left, e: Math.max(1, tv.e - 1), pf: tv.pf, nk: tv.nk};
          cities[t.id] = s.cities[t.id];
          if (prev){ touched.add(prev); }
          const pn = prev ? s.players[prev].name : 'нейтральный город';
          this.news(now, `⚔ ${t.n} (${D.names[t.cc] || t.cc}) захвачен игроком ${p.name}${prev ? ' у игрока ' + pn : ''}`, 'war', p.id);
        } else {
          const left = Math.max(0, Math.round(tv.a - n * 0.6 / (def / Math.max(1, tv.a))));
          s.cities[t.id] = {o: prev, a: left, e: tv.e, pf: tv.pf, nk: tv.nk};
          cities[t.id] = s.cities[t.id];
          if (prev) this.news(now, `🛡 Атака игрока ${p.name} на ${t.n} отбита — город удержал ${s.players[prev].name}`, 'war', p.id);
          conn.send({t: 'info', msg: `Атака отбита: потеряно ${n} солдат, у врага осталось ${left}`});
        }
      }
    }
    else if (a.type === 'research'){
      const st = nukeStage(p, now);
      if (p.nu && now < p.nu) return err('Исследование уже идёт');
      p.ns = st; p.nu = 0;
      if (st >= RULES.NUKE_STAGES) return err('Ядерная программа завершена');
      if (!spend(nukeStageCost(st + 1))) return;
      p.nt = st + 1; p.nu = now + nukeStageMs(st + 1);
      if (st + 1 === RULES.NUKE_STAGES) this.news(now, `Игрок ${p.name} начинает финальный этап ядерной программы`, 'nuke', p.id);
    }
    else if (a.type === 'warhead'){
      this.normalize(p, now);
      if (p.ns < RULES.NUKE_STAGES) return err('Сначала завершите ядерную программу');
      if (p.wb) return err('Боеголовка уже строится');
      if (!spend(RULES.WARHEAD_COST)) return;
      p.wb = now + RULES.WARHEAD_MS;
    }
    else if (a.type === 'nuke'){
      this.normalize(p, now);
      const t = C(a.to); if (!t) return err('Нет такого города');
      if (own(t.id)) return err('Это ваш город');
      if (p.wh <= 0) return err('Нет готовых боеголовок');
      const tv = cityView(s, D, t.id);
      p.wh--;
      s.cities[t.id] = {o: tv.o, a: 0, e: Math.max(1, tv.e - 3), pf: Math.max(0.1, tv.pf * 0.5), nk: tv.nk + 1};
      cities[t.id] = s.cities[t.id];
      if (tv.o) touched.add(tv.o);
      this.news(now, `☢ Ядерный удар по городу ${t.n} (${D.names[t.cc] || t.cc}) — запустил ${p.name}`, 'nuke', p.id);
    }
    else return err('Неизвестное действие');

    for (const pid of touched) this.recalc(pid, now);
    const players = {}; for (const pid of touched) players[pid] = this.pub(s.players[pid]);
    s.lastActive = now;
    this.broadcast({players, cities});
    this.onChange();
  }

  // ---- economy helpers ----
  settle(p, now){ p.m = moneyAt(p, now); p.t = now; this.normalize(p, now); }
  normalize(p, now){
    if (p.nu && now >= p.nu){ p.ns = p.nt; p.nu = 0; }
    if (p.wb && now >= p.wb){ p.wh++; p.wb = 0; }
  }
  recalc(pid, now){
    const p = this.s.players[pid]; if (!p) return;
    p.m = moneyAt(p, now); p.t = now;
    let rate = 0, nc = 0, army = 0;
    for (const id in this.s.cities){
      const e = this.s.cities[id]; if (e.o !== pid) continue;
      const c = this.data.byId.get(+id); if (!c) continue;
      rate += baseIncome(c.pop * (e.pf ?? 1)) * e.e; nc++; army += e.a;
    }
    p.rate = Math.round(rate * 100) / 100; p.nc = nc; p.army = army;
  }
  pub(p){ const {id, name, color, cc, m, t, rate, ns, nt, nu, wh, wb, on, nc, army} = p; return {id, name, color, cc, m, t, rate, ns, nt, nu, wh, wb, on, nc, army}; }
  snapshot(){
    const players = {}; for (const id in this.s.players) players[id] = this.pub(this.s.players[id]);
    return {players, cities: this.s.cities, taken: this.s.taken, news: this.s.news.slice(-30)};
  }
  news(now, txt, k, pid){ const n = {ts: now, txt, k, pid}; this.s.news.push(n); if (this.s.news.length > RULES.NEWS_KEEP) this.s.news.splice(0, this.s.news.length - RULES.NEWS_KEEP); (this._pendingNews ||= []).push(n); }
  broadcast(patch, except){
    const msg = {t: 'patch', now: this.now(), ...patch};
    if (this._pendingNews){ msg.news = this._pendingNews; this._pendingNews = null; }
    for (const c of this.conns) if (c !== except && c.pid) { try { c.send(msg); } catch {} }
  }
  broadcastOnline(){ const msg = {t: 'online', n: this.online(), cap: RULES.CAP}; for (const c of this.conns) { try { c.send(msg); } catch {} } }
}

function randToken(){
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = '';
  for (let i = 0; i < 24; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ---------- простые боты для офлайн-игры ----------
export function makeBot(room, name, cc){
  const conn = {bot: true, inbox: [], send(m){ if (m.t === 'welcome') this.pid = m.you; }, close(){}};
  room.connect(conn);
  room.message(conn, {t: 'hello', name});
  room.message(conn, {t: 'claim', cc});
  let tick = 0;
  conn.step = () => {
    const s = room.s, p = s.players[conn.pid]; if (!p || !p.cc) return;
    const now = room.now(), D = room.data; tick++;
    const mine = Object.keys(s.cities).filter(id => s.cities[id].o === p.id).map(Number);
    if (!mine.length) return;
    const money = moneyAt(p, now);
    // 1) economy in the richest city we can afford
    const best = mine.map(id => ({id, c: D.byId.get(id), e: s.cities[id]})).sort((a, b) => b.c.pop - a.c.pop);
    const up = best.find(x => x.e.e < 6 && econCost(x.c.pop, x.e.e) < money * 0.6);
    if (up && tick % 3 === 1){ room.message(conn, {t: 'act', a: {type: 'econ', city: up.id}}); return; }
    // 2) army in a border city
    if (money > 600){ const x = best[Math.floor(Math.random() * Math.min(5, best.length))]; room.message(conn, {t: 'act', a: {type: 'recruit', city: x.id, n: Math.floor(money * 0.4 / RULES.ARMY_COST)}}); }
    // 3) attack a weak neighbour now and then
    if (tick % 4 === 0){
      for (const x of best.slice(0, 12)){
        if (x.e.a < 40) continue;
        let target = null, td = Infinity;
        for (const [id, c] of D.byId){
          if (Math.abs(c.la - x.c.la) > 8 || Math.abs(c.lo - x.c.lo) > 10) continue;
          const v = cityView(s, D, id); if (v.o === p.id) continue;
          const d = distKm(x.c, c); if (d > RULES.RANGE_KM || v.a * 1.3 >= x.e.a - 1) continue;
          if (d < td){ td = d; target = id; }
        }
        if (target){ room.message(conn, {t: 'act', a: {type: 'attack', from: x.id, to: target, n: x.e.a - 1}}); break; }
      }
    }
    if (tick % 7 === 0) room.message(conn, {t: 'act', a: {type: 'research'}});
  };
  return conn;
}
