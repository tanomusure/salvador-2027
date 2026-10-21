// Busca pasajes Córdoba → Salvador en Kiwi, eDreams y Aerolíneas (en USD) y manda mail si alguno cumple el tope.
// Corre solo en GitHub Actions cada 6 horas. Estado y historial quedan en este repo.
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'fs';
import { execFileSync } from 'child_process';

const CFG = {
  // Viajes [ida, vuelta]: dos semanas laborales más los findes, en Carnaval (29/01 al 10/02)
  viajes: [
    ['2027-01-30', '2027-02-13'], ['2027-01-30', '2027-02-14'],
    ['2027-02-01', '2027-02-13'], ['2027-02-01', '2027-02-14'],
    ['2027-02-06', '2027-02-19'], ['2027-02-06', '2027-02-20'], ['2027-02-06', '2027-02-21'],
  ],
  pasajeros: 6,
  topeUsdPorPersona: 650,
  maxIdaHoras: 16, // se aceptan escalas largas
  maxVueltaHoras: 24,
  costoCordobaBaires: 228, // avión Córdoba-Aeroparque ida y vuelta (Aerolíneas Plus con carry on, en USD), para comparar lo que sale de Aeroparque
  avisarDesdeBaires: false, // no quieren ir a Buenos Aires: lo que sale de Aeroparque se ve en la app pero no avisa
  ultimoDiaDeBusqueda: '2027-01-25',
  mailTo: process.env.MAIL_TO,
};

const kiwiUrl = (ida, vta) => `https://www.kiwi.com/en/search/results/cordoba-cordoba-argentina/salvador-state-of-bahia-brazil/${ida}/${vta}/?sortBy=price&adults=${CFG.pasajeros}&children=0&infants=0&bags=${Array(CFG.pasajeros).fill('1.0').join('_')}-`;
// Los casilleros de fecha de eDreams muestran un día menos, pero la búsqueda es la correcta
const edreamsUrl = (ida, vta) => `https://www.edreams.com/travel/#results/type=R;from=COR;to=SSA;dep=${ida};ret=${vta};buyPath=36;adults=${CFG.pasajeros};children=0;infants=0;internalSearch=true`;
// La versión es-uy de Aerolíneas cobra en USD (la de Argentina cobra en pesos)
const d8 = f => f.replaceAll('-', '');
const aerolineasUrl = (ida, vta) => `https://www.aerolineas.com.ar/es-uy/flights-offers?adt=${CFG.pasajeros}&inf=0&chd=0&flexDates=false&cabinClass=Economy&flightType=ROUND_TRIP&leg=COR-SSA-${d8(ida)}&leg=SSA-COR-${d8(vta)}&redirectFrom=AR`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// SALIDA=turismocity: la corrida local de la Mac (Turismocity frena a GitHub con Cloudflare) escribe sus propios archivos
const SALIDA = process.env.SALIDA || '';
const SUF = SALIDA ? `-${SALIDA}` : '';
const ESTADO = new URL(`./estado${SUF}.json`, import.meta.url);
const HISTORIAL = new URL(`./historial${SUF}.csv`, import.meta.url);
const DATOS_APP = new URL(`./docs/datos${SUF}.json`, import.meta.url);
const REPO = process.env.GITHUB_REPOSITORY || 'tanomusure/salvador-2027';

const hhmm = min => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
const hoyAR = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 16);

async function nuevoContexto(browser) {
  return browser.newContext({ locale: 'en-US', timezoneId: 'America/Argentina/Cordoba', userAgent: UA, viewport: { width: 1280, height: 900 } });
}

async function buscarKiwi(browser, ida, vta) {
  const ctx = await nuevoContexto(browser);
  const page = await ctx.newPage();
  // Pedimos los precios en USD (Kiwi cobra en la moneda elegida) y más resultados por página
  await page.route('**/umbrella/v2/graphql?featureName=SearchReturnItinerariesQuery*', async route => {
    try {
      const body = JSON.parse(route.request().postData());
      body.variables.options.currency = 'usd';
      body.variables.filter.limit = 60;
      await route.continue({ postData: JSON.stringify(body) });
    } catch { await route.continue(); }
  });
  const vistos = new Map();
  page.on('response', async r => {
    if (!r.url().includes('SearchReturnItinerariesQuery')) return;
    try {
      const its = (await r.json())?.data?.returnItineraries?.itineraries || [];
      for (const it of its) vistos.set(it.id, it);
    } catch {}
  });
  await page.goto(kiwiUrl(ida, vta), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(30000);
  await ctx.close();

  return [...vistos.values()].filter(it => it.outbound && it.inbound).map(it => {
    const tramo = s => {
      const segs = s.sectorSegments.map(x => x.segment);
      return {
        min: s.duration / 60,
        sale: segs[0].source.localTime.slice(0, 16).replace('T', ' '),
        llega: segs.at(-1).destination.localTime.slice(0, 16).replace('T', ' '),
        escalas: segs.slice(0, -1).map(x => x.destination.station.code),
        cambioAeropuerto: segs.some((x, i) => i > 0 && x.source.station.code !== segs[i - 1].destination.station.code),
        aerolineas: [...new Set(segs.map(x => x.carrier.name))],
      };
    };
    const url = it.bookingOptions?.edges?.[0]?.node?.bookingUrl;
    return {
      sitio: 'Kiwi',
      cobraEn: 'USD',
      usdPorPersona: Number(it.price.amount) / CFG.pasajeros,
      precioOriginal: `USD ${Math.round(Number(it.price.amount))} total`,
      carryOn: it.bagsInfo?.includedHandBags >= CFG.pasajeros,
      ida: tramo(it.outbound),
      vuelta: tramo(it.inbound),
      link: url ? `https://www.kiwi.com${url}` : kiwiUrl(ida, vta),
    };
  });
}

async function buscarEdreams(browser, ida, vta, eurUsd) {
  const ctx = await nuevoContexto(browser);
  const page = await ctx.newPage();
  let data = null;
  page.on('response', async r => {
    if (!r.url().includes('/frontend-api/service/graphql')) return;
    try { const j = await r.json(); if (j?.data?.searchItinerary?.itineraries) data = j.data.searchItinerary; } catch {}
  });
  await page.goto(edreamsUrl(ida, vta), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(30000);
  await ctx.close();
  if (!data) return [];

  const seg = Object.fromEntries(data.segments.map(s => [s.id, s.segment]));
  const sec = Object.fromEntries(data.sections.map(s => [s.id, s.section]));
  const loc = Object.fromEntries(data.locations.map(l => [l.id, l.location]));
  const car = Object.fromEntries(data.carriers.map(c => [c.id, c.carrier]));
  const secId = x => (typeof x === 'object' ? x.id : x);

  return data.itineraries.map(it => {
    const tramo = l => {
      const s = seg[l.segmentId];
      const secs = s.sections.map(x => sec[secId(x)]);
      return {
        min: s.duration,
        sale: secs[0].departureDate.slice(0, 16).replace('T', ' '),
        llega: secs.at(-1).arrivalDate.slice(0, 16).replace('T', ' '),
        escalas: secs.slice(0, -1).map(x => loc[x.destinationId]?.iata),
        cambioAeropuerto: secs.some((x, i) => i > 0 && x.departureId !== secs[i - 1].destinationId),
        aerolineas: [...new Set(secs.map(x => car[x.carrierId]?.name || x.carrierId))],
        equipaje: s.baggageCondition,
      };
    };
    const [tIda, tVuelta] = it.legs.map(tramo);
    const fee = t => it.fees.find(f => f.type === t)?.price;
    const prime = fee('MEMBER_PRICE_POLICY_DISCOUNTED') || fee('MEMBER_PRICE_POLICY_UNDISCOUNTED');
    const normal = fee('MEMBER_PRICE_POLICY_UNDISCOUNTED') || prime;
    const aUsd = p => (p.currency === 'USD' ? p.amount : p.amount * eurUsd);
    return {
      sitio: 'eDreams (Prime)',
      cobraEn: prime.currency,
      usdPorPersona: aUsd(prime),
      precioOriginal: `€${prime.amount.toFixed(0)} c/u con Prime, €${normal.amount.toFixed(0)} sin Prime`,
      carryOn: [tIda, tVuelta].every(t => ['CABIN_INCLUDED', 'CHECKIN_INCLUDED'].includes(t.equipaje)),
      ida: tIda, vuelta: tVuelta,
      fechasOk: tIda.sale.startsWith(ida) && tVuelta.sale.startsWith(vta),
      link: edreamsUrl(ida, vta),
    };
  }).filter(o => o.fechasOk);
}

async function buscarAerolineas(browser, ida, vta) {
  const ctx = await nuevoContexto(browser);
  const page = await ctx.newPage();
  let data = null;
  page.on('response', async r => {
    if (!r.url().includes('/v1/flights/offers')) return;
    try { const j = await r.json(); if (j?.brandedOffers) data = j; } catch {}
  });
  await page.goto(aerolineasUrl(ida, vta), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(25000);
  await ctx.close();
  if (!data || data.searchMetadata?.currency !== 'USD') return [];

  // Tarifas que incluyen carry on según las reglas de la propia búsqueda (Base, Plus, Flex...)
  const conCarry = new Set(Object.entries(data.fareRules?.[0]?.brandConfigurations || {})
    .filter(([, c]) => c.fareOptionConfiguration?.CARRY_ON?.enabled).map(([id]) => id));
  const vuelos = n => (data.brandedOffers[n] || []).map(o => {
    const l = o.legs[0];
    return {
      tramo: {
        min: l.totalDuration,
        sale: l.segments[0].departure.slice(0, 16).replace('T', ' '),
        llega: l.segments.at(-1).arrival.slice(0, 16).replace('T', ' '),
        escalas: l.segments.slice(0, -1).map(s => s.destination),
        cambioAeropuerto: l.segments.some((x, i) => i > 0 && x.origin !== l.segments[i - 1].destination),
        aerolineas: [...new Set(l.segments.map(s => (s.operatingAirline === 'AR' ? 'Aerolíneas Argentinas' : s.operatingAirline)))],
      },
      ofertas: o.offers.filter(x => x.fare && conCarry.has(x.brand.id)),
    };
  });

  const opciones = [];
  for (const vIda of vuelos('0')) for (const vVta of vuelos('1')) {
    let mejor = null;
    for (const a of vIda.ofertas) for (const b of vVta.ofertas) {
      if (!(a.combinableOffers || []).includes(b.offerId) && !(b.combinableOffers || []).includes(a.offerId)) continue;
      const total = a.fare.total + b.fare.total;
      if (!mejor || total < mejor.total) mejor = { total, a, b };
    }
    if (!mejor) continue;
    opciones.push({
      sitio: 'Aerolíneas Argentinas',
      cobraEn: 'USD',
      usdPorPersona: mejor.total,
      precioOriginal: `USD ${mejor.a.fare.total} ida (${mejor.a.brand.name}) + USD ${mejor.b.fare.total} vuelta (${mejor.b.brand.name}) por persona, con tasas`,
      carryOn: true,
      ida: vIda.tramo,
      vuelta: vVta.tramo,
      link: aerolineasUrl(ida, vta),
    });
  }
  return opciones;
}

// Turismocity compara muchas webs. Sus resultados ya decodificados quedan en el store de la página (Pinia).
// Las webs de su lista "impuesto PAIS" cobran en pesos con impuestos: se marcan como ARS y no cuentan para el aviso.
const fechaTc = f => `${f.slice(8, 10)}-${f.slice(5, 7)}-${f.slice(0, 4)}`;
const turismocityUrl = (origen, ida, vta) => `https://www.turismocity.com.ar/vuelos/resultados-a-salvador_de_bahia-SSA?s=${origen}-SSA.${fechaTc(ida)}.SSA-${origen}.${fechaTc(vta)}&adults=${CFG.pasajeros}`;

let busquedasTurismocity = 0;
async function buscarTurismocity(browser, ida, vta, origen = 'COR') {
  // Pausa entre búsquedas: muchas seguidas hacen que Cloudflare pida verificación
  if (busquedasTurismocity++) await new Promise(r => setTimeout(r, 20000));
  const ctx = await nuevoContexto(browser);
  const page = await ctx.newPage();
  await page.goto(turismocityUrl(origen, ida, vta), { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Trae resultados de a tandas y algunas webs (FlightNetwork) llegan tarde: esperar que la cantidad
  // deje de cambiar, con un mínimo de 30 s y un máximo de 90 s
  let previo = -1, estables = 0;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const n = await page.evaluate(() => { const f = window.$nuxt?.$pinia?.state?.value?.flights; return f && !f.isLoading && f.metasready ? f.itinerariesFilteredLen : -1; }).catch(() => -1);
    estables = n > 0 && n === previo ? estables + 1 : 0;
    previo = n;
    if (i >= 15 && estables >= 3) break;
  }
  const crudo = await page.evaluate(() => {
    const st = window.$nuxt?.$pinia?.state?.value;
    if (!st?.flights?.itinerariesFiltered) return null;
    const conImpuesto = (st.index?.impuestoPaisProviders || []).map(s => s.toLowerCase());
    const dic = st.flights.dictionary?.airline || {};
    const url = b64 => { try { return atob(b64); } catch { return null; } };
    return st.flights.itinerariesFiltered.map(it => ({
      tramos: it.segments.map(s => ({
        min: s.duration,
        sale: s.flights[0].departureTime.slice(0, 16),
        llega: s.flights.at(-1).arrivalTime.slice(0, 16),
        escalas: s.flights.slice(0, -1).map(f => f.arrival),
        cambioAeropuerto: s.flights.some((f, i) => i > 0 && f.departure !== s.flights[i - 1].arrival),
        aerolineas: [...new Set(s.flights.map(f => dic[f.airline] || f.airline))],
        asientos: Math.min(...s.flights.map(f => f.availableSeats ?? 9)),
      })),
      ofertas: it.providers.map(p => ({
        web: p.providerName,
        enPesos: conImpuesto.includes((p.crawlerName || '').toLowerCase()) || conImpuesto.includes((p.providerName || '').toLowerCase()),
        moneda: p.price?.currency, valor: p.price?.value,
        carry: (p.cabinBaggageIncluded || []).flat().every(Boolean),
        link: url(p.base64),
      })),
    }));
  });
  if (!crudo?.length) {
    // Para diagnosticar bloqueos: qué mostró la página
    const diag = await page.evaluate(() => ({ url: location.href, titulo: document.title, texto: document.body?.innerText?.slice(0, 300) })).catch(e => ({ error: e.message }));
    console.log('Turismocity sin resultados', origen, ida, vta, JSON.stringify(diag));
  }
  await ctx.close();
  if (!crudo) return [];

  const opciones = [];
  for (const it of crudo) {
    if (it.tramos.length !== 2 || it.tramos.some(t => t.asientos < CFG.pasajeros)) continue;
    const validas = it.ofertas.filter(o => o.carry && o.valor && o.moneda === 'USD').sort((a, b) => a.valor - b.valor);
    // La mejor que cobra en dólares; si no hay, la mejor en pesos (se muestra, pero no avisa)
    const o = validas.find(x => !x.enPesos) || validas[0];
    if (!o) continue;
    const [tIda, tVta] = it.tramos;
    opciones.push({
      sitio: `${o.web} (vía Turismocity)`,
      cobraEn: o.enPesos ? 'ARS' : 'USD',
      origen,
      usdPorPersona: o.valor / CFG.pasajeros, // con adults=6 Turismocity da el total del grupo
      precioOriginal: `USD ${Math.round(o.valor)} los ${CFG.pasajeros} en ${o.web}${o.enPesos ? ', se paga en pesos con impuestos' : ''}${origen === 'BUE' ? '. Sale de Buenos Aires: no incluye ir y volver desde Córdoba' : ''}`,
      carryOn: true,
      ida: tIda, vuelta: tVta,
      link: o.link || turismocityUrl(origen, ida, vta),
    });
  }
  return opciones;
}

async function cotizacionEurUsd() {
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD');
    return (await r.json()).rates.USD;
  } catch { return 1.14; }
}

const costoTotal = o => o.usdPorPersona + (o.origen === 'BUE' ? CFG.costoCordobaBaires : 0);
// No quieren cambiar de aeropuerto en una escala (por ejemplo llegar a Ezeiza y salir de Aeroparque)
const cumpleHorarios = o => o.carryOn && !o.ida.cambioAeropuerto && !o.vuelta.cambioAeropuerto
  && o.ida.min <= CFG.maxIdaHoras * 60 && o.vuelta.min <= CFG.maxVueltaHoras * 60;
const maxEscalas = o => Math.max(o.ida.escalas.length, o.vuelta.escalas.length);
const clave = o => `${o.sitio}|${o.ida.sale}|${o.vuelta.sale}|${o.ida.aerolineas.join('+')}`;

function textoOpcion(o) {
  const t = (n, x) => `${n}: ${x.sale} → ${x.llega} (${hhmm(x.min)}, ${x.escalas.length ? `escala en ${x.escalas.join(', ')}` : 'directo'}) · ${x.aerolineas.join(' + ')}`;
  return [
    `${o.sitio}: USD ${Math.round(o.usdPorPersona)} por persona, USD ${Math.round(o.usdPorPersona * CFG.pasajeros)} los ${CFG.pasajeros}`,
    o.origen === 'BUE' ? `Sale de Buenos Aires: sumando USD ${CFG.costoCordobaBaires} de avión Córdoba-Aeroparque son USD ${Math.round(costoTotal(o))} por persona` : '',
    `Precio en el sitio: ${o.precioOriginal}. Cobra en ${o.cobraEn}${o.cobraEn === 'USD' ? '' : ' (no en dólares: confirmá con tu banco antes de pagar)'}`,
    t('Ida', o.ida),
    t('Vuelta', o.vuelta),
    'Carry on incluido en ida y vuelta',
    `Link: ${o.link}`,
  ].filter(Boolean).join('\n');
}

// Avisa por Gmail si hay contraseña de aplicación cargada; si no, abre un issue en el repo
// mencionando al dueño, y GitHub se lo manda por mail.
async function mandarMail(asunto, cuerpo) {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      const pass = process.env.GMAIL_APP_PASSWORD.replace(/\s/g, '');
      const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass } });
      await t.sendMail({ from: `Buscador de vuelos <${process.env.GMAIL_USER}>`, to: CFG.mailTo, subject: asunto, text: cuerpo });
      return true;
    } catch (e) {
      console.log('Gmail falló, aviso por GitHub:', e.message);
    }
  }
  return avisarPorGithub(asunto, cuerpo);
}

async function avisarPorGithub(asunto, cuerpo) {
  const repo = REPO;
  const texto = `@${repo.split('/')[0]}\n\n${cuerpo}`;
  if (!process.env.GITHUB_TOKEN) {
    // En la Mac: se le pide a GitHub que publique el aviso con su bot (workflow aviso.yml), así llega el mail
    try {
      execFileSync('gh', ['workflow', 'run', 'aviso.yml', '-R', repo, '-f', `asunto=${asunto}`, '-f', `cuerpo=${texto}`], { encoding: 'utf8' });
      console.log('Aviso pedido a GitHub:', asunto);
      return true;
    } catch (e) {
      console.log('Sin GitHub ni Gmail, no se avisa:', e.message, '\n', asunto, '\n', cuerpo);
      return false;
    }
  }
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    body: JSON.stringify({ title: asunto, body: texto }),
  });
  if (!r.ok) {
    console.log('No se pudo abrir el issue:', r.status, await r.text());
    process.exitCode = 1;
    return false;
  }
  console.log('Aviso enviado:', (await r.json()).html_url);
  return true;
}

// Datos que lee la app (docs/datos.json): última corrida completa y la serie de precios
function guardarDatosApp(resultados, ahora, mailEnviado) {
  const previo = fs.existsSync(DATOS_APP) ? JSON.parse(fs.readFileSync(DATOS_APP)) : { serie: [] };
  const opcion = o => ({
    sitio: o.sitio, cobraEn: o.cobraEn, origen: o.origen || 'COR', usd: Math.round(o.usdPorPersona), usdDesdeCordoba: Math.round(costoTotal(o)), precioOriginal: o.precioOriginal,
    ida: o.ida, vuelta: o.vuelta, link: o.link,
  });
  const busquedas = Object.entries(resultados).map(([nombre, ops]) => {
    const [sitio, fechas] = nombre.split(' ');
    const validas = (ops || []).filter(cumpleHorarios).sort((a, b) => costoTotal(a) - costoTotal(b));
    // Primero las que no se pagan en pesos; de las en pesos alcanza con la mejor, como referencia
    const enDolares = validas.filter(o => o.cobraEn !== 'ARS');
    const elegidas = [...new Set([...enDolares.slice(0, 5), ...enDolares.filter(o => maxEscalas(o) <= 1).slice(0, 5), ...validas.filter(o => o.cobraEn === 'ARS').slice(0, 1)])];
    return {
      sitio, fechas, estado: ops === null ? 'error' : ops.length ? 'ok' : 'sin_resultados',
      revisadas: ops?.length || 0, cumplen: validas.length, opciones: elegidas.map(opcion),
    };
  });
  const serie = [...(previo.serie || []), ...busquedas.filter(b => b.opciones[0] && b.opciones[0].cobraEn !== 'ARS').map(b => ({ t: ahora, sitio: b.sitio, fechas: b.fechas, usd: b.opciones[0].usdDesdeCordoba }))];
  fs.mkdirSync(new URL('./docs/', import.meta.url), { recursive: true });
  fs.writeFileSync(DATOS_APP, JSON.stringify({
    actualizado: ahora, mailEnviado,
    config: { costoCordobaBaires: CFG.costoCordobaBaires, viajes: CFG.viajes, pasajeros: CFG.pasajeros, topeUsdPorPersona: CFG.topeUsdPorPersona, maxIdaHoras: CFG.maxIdaHoras, maxVueltaHoras: CFG.maxVueltaHoras, cadaHoras: 6 },
    busquedas,
    serie: serie.slice(-2000),
  }));
}

async function main() {
  const estado = fs.existsSync(ESTADO) ? JSON.parse(fs.readFileSync(ESTADO)) : { avisados: {}, ultimoResumen: '' };
  const ahora = hoyAR();

  if (ahora.slice(0, 10) >= CFG.ultimoDiaDeBusqueda) {
    if (!estado.finAvisado && !SALIDA) {
      await mandarMail('Vuelos Salvador: la búsqueda terminó', 'Ya no se busca más porque falta poco para el viaje. Podés borrar o desactivar el repo de GitHub.');
      estado.finAvisado = true;
      fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 1));
    }
    return;
  }

  const eurUsd = await cotizacionEurUsd();
  const browser = await chromium.launch();
  const resultados = {};
  const sitios = SALIDA === 'turismocity'
    ? [['Turismocity', (b, ida, vta) => buscarTurismocity(b, ida, vta, 'COR')], ['TurismocityBUE', (b, ida, vta) => buscarTurismocity(b, ida, vta, 'BUE')]]
    : [['Kiwi', buscarKiwi], ['eDreams', (b, ida, vta) => buscarEdreams(b, ida, vta, eurUsd)], ['Aerolineas', buscarAerolineas]];
  const dm = f => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
  // Para pruebas: SOLO=Kiwi,Turismocity limita webs y FECHAS=2027-01-30:2027-02-13 limita fechas
  const solo = process.env.SOLO ? process.env.SOLO.split(',') : null;
  const fechas = process.env.FECHAS ? process.env.FECHAS.split(',').map(f => f.split(':')) : null;
  const pares = fechas || CFG.viajes;
  for (const [ida, vta] of pares) for (const [sitio, fn] of sitios.filter(([n]) => !solo || solo.includes(n))) {
    const nombre = `${sitio} ${dm(ida)}-${dm(vta)}`;
    try { resultados[nombre] = await fn(browser, ida, vta); } catch (e) { console.log(nombre, 'falló:', e.message); resultados[nombre] = null; }
  }
  await browser.close();

  const filas = [];
  const sirven = [];
  for (const [nombre, ops] of Object.entries(resultados)) {
    if (!ops || !ops.length) { filas.push([ahora, nombre, 'sin resultados', '', '', '']); continue; }
    const validas = ops.filter(cumpleHorarios).sort((a, b) => costoTotal(a) - costoTotal(b));
    const mejor = validas.find(o => o.cobraEn !== 'ARS');
    console.log(`${nombre}: ${ops.length} opciones, ${validas.length} cumplen horarios y carry on. Mejor: ${mejor ? Math.round(mejor.usdPorPersona) : '-'} USD c/u`);
    filas.push(mejor ? [ahora, nombre, Math.round(mejor.usdPorPersona), mejor.cobraEn, hhmm(mejor.ida.min), hhmm(mejor.vuelta.min)] : [ahora, nombre, 'ninguna cumple horarios', '', '', '']);
    // Avisa solo lo que no se paga en pesos. Lo que sale de Aeroparque se compara sumando ir y volver desde Córdoba.
    sirven.push(...validas.filter(o => o.cobraEn !== 'ARS' && (CFG.avisarDesdeBaires || o.origen !== 'BUE') && costoTotal(o) <= CFG.topeUsdPorPersona));
  }

  // Solo avisar opciones nuevas o que bajaron de precio
  const nuevas = sirven.sort((a, b) => costoTotal(a) - costoTotal(b))
    .filter(o => !(clave(o) in estado.avisados) || o.usdPorPersona < estado.avisados[clave(o)] - 1);
  let mailEnviado = false;
  if (nuevas.length && !solo && !fechas) {
    const top = nuevas.slice(0, 3);
    const asunto = `Vuelos Salvador: USD ${Math.round(costoTotal(top[0]))} c/u${top[0].origen === 'BUE' ? ' saliendo de Aeroparque, con avión desde Córdoba' : ''} en ${top[0].sitio}`;
    const cuerpo = [
      `Encontré ${nuevas.length === 1 ? 'una opción' : `${nuevas.length} opciones`} de Córdoba a Salvador (${CFG.viajes.length} combinaciones de fechas entre el ${CFG.viajes[0][0]} y el ${CFG.viajes.at(-1)[1]}, ${CFG.pasajeros} personas con carry on) bajo USD ${CFG.topeUsdPorPersona} por persona.`,
      ...top.map(textoOpcion),
      'Los precios cambian rápido. Confirmá precio, equipaje y moneda en la página antes de pagar.',
      top.some(o => o.sitio.startsWith('eDreams')) ? 'En eDreams entrá con tu cuenta Prime para ver ese precio.' : '',
    ].filter(Boolean).join('\n\n');
    mailEnviado = await mandarMail(asunto, cuerpo);
    if (mailEnviado) for (const o of nuevas) estado.avisados[clave(o)] = o.usdPorPersona;
  }

  // Resumen semanal los lunes, para saber que sigue vivo. Con PRUEBA=1 se manda siempre.
  const lunes = new Date(`${ahora.slice(0, 10)}T12:00:00`).getDay() === 1;
  const prueba = process.env.PRUEBA === '1';
  if (!SALIDA && !mailEnviado && (prueba || (lunes && estado.ultimoResumen !== ahora.slice(0, 10)))) {
    const lineas = filas.map(f => `${f[1]}: ${typeof f[2] === 'number' ? `USD ${f[2]} c/u (cobra en ${f[3]}), ida ${f[4]}, vuelta ${f[5]}` : f[2]}`);
    const asunto = prueba ? 'Vuelos Salvador: mail de prueba' : 'Vuelos Salvador: resumen semanal';
    await mandarMail(asunto, `Sigo buscando cada 6 horas. Todavía nada bajo USD ${CFG.topeUsdPorPersona} c/u.\n\nMejor precio que cumple horarios y carry on hoy:\n${lineas.join('\n')}\n\n${CFG.viajes.map(([i, v]) => `${i} al ${v}\nKiwi: ${kiwiUrl(i, v)}\neDreams: ${edreamsUrl(i, v)}\nAerolíneas en USD: ${aerolineasUrl(i, v)}`).join('\n\n')}`);
    if (!prueba) estado.ultimoResumen = ahora.slice(0, 10);
  }

  // Una corrida de prueba (SOLO o FECHAS) no pisa la app ni el historial
  if (solo || fechas) {
    for (const [nombre, ops] of Object.entries(resultados)) {
      const m = (ops || []).filter(cumpleHorarios).filter(o => o.cobraEn !== 'ARS').sort((a, b) => costoTotal(a) - costoTotal(b))[0];
      if (m) console.log(`\n${nombre}\n${textoOpcion(m)}`);
    }
    console.log('Corrida de prueba: no se guardan datos');
    return;
  }
  guardarDatosApp(resultados, ahora, mailEnviado);

  if (!fs.existsSync(HISTORIAL)) fs.writeFileSync(HISTORIAL, 'fecha,sitio,mejor_usd_por_persona,cobra_en,ida,vuelta,mail\n');
  fs.appendFileSync(HISTORIAL, filas.map(f => [...f, mailEnviado ? 'si' : 'no'].join(',')).join('\n') + '\n');
  fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 1));
}

await main();
