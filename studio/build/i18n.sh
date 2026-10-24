#!/usr/bin/env bash
# The interface catalogs AI-Word is built with: a copy of storytold/craft-i18n (pinned in
# craft-i18n.rev) with the app's name changed to AI-Word, plus AI-Word's own Russian rows
# (studio/i18n/ru.tsv). Prints the folder to pass as CRAFT_I18N_DIR.
#
# Usage: studio/build/i18n.sh <craft-i18n checkout> <output folder>
set -euo pipefail
SRC="${1:?craft-i18n checkout}"
OUT="${2:?output folder}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -d "$SRC/locales" ] || { echo "error: $SRC has no locales/" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC/locales" "$OUT/locales"
# The English source column is the lookup key, and the code says "AI-Word" where it said
# "WordCraft": both columns change together, so every translated row still matches.
find "$OUT/locales" -name 'wordcraft.tsv' -o -name 'common.tsv' | while read -r f; do
  sed -i.bak 's/WordCraft/AI-Word/g' "$f" && rm -f "$f.bak"
done
# AI-Word's own rows, after the rename (they may name WordCraft on purpose).
if [ -f "$HERE/i18n/ru.tsv" ] && [ -f "$OUT/locales/ru/wordcraft.tsv" ]; then
  { echo; grep -v '^#' "$HERE/i18n/ru.tsv"; } >>"$OUT/locales/ru/wordcraft.tsv"
fi
echo "$OUT"
