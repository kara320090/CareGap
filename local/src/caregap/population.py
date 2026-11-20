"""Population context kept separate from the welfare data and allocation inputs."""

import json

from .data import ROOT

POPULATION_DATE = "2025-12-31"
POPULATION_SOURCE = "https://jumin.mois.go.kr/ageStatMonth.do"
POPULATION_CATALOG = "https://www.data.go.kr/data/3033304/fileData.do"
POPULATION_FILE = ROOT / "data" / "population_65plus_202512.json"


def load_population(path=POPULATION_FILE):
    data = json.loads(path.read_text(encoding="utf-8"))
    counts = data["regions"]
    if (data["reference_date"] != POPULATION_DATE or len(counts) != 229
            or any(type(value) is not int or value <= 0 for value in counts.values())):
        raise ValueError("고령인구 자료의 기준일 또는 지역별 값이 올바르지 않습니다.")
    return data


def population_context(rows, counts):
    """Use matching regional totals, including areas with unknown service use."""
    if not rows:
        return None, None
    population = [counts.get(row["region_id"]) for row in rows]
    if any(value is None for value in population):
        return None, None
    total = sum(population)
    return total, sum(row["demand_b"] for row in rows) * 1_000 / total if total else None
