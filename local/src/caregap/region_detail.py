"""Local region comparison and links to the official provider directory."""
from urllib.parse import urlencode

import pandas as pd
import streamlit as st

from .data import summarize_welfare
from .population import population_context
from .regional_context import (
    APPLICATION_GUIDE, CARE_STATISTICS, COMPARISON_LABELS,
    compare_neighbors, demographic_values, follow_up,
)

DIRECTORY_URL = "https://www.1661-2129.or.kr/organization/sub01.php"
# Province filters published by the official directory. Other labels use its full list.
DIRECTORY_PROVINCES = frozenset({
    "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시",
    "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도",
    "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
})


def provider_directory_url(province):
    return DIRECTORY_URL + "?" + urlencode({"og_type": province if province in DIRECTORY_PROVINCES else "전체"})


def set_detail_region(region_id):
    if region_id != st.session_state.get("detail_region_id"):
        st.session_state["detail_region_id"] = region_id
        st.session_state["detail_peer_region"] = None


def select_table_region(widget_key, displayed_ids):
    selected_rows = st.session_state[widget_key]["selection"]["rows"]
    if selected_rows and 0 <= selected_rows[0] < len(displayed_ids):
        set_detail_region(displayed_ids[selected_rows[0]])


def select_map_region(widget_key):
    points = st.session_state[widget_key]["selection"].get("region_point", [])
    if points and points[0].get("region_id"):
        set_detail_region(points[0]["region_id"])


def people(value):
    return "미상" if value is None else f"{value:,}명"


def percent(value):
    return "미상" if value is None else f"{value:.2%}"


def ratio_evidence(summary):
    if summary["ratio"] is None:
        return "이용자 수 미상으로 비율 산출 불가" if summary["users"] is None else "양수인 수요가 없어 비율 산출 불가"
    return f"{people(summary['ratio_users'])} ÷ {people(summary['ratio_demand'])} = {percent(summary['ratio'])}"


def province_warnings(summary):
    counts = (
        ("이용자 수 미상", summary["unknown_count"]),
        ("수요 0 (이용 확인)", summary["zero_demand_count"]),
        ("비율 100% 초과", summary["above_demand_count"]),
    )
    return " · ".join(f"{label} {count:,}곳" for label, count in counts if count) or "없음"


def render_region_detail(view, selected_ids, records_by_id, metadata, source_cells, population_by_id, context):
    st.subheader("지역 상세 비교")
    if not selected_ids:
        st.caption("먼저 분석 범위에 시군구를 포함해 주세요.")
        return
    focus_key = f"detail_focus_{view}"
    focus_id = st.session_state.get("detail_region_id")
    st.session_state[focus_key] = focus_id
    st.selectbox(
        "상세 지역", [None, *sorted(selected_ids)], key=focus_key,
        format_func=lambda value: value or "시군구를 선택하세요",
        on_change=lambda: set_detail_region(st.session_state[focus_key]),
    )
    if focus_id is None:
        st.caption("현황표 행이나 지도에서 시군구를 선택해도 상세 비교를 열 수 있습니다.")
        return

    focus = records_by_id[focus_id]
    province = focus["province"]
    province_label = f"{province} 전체"
    peer_key = f"detail_peer_{view}"
    peer_id = st.session_state.get("detail_peer_region")
    st.session_state[peer_key] = peer_id
    st.selectbox(
        "비교 대상", [None, *sorted(set(records_by_id) - {focus_id})], key=peer_key,
        format_func=lambda value: value or province_label,
        on_change=lambda: st.session_state.update(detail_peer_region=st.session_state[peer_key]),
    )
    peer_label = peer_id or province_label
    peer_rows = [records_by_id[peer_id]] if peer_id else [
        row for row in records_by_id.values() if row["province"] == province
    ]
    focus_summary = summarize_welfare([focus])
    peer_summary = summarize_welfare(peer_rows)
    focus_pop, focus_rate = population_context([focus], population_by_id)
    peer_pop, peer_rate = population_context(peer_rows, population_by_id)
    st.table(pd.DataFrame({
        "지표": ["수요군 B", "확인된 연간 이용자", "이용 대 수요 비율", "65세 이상 인구",
                 "65세 이상 인구 1,000명당 수요군 B", "자료 경고"],
        focus_id: [people(focus_summary["demand"]), people(focus_summary["users"]),
                   percent(focus_summary["ratio"]), people(focus_pop),
                   "—" if focus_rate is None else f"{focus_rate:,.2f}명", " · ".join(focus["flags"]) or "없음"],
        peer_label: [people(peer_summary["demand"]), people(peer_summary["users"]), percent(peer_summary["ratio"]),
                     people(peer_pop), "—" if peer_rate is None else f"{peer_rate:,.2f}명",
                     (" · ".join(peer_rows[0]["flags"]) or "없음") if peer_id else province_warnings(peer_summary)],
    }), hide_index=True)
    if focus_summary["ratio"] is not None and peer_summary["ratio"] is not None:
        difference = (focus_summary["ratio"] - peer_summary["ratio"]) * 100
        st.caption(f"이용 대 수요 비율 차이 (상세 지역 − 비교 대상) · {difference:+.2f}%p")
    if peer_id is None:
        st.caption(f"{province_label} {len(peer_rows):,}곳은 현재 분석 범위와 별도로 집계합니다. 비율 계산에는 {peer_summary['eligible_count']:,}곳이 포함됩니다.")

    demographics = demographic_values(focus_id, population_by_id, context)
    if demographics:
        st.caption(f"80세 이상 {demographics['age80']:,}명 ({demographics['age_share']:.2%}) · "
                   f"65세 이상 1인세대 {demographics['single65']:,}세대 ({demographics['single_share']:.2%}) · "
                   f"2024년 말 대비 고령인구 {demographics['change']:+,}명 ({demographics['growth']:+.2%})")
        render_neighbor_comparison(view, focus, records_by_id, population_by_id, context)
    else:
        st.markdown("**다음에 확인할 것**")
        for note in follow_up(focus, False):
            st.write(note)

    with st.expander("상세 비교의 원본 셀과 계산식"):
        st.caption(f"보건복지부 부가통계 {metadata['sheet']} · C열 수요군 B · E열 연간 이용자")
        st.write(f"{focus_id} · {ratio_evidence(focus_summary)}")
        st.write(f"{peer_label} · {ratio_evidence(peer_summary)}")
        st.caption("시도 비율은 이용자 수가 확인되고 수요가 양수인 같은 지역의 이용자 합계와 수요 합계로 계산합니다.")
        cells = source_cells(list({row["region_id"]: row for row in [focus, *peer_rows]}.values()))
        cells["연간 이용자"] = cells["연간 이용자"].astype("Int64").astype("string").fillna("미상")
        st.dataframe(cells, hide_index=True, width="stretch")

    with st.expander("노인맞춤돌봄서비스 수행기관 안내"):
        st.write(f"**{focus_id}**")
        st.caption("공식 목록의 시군구 열에서 해당 지역을 찾아 수행기관명, 주소, 대표 연락처를 확인할 수 있습니다.")
        st.link_button("공식 수행기관 목록 열기", provider_directory_url(province))
        st.link_button("주민·보호자용 공식 신청 절차", APPLICATION_GUIDE)
        st.link_button("장기요양 등급 판정 공식 통계", CARE_STATISTICS)


def render_neighbor_comparison(view, focus, records, counts, context):
    key = focus["region_id"]
    mode = st.selectbox("유사 지역 비교 기준", ["province", *COMPARISON_LABELS], index=1,
                        format_func=lambda value: COMPARISON_LABELS.get(value, "같은 시도 전체"),
                        key=f"regional_context_mode_{view}")
    age_comparison = compare_neighbors(key, "age", records, counts, context)
    if mode == "province":
        region_rows = [row for row in records.values() if row["province"] == focus["province"]]
        total, rate = population_context(region_rows, counts)
        st.caption(f"{focus['province']} 전체 · 65세 이상 {people(total)} · 1,000명당 수요군 B "
                   f"{f'{rate:.2f}명' if rate is not None else '미상'}")
    else:
        comparison = age_comparison if mode == "age" else compare_neighbors(key, mode, records, counts, context)
        if comparison:
            st.caption("65세 이상 인구 규모와 80세 이상 비중을 사용합니다. 1인세대 기준은 65세 이상 1인세대 비중도 사용합니다.")
            rows = []
            for other in [key, *comparison["peers"]]:
                stats = demographic_values(other, counts, context)
                row = records[other]
                rows.append({"지역": other, "65세 이상": people(stats["older"]),
                             "80세 이상 비중": percent(stats["age_share"]),
                             "65세 이상 1인세대 비중": percent(stats["single_share"]),
                             "수요군 B": people(row["demand_b"]),
                             "고령인구 1,000명당 수요군 B": f"{row['demand_b'] * 1000 / counts[other]:.2f}명"})
            st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
            st.markdown(f"**고령인구 1,000명당 수요군 B {comparison['rate']:.2f}명 · 유사 5곳 중앙값 {comparison['median']:.2f}명**")
            st.caption(f"선택 지역 − 중앙값: 수요군 B {focus['demand_b'] - comparison['demand']:+,}명 · "
                       f"1,000명당 {comparison['rate'] - comparison['median']:+.2f}명")
            if mode == "age":
                st.caption("비교 대상 수에 따른 중앙값 · " +
                           " · ".join(f"{size}곳 {value:.2f}명" for size, value in comparison["medians"].items()))
        else:
            st.caption("유사 지역의 수요 자료를 확인할 수 없습니다.")
    st.markdown("**다음에 확인할 것**")
    for note in follow_up(focus, bool(age_comparison and age_comparison["sensitive"])):
        st.write(note)
