"""Demographic comparisons and source-based follow-up guidance."""

import json
from statistics import median

from .data import ROOT

HOUSEHOLDS_SOURCE = "https://www.data.go.kr/data/15097973/fileData.do"
APPLICATION_GUIDE = "https://www.1661-2129.or.kr/sub02/sub01.php"
CARE_STATISTICS = (
    "https://stat.kosis.kr/nsieu/view/tree.do?"
    "hOrg=350&id=350_350_35006_35006_02%2AMT_OTITLE&task=branchView"
)
COMPARISON_LABELS = {"age": "인구 구조가 비슷한 5곳", "household": "1인세대 비중까지 비슷한 5곳"}
MISSING = "연간 이용자 미상입니다. E열 원본 셀과 값이 비어 있는 이유를 확인하세요."
ABOVE = "이용 대 수요 비율이 100%를 넘습니다. C·E열 집계의 대상과 기준 기간을 확인하세요."
SENSITIVE = "비교 대상을 3·5·7곳으로 바꾸면 중앙값 대비 방향이 달라집니다. 비교 기준과 지역 목록을 확인하세요."
NORMAL = "수요군 B의 인원과 1,000명당 수치를 함께 보고 원본 셀과 기준일을 확인하세요."


def load_regional_context(counts):
    data = json.loads((ROOT / "data/regional_context.json").read_text(encoding="utf-8"))
    context = data["regions"]
    if data["reference_date"] != "2025-12-31" or data["prior_date"] != "2024-12-31" or set(context) != set(counts):
        raise ValueError("전국 인구 맥락 자료의 지역 또는 기준일이 일치하지 않습니다.")
    for key, entry in context.items():
        if not (0 < entry["age80"] <= counts[key] and 0 <= entry["single65"] <= counts[key] and entry["prior65"] > 0):
            raise ValueError(f"인구 맥락의 집계 범위가 올바르지 않습니다: {key}")
        for mode in COMPARISON_LABELS:
            peers = set(entry[mode])
            if len(entry[mode]) != 7 or len(peers) != 7 or key in peers or not peers <= context.keys():
                raise ValueError(f"유사 지역 목록이 올바르지 않습니다: {key}")
    return context


def demographic_values(key, counts, context):
    if key not in context or key not in counts:
        return None
    item, older = context[key], counts[key]
    change = older - item["prior65"]
    return {**item, "older": older, "age_share": item["age80"] / older,
            "single_share": item["single65"] / older, "change": change,
            "growth": change / item["prior65"]}


def compare_neighbors(key, mode, records, counts, context):
    peers = context[key][mode]
    if any(other not in records or other not in counts for other in [key, *peers]):
        return None
    rates = [records[other]["demand_b"] * 1000 / counts[other] for other in peers]
    current = records[key]["demand_b"] * 1000 / counts[key]
    medians = {size: median(rates[:size]) for size in (3, 5, 7)}
    signs = {0 if abs(current - value) < .005 else (1 if current > value else -1) for value in medians.values()}
    return {
        "peers": peers[:5], "demand": median(records[other]["demand_b"] for other in peers[:5]),
        "rate": current, "median": medians[5], "medians": medians,
        "sensitive": len(signs) > 1,
    }


def follow_up(row, sensitive):
    guidance = []
    users, demand = row["annual_users"], row["demand_b"]
    if users is None:
        guidance.append(MISSING)
    elif demand > 0 and users > demand:
        guidance.append(ABOVE)
    if sensitive:
        guidance.append(SENSITIVE)
    return guidance or [NORMAL]
