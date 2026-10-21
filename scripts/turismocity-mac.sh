#!/bin/zsh
# Corre en la Mac de Tano (launchd, cada 6 horas): Turismocity frena a los servidores de GitHub con Cloudflare,
# así que esta parte se busca desde acá y se sube a docs/datos-turismocity.json, que la app junta con el resto.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.." || exit 1
echo "=== $(date '+%F %H:%M') ==="
git pull -q --rebase --autostash origin main || exit 1
SALIDA=turismocity node buscar.mjs 2>&1 | grep -v DEP0169
git add docs/datos-turismocity.json estado-turismocity.json historial-turismocity.csv
git commit -qm "Turismocity desde la Mac $(date '+%F %H:%M')" || exit 0
git push -q origin main || { git pull -q --rebase origin main && git push -q origin main; }
