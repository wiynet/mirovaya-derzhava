import fs from 'node:fs';
import {RoomCore, prepareData, moneyAt, moodAt, makeBot, RULES, atWar} from '../public/game.js';
const data = prepareData(JSON.parse(fs.readFileSync(new URL('../public/data/game.json', import.meta.url))));
let T = 1_000_000; const room = new RoomCore(data, null, {now: () => T});
const mk = n => ({n, inbox: [], send(m){ this.inbox.push(m); }, close(){}}), last = c => c.inbox.at(-1);
const a = mk('a'), b = mk('b');
room.connect(a); room.connect(b);
room.message(a, {t: 'hello', name: 'Алиса'}); room.message(b, {t: 'hello', name: 'Боб'});
room.message(a, {t: 'claim', cc: 'AZ'}); room.message(b, {t: 'claim', cc: 'AM'});
const pa = room.s.players[a.pid], pb = room.s.players[b.pid];
console.log('start money AZ', Math.round(pa.m), 'AM', Math.round(pb.m), '| rate', pa.rate, pb.rate, '| mood', Math.round(moodAt(pa, T)));
const ganja = data.byCc.get('AZ')[1].id, yerevan = data.byCc.get('AM')[0].id;
T += 60000; room.message(a, {t: 'act', a: {type: 'recruit', city: ganja, n: 400}});
room.message(a, {t: 'act', a: {type: 'send', from: ganja, to: yerevan, n: 300}});
console.log('send without war ->', last(a).msg);
room.message(a, {t: 'act', a: {type: 'war', target: b.pid}});
console.log('justify until +', (room.s.just[a.pid + '>' + b.pid].until - T) / 1000, 's');
T += 241000; room.tick(T); console.log('at war:', atWar(room.s, a.pid, b.pid), 'mood A target', Math.round(pa.htg));
room.message(a, {t: 'act', a: {type: 'send', from: ganja, to: yerevan, n: 300}});
const army = Object.values(room.s.armies)[0]; console.log('army travel s', (army.arrive - army.start) / 1000);
T += 20000; room.tick(T); console.log('arrived? yerevan owner', room.s.cities[yerevan].o === a.pid ? 'Алиса' : 'Боб', 'army', room.s.cities[yerevan].a);
room.message(b, {t: 'act', a: {type: 'peace', target: a.pid}}); console.log('A got', last(a).t);
room.message(a, {t: 'act', a: {type: 'peaceAnswer', from: b.pid, accept: true}}); console.log('war after peace', atWar(room.s, a.pid, b.pid));
room.message(a, {t: 'act', a: {type: 'war', target: b.pid}}); console.log('war during truce ->', last(a).msg);
room.message(a, {t: 'act', a: {type: 'budget', tax: 60, spend: 0}});
console.log('rate with tax 60', pa.rate, 'mood target', Math.round(pa.htg));
let revolts = 0; for (let i = 0; i < 40; i++){ T += 30000; room.tick(T); }
console.log('mood now', Math.round(moodAt(pa, T)), 'cities', pa.nc, 'revolt news', room.s.news.filter(n => n.k === 'revolt').length);
room.message(a, {t: 'act', a: {type: 'research'}}); console.log('nuke research ->', last(a).msg || 'ok', Math.round(moneyAt(pa, T)));
// cap
const ok = []; for (let i = 0; i < 52; i++) ok.push(room.connect(mk('x' + i)));
console.log('accepted', ok.filter(Boolean).length, 'of 52 (2 already in)');
// bots
const r2 = new RoomCore(data, null, {now: () => T});
const bots = ['RU','UA','KZ','CN','MN'].map((cc, i) => makeBot(r2, 'Бот ' + i, cc));
for (let i = 0; i < 400; i++){ T += 3000; r2.tick(T); bots.forEach(b => b.step()); }
console.log('bots:', Object.values(r2.s.players).map(p => `${p.cc} c=${p.nc} army=${p.army} rate=${p.rate}`).join(' | '));
console.log('wars', Object.keys(r2.s.wars).length, 'armies moving', Object.keys(r2.s.armies).length, r2.s.news.slice(-3).map(n => n.txt));
console.log('next due in s', ((r2.nextDue() - T) / 1000).toFixed(1));
