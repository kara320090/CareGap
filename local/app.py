from decimal import Decimal
from functools import partial
import hashlib
from pathlib import Path
from sqlite3 import Error as DatabaseError
import sys
sys.path.insert(0, str(Path(__file__).parent / "src"))

import altair as alt
import pandas as pd
import streamlit as st
from caregap.data import prepare_regions, summarize_welfare
from caregap.boundaries import load_boundaries, join_regions
from caregap.optimization import calculate_alternatives, make_areas, scale_unit_costs
from caregap.clustering import analyze_clusters, cluster_exclusion_reason
from caregap.population import POPULATION_SOURCE, load_population, population_context
from caregap.regional_context import HOUSEHOLDS_SOURCE, demographic_values, load_regional_context
from caregap.welfare_guide import render_welfare_guide
from caregap.region_detail import render_region_detail, select_map_region, select_table_region, set_detail_region
from caregap.reporting import bundle, inputs, fingerprint, json_bytes, csv_bytes, html_bytes
from caregap.scenario_comparison import compare_results
from caregap import __version__, revisions, storage

ALLOCATION_STATUS = {
    "OPTIMAL": "최적해 확인 (OPTIMAL)", "BASELINE": "기준 대안 (BASELINE)",
    "FEASIBLE": "제약을 만족하는 해 (FEASIBLE)", "UNKNOWN": "제한 시간 내 해 미확인 (UNKNOWN)",
    "INFEASIBLE": "제약을 만족하는 해 없음 (INFEASIBLE)", "MODEL_INVALID": "모형 또는 결과 오류 (MODEL_INVALID)",
    "INPUT_ERROR": "입력 오류 (INPUT_ERROR)", "NO_DATA": "계산 대상 없음 (NO_DATA)",
}

st.set_page_config(page_title="CareGap | 지역 복지 현황", page_icon="🌱", layout="wide")
st.markdown("""<style>
.block-container{padding-top:4rem;max-width:1500px}h1{letter-spacing:-1.4px}h2,h3{letter-spacing:-.6px}
[data-testid="stMetric"]{background:#f0f6f3;border:1px solid #dce7e1;border-radius:12px;padding:16px 20px}
[data-testid="stMetricLabel"]{color:#52675e}[data-testid="stMetricValue"]{font-weight:650}
[data-testid="stSidebar"]{background:#f2f5f3}div.stButton>button[kind="primary"]{border-radius:8px}
.eyebrow{font-size:12px;letter-spacing:2px;font-weight:700;color:#167558}.intro{font-size:17px;color:#536960;max-width:880px;line-height:1.7}
</style>""", unsafe_allow_html=True)


@st.cache_data
def boundaries():
    return load_boundaries()


@st.cache_data
def clusters(rows, include_above):
    return analyze_clusters(rows, include_above)


def show_revision_error(error):
    st.error(str(error))
    try:
        revisions.record_failure(str(error))
    except (OSError, DatabaseError):
        st.caption("판본 저장소에 실패 이력을 기록하지 못했습니다.")


def to_won(manwon):
    amount = Decimal(str(manwon)) * 10000
    return int(amount) if amount == amount.to_integral_value() else None


def select_scope(provinces, districts=None):
    st.session_state["scope_provinces"] = provinces
    st.session_state["scope_regions"] = districts or []


def format_source_cells(rows, missing_markers):
    return pd.DataFrame([
        {"지역": row["region_id"], "수요 원본 셀": f"C{row['source_row']}", "이용자 원본 셀": f"E{row['source_row']}",
         "수요군 B": row["demand_b"], "연간 이용자": row["annual_users"],
         "미상 원본 표기": missing_markers.get(row["region_id"], "—"), "자료 경고": " / ".join(row["flags"])}
        for row in rows
    ])

@st.cache_data
def population_snapshot():
    return load_population()["regions"]


@st.cache_data
def regional_context_snapshot(counts):
    return load_regional_context(counts)

with st.expander("기본 복지 안내 · 서비스 검색·비교·신청 경로·기관 찾기", expanded=True):
    render_welfare_guide()

try:
    data = revisions.active_dataset()
except FileNotFoundError as exc:
    if Path(exc.filename).name == "regions.json":
        st.info("전국 돌봄 통계는 원본 자료를 준비한 뒤 이용할 수 있습니다. 위 복지서비스 안내는 바로 사용할 수 있습니다.")
        st.markdown("[보건복지부 원본 안내](https://www.mohw.go.kr/board.es?act=view&bid=0073&list_no=1492217&mid=a60401000000)에서 부가통계 XLSX를 받아 `data/source.xlsx`로 두세요.")
        st.code(r".\.venv\Scripts\python.exe scripts/import_source.py", language="powershell")
        st.caption("변환이 끝나면 이 화면을 새로고침하세요.")
    else:
        st.error(f"자료 검증 실패: {exc}")
    st.stop()
except (ValueError, KeyError, TypeError, OSError, DatabaseError) as exc:
    st.error(f"자료 검증 실패: {exc}")
    st.stop()
records, meta = data["regions"], data["metadata"]
source_cells = partial(format_source_cells, missing_markers=data["audit"].get("missing_user_markers", {}))
records_by_id = {row["region_id"]: row for row in records}
try:
    population_by_id = population_snapshot()
    if set(population_by_id) != set(records_by_id):
        raise ValueError("복지 자료와 고령인구 자료의 지역이 일치하지 않습니다.")
except (ValueError, KeyError, TypeError, OSError):
    population_by_id = {}
try:
    regional_context = regional_context_snapshot(population_by_id)
except (ValueError, KeyError, TypeError, OSError):
    regional_context = {}
province_options = list(dict.fromkeys(r["province"] for r in records))

if "pending_restore" in st.session_state:
    restored = st.session_state.pop("pending_restore")
    area_params = restored["parameters"]["areas"]
    selected_ids = {a["region_id"] for a in area_params} | {r["region_id"] for r in restored["excluded"]}
    st.session_state["scope_provinces"] = [p for p in province_options if any(r["province"] == p and r["region_id"] in selected_ids for r in records)]
    st.session_state["scope_regions"] = sorted(selected_ids)
    st.session_state["budget_man"] = restored["parameters"]["budget_won"] / 10000
    if area_params:
        a = area_params[0]
        st.session_state.update(p_default=a["productivity"], cost_man=a["cost"] / 10000, upper_default=a["upper"])
        st.session_state["restore_defaults"] = (a["productivity"], a["cost"], a["upper"])
    st.session_state["restore_areas"] = {a["region_id"]: a for a in area_params}
    st.session_state["restore_notice"] = True
    st.session_state["editor_revision"] = st.session_state.get("editor_revision", 0) + 1

with st.sidebar:
    st.markdown("### CareGap")
    st.caption("hybon · 지역 복지 현황과 정책 검토")
    st.divider()
    st.markdown("**01  지역 선택**")
    st.caption("시도를 고르고, 필요한 경우 시군구까지 좁혀 보세요.")
    with st.expander("검증 사례로 시작하기"):
        st.button("인천 중구·옹진군", key="demo_incheon", on_click=select_scope,
                  args=(["인천광역시"], ["인천광역시 중구", "인천광역시 옹진군"]))
        st.button("충남 15개 시군구", key="demo_chungnam", on_click=select_scope, args=(["충청남도"],))
        st.button("전국 보기", key="demo_national", on_click=select_scope, args=(province_options,))
    provinces = st.multiselect("시도 선택", province_options, default=province_options, key="scope_provinces")
    region_options = sorted(r["region_id"] for r in records if r["province"] in provinces)
    if "scope_regions" in st.session_state:
        st.session_state["scope_regions"] = [r for r in st.session_state["scope_regions"] if r in region_options]
    regions = st.multiselect("시군구 선택 · 비우면 선택 시도 전체", region_options, key="scope_regions")
    selected = [r for r in records if r["province"] in provinces and (not regions or r["region_id"] in regions)]
    st.caption(f"선택 {len(selected):,}개 지역 / 전국 {len(records):,}개")
    st.divider()
    st.caption(f"자료 판본 · {meta['dataset_version']}\n\n연간 이용자 2025년 · 수요군 B 세부 기준일 미확인")
    st.divider()
    with st.expander("02  배분 시뮬레이션 가정"):
        budget_man = st.number_input("추가 연간 예산 (만원)", min_value=0.0, max_value=100000000.0, value=10000.0, step=1000.0, format="%.4f", key="budget_man")
        p_default = st.number_input("자원 1단위당 연간 추가 모형 이용자", 1, 10000, 4, key="p_default")
        cost_man = st.number_input("자원 1단위 연간 비용 (만원)", min_value=0.0001, max_value=1000000.0, value=3000.0, step=100.0, format="%.4f", key="cost_man")
        upper_default = st.number_input("지역별 최대 자원 단위 기본값", 0, 10000, 15, key="upper_default")
        st.caption("기본값은 시연용 가정입니다. 실제 인건비·인력 생산성·운영 한계가 아닙니다.")

selected_ids = [row["region_id"] for row in selected]
if st.session_state.get("detail_region_id") not in selected_ids:
    set_detail_region(selected_ids[0] if len(selected_ids) == 1 else None)
if st.session_state.get("detail_peer_region") not in records_by_id:
    st.session_state["detail_peer_region"] = None
valid, excluded = prepare_regions(selected)
budget = to_won(budget_man)
default_cost = to_won(cost_man)
st.markdown('<div class="eyebrow">CAREGAP · 지역 복지 현황</div>', unsafe_allow_html=True)
st.title("지역별 노인돌봄 수요와 이용 현황")
st.markdown('<p class="intro">노인맞춤돌봄서비스의 지역별 수요와 이용을 살펴보고, 공개 원자료에서 수치의 근거를 확인할 수 있습니다.</p>', unsafe_allow_html=True)
st.markdown("**① 왼쪽에서 지역 선택  →  ② 현황 표·지도 비교  →  ③ 자료와 검증에서 출처 확인**")
with st.container(border=True):
    st.markdown(
        f"**출처·기준일·지표 정의**\n\n"
        f"- **수요군 B** · [보건복지부 실태조사]({meta['source_url']}) 부가통계 {meta['sheet']} C열. "
        "통합돌봄 핵심군 중 장기요양 미인정·독거 고령층의 추정 집계입니다. 지역계획 표 작성 기준은 2025년 12월 말이며, 수요군 조건별 세부 판정일은 미상입니다.\n"
        "- **연간 이용자와 이용 대 수요 비율** · 같은 시트 E열. 2025년 1~12월 1회 이상 이용한 중점관리군입니다. "
        "비율은 연간 이용자 ÷ 수요군 B이며, 집계 비율에는 이용값이 확인되고 수요가 양수인 지역만 포함합니다.\n"
        f"- **65세 이상 인구와 1,000명당 수요군 B** · [행정안전부 주민등록인구]({POPULATION_SOURCE}), 2025년 12월 31일. "
        "같은 지역의 수요군 B 합계 ÷ 65세 이상 주민등록인구 합계 × 1,000입니다. 인구 규모를 감안한 비교 지표입니다.\n"
        f"- **연령 구조·1인세대·인구 변화** · 80세 이상 인구와 [65세 이상 주민등록 1인세대]({HOUSEHOLDS_SOURCE})를 각각 2025년 말 65세 이상 인구로 나눕니다. "
        "1인세대는 주민등록 기준입니다. 인구 증감은 2025년 말 인구에서 2024년 말 인구를 빼고, 증감률은 그 차이를 2024년 말 인구로 나눕니다."
    )
    if not population_by_id:
        st.warning("고령인구 자료를 확인하지 못해 인구 보조 지표를 표시할 수 없습니다.")
cols = st.columns(4)
cols[0].metric("선택 지역", f"{len(selected):,}개", help="원자료의 17개 시도 합계 행을 제외한 시군구")
cols[1].metric("수요군 B 합계", f"{sum(r['demand_b'] for r in selected):,}명" if selected else "—", help="원자료가 정의한 노인맞돌 수요군. 실제 대기자 수가 아닙니다.")
missing_users = sum(r["annual_users"] is None for r in selected)
known_users = [r["annual_users"] for r in selected if r["annual_users"] is not None]
users_label = f"{sum(known_users):,}명" if known_users else "미상" if selected else "—"
cols[2].metric("확인된 연간 이용자 합계", users_label, help="확인된 수치만 합산합니다. 선택 지역의 이용값이 모두 결측이면 미상으로 표시합니다.")
above_demand = sum(r["raw_ratio"] is not None and r["raw_ratio"] > 1 for r in selected)
cols[3].metric("이용 미상 / 비율 100% 초과", f"{missing_users} / {above_demand}", help="이용자 수가 미상인 지역과 원자료 이용자 수가 수요군보다 큰 지역의 수입니다.")
older_total, demand_per_1000 = population_context(selected, population_by_id)
context_cols = st.columns(2)
context_cols[0].metric("65세 이상 주민등록인구", f"{older_total:,}명" if older_total is not None else "—")
context_cols[1].metric("65세 이상 인구 1,000명당 수요군 B",
                       f"{demand_per_1000:,.2f}명" if demand_per_1000 is not None else "—")
st.info("수요군 B는 돌봄 수요의 추정 집계입니다. 지역 비율은 연간 이용자 수를 수요군 B로 나눈 값이며, 두 집단의 중복 인원은 미상입니다.", icon="ℹ️")
overview, region_map, quality, types, comparison, history = st.tabs(
    ["현황 살펴보기", "지역 지도", "자료와 검증", "지역 유형 분석", "배분 대안 비교", "시나리오 기록"]
)

with overview:
    st.subheader("선택 지역의 수요군과 이용 지표")
    st.markdown('<span id="regional-overview"></span>', unsafe_allow_html=True)
    if missing_users:
        st.caption(f"이용자 수 미상 {missing_users:,}곳 · 표의 자료 경고와 지도에서 확인할 수 있습니다.")
    st.caption("점 하나가 지역 하나입니다. 이용자 수가 미상인 지역은 도표에서 제외합니다. 100%를 넘는 원값도 그대로 표시합니다.")
    chart_rows = [{"지역": r["region_id"], "수요군 B": r["demand_b"], "원자료 비율": r["raw_ratio"], "이용자": r["annual_users"]} for r in selected if r["raw_ratio"] is not None]
    if chart_rows:
        chart = alt.Chart(pd.DataFrame(chart_rows)).mark_circle(size=90, opacity=.7, color="#16805e").encode(
            x=alt.X("수요군 B:Q", title="수요군 B (명)"), y=alt.Y("원자료 비율:Q", axis=alt.Axis(format=".0%"), title="연간 이용자 / 수요군 B"),
            tooltip=["지역:N", "수요군 B:Q", "이용자:Q", alt.Tooltip("원자료 비율:Q", format=".2%")]).properties(height=330)
        st.altair_chart(chart, width="stretch")
    elif selected:
        st.info("선택 지역의 비율을 계산할 수 없습니다. 아래 표에서 이용값과 자료 경고를 확인하세요.")
    else:
        st.info("왼쪽에서 시도 또는 시군구를 선택하세요.")
    with st.expander("현황표에서 지역 찾기", expanded=True):
        search_col, flag_col, sort_col = st.columns(3)
        query = "".join(search_col.text_input("시도·시군구 검색").split())
        flag = flag_col.selectbox("자료 표시 필터", ["전체", "이용자 수 미상", "100% 초과"])
        sort = sort_col.selectbox("현황표 정렬", ["기본 순서", "고령인구 증감 인원", "65세 이상 1인세대 비중"])
    visible_rows = []
    for row in selected:
        name = "".join(row["region_id"].split())
        compact_name = name
        for suffix in ("특별자치시", "특별자치도", "특별시", "광역시"):
            compact_name = compact_name.replace(suffix, "")
        if query not in name and query not in compact_name:
            continue
        if flag == "이용자 수 미상" and row["annual_users"] is not None:
            continue
        if flag == "100% 초과" and not (row["raw_ratio"] is not None and row["raw_ratio"] > 1):
            continue
        visible_rows.append(row)
    sort_key = {"고령인구 증감 인원": "change", "65세 이상 1인세대 비중": "single_share"}.get(sort)
    if sort_key and regional_context:
        visible_rows.sort(key=lambda row: (-demographic_values(row["region_id"], population_by_id, regional_context)[sort_key],
                                           row["region_id"]))
    st.caption(f"현황표 {len(visible_rows):,}곳 · 지도와 배분에는 왼쪽에서 선택한 범위를 사용합니다.")
    display_rows = []
    for row in visible_rows:
        population, rate = population_context([row], population_by_id)
        demographics = demographic_values(row["region_id"], population_by_id, regional_context) or {}
        display_rows.append({
            "지역": row["region_id"], "수요군 B": row["demand_b"], "연간 이용자": row["annual_users"],
            "원자료 비율": row["raw_ratio"], "자료 경고": " / ".join(row["flags"]) or "없음",
            "65세 이상 인구": population, "65세 이상 인구 1,000명당 수요군 B": rate,
            "80세 이상 인구": demographics.get("age80"), "80세 이상 비중": demographics.get("age_share"),
            "65세 이상 1인세대": demographics.get("single65"), "65세 이상 1인세대 비중": demographics.get("single_share"),
            "고령인구 증감": demographics.get("change"), "고령인구 증감률": demographics.get("growth"),
        })
    display = pd.DataFrame(display_rows)
    if display.empty:
        if selected:
            st.info("검색어와 자료 표시 조건에 맞는 지역이 없습니다.")
    else:
        st.dataframe(
            display, hide_index=True, width="stretch",
            column_config={
                "원자료 비율": st.column_config.NumberColumn(format="percent"),
                "65세 이상 인구": st.column_config.NumberColumn(format="localized"),
                "65세 이상 인구 1,000명당 수요군 B": st.column_config.NumberColumn(format="%.2f"),
                "80세 이상 비중": st.column_config.NumberColumn(format="percent"),
                "65세 이상 1인세대 비중": st.column_config.NumberColumn(format="percent"),
                "고령인구 증감률": st.column_config.NumberColumn(format="percent"),
            },
            key="region_detail_table", selection_mode="single-row",
            on_select=lambda: select_table_region("region_detail_table", [row["region_id"] for row in visible_rows]),
        )
    render_region_detail("overview", selected_ids, records_by_id, meta, source_cells, population_by_id, regional_context)
    aggregated = []
    for province in provinces:
        subset = [r for r in selected if r["province"] == province]
        if not subset:
            continue
        summary = summarize_welfare(subset)
        aggregated.append({"시도": province, "선택 지역 수": len(subset), "총수요군 B": summary["demand"],
                           "확인 이용자 합계": summary["users"], "비율 집계 지역 수": summary["eligible_count"], "이용자 미상 지역 수": summary["unknown_count"],
                           "집계 지역 수요군 B": summary["ratio_demand"], "집계 지역 연간 이용자": summary["ratio_users"],
                           "집계 지역 원자료 비율": summary["ratio"]})
    if selected:
        with st.expander("선택 지역의 원본 근거"):
            st.caption(f"보건복지부 부가통계 {meta['sheet']} · C열 수요군 B · E열 연간 이용자")
            st.caption("시도 비교 비율은 이용값이 확인되고 수요가 양수인 지역의 이용자 합계를 같은 지역의 수요 합계로 나눕니다.")
            if len(aggregated) == 1:
                area = aggregated[0]
                ratio = area["집계 지역 원자료 비율"]
                if ratio is not None:
                    st.markdown(f"**{area['시도']} 시도 비교 비율 {ratio:.2%}** · "
                                f"{area['집계 지역 연간 이용자']:,}명 ÷ {area['집계 지역 수요군 B']:,}명 "
                                f"(비율 집계 {area['비율 집계 지역 수']:,}곳)")
                else:
                    st.caption("선택 범위에서 비율을 집계할 수 있는 지역이 없습니다.")
            cells = source_cells(selected)
            cells["연간 이용자"] = cells["연간 이용자"].astype("Int64").astype("string").fillna("미상")
            if len(cells) <= 12:
                st.table(cells, hide_index=True)
            else:
                st.dataframe(cells, hide_index=True, width="stretch")
    with st.expander("시도별 원자료 지표 비교"):
        if aggregated:
            af = pd.DataFrame(aggregated)
            chart_data = af.dropna(subset=["집계 지역 원자료 비율"])
            if not chart_data.empty:
                st.altair_chart(alt.Chart(chart_data).mark_bar(color="#16805e").encode(x=alt.X("집계 지역 원자료 비율:Q", axis=alt.Axis(format=".0%")),
                                y=alt.Y("시도:N", sort="-x"), tooltip=list(af.columns)).properties(height=max(120, 28 * len(chart_data))), width="stretch")
            st.caption("분자와 분모에 같은 지역을 집계합니다. 이용값이 확인되고 수요가 양수인 선택 지역만 비율 계산에 포함합니다.")
            st.dataframe(af, hide_index=True, width="stretch", column_config={"집계 지역 원자료 비율": st.column_config.NumberColumn(format="percent")})

with region_map:
    st.subheader("선택 지역의 돌봄 지표 지도")
    st.caption("지도의 지역을 클릭하면 아래 상세 비교에서 볼 수 있습니다. 회색은 해당 지표가 미상인 지역입니다.")
    metric_options = {"raw_ratio": "원자료 이용 대 수요 비율", "demand_b": "수요군 B", "annual_users": "연간 이용자"}
    metric = st.radio("지도 지표", list(metric_options), format_func=metric_options.get, horizontal=True)
    try:
        boundary_index, boundary_meta = boundaries()
        features, unmatched = join_regions(selected, boundary_index, metric)
    except (OSError, ValueError, KeyError) as exc:
        st.warning(f"지도 자료를 읽지 못했습니다. {exc}")
    else:
        st.caption(
            f"경계 기준일 {boundary_meta['boundary_date']} · SGIS 통계지역코드 · 연결 {len(features)}/{len(selected)}개"
        )
        if unmatched:
            st.warning("경계를 연결하지 못한 지역 · " + ", ".join(unmatched))
        if features:
            number_format = ".2%" if metric == "raw_ratio" else ",.0f"
            for feature in features:
                props = feature["properties"]
                value = props["value"]
                feature["region_id"] = props["region_id"]
                feature["value_missing"] = value is None
                props["display_value"] = "미상" if value is None else format(value, number_format)
            tooltip = [
                alt.Tooltip("properties.region_id:N", title="지역"),
                alt.Tooltip("properties.display_value:N", title=metric_options[metric]),
                alt.Tooltip("properties.sgis_label:N", title="SGIS 코드"),
                alt.Tooltip("properties.warnings:N", title="자료 경고"),
            ]
            region_point = alt.selection_point(name="region_point", fields=["region_id"], on="click", toggle=False)
            color = alt.Color("properties.value:Q", title=metric_options[metric],
                              scale=alt.Scale(scheme="teals"), legend=alt.Legend(format=number_format))
            chart = (
                alt.Chart(alt.Data(values=features))
                .mark_geoshape(stroke="#526873", strokeWidth=0.45, invalid=None, cursor="pointer")
                .encode(color=alt.condition("datum.value_missing === true", alt.value("#c1c9ce"), color),
                        tooltip=tooltip)
                .add_params(region_point).project(type="mercator").properties(height=530)
            )
            st.altair_chart(
                chart, width="stretch", key="region_detail_map", selection_mode="region_point",
                on_select=lambda: select_map_region("region_detail_map"),
            )
        else:
            st.info("경계를 표시할 지역을 선택하세요.")
        st.caption("복지 집계 단위에 맞춰 일반구 경계를 병합했습니다. 화면용 간략화 경계입니다.")
        st.link_button("SGIS 경계 원자료", boundary_meta["source_url"])
    render_region_detail("map", selected_ids, records_by_id, meta, source_cells, population_by_id, regional_context)

with comparison:
    st.subheader("같은 조건으로, 세 가지 대안")
    st.caption(f"현황과 같은 선택 범위 {len(selected):,}곳에서 계산합니다.")
    st.caption("정책 검토용 기능입니다. 왼쪽의 배분 시뮬레이션 가정에서 예산과 단가를 설정한 뒤 대안을 비교할 수 있습니다.")
    st.write("형평성 우선은 최저 모형 비율 → 추가 모형 이용자 → 비용 순서로 계산합니다. 수요 비례와 부족분 우선에도 동일한 예산·지역별 한계를 적용합니다.")
    st.caption(f"선택 지역 {len(selected):,}개 · 배분 계산 대상 {len(valid):,}개 · 제외 {len(excluded):,}개")
    if excluded:
        with st.expander("배분 계산 제외 사유"):
            st.dataframe(pd.DataFrame(excluded).rename(columns={
                "region_id": "지역", "reason": "배분 제외 사유", "source_row": "원본 행",
            }), hide_index=True, width="stretch")
    with st.expander("지역별 가정 조정", expanded=False):
        st.caption("자원 단위는 가상의 추가 투입량입니다. 실제 직원 수로 해석하지 마세요. 아래 표의 네 가지 가정만 편집할 수 있습니다.")
        if st.session_state.get("restore_defaults", (p_default, default_cost, upper_default)) != (p_default, default_cost, upper_default):
            st.session_state.pop("restore_areas", None)
            st.session_state.pop("restore_defaults", None)
        restored_params = st.session_state.get("restore_areas", {})
        param_rows = []
        for r in valid:
            old = restored_params.get(r["region_id"], {})
            param_rows.append({"지역": r["region_id"], "연간 추가 모형 이용자": old.get("productivity", p_default),
                               "연간 단위 비용 원": old.get("cost", default_cost), "최소 자원 단위": old.get("lower", 0),
                               "최대 자원 단위": old.get("upper", upper_default)})
        editor_key = f"params_{fingerprint(param_rows)[:16]}_{st.session_state.get('editor_revision', 0)}"
        edited = st.data_editor(pd.DataFrame(param_rows, columns=["지역", "연간 추가 모형 이용자", "연간 단위 비용 원", "최소 자원 단위", "최대 자원 단위"]),
                                disabled=["지역"], hide_index=True, width="stretch", height=300, key=editor_key,
                                column_config={k: st.column_config.NumberColumn(step=1, required=True) for k in ["연간 추가 모형 이용자", "연간 단위 비용 원", "최소 자원 단위", "최대 자원 단위"]})
        if restored_params and st.button("복원한 지역별 가정 초기화"):
            st.session_state.pop("restore_areas", None)
            st.session_state["editor_revision"] += 1
            st.rerun()
    error = None
    try:
        if budget is None or default_cost is None:
            raise ValueError("예산과 기본 단가는 원 단위로 입력하세요. 만원 단위 입력란은 소수점 넷째 자리까지 허용합니다.")
        areas = make_areas(valid, edited.to_dict("records"))
        current_hash = fingerprint(inputs(meta, areas, budget, excluded))
    except (ValueError, TypeError, KeyError) as exc:
        areas, current_hash, error = [], None, str(exc)
        st.error(error)
    if st.session_state.pop("restore_notice", False):
        st.success("저장된 지역·예산·개별 가정을 복원했습니다. 다시 계산해 결과를 확인하세요.")
    if st.button("세 가지 배분 대안 계산", type="primary", disabled=bool(error) or not areas):
        with st.spinner("동일한 제약 아래 대안을 계산하고 있습니다…"):
            results = calculate_alternatives(areas, budget)
            st.session_state["report"] = bundle(meta, areas, budget, results, excluded, provenance=valid)
    report = st.session_state.get("report")
    current = report is not None and report["input_sha256"] == current_hash
    if report and not current:
        st.warning("입력 조건이 바뀌었습니다. 이전 결과의 표시·저장·다운로드를 중단했습니다. 다시 계산하세요.")
    if current:
        summaries, alternatives = [], []
        for result in report["results"]:
            metrics = result["metrics"]
            alternatives.append({
                "대안": result["method"], "계산 상태": ALLOCATION_STATUS.get(result["status"], result["status"]),
                "최저 모형 비율": f"{metrics['minimum_ratio']:.2%}" if metrics else "—",
                "추가 모형 이용자": f"{metrics['additional_model_users']:,}명" if metrics else "—",
                "사용 예산": f"{metrics['cost']:,}원" if metrics else "—",
            })
            summaries.extend({"대안": result["method"], "지역": r["region_id"], "자원 단위": r["units"], "추가 모형 이용자": r["additional_model_users"], "비용 원": r["cost"], "전 모형 비율": r["before_ratio"], "후 모형 비율": r["after_ratio"]} for r in result["rows"])
        st.table(pd.DataFrame(alternatives), hide_index=True)
        for result in report["results"]:
            for message in result["messages"]:
                st.warning(f"{result['method']} · {message}")
        st.caption("최저 비율은 0.01%p 단위로 비교합니다. 예산이 작으면 여러 저비율 지역을 동시에 개선하기 어려워 최저 비율은 그대로일 수 있습니다.")
        if summaries:
            frame = pd.DataFrame(summaries)
            nonzero = frame[frame["자원 단위"] > 0]
            if not nonzero.empty:
                st.altair_chart(alt.Chart(nonzero).mark_bar().encode(x=alt.X("자원 단위:Q", axis=alt.Axis(tickMinStep=1)),
                                y=alt.Y("지역:N", title=None), color=alt.Color("대안:N", scale=alt.Scale(range=["#16805e", "#477cb0", "#c18a3d"])),
                                yOffset="대안:N", tooltip=list(nonzero.columns)).properties(height=min(700, max(180, 55 * nonzero["지역"].nunique()))), width="stretch")
            st.dataframe(frame, hide_index=True, width="stretch", height=330,
                         column_config={k: st.column_config.NumberColumn(format="percent") for k in ["전 모형 비율", "후 모형 비율"]})
        with st.expander("계산 상태와 단계별 최적성 확인"):
            for result in report["results"]:
                if metrics := result["metrics"]:
                    st.caption(f"{result['method']} · 자원 {metrics['resource_units']:,}단위 · "
                               f"미사용 예산 {metrics['unspent_budget']:,}원 · 제약 위반 {metrics['constraint_violations']}건")
            phases = ("최저 비율 (0.01%p)", "추가 모형 이용자 (명)", "비용 (원)")
            stages = report["results"][0]["stages"]
            if stages:
                st.dataframe(pd.DataFrame([
                    {"단계": phases[stage["phase"] - 1], "상태": ALLOCATION_STATUS.get(stage["status"], stage["status"]),
                     "목표값": stage["objective"], "소요 시간 (초)": stage["seconds"], "제한 시간 (초)": stage["time_limit"]}
                    for stage in stages
                ]), hide_index=True, width="stretch")
            else:
                st.caption("입력과 제약을 확인한 단계에서 계산을 종료했습니다.")
        st.markdown("**검토 기록 내려받기**")
        st.caption(f"입력 지문 · {report['input_sha256']}")
        exports = st.columns(3)
        exports[0].download_button("전체 입력·결과 JSON", json_bytes(report), "caregap_scenario.json", "application/json", on_click="ignore")
        exports[1].download_button("지역별 비교 CSV", csv_bytes(report), "caregap_comparison.csv", "text/csv", on_click="ignore")
        exports[2].download_button("검토 보고서 HTML", html_bytes(report), "caregap_report.html", "text/html", on_click="ignore")
        name = st.text_input("시나리오 이름", max_chars=80, placeholder="예: 1억원 · 생산성 4 · 전국")
        if st.button("현재 시나리오 저장", disabled=not name.strip()):
            storage.save(report, name)
            st.success("이 PC의 시나리오 기록에 저장했습니다.")

    with st.expander("기준 조건과 변경 조건 비교"):
        st.caption("현재 선택 지역과 지역별 가정이 기준입니다. 아래에서 예산 또는 단가 한 가지를 바꿀 수 있습니다.")
        dimension = st.radio("변경 항목", ["예산", "지역별 단가 일괄 배율"], horizontal=True, key="compare_dimension")
        changed_areas, changed_budget = areas, budget
        comparison_error = None
        if dimension == "예산":
            changed_man = st.number_input("변경 연간 예산 (만원)", min_value=0.0, max_value=100000000.0,
                                          value=0.0, step=1000.0, format="%.4f", key="compare_budget_man")
            changed_budget = to_won(changed_man)
            if changed_budget is None:
                comparison_error = "변경 예산은 원 단위로 입력하세요."
            change_label = f"연간 예산 {changed_budget:,}원" if changed_budget is not None else ""
        else:
            scale = st.number_input("지역별 단가 배율 (%)", min_value=1.0, max_value=1000.0, value=120.0,
                                    step=1.0, format="%.2f", key="compare_cost_scale")
            change_label = f"지역별 단가 {scale:g}%"
            try:
                changed_areas = scale_unit_costs(areas, scale)
            except ValueError as exc:
                comparison_error = str(exc)
        if comparison_error:
            st.error(comparison_error)
        if budget is not None:
            st.caption(f"기준 연간 예산 {budget:,}원 · 변경 조건 {change_label or '입력 오류'}")
        can_compare = current_hash is not None and bool(areas) and not comparison_error
        if can_compare:
            changed_hash = fingerprint(inputs(meta, changed_areas, changed_budget, excluded))
            comparison_key = (current_hash, changed_hash, dimension, change_label)
        else:
            comparison_key = None
        scenario = st.session_state.get("sensitivity_result")
        if scenario and scenario[0] != comparison_key:
            st.session_state.pop("sensitivity_result")
            scenario = None
            st.warning("비교 조건이 바뀌었습니다. 기준과 변경 조건을 다시 계산하세요.")
        if st.button("기준과 변경 조건 계산", disabled=not can_compare):
            with st.spinner("두 조건에서 세 가지 대안을 비교하고 있습니다…"):
                reference = report["results"] if current else calculate_alternatives(areas, budget)
                changed = reference if changed_hash == current_hash else calculate_alternatives(changed_areas, changed_budget)
                scenario = (comparison_key, reference, changed)
                st.session_state["sensitivity_result"] = scenario
        if scenario:
            _, reference, changed = scenario
            summaries, differences = compare_results(reference, changed, ALLOCATION_STATUS)
            st.table(pd.DataFrame(summaries), hide_index=True)
            st.caption("비율 차이는 반올림 전 값으로 계산합니다. 순위는 최저 모형 비율(0.01%p 단위), 추가 모형 이용자, 낮은 비용 순이며, 비교 가능한 결과가 모두 있을 때 매깁니다.")
            for condition, results in (("기준", reference), ("변경", changed)):
                for result in results:
                    for message in result["messages"]:
                        st.warning(f"{condition} · {result['method']} · {message}")
            if differences:
                st.markdown("**배분이 달라진 지역**")
                st.dataframe(pd.DataFrame(differences), hide_index=True, width="stretch")
            elif all(result["rows"] for result in [*reference, *changed]):
                st.caption("배분 단위가 바뀐 지역이 없습니다.")
            else:
                st.caption("양쪽에 배분 결과가 있는 대안만 지역별 차이를 계산할 수 있습니다.")

with types:
    st.subheader("비슷한 지표를 가진 지역 묶기")
    st.write("현황을 비교한 뒤 수요 규모와 원자료 비율이 비슷한 지역을 함께 살펴봅니다. 유형은 정책 우열이나 지원 자격을 판정하지 않습니다.")
    st.caption("수요군 B는 로그 변환한 뒤 사용합니다. 로그값과 이용 대 수요 비율을 각각 표준화해 두 지표의 단위 차이를 줄입니다.")
    include_above = st.checkbox("100% 초과 지역도 포함해 민감도 확인", value=False)
    cluster_hash = fingerprint({"ids": [r["region_id"] for r in selected], "include_above": include_above, "source": meta["dataset_sha256"]})
    if st.button("선택 지역 유형 분석"):
        with st.spinner("K=2~5 후보와 세 가지 난수 시드를 비교합니다…"):
            st.session_state["cluster_result"] = (cluster_hash, clusters(selected, include_above))
    cr = st.session_state.get("cluster_result")
    if cr and cr[0] == cluster_hash:
        c = cr[1]
        if c["status"] != "OK":
            valid_count = sum(cluster_exclusion_reason(row, include_above) is None for row in selected)
            st.warning(f"{c['message']} 선택 {len(selected)}곳 · 유효 {valid_count}곳 · 제외 {len(selected) - valid_count}곳")
        else:
            a, b, d = st.columns(3)
            a.metric("선택한 유형 수", c["chosen_k"])
            b.metric("평균 실루엣", f"{max(x['mean_silhouette'] for x in c['candidates']):.3f}")
            d.metric("시드 간 평균 ARI", f"{c['seed_ari']:.3f}")
            st.caption(f"유형 분석에 사용한 지역 {len(c['rows']):,}개 / 선택 {len(selected):,}개")
            st.caption("ARI는 반복 실행 간 묶음의 일치도입니다. 원자료 사분면과 일치하는 정도를 정답률로 해석하지 않습니다.")
            cf = pd.DataFrame(c["rows"])
            plot = alt.Chart(cf).mark_circle(size=95, opacity=.75).encode(x=alt.X("demand_b:Q", title="수요군 B"),
                    y=alt.Y("raw_ratio:Q", title="원자료 비율", axis=alt.Axis(format=".0%")), color=alt.Color("cluster:N", title="유형"), tooltip=["region_id:N", "cluster:N", "demand_b:Q", alt.Tooltip("raw_ratio:Q", format=".2%")]).properties(height=330)
            st.altair_chart(plot, width="stretch")
            st.dataframe(pd.DataFrame(c["profiles"]).rename(columns={"cluster": "유형", "regions": "지역 수", "median_demand": "수요군 중앙값", "median_raw_ratio": "원자료 비율 중앙값"}), hide_index=True, width="stretch",
                         column_config={"원자료 비율 중앙값": st.column_config.NumberColumn(format="percent")})
            st.caption(f"각 후보를 시드별 {c['n_init']}회 초기화해 비교합니다.")
            st.dataframe(pd.DataFrame([
                {"후보 유형 수": candidate["k"], "평균 실루엣": candidate["mean_silhouette"],
                 **{f"시드 {seed}": score for seed, score in candidate["scores_by_seed"].items()}}
                for candidate in c["candidates"]
            ]), hide_index=True, width="stretch")
            with st.expander("지역 유형·원자료 사분면 교차표"):
                quadrant = cf["source_quadrant"].astype("Int64").astype("string").fillna("미상")
                st.dataframe(pd.crosstab(cf["cluster"], quadrant), width="stretch")
                st.dataframe(cf, hide_index=True, width="stretch")
            st.download_button("유형 분석 JSON", json_bytes(c), "caregap_clusters.json", "application/json")
        excluded_types = [
            {"지역": row["region_id"], "유형 제외 사유": reason}
            for row in selected if (reason := cluster_exclusion_reason(row, include_above)) is not None
        ]
        with st.expander(f"유형 분석 제외 지역 {len(excluded_types)}개"):
            if excluded_types:
                st.dataframe(pd.DataFrame(excluded_types), hide_index=True, width="stretch")
            else:
                st.caption("제외 지역이 없습니다.")
    elif cr:
        st.caption("범위 또는 초과값 포함 설정이 바뀌었습니다. 유형 분석을 다시 실행하세요.")

with quality:
    st.subheader("자료를 해석하기 전에")
    st.markdown("""- **수요군 B**는 통합돌봄 핵심군 중 장기요양 미인정이면서 독거인 고령층의 추정 집계입니다. 실제 신청·대기 인원과는 집계 기준이 다릅니다. 지역계획 표는 2025년 12월 말 기준이며, 독거와 미인정 조건의 개별 판정일은 미상입니다.
- **연간 이용자**는 2025년 1~12월에 한 번 이상 서비스를 이용한 중점관리군의 집계입니다.
- **생활지원사 수**는 보고서에서 연간 이용자 수를 4로 나눠 환산했습니다.
- **미상**은 원본의 빈칸 또는 대시를 뜻합니다. 현황에 미상으로 표시하고 배분 계산에서는 해당 지역을 제외합니다.
- **100% 초과**는 연간 이용자 수가 수요군 B보다 큰 경우입니다. 현황에서 원래 비율을 보여 주고 배분 모형에서만 기준량을 수요군 B 이하로 제한합니다.""")
    st.caption(f"부가통계 {meta['sheet']}의 C열과 E열 · 조사 요약본 137~138쪽, 표 5-3-13")
    st.link_button("보건복지부 지역사회 통합돌봄 실태조사", meta["source_url"])
    with st.expander("비율 계산과 자료 확인 범위"):
        st.markdown("""보고서의 표 5-3-13은 연간 이용자 수를 수요군 B로 나눕니다. 기본 판본의 부여군은 407명 ÷ 391명으로 **104.09%**입니다. 공개된 두 집계만으로 수요군 B 안에서 실제 서비스를 이용한 인원을 계산할 수 없습니다.

시제품에서는 두 공개 집계를 지역 단위로 비교합니다. 수요군 조건별 세부 판정일, 두 집단의 중복 인원과 지역 귀속 방식은 확인할 수 없어 미상으로 관리합니다.""")
        st.link_button("시군구 지역계획 작성 기준과 별지", "https://www.mohw.go.kr/board.es?act=view&bid=0073&list_no=1492242&mid=a60401000000")
    audit = data["audit"]
    with st.expander("전국 자료 점검 내역"):
        st.caption(f"수요군 B {audit['demand_b_sum']:,}명 · 확인 이용자 {audit['known_annual_users_sum']:,}명 · 이용 미상 {len(audit['missing_users'])}개 지역")
        if audit["province_total_mismatches"]:
            st.warning("원본 시도 합계와 시군구 합계가 다른 지역 · " + ", ".join(audit["province_total_mismatches"]))
        st.caption("전국·시도·일반 및 인구감소지역 합계는 원본의 별도 행이며 지역별 조회와 계산에서 제외합니다.")
        st.dataframe(pd.DataFrame(audit["excluded_aggregates"]).rename(columns={
            "row": "원본 행", "name": "원본 집계 범위", "demand_b": "수요군 B", "annual_users": "연간 이용자",
        }), hide_index=True, width="stretch")
    with st.expander("원본 지문과 데이터 정의"):
        st.json(meta)
    with st.expander("현재 지역의 원본 셀과 값 확인"):
        st.dataframe(source_cells(selected), hide_index=True, width="stretch")
    with st.expander(f"전국 원자료 비율 100% 초과 {len(audit['above_demand'])}개 지역"):
        st.dataframe(pd.DataFrame([
            {"지역": r["region_id"], "수요군 B": r["demand_b"], "연간 이용자": r["annual_users"], "원자료 비율": r["raw_ratio"]}
            for r in records if r["region_id"] in audit["above_demand"]
        ]), hide_index=True, width="stretch", column_config={"원자료 비율": st.column_config.NumberColumn(format="percent")})
    if excluded:
        st.warning("현재 계산 제외 지역")
        st.dataframe(pd.DataFrame(excluded), hide_index=True, width="stretch")
    with st.expander("자료 판본 검증·갱신"):
        st.write("현재 자료 판본", meta["dataset_version"])
        st.caption("2025년 동일 지표·지역 구성의 XLSX 정정본을 비교합니다. 파일 지문, 열 정의, 지역 키와 전국·시도 합계를 대조합니다.")
        correction = st.file_uploader("2025년 정정 XLSX", type=["xlsx"], key="correction_workbook")
        expected_sha = st.text_input("사전 확인한 원본 SHA-256", max_chars=64, key="correction_sha").strip().lower()
        if st.button("정정본 검증", disabled=correction is None):
            st.session_state.pop("staged_correction", None)
            try:
                candidate = revisions.stage_update(correction.getvalue(), expected_sha)
                st.session_state["staged_correction"] = (candidate, meta["dataset_sha256"])
            except ValueError as exc:
                show_revision_error(exc)
        staged = st.session_state.get("staged_correction")
        if staged and correction and expected_sha == staged[0]["metadata"]["source_sha256"] == hashlib.sha256(correction.getvalue()).hexdigest():
            candidate, previous_sha = staged
            st.success("구조·지역·전국 및 시도 합계·파일 지문 검증 통과")
            measures = {"regions": "지역 수", "demand_b_sum": "수요군 B 합계",
                        "known_annual_users_sum": "확인 이용자 합계", "known_users_regions": "이용 확인 지역 수"}
            st.dataframe(pd.DataFrame([
                {"지표": label, "현재": data["audit"][key], "정정본": candidate["audit"][key]}
                for key, label in measures.items()
            ]), hide_index=True)
            st.caption("적용 시 현재 자료 판본이 바뀌며 배분 및 유형 분석은 다시 실행해야 합니다.")
            if st.button("검증한 판본 적용", type="primary"):
                try:
                    revisions.activate(correction.getvalue(), expected_sha, previous_sha)
                except (ValueError, OSError, DatabaseError) as exc:
                    show_revision_error(exc)
                else:
                    st.session_state.pop("staged_correction", None)
                    st.rerun()
        versions, changes = revisions.version_history()
        restore_options = [sha for sha in versions if sha != meta["dataset_sha256"]]
        if restore_options:
            restore_sha = st.selectbox("복원할 판본", restore_options, format_func=versions.get)
            if st.button("선택 판본 복원"):
                try:
                    revisions.restore(restore_sha, meta["dataset_sha256"])
                except (ValueError, OSError, DatabaseError) as exc:
                    show_revision_error(exc)
                else:
                    st.rerun()
        if changes:
            st.dataframe(pd.DataFrame([
                {"시각 UTC": row["time_utc"], "판본": versions.get(row["digest"], row["digest"][:12]),
                 "처리 기록": row["action"]} for row in changes
            ]), hide_index=True)

with history:
    st.subheader("이 PC에 저장한 시나리오")
    st.caption("지역·예산·개별 가정을 복원한 뒤 다시 계산합니다. 다른 PC와 자동 동기화하지 않습니다.")
    runs = storage.list_runs()
    if not runs:
        st.info("저장한 시나리오가 없습니다. 배분 대안 계산 후 이름을 붙여 저장하세요.")
    else:
        run_by_id = {r["id"]: r for r in runs}
        chosen = st.selectbox("저장 기록", list(run_by_id), format_func=lambda key: f"{run_by_id[key]['name']} · {run_by_id[key]['created_at'][:19]}")
        matching = run_by_id[chosen]["source_hash"] == meta["dataset_sha256"]
        saved = storage.load(chosen)
        st.write(f"선택 범위 {len(saved['parameters']['areas']) + len(saved['excluded'])}개 지역 · 예산 {saved['parameters']['budget_won']:,}원")
        st.caption(" / ".join(f"{r['method']}: {r['status']}" for r in saved["results"]))
        if not matching:
            st.warning("현재 자료와 지문이 다른 기록입니다. 자동 복원하지 않습니다.")
        if st.button("선택 기록의 입력 복원", disabled=not matching):
            st.session_state["pending_restore"] = saved
            st.session_state.pop("report", None)
            st.rerun()
        st.download_button("저장 기록 JSON", json_bytes(saved), "caregap_saved.json", "application/json")

st.divider()
st.caption(f"CareGap {__version__} · 공개 집계 자료와 명시적 가정에 기반한 시제품 · 전국 선택형 · hybon")
