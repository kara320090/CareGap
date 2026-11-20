from streamlit.testing.v1 import AppTest

from caregap.welfare_guide import find_services, load_catalog, directory_route, comparison_notices
from caregap.data import ROOT
from caregap import revisions


def test_service_search_covers_needs_and_empty_queries():
    data = load_catalog()
    assert len(data["services"]) == 20
    assert len({row["id"] for row in data["services"]}) == 20
    ids = lambda query, need="전체": [item["id"] for item in find_services(data["services"], query, need)]
    assert len(ids("")) == 20
    assert ids("안부") == ["daily-care", "safety"]
    assert ids("퇴원") == ["integrated-care"]
    assert ids("연금", "생활비·위기") == ["basic-pension", "disability-pension"]
    assert ids("없는서비스") == []


def test_basic_guide_search_comparison_and_empty_state():
    app = AppTest.from_file(ROOT / "app.py", default_timeout=40).run()
    assert not app.exception
    app.text_input(key="welfare_query").set_value("안부").run()
    labels = [item.label for item in app.expander]
    assert "노인맞춤돌봄서비스" in labels and "독거노인·장애인 응급안전안심서비스" in labels
    app.multiselect(key="welfare_compare").set_value(["daily-care", "safety"]).run()
    table = next(t.value for t in app.table if "항목" in t.value.columns)
    assert list(table.columns) == ["항목", "노인맞춤돌봄서비스", "독거노인·장애인 응급안전안심서비스"]
    assert "신청 시작" in list(table["항목"])
    app.selectbox(key="welfare_region").select("인천광역시 옹진군").run()
    assert not app.exception
    assert any("옹진군" in item.value and "공식 목록" in item.value for item in app.markdown)
    app.text_input(key="welfare_query").set_value("없는서비스").run()
    assert any("검색어를 줄이거나" in item.value for item in app.info)


def test_basic_guide_remains_usable_when_statistics_cannot_load(monkeypatch):
    def unavailable():
        raise ValueError("통계 원본을 확인할 수 없습니다.")

    monkeypatch.setattr(revisions, "active_dataset", unavailable)
    app = AppTest.from_file(ROOT / "app.py", default_timeout=40).run()
    assert not app.exception
    app.text_input(key="welfare_query").set_value("연금").run()
    assert not app.exception
    assert "기초연금" in [item.label for item in app.expander]


def test_hidden_comparisons_keep_selection_order_and_links_and_show_selected_directory():
    app = AppTest.from_string("from caregap.welfare_guide import render_welfare_guide\nrender_welfare_guide()").run()
    by_id = {row["id"]: row for row in load_catalog()["services"]}
    selected = ["safety", "daily-care"]
    app.multiselect(key="welfare_compare").set_value(selected).run()
    app.text_input(key="welfare_query").set_value("없는서비스").run()
    assert list(app.table[0].value.columns) == ["항목", *(by_id[s]["name"] for s in selected)]
    links = {button.proto.label: button.proto.url for button in app.get("link_button")}
    for service_id in selected:
        row = by_id[service_id]
        assert links[f"{row['name']} · {row['action_label']}"] == row["action_url"]
    app.selectbox(key="welfare_region").select("인천광역시 옹진군").run()
    app.selectbox(key="welfare_plan").select("disability-activity").run()
    urls = [button.proto.url for button in app.get("link_button")]
    assert directory_route(by_id["disability-activity"])[1] in urls
    assert not any("sub01.php?og_type=" in url for url in urls)
    assert not app.exception


def test_catalogue_filters_are_intersections_and_not_eligibility_rules():
    services = load_catalog()["services"]
    result = find_services(services, "", "양육·교육", "영유아·아동", "온라인")
    assert {row["id"] for row in result} == {"education", "child-allowance", "parent-pay", "birth-voucher", "childcare", "single-parent"}
    assert find_services(services, "퇴원", "주거") == []
    assert "housing" in {row["id"] for row in find_services(services, group="노년")}
    assert "disability-activity" not in {row["id"] for row in find_services(services, group="노년")}
    for row in services:
        assert row["source_url"].startswith("https://") and len(row["checklist"]) == 3
        assert row["checked_on"] == ("2026-11-10" if row["id"] == "birth-voucher" else "2026-11-09")


def test_service_specific_directory_does_not_misroute_other_services():
    services = {row["id"]: row for row in load_catalog()["services"]}
    assert "og_type=" in directory_route(services["daily-care"], "인천광역시")[1]
    assert "1661-2129" not in directory_route(services["safety"], "인천광역시")[1]
    assert "longtermcare.or.kr" in directory_route(services["long-term-care"])[1]
    assert "childcare.go.kr" in directory_route(services["childcare"])[1]
    assert "nid.or.kr" in directory_route(services["dementia"])[1]
    assert "원클릭" in directory_route(services["education"])[0]
    assert "정산" in comparison_notices(["childcare", "parent-pay"])[0]
    assert comparison_notices([]) == []


def test_extended_ui_reset_preserves_comparison_and_preparation_is_service_specific():
    app = AppTest.from_file(ROOT / "app.py", default_timeout=40).run()
    app.selectbox(key="welfare_need").select("양육·교육")
    app.selectbox(key="welfare_group").select("영유아·아동")
    app.selectbox(key="welfare_channel").select("온라인").run()
    assert not app.exception
    assert "부모급여" in [item.label for item in app.expander]
    assert "노인맞춤돌봄서비스" not in [item.label for item in app.expander]
    app.multiselect(key="welfare_compare").set_value(["parent-pay", "childcare"]).run()
    assert any("정산" in item.value for item in app.info)
    app.selectbox(key="welfare_plan").select("parent-pay").run()
    checklist = next(row for row in load_catalog()["services"] if row["id"] == "parent-pay")["checklist"]
    app.multiselect(key="welfare_ready_parent-pay").set_value(checklist[:1]).run()
    assert any("1/3" in row.value for row in app.caption)
    app.selectbox(key="welfare_plan").select("childcare").run()
    assert app.multiselect(key="welfare_ready_childcare").value == []
    app.button(key="welfare_reset").click().run()
    assert app.selectbox(key="welfare_need").value == "전체"
    assert app.multiselect(key="welfare_compare").value == ["parent-pay", "childcare"]
    assert not app.exception


def test_preparation_survives_service_roundtrip_and_region_change_clears_hidden_regional_checks():
    app = AppTest.from_file(ROOT / "app.py", default_timeout=45).run()
    services = {row["id"]: row for row in load_catalog()["services"]}
    app.selectbox(key="welfare_region").select("인천광역시 중구").run()
    app.selectbox(key="welfare_plan").select("parent-pay").run()
    checklist = services["parent-pay"]["checklist"]
    app.multiselect(key="welfare_ready_parent-pay").set_value(checklist).run()
    app.selectbox(key="welfare_plan").select("childcare").run()
    assert app.multiselect(key="welfare_ready_childcare").value == []
    app.selectbox(key="welfare_plan").select("parent-pay").run()
    assert app.multiselect(key="welfare_ready_parent-pay").value == checklist
    app.selectbox(key="welfare_plan").select("childcare").run()
    app.selectbox(key="welfare_region").select("인천광역시 옹진군").run()
    app.selectbox(key="welfare_plan").select("parent-pay").run()
    assert app.multiselect(key="welfare_ready_parent-pay").value == checklist[:-1]
    assert not app.exception
