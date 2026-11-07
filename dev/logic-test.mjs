import fs from 'node:fs';
import {RoomCore, prepareData, moneyAt, findRoute, RULES, atWar, isAlly, makeBot} from '../public/game.js';
const data = prepareData(JSON.parse(fs.readFileSync(new URL('../public/data/game.json', import.meta.url))));
let T = 1_000_000; const room = new RoomCore(data, null, {now: () => T});
const mk = n => ({n, inbox: [], send(m){ this.inbox.push(m); }, close(){}}), last = c => c.inbox.at(-1);
const a = mk('a'), b = mk('b'), c = mk('c');
for (const x of [a, b, c]) room.connect(x);
room.message(a, {t: 'hello', name: 'Алиса'}); room.message(b, {t: 'hello', name: 'Боб'}); room.message(c, {t: 'hello', name: 'Вика'});
room.message(a, {t: 'claim', cc: 'AZ'}); room.message(b, {t: 'claim', cc: 'AM'}); room.message(c, {t: 'claim', cc: 'GE'});
const city = n => [...data.byId.values()].find(x => x.n === n).id;
const baku = city('Баку'), yerevan = city('Ереван'), gyumri = city('Гюмри'), tbilisi = city('Тбилиси');
T += 120000; room.message(a, {t: 'act', a: {type: 'recruit', city: baku, n: 400}});
// to Tbilisi (Georgia, no war): not allowed as target
room.message(a, {t: 'act', a: {type: 'send', from: baku, to: tbilisi, n: 300}}); console.log('send to non-war player ->', last(a).msg);
// war with Armenia
room.message(a, {t: 'act', a: {type: 'war', target: b.pid}}); T += 241000; room.tick(T);
console.log('war', atWar(room.s, a.pid, b.pid));
const r1 = findRoute(room.s, data, a.pid, baku, gyumri); console.log('route Baku->Gyumri:', r1.err || r1.path.map(id => data.byId.get(id).n).join(' → '));
const r2 = findRoute(room.s, data, a.pid, baku, yerevan); console.log('route Baku->Yerevan:', r2.err || r2.path.map(id => data.byId.get(id).n).join(' → '), r2.foreign && r2.foreign.length, 'foreign');
room.message(a, {t: 'act', a: {type: 'send', from: baku, to: yerevan, n: 300}}); console.log('send ->', last(a).t, last(a).msg || '');
const army = Object.values(room.s.armies)[0];
if (army){ console.log('legs', army.path.length, 'eta s', (army.arrive - T) / 1000);
  T = army.arrive + 10; room.tick(T); console.log('Yerevan owner', room.s.cities[yerevan].o === a.pid ? 'Алиса' : 'Боб', room.s.cities[yerevan].a, last(a).msg || ''); }
// alliance with Georgia
room.message(a, {t: 'act', a: {type: 'ally', target: c.pid}}); console.log('C got', c.inbox.find(m => m.t === 'allyOffer') ? 'allyOffer' : 'nothing');
room.message(c, {t: 'act', a: {type: 'allyAnswer', from: a.pid, accept: true}}); console.log('allies', isAlly(room.s, a.pid, c.pid));
room.message(a, {t: 'act', a: {type: 'war', target: c.pid}}); console.log('war on ally ->', last(a).msg);
const r3 = findRoute(room.s, data, a.pid, baku, city('Батуми')); console.log('route via ally:', r3.err || r3.path.map(id => data.byId.get(id).n).join(' → '));
const r4 = findRoute(room.s, data, a.pid, baku, city('Москва')); console.log('route to Moscow (neutral):', r4.err || `${r4.path.length} cities, ${Math.round(r4.km)} km, foreign ${r4.foreign.length}`);
const r5 = findRoute(room.s, data, a.pid, baku, city('Нью-Йорк')); console.log('route to NY:', r5.err);
// bots
const r6 = new RoomCore(data, null, {now: () => T});
const bots = ['RU','UA','KZ','CN','MN'].map((cc, i) => makeBot(r6, 'Бот ' + i, cc));
let t0 = Date.now();
for (let i = 0; i < 400; i++){ T += 3000; r6.tick(T); bots.forEach(b => b.step()); }
console.log('bots ok in', Date.now() - t0, 'ms:', Object.values(r6.s.players).map(p => `${p.cc} c=${p.nc}`).join(' '), '| armies', Object.keys(r6.s.armies).length, '| wars', Object.keys(r6.s.wars).length);
