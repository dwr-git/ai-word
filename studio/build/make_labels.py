#!/usr/bin/env python3
"""Russian names for the assistant's command search.

Reads the Russian interface catalogs AI-Word is built with (`$CRAFT_I18N_DIR/locales/ru/common.tsv`
and `wordcraft.tsv`, after studio/build/i18n.sh renamed the app) and writes studio/ru-labels.json:

    {"text": {"Line Spacing": "Междустрочный интервал", ...}, "id": {"para.single": "…", ...}}

`text` translates labels and ribbon-path segments (rows with an empty or plain context); `id` holds
the `@id` rows (a command's own Russian name). The assistant panel uses both to show and search
commands in Russian. Run by studio/build/package.sh.
"""

import json
import os
import sys
from pathlib import Path


def unescape(s: str) -> str:
    return s.replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\")


def main() -> int:
    i18n = Path(os.environ.get("CRAFT_I18N_DIR", "")) / "locales" / "ru"
    dst = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ru-labels.json")
    text: dict[str, str] = {}
    ids: dict[str, str] = {}
    for name in ("common.tsv", "wordcraft.tsv"):
        path = i18n / name
        if not path.is_file():
            print(f"warning: {path} not found; command names stay English", file=sys.stderr)
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            cols = line.split("\t")
            if len(cols) < 3:
                continue
            context, source, target = cols[0], unescape(cols[1]), unescape(cols[2])
            if not target or context in ("@plural", "@msg"):
                continue
            if context == "@id":
                ids[source] = target
            elif source not in text or context == "":
                text[source] = target
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({"text": text, "id": ids}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{dst}: {len(text)} labels, {len(ids)} command names")
    return 0


if __name__ == "__main__":
    sys.exit(main())
