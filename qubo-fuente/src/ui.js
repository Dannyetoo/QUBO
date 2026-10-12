/* ==========================================================================
   QUBO · PERSISTENCIA
   Un solo adaptador. Hoy guarda en localStorage; para sincronizar con un
   servidor basta con sustituir read() y write() por llamadas a tu API.
   ========================================================================== */
const Store = (() => {
  const KEY = 'qubo.v1';
  let mem = null, ok = true;
  const fromMem = () => (mem ? JSON.parse(mem) : null);
  return {
    get ok() { return ok; },
    read() {
      if (!ok && mem) return fromMem();
      try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : fromMem(); }
      catch (e) { ok = false; return fromMem(); }
    },
    write(state) {
      mem = JSON.stringify(state);
      try { localStorage.setItem(KEY, mem); ok = true; } catch (e) { ok = false; }
    },
    // Si lo guardado no se puede leer, se aparta una copia antes de seguir: nunca se pisa a ciegas.
    quarantine() {
      try { const raw = localStorage.getItem(KEY); if (raw) localStorage.setItem(KEY + '.copia-' + Date.now(), raw); } catch (e) { /* sin almacenamiento */ }
    },
    onExternalChange(fn) { window.addEventListener('storage', e => { if (e.key === KEY) fn(); }); },
  };
})();

/* ==========================================================================
   QUBO · INTERFAZ
   Solo dibuja lo que calcula el núcleo y traduce toques en operaciones.
   ========================================================================== */
(() => {
  'use strict';
  const HOSTED = false;   // el empaquetado para Hostinger lo cambia a true (descarga de respaldo y modo sin conexión)

  const $ = (sel, root) => (root || document).querySelector(sel);
  const view = $('#view'), sheet = $('#sheet'), toastEl = $('#toast');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const M = c => { const p = Core.moneyParts(c); return `<span class="m">${p.sign}$${p.whole}<i>.${p.frac}</i></span>`; };
  const T = Core.money;

  const dfDay = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const dayLabel = iso => dfDay.format(new Date(iso + 'T12:00:00Z')).replace(/[.,]/g, '');
  const stamp = ts => new Intl.DateTimeFormat('es-MX', { timeZone: state.settings.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts)).replace(/\./g, '');
  const clock = () => new Intl.DateTimeFormat('es-MX', { timeZone: state.settings.tz, hour: '2-digit', minute: '2-digit' }).format(new Date());
  function whenText(days) {
    if (days < -1) return `Venció hace ${-days} días`;
    if (days === -1) return 'Venció ayer';
    if (days === 0) return 'Vence hoy';
    if (days === 1) return 'Vence mañana';
    return `Vence en ${days} días`;
  }

  /* ---------- Estado y guardado ---------- */

  let state = boot(), lastPlan = null, cur = null, flash = null, undoFn = null, toastTimer = 0;

  function boot() {
    const raw = Store.read(), s = Core.normalize(raw);
    if (s) return s;
    if (raw) Store.quarantine();
    return Core.demo(new Date());
  }
  const today = () => Core.dayIn(state.settings.tz, new Date());

  // Cada cambio parte de lo último guardado (otra pestaña pudo escribir) y sube la revisión.
  function commit(fn) {
    const fresh = Core.normalize(Store.read()) || JSON.parse(JSON.stringify(state));
    const res = fn(fresh, Core.dayIn(fresh.settings.tz, new Date()), new Date().toISOString()) || { ok: true };
    if (res.ok) { fresh.rev += 1; Store.write(fresh); state = fresh; }
    else state = Core.normalize(Store.read()) || state;
    render();
    return res;
  }
  const undoEntry = id => commit((s, day, ts) => Core.ops.void(s, { id: 'anula:' + id, ref: id, ts }, day));

  /* ---------- Pantalla principal ---------- */

  function render() {
    const p = lastPlan = Core.plan(state, new Date());
    $('#today').textContent = dayLabel(p.today);
    const note = flash; flash = null;
    view.innerHTML = banner() + hero(p) + nextDue(p) + planBlock(p, note) + alerts(p);
  }

  function banner() {
    if (!state.demo) return '';
    return `<div class="banner"><span>Datos de ejemplo</span>
      <button class="link" type="button" data-act="demo-clear">Borrar y usar los míos</button></div>`;
  }

  function hero(p) {
    return `<section class="hero">
      <p class="label">Disponible</p>
      <p class="big${p.free < 0 ? ' neg' : ''}">${M(p.free)}</p>
      <dl class="pair">
        <div><dt>Reservado</dt><dd>${M(p.reservedTotal)}</dd></div>
        <div><dt>Total en mano</dt><dd>${M(p.cash)}</dd></div>
      </dl>
    </section>`;
  }

  function coverage(it) {
    const rest = Math.max(0, it.pending - it.reserved - it.now - it.future - it.short);
    const seg = [['b-res', 'k-res', 'Apartado', it.reserved], ['b-now', 'k-now', 'Con lo de hoy', it.now],
      ['b-fut', 'l-fut', 'Proyectado', it.future], ['b-miss', 'k-pay', 'Falta', it.short], ['b-rest', '', '', rest]];
    const bar = seg.filter(s => s[3] > 0).map(s => `<span class="${s[0]}" style="flex:${s[3]}"></span>`).join('');
    const legend = seg.filter(s => s[3] > 0 && s[2]).map(s => `<span class="${s[1]}">${s[2]} ${T(s[3])}</span>`).join('');
    return `<div class="bar" role="img" aria-label="Cobertura del pago">${bar}</div><p class="legend">${legend}</p>`;
  }

  function nextDue(p) {
    if (!p.next) return '';
    const { it, projDaily, projConf } = p.next;
    let proj = '';
    if (it.days > 0) {
      proj = projDaily + projConf > 0
        ? `Antes de esa fecha proyectas ${T(projDaily)} de ingreso diario${projConf ? ` y ${T(projConf)} confirmados` : ''}. Es una estimación, no saldo.`
        : 'Sin ingresos proyectados antes de esa fecha.';
    }
    return `<section class="next">
      <div class="row wrap"><p class="label">Próximo vencimiento</p>
        <p class="when${it.days <= 1 ? ' hot' : ''}">${whenText(it.days)} · ${dayLabel(it.o.due)}</p></div>
      <div class="row"><h2>${esc(it.o.name)}</h2><p class="amt">${M(it.pending)}</p></div>
      ${coverage(it)}
      ${proj ? `<p class="cap">${proj}</p>` : ''}
    </section>`;
  }

  function payItem(a) {
    const it = a.it, bits = [`${whenText(it.days)} (${dayLabel(it.o.due)})`];
    if (it.o.sev === 'critica' || it.o.sev === 'alta') bits.push(`consecuencia ${Core.SEV_LABEL[it.o.sev].toLowerCase()}`);
    let why = bits.join(' · ') + '.';
    if (!a.full) why += ` Pago parcial${it.minEff && a.amount >= it.minEff ? ' que cubre el mínimo' : ''}; quedarán ${T(it.pending - a.amount)}.`;
    if (a.fromReserve > 0) why += ` ${T(a.fromReserve)} salen de lo que ya apartaste.`;
    if (it.o.dest) why += ` Destino: ${esc(it.o.dest)}.`;
    return `<li><strong>${esc(it.o.name)}</strong><span class="it-amt">${M(a.amount)}</span>
      <p class="why">${why}</p>
      <button class="btn sm" type="button" data-act="move" data-kind="pay" data-ob="${esc(it.o.id)}" data-amount="${a.amount}" data-key="r:pay:${esc(it.o.id)}:${state.rev}">Confirmar pago</button></li>`;
  }

  function reserveItem(a) {
    const it = a.it;
    let why = `${whenText(it.days)} (${dayLabel(it.o.due)}). `;
    if (a.incomplete) {
      const target = it.o.partial ? (it.minEff || 1) : it.pending;
      why += `Todavía no alcanza para pagarlo: faltan ${T(target - it.reserved - it.now)}. Aparta esto mientras tanto.`;
    } else if (it.short > 0) why += 'No se completa a tiempo: aparta todo lo que puedas.';
    else if (a.protectedPart > 0) why += 'Tus ingresos proyectados no alcanzan a cubrirlo: aparta desde hoy.';
    else if (it.extra > 0 && it.extra === a.amount) why += 'Abono por encima del mínimo.';
    else why += 'Vencimiento cercano: apártalo para no depender de ingresos que aún no llegan.';
    return `<li><strong>${esc(it.o.name)}</strong><span class="it-amt">${M(a.amount)}</span>
      <p class="why">${why}</p>
      <button class="btn sm" type="button" data-act="move" data-kind="reserve" data-ob="${esc(it.o.id)}" data-amount="${a.amount}" data-key="r:reserve:${esc(it.o.id)}:${state.rev}">Confirmar apartado</button></li>`;
  }

  function planBlock(p, note) {
    if (!state.obligations.length) {
      return `<section class="plan" id="plan"><p class="label">Reparto</p>
        <p class="none">Agrega tus obligaciones y te diré qué pagar, qué apartar y qué conservar.</p>
        <button class="btn" type="button" data-act="ob-new">Agregar obligación</button></section>`;
    }
    const split = p.free > 0 ? `<div class="bar" role="img" aria-label="Reparto del dinero disponible">
        ${[['b-pay', p.payFree], ['b-res', p.reserveTotal], ['b-keep', p.keep]].filter(s => s[1] > 0).map(s => `<span class="${s[0]}" style="flex:${s[1]}"></span>`).join('')}</div>` : '';
    const keepRows = [];
    if (p.safety > 0) keepRows.push(`<p class="kv"><span>Reserva de seguridad${p.cushion < p.safety ? ` (meta ${T(p.safety)})` : ''}</span><span>${M(p.cushion)}</span></p>`);
    if (p.keepExtra > 0 || !p.safety) keepRows.push(`<p class="kv"><span>Libre, sin compromiso</span><span>${M(p.keepExtra)}</span></p>`);
    const fromRes = p.payTotal - p.payFree;
    return `<section class="plan" id="plan">
      <p class="label">Reparte ahora</p>
      <p class="mid">${M(p.distribute)}</p>
      <p class="cap">${p.distribute > 0 ? `de tus ${T(p.free)} disponibles.` : 'Hoy no hay nada que repartir.'}${fromRes > 0 ? ` Además usarás ${T(fromRes)} que ya tenías apartados.` : ''}</p>
      ${note ? `<p class="note">Ingreso de ${T(note)} registrado. El reparto ya lo incluye.</p>` : ''}
      ${split}
      <div class="cube pay"><header><span class="sq"></span><h3>Pagar</h3><span class="tot">${M(p.payTotal)}</span></header>
        ${p.pay.length ? `<ul class="items">${p.pay.map(payItem).join('')}</ul>` : '<p class="none">Nada por pagar todavía.</p>'}</div>
      <div class="cube reserve"><header><span class="sq"></span><h3>Reservar</h3><span class="tot">${M(p.reserveTotal)}</span></header>
        ${p.reserve.length ? `<ul class="items">${p.reserve.map(reserveItem).join('')}</ul>` : '<p class="none">Nada nuevo por apartar.</p>'}</div>
      <div class="cube keep"><header><span class="sq"></span><h3>Conservar</h3><span class="tot">${M(p.keep)}</span></header>
        ${keepRows.join('')}</div>
    </section>`;
  }

  function alerts(p) {
    const out = [];
    if (!Store.ok) out.push('<div class="alert k-pay"><p>Este navegador no está guardando datos. Lo que registres se perderá al cerrar: copia un respaldo desde Configuración.</p></div>');
    if (p.free < 0) out.push(`<div class="alert k-pay"><p>Tienes ${T(-p.free)} más apartado que dinero real. Libera un apartado o corrige tu saldo en Movimientos.</p></div>`);
    for (const it of p.shorts) {
      let t = `<strong>${esc(it.o.name)}</strong>: faltan ${T(it.short)} para el ${dayLabel(it.o.due)}. `;
      t += it.lateDate ? `Con lo proyectado se completaría hacia el ${dayLabel(it.lateDate)}.` : 'Lo proyectado no alcanza a completarlo.';
      if (it.days <= state.settings.payDays && p.cushion > 0) t += ` Tu reserva de seguridad tiene ${T(p.cushion)}; usarla es decisión tuya.`;
      out.push(`<div class="alert k-pay"><p>${t}</p><button class="btn sm" type="button" data-act="ob-edit" data-ob="${esc(it.o.id)}">Ver obligación</button></div>`);
    }
    for (const r of p.releases) {
      out.push(`<div class="alert k-res"><p>Sugerencia: libera ${T(r.amount)} apartados para <strong>${esc(r.from.o.name)}</strong> y úsalos en <strong>${esc(r.for.o.name)}</strong>, que pesa más.</p>
        <button class="btn sm" type="button" data-act="move" data-kind="release" data-ob="${esc(r.from.o.id)}" data-amount="${r.amount}" data-key="r:release:${esc(r.from.o.id)}:${state.rev}">Liberar</button></div>`);
    }
    const acted = new Set([...p.pay, ...p.reserve].map(a => a.it));
    for (const it of p.items) {
      if (it.days > state.settings.payDays || it.short > 0 || acted.has(it) || it.future <= 0) continue;
      out.push(`<div class="alert info"><p><strong>${esc(it.o.name)}</strong> ${whenText(it.days).toLowerCase()} y depende de ${T(it.future)} que aún no llegan. Regístralos en cuanto entren.</p></div>`);
    }
    for (const f of p.overdueFuture) {
      out.push(`<div class="alert info"><p>¿Ya recibiste ${esc(f.concept || 'el ingreso confirmado')} (${T(f.amount)})? Estaba previsto para el ${dayLabel(f.date)} y ya no se proyecta.</p>
        <button class="btn sm" type="button" data-act="fut-received" data-fid="${esc(f.id)}">Sí, registrarlo</button></div>`);
    }
    return out.length ? `<section class="alerts"><p class="label">Avisos</p>${out.join('')}</section>` : '';
  }

  /* ---------- Paneles ---------- */

  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  const head = (title, back) => `<div class="sh-top">${back ? `<button class="icon" type="button" data-act="back" aria-label="Volver">${ICON_BACK}</button>` : ''}
    <h2>${title}</h2><button class="icon" type="button" data-act="close" aria-label="Cerrar">${ICON_X}</button></div>`;
  const moneyField = (id, label, cents, opt) => `<label class="field"><span>${label}</span>
    <span class="money"><input type="text" inputmode="decimal" autocomplete="off" id="${id}" name="${id}" value="${cents == null ? '' : Core.moneyInput(cents)}" placeholder="0.00"${opt && opt.readonly ? ' readonly' : ''}></span>
    ${opt && opt.help ? `<small>${opt.help}</small>` : ''}</label>`;

  function openSheet(name, params) {
    cur = { name, params: params || {} };
    drawSheet();
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
    const first = $('[data-focus]', sheet);
    if (first) { first.focus(); if (first.select) first.select(); }
  }
  function drawSheet() {
    if (!cur) return;
    const keep = toastEl.parentNode === sheet && !toastEl.hidden;
    sheet.innerHTML = `<div class="sh">${SHEETS[cur.name](cur.params)}</div>`;
    if (keep) sheet.appendChild(toastEl); else document.body.appendChild(toastEl);
  }
  function closeSheet() {
    document.body.appendChild(toastEl);
    if (sheet.open) sheet.close();
    cur = null; sheet.innerHTML = '';
  }
  sheet.addEventListener('close', () => { if (!sheet.open) { document.body.appendChild(toastEl); cur = null; } });
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

  const SHEETS = {
    income() {
      return `${head('Registrar ingreso')}
        <form data-form="income" novalidate>
          <label class="field"><span>Cantidad recibida</span>
            <span class="money xl"><input type="text" inputmode="decimal" autocomplete="off" id="in-amount" name="amount" placeholder="0.00" data-focus></span></label>
          <label class="field"><span>Concepto (opcional)</span>
            <input type="text" id="in-concept" name="concept" maxlength="120" autocomplete="off" placeholder="Venta, pago de cliente, sueldo"></label>
          <p class="cap">Se guarda con la fecha y hora de este momento: ${stamp(new Date().toISOString())}.</p>
          <p class="err" role="alert"></p>
          <button class="btn primary" type="submit">Guardar y ver recomendación</button>
        </form>`;
    },

    move(q) {
      const o = state.obligations.find(x => x.id === q.ob);
      if (!o) return `${head('Movimiento')}<p class="none">Esa obligación ya no existe.</p>`;
      const acc = Core.account(state, today()), b = acc.by.get(o.id), free = Math.max(0, acc.free);
      const title = { pay: 'Confirmar pago', reserve: 'Confirmar apartado', release: 'Liberar apartado' }[q.kind];
      const cta = { pay: 'Ya pagué, registrar', reserve: 'Apartar este dinero', release: 'Liberar este dinero' }[q.kind];
      let def = q.amount, info = '', fixed = false;
      if (q.kind === 'pay') {
        fixed = !o.partial;
        if (def == null) def = o.partial ? Math.min(b.pending, free + b.reserved) : b.pending;
        info = `Pendiente ${T(b.pending)} · apartado ${T(b.reserved)} · disponible ${T(free)}.` +
          (fixed ? ' No admite pagos parciales.' : o.min ? (Core.minRemaining(o, b) ? ` Mínimo ${T(Core.minRemaining(o, b))}.` : ' Mínimo de este vencimiento ya cubierto.') : '') +
          ' Primero se usa lo apartado y el resto sale de tu disponible.';
      } else if (q.kind === 'reserve') {
        if (def == null) def = Math.min(Math.max(0, b.pending - b.reserved), free);
        info = `Faltan ${T(Math.max(0, b.pending - b.reserved))} por apartar · disponible ${T(free)}. El dinero sigue en tu mano, pero deja de contar como disponible.`;
      } else {
        if (def == null) def = b.reserved;
        info = `Apartado ${T(b.reserved)}. Al liberarlo vuelve a tu disponible.`;
      }
      return `${head(title, !!q.back)}
        <form data-form="move" novalidate>
          <p class="headline">${esc(o.name)}</p>
          ${q.kind === 'pay' && o.dest ? `<p class="cap">Destino: ${esc(o.dest)}</p>` : ''}
          ${moneyField('mv-amount', 'Cantidad', def, { readonly: fixed })}
          <p class="cap">${info}</p>
          <p class="err" role="alert"></p>
          <button class="btn primary" type="submit">${cta}</button>
        </form>`;
    },

    config(q) {
      const tab = q.tab || 'ob';
      const tabs = [['ob', 'Obligaciones'], ['in', 'Ingresos'], ['aj', 'Ajustes']].map(t =>
        `<button type="button" role="tab" aria-selected="${t[0] === tab}" data-act="tab" data-tab="${t[0]}">${t[1]}</button>`).join('');
      return `${head('Configuración')}<div class="tabs" role="tablist">${tabs}</div>${{ ob: cfgOb, in: cfgIn, aj: cfgAj }[tab]()}`;
    },

    ob(q) {
      const o = q.id ? state.obligations.find(x => x.id === q.id) : null;
      if (q.id && !o) return `${head('Obligación', true)}<p class="none">Esa obligación ya no existe.</p>`;
      const b = o ? Core.account(state, today()).by.get(o.id) : null;
      const sev = o ? o.sev : 'alta', prio = o ? o.prio : 3;
      const opt = (v, t, sel) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`;
      return `${head(o ? 'Editar obligación' : 'Nueva obligación', true)}
        <form data-form="ob" novalidate>
          <label class="field"><span>Nombre</span><input type="text" id="ob-name" name="name" maxlength="80" autocomplete="off" value="${esc(o ? o.name : '')}" placeholder="Renta, luz, tarjeta"${o ? '' : ' data-focus'}></label>
          <div class="two">
            ${moneyField('ob-amount', 'Monto total', o ? o.amount : null)}
            ${moneyField('ob-pending', 'Pendiente', b ? b.pending : null, { help: 'Vacío = todo el monto' })}
          </div>
          <label class="field"><span>Vence el</span><input type="date" id="ob-due" name="due" value="${o ? o.due : Core.addDays(today(), 7)}"></label>
          <label class="field"><span>Si no pagas a tiempo</span><select id="ob-sev" name="sev">
            ${opt('critica', 'Crítica: corte, desalojo, embargo', sev)}${opt('alta', 'Alta: recargos fuertes, historial', sev)}
            ${opt('media', 'Media: recargo menor', sev)}${opt('baja', 'Baja: se puede negociar', sev)}</select>
            <small>Pesa más que la prioridad manual.</small></label>
          <div class="two">
            <label class="field"><span>Prioridad manual</span><select id="ob-prio" name="prio">
              ${[1, 2, 3, 4, 5].map(n => opt(String(n), n === 1 ? '1 · primero' : n === 5 ? '5 · al final' : String(n), String(prio))).join('')}</select></label>
            <label class="field"><span>Estado</span><select id="ob-status" name="status">
              ${opt('activa', 'Activa', o ? o.status : 'activa')}${opt('pausa', 'En pausa', o ? o.status : 'activa')}</select></label>
          </div>
          <label class="check"><input type="checkbox" id="ob-partial" name="partial"${o && o.partial ? ' checked' : ''}> Permite pagos parciales</label>
          <div id="ob-min-wrap"${o && o.partial ? '' : ' hidden'}>${moneyField('ob-min', 'Pago mínimo', o && o.min ? o.min : null, { help: 'Lo que evita el recargo. Vacío si no hay mínimo.' })}</div>
          <label class="field"><span>Destino del pago</span><input type="text" id="ob-dest" name="dest" maxlength="120" autocomplete="off" value="${esc(o ? o.dest : '')}" placeholder="Cuenta, tienda o persona"></label>
          <p class="err" role="alert"></p>
          <button class="btn primary" type="submit">Guardar</button>
        </form>
        ${o ? `<p class="sub">Movimientos manuales</p>
          <p class="cap">Pagado ${T(o.amount - b.pending)} de ${T(o.amount)} · apartado ${T(b.reserved)}.</p>
          <div class="list"><div class="acts">
            ${b.pending > 0 ? `<button class="btn sm" type="button" data-act="move" data-kind="pay" data-ob="${esc(o.id)}" data-back="1">Registrar pago</button>
            <button class="btn sm" type="button" data-act="move" data-kind="reserve" data-ob="${esc(o.id)}" data-back="1">Apartar</button>` : ''}
            ${b.reserved > 0 ? `<button class="btn sm" type="button" data-act="move" data-kind="release" data-ob="${esc(o.id)}" data-back="1">Liberar</button>` : ''}
            <button class="btn sm danger" type="button" data-act="ob-delete" data-ob="${esc(o.id)}">Eliminar</button>
          </div></div>` : ''}`;
    },

    history() {
      const acc = Core.account(state, today());
      const rows = state.ledger.slice().reverse().map(e => {
        const off = acc.voided.has(e.id);
        let t = '', a = '', cls = '';
        if (e.type === 'income') { t = 'Ingreso' + (e.concept ? ' · ' + esc(e.concept) : ''); a = '+' + T(e.amount); cls = 'plus'; }
        else if (e.type === 'payment') { t = 'Pago · ' + esc(e.label || ''); a = '−' + T(e.amount); cls = 'minus'; }
        else if (e.type === 'reserve') { t = 'Apartado · ' + esc(e.label || ''); a = T(e.amount); }
        else if (e.type === 'release') { t = 'Liberado · ' + esc(e.label || ''); a = T(e.amount); }
        else if (e.type === 'void') { t = 'Anulación' + (e.label ? ' · ' + esc(e.label) : ''); }
        else { t = esc(e.concept || 'Ajuste'); a = (e.amount < 0 ? '' : '+') + T(e.amount); cls = e.amount < 0 ? 'minus' : 'plus'; }
        const extra = e.type === 'payment' && e.fromReserve ? ` · ${T(e.fromReserve)} de lo apartado` : e.auto ? ' · automático' : '';
        const can = !off && e.type !== 'void' && e.type !== 'release';
        return `<li class="${off ? 'off' : ''}"><span class="t">${t}${off ? '<span class="chip">Anulado</span>' : ''}</span>
          <span class="a ${off ? '' : cls}">${a}</span><span class="s">${stamp(e.ts)}${extra}</span>
          ${can ? `<span class="acts"><button class="link" type="button" data-act="void" data-ref="${esc(e.id)}">Anular</button></span>` : ''}</li>`;
      }).join('');
      return `${head('Movimientos')}
        <p class="cap">Total en mano ${T(acc.cash)} · reservado ${T(acc.reservedTotal)} · disponible ${T(acc.free)}. Nada se borra: anular agrega un movimiento que cancela al original.</p>
        <details><summary>Mi dinero real no coincide</summary>
          <form data-form="adjust" novalidate>
            ${moneyField('adj-target', 'Dinero que tienes en realidad', acc.cash, { help: 'Se registra la diferencia como corrección, por ejemplo por gastos fuera de la app.' })}
            <p class="err" role="alert"></p>
            <button class="btn" type="submit">Corregir saldo</button>
          </form></details>
        ${rows ? `<ul class="list">${rows}</ul>` : '<p class="none">Aún no hay movimientos.</p>'}`;
    },

    backup() {
      return `${head('Respaldo', true)}
        <div class="stack">
          <p class="cap">Tus datos viven solo en este navegador. Guarda este texto en un lugar seguro para pasarlos a otro teléfono o recuperarlos.</p>
          <textarea id="bk-out" readonly aria-label="Respaldo">${esc(JSON.stringify(state))}</textarea>
          <div class="list"><div class="acts">
            <button class="btn sm" type="button" data-act="bk-copy">Copiar respaldo</button>
            ${HOSTED ? '<button class="btn sm" type="button" data-act="bk-download">Descargar archivo</button>' : ''}
          </div></div>
          <p class="sub">Restaurar</p>
          <label class="field"><span>Elige un archivo de respaldo</span><input type="file" id="bk-file" accept=".json,application/json,text/plain"></label>
          <label class="field"><span>o pega aquí el texto</span><textarea id="bk-in" spellcheck="false" autocomplete="off"></textarea></label>
          <p class="err" role="alert"></p>
          <button class="btn danger" type="button" data-act="bk-restore">Reemplazar mis datos con este respaldo</button>
        </div>`;
    },
  };

  function cfgOb() {
    const acc = Core.account(state, today()), day = today();
    const rows = state.obligations.slice().sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0)).map(o => {
      const b = acc.by.get(o.id), d = Core.diffDays(o.due, day);
      const chip = b.pending <= 0 ? '<span class="chip ok">Pagada</span>' : o.status === 'pausa' ? '<span class="chip">En pausa</span>' : d < 0 ? '<span class="chip hot">Vencida</span>' : '';
      return `<li><button class="rowb" type="button" data-act="ob-edit" data-ob="${esc(o.id)}">
        <span class="t">${esc(o.name)}${chip}</span>
        <span class="a">${T(b.pending)}${b.reserved > 0 ? `<small>apartado ${T(b.reserved)}</small>` : ''}</span>
        <span class="s">${dayLabel(o.due)} · ${Core.SEV_LABEL[o.sev]} · prioridad ${o.prio}${o.partial ? ' · parciales' : ''}</span></button></li>`;
    }).join('');
    return `${rows ? `<ul class="list">${rows}</ul>` : '<p class="none">Sin obligaciones todavía.</p>'}
      <button class="btn primary" type="button" data-act="ob-new">Nueva obligación</button>`;
  }

  function cfgIn() {
    const acc = Core.account(state, today()), S = state.settings;
    const fut = state.future.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map(f => `<li>
      <span class="t">${esc(f.concept || 'Ingreso confirmado')}${f.received ? '<span class="chip ok">Recibido</span>' : ''}</span>
      <span class="a">${T(f.amount)}</span><span class="s">${dayLabel(f.date)}</span>
      ${f.received ? '' : `<span class="acts"><button class="link" type="button" data-act="fut-received" data-fid="${esc(f.id)}">Ya lo recibí</button>
        <button class="link" type="button" data-act="fut-delete" data-fid="${esc(f.id)}">Quitar</button></span>`}</li>`).join('');
    return `<form data-form="settings" novalidate>
        ${moneyField('st-opening', 'Saldo inicial', acc.opening, { help: 'El dinero real con el que empiezas.' })}
        ${moneyField('st-safety', 'Reserva mínima de seguridad', S.safety, { help: 'Nunca se recomienda repartirla.' })}
        ${moneyField('st-daily', 'Ingreso diario estimado', S.daily, { help: 'Solo sirve para proyectar. No cuenta como saldo hasta que lo registres.' })}
        <p class="err" role="alert"></p>
        <button class="btn primary" type="submit">Guardar</button>
      </form>
      <p class="sub">Ingresos futuros confirmados</p>
      ${fut ? `<ul class="list">${fut}</ul>` : '<p class="cap">Dinero que ya sabes que llegará en una fecha concreta.</p>'}
      <form data-form="future" novalidate>
        <label class="field"><span>Concepto</span><input type="text" id="fu-concept" name="concept" maxlength="80" autocomplete="off" placeholder="Cobro, sueldo, depósito"></label>
        <div class="two">${moneyField('fu-amount', 'Cantidad', null)}
          <label class="field"><span>Llega el</span><input type="date" id="fu-date" name="date" value="${Core.addDays(today(), 1)}"></label></div>
        <p class="err" role="alert"></p>
        <button class="btn" type="submit">Agregar ingreso futuro</button>
      </form>`;
  }

  function cfgAj() {
    const S = state.settings;
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { zones = []; }
    if (!zones.includes(S.tz)) zones.unshift(S.tz);
    return `<form data-form="rules" novalidate>
        <div class="two">
          <label class="field"><span>Pagar si faltan</span><input type="number" inputmode="numeric" id="st-pay" name="payDays" min="0" max="30" value="${S.payDays}"><small>días o menos</small></label>
          <label class="field"><span>Apartar si faltan</span><input type="number" inputmode="numeric" id="st-hor" name="horizon" min="0" max="365" value="${S.horizon}"><small>días o menos</small></label>
        </div>
        <label class="field"><span>Zona horaria</span><select id="st-tz" name="tz">${zones.map(z => `<option${z === S.tz ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select>
          <small>Define cuándo cambia el día para vencimientos y proyecciones.</small></label>
        <p class="err" role="alert"></p>
        <button class="btn primary" type="submit">Guardar</button>
      </form>
      <details><summary>Cómo decide QUBO</summary><ol class="rules">
        <li>Solo reparte dinero real: lo que tienes en mano, menos lo apartado, menos tu reserva de seguridad.</li>
        <li>Ordena por la consecuencia del impago, luego por tu prioridad manual y luego por fecha.</li>
        <li>Proyecta día por día tu ingreso diario y tus ingresos confirmados hasta cada vencimiento. Lo que ese futuro no alcanza a cubrir se aparta desde hoy.</li>
        <li>Si algo no se puede cubrir a tiempo de ninguna forma, primero salva lo que vence antes y sí alcanza; el resto lo aparta para eso.</li>
        <li>Lo que sobra se adelanta a los vencimientos cercanos y después a los saldos por encima del mínimo.</li>
        <li>Marca PAGAR cuando falta poco para vencer y alcanza el mínimo exigido; si no, RESERVAR.</li>
      </ol></details>
      <p class="sub">Datos</p>
      <div class="list"><div class="acts">
        <button class="btn sm" type="button" data-act="open-backup">Respaldo y restauración</button>
        <button class="btn sm danger" type="button" data-act="reset">Borrar todo</button>
      </div></div>`;
  }

  /* ---------- Avisos breves ---------- */

  function toast(msg, undo) {
    toastEl.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" data-act="undo">Deshacer</button>' : ''}`;
    undoFn = undo || null;
    (sheet.open ? sheet : document.body).appendChild(toastEl);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; undoFn = null; }, undo ? 7000 : 3200);
  }
  // Las acciones que destruyen piden un segundo toque (aquí no existen los diálogos del navegador).
  function armed(el) {
    if (el.dataset.armed) return true;
    el.dataset.armed = '1'; el.dataset.label = el.textContent; el.textContent = 'Toca otra vez para confirmar';
    setTimeout(() => { if (el.isConnected && el.dataset.armed) { delete el.dataset.armed; el.textContent = el.dataset.label; } }, 3500);
    return false;
  }
  const setErr = (form, msg) => { const e = $('.err', form); if (e) e.textContent = msg || ''; return false; };
  const cents = (form, name) => Core.parseMoney(form.elements[name].value);
  // Campo de dinero opcional: vacío vale el valor por omisión; inválido devuelve NaN.
  const centsOr = (form, name, fallback) => { const v = form.elements[name].value.trim(); if (!v) return fallback; const c = Core.parseMoney(v); return c == null ? NaN : c; };

  /* ---------- Acciones ---------- */

  const ACT = {
    'open-income'() { openSheet('income', { id: Core.uid() }); },
    'open-config'() { openSheet('config', { tab: 'ob' }); },
    'open-history'() { openSheet('history'); },
    'open-backup'() { openSheet('backup', { back: 'aj' }); },
    'tab'(el) { cur.params.tab = el.dataset.tab; drawSheet(); },
    'close'() { closeSheet(); },
    'back'() {
      if (cur.name === 'move' && cur.params.back) return openSheet('ob', { id: cur.params.ob, entry: Core.uid() });
      openSheet('config', { tab: cur.params.back || 'ob' });
    },
    'refresh'() {
      state = Core.normalize(Store.read()) || state;
      render(); window.scrollTo({ top: 0, behavior: 'smooth' });
      toast(`Estado actualizado · ${clock()}`);
    },
    'move'(el) {
      openSheet('move', { kind: el.dataset.kind, ob: el.dataset.ob, id: el.dataset.key || Core.uid(),
        amount: el.dataset.amount ? Number(el.dataset.amount) : null, back: el.dataset.back || '' });
    },
    'ob-new'() { openSheet('ob', { id: null, newId: Core.uid(), entry: Core.uid() }); },
    'ob-edit'(el) { openSheet('ob', { id: el.dataset.ob, entry: Core.uid() }); },
    'ob-delete'(el) {
      if (!armed(el)) return;
      const res = commit((s, day, ts) => Core.ops.deleteObligation(s, { id: Core.uid(), ob: el.dataset.ob, ts }, day));
      openSheet('config', { tab: 'ob' });
      toast(res.ok ? 'Obligación eliminada' : res.msg);
    },
    'fut-received'(el) {
      const fid = el.dataset.fid;
      const res = commit((s, day, ts) => Core.ops.receiveFuture(s, { fid, ts }));
      if (cur) drawSheet();
      toast(res.ok ? 'Ingreso registrado en tu saldo' : res.msg, res.ok ? () => { undoEntry(res.id); if (cur) drawSheet(); } : null);
    },
    'fut-delete'(el) {
      if (!armed(el)) return;
      const res = commit(s => Core.ops.deleteFuture(s, { fid: el.dataset.fid }));
      drawSheet(); if (!res.ok) toast(res.msg);
    },
    'void'(el) {
      if (!armed(el)) return;
      const res = undoEntry(el.dataset.ref);
      drawSheet(); toast(res.ok ? 'Movimiento anulado' : res.msg);
    },
    'undo'() { const fn = undoFn; undoFn = null; toastEl.hidden = true; if (fn) { fn(); toast('Deshecho'); } },
    'demo-clear'(el) {
      if (!armed(el)) return;
      Store.write(Object.assign(Core.blank(state.settings.tz), { rev: state.rev + 1 }));
      state = Core.normalize(Store.read()); render();
      openSheet('config', { tab: 'in' });
    },
    'reset'(el) {
      if (!armed(el)) return;
      Store.write(Object.assign(Core.blank(state.settings.tz), { rev: state.rev + 1 }));
      state = Core.normalize(Store.read()); render(); closeSheet(); toast('Datos borrados');
    },
    'bk-copy'() {
      const ta = $('#bk-out', sheet);
      const fallback = () => { ta.focus(); ta.select(); toast('Texto seleccionado: cópialo con el menú del teléfono'); };
      try { navigator.clipboard.writeText(ta.value).then(() => toast('Respaldo copiado'), fallback); } catch (e) { fallback(); }
    },
    /*SOLO-HOSTINGER*/
    'bk-download'() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: 'application/json' }));
      a.download = `qubo-respaldo-${today()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    /*FIN-SOLO-HOSTINGER*/
    'bk-restore'(el) {
      const box = el.closest('.stack');
      let parsed = null;
      try { parsed = Core.normalize(JSON.parse($('#bk-in', sheet).value)); } catch (e) { parsed = null; }
      if (!parsed) return setErr(box, 'Ese texto no es un respaldo válido de QUBO.');
      setErr(box, '');
      if (!armed(el)) return;
      parsed.rev = Math.max(parsed.rev, state.rev) + 1;
      Store.write(parsed); state = Core.normalize(Store.read()) || parsed;
      render(); closeSheet(); toast('Respaldo restaurado');
    },
  };

  const FORMS = {
    income(f) {
      const amount = cents(f, 'amount');
      if (amount == null || amount <= 0) return setErr(f, 'Escribe la cantidad, por ejemplo 1250.50');
      const id = cur.params.id;
      flash = amount;
      const res = commit((s, day, ts) => Core.ops.income(s, { id, amount, concept: f.elements.concept.value, ts }));
      if (!res.ok && !res.dup) { flash = null; return setErr(f, res.msg); }
      closeSheet();
      if (res.ok) toast(`Ingreso de ${T(amount)} guardado`, () => undoEntry(id));
      const el = $('#plan'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    move(f) {
      const q = cur.params, amount = cents(f, 'mv-amount');
      if (amount == null || amount <= 0) return setErr(f, 'Escribe una cantidad mayor a cero.');
      const res = commit((s, day, ts) => Core.ops[q.kind](s, { id: q.id, ob: q.ob, amount, ts }, day));
      if (!res.ok && !res.dup) return setErr(f, res.msg);
      if (q.back) openSheet('ob', { id: q.ob, entry: Core.uid() }); else closeSheet();
      const done = { pay: 'Pago registrado', reserve: 'Dinero apartado', release: 'Apartado liberado' }[q.kind];
      if (res.ok) toast(`${done}: ${T(amount)}`, q.kind === 'release' ? null : () => { undoEntry(q.id); if (cur) drawSheet(); });
    },
    ob(f) {
      const q = cur.params, E = f.elements;
      // Si no tocaste "Pendiente" al editar, se recalcula a partir del monto y de lo ya pagado.
      const pEl = E['ob-pending'], untouched = q.id && pEl.value === pEl.defaultValue;
      const amount = cents(f, 'ob-amount'), pending = untouched ? null : centsOr(f, 'ob-pending', null), min = centsOr(f, 'ob-min', 0);
      if (amount == null) return setErr(f, 'Escribe el monto total.');
      if (Number.isNaN(pending) || Number.isNaN(min)) return setErr(f, 'Revisa los montos: usa números como 1250.50');
      const res = commit((s, day, ts) => Core.ops.saveObligation(s, {
        id: q.id, newId: q.newId, entry: q.entry, ts, name: E.name.value, amount, pending, due: E.due.value, sev: E.sev.value,
        prio: Number(E.prio.value), partial: E.partial.checked, min, dest: E.dest.value, status: E.status.value }, day));
      if (!res.ok && !res.dup) return setErr(f, res.msg);
      openSheet('config', { tab: 'ob' }); toast('Obligación guardada');
    },
    settings(f) {
      const S = state.settings, opening = cents(f, 'st-opening'), safety = cents(f, 'st-safety'), daily = cents(f, 'st-daily');
      if (opening == null || safety == null || daily == null) return setErr(f, 'Revisa los montos: usa números como 1250.50 (cero si no aplica).');
      const res = commit((s, day, ts) => Core.ops.saveSettings(s, { id: Core.uid(), ts, opening, safety, daily, payDays: S.payDays, horizon: S.horizon, tz: S.tz }, day));
      if (!res.ok) return setErr(f, res.msg);
      drawSheet(); toast('Guardado');
    },
    rules(f) {
      const E = f.elements, S = state.settings, opening = Core.account(state, today()).opening;
      const res = commit((s, day, ts) => Core.ops.saveSettings(s, { id: Core.uid(), ts, opening, safety: S.safety, daily: S.daily,
        payDays: Number(E.payDays.value), horizon: Number(E.horizon.value), tz: E.tz.value }, day));
      if (!res.ok) return setErr(f, res.msg);
      drawSheet(); toast('Guardado');
    },
    future(f) {
      const amount = cents(f, 'fu-amount');
      if (amount == null || amount <= 0) return setErr(f, 'Escribe la cantidad.');
      const res = commit((s, day) => Core.ops.addFuture(s, { id: Core.uid(), amount, date: f.elements.date.value, concept: f.elements.concept.value }, day));
      if (!res.ok) return setErr(f, res.msg);
      drawSheet(); toast('Ingreso futuro agregado');
    },
    adjust(f) {
      const target = cents(f, 'adj-target');
      if (target == null) return setErr(f, 'Escribe cuánto dinero tienes en realidad.');
      const res = commit((s, day, ts) => Core.ops.adjustCash(s, { id: Core.uid(), target, ts }, day));
      if (!res.ok) return setErr(f, res.msg);
      drawSheet(); toast('Saldo corregido');
    },
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el);
  });
  document.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target, h = FORMS[f.dataset.form];
    if (!h || f.dataset.busy) return;
    f.dataset.busy = '1';                       // un envío a la vez: el doble toque no pasa de aquí
    try { h(f); } finally { delete f.dataset.busy; }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'ob-partial') $('#ob-min-wrap', sheet).hidden = !e.target.checked;
    if (e.target.id === 'bk-file' && e.target.files[0]) {
      const r = new FileReader();
      r.onload = () => { const ta = $('#bk-in', sheet); if (ta) ta.value = String(r.result || ''); };
      r.readAsText(e.target.files[0]);
    }
  });

  /* ---------- Mantenerse al día ---------- */

  const resync = () => { state = Core.normalize(Store.read()) || state; render(); };
  Store.onExternalChange(() => { resync(); if (cur && (cur.name === 'config' || cur.name === 'history')) drawSheet(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !cur) resync(); });
  // Al cambiar el día en tu zona horaria, vencimientos y proyecciones se recalculan solos.
  setInterval(() => { if (lastPlan && today() !== lastPlan.today && !cur) render(); }, 30000);

  if (HOSTED && 'serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  render();
})();
