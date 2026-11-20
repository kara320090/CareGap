"""Join audited SGIS geometry to the current set of welfare observations."""
import json

from .data import ROOT

BOUNDARY_FILE = ROOT / "data/boundaries_2025q2.geojson"


def load_boundaries(path=BOUNDARY_FILE):
    source = json.loads(path.read_text(encoding="utf-8"))
    if source["metadata"]["boundary_date"] != "2025-06-30":
        raise ValueError("지원하는 SGIS 경계 기준일과 다릅니다.")
    indexed = {}
    used_codes = set()
    for feature in source["features"]:
        properties = feature["properties"]
        key = properties["region_id"]
        codes = properties["sgis_codes"]
        if key in indexed or not codes or len(codes) != len(set(codes)) or used_codes.intersection(codes):
            raise ValueError("경계 자료의 지역 키 또는 SGIS 코드가 중복되었습니다.")
        indexed[key] = feature
        used_codes.update(codes)
    metadata = source["metadata"]
    if len(indexed) != metadata["region_count"] or len(used_codes) != metadata["source_code_count"]:
        raise ValueError("경계 자료의 지역 수 또는 코드 수가 메타데이터와 다릅니다.")
    return indexed, metadata


def join_regions(rows, boundaries, metric):
    features, unmatched = [], []
    for row in rows:
        feature = boundaries.get(row["region_id"])
        if feature is None:
            unmatched.append(row["region_id"])
            continue
        properties = feature["properties"]
        features.append({**feature, "properties": {
            **properties, "value": row[metric],
            "sgis_label": ", ".join(properties["sgis_codes"]),
            "warnings": " · ".join(row["flags"]) or "없음",
        }})
    return features, unmatched
