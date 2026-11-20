from dataclasses import replace

import pytest
from streamlit.testing.v1 import AppTest

from caregap import storage
from caregap.data import ROOT, summarize_welfare
from caregap.optimization import Area, calculate_alternatives, scale_unit_costs
from caregap.region_detail import provider_directory_url
from caregap.scenario_comparison import alternative_ranks


def test_region_detail_preserves_unknown_and_analysis_scope(monkeypatch):
    monkeypatch.setattr(storage, "list_runs", lambda: [])
    app = AppTest.from_file(ROOT / "app.py", default_timeout=45).run()
    app.button(key="demo_incheon").click().run()
    app.selectbox(key="detail_focus_overview").select("인천광역시 중구").run()
    detail = next(table.value.set_index("지표") for table in app.table if "지표" in table.value)
    assert detail.loc["이용 대 수요 비율"].tolist() == ["51.81%", "29.88%"]
    assert app.selectbox(key="detail_focus_map").value == "인천광역시 중구"
    app.selectbox(key="detail_peer_overview").select("인천광역시 옹진군").run()
    detail = next(table.value.set_index("지표") for table in app.table if "지표" in table.value)
    assert detail.loc["확인된 연간 이용자"].tolist() == ["143명", "미상"]
    assert detail.loc["이용 대 수요 비율"].tolist() == ["51.81%", "미상"]
    assert detail.loc["65세 이상 인구"].tolist() == ["28,899명", "7,087명"]
    assert detail.loc["65세 이상 인구 1,000명당 수요군 B"].tolist() == ["9.55명", "9.45명"]
    assert [metric.value for metric in app.metric[4:6]] == ["35,986명", "9.53명"]
    assert not any("비율 차이" in caption.value for caption in app.caption)
    app.selectbox(key="detail_focus_map").select("인천광역시 옹진군").run()
    assert app.selectbox(key="detail_focus_overview").value == "인천광역시 옹진군"
    assert app.selectbox(key="detail_peer_overview").value is None
    assert [metric.value for metric in app.metric[:3]] == ["2개", "343명", "143명"]
    assert any(item.proto.url == provider_directory_url("인천광역시") for item in app.get("link_button"))
    app.button(key="demo_chungnam").click().run()
    assert app.selectbox(key="detail_focus_overview").value is None
    assert not app.exception


def test_scenario_comparison_tracks_inputs_and_keeps_infeasible_distinct(monkeypatch):
    monkeypatch.setattr(storage, "list_runs", lambda: [])
    app = AppTest.from_file(ROOT / "app.py", default_timeout=45).run()
    app.button(key="demo_chungnam").click().run()
    button = lambda: next(item for item in app.button if item.label == "기준과 변경 조건 계산")
    button().click().run()
    _, reference, changed = app.session_state["sensitivity_result"]
    assert all(result["metrics"]["cost"] == 90_000_000 for result in reference)
    assert all(result["metrics"]["additional_model_users"] == 12 for result in reference)
    assert all(result["metrics"]["cost"] == result["metrics"]["additional_model_users"] == 0 for result in changed)
    assert any("배분 단위 차이" in frame.value for frame in app.dataframe)
    app.radio(key="compare_dimension").set_value("지역별 단가 일괄 배율").run()
    assert "sensitivity_result" not in app.session_state
    button().click().run()
    _, _, changed = app.session_state["sensitivity_result"]
    assert all(result["metrics"]["cost"] == 72_000_000 for result in changed)
    assert all(result["metrics"]["additional_model_users"] == 8 for result in changed)
    assert all(row["unit_cost"] == 36_000_000 for result in changed for row in result["rows"])

    editor = next(frame for frame in app.dataframe if "최소 자원 단위" in frame.value)
    key = editor.proto.id.rsplit("-", 1)[1]
    app.session_state[key] = {"edited_rows": {0: {"최소 자원 단위": 1}}, "added_rows": [], "deleted_rows": []}
    app.radio(key="compare_dimension").set_value("예산").run()
    assert "sensitivity_result" not in app.session_state
    button().click().run()
    _, _, changed = app.session_state["sensitivity_result"]
    assert all(result["status"] == "INFEASIBLE" and not result["rows"] for result in changed)
    assert any("최소 비용이 예산을 넘습니다" in warning.value for warning in app.warning)
    assert not any("배분 단위 차이" in frame.value for frame in app.dataframe)
    app.number_input(key="budget_man").set_value(11000.0).run()
    assert "sensitivity_result" not in app.session_state
    assert not app.exception


def test_weighted_summary_cost_rounding_and_rank_ties():
    summary = summarize_welfare([
        {"annual_users": 2, "demand_b": 5},
        {"annual_users": 0, "demand_b": 15},
        {"annual_users": None, "demand_b": 40},
        {"annual_users": 3, "demand_b": 0},
    ])
    assert (summary["demand"], summary["users"], summary["ratio"], summary["eligible_count"]) == (60, 5, 0.1, 2)
    area = Area("지역", 10, 2, cost=5, lower=1)
    assert scale_unit_costs([area], 110) == [replace(area, cost=6)]
    results = calculate_alternatives([area], 5)
    assert set(alternative_ranks(results).values()) == {"공동 1위"}
    assert alternative_ranks([{**results[0], "status": "FEASIBLE"}, *results[1:]]) == {}


def test_cost_scale_checks_base_percentage_and_rounded_prices():
    area = Area("지역", 10, 2, cost=100)
    assert scale_unit_costs([area], 1)[0].cost == 1
    assert scale_unit_costs([area], 1000)[0].cost == 1000
    for percentage in (0.99, 1000.01, False, float("nan"), float("inf")):
        with pytest.raises(ValueError, match="배율"):
            scale_unit_costs([area], percentage)
    for original, percentage in ((0.5, 200), (1, 1), (10**10, 101)):
        with pytest.raises(ValueError, match="단가"):
            scale_unit_costs([replace(area, cost=original)], percentage)


def test_overview_distinguishes_empty_search_scope_and_unknown_users(monkeypatch):
    monkeypatch.setattr(storage, "list_runs", lambda: [])
    app = AppTest.from_file(ROOT / "app.py", default_timeout=60).run()
    app.button(key="demo_incheon").click().run()
    summary = next(frame.value for frame in app.dataframe if "총수요군 B" in frame.value).iloc[0]
    assert (summary["총수요군 B"], summary["확인 이용자 합계"], summary["집계 지역 수요군 B"]) == (343, 143, 276)
    query = next(field for field in app.text_input if field.label == "시도·시군구 검색")
    query.set_value("해당없음").run()
    assert any("조건에 맞는 지역이 없습니다" in item.value for item in app.info)
    assert app.metric[0].value == "2개"
    app.multiselect(key="scope_provinces").set_value([]).run()
    assert not app.exception
    assert [item.value for item in app.metric[:3]] == ["0개", "—", "—"]
