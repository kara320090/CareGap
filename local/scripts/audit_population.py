"""Check whether the MOIS year-end population data can add regional context."""

import argparse
import csv
import hashlib
import io
import json
from collections import defaultdict
from pathlib import Path
import re
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from caregap.data import load_dataset
from caregap.population import POPULATION_CATALOG, POPULATION_DATE, POPULATION_SOURCE

PORTAL = "https://jumin.mois.go.kr"
MONTH = "2025년12월"


def download_population(year=2025, households=False):
    params = {
        "sltOrgType": 1, "sltOrgLvl1": "A", "sltOrgLvl2": "",
        "gender": "gender", "sum": "sum", "sltUndefType": "",
        "searchYearStart": year, "searchMonthStart": 12,
        "searchYearEnd": year, "searchMonthEnd": 12,
        "sltOrderType": 1, "sltOrderValue": "ASC",
        "sltArgTypes": 1, "sltArgTypeA": 65, "sltArgTypeB": 100,
        "category": "month", "state": 2,
    }
    endpoint = "downloadCsvAge.do?searchYearMonth=month&xlsStats=2"
    referer = "ageStatMonth.do"
    if households:
        params["sttsGbn"] = "admm"
        endpoint = "sexdAge1HshdDown.do?searchYearMonth=month&xlsStats=2&downType=Csv"
        referer = "sexdAge1Hshd.do?sttsGbn=admm"
    request = Request(
        f"{PORTAL}/{endpoint}",
        data=urlencode(params).encode(),
        headers={"Referer": f"{PORTAL}/{referer}", "User-Agent": "Mozilla/5.0"},
    )
    with urlopen(request, timeout=20) as response:
        return response.read(5_000_001)


def read_population(raw, month=MONTH, households=False, minimum_age=65):
    if len(raw) > 5_000_000:
        raise ValueError("인구통계 파일 크기가 예상 범위를 벗어납니다.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp949")
    reader = csv.DictReader(io.StringIO(text))
    age_fields = [f"{month}_계_{age}세" for age in range(65, 100)] + [f"{month}_계_100세 이상"]
    total_field = f"{month}_계_연령구간{'세대수' if households else '인구수'}"
    required = {"행정구역", total_field, *age_fields}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError(f"{month} 65세 이상 행정안전부 원본의 열과 일치하지 않습니다.")
    by_name = defaultdict(list)
    used_codes = set()
    for row in reader:
        label = row["행정구역"]
        match = re.fullmatch(r"(.*?)\s*\((\d{10})\)\s*", label or "")
        if not match:
            raise ValueError(f"행정구역과 코드를 읽지 못했습니다. {label}")
        name, code = match.groups()
        age_counts = [int(row[field].replace(",", "")) for field in age_fields]
        reported = int(row[total_field].replace(",", ""))
        if code in used_codes or min(age_counts) < 0 or sum(age_counts) != reported:
            raise ValueError(f"연령 합계 또는 행정구역 코드 검증 실패: {label}")
        used_codes.add(code)
        by_name[" ".join(name.split())].append((code, sum(age_counts[minimum_age - 65:])))
    return by_name


def match_regions(welfare_rows, population):
    matched = {}
    province_sums = defaultdict(int)
    for row in welfare_rows:
        name = row["region_id"]
        if name == "세종특별자치시 세종시":
            # The export has both the province and the district with the same name and population.
            candidates = [item for item in population["세종특별자치시"] if item[0] == "3611000000"]
        else:
            candidates = population[name]
        if len(candidates) != 1 or candidates[0][1] <= 0:
            raise ValueError(f"단일 시군구와 연결할 수 없습니다. {name}: {candidates}")
        matched[name] = candidates[0]
        province_sums[row["province"]] += candidates[0][1]
    if len(matched) != 229 or len({code for code, _ in matched.values()}) != 229 or len(province_sums) != 17:
        raise ValueError("전국 229개 지역과 17개 시도에 1대1로 연결되지 않았습니다.")
    for province, total in province_sums.items():
        if [count for code, count in population[province] if code.endswith("00000000")] != [total]:
            raise ValueError(f"시도 합계 불일치: {province}")
    return matched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", nargs="?", type=Path)
    parser.add_argument("--output", type=Path, help="Write the verified regional snapshot")
    args = parser.parse_args()
    raw = args.csv.read_bytes() if args.csv else download_population()
    population = read_population(raw)
    welfare_rows = load_dataset()["regions"]
    matched = match_regions(welfare_rows, population)
    source_hash = hashlib.sha256(raw).hexdigest()
    print(f"2025년 12월 65세 이상 주민등록인구 · SHA-256 {source_hash}")
    print(f"복지 지역 {len(matched)}곳 연결 · 17개 시도 합계 일치 · 전국 {sum(n for _, n in matched.values()):,}명")
    for row in welfare_rows:
        if row["region_id"] in {"인천광역시 중구", "인천광역시 옹진군"}:
            _, older_population = matched[row["region_id"]]
            print(f"{row['region_id']} · 65세 이상 {older_population:,}명 · "
                  f"65세 이상 인구 1,000명당 수요군 B {row['demand_b'] / older_population * 1_000:.2f}명")
    if args.output:
        data = {
            "reference_date": POPULATION_DATE,
            "source_url": POPULATION_SOURCE,
            "catalog_url": POPULATION_CATALOG,
            "source_sha256": source_hash,
            "regions": {name: count for name, (_, count) in matched.items()},
        }
        args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
