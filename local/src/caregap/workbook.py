"""Read the Ministry's 2025 elderly care workbook schema."""
from collections import Counter
from itertools import islice
import re

from openpyxl import load_workbook

SHEET = "13.노인맞춤돌봄서비스"
PROVINCES = {
    "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시",
    "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도",
    "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
}


def read_workbook(source):
    workbook = load_workbook(source, read_only=True, data_only=True, keep_links=False)
    try:
        if SHEET not in workbook.sheetnames:
            raise ValueError(f"'{SHEET}' 시트가 없습니다.")
        sheet = workbook[SHEET]
        sheet.reset_dimensions()
        rows = list(islice(sheet.iter_rows(min_row=1, max_col=11, values_only=True), 501))
        if len(rows) > 500:
            raise ValueError("원본 시트가 500행을 넘습니다.")
    finally:
        workbook.close()
    if len(rows) < 5 or rows[3][4] != "연간 이용자 수(명)" or rows[4][2] != "노인맞돌 수요군(B)":
        raise ValueError("C열 수요군 B 또는 E열 연간 이용자 헤더가 다릅니다.")

    records, aggregates, province = [], [], None
    totals = []
    province_headers = Counter()
    province_totals = {}
    missing_user_markers = {}
    for number, row in enumerate(rows[5:], 6):
        name = row[0]
        if name is None:
            continue
        if not isinstance(name, str) or not name.strip() or name != name.strip():
            raise ValueError(f"{number}행 지역 이름이 올바르지 않습니다.")
        if name == "전국" or name in PROVINCES or re.fullmatch(r"(일반|인구감소)\(\d+개소\)", name):
            source_total = tuple(value if type(value) is int and value >= 0 else None for value in (row[2], row[4]))
            if name == "전국":
                totals.append(source_total)
            elif name in PROVINCES:
                province = name
                province_headers[name] += 1
                province_totals[name] = source_total
            aggregates.append({"row": number, "name": name, "demand_b": source_total[0], "annual_users": source_total[1]})
            continue
        if province is None:
            raise ValueError(f"{number}행의 시도 맥락을 확인할 수 없습니다.")
        demand, users = row[2], row[4]
        if type(demand) is not int or not 0 <= demand <= 10**8:
            raise ValueError(f"{number}행 수요는 0 이상 1억 이하 정수여야 합니다.")
        if users in (None, "-"):
            missing_user_markers[f"{province} {name}"] = "대시(-)" if users == "-" else "빈 셀"
            users = None
        elif type(users) is not int or not 0 <= users <= 10**8:
            raise ValueError(f"{number}행 이용자는 0 이상 1억 이하 정수 또는 결측이어야 합니다.")
        flags = []
        if users is None:
            flags.append("이용 수 미상")
        if demand == 0:
            flags.append("수요 0")
        if demand > 0 and users is not None and users > demand:
            flags.append("원자료 이용 대 수요 100% 초과")
        records.append({
            "region_id": f"{province} {name}", "province": province, "district": name,
            "demand_b": demand, "annual_users": users,
            "equivalent_workers": row[3] if type(row[3]) is int else None,
            "source_quadrant": row[10] if type(row[10]) is int else None,
            "source_row": number, "raw_ratio": users / demand if users is not None and demand > 0 else None,
            "flags": flags,
        })
    summary = {
        "regions": len(records), "known_users_regions": sum(r["annual_users"] is not None for r in records),
        "demand_b_sum": sum(r["demand_b"] for r in records),
        "known_annual_users_sum": sum(r["annual_users"] or 0 for r in records),
        "missing_users": [r["region_id"] for r in records if r["annual_users"] is None],
        "missing_user_markers": missing_user_markers,
        "above_demand": [r["region_id"] for r in records if r["raw_ratio"] is not None and r["raw_ratio"] > 1],
        "duplicate_keys": len(records) - len({r["region_id"] for r in records}),
        "excluded_aggregates": aggregates,
    }
    if province_headers != dict.fromkeys(PROVINCES, 1) or summary["duplicate_keys"]:
        raise ValueError("17개 시도 표제 또는 시군구 지역 키가 중복되거나 누락되었습니다.")
    if totals != [(summary["demand_b_sum"], summary["known_annual_users_sum"])]:
        raise ValueError("전국 합계 행과 시군구 집계 합계가 일치해야 합니다.")
    demand_by_province, users_by_province = Counter(), Counter()
    for record in records:
        demand_by_province[record["province"]] += record["demand_b"]
        users_by_province[record["province"]] += record["annual_users"] or 0
    summary["province_total_mismatches"] = [
        name for name, total in province_totals.items() if total != (demand_by_province[name], users_by_province[name])
    ]
    return records, summary
