/* ==========================================================================
   QUBO · NÚCLEO (sin DOM, sin almacenamiento)
   Dinero en centavos enteros · fechas civiles por zona horaria ·
   contabilidad por libro de movimientos · motor determinista de priorización.
   Todo aquí es puro: mismo estado + misma fecha = misma respuesta.
   ========================================================================== */
const Core = (() => {
  'use strict';

  const DAY = 86400000;
  const SEV = { critica: 4, alta: 3, media: 2, baja: 1 };
  const SEV_LABEL = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja' };
  const isInt = Number.isSafeInteger;

  /* ---------- Dinero: siempre enteros en centavos ---------- */

  // Convierte texto a centavos sin pasar por punto flotante. Devuelve null si no es válido.
  function parseMoney(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim().replace(/[$\s]/g, '');
    if (!s) return null;
    if (s.includes(',')) {
      if (s.includes('.') || /^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');   // 1,250.50 · 1,250
      else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');                       // 12,5
      else return null;
    }
    const m = /^(\d{0,11})(?:\.(\d{0,2}))?$/.exec(s);
    if (!m || (m[1] === '' && !m[2])) return null;
    return Number(m[1] || '0') * 100 + Number((m[2] || '').padEnd(2, '0'));
  }

  function moneyParts(cents) {
    const a = Math.abs(cents);
    return {
      sign: cents < 0 ? '−' : '',
      whole: String(Math.trunc(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
      frac: String(a % 100).padStart(2, '0'),
    };
  }
  function money(cents) { const p = moneyParts(cents); return `${p.sign}$${p.whole}.${p.frac}`; }
  // Texto para precargar un campo de monto.
  function moneyInput(cents) { const p = moneyParts(Math.abs(cents)); return `${p.whole.replace(/,/g, '')}.${p.frac}`; }

  /* ---------- Fechas civiles (AAAA-MM-DD) y zona horaria ---------- */

  const fmtCache = new Map();
  // Día civil en el que cae un instante, visto desde la zona horaria dada.
  function dayIn(tz, date) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      fmtCache.set(tz, f);
    }
    const p = {};
    for (const x of f.formatToParts(date)) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}`;
  }
  function validTz(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }
  function localTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }
  // Los días se cuentan como enteros desde 1970 en UTC: restar fechas nunca depende del horario de verano.
  function dayNum(iso) { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); }
  function isDay(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
    const y = Number(iso.slice(0, 4));
    return y >= 2000 && y <= 2100 && new Date(dayNum(iso) * DAY).toISOString().slice(0, 10) === iso;
  }
  function addDays(iso, n) { return new Date((dayNum(iso) + n) * DAY).toISOString().slice(0, 10); }
  function diffDays(a, b) { return dayNum(a) - dayNum(b); }

  function uid() {
    try { if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* sigue */ }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- Estado ---------- */

  function blank(tz) {
    return {
      app: 'qubo', v: 1, rev: 0, demo: false,
      settings: { tz: validTz(tz) ? tz : localTz(), daily: 0, safety: 0, payDays: 3, horizon: 15 },
      obligations: [], future: [], ledger: [],
    };
  }

  const LEDGER_TYPES = ['opening', 'adjust', 'income', 'payment', 'reserve', 'release', 'void'];

  // Valida y copia un estado leído del almacenamiento o de un respaldo. Estricto: ante cualquier dato raro devuelve null.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || raw.app !== 'qubo') return null;
    const st = raw.settings || {};
    const out = blank(st.tz);
    out.rev = isInt(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
    out.demo = raw.demo === true;
    const nn = v => isInt(v) && v >= 0;
    if (nn(st.daily)) out.settings.daily = st.daily;
    if (nn(st.safety)) out.settings.safety = st.safety;
    if (nn(st.payDays) && st.payDays <= 30) out.settings.payDays = st.payDays;
    if (nn(st.horizon) && st.horizon <= 365) out.settings.horizon = st.horizon;
    const str = (v, max) => typeof v === 'string' && v.length <= max;
    const ids = new Set();

    for (const o of Array.isArray(raw.obligations) ? raw.obligations : []) {
      if (!o || !str(o.id, 80) || !o.id || ids.has(o.id) || !str(o.name, 80) || !o.name) return null;
      if (!(isInt(o.amount) && o.amount > 0) || !isDay(o.due) || !(o.sev in SEV)) return null;
      const paidBefore = nn(o.paidBefore) ? o.paidBefore : 0;
      if (paidBefore > o.amount) return null;
      ids.add(o.id);
      out.obligations.push({
        id: o.id, name: o.name, amount: o.amount, paidBefore, due: o.due, sev: o.sev,
        prio: isInt(o.prio) && o.prio >= 1 && o.prio <= 5 ? o.prio : 3,
        partial: o.partial === true, min: nn(o.min) ? Math.min(o.min, o.amount) : 0,
        dest: str(o.dest, 120) ? o.dest : '', status: o.status === 'pausa' ? 'pausa' : 'activa',
        created: str(o.created, 40) ? o.created : '',
      });
    }
    const fids = new Set();
    for (const f of Array.isArray(raw.future) ? raw.future : []) {
      if (!f || !str(f.id, 80) || !f.id || fids.has(f.id) || !(isInt(f.amount) && f.amount > 0) || !isDay(f.date)) return null;
      fids.add(f.id);
      out.future.push({ id: f.id, amount: f.amount, date: f.date, concept: str(f.concept, 80) ? f.concept : '', received: f.received === true });
    }
    const lids = new Set();
    for (const e of Array.isArray(raw.ledger) ? raw.ledger : []) {
      if (!e || !str(e.id, 120) || !e.id || lids.has(e.id) || !LEDGER_TYPES.includes(e.type)) return null;
      if (!str(e.ts, 40) || Number.isNaN(Date.parse(e.ts))) return null;
      const x = { id: e.id, ts: e.ts, type: e.type };
      if (e.type === 'void') { if (!str(e.ref, 120)) return null; x.ref = e.ref; }
      else {
        if (!isInt(e.amount)) return null;
        if (e.type !== 'opening' && e.type !== 'adjust' && e.amount <= 0) return null;
        x.amount = e.amount;
      }
      if (str(e.ob, 80) && e.ob) x.ob = e.ob;
      if (str(e.label, 80) && e.label) x.label = e.label;
      if (str(e.concept, 120) && e.concept) x.concept = e.concept;
      if (str(e.fi, 80) && e.fi) x.fi = e.fi;
      if (e.type === 'payment') { x.fromReserve = nn(e.fromReserve) ? Math.min(e.fromReserve, e.amount) : 0; if (isDay(e.due)) x.due = e.due; }
      if (e.auto === true) x.auto = true;
      lids.add(e.id);
      out.ledger.push(x);
    }
    return out;
  }

  /* ---------- Contabilidad: el libro de movimientos es la única fuente de verdad ---------- */

  // Recorre el libro y deriva saldos. Nada se guarda como total: no hay forma de que un total se desfase.
  function account(state, today) {
    const tz = state.settings.tz;
    const voided = new Set();
    for (const e of state.ledger) if (e.type === 'void') voided.add(e.ref);
    const by = new Map();
    for (const o of state.obligations) by.set(o.id, { paid: 0, paidDue: 0, reserved: 0, pending: 0, due: o.due });
    const lo = (dayNum(today) - 2) * DAY;   // solo los movimientos recientes pueden ser "de hoy"
    let cash = 0, opening = 0, incomeToday = 0;
    for (const e of state.ledger) {
      if (e.type === 'void' || voided.has(e.id)) continue;
      const b = e.ob ? by.get(e.ob) : null;
      switch (e.type) {
        case 'opening': cash += e.amount; opening += e.amount; break;
        case 'adjust': cash += e.amount; break;
        case 'income':
          cash += e.amount;
          // Lo ya registrado hoy descuenta la proyección de hoy (no se cuenta dos veces).
          if (!e.fi) { const t = Date.parse(e.ts); if (t >= lo && dayIn(tz, new Date(t)) === today) incomeToday += e.amount; }
          break;
        case 'payment':
          cash -= e.amount;
          if (b) { b.paid += e.amount; b.reserved -= e.fromReserve || 0; if (e.due === b.due) b.paidDue += e.amount; }
          break;
        case 'reserve': if (b) b.reserved += e.amount; break;
        case 'release': if (b) b.reserved -= e.amount; break;
      }
    }
    let reservedTotal = 0;
    for (const o of state.obligations) {
      const b = by.get(o.id);
      b.reserved = Math.max(0, b.reserved);
      b.pending = Math.max(0, o.amount - o.paidBefore - b.paid);
      reservedTotal += b.reserved;
    }
    return { cash, opening, reservedTotal, free: cash - reservedTotal, by, voided, incomeToday };
  }

  // Mínimo que falta para el vencimiento vigente. Lo ya pagado contra esa fecha cuenta: el mínimo no se pide dos veces.
  function minRemaining(o, b) {
    if (!o.partial) return b.pending;
    return o.min > 0 ? Math.min(Math.max(0, o.min - b.paidDue), b.pending) : 0;
  }

  /* ---------- Motor de priorización ---------- */

  /*
    Reglas, en orden:
    1. Solo se reparte dinero disponible real (en mano − reservado) por encima de la reserva de seguridad.
    2. Importancia = consecuencia del impago → prioridad manual → fecha. La consecuencia manda sobre el orden manual.
    3. Cada obligación se intenta cubrir con el ingreso proyectado MÁS TARDÍO que llegue antes de su vencimiento;
       solo lo que el futuro no cubre reclama dinero de hoy ("protegido").
    4. Si una obligación no se puede cubrir a tiempo ni con lo proyectado, primero se salvan las que vencen
       antes y sí se pueden cubrir completas; lo demás se aparta para ella.
    5. Lo que sobra se adelanta a los vencimientos cercanos (dentro del horizonte), del más próximo al más lejano.
    6. Lo que queda después va a los saldos por encima del mínimo (p. ej. el resto de una tarjeta).
    7. PAGAR si vence dentro de la ventana de pago y alcanza el mínimo exigido; si no, RESERVAR.
  */
  function plan(state, now) {
    const S = state.settings;
    const today = dayIn(S.tz, now || new Date());
    const acc = account(state, today);
    const free = acc.free;
    const cushion = Math.max(0, Math.min(free, S.safety));
    let pool = Math.max(0, free - S.safety);
    const distributable = pool;

    const items = [];
    for (const o of state.obligations) {
      const b = acc.by.get(o.id);
      if (o.status !== 'activa' || b.pending <= 0) continue;
      const reserved = Math.min(b.reserved, b.pending);
      // Tramo A = lo que evita el impago: todo (sin parciales), el mínimo que falta (parciales con mínimo)
      // o todo pero divisible (parcial sin mínimo). Tramo B = el saldo por encima del mínimo.
      const minEff = minRemaining(o, b);
      const base = o.partial && o.min > 0 ? minEff : b.pending;
      items.push({
        o, pending: b.pending, reserved, days: diffDays(o.due, today), minEff, threshold: minEff > 0,
        needA: Math.max(0, base - reserved),
        needB: Math.max(0, (b.pending - base) - Math.max(0, reserved - base)),
        protectedNow: 0, accel: 0, extra: 0, future: 0, short: 0, lateDate: null, now: 0, done: false,
      });
    }
    items.sort((x, y) =>
      SEV[y.o.sev] - SEV[x.o.sev] || x.o.prio - y.o.prio || x.days - y.days ||
      (x.o.created < y.o.created ? -1 : x.o.created > y.o.created ? 1 : 0) || (x.o.id < y.o.id ? -1 : 1));
    items.forEach((it, i) => { it.rank = i; });

    // Proyección día por día. Índice = días desde hoy. El ingreso diario es una estimación, nunca saldo.
    const maxDays = items.reduce((m, it) => Math.max(m, it.days), 0);
    const T = Math.min(366, maxDays) + 60;
    const daily = new Array(T + 1).fill(S.daily);
    daily[0] = Math.max(0, S.daily - acc.incomeToday);
    const conf = new Array(T + 1).fill(0);
    const overdueFuture = [];
    for (const f of state.future) {
      if (f.received) continue;
      const t = diffDays(f.date, today);
      if (t < 0) overdueFuture.push(f); else if (t <= T) conf[t] += f.amount;
    }
    const daily0 = daily.slice(), conf0 = conf.slice();

    // Antes del vencimiento D cuentan: confirmados hasta el día D y el ingreso diario de los días anteriores a D.
    const cut = it => Math.min(it.days, T);
    function futureAvail(it) {
      let s = 0;
      for (let t = cut(it); t >= 0; t--) { s += conf[t]; if (t < it.days) s += daily[t]; }
      return s;
    }
    function takeFuture(it, need) {
      let got = 0;
      for (let t = cut(it); t >= 0 && need > 0; t--) {
        let k = Math.min(conf[t], need); conf[t] -= k; need -= k; got += k;
        if (t < it.days) { k = Math.min(daily[t], need); daily[t] -= k; need -= k; got += k; }
      }
      return got;
    }
    // Una obligación que no llega a tiempo absorbe los ingresos siguientes; estima cuándo se completaría.
    function takeLate(it, need) {
      for (let t = Math.max(0, it.days); t <= T; t++) {
        let k = Math.min(conf[t], need); conf[t] -= k; need -= k;
        k = Math.min(daily[t], need); daily[t] -= k; need -= k;
        if (need <= 0) return addDays(today, t);
      }
      return null;
    }
    function serve(it) {
      it.done = true;
      let need = it.needA;
      if (need <= 0) return;
      const f = takeFuture(it, need); need -= f; it.future += f;
      const c = Math.min(pool, need); pool -= c; need -= c; it.protectedNow += c;
      it.short = need;
      if (need > 0) it.lateDate = takeLate(it, need);
    }
    const feasible = it => futureAvail(it) + pool >= it.needA;

    // Paso A · proteger: reclamar de hoy solo lo que el futuro no alcanza a cubrir.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.done) continue;
      if (it.threshold && it.needA > 0 && !feasible(it)) {
        for (let j = i + 1; j < items.length; j++) {
          const e = items[j];
          if (!e.done && e.needA > 0 && e.days <= it.days && feasible(e)) { serve(e); e.jumped = true; }
        }
      }
      serve(it);
    }
    // Paso B · adelantar a vencimientos cercanos lo que hoy dependía de ingresos futuros.
    const near = items.filter(it => it.days <= S.horizon).sort((x, y) => x.days - y.days || x.rank - y.rank);
    for (const it of near) {
      if (pool <= 0) break;
      const k = Math.min(pool, it.future); pool -= k; it.accel += k; it.future -= k;
    }
    // Paso C · saldos por encima del mínimo.
    for (const it of near) {
      if (pool <= 0) break;
      const k = Math.min(pool, it.needB); pool -= k; it.extra += k;
    }

    // Convertir asignaciones en acciones.
    const pay = [], reserve = [];
    const byDue = items.slice().sort((x, y) => x.days - y.days || x.rank - y.rank);
    for (const it of byDue) {
      it.now = it.protectedNow + it.accel + it.extra;
      const total = it.reserved + it.now;
      const dueSoon = it.days <= S.payDays;
      const minPay = it.o.partial ? (it.minEff > 0 ? it.minEff : 1) : it.pending;
      if (dueSoon && total >= minPay) {
        const amount = Math.min(total, it.pending);
        const fromReserve = Math.min(it.reserved, amount);
        pay.push({ it, amount, fromReserve, fromFree: amount - fromReserve, full: amount === it.pending });
      } else if (it.now > 0) {
        reserve.push({ it, amount: it.now, incomplete: dueSoon, protectedPart: it.protectedNow });
      }
    }
    const payFree = pay.reduce((s, a) => s + a.fromFree, 0);
    const payTotal = pay.reduce((s, a) => s + a.amount, 0);
    const reserveTotal = reserve.reduce((s, a) => s + a.amount, 0);
    const distribute = payFree + reserveTotal;
    const keep = Math.max(0, free - distribute);

    // Sugerencia: liberar apartados de obligaciones menos importantes para cubrir un faltante más grave.
    const releases = [];
    const holders = items.filter(it => it.reserved > 0).map(it => ({ it, left: it.reserved })).sort((x, y) => y.it.rank - x.it.rank);
    for (const s of items) {
      if (s.short <= 0) continue;
      let need = s.short;
      for (const h of holders) {
        if (need <= 0 || h.it.rank <= s.rank) break;
        const k = Math.min(h.left, need);
        if (k > 0) { releases.push({ from: h.it, for: s, amount: k }); h.left -= k; need -= k; }
      }
    }

    // Próximo vencimiento y su proyección diaria.
    let next = null;
    if (byDue.length) {
      const it = byDue[0];
      let projDaily = 0, projConf = 0;
      for (let t = cut(it); t >= 0; t--) { projConf += conf0[t]; if (t < it.days) projDaily += daily0[t]; }
      next = { it, projDaily, projConf };
    }

    return {
      today, cash: acc.cash, reservedTotal: acc.reservedTotal, free, opening: acc.opening, incomeToday: acc.incomeToday,
      safety: S.safety, cushion, distributable, distribute, payFree, payTotal, reserveTotal,
      keep, keepExtra: keep - cushion, pay, reserve, items, next, releases, overdueFuture,
      shorts: items.filter(it => it.short > 0), acc,
    };
  }

  /* ---------- Operaciones: la única forma de cambiar el estado ---------- */

  const fail = msg => ({ ok: false, msg });
  // Un mismo id nunca entra dos veces al libro: doble toque, doble pestaña o reintento no duplican nada.
  const DUP = { ok: false, dup: true, msg: 'Ese movimiento ya estaba registrado.' };
  const seen = (s, id) => s.ledger.some(x => x.id === id);
  function push(s, e) {
    if (seen(s, e.id)) return DUP;
    s.ledger.push(e);
    return { ok: true, id: e.id };
  }
  const okAmount = a => isInt(a) && a > 0;
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  const ops = {
    income(s, { id, amount, concept, ts }) {
      if (seen(s, id)) return DUP;
      if (!okAmount(amount)) return fail('Escribe una cantidad mayor a cero.');
      const e = { id, ts, type: 'income', amount };
      if (text(concept, 120)) e.concept = text(concept, 120);
      return push(s, e);
    },

    pay(s, { id, ob, amount, ts }, today) {
      if (seen(s, id)) return DUP;
      const o = s.obligations.find(x => x.id === ob);
      if (!o) return fail('Esa obligación ya no existe.');
      if (!okAmount(amount)) return fail('Escribe una cantidad mayor a cero.');
      const acc = account(s, today), b = acc.by.get(ob);
      if (b.pending <= 0) return fail('Esta obligación ya está pagada.');
      if (amount > b.pending) return fail(`Solo quedan ${money(b.pending)} pendientes.`);
      if (!o.partial && amount !== b.pending) return fail(`No admite pagos parciales: son ${money(b.pending)} completos.`);
      const minRem = minRemaining(o, b);
      if (o.partial && amount < minRem) return fail(`El pago mínimo es ${money(minRem)}.`);
      const fromReserve = Math.min(b.reserved, amount);
      if (amount - fromReserve > Math.max(0, acc.free)) {
        return fail(`No tienes ese dinero. Puedes pagar hasta ${money(Math.max(0, acc.free) + b.reserved)}.`);
      }
      const r = push(s, { id, ts, type: 'payment', ob, label: o.name, amount, fromReserve, due: o.due });
      if (!r.ok) return r;
      const excess = (b.reserved - fromReserve) - (b.pending - amount);   // apartado que ya no hace falta
      if (excess > 0) push(s, { id: id + ':lib', ts, type: 'release', ob, label: o.name, amount: excess, auto: true });
      return r;
    },

    reserve(s, { id, ob, amount, ts }, today) {
      if (seen(s, id)) return DUP;
      const o = s.obligations.find(x => x.id === ob);
      if (!o) return fail('Esa obligación ya no existe.');
      if (!okAmount(amount)) return fail('Escribe una cantidad mayor a cero.');
      const acc = account(s, today), b = acc.by.get(ob);
      if (amount > b.pending - b.reserved) return fail(`Solo faltan ${money(Math.max(0, b.pending - b.reserved))} por apartar.`);
      if (amount > acc.free) return fail(`Solo tienes ${money(Math.max(0, acc.free))} disponibles.`);
      return push(s, { id, ts, type: 'reserve', ob, label: o.name, amount });
    },

    release(s, { id, ob, amount, ts }, today) {
      if (seen(s, id)) return DUP;
      const o = s.obligations.find(x => x.id === ob);
      if (!o) return fail('Esa obligación ya no existe.');
      if (!okAmount(amount)) return fail('Escribe una cantidad mayor a cero.');
      const b = account(s, today).by.get(ob);
      if (amount > b.reserved) return fail(`Solo hay ${money(b.reserved)} apartados.`);
      return push(s, { id, ts, type: 'release', ob, label: o.name, amount });
    },

    // Nada se borra: anular agrega un movimiento que cancela al original.
    void(s, { id, ref, ts }, today) {
      if (seen(s, id)) return DUP;
      const e = s.ledger.find(x => x.id === ref);
      if (!e || e.type === 'void') return fail('Ese movimiento no existe.');
      if (e.type === 'release') return fail('Una liberación no se anula: vuelve a apartar el dinero.');
      const acc = account(s, today);
      if (acc.voided.has(ref)) return fail('Ese movimiento ya estaba anulado.');
      if (e.type === 'reserve') {
        const b = acc.by.get(e.ob);
        if (b && b.reserved < e.amount) return fail('Parte de ese apartado ya se usó en un pago. Anula primero el pago.');
      }
      const r = push(s, { id, ts, type: 'void', ref, label: e.label || e.concept || '' });
      if (!r.ok) return r;
      if (e.fi) { const f = s.future.find(x => x.id === e.fi); if (f) f.received = false; }
      return r;
    },

    saveSettings(s, d, today) {
      const { id, ts } = d;
      for (const k of ['opening', 'safety', 'daily']) if (!(isInt(d[k]) && d[k] >= 0)) return fail('Revisa los montos: deben ser cero o más.');
      if (!(isInt(d.payDays) && d.payDays >= 0 && d.payDays <= 30)) return fail('Días para pagar: entre 0 y 30.');
      if (!(isInt(d.horizon) && d.horizon >= 0 && d.horizon <= 365)) return fail('Días para reservar: entre 0 y 365.');
      if (!validTz(d.tz)) return fail('Zona horaria no válida.');
      const delta = d.opening - account(s, today).opening;
      if (delta !== 0) { const r = push(s, { id, ts, type: 'opening', amount: delta, concept: 'Saldo inicial' }); if (!r.ok) return r; }
      Object.assign(s.settings, { safety: d.safety, daily: d.daily, payDays: d.payDays, horizon: d.horizon, tz: d.tz });
      return { ok: true };
    },

    // Corrige el dinero en mano cuando la realidad no coincide (gastos fuera de la app, efectivo contado).
    adjustCash(s, { id, target, ts }, today) {
      if (!(isInt(target) && target >= 0)) return fail('Escribe cuánto dinero tienes en realidad.');
      const delta = target - account(s, today).cash;
      if (delta === 0) return fail('El saldo ya coincide.');
      return push(s, { id, ts, type: 'adjust', amount: delta, concept: 'Corrección de saldo' });
    },

    saveObligation(s, d, today) {
      const name = text(d.name, 80);
      if (!name) return fail('Ponle un nombre.');
      if (!okAmount(d.amount)) return fail('El monto debe ser mayor a cero.');
      if (!isDay(d.due)) return fail('Elige la fecha de vencimiento.');
      if (!(d.sev in SEV)) return fail('Elige la consecuencia del impago.');
      if (!(isInt(d.prio) && d.prio >= 1 && d.prio <= 5)) return fail('Prioridad: del 1 al 5.');
      const min = d.partial ? d.min : 0;
      if (!(isInt(min) && min >= 0 && min <= d.amount)) return fail('El mínimo no puede superar el monto.');
      let o = d.id ? s.obligations.find(x => x.id === d.id) : null;
      if (d.id && !o) return fail('Esa obligación ya no existe.');
      const paid = o ? account(s, today).by.get(o.id).paid : 0;
      const pending = d.pending == null ? Math.max(0, d.amount - (o ? o.paidBefore : 0) - paid) : d.pending;
      if (!(isInt(pending) && pending >= 0)) return fail('Revisa lo pendiente.');
      if (pending + paid > d.amount) {
        return fail(paid ? `Ya registraste ${money(paid)} en pagos: lo pendiente no puede pasar de ${money(d.amount - paid)}.` : 'Lo pendiente no puede superar el monto total.');
      }
      if (!o) {
        if (s.obligations.some(x => x.id === d.newId)) return { ok: false, dup: true, msg: 'Esa obligación ya estaba guardada.' };
        o = { id: d.newId, created: d.ts }; s.obligations.push(o);
      }
      Object.assign(o, {
        name, amount: d.amount, paidBefore: d.amount - paid - pending, due: d.due, sev: d.sev, prio: d.prio,
        partial: d.partial === true, min, dest: text(d.dest, 120), status: d.status === 'pausa' ? 'pausa' : 'activa',
      });
      const b = account(s, today).by.get(o.id);
      const excess = o.status === 'pausa' ? b.reserved : b.reserved - b.pending;
      if (excess > 0) push(s, { id: d.entry + ':lib', ts: d.ts, type: 'release', ob: o.id, label: o.name, amount: excess, auto: true });
      return { ok: true, id: o.id };
    },

    deleteObligation(s, { id, ob, ts }, today) {
      const o = s.obligations.find(x => x.id === ob);
      if (!o) return fail('Esa obligación ya no existe.');
      const b = account(s, today).by.get(ob);
      if (b.reserved > 0) push(s, { id: id + ':lib', ts, type: 'release', ob, label: o.name, amount: b.reserved, auto: true });
      s.obligations = s.obligations.filter(x => x.id !== ob);
      return { ok: true };
    },

    addFuture(s, { id, amount, date, concept }, today) {
      if (!okAmount(amount)) return fail('Escribe una cantidad mayor a cero.');
      if (!isDay(date)) return fail('Elige la fecha en que llegará.');
      if (s.future.some(f => f.id === id)) return { ok: false, dup: true, msg: 'Ese ingreso ya estaba guardado.' };
      s.future.push({ id, amount, date, concept: text(concept, 80), received: false });
      return { ok: true };
    },
    deleteFuture(s, { fid }) {
      const f = s.future.find(x => x.id === fid);
      if (!f) return fail('Ese ingreso ya no existe.');
      if (f.received) return fail('Ya está recibido: anúlalo desde Movimientos.');
      s.future = s.future.filter(x => x.id !== fid);
      return { ok: true };
    },
    // Al llegar, el ingreso confirmado pasa al saldo real una sola vez y deja de proyectarse.
    receiveFuture(s, { fid, ts }) {
      const f = s.future.find(x => x.id === fid);
      if (!f) return fail('Ese ingreso ya no existe.');
      if (f.received) return { ok: false, dup: true, msg: 'Ese ingreso ya estaba recibido.' };
      const n = s.ledger.filter(e => e.fi === fid).length;
      const r = push(s, { id: `fi:${fid}:${n}`, ts, type: 'income', amount: f.amount, concept: f.concept || 'Ingreso confirmado', fi: fid });
      if (r.ok) f.received = true;
      return r;
    },
  };

  /* ---------- Datos de ejemplo (fechas relativas a hoy) ---------- */

  function demo(now, tz) {
    const s = blank(tz);
    const today = dayIn(s.settings.tz, now), ts = now.toISOString();
    s.demo = true;
    Object.assign(s.settings, { daily: 90000, safety: 50000 });
    const ob = (id, name, amount, days, sev, prio, extra) => s.obligations.push(Object.assign(
      { id, name, amount, paidBefore: 0, due: addDays(today, days), sev, prio, partial: false, min: 0, dest: '', status: 'activa', created: ts + id }, extra));
    ob('ej-luz', 'Luz', 78000, 2, 'alta', 2, { dest: 'Recibo en línea o tienda' });
    ob('ej-renta', 'Renta', 650000, 6, 'critica', 1, { dest: 'Transferencia al arrendador' });
    ob('ej-tarjeta', 'Tarjeta de crédito', 1240000, 9, 'alta', 2, { partial: true, min: 124000, dest: 'App del banco' });
    ob('ej-internet', 'Internet', 38900, 12, 'media', 3, { dest: 'Cargo en línea' });
    ob('ej-prestamo', 'Préstamo de un familiar', 200000, 20, 'baja', 4, { partial: true, dest: 'En efectivo' });
    s.future.push({ id: 'ej-cobro', amount: 400000, date: addDays(today, 4), concept: 'Cobro pendiente', received: false });
    s.ledger.push({ id: 'ej-inicial', ts, type: 'opening', amount: 320000, concept: 'Saldo inicial' });
    return s;
  }

  return {
    SEV, SEV_LABEL, parseMoney, money, moneyParts, moneyInput, dayIn, validTz, localTz, isDay, addDays, diffDays,
    uid, blank, normalize, account, minRemaining, plan, ops, demo,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;
