"""V4 internal user tasks, without any scenario or document storage actions."""
import pandas as pd
import pytest
from streamlit.testing.v1 import AppTest

from caregap import storage
from caregap.data import ROOT, load_dataset
from caregap.optimization import Area, allocation
from caregap.reporting import fingerprint, inputs


def button(app, label):
    return next(item for item in app.button if item.label == label)


def frame_with(app, column):
    return next(frame.value for frame in app.dataframe if column in frame.value)


def click(app, label):
    button(app, label).click().run()
    assert not app.exception


def test_public_data_and_two_optional_features(monkeypatch):
    monkeypatch.setattr(storage, "list_runs", lambda: [])
    app = AppTest.from_file(ROOT / "app.py", default_timeout=45).run()
    assert not app.exception
    assert app.title[0].value == "지역별 노인돌봄 수요와 이용 현황"
    assert [tab.label for tab in app.tabs[:3]] == ["현황 살펴보기", "지역 지도", "자료와 검증"]
    assert [item.value for item in app.metric[:4]] == ["229개", "112,243명", "43,223명", "1 / 5"]
    assert any("추정 집계" in i.value and "중복 인원은 미상" in i.value for i in app.info)
    assert any("표 5-3-13" in item.value for item in app.caption)
    assert all(any(number in link.proto.url for link in app.get("link_button")) for number in ("1492217", "1492242"))
    assert any("연결 229/229개" in item.value for item in app.caption)
    assert [app.number_input(key=key).value for key in ("budget_man", "p_default", "cost_man", "upper_default")] == [10000.0, 4, 3000.0, 15]

    app.multiselect(key="scope_provinces").set_value(["인천광역시"]).run()
    app.multiselect(key="scope_regions").set_value(["인천광역시 중구", "인천광역시 옹진군"]).run()
    assert not app.exception
    assert [item.value for item in app.metric[:4]] == ["2개", "343명", "143명", "1 / 0"]
    assert any("연결 2/2개" in item.value for item in app.caption)
    rows = frame_with(app, "수요 원본 셀").set_index("지역")
    assert tuple(rows.loc["인천광역시 중구", ["수요 원본 셀", "이용자 원본 셀", "수요군 B", "연간 이용자"]]) == ("C63", "E63", 276, 143)
    assert tuple(rows.loc["인천광역시 옹진군", ["수요 원본 셀", "이용자 원본 셀", "수요군 B"]]) == ("C72", "E72", 67)
    assert pd.isna(rows.loc["인천광역시 옹진군", "연간 이용자"])
    assert rows.loc["인천광역시 옹진군", "미상 원본 표기"] == "대시(-)"
    evidence = next(table.value for table in app.table if "수요 원본 셀" in table.value).set_index("지역")
    assert evidence.loc["인천광역시 옹진군", "연간 이용자"] == "미상"
    assert any("51.81%" in item.value and "143명 ÷ 276명" in item.value for item in app.markdown)
    province = frame_with(app, "집계 지역 원자료 비율").iloc[0]
    assert province["비율 집계 지역 수"] == province["이용자 미상 지역 수"] == 1
    assert province["집계 지역 원자료 비율"] == pytest.approx(143 / 276)
    excluded = frame_with(app, "배분 제외 사유").iloc[0]
    assert tuple(excluded) == ("인천광역시 옹진군", "이용 수 미상", 72)
    click(app, "세 가지 배분 대안 계산")
    app.multiselect(key="scope_regions").set_value(["인천광역시 중구"]).run()
    assert any("입력 조건이 바뀌었습니다" in item.value for item in app.warning)
    assert not any("후 모형 비율" in frame.value for frame in app.dataframe)
    app.multiselect(key="scope_regions").set_value(["인천광역시 옹진군"]).run()
    assert app.metric[2].value == "미상"
    assert button(app, "세 가지 배분 대안 계산").disabled
    click(app, "선택 지역 유형 분석")
    assert any("유효 지역 4개 이상" in w.value for w in app.warning)
    assert frame_with(app, "유형 제외 사유").iloc[0].tolist() == ["인천광역시 옹진군", "이용자 수 미상"]

    app.multiselect(key="scope_provinces").set_value(["충청남도", "대전광역시"]).run()
    assert app.metric[0].value == "20개"
    assert not app.multiselect(key="scope_regions").value
    app.multiselect(key="scope_provinces").set_value(["충청남도"]).run()
    click(app, "선택 지역 유형 분석")
    assert any("유형 분석에 사용한 지역 14개 / 선택 15개" in item.value for item in app.caption)
    assert frame_with(app, "유형 제외 사유").iloc[0].tolist() == ["충청남도 부여군", "원자료 비율 100% 초과"]
    scores = frame_with(app, "후보 유형 수")
    assert scores["후보 유형 수"].tolist() == [2, 3, 4, 5]
    assert scores[["시드 17", "시드 42", "시드 73"]].mean(axis=1).tolist() == pytest.approx(scores["평균 실루엣"].tolist())
    app.checkbox[0].check().run()
    assert not any("후보 유형 수" in frame.value for frame in app.dataframe)
    click(app, "선택 지역 유형 분석")
    assert any("유형 분석에 사용한 지역 15개 / 선택 15개" in item.value for item in app.caption)
    membership = frame_with(app, "source_quadrant").set_index("region_id")
    assert membership.loc["충청남도 부여군", "raw_ratio"] == pytest.approx(407 / 391)

    click(app, "세 가지 배분 대안 계산")
    comparison = next(table.value for table in app.table if "최저 모형 비율" in table.value)
    assert comparison["최저 모형 비율"].tolist() == ["22.41%", "20.70%", "20.70%"]
    assert comparison["추가 모형 이용자"].tolist() == ["12명"] * 3
    assert comparison["사용 예산"].tolist() == ["90,000,000원"] * 3
    assert app.session_state["report"]["parameters"]["budget_won"] == 100_000_000
    results = frame_with(app, "후 모형 비율")
    grouped = results.groupby("대안")[["자원 단위", "추가 모형 이용자", "비용 원"]].sum()
    assert grouped.values.tolist() == [[3, 12, 90_000_000]] * 3
    stages = frame_with(app, "제한 시간 (초)")
    assert stages["목표값"].tolist() == [2240, 12, 90_000_000]
    assert stages["상태"].str.endswith("(OPTIMAL)").all()
    assert (stages["제한 시간 (초)"] == 5).all()
    app.number_input(key="budget_man").set_value(0.0).run()
    assert any("입력 조건이 바뀌었습니다" in item.value for item in app.warning)
    assert not any("후 모형 비율" in frame.value for frame in app.dataframe)
    assert not any("최저 모형 비율" in table.value for table in app.table)
    click(app, "세 가지 배분 대안 계산")
    comparison = next(table.value for table in app.table if "최저 모형 비율" in table.value)
    assert comparison["사용 예산"].tolist() == ["0원"] * 3
    assert comparison["추가 모형 이용자"].tolist() == ["0명"] * 3
    assert frame_with(app, "후 모형 비율")[["자원 단위", "추가 모형 이용자", "비용 원"]].to_numpy().sum() == 0

    editor = next(frame for frame in app.dataframe if "최소 자원 단위" in frame.value)
    key = editor.proto.id.rsplit("-", 1)[1]
    edited_areas = {
        0: {"연간 추가 모형 이용자": 7, "연간 단위 비용 원": 20_000_000, "최소 자원 단위": 2, "최대 자원 단위": 3},
        1: {"연간 단위 비용 원": 25_000_000, "최소 자원 단위": 1},
    }
    app.session_state[key] = {"edited_rows": edited_areas, "added_rows": [], "deleted_rows": []}
    app.number_input(key="budget_man").set_value(10000.0).run()
    click(app, "세 가지 배분 대안 계산")
    for result in app.session_state["report"]["results"]:
        a, b, untouched = result["rows"][:3]
        assert (a["productivity"], a["unit_cost"], a["lower"], a["upper"]) == (7, 20_000_000, 2, 3)
        assert (b["productivity"], b["unit_cost"], b["lower"], b["upper"]) == (4, 25_000_000, 1, 15)
        assert (untouched["productivity"], untouched["unit_cost"], untouched["lower"], untouched["upper"]) == (4, 30_000_000, 0, 15)
        assert a["cost"] == a["units"] * 20_000_000 and b["cost"] == b["units"] * 25_000_000
    bad_limits = {0: {"최소 자원 단위": 3, "최대 자원 단위": 2}}
    app.session_state[key] = {"edited_rows": bad_limits, "added_rows": [], "deleted_rows": []}
    app.run()
    assert button(app, "세 가지 배분 대안 계산").disabled
    assert any(a["region_id"] in item.value for item in app.error)
    app.session_state[key] = {"edited_rows": {0: {"최소 자원 단위": 1}}, "added_rows": [], "deleted_rows": []}
    app.number_input(key="budget_man").set_value(0.0).run()
    click(app, "세 가지 배분 대안 계산")
    comparison = next(table.value for table in app.table if "최저 모형 비율" in table.value)
    assert comparison["계산 상태"].str.endswith("(INFEASIBLE)").all()
    assert comparison["사용 예산"].tolist() == ["—"] * 3
    assert sum("최소 비용이 예산을 넘습니다" in w.value for w in app.warning) == 3
    assert not any("후 모형 비율" in frame.value for frame in app.dataframe)
    app.number_input(key="budget_man").set_value(1.00001).run()
    assert button(app, "세 가지 배분 대안 계산").disabled
    assert any("원 단위" in item.value for item in app.error)
    app.multiselect(key="scope_provinces").set_value([]).run()
    assert not app.exception and app.metric[0].value == "0개"
    assert any("경계를 표시할 지역을 선택" in item.value for item in app.info)


def test_fingerprint_is_canonical_and_tracks_budget_and_area_assumptions():
    meta = load_dataset()["metadata"]
    a, b = Area("A", 10, 2), Area("B", 20, 7)
    original = fingerprint(inputs(meta, [a, b], 100))
    assert original == fingerprint(inputs(meta, [b, a], 100))
    assert original != fingerprint(inputs(meta, [a, b], 101))
    assert original != fingerprint(inputs(meta, [a, Area("B", 20, 7, productivity=5)], 100))


@pytest.mark.parametrize("counts", [[], [1.5], [True], [2], [1]], ids=["missing", "fractional", "boolean", "upper_bound", "budget"])
def test_malformed_solution_is_not_displayed_as_allocation(counts):
    result = allocation([Area("지역", 10, 1, upper=1)], counts, 0, "시험")
    assert result["status"] == "MODEL_INVALID"
    assert result["messages"] and not result["rows"] and not result["metrics"]
