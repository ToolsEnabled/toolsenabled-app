"""Build deterministic LEAN equity minute files from frozen completed bars."""
import json
import re
import sys
import zipfile
from pathlib import Path
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

root = Path(sys.argv[1])
task = json.load(sys.stdin)
grouped, symbols = {}, set()
for bar in task["bars"]:
    end = datetime.fromisoformat(bar["time"].replace("Z", "+00:00"))
    if end.tzinfo is None or end.second or end.microsecond:
        raise ValueError("LEAN code grading requires minute-aligned timestamps with a timezone")
    start = (end - timedelta(minutes=1)).astimezone(ZoneInfo("America/New_York"))
    day = start.strftime("%Y%m%d")
    millis = (start.hour * 3600 + start.minute * 60) * 1000
    for ticker, cents in bar["prices"].items():
        if not re.fullmatch(r"[A-Z][A-Z0-9.]{0,19}", ticker):
            raise ValueError("Invalid equity ticker")
        symbol = ticker.lower()
        symbols.add(symbol)
        if cents is None:
            continue
        if type(cents) is not int or cents <= 0:
            raise ValueError("Prices must be positive integer cents")
        scaled = cents * 100
        grouped.setdefault((symbol, day), []).append(f"{millis},{scaled},{scaled},{scaled},{scaled},1000000")
for (symbol, day), rows in grouped.items():
    directory = root / "equity" / "usa" / "minute" / symbol
    directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(directory / (day + "_trade.zip"), "w") as archive:
        member = zipfile.ZipInfo(day + "_" + symbol + "_minute_trade.csv", date_time=(2024, 1, 1, 0, 0, 0))
        archive.writestr(member, "\n".join(rows) + "\n")
for symbol in symbols:
    for folder, content in [("map_files", f"20000101,{symbol},usa\n20501231,{symbol},usa\n"), ("factor_files", "20000101,1,1,1\n20501231,1,1,1\n")]:
        file = root / "equity" / "usa" / folder / (symbol + ".csv")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding="utf-8", newline="\n")
print(json.dumps({"output": {"symbols": sorted(symbols), "files": len(grouped)}}))
