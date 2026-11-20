"""Public program discovery and comparison without private applicant records."""
import json
import pandas as pd
import streamlit as st

from .data import ROOT
from .region_detail import provider_directory_url

CATALOG_FILE = ROOT / "data/welfare_catalog.json"
NEEDS = ["전체", "일상생활", "안전·안부", "요양·통합지원", "생활비·위기", "주거", "양육·교육", "일자리", "건강·의료"]
COMPARISON_FIELDS = [("대상 안내", "target"), ("지원 내용", "support"), ("신청 시작", "start"),
                     ("상담 전 확인", "check"), ("진행 절차", "process"), ("제공 범위", "coverage"),
                     ("공식 출처", "source_name"), ("공식 안내 확인일", "checked_on")]


def load_catalog():
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def find_services(services, query="", need="전체", group="전체", channel="전체"):
    terms = query.casefold().split()
    result = []
    for item in services:
        searchable = " ".join([item["name"], item["target"], item["support"], *item["keywords"]]).casefold()
        if ((need in ("", "전체") or need in item["needs"])
                and (group in ("", "전체") or group in item["groups"] or "가구공통" in item["groups"])
                and (channel in ("", "전체") or channel in item["channels"])
                and all(term in searchable for term in terms)):
            result.append(item)
    return result


def directory_route(item, province=""):
    directory = item["directory"]
    if directory == "daily-care":
        return ("노인맞춤돌봄 공식 수행기관 목록", provider_directory_url(province),
                "공식 목록의 시군구 열에서 기관명·주소·대표 연락처를 확인하세요.")
    routes = {
        "long-term-care": ("국민건강보험공단 장기요양 안내", "https://www.longtermcare.or.kr/", "공식 사이트에서 장기요양기관 찾기와 인정 신청 방법을 확인하세요."),
        "dementia": ("공식 치매안심센터 안내", "https://ansim.nid.or.kr/", "공식 사이트에서 가까운 치매안심센터를 선택하세요."),
        "disability": ("국민연금공단 장애인활동지원 제공기관 목록", "https://www.ableservice.or.kr/info/sprtinst/getOHGE0001M0.do", "공식 목록에서 시도·시군구를 선택해 활동지원 제공기관과 연락처를 확인하세요."),
        "childcare": ("공식 아이사랑 보육 안내", "https://www.childcare.go.kr/", "공식 사이트에서 어린이집 찾기와 입소 안내를 확인하세요."),
        "housing": ("공식 주거급여 안내", item["source_url"], "주거급여 안내에서 조사·신청 창구를 확인하세요."),
        "employment": ("공식 고용24 취업지원 안내", item["source_url"], "공식 안내에서 고용센터 상담과 구직등록·신청 경로를 확인하세요."),
        "education": ("공식 교육비 원클릭", "https://oneclick.neis.go.kr/nxui/index.html", "공식 사이트에서 교육급여·교육비 신청 경로를 확인하세요."),
    }
    return routes.get(directory, (item["action_label"], item["action_url"], "선택 지역의 읍면동 행정복지센터 등 공식 접수 창구에 문의하세요. 기관별 접수·정원은 직접 확인합니다."))


def comparison_notices(selected):
    if {"parent-pay", "childcare"}.issubset(selected):
        return ["부모급여와 보육료는 이용 방식에 따른 지급·정산 및 변경 신청 기준을 함께 확인하세요. 비교 선택은 동시 수급 가능 여부를 뜻하지 않습니다."]
    if len(selected) > 1:
        return ["함께 비교한 서비스의 중복 이용 가능 여부와 변경 신청 조건은 각 공식 창구에서 확인하세요."]
    return []


def _reset_filters():
    st.session_state.update(welfare_query="", welfare_need="전체", welfare_group="전체", welfare_channel="전체")


def _remember_preparation(service_id):
    saved = dict(st.session_state.get("welfare_prepared", {}))
    saved[service_id] = list(st.session_state.get(f"welfare_ready_{service_id}", []))
    st.session_state["welfare_prepared"] = saved


def _reset_regional_preparation(services):
    saved = dict(st.session_state.get("welfare_prepared", {}))
    for item in services:
        # The final item asks for confirmation at the selected local office.
        regional = item["checklist"][-1]
        saved[item["id"]] = [text for text in saved.get(item["id"], []) if text != regional]
        key = f"welfare_ready_{item['id']}"
        if key in st.session_state:
            st.session_state[key] = list(saved[item["id"]])
    st.session_state["welfare_prepared"] = saved


def render_welfare_guide():
    catalog = load_catalog()
    services = catalog["services"]
    names = {item["id"]: item["name"] for item in services}
    st.subheader("복지서비스 찾기")
    st.caption("필요한 도움으로 서비스를 찾고 지원 내용·신청 경로를 비교하세요. 서비스별 선정 조건은 공식 창구에서 확인할 수 있습니다.")
    st.caption(catalog["scope_note"])
    query_col, need_col, group_col, channel_col = st.columns(4)
    query = query_col.text_input("서비스 이름·필요한 도움", key="welfare_query", placeholder="예: 안부, 퇴원, 연금")
    need = need_col.selectbox("필요한 도움", NEEDS, key="welfare_need")
    group = group_col.selectbox("대상 분류", ["전체", *catalog["groups"]], key="welfare_group")
    channel = channel_col.selectbox("공식 신청·상담 방식", ["전체", *catalog["channels"]], key="welfare_channel")
    st.button("검색 조건 초기화", key="welfare_reset", on_click=_reset_filters)
    st.caption(catalog["selection_note"])
    matches = find_services(services, query, need, group, channel)
    st.caption(f"안내 서비스 {len(matches)}개 / 등록 {len(services)}개 · 안내 묶음 기준일 {catalog['checked_on']} · 서비스별 확인일은 상세에서 확인")
    if not matches:
        st.info("검색어를 줄이거나 필요한 도움을 ‘전체’로 바꿔 보세요.")
    for item in matches:
        with st.expander(item["name"]):
            for label, field in [("대상 안내", "target"), ("지원 내용", "support"), ("신청 시작", "start"),
                                 ("상담 전 확인", "check"), ("진행 절차", "process")]:
                st.markdown(f"**{label}** · {item[field]}")
            st.link_button(item["action_label"], item["action_url"])
            st.markdown(f"출처 · [{item['source_name']}]({item['source_url']}) · 확인일 {item['checked_on']}")
            st.caption(item["coverage"] + " · 공식 신청·상담 방식: " + " / ".join(item["channels"]))
    selected = st.multiselect("지원 내용 나란히 비교 · 최대 3개", list(names), format_func=names.get,
                              max_selections=3, key="welfare_compare")
    if selected:
        fields = COMPARISON_FIELDS
        columns = {"항목": [label for label, _ in fields]}
        by_id = {item["id"]: item for item in services}
        for service_id in selected:
            item = by_id[service_id]
            columns[item["name"]] = [item[field] for _, field in fields]
        st.table(pd.DataFrame(columns), hide_index=True)
        for service_id in selected:
            item = by_id[service_id]
            st.link_button(f"{item['name']} · {item['action_label']}", item["action_url"])
        for notice in comparison_notices(selected):
            st.info(notice)
        st.caption("검색 조건을 바꿔도 비교 선택은 유지됩니다. 비교 입력에서 선택을 해제할 수 있습니다.")
    st.markdown("**지역 수행기관과 공식 창구**")
    try:
        regions = sorted(json.loads((ROOT / "data/population_65plus_202512.json").read_text(encoding="utf-8"))["regions"])
    except (OSError, ValueError, KeyError):
        regions = []
    region = st.selectbox("안내받을 시군구", ["선택하세요", *regions], key="welfare_region",
                          on_change=_reset_regional_preparation, args=(services,))
    plan_id = st.selectbox("준비할 서비스", list(names), format_func=names.get, key="welfare_plan")
    item = next(row for row in services if row["id"] == plan_id)
    title, url, instruction = directory_route(item, region.split()[0] if region != "선택하세요" else "")
    region_label = region if region != "선택하세요" else "상담할 지역을 위에서 선택하세요"
    st.write(f"{region_label} · {item['name']} · {instruction}")
    st.link_button(title, url)
    st.markdown("**서비스별 상담 준비**")
    ready_key = f"welfare_ready_{plan_id}"
    if ready_key not in st.session_state:
        st.session_state[ready_key] = list(st.session_state.get("welfare_prepared", {}).get(plan_id, []))
    prepared = st.multiselect("상담 전에 확인할 항목", item["checklist"], key=ready_key,
                              on_change=_remember_preparation, args=(plan_id,))
    st.caption(f"확인 표시 {len(prepared)}/{len(item['checklist'])} · 현재 화면의 준비 표시이며 실제 신청·접수 상태는 아닙니다.")
    st.caption("서비스를 바꿔도 일반 확인 표시는 유지됩니다. 신청 지역을 바꾸면 모든 서비스의 지역 관련 확인 표시를 해제합니다.")
    st.markdown(f"**상담할 질문** · {item['check']} 필요한 신청서·대리신청 서류와 현재 접수 가능 여부도 물어보세요.")
    st.link_button("복지로 전체 복지서비스·모의계산·신청", "https://www.bokjiro.go.kr/ssis-tbu/")
    st.link_button("공식 복지 상담 창구", "https://www.129.go.kr/counsel/counsel01.do")
