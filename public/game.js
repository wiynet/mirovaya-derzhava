// ============================================================================
//  «Мировая держава» — общая игровая логика (сервер Cloudflare и браузер).
//  Время везде в миллисекундах. Деньги и настроение считаются «вживую» по
//  формулам от времени, а события (армия дошла, война оправдана, восстание)
//  обрабатывает tick(now), который сервер вызывает по будильнику.
// ============================================================================

export const RULES = {
  CAP: 50,                       // максимум игроков на одном сервере
  MAX_ECON: 10,
  ARMY_COST: 5,                  // цена солдата
  UPKEEP: 0.01,                  // содержание солдата в секунду
  SPEED_KMS: 12,                 // скорость армии, км в секунду
  MAX_SEND_KM: 2500,             // по прямой
  MAX_ROUTE_KM: 4000,            // по дороге через города
  ALLY_OFFER_MS: 60000,
  TAX_BASE: 25,                  // обычные налоги, %
  DIPLO_MAX: 5,
  JUSTIFY_MS: 240000,            // оправдание войны при дипломатии 1 (делится на уровень)
  TRUCE_MS: 300000,              // перемирие после мира
  PEACE_OFFER_MS: 60000,
  NUKE_STAGES: 5,
  WARHEAD_COST: 150000,
  WARHEAD_MS: 60000,
  REVOLT_BELOW: 30,              // настроение ниже — возможна гражданская война
  CHECK_MS: 30000,
  NEWS_KEEP: 60,
};
export const nukeStageCost = s => [0, 50000, 100000, 150000, 200000, 300000][s];
export const nukeStageMs = s => 30000 + 30000 * s;
export const diploCost = l => 1500 * l * l;
export const justifyMs = l => Math.round(RULES.JUSTIFY_MS / Math.max(1, l));
const cityScale = pop => 0.5 + Math.sqrt(pop / 1e5) * 0.5;
export const baseIncome = pop => 0.4 + Math.sqrt(pop / 1000) * 0.08;
export const econCost = (pop, e) => Math.round(80 * e * e * cityScale(pop));
export const armyCap = (pop, e) => Math.round(100 + pop / 600 * e);
export const neutralArmy = pop => Math.max(5, Math.round(pop / 8000));
export const startArmy = pop => Math.max(10, Math.round(pop / 15000));
export const startMoney = gdp => Math.max(300, Math.round(300 * Math.sqrt((gdp || 1000) / 1000)));   // богатые страны начинают с бо́льшей казной

export function distKm(a, b){
  const R = 6371, r = Math.PI / 180;
  const dLa = (b.la - a.la) * r, dLo = (b.lo - a.lo) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.la * r) * Math.cos(b.la * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const travelMs = km => Math.max(5000, Math.round(km / RULES.SPEED_KMS * 1000));
const warKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
const PALETTE = Array.from({length: 60}, (_, i) => `hsl(${Math.round((i * 137.508 + 8) % 360)} 68% 50%)`);

export function prepareData(raw){
  const byId = new Map(), byCc = new Map();
  raw.c.forEach(([id, cc, pop, la, lo, cap, n], i) => {
    const c = {id, cc, pop, la, lo, cap, n, nb: raw.nb ? raw.nb[i] : []};
    byId.set(id, c);
    if (!byCc.has(cc)) byCc.set(cc, []);
    byCc.get(cc).push(c);
  });
  return {byId, byCc, names: raw.n || {}, gdp: raw.g || {}};
}

// ---------- roads between cities ----------
// How an army of player `pid` relates to a city on its way:
//  'own' / 'ally' — free passage; 'enemy' — at war: cannot pass, only attack; 'foreign' — neutral or not at war: passes but loses soldiers
export function passKind(s, pid, v){
  if (v.o === pid) return 'own';
  if (v.o && isAlly(s, pid, v.o)) return 'ally';
  if (v.o && atWar(s, pid, v.o)) return 'enemy';
  return 'foreign';
}
export const passLoss = (n, garrison) => Math.min(n, Math.round(3 + garrison * 0.15 + n * 0.04));
// cheapest road from city `from` to city `to` (Dijkstra over neighbouring cities)
export function findRoute(s, data, pid, from, to){
  const D = data, start = D.byId.get(from), goal = D.byId.get(to);
  if (!start || !goal) return {err: 'Нет такого города'};
  const dist = new Map([[from, 0]]), prev = new Map(), km = new Map([[from, 0]]);
  const heap = [[0, from]];
  const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i > 0){ const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length){ heap[0] = last; let i = 0; for (;;){ const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  let blocker = null, found = false;
  while (heap.length){
    const [d, id] = pop();
    if (d > (dist.get(id) ?? Infinity)) continue;
    if (id === to){ found = true; break; }
    const c = D.byId.get(id);
    if (id !== from){
      const k = passKind(s, pid, cityView(s, D, id));
      if (k === 'enemy'){ if (!blocker) blocker = id; continue; }   // can't walk through an enemy city; the first one met is the front line
    }
    for (const nid of c.nb){
      const n = D.byId.get(nid); if (!n) continue;
      const step = distKm(c, n), tot = km.get(id) + step;
      if (tot > RULES.MAX_ROUTE_KM) continue;
      const k = nid === to ? 'own' : passKind(s, pid, cityView(s, D, nid));
      const w = d + step + (k === 'foreign' ? 250 : 0);       // prefer friendly roads
      if (w < (dist.get(nid) ?? Infinity)){ dist.set(nid, w); km.set(nid, tot); prev.set(nid, id); push(w, nid); }
    }
  }
  if (!found){
    if (blocker && distKm(D.byId.get(blocker), goal) < 1500) return {err: `Путь закрыт: сначала захватите ближний вражеский город ${D.byId.get(blocker).n}`, blocker};
    return {err: 'Туда нет дороги: слишком далеко или через океан'};
  }
  const path = [to]; while (path[0] !== from) path.unshift(prev.get(path[0]));
  let t = 0; const legs = [0];
  for (let i = 1; i < path.length; i++){ t += distKm(D.byId.get(path[i - 1]), D.byId.get(path[i])); legs.push(t); }
  const foreign = path.slice(1, -1).filter(id => passKind(s, pid, cityView(s, D, id)) === 'foreign');
  return {path, km: t, legs, foreign};
}

// ---------- функции над состоянием (одинаковые в браузере и на сервере) ----------
export function cityView(s, data, id){
  const base = data.byId.get(id); if (!base) return null;
  const e = s.cities[id];
  if (e) return {id, o: e.o ?? null, a: e.a, e: e.e, pf: e.pf ?? 1, nk: e.nk || 0, reb: e.reb || 0, base};
  return {id, o: null, a: neutralArmy(base.pop), e: 1, pf: 1, nk: 0, reb: 0, base};
}
export function moneyAt(p, now){ return Math.max(0, p.m + p.rate * Math.max(0, now - p.t) / 1000); }
export function moodTarget(p, wars){
  return Math.max(0, Math.min(100, 72 - (p.tax - RULES.TAX_BASE) * 1.7 + (p.spend - 10) * 1.3 - Math.min(3, wars) * 7));
}
export function moodAt(p, now){ return p.ht0 + (p.htg - p.ht0) * (1 - Math.exp(-Math.max(0, now - p.ht) / 120000)); }
export function nukeStage(p, now){ return (p.nu && now >= p.nu) ? p.nt : p.ns; }
export function warheads(p, now){ return p.wh + ((p.wb && now >= p.wb) ? 1 : 0); }
export function atWar(s, a, b){ return !!(a && b && s.wars[warKey(a, b)]); }
export function isAlly(s, a, b){ return !!(a && b && s.allies && s.allies[warKey(a, b)]); }
export function warsOf(s, pid){ return Object.values(s.wars).filter(w => w.a === pid || w.b === pid).map(w => w.a === pid ? w.b : w.a); }
export function armyPos(army, data, now){
  const P = army.path, ts = army.ts;
  let i = 1; while (i < ts.length - 1 && ts[i] <= now) i++;
  const a = data.byId.get(P[i - 1]), b = data.byId.get(P[i]);
  const k = Math.max(0, Math.min(1, (now - ts[i - 1]) / Math.max(1, ts[i] - ts[i - 1])));
  return {la: a.la + (b.la - a.la) * k, lo: a.lo + (b.lo - a.lo) * k, seg: i};
}

export class RoomCore {
  constructor(data, saved, opts = {}){
    this.data = data;
    this.s = saved && saved.v === 3 ? saved : RoomCore.fresh();
    this.conns = new Set();
    this.name = opts.name || 'room';
    this.onChange = opts.onChange || (() => {});
    this.now = opts.now || (() => Date.now());
  }
  static fresh(){ return {v: 3, created: Date.now(), players: {}, tokens: {}, cities: {}, taken: {}, news: [], seq: 0, aseq: 0,
    armies: {}, wars: {}, just: {}, offers: {}, truce: {}, allies: {}, aoffers: {}, nextCheck: 0, lastActive: Date.now()}; }

  online(){ let n = 0; for (const c of this.conns) if (!c.bot) n++; return n; }
  isFull(){ return this.online() >= RULES.CAP; }

  connect(conn){
    if (!conn.bot && this.isFull()){ conn.send({t: 'full'}); conn.close && conn.close(); return false; }
    if (this.online() === 0 && this.now() - (this.s.lastActive || 0) > 12 * 3600e3 && Object.keys(this.s.players).length) this.s = RoomCore.fresh();
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

  message(conn, msg){
    const now = this.now();
    try {
      this.tick(now);
      if (msg.t === 'hello') return this.hello(conn, msg, now);
      if (!conn.pid) return conn.send({t: 'err', msg: 'Сначала войдите'});
      const p = this.s.players[conn.pid];
      if (msg.t === 'claim') return this.claim(conn, p, msg.cc, now);
      if (msg.t === 'act') return this.act(conn, p, msg.a || {}, now);
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
      p = s.players[pid] = {id: pid, name, color: PALETTE[(s.seq - 1) % PALETTE.length], cc: null, m: 0, t: now, rate: 0,
        tax: RULES.TAX_BASE, spend: 10, ht0: 70, htg: 70, ht: now, dip: 1,
        ns: 0, nt: 0, nu: 0, wh: 0, wb: 0, on: 1, seen: now, nc: 0, army: 0, gross: 0, upkeep: 0};
      conn.token = token;
    } else p.name = name || p.name;
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
    s.taken[cc] = p.id; p.cc = cc; p.m = startMoney(this.data.gdp[cc]); p.t = now;
    const cities = {};
    for (const c of list){
      const e = s.cities[c.id];
      if (e && e.o) continue;
      s.cities[c.id] = {o: p.id, a: startArmy(c.pop), e: 1, pf: e ? e.pf : 1, nk: e ? e.nk : 0};
      cities[c.id] = s.cities[c.id];
    }
    this.recalc(p.id, now); this.mood(p, now);
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
    const out = {players: new Set([p.id]), cities: {}, armies: {}, wars: false};
    const spend = cost => { if (p.m < cost){ err(`Не хватает денег: нужно ${Math.round(cost).toLocaleString('ru-RU')}`); return false; } p.m -= cost; return true; };

    switch (a.type){
      case 'econ': {
        const c = C(a.city); if (!c || !own(c.id)) return err('Это не ваш город');
        const e = s.cities[c.id];
        if (e.e >= RULES.MAX_ECON) return err('Экономика уже максимальная');
        if (!spend(econCost(c.pop * (e.pf ?? 1), e.e))) return;
        e.e++; out.cities[c.id] = e; break;
      }
      case 'recruit': {
        const c = C(a.city); if (!c || !own(c.id)) return err('Это не ваш город');
        const e = s.cities[c.id], cap = armyCap(c.pop * (e.pf ?? 1), e.e);
        let n = Math.min(Math.max(1, Math.floor(+a.n || 0)), cap - e.a, Math.floor(p.m / RULES.ARMY_COST));
        if (cap - e.a <= 0) return err('В городе нет места — поднимите экономику');
        if (n <= 0) return err('Не хватает денег');
        p.m -= n * RULES.ARMY_COST; e.a += n; out.cities[c.id] = e; break;
      }
      case 'send': {
        const f = C(a.from), t = C(a.to); if (!f || !t || f === t) return err('Нет такого города');
        if (!own(f.id)) return err('Отправлять можно только из своего города');
        const fe = s.cities[f.id], tv = cityView(s, D, t.id);
        if (tv.o && tv.o !== p.id && !atWar(s, p.id, tv.o)) return err(isAlly(s, p.id, tv.o) ? 'Это город союзника' : `Вы не воюете с игроком ${s.players[tv.o].name}. Сначала объявите войну.`);
        const d = distKm(f, t); if (d > RULES.MAX_SEND_KM) return err(`Слишком далеко: ${Math.round(d)} км (можно до ${RULES.MAX_SEND_KM})`);
        const n = Math.min(Math.floor(+a.n || 0), fe.a - 1);
        if (n <= 0) return err('В городе должен остаться хотя бы 1 солдат');
        const r = findRoute(s, D, p.id, f.id, t.id); if (r.err) return err(r.err);
        fe.a -= n; out.cities[f.id] = fe;
        const id = 'a' + (++s.aseq).toString(36);
        s.armies[id] = out.armies[id] = this.makeArmy(id, p.id, n, r, now);
        break;
      }
      case 'ally': {
        const q = s.players[a.target]; if (!q || q === p || !q.cc) return err('Нет такого игрока');
        if (isAlly(s, p.id, q.id)) return err('Вы уже союзники');
        if (atWar(s, p.id, q.id)) return err('Сначала заключите мир');
        s.aoffers[p.id + '>' + q.id] = {from: p.id, to: q.id, until: now + RULES.ALLY_OFFER_MS};
        out.wars = true;
        this.sendTo(q.id, {t: 'allyOffer', from: p.id, until: now + RULES.ALLY_OFFER_MS});
        conn.send({t: 'info', msg: `Запрос на союз отправлен игроку ${q.name}`});
        break;
      }
      case 'allyAnswer': {
        const key = a.from + '>' + p.id, off = s.aoffers[key];
        if (!off || off.until < now) return err('Запрос уже не действует');
        delete s.aoffers[key]; out.wars = true;
        const q = s.players[a.from];
        if (a.accept){ s.allies[warKey(p.id, q.id)] = {a: q.id, b: p.id, since: now}; this.news(now, `🤝 ${q.name} и ${p.name} заключили союз`, 'diplo', p.id); }
        else this.sendTo(q.id, {t: 'info', msg: `${p.name} отказался от союза`});
        break;
      }
      case 'unally': {
        const q = s.players[a.target]; if (!q || !isAlly(s, p.id, q.id)) return err('Вы не союзники');
        delete s.allies[warKey(p.id, q.id)]; out.wars = true;
        this.news(now, `💔 ${p.name} разорвал союз с игроком ${q.name}`, 'diplo', p.id);
        break;
      }
      case 'budget': {
        p.tax = Math.max(0, Math.min(60, Math.round(+a.tax)));
        p.spend = Math.max(0, Math.min(40, Math.round(+a.spend)));
        this.mood(p, now); break;
      }
      case 'diplo': {
        if (p.dip >= RULES.DIPLO_MAX) return err('Дипломатия уже максимальная');
        if (!spend(diploCost(p.dip))) return;
        p.dip++; break;
      }
      case 'war': {
        const q = s.players[a.target]; if (!q || q === p || !q.cc) return err('Нет такого игрока');
        if (atWar(s, p.id, q.id)) return err('Вы уже воюете');
        if (isAlly(s, p.id, q.id)) return err('Это ваш союзник — сначала разорвите союз');
        if (s.just[p.id + '>' + q.id]) return err('Повод для войны уже готовится');
        const tr = s.truce[warKey(p.id, q.id)]; if (tr && tr > now) return err(`Перемирие ещё ${Math.ceil((tr - now) / 1000)} с`);
        s.just[p.id + '>' + q.id] = {a: p.id, b: q.id, until: now + justifyMs(p.dip)};
        out.wars = true;
        this.news(now, `${p.name} ищет повод для войны с игроком ${q.name}`, 'diplo', p.id);
        break;
      }
      case 'peace': {
        const q = s.players[a.target]; if (!q || !atWar(s, p.id, q.id)) return err('Вы не воюете с этим игроком');
        const key = p.id + '>' + q.id;
        s.offers[key] = {from: p.id, to: q.id, until: now + RULES.PEACE_OFFER_MS};
        out.wars = true;
        this.sendTo(q.id, {t: 'peaceOffer', from: p.id, until: now + RULES.PEACE_OFFER_MS});
        conn.send({t: 'info', msg: `Предложение мира отправлено игроку ${q.name}`});
        break;
      }
      case 'peaceAnswer': {
        const key = a.from + '>' + p.id, off = s.offers[key];
        if (!off || off.until < now) return err('Предложение уже не действует');
        delete s.offers[key]; out.wars = true;
        const q = s.players[a.from];
        if (a.accept){ this.makePeace(p.id, q.id, now, out); this.news(now, `🕊 ${p.name} и ${q.name} заключили мир`, 'diplo', p.id); }
        else this.sendTo(q.id, {t: 'info', msg: `${p.name} отказался от мира`});
        break;
      }
      case 'research': {
        const st = nukeStage(p, now);
        if (p.nu && now < p.nu) return err('Исследование уже идёт');
        p.ns = st; p.nu = 0;
        if (st >= RULES.NUKE_STAGES) return err('Ядерная программа завершена');
        if (!spend(nukeStageCost(st + 1))) return;
        p.nt = st + 1; p.nu = now + nukeStageMs(st + 1);
        if (st + 1 === RULES.NUKE_STAGES) this.news(now, `☢ ${p.name} начинает финальный этап ядерной программы`, 'nuke', p.id);
        break;
      }
      case 'warhead': {
        this.normalize(p, now);
        if (p.ns < RULES.NUKE_STAGES) return err('Сначала завершите ядерную программу');
        if (p.wb) return err('Бомба уже собирается');
        if (!spend(RULES.WARHEAD_COST)) return;
        p.wb = now + RULES.WARHEAD_MS; break;
      }
      case 'nuke': {
        this.normalize(p, now);
        const t = C(a.to); if (!t) return err('Нет такого города');
        if (own(t.id)) return err('Это ваш город');
        const tv = cityView(s, D, t.id);
        if (tv.o && !atWar(s, p.id, tv.o)) return err('Ядерный удар возможен только по врагу, с которым идёт война');
        if (p.wh <= 0) return err('Нет готовых бомб');
        p.wh--;
        s.cities[t.id] = {o: tv.o, a: 0, e: Math.max(1, tv.e - 3), pf: Math.max(0.1, tv.pf * 0.5), nk: tv.nk + 1, reb: tv.reb};
        out.cities[t.id] = s.cities[t.id];
        if (tv.o) out.players.add(tv.o);
        this.news(now, `☢ Ядерный удар по городу ${t.n} (${D.names[t.cc] || t.cc}) — запустил ${p.name}`, 'nuke', p.id);
        break;
      }
      default: return err('Неизвестное действие');
    }
    this.finish(out, now);
  }

  // ---- time-driven events: armies arrive, wars get justified, revolts ----
  tick(now){
    const s = this.s;
    for (let guard = 0; guard < 500; guard++){
      const ev = this.nextEvent(now); if (!ev) break;
      const out = {players: new Set(), cities: {}, armies: {}, wars: false};
      if (ev.k === 'army') this.waypoint(ev.v, ev.t, out);
      else if (ev.k === 'just'){
        delete s.just[ev.id];
        const p = s.players[ev.v.a], q = s.players[ev.v.b];
        if (p && q && !atWar(s, p.id, q.id)){
          s.wars[warKey(p.id, q.id)] = {a: p.id, b: q.id, since: ev.t};
          this.mood(p, ev.t); this.mood(q, ev.t);
          out.players.add(p.id); out.players.add(q.id);
          this.news(ev.t, `⚔ ${p.name} объявил войну игроку ${q.name}`, 'war', p.id);
        }
        out.wars = true;
      } else if (ev.k === 'offer'){ delete s.offers[ev.id]; out.wars = true; }
      else if (ev.k === 'aoffer'){ delete s.aoffers[ev.id]; out.wars = true; }
      else if (ev.k === 'check'){ s.nextCheck = now + RULES.CHECK_MS; this.check(now, out); }
      this.finish(out, ev.t);
    }
  }
  nextEvent(now){
    const s = this.s; let best = null;
    const consider = (t, k, id, v) => { if (t <= now && (!best || t < best.t)) best = {t, k, id, v}; };
    for (const id in s.armies) consider(s.armies[id].ts[s.armies[id].i], 'army', id, s.armies[id]);
    for (const id in s.just) consider(s.just[id].until, 'just', id, s.just[id]);
    for (const id in s.offers) consider(s.offers[id].until, 'offer', id, s.offers[id]);
    for (const id in s.aoffers) consider(s.aoffers[id].until, 'aoffer', id, s.aoffers[id]);
    if (Object.keys(s.players).length) consider(Math.max(s.nextCheck || 0, 1), 'check');
    return best;
  }
  // when the server should wake up next
  nextDue(){
    const s = this.s; let t = Infinity;
    for (const id in s.armies) t = Math.min(t, s.armies[id].ts[s.armies[id].i]);
    for (const id in s.just) t = Math.min(t, s.just[id].until);
    for (const id in s.offers) t = Math.min(t, s.offers[id].until);
    for (const id in s.aoffers) t = Math.min(t, s.aoffers[id].until);
    if (this.online() > 0) t = Math.min(t, s.nextCheck || this.now());
    return t;
  }
  makeArmy(id, o, n, r, now){
    const ts = r.legs.map(km => now + Math.round(km / RULES.SPEED_KMS * 1000));
    ts[ts.length - 1] = Math.max(ts[ts.length - 1], now + 5000);
    return {id, o, n, path: r.path, ts, i: 1, from: r.path[0], to: r.path[r.path.length - 1], start: now, arrive: ts[ts.length - 1], lost: 0};
  }
  // the army reaches the next city on its road
  waypoint(army, now, out){
    const s = this.s, D = this.data, p = s.players[army.o];
    if (!p){ delete s.armies[army.id]; out.armies[army.id] = null; return; }
    out.players.add(p.id);
    const id = army.path[army.i], c = D.byId.get(id), v = cityView(s, D, id);
    if (army.i === army.path.length - 1) return this.arrive(army, now, out);
    const k = passKind(s, p.id, v);
    if (k === 'enemy'){ army.to = id; return this.arrive(army, now, out); }      // the road was cut by a war — fight here
    if (k === 'foreign'){
      const loss = passLoss(army.n, v.a);
      army.n -= loss; army.lost += loss;
      if (army.n <= 0){
        delete s.armies[army.id]; out.armies[army.id] = null;
        this.sendTo(p.id, {t: 'info', msg: `Армия погибла по дороге у города ${c.n}`});
        return;
      }
    }
    army.i++; out.armies[army.id] = army;
  }
  arrive(army, now, out){
    const s = this.s, D = this.data;
    delete s.armies[army.id]; out.armies[army.id] = null;
    const p = s.players[army.o]; if (!p) return;
    const t = D.byId.get(army.to), tv = cityView(s, D, army.to);
    out.players.add(p.id);
    if (army.lost) this.sendTo(p.id, {t: 'info', msg: `По дороге через чужие города армия потеряла ${army.lost} солдат`});
    if (tv.o === p.id){ s.cities[t.id].a += army.n; out.cities[t.id] = s.cities[t.id]; return; }
    if (tv.o && !atWar(s, p.id, tv.o)){
      // peace was made while marching: the army walks back home
      const back = s.cities[army.from] && s.cities[army.from].o === p.id ? army.from : null;
      const r = back && findRoute(s, D, p.id, t.id, back);
      if (r && !r.err){ const id = 'a' + (++s.aseq).toString(36); s.armies[id] = out.armies[id] = this.makeArmy(id, p.id, army.n, r, now); }
      return;
    }
    const prev = tv.o;
    const def = tv.a * (t.cap && prev && s.taken[t.cc] === prev ? 1.25 : 1);
    if (army.n > def){
      const left = Math.max(1, Math.round(army.n - def * 0.6));
      s.cities[t.id] = {o: p.id, a: left, e: Math.max(1, tv.e - 1), pf: tv.pf, nk: tv.nk};
      out.cities[t.id] = s.cities[t.id];
      if (prev) out.players.add(prev);
      this.news(now, `⚔ ${t.n} (${D.names[t.cc] || t.cc}) захвачен игроком ${p.name}${prev ? ' у игрока ' + s.players[prev].name : tv.reb ? ' у повстанцев' : ''}`, 'war', p.id);
    } else {
      const left = Math.max(0, Math.round(tv.a - army.n * 0.6 * tv.a / Math.max(1, def)));
      s.cities[t.id] = {o: prev, a: left, e: tv.e, pf: tv.pf, nk: tv.nk, reb: tv.reb};
      out.cities[t.id] = s.cities[t.id];
      if (prev){ out.players.add(prev); this.news(now, `🛡 ${t.n}: атака игрока ${p.name} отбита`, 'war', p.id); }
      this.sendTo(p.id, {t: 'info', msg: `Атака на ${t.n} отбита: потеряно ${army.n} солдат`});
    }
  }
  check(now, out){
    const s = this.s, D = this.data;
    for (const p of Object.values(s.players)){
      if (!p.cc) continue;
      const h = moodAt(p, now);
      // no money and spending more than earning: soldiers desert
      if (moneyAt(p, now) <= 0 && p.rate < 0){
        for (const id in s.cities){ const e = s.cities[id]; if (e.o === p.id && e.a > 1){ e.a = Math.max(1, Math.floor(e.a * 0.92)); out.cities[id] = e; } }
        out.players.add(p.id);
        this.sendTo(p.id, {t: 'info', msg: 'Казна пуста — солдаты дезертируют. Снизьте расходы или поднимите налоги.'});
      }
      if (h >= RULES.REVOLT_BELOW || p.nc <= 1) continue;
      if (Math.random() > (RULES.REVOLT_BELOW - h) / RULES.REVOLT_BELOW * 0.8) continue;
      // civil war: a city (not the capital, if possible) goes to the rebels
      const mine = Object.keys(s.cities).filter(id => s.cities[id].o === p.id).map(Number);
      const pick = mine.filter(id => !D.byId.get(id).cap).sort(() => Math.random() - 0.5)[0] || mine[0];
      const e = s.cities[pick], c = D.byId.get(pick);
      s.cities[pick] = {o: null, a: Math.max(neutralArmy(c.pop), Math.round(e.a * 0.8)), e: e.e, pf: e.pf, nk: e.nk, reb: 1};
      out.cities[pick] = s.cities[pick]; out.players.add(p.id);
      this.news(now, `🔥 Гражданская война: жители города ${c.n} (${D.names[c.cc] || c.cc}) восстали против игрока ${p.name}`, 'revolt', p.id);
    }
  }
  makePeace(a, b, now, out){
    const s = this.s;
    delete s.wars[warKey(a, b)];
    s.truce[warKey(a, b)] = now + RULES.TRUCE_MS;
    delete s.just[a + '>' + b]; delete s.just[b + '>' + a];
    this.mood(s.players[a], now); this.mood(s.players[b], now);
    out.players.add(a); out.players.add(b); out.wars = true;
  }
  finish(out, now){
    const s = this.s;
    for (const pid of out.players) this.recalc(pid, now);
    const players = {}; for (const pid of out.players) if (s.players[pid]) players[pid] = this.pub(s.players[pid]);
    const patch = {players, cities: out.cities, armies: out.armies};
    if (out.wars) Object.assign(patch, this.diploState());
    s.lastActive = now;
    this.broadcast(patch);
    this.onChange();
  }

  // ---- economy ----
  settle(p, now){ p.m = moneyAt(p, now); p.t = now; this.normalize(p, now); }
  normalize(p, now){
    if (p.nu && now >= p.nu){ p.ns = p.nt; p.nu = 0; }
    if (p.wb && now >= p.wb){ p.wh++; p.wb = 0; }
  }
  mood(p, now){ if (!p) return; p.ht0 = moodAt(p, now); p.ht = now; p.htg = moodTarget(p, warsOf(this.s, p.id).length); }
  recalc(pid, now){
    const p = this.s.players[pid]; if (!p) return;
    p.m = moneyAt(p, now); p.t = now;
    let gross = 0, nc = 0, army = 0;
    for (const id in this.s.cities){
      const e = this.s.cities[id]; if (e.o !== pid) continue;
      const c = this.data.byId.get(+id); if (!c) continue;
      gross += baseIncome(c.pop * (e.pf ?? 1)) * e.e; nc++; army += e.a;
    }
    for (const id in this.s.armies) if (this.s.armies[id].o === pid) army += this.s.armies[id].n;
    gross *= p.tax / RULES.TAX_BASE;
    const upkeep = army * RULES.UPKEEP, social = gross * p.spend / 100;
    p.gross = Math.round(gross * 100) / 100; p.upkeep = Math.round(upkeep * 100) / 100;
    p.rate = Math.round((gross - upkeep - social) * 100) / 100; p.nc = nc; p.army = army;
  }
  pub(p){ const {id, name, color, cc, m, t, rate, gross, upkeep, tax, spend, ht0, htg, ht, dip, ns, nt, nu, wh, wb, on, nc, army} = p;
    return {id, name, color, cc, m, t, rate, gross, upkeep, tax, spend, ht0, htg, ht, dip, ns, nt, nu, wh, wb, on, nc, army}; }
  diploState(){ return {wars: this.s.wars, just: this.s.just, offers: this.s.offers, truce: this.s.truce, allies: this.s.allies, aoffers: this.s.aoffers}; }
  snapshot(){
    const players = {}; for (const id in this.s.players) players[id] = this.pub(this.s.players[id]);
    return {players, cities: this.s.cities, taken: this.s.taken, news: this.s.news.slice(-30), armies: this.s.armies, ...this.diploState()};
  }
  news(now, txt, k, pid){ const n = {ts: now, txt, k, pid}; this.s.news.push(n); if (this.s.news.length > RULES.NEWS_KEEP) this.s.news.splice(0, this.s.news.length - RULES.NEWS_KEEP); (this._pendingNews ||= []).push(n); }
  sendTo(pid, msg){ for (const c of this.conns) if (c.pid === pid){ try { c.send(msg); } catch {} } }
  broadcast(patch, except){
    const msg = {t: 'patch', now: this.now(), ...patch};
    if (this._pendingNews){ msg.news = this._pendingNews; this._pendingNews = null; }
    for (const c of this.conns) if (c !== except && c.pid){ try { c.send(msg); } catch {} }
  }
  broadcastOnline(){ const msg = {t: 'online', n: this.online(), cap: RULES.CAP}; for (const c of this.conns){ try { c.send(msg); } catch {} } }
}

function randToken(){
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = '';
  for (let i = 0; i < 24; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ---------- простые боты для офлайн-игры ----------
export function makeBot(room, name, cc){
  const conn = {bot: true, send(m){
    if (m.t === 'welcome') this.pid = m.you;
    if (m.t === 'allyOffer') setTimeout(() => room.message(conn, {t: 'act', a: {type: 'allyAnswer', from: m.from, accept: Math.random() < 0.4}}), 5000);
    if (m.t === 'peaceOffer') setTimeout(() => room.message(conn, {t: 'act', a: {type: 'peaceAnswer', from: m.from, accept: Math.random() < 0.6}}), 4000);
  }, close(){}};
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
    if (tick === 1) room.message(conn, {t: 'act', a: {type: 'budget', tax: 30, spend: 12}});
    const best = mine.map(id => ({id, c: D.byId.get(id), e: s.cities[id]})).sort((a, b) => b.c.pop - a.c.pop);
    const up = best.find(x => x.e.e < 6 && econCost(x.c.pop, x.e.e) < money * 0.6);
    if (up && tick % 3 === 1){ room.message(conn, {t: 'act', a: {type: 'econ', city: up.id}}); return; }
    if (money > 800 && p.rate > p.army * RULES.UPKEEP){ const x = best[Math.floor(Math.random() * Math.min(5, best.length))]; room.message(conn, {t: 'act', a: {type: 'recruit', city: x.id, n: Math.floor(money * 0.3 / RULES.ARMY_COST)}}); }
    // now and then pick a fight with a weaker neighbouring player
    if (tick % 25 === 0 && Math.random() < 0.5){
      const near = new Set();
      for (const x of best.slice(0, 15)) for (const [id, c] of D.byId){
        const e = s.cities[id]; if (!e || !e.o || e.o === p.id) continue;
        if (Math.abs(c.la - x.c.la) < 6 && Math.abs(c.lo - x.c.lo) < 8 && distKm(x.c, c) < 700) near.add(e.o);
      }
      for (const q of near){ const qp = s.players[q]; if (qp && qp.army < p.army * 0.8 && !atWar(s, p.id, q) && !isAlly(s, p.id, q)){ room.message(conn, {t: 'act', a: {type: 'war', target: q}}); break; } }
    }
    if (tick % 5 === 0){
      for (const x of best.slice(0, 10)){
        if (x.e.a < 60) continue;
        let target = null, td = Infinity;
        for (const [id, c] of D.byId){
          if (Math.abs(c.la - x.c.la) > 8 || Math.abs(c.lo - x.c.lo) > 10) continue;
          const v = cityView(s, D, id); if (v.o === p.id || (v.o && !atWar(s, p.id, v.o))) continue;
          if (!x.c.nb.includes(id)) continue;                      // bots only hit neighbouring cities
          const d = distKm(x.c, c); if (d > 900 || v.a * 1.4 >= x.e.a - 1) continue;
          if (d < td){ td = d; target = id; }
        }
        if (target){ room.message(conn, {t: 'act', a: {type: 'send', from: x.id, to: target, n: x.e.a - 1}}); break; }
      }
    }
  };
  return conn;
}
