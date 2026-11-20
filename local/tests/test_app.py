from pathlib import Path
import csv
from io import StringIO
import json

from streamlit.testing.v1 import AppTest
from caregap import storage
from caregap.reporting import csv_bytes, fingerprint, html_bytes, json_bytes

APP = Path(__file__).resolve().parents[1] / "app.py"


def button(app, label):
    return next(x for x in app.button if x.label == label)


def test_user_flow_and_stale_protection(tmp_path, monkeypatch):
    db = tmp_path / "ui.sqlite3"
    original_connect = storage.connect
    monkeypatch.setattr(storage, "connect", lambda path=None: original_connect(db))
    app = AppTest.from_file(APP, default_timeout=45).run()
    assert not app.exception
    assert app.title[0].value == "지역별 노인돌봄 수요와 이용 현황"
    assert [tab.label for tab in app.tabs[:3]] == ["현황 살펴보기", "지역 지도", "자료와 검증"]
    assert app.metric[0].value == "229개"
    assert app.metric[3].value == "1 / 5"
    totals = next(frame.value for frame in app.dataframe if "원본 집계 범위" in frame.value)
    national = totals.loc[totals["원본 집계 범위"] == "전국"].iloc[0]
    assert (national["수요군 B"], national["연간 이용자"]) == (112243, 43223)
    app.multiselect(key="scope_provinces").set_value(["충청남도"]).run()
    assert not app.exception and app.metric[0].value == "15개"
    button(app, "세 가지 배분 대안 계산").click().run()
    assert not app.exception
    report = app.session_state["report"]
    assert len(report["results"]) == 3
    assert all(r["rows"] for r in report["results"])
    digest = fingerprint(report["parameters"])
    assert any(digest in item.value for item in app.caption)
    assert json.loads(json_bytes(report))["input_sha256"] == digest
    csv_rows = csv.DictReader(StringIO(csv_bytes(report).decode("utf-8-sig")))
    assert {row["input_sha256"] for row in csv_rows} == {digest}
    assert f"입력 지문: {digest}" in html_bytes(report).decode()
    next(field for field in app.text_input if field.label == "시나리오 이름").set_value("UI 기록").run()
    button(app, "현재 시나리오 저장").click().run()
    assert len(storage.list_runs(db)) == 1
    editor = next(frame for frame in app.dataframe if "최소 자원 단위" in frame.value)
    editor_key = editor.proto.id.rsplit("-", 1)[1]
    app.session_state[editor_key] = {"edited_rows": {0: {"연간 추가 모형 이용자": 7}}, "added_rows": [], "deleted_rows": []}
    app.run()
    button(app, "세 가지 배분 대안 계산").click().run()
    assert app.session_state["report"]["parameters"]["areas"][0]["productivity"] == 7
    app.number_input(key="budget_man").set_value(20000.0).run()
    assert any("입력 조건이 바뀌었습니다" in x.value for x in app.warning)
    assert not any(x.label == "현재 시나리오 저장" for x in app.button)
    button(app, "선택 기록의 입력 복원").click().run()
    assert not app.exception
    assert app.number_input(key="budget_man").value == 10000.0
    button(app, "세 가지 배분 대안 계산").click().run()
    assert not app.exception
    assert app.session_state["report"]["parameters"]["budget_won"] == 100000000
    assert app.session_state["report"]["parameters"] == report["parameters"]
    button(app, "선택 지역 유형 분석").click().run()
    assert not app.exception
    assert app.session_state["cluster_result"][1]["status"] == "OK"
    app.checkbox[0].check().run()
    assert not any(x.proto.label == "유형 분석 JSON" for x in app.get("download_button"))
    app.multiselect(key="scope_provinces").set_value([]).run()
    assert not app.exception and app.metric[0].value == "0개"
    assert button(app, "세 가지 배분 대안 계산").disabled
    app.multiselect(key="scope_provinces").set_value(["인천광역시"]).run()
    app.multiselect(key="scope_regions").set_value(["인천광역시 옹진군"]).run()
    assert app.metric[2].value == "미상"
    assert button(app, "세 가지 배분 대안 계산").disabled
    provincial = next(frame.value for frame in app.dataframe if "비율 집계 지역 수" in frame.value)
    assert provincial.iloc[0]["비율 집계 지역 수"] == 0
    assert provincial.iloc[0]["이용자 미상 지역 수"] == 1
    assert provincial.iloc[0]["집계 지역 원자료 비율"] is None
    app.multiselect(key="scope_regions").set_value(["인천광역시 중구", "인천광역시 옹진군"]).run()
    button(app, "세 가지 배분 대안 계산").click().run()
    assert not app.exception and len(app.session_state["report"]["excluded"]) == 1
    app.multiselect(key="scope_regions").set_value(["인천광역시 중구"]).run()
    assert any("입력 조건이 바뀌었습니다" in x.value for x in app.warning)
    app.number_input(key="budget_man").set_value(1.00001).run()
    assert button(app, "세 가지 배분 대안 계산").disabled
    assert any("원 단위" in x.value for x in app.error)
