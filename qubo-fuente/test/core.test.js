// Pruebas del núcleo de QUBO. Ejecutar: node test/core.test.js
const C = require('../src/core.js');
const assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const TZ = 'America/Mexico_City';
const NOW = new Date('2026-10-11T02:11:00Z');           // 10 oct 2026, 20:11 en Ciudad de México
const TODAY = '2026-10-10';
const ts = NOW.toISOString();
function mk(over) {
  const s = C.blank(TZ);
  Object.assign(s.settings, { daily: 0, safety: 0, payDays: 3, horizon: 15 }, over && over.settings);
  return s;
}
let seq = 0;
function ob(s, name, amount, days, sev, prio, extra) {
  const id = 'o' + (++seq);
  s.obligations.push(Object.assign({ id, name, amount, paidBefore: 0, due: C.addDays(TODAY, days), sev, prio, partial: false, min: 0, dest: '', status: 'activa', created: String(seq).padStart(6, '0') }, extra));
  return id;
}
const open = (s, amount) => s.ledger.push({ id: 'open' + (++seq), ts, type: 'opening', amount });
const P = s => C.plan(s, NOW);
const find = (list, id) => list.find(a => a.it.o.id === id);

t('dinero: texto a centavos sin flotantes', () => {
  const ok = { '0.1': 10, '0.2': 20, '1250.50': 125050, '1,250.50': 125050, '$ 1,250': 125000, '12,5': 1250, '.5': 50, '5.': 500, '19.99': 1999, '1000000': 100000000, '0': 0 };
  for (const k in ok) assert.strictEqual(C.parseMoney(k), ok[k], k);
  for (const bad of ['', ' ', '.', 'abc', '1.234', '-5', '1,2,3', '1e3', '12,3456']) assert.strictEqual(C.parseMoney(bad), null, bad);
  assert.strictEqual(C.parseMoney('0.1') + C.parseMoney('0.2'), 30);          // 0.1 + 0.2 = 0.30 exactos
  assert.strictEqual(C.money(123456789), '$1,234,567.89');
  assert.strictEqual(C.money(-5), '−$0.05');
  assert.strictEqual(C.parseMoney(C.moneyInput(1999)), 1999);
});

t('fechas: el día depende de la zona horaria, no del reloj UTC', () => {
  assert.strictEqual(C.dayIn(TZ, NOW), '2026-10-10');
  assert.strictEqual(C.dayIn('UTC', NOW), '2026-10-11');
  assert.strictEqual(C.dayIn('Asia/Tokyo', NOW), '2026-10-11');
  assert.strictEqual(C.dayIn(TZ, new Date('2026-10-11T05:59:59Z')), '2026-10-10');   // 23:59:59 local
  assert.strictEqual(C.dayIn(TZ, new Date('2026-10-11T06:00:00Z')), '2026-10-11');   // medianoche local
  assert.strictEqual(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(C.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(C.diffDays('2026-11-02', '2026-10-25'), 8);                     // cruza el cambio de horario en EE. UU.
  assert.strictEqual(C.diffDays('2026-03-09', '2026-03-07'), 2);
  assert.ok(C.isDay('2026-02-28') && !C.isDay('2026-02-30') && !C.isDay('2026-13-01') && !C.isDay('26-1-1'));
});

t('ejemplo: paga lo que vence, aparta para la renta, respeta la reserva', () => {
  const p = P(C.demo(NOW, TZ));
  assert.strictEqual(p.free, 320000);
  assert.strictEqual(p.distributable, 270000);
  assert.deepStrictEqual(p.pay.map(a => [a.it.o.name, a.amount]), [['Luz', 78000]]);
  assert.deepStrictEqual(p.reserve.map(a => [a.it.o.name, a.amount]), [['Renta', 192000]]);
  assert.strictEqual(p.keep, 50000);
  assert.strictEqual(p.shorts.length, 0);
  assert.strictEqual(p.next.it.o.name, 'Luz');
  assert.strictEqual(p.next.projDaily, 180000);          // hoy y mañana; el día del vencimiento no cuenta
});

t('el ingreso diario nunca es saldo', () => {
  const s = mk({ settings: { daily: 500000 } });
  ob(s, 'Renta', 100000, 1, 'critica', 1);
  const p = P(s);
  assert.strictEqual(p.cash, 0); assert.strictEqual(p.free, 0); assert.strictEqual(p.distribute, 0);
  assert.strictEqual(p.pay.length + p.reserve.length, 0);
});

t('la consecuencia manda sobre la prioridad manual', () => {
  const s = mk(); open(s, 100000);
  const low = ob(s, 'Gimnasio', 100000, 5, 'baja', 1);
  const crit = ob(s, 'Renta', 100000, 5, 'critica', 5);
  const p = P(s);
  assert.strictEqual(find(p.reserve, crit).amount, 100000);
  assert.strictEqual(find(p.reserve, low), undefined);
  assert.strictEqual(p.shorts[0].o.id, low);
});

t('misma consecuencia: decide la prioridad manual', () => {
  const s = mk(); open(s, 100000);
  const a = ob(s, 'A', 100000, 2, 'alta', 3);
  const b = ob(s, 'B', 100000, 9, 'alta', 1);
  const p = P(s);
  assert.strictEqual(find(p.reserve, b).amount, 100000);
  assert.strictEqual(p.pay.length, 0);
  assert.strictEqual(p.shorts[0].o.id, a);
});

t('protege lo crítico lejano cuando lo proyectado no alcanza', () => {
  const s = mk({ settings: { daily: 10000 } }); open(s, 100000);
  const low = ob(s, 'Suscripción', 80000, 1, 'baja', 3);
  const crit = ob(s, 'Renta', 500000, 20, 'critica', 1, { partial: true });   // divisible: cada peso ayuda
  const p = P(s);
  assert.strictEqual(find(p.reserve, crit).amount, 100000);
  assert.strictEqual(find(p.pay, low), undefined);
});

t('si lo proyectado sí cubre lo crítico, se paga lo que vence antes', () => {
  const s = mk({ settings: { daily: 60000 } }); open(s, 100000);
  const low = ob(s, 'Suscripción', 80000, 1, 'baja', 3);
  const crit = ob(s, 'Renta', 500000, 10, 'critica', 1);
  const p = P(s);
  assert.strictEqual(find(p.pay, low).amount, 80000);
  assert.strictEqual(find(p.reserve, crit).amount, 20000);
  assert.strictEqual(p.shorts.length, 0);
});

t('lo imposible a tiempo no arrastra a lo que sí se puede salvar antes', () => {
  const s = mk(); open(s, 270000);
  const renta = ob(s, 'Renta', 650000, 6, 'critica', 1);
  const luz = ob(s, 'Luz', 78000, 2, 'alta', 2);
  const net = ob(s, 'Internet', 38900, 12, 'media', 3);
  const p = P(s);
  assert.strictEqual(find(p.pay, luz).amount, 78000);            // vence antes y alcanza
  assert.strictEqual(find(p.reserve, renta).amount, 192000);     // todo lo demás se aparta para la renta
  assert.strictEqual(find(p.reserve, net), undefined);           // vence después: la renta tiene prioridad
  assert.strictEqual(p.shorts.find(i => i.o.id === renta).short, 458000);
});

t('estima cuándo se completaría un pago que no llega a tiempo', () => {
  const s = mk({ settings: { daily: 50000 } }); open(s, 100000);
  const r = ob(s, 'Renta', 400000, 2, 'critica', 1);
  const it = P(s).shorts[0];
  assert.strictEqual(it.o.id, r);
  assert.strictEqual(it.short, 200000);                  // 100,000 hoy + 2 días de ingreso
  assert.strictEqual(it.lateDate, C.addDays(TODAY, 5));  // 4 días más de ingreso diario
});

t('sin parciales no se recomienda un pago incompleto: se aparta', () => {
  const s = mk(); open(s, 50000);
  const a = ob(s, 'Luz', 78000, 0, 'alta', 1);
  const p = P(s);
  assert.strictEqual(p.pay.length, 0);
  assert.strictEqual(find(p.reserve, a).amount, 50000);
  assert.ok(find(p.reserve, a).incomplete);
});

t('parciales: debajo del mínimo se aparta en vez de pagar', () => {
  const s = mk(); open(s, 300000);
  const card = ob(s, 'Tarjeta', 1000000, 1, 'alta', 2, { partial: true, min: 100000 });
  const rent = ob(s, 'Renta', 250000, 8, 'critica', 1);
  const p = P(s);
  assert.strictEqual(find(p.pay, card), undefined);
  assert.strictEqual(find(p.reserve, card).amount, 50000);
  assert.strictEqual(find(p.reserve, rent).amount, 250000);
});

t('parciales: cubre el mínimo, abona el sobrante y no pide el mínimo dos veces', () => {
  const s = mk(); open(s, 400000);
  const card = ob(s, 'Tarjeta', 1000000, 1, 'alta', 2, { partial: true, min: 100000 });
  const rent = ob(s, 'Renta', 250000, 8, 'critica', 1);
  let p = P(s);
  const a = find(p.pay, card);
  assert.strictEqual(a.amount, 150000); assert.strictEqual(a.full, false);
  assert.strictEqual(find(p.reserve, rent).amount, 250000);
  assert.ok(C.ops.pay(s, { id: 'p1', ob: card, amount: 150000, ts }, TODAY).ok);
  assert.ok(C.ops.reserve(s, { id: 'r1', ob: rent, amount: 250000, ts }, TODAY).ok);
  p = P(s);
  assert.strictEqual(p.free, 0); assert.strictEqual(p.cash, 250000); assert.strictEqual(p.reservedTotal, 250000);
  assert.strictEqual(p.shorts.length, 0);                        // el mínimo de este vencimiento ya está cubierto
  assert.strictEqual(C.minRemaining(s.obligations[0], p.acc.by.get(card)), 0);
  s.obligations[0].due = C.addDays(TODAY, 31);                   // siguiente corte: el mínimo vuelve a exigirse
  assert.strictEqual(C.minRemaining(s.obligations[0], C.account(s, TODAY).by.get(card)), 100000);
});

t('la reserva de seguridad no se reparte', () => {
  const s = mk({ settings: { safety: 50000 } }); open(s, 60000);
  const a = ob(s, 'Luz', 30000, 0, 'critica', 1);
  const p = P(s);
  assert.strictEqual(p.distributable, 10000);
  assert.strictEqual(p.pay.length, 0);
  assert.strictEqual(find(p.reserve, a).amount, 10000);
  assert.strictEqual(p.keep, 50000); assert.strictEqual(p.cushion, 50000);
});

t('pagar usa primero lo apartado y no duplica movimientos', () => {
  const s = mk(); open(s, 100000);
  const a = ob(s, 'Luz', 78000, 0, 'alta', 1);
  assert.ok(C.ops.reserve(s, { id: 'r1', ob: a, amount: 30000, ts }, TODAY).ok);
  assert.strictEqual(C.ops.reserve(s, { id: 'r1', ob: a, amount: 30000, ts }, TODAY).dup, true);   // doble toque
  let p = P(s);
  assert.strictEqual(p.free, 70000); assert.strictEqual(p.reservedTotal, 30000); assert.strictEqual(p.cash, 100000);
  const act = find(p.pay, a);
  assert.deepStrictEqual([act.amount, act.fromReserve, act.fromFree], [78000, 30000, 48000]);
  assert.strictEqual(p.distribute, 48000);
  assert.ok(C.ops.pay(s, { id: 'p1', ob: a, amount: 78000, ts }, TODAY).ok);
  assert.strictEqual(C.ops.pay(s, { id: 'p1', ob: a, amount: 78000, ts }, TODAY).dup, true);
  assert.strictEqual(C.ops.pay(s, { id: 'p2', ob: a, amount: 78000, ts }, TODAY).ok, false);        // ya está pagada
  p = P(s);
  assert.deepStrictEqual([p.cash, p.reservedTotal, p.free, p.pay.length], [22000, 0, 22000, 0]);
  assert.strictEqual(s.ledger.filter(e => e.type === 'payment').length, 1);
});

t('nunca se paga con dinero que no existe', () => {
  const s = mk(); open(s, 50000);
  const a = ob(s, 'A', 40000, 0, 'alta', 1), b = ob(s, 'B', 40000, 0, 'alta', 2);
  assert.ok(C.ops.reserve(s, { id: 'r1', ob: a, amount: 40000, ts }, TODAY).ok);
  assert.strictEqual(C.ops.pay(s, { id: 'p1', ob: b, amount: 40000, ts }, TODAY).ok, false);   // solo quedan 10,000 libres
  assert.strictEqual(C.ops.reserve(s, { id: 'r2', ob: b, amount: 10001, ts }, TODAY).ok, false);
  assert.ok(C.ops.reserve(s, { id: 'r3', ob: b, amount: 10000, ts }, TODAY).ok);
  assert.strictEqual(P(s).free, 0);
});

t('anular restituye saldos y deja rastro', () => {
  const s = mk(); open(s, 100000);
  const a = ob(s, 'Luz', 78000, 0, 'alta', 1);
  C.ops.reserve(s, { id: 'r1', ob: a, amount: 30000, ts }, TODAY);
  C.ops.pay(s, { id: 'p1', ob: a, amount: 78000, ts }, TODAY);
  assert.strictEqual(C.ops.void(s, { id: 'v0', ref: 'r1', ts }, TODAY).ok, false);     // el apartado ya se usó
  assert.ok(C.ops.void(s, { id: 'v1', ref: 'p1', ts }, TODAY).ok);
  assert.strictEqual(C.ops.void(s, { id: 'v2', ref: 'p1', ts }, TODAY).ok, false);     // no se anula dos veces
  const p = P(s);
  assert.deepStrictEqual([p.cash, p.reservedTotal, p.free], [100000, 30000, 70000]);
  assert.strictEqual(p.acc.by.get(a).pending, 78000);
  assert.strictEqual(s.ledger.length, 4);                                              // nada se borró
});

t('un ingreso no se registra dos veces y se puede deshacer', () => {
  const s = mk();
  assert.ok(C.ops.income(s, { id: 'i1', amount: 150000, concept: 'Venta', ts }).ok);
  assert.strictEqual(C.ops.income(s, { id: 'i1', amount: 150000, concept: 'Venta', ts }).dup, true);
  assert.strictEqual(P(s).cash, 150000);
  assert.ok(C.ops.void(s, { id: 'anula:i1', ref: 'i1', ts }, TODAY).ok);
  assert.strictEqual(P(s).cash, 0);
});

t('lo registrado hoy descuenta la proyección de hoy', () => {
  const s = mk({ settings: { daily: 90000 } });
  ob(s, 'Luz', 500000, 1, 'alta', 1);
  assert.strictEqual(P(s).next.projDaily, 90000);
  C.ops.income(s, { id: 'i1', amount: 60000, ts }, TODAY);
  assert.strictEqual(P(s).next.projDaily, 30000);
  C.ops.income(s, { id: 'i2', amount: 60000, ts }, TODAY);
  assert.strictEqual(P(s).next.projDaily, 0);
  const ayer = new Date(NOW.getTime() - 86400000).toISOString();
  const s2 = mk({ settings: { daily: 90000 } }); ob(s2, 'Luz', 500000, 1, 'alta', 1);
  C.ops.income(s2, { id: 'i1', amount: 60000, ts: ayer });
  assert.strictEqual(P(s2).next.projDaily, 90000);                 // lo de ayer no toca la proyección de hoy
});

t('ingreso confirmado: se proyecta, entra una sola vez y deja de proyectarse', () => {
  const s = mk();
  const r = ob(s, 'Renta', 400000, 5, 'critica', 1);
  C.ops.addFuture(s, { id: 'f1', amount: 400000, date: C.addDays(TODAY, 5), concept: 'Cobro' }, TODAY);
  let p = P(s);
  assert.strictEqual(p.cash, 0); assert.strictEqual(p.shorts.length, 0); assert.strictEqual(p.next.projConf, 400000);
  assert.ok(C.ops.receiveFuture(s, { fid: 'f1', ts }).ok);
  assert.strictEqual(C.ops.receiveFuture(s, { fid: 'f1', ts }).dup, true);
  p = P(s);
  assert.strictEqual(p.cash, 400000); assert.strictEqual(p.next.projConf, 0);
  assert.strictEqual(find(p.reserve, r).amount, 400000);
  assert.strictEqual(p.incomeToday, 0);                            // no cuenta como ingreso diario de hoy
  assert.ok(C.ops.void(s, { id: 'v', ref: 'fi:f1:0', ts }, TODAY).ok);
  assert.strictEqual(s.future[0].received, false);
  assert.ok(C.ops.receiveFuture(s, { fid: 'f1', ts }).ok);
  assert.strictEqual(P(s).cash, 400000);
});

t('sugiere liberar un apartado menos importante ante un faltante más grave', () => {
  const s = mk(); open(s, 50000);
  const low = ob(s, 'Gimnasio', 50000, 10, 'baja', 3);
  C.ops.reserve(s, { id: 'r1', ob: low, amount: 50000, ts }, TODAY);
  const crit = ob(s, 'Renta', 40000, 1, 'critica', 1);
  const p = P(s);
  assert.strictEqual(p.shorts[0].o.id, crit);
  assert.deepStrictEqual(p.releases.map(r => [r.from.o.id, r.for.o.id, r.amount]), [[low, crit, 40000]]);
});

t('editar, pausar y eliminar liberan lo apartado que sobra', () => {
  const s = mk(); open(s, 100000);
  const r1 = C.ops.saveObligation(s, { newId: 'n1', entry: 'e1', ts, name: 'Luz', amount: 78000, pending: null, due: C.addDays(TODAY, 4), sev: 'alta', prio: 2, partial: false, min: 0, dest: '', status: 'activa' }, TODAY);
  assert.ok(r1.ok);
  C.ops.reserve(s, { id: 'r1', ob: 'n1', amount: 78000, ts }, TODAY);
  assert.ok(C.ops.saveObligation(s, { id: 'n1', entry: 'e2', ts, name: 'Luz', amount: 60000, pending: null, due: C.addDays(TODAY, 4), sev: 'alta', prio: 2, partial: false, min: 0, dest: '', status: 'activa' }, TODAY).ok);
  assert.strictEqual(P(s).reservedTotal, 60000);
  assert.ok(C.ops.saveObligation(s, { id: 'n1', entry: 'e3', ts, name: 'Luz', amount: 60000, pending: null, due: C.addDays(TODAY, 4), sev: 'alta', prio: 2, partial: false, min: 0, dest: '', status: 'pausa' }, TODAY).ok);
  assert.deepStrictEqual([P(s).reservedTotal, P(s).free], [0, 100000]);
  assert.strictEqual(C.ops.saveObligation(s, { id: 'n1', entry: 'e4', ts, name: 'Luz', amount: 60000, pending: 70000, due: C.addDays(TODAY, 4), sev: 'alta', prio: 2, partial: false, min: 0, dest: '', status: 'activa' }, TODAY).ok, false);
  assert.ok(C.ops.deleteObligation(s, { id: 'd1', ob: 'n1', ts }, TODAY).ok);
  assert.strictEqual(P(s).cash, 100000);
});

t('saldo inicial y corrección de saldo quedan como movimientos', () => {
  const s = mk();
  const base = { safety: 0, daily: 0, payDays: 3, horizon: 15, tz: TZ, ts };
  assert.ok(C.ops.saveSettings(s, Object.assign({ id: 'a', opening: 320000 }, base), TODAY).ok);
  assert.ok(C.ops.saveSettings(s, Object.assign({ id: 'b', opening: 300000 }, base), TODAY).ok);
  assert.ok(C.ops.saveSettings(s, Object.assign({ id: 'c', opening: 300000 }, base), TODAY).ok);   // sin cambio: sin movimiento
  assert.deepStrictEqual(s.ledger.map(e => e.amount), [320000, -20000]);
  assert.ok(C.ops.adjustCash(s, { id: 'x', target: 250000, ts }, TODAY).ok);
  const p = P(s);
  assert.deepStrictEqual([p.cash, p.opening], [250000, 300000]);
});

t('respaldo: ida y vuelta idéntica, y rechaza datos corruptos', () => {
  const s = C.demo(NOW, TZ);
  C.ops.income(s, { id: 'i1', amount: 12345, concept: 'x', ts });
  C.ops.pay(s, { id: 'p1', ob: 'ej-luz', amount: 78000, ts }, TODAY);
  const back = C.normalize(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(back, s);
  assert.strictEqual(C.normalize(null), null);
  assert.strictEqual(C.normalize({ app: 'otro' }), null);
  const bad = JSON.parse(JSON.stringify(s)); bad.ledger[0].amount = 10.5;
  assert.strictEqual(C.normalize(bad), null);
  const bad2 = JSON.parse(JSON.stringify(s)); bad2.obligations[0].due = '2026-02-31';
  assert.strictEqual(C.normalize(bad2), null);
});

t('2,000 casos aleatorios: invariantes de dinero y recomendaciones siempre ejecutables', () => {
  let x = 20261010;
  const rnd = k => { x = (x * 1664525 + 1013904223) >>> 0; return x % k; };
  const sevs = ['critica', 'alta', 'media', 'baja'];
  for (let i = 0; i < 2000; i++) {
    const s = mk({ settings: { daily: rnd(3) ? rnd(200000) : 0, safety: rnd(3) ? 0 : rnd(100000), payDays: rnd(6), horizon: rnd(40) } });
    open(s, rnd(1500000));
    const k = 1 + rnd(7);
    for (let j = 0; j < k; j++) {
      const amount = 1 + rnd(900000), partial = rnd(2) === 1;
      const id = ob(s, 'O' + j, amount, rnd(45) - 5, sevs[rnd(4)], 1 + rnd(5), { partial, min: partial && rnd(2) ? 1 + rnd(amount) : 0, status: rnd(9) ? 'activa' : 'pausa' });
      if (rnd(3) === 0) C.ops.reserve(s, { id: 'pre' + id, ob: id, amount: 1 + rnd(amount), ts }, TODAY);
    }
    if (rnd(2)) C.ops.addFuture(s, { id: 'f' + i, amount: 1 + rnd(600000), date: C.addDays(TODAY, rnd(30)), concept: '' }, TODAY);
    if (rnd(4) === 0) C.ops.income(s, { id: 'inc' + i, amount: 1 + rnd(300000), ts }, TODAY);

    const p = P(s), ctx = 'caso ' + i;
    assert.strictEqual(p.cash - p.reservedTotal, p.free, ctx);
    assert.ok(p.distribute <= p.distributable && p.distribute <= Math.max(0, p.free), ctx + ': reparte de más');
    assert.strictEqual(p.payFree + p.reserveTotal, p.distribute, ctx);
    assert.strictEqual(p.keep, Math.max(0, p.free) - p.distribute, ctx);
    assert.ok(p.keep >= p.cushion, ctx + ': toca la reserva de seguridad');
    for (const it of p.items) {
      assert.ok([it.now, it.future, it.short, it.reserved].every(v => Number.isSafeInteger(v) && v >= 0), ctx);
      assert.ok(it.reserved + it.now + it.future + it.short <= it.pending, ctx + ': cubre más de lo pendiente');
    }
    if (p.shorts.length) assert.strictEqual(p.distribute, p.distributable, ctx + ': deja dinero ocioso habiendo faltantes');
    assert.deepStrictEqual(P(s).pay.map(a => [a.it.o.id, a.amount]), p.pay.map(a => [a.it.o.id, a.amount]), ctx + ': no es determinista');

    // Toda recomendación debe poder confirmarse tal cual, y al confirmar todo no queda nada por repartir.
    const before = { cash: p.cash, free: p.free };
    for (const a of p.reserve) assert.ok(C.ops.reserve(s, { id: 'R' + a.it.o.id, ob: a.it.o.id, amount: a.amount, ts }, TODAY).ok, ctx + ': apartado rechazado');
    for (const a of p.pay) {
      const r = C.ops.pay(s, { id: 'P' + a.it.o.id, ob: a.it.o.id, amount: a.amount, ts }, TODAY);
      assert.ok(r.ok, ctx + ': pago rechazado · ' + r.msg);
    }
    const q = P(s);
    assert.strictEqual(q.cash, before.cash - p.payTotal, ctx);
    assert.strictEqual(q.free, before.free - p.distribute, ctx);
    assert.ok(q.cash >= 0, ctx);
    assert.strictEqual(q.distribute, 0, ctx + ': tras confirmar aún recomienda repartir ' + q.distribute);
    assert.strictEqual(q.pay.length, 0, ctx + ': recomienda pagar dos veces');
  }
});

console.log(`\n${n} pruebas correctas`);
