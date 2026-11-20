from contextlib import closing
import hashlib
import json
from io import BytesIO
from functools import partial

from openpyxl import load_workbook
import pytest
from streamlit.testing.v1 import AppTest

from caregap import revisions, storage
from caregap.boundaries import join_regions, load_boundaries
from caregap.data import ROOT, load_dataset
from caregap.workbook import SHEET


def test_boundary_join_keeps_city_and_province_keys():
    indexed, meta = load_boundaries()
    rows = load_dataset()["regions"]
    features, unmatched = join_regions(rows, indexed, "raw_ratio")
    by_key = {f["properties"]["region_id"]: f["properties"] for f in features}
    assert len(features) == 229 and not unmatched
    assert meta["boundary_date"] == "2025-06-30"
    assert len({code for p in by_key.values() for code in p["sgis_codes"]}) == 252
    assert by_key["충청남도 천안시"]["sgis_codes"] == ["34011", "34012"]
    sejong = next(p for key, p in by_key.items() if key.startswith("세종특별자치시 "))
    assert sejong["sgis_codes"] == ["29010"]
    assert by_key["서울특별시 중구"]["sgis_codes"] != by_key["인천광역시 중구"]["sgis_codes"]
    assert by_key["인천광역시 옹진군"]["value"] is None
    assert join_regions([{"region_id": "미등록"}], indexed, "demand_b") == ([], ["미등록"])


@pytest.fixture
def corrected_workbook():
    baseline = load_dataset()
    workbook = load_workbook(ROOT / "data/source.xlsx")
    sheet = workbook[SHEET]
    total = next(row for row in sheet.iter_rows(min_col=1, max_col=1) if row[0].value == "전국")[0].row
    first = baseline["regions"][0]
    region = first["source_row"]
    province = next(row[0].row for row in sheet.iter_rows(min_col=1, max_col=1) if row[0].value == first["province"])
    sheet.cell(region, 3).value += 1
    sheet.cell(region, 11).value = None
    sheet.cell(total, 3).value += 1
    sheet.cell(province, 3).value += 1
    yield workbook, sheet, total, province
    workbook.close()


def workbook_bytes(workbook):
    out = BytesIO()
    workbook.save(out)
    payload = out.getvalue()
    return payload, hashlib.sha256(payload).hexdigest()


def test_revision_dry_run_validates_source_and_totals(corrected_workbook):
    workbook, sheet, national, province = corrected_workbook
    baseline = load_dataset()
    raw, sha = workbook_bytes(workbook)
    with pytest.raises(ValueError, match="SHA-256이 입력값과 다릅니다"):
        revisions.stage_update(raw, "0" * 64)
    staged = revisions.stage_update(raw, sha)
    assert staged["audit"]["demand_b_sum"] == baseline["audit"]["demand_b_sum"] + 1
    assert staged["metadata"]["source_sha256"] == sha
    assert staged["metadata"]["source_report_sha256"] is None
    sheet.cell(province, 3).value += 1
    with pytest.raises(ValueError, match="시도 합계"):
        revisions.stage_update(*workbook_bytes(workbook))
    sheet.cell(province, 3).value -= 1
    sheet.cell(national, 3).value += 1
    with pytest.raises(ValueError, match="전국 합계"):
        revisions.stage_update(*workbook_bytes(workbook))
    assert load_dataset() == baseline


def test_revision_validates_activates_and_restores(corrected_workbook, tmp_path):
    workbook, sheet, total, province = corrected_workbook
    db = tmp_path / "revisions.sqlite3"
    base = revisions.active_dataset(db)
    base_sha = base["metadata"]["dataset_sha256"]
    raw, sha = workbook_bytes(workbook)
    with pytest.raises(ValueError, match="SHA-256이 입력값과 다릅니다"):
        revisions.activate(raw, "0" * 64, base_sha, db)
    revisions.record_failure("파일 지문 불일치", db)
    assert revisions.active_dataset(db) == base
    sheet.cell(province, 3).value += 1
    bad_raw, bad_sha = workbook_bytes(workbook)
    with pytest.raises(ValueError, match="시도 합계"):
        revisions.activate(bad_raw, bad_sha, base_sha, db)
    assert revisions.active_dataset(db) == base
    sheet.cell(province, 3).value -= 1
    staged = revisions.stage_update(raw, sha)
    assert staged["audit"]["demand_b_sum"] == base["audit"]["demand_b_sum"] + 1
    assert staged["metadata"]["source_report_sha256"] is None
    assert revisions.active_dataset(db) == base
    activated = revisions.activate(raw, sha, base_sha, db)
    assert activated == staged == revisions.active_dataset(db)
    revised_sha = activated["metadata"]["dataset_sha256"]
    legacy = {**activated, "audit": {k: v for k, v in activated["audit"].items() if k != "province_total_mismatches"}}
    legacy["audit"]["excluded_aggregates"] = [{k: row[k] for k in ("name", "row")} for row in activated["audit"]["excluded_aggregates"]]
    with closing(revisions.connect(db)) as con, con:
        con.execute("UPDATE versions SET payload = ? WHERE digest = ?", (json.dumps(legacy), revised_sha))
    assert revisions.active_dataset(db) == activated
    with pytest.raises(ValueError, match="다른 세션"):
        revisions.activate(raw, sha, base_sha, db)
    sheet.cell(total, 3).value += 1
    raw, sha = workbook_bytes(workbook)
    with pytest.raises(ValueError, match="전국 합계"):
        revisions.activate(raw, sha, revised_sha, db)
    assert revisions.active_dataset(db) == activated
    revisions.restore(base_sha, revised_sha, db)
    assert revisions.active_dataset(db) == base
    versions, changes = revisions.version_history(db)
    assert set(versions) == {base_sha, revised_sha}
    assert [row["action"] for row in changes] == ["이전 판본 복원", "정정본 적용", "검증 또는 적용 실패 · 파일 지문 불일치"]
    revisions.restore(revised_sha, base_sha, db)
    assert revisions.active_dataset(db) == activated


def test_app_revision_switch_invalidates_old_result(corrected_workbook, tmp_path, monkeypatch):
    db = tmp_path / "revisions.sqlite3"
    for name in ("active_dataset", "activate", "restore", "record_failure", "version_history"):
        monkeypatch.setattr(revisions, name, partial(getattr(revisions, name), path=db))
    connect = storage.connect
    monkeypatch.setattr(storage, "connect", lambda path=None: connect(tmp_path / "scenarios.sqlite3"))
    raw, sha = workbook_bytes(corrected_workbook[0])
    app = AppTest.from_file(ROOT / "app.py", default_timeout=45).run()

    def click(label):
        next(b for b in app.button if b.label == label).click().run()
        assert not app.exception

    app.multiselect(key="scope_provinces").set_value(["서울특별시"]).run()
    click("세 가지 배분 대안 계산")
    assert len(app.get("download_button")) == 3
    app.file_uploader(key="correction_workbook").upload("test-correction.xlsx", raw)
    app.text_input(key="correction_sha").set_value("0" * 64).run()
    click("정정본 검증")
    assert any("SHA-256이 입력값과 다릅니다" in e.value for e in app.error)
    assert len(app.get("download_button")) == 3
    app.text_input(key="correction_sha").set_value(sha).run()
    click("정정본 검증")
    assert any("검증 통과" in s.value for s in app.success)
    click("검증한 판본 적용")
    assert any("2025-correction-" in c.value for c in app.caption)
    assert not app.get("download_button")
    assert any("입력 조건이 바뀌었습니다" in w.value for w in app.warning)
    click("선택 지역 유형 분석")
    cross = next(frame.value for frame in app.dataframe if "미상" in frame.value)
    assert cross["미상"].sum() == 1
    assert cross.to_numpy().sum() == len(app.session_state["cluster_result"][1]["rows"])
    click("선택 판본 복원")
    assert len(app.get("download_button")) == 3
