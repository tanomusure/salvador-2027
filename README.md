# Salvador 2027

Buscador de pasajes Córdoba → Salvador para 6 personas con carry on. Corre solo cada 6 horas en GitHub Actions y publica la app en https://tanomusure.github.io/salvador-2027/

Busca en Kiwi (precio en USD), eDreams (precio Prime, cobra en EUR), Aerolíneas Argentinas (versión que cobra en USD; tarifas Base o superiores, que incluyen carry on) y Turismocity desde Córdoba y desde Buenos Aires. De Turismocity se descartan para el aviso las webs que cobran en pesos con impuestos, y lo que sale de Aeroparque se compara sumando USD 120 de micro Córdoba-Buenos Aires. Fechas: ida 30/01 o 01/02/2027, vuelta 13/02 o 14/02/2027.

Avisa cuando encuentra algo de USD 650 o menos por persona, con ida de 16 h como máximo y vuelta de 24 h como máximo (se aceptan escalas largas): abre un issue que menciona al dueño y GitHub lo manda por mail. Los lunes manda un resumen. Deja de buscar el 25/01/2027.

- App: `docs/index.html`, lee `docs/datos.json`, que actualiza el bot
- Historial de precios: `historial.csv`
- Cambiar tope, fechas o duraciones: bloque `CFG` arriba de `buscar.mjs`
- Correrlo a mano: pestaña Actions → Buscar vuelos → Run workflow
- Pausarlo: pestaña Actions → Buscar vuelos → Disable workflow
