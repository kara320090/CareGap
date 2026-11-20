from datetime import datetime, timezone
from pathlib import Path
import json
import sqlite3
import uuid
from .data import ROOT


def connect(path=None):
    target = Path(path or ROOT / ".local/scenarios.sqlite3")
    target.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(target)
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE IF NOT EXISTS scenarios (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, source_hash TEXT NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL)")
    return con


def save(report, name, path=None):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError("이름은 공백을 제외하고 1~80자입니다.")
    ident = uuid.uuid4().hex
    with connect(path) as con:
        con.execute("INSERT INTO scenarios VALUES (?, ?, ?, ?, ?, ?)",
                    (ident, name.strip(), datetime.now(timezone.utc).isoformat(), report["source"]["dataset_sha256"],
                     report["input_sha256"], json.dumps(report, ensure_ascii=False, allow_nan=False)))
    return ident


def list_runs(path=None):
    with connect(path) as con:
        return [dict(r) for r in con.execute("SELECT id,name,created_at,source_hash,input_hash FROM scenarios ORDER BY created_at DESC")]


def load(ident, path=None):
    with connect(path) as con:
        row = con.execute("SELECT payload FROM scenarios WHERE id=?", (ident,)).fetchone()
    if row is None:
        raise ValueError("저장된 시나리오를 찾을 수 없습니다.")
    return json.loads(row["payload"])
