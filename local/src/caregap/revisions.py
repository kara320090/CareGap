"""Validate corrected 2025 workbooks and atomically select a local revision."""
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import sqlite3
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

from openpyxl.utils.exceptions import InvalidFileException

from .data import ROOT, dataset_digest, load_dataset, validate_dataset
from .workbook import read_workbook

DEFAULT_DB = ROOT / ".local/dataset_revisions.sqlite3"
MAX_UPLOAD = 25 * 1024 * 1024


def stage_update(workbook: bytes, expected_sha256: str) -> dict:
    expected = expected_sha256.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("사전에 확인한 원본 SHA-256 값 64자리를 입력하세요.")
    if not 0 < len(workbook) <= MAX_UPLOAD:
        raise ValueError("25MB 이하의 XLSX를 선택하세요.")
    actual = hashlib.sha256(workbook).hexdigest()
    if actual != expected:
        raise ValueError("업로드 파일의 SHA-256이 입력값과 다릅니다.")

    baseline = load_dataset()
    if actual == baseline["metadata"]["source_sha256"]:
        raise ValueError("기본 원본과 동일한 파일입니다. 판본 전환은 필요하지 않습니다.")
    try:
        with ZipFile(BytesIO(workbook)) as archive:
            entries = archive.infolist()
            if len(entries) > 250 or sum(entry.file_size for entry in entries) > 100 * 1024 * 1024:
                raise ValueError("XLSX의 압축 해제 크기 또는 항목 수가 허용 범위를 넘습니다.")
        rows, audit = read_workbook(BytesIO(workbook))
    except (BadZipFile, InvalidFileException, KeyError, ParseError, OSError, TypeError) as error:
        raise ValueError("지원하는 XLSX 파일인지 확인하세요.") from error
    old_keys = {r["region_id"] for r in baseline["regions"]}
    new_keys = {r["region_id"] for r in rows}
    if old_keys != new_keys:
        raise ValueError(f"기본 자료와 지역 구성이 다릅니다. 누락 {len(old_keys - new_keys)}개, 추가 {len(new_keys - old_keys)}개")
    if audit["province_total_mismatches"]:
        raise ValueError("시도 합계 행과 시군구 합계가 다릅니다. " + ", ".join(audit["province_total_mismatches"]))

    meta = {**baseline["metadata"], "dataset_version": f"2025-correction-{actual[:12]}",
            "source_sha256": actual, "source_filename": "local-correction.xlsx",
            "source_report_sha256": None,
            "source_verification": "로컬 업로드 정정본. 파일 지문·엑셀 구조·전국 합계 검증. 발행기관 확인은 별도."}
    meta["dataset_sha256"] = dataset_digest(meta, rows)
    return validate_dataset({"metadata": meta, "regions": rows, "audit": audit})


def connect(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=5)
    con.row_factory = sqlite3.Row
    con.executescript("""
        CREATE TABLE IF NOT EXISTS versions (
            digest TEXT PRIMARY KEY, label TEXT NOT NULL, payload TEXT NOT NULL, source BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS switches (
            seq INTEGER PRIMARY KEY, time_utc TEXT NOT NULL, digest TEXT NOT NULL, action TEXT NOT NULL
        );
    """)
    return con


def current_digest(con, baseline):
    row = con.execute(
        "SELECT digest FROM switches WHERE action IN ('정정본 적용', '이전 판본 복원') ORDER BY seq DESC LIMIT 1"
    ).fetchone()
    return row["digest"] if row else baseline["metadata"]["dataset_sha256"]


def active_dataset(path: Path = DEFAULT_DB) -> dict:
    baseline = load_dataset()
    if not path.exists():
        return baseline
    with closing(connect(path)) as con:
        digest = current_digest(con, baseline)
        if digest == baseline["metadata"]["dataset_sha256"]:
            return baseline
        revision = con.execute("SELECT payload FROM versions WHERE digest = ?", (digest,)).fetchone()
        if revision is None:
            raise ValueError("활성 자료 판본을 찾을 수 없습니다.")
        data = validate_dataset(json.loads(revision["payload"]))
        if "province_total_mismatches" not in data["audit"] or "missing_user_markers" not in data["audit"]:
            # Earlier revisions omitted aggregate totals or original missing-value signs.
            source = con.execute("SELECT source FROM versions WHERE digest = ?", (digest,)).fetchone()["source"]
            if hashlib.sha256(source).hexdigest() != data["metadata"]["source_sha256"]:
                raise ValueError("보관된 정정본의 파일 지문이 다릅니다.")
            _, data["audit"] = read_workbook(BytesIO(source))
    return data


@contextmanager
def switching(expected_active: str, path: Path):
    baseline = load_dataset()
    with closing(connect(path)) as con, con:
        con.execute("BEGIN IMMEDIATE")
        if current_digest(con, baseline) != expected_active:
            raise ValueError("다른 세션에서 자료 판본을 바꿨습니다. 현재 판본을 다시 확인하세요.")
        yield con


def activate(workbook: bytes, expected_sha256: str, expected_active: str, path: Path = DEFAULT_DB) -> dict:
    candidate = stage_update(workbook, expected_sha256)
    meta = candidate["metadata"]
    digest = meta["dataset_sha256"]
    with switching(expected_active, path) as con:
        con.execute("INSERT OR IGNORE INTO versions VALUES (?, ?, ?, ?)",
                    (digest, meta["dataset_version"], json.dumps(candidate, ensure_ascii=False), workbook))
        con.execute("INSERT INTO switches (time_utc, digest, action) VALUES (?, ?, ?)",
                    (datetime.now(timezone.utc).isoformat(timespec="seconds"), digest, "정정본 적용"))
    return candidate


def restore(digest: str, expected_active: str, path: Path = DEFAULT_DB) -> None:
    baseline_digest = load_dataset()["metadata"]["dataset_sha256"]
    with switching(expected_active, path) as con:
        if digest != baseline_digest:
            revision = con.execute("SELECT payload FROM versions WHERE digest = ?", (digest,)).fetchone()
            if revision is None:
                raise ValueError("복원할 수 있는 판본이 아닙니다.")
            validate_dataset(json.loads(revision["payload"]))
        con.execute("INSERT INTO switches (time_utc, digest, action) VALUES (?, ?, ?)",
                    (datetime.now(timezone.utc).isoformat(timespec="seconds"), digest, "이전 판본 복원"))


def record_failure(reason: str, path: Path = DEFAULT_DB) -> None:
    baseline = load_dataset()
    with closing(connect(path)) as con, con:
        con.execute("BEGIN IMMEDIATE")
        con.execute("INSERT INTO switches (time_utc, digest, action) VALUES (?, ?, ?)",
                    (datetime.now(timezone.utc).isoformat(timespec="seconds"), current_digest(con, baseline),
                     f"검증 또는 적용 실패 · {reason[:240]}"))


def version_history(path: Path = DEFAULT_DB):
    base = load_dataset()["metadata"]
    versions = {base["dataset_sha256"]: base["dataset_version"]}
    if not path.exists():
        return versions, []
    with closing(connect(path)) as con:
        versions.update({r["digest"]: r["label"] for r in con.execute("SELECT digest, label FROM versions")})
        changes = [dict(row) for row in con.execute("SELECT time_utc, digest, action FROM switches ORDER BY seq DESC LIMIT 20")]
    return versions, changes
