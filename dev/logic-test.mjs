import fs from 'node:fs';
import {RoomCore, prepareData, moneyAt, makeBot, RULES} from '../public/game.js';
const data = prepareData(JSON.parse(fs.readFileSync(new URL('../public/data/game.json', import.meta.url))));
let T = 1_000_000; const room = new RoomCore(data, null, {now: () => T});
const log = []; const mk = n => ({n, inbox: [], send(m){ this.inbox.push(m); }, close(){}});
const a = mk('a'), b = mk('b');
room.connect(a); room.connect(b);
room.message(a, {t: 'hello', name: 'Алиса'}); room.message(b, {t: 'hello', name: 'Боб'});
room.message(a, {t: 'claim', cc: 'AZ'}); room.message(b, {t: 'claim', cc: 'AZ'});
console.log('b claim AZ ->', b.inbox.at(-1));
room.message(b, {t: 'claim', cc: 'AM'});
const pa = room.s.players[a.pid], pb = room.s.players[b.pid];
console.log('A rate', pa.rate, 'cities', pa.nc, 'army', pa.army, '| B rate', pb.rate, pb.nc);
T += 60000; console.log('A money after 60s', Math.round(moneyAt(pa, T)));
const baku = data.byCc.get('AZ')[0].id, ganja = data.byCc.get('AZ')[1].id;
room.message(a, {t: 'act', a: {type: 'econ', city: baku}}); console.log('econ ->', room.s.cities[baku].e, Math.round(pa.m), pa.rate);
room.message(a, {t: 'act', a: {type: 'recruit', city: ganja, n: 1000}}); console.log('recruit ganja army', room.s.cities[ganja].a);
const yerevan = data.byCc.get('AM')[0].id;
const gyumri = data.byCc.get('AM').find(c => c.n.includes('Гюмри'))?.id || data.byCc.get('AM')[1].id;
room.message(a, {t: 'act', a: {type: 'attack', from: ganja, to: yerevan, n: 2000}});
console.log('attack result', room.s.cities[yerevan], a.inbox.at(-1).t, a.inbox.at(-1).msg || '');
for (let i = 0; i < 5; i++){ T += 200000; room.message(a, {t: 'act', a: {type: 'research'}}); }
T += 200000; room.message(a, {t: 'act', a: {type: 'warhead'}}); T += 31000;
room.message(a, {t: 'act', a: {type: 'nuke', to: gyumri}}); console.log('nuke', room.s.cities[gyumri], room.s.news.at(-1).txt);
// cap test
const conns = []; for (let i = 0; i < 52; i++){ const c = mk('x'+i); const ok = room.connect(c); conns.push(ok); }
console.log('online', room.online(), 'accepted', conns.filter(Boolean).length, 'of 52 (2 already in)');
// bots
const r2 = new RoomCore(data, null, {now: () => T});
const bots = ['RU','CN','US','DE','IN'].map((cc, i) => makeBot(r2, 'Бот ' + i, cc));
for (let i = 0; i < 300; i++){ T += 3000; bots.forEach(b => b.step()); }
console.log('bots after 15 min:', Object.values(r2.s.players).map(p => `${p.name} ${p.cc} cities=${p.nc} army=${p.army} rate=${p.rate} ns=${p.ns}`).join(' | '));
console.log('news sample:', r2.s.news.slice(-4).map(n => n.txt));
console.log('state size KB', Math.round(JSON.stringify(r2.s).length / 1024));
