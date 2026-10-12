// Recorrido de humo por la interfaz (requiere Playwright). node test/ui.smoke.js <carpeta-capturas>
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path'), assert = require('assert');
const out = process.argv[2] || '.';
(async () => {
  const browser = await chromium.launch({ executablePath: undefined });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'America/Mexico_City', locale: 'es-MX' });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('file://' + path.resolve(__dirname, '../dist/hostinger/index.html'));
  const txt = sel => page.locator(sel).first().innerText();
  const noOverflow = async tag => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'desborde horizontal: ' + tag);
  const shot = async (name, full) => { await page.waitForTimeout(350); return page.screenshot({ path: path.join(out, name + '.png'), fullPage: !!full }); };

  assert.strictEqual(await txt('.big'), '$3,200.00');
  await noOverflow('inicio'); await shot('1-inicio', true);

  // Registrar ingreso → recomendación inmediata
  await page.click('[data-act="open-income"]');
  await page.fill('#in-amount', '1,500.50'); await page.fill('#in-concept', 'Venta del día');
  await shot('2-ingreso');
  await page.click('#sheet button[type="submit"]');
  assert.strictEqual(await txt('.big'), '$4,700.50');
  assert.ok((await txt('.note')).includes('$1,500.50'));
  await page.waitForTimeout(400); await shot('3-tras-ingreso', true);

  // Confirmar pago de Luz
  await page.click('.cube.pay [data-act="move"]');
  await shot('4-confirmar-pago');
  await page.click('#sheet button[type="submit"]');
  assert.strictEqual(await txt('.pair dd'), '$0.00');
  assert.strictEqual(await page.locator('.pair dd').nth(1).innerText(), '$3,920.50');
  // Confirmar apartado de Renta
  await page.click('.cube.reserve [data-act="move"]');
  await page.click('#sheet button[type="submit"]');
  const reserved = await txt('.pair dd');
  assert.notStrictEqual(reserved, '$0.00');
  assert.strictEqual(await page.locator('.pair dd').nth(1).innerText(), '$3,920.50');   // apartar no mueve el total en mano
  // Deshacer el apartado desde el aviso
  await page.click('#toast [data-act="undo"]');
  assert.strictEqual(await txt('.pair dd'), '$0.00');
  await page.click('.cube.reserve [data-act="move"]'); await page.click('#sheet button[type="submit"]');
  await noOverflow('reparto'); await page.waitForTimeout(300); await shot('5-tras-confirmar', true);

  // Persistencia: recargar conserva todo
  const before = await page.locator('#view').innerText();
  await page.reload();
  assert.strictEqual(await page.locator('#view').innerText(), before);

  // Movimientos
  await page.click('[data-act="open-history"]');
  assert.strictEqual(await page.locator('#sheet .list li').count(), 6);   // inicial, ingreso, pago, apartado, anulación, apartado
  await shot('6-movimientos');
  await page.click('#sheet [data-act="close"]');

  // Configuración: obligaciones, edición, ingresos, ajustes
  await page.click('[data-act="open-config"]'); await shot('7-config-obligaciones');
  await page.click('#sheet [data-act="ob-edit"] >> nth=1'); await shot('8-editar-obligacion', false);
  await page.click('#sheet [data-act="back"]');
  await page.click('#sheet [data-tab="in"]'); await shot('9-config-ingresos');
  await page.fill('#st-daily', '1200'); await page.click('#sheet form[data-form="settings"] button[type="submit"]');
  await page.fill('#fu-amount', '2500'); await page.fill('#fu-concept', 'Depósito'); await page.click('#sheet form[data-form="future"] button[type="submit"]');
  assert.strictEqual(await page.locator('#sheet .list li').count(), 2);
  await page.click('#sheet [data-tab="aj"]'); await shot('10-config-ajustes');
  await page.click('#sheet [data-act="open-backup"]');
  assert.ok((await page.inputValue('#bk-out')).startsWith('{"app":"qubo"'));
  await page.click('#sheet [data-act="close"]');

  // Nueva obligación con error de validación y luego correcta
  await page.click('[data-act="open-config"]'); await page.click('#sheet [data-act="ob-new"]');
  await page.click('#sheet form[data-form="ob"] button[type="submit"]');
  assert.ok((await txt('#sheet .err')).length > 0);
  await page.fill('#ob-name', 'Agua'); await page.fill('#ob-amount', '240'); 
  await page.click('#sheet form[data-form="ob"] button[type="submit"]');
  assert.strictEqual(await page.locator('#sheet .list li').count(), 6);
  await page.click('#sheet [data-act="close"]');
  await noOverflow('final');

  // Tema oscuro y pantalla angosta
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 360, height: 780 });
  await noOverflow('360'); await shot('11-oscuro', true);
  await page.setViewportSize({ width: 320, height: 640 }); await noOverflow('320');

  // Empezar con datos propios
  await page.click('[data-act="demo-clear"]'); await page.click('[data-act="demo-clear"]');
  await page.click('#sheet [data-act="close"]');
  assert.strictEqual(await txt('.big'), '$0.00');
  await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 390, height: 844 }); await shot('12-vacio', true);

  assert.deepStrictEqual(errors, []);
  console.log('recorrido de interfaz correcto');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
