from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]


def summarize_welfare(rows):
    """Keep the numerator and denominator on the same eligible regions."""
    observed = [row for row in rows if row["annual_users"] is not None]
    eligible = [row for row in observed if row["demand_b"] > 0]
    numerator = sum(row["annual_users"] for row in eligible) if eligible else None
    denominator = sum(row["demand_b"] for row in eligible) if eligible else None
    return {
        "demand": sum(row["demand_b"] for row in rows),
        "users": sum(row["annual_users"] for row in observed) if observed else None,
        "ratio_users": numerator,
        "ratio_demand": denominator,
        "ratio": numerator / denominator if denominator else None,
        "eligible_count": len(eligible),
        "unknown_count": len(rows) - len(observed),
        "zero_demand_count": len(observed) - len(eligible),
        "above_demand_count": sum(row["annual_users"] > row["demand_b"] for row in eligible),
    }


def load_dataset(path: Path | None = None) -> dict:
    data = json.loads((path or ROOT / "data/regions.json").read_text(encoding="utf-8"))
    return validate_dataset(data)


def dataset_digest(metadata: dict, records: list[dict]) -> str:
    meta = {key: value for key, value in metadata.items() if key != "dataset_sha256"}
    canonical = json.dumps({"metadata": meta, "regions": records}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def validate_dataset(data: dict) -> dict:
    seen = set()
    for row in data["regions"]:
        if row["region_id"] in seen:
            raise ValueError("자료에 중복 지역 키가 있습니다.")
        seen.add(row["region_id"])
        for key in ["demand_b", "annual_users"]:
            value = row[key]
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError(f"{row['region_id']} {key} 값이 잘못되었습니다.")
        if row["demand_b"] is None:
            raise ValueError("수요 필드는 필수입니다.")
    meta = data["metadata"]
    expected = meta["dataset_sha256"]
    actual = dataset_digest(meta, data["regions"])
    if actual != expected:
        raise ValueError("묶음 자료의 지문이 맞지 않습니다. 원본 추출을 다시 검증하세요.")
    return data


def prepare_regions(records: list[dict]) -> tuple[list[dict], list[dict]]:
    valid, excluded = [], []
    for row in sorted(records, key=lambda r: r["region_id"]):
        reason = "이용 수 미상" if row["annual_users"] is None else "수요 0" if row["demand_b"] == 0 else None
        if reason:
            excluded.append({"region_id": row["region_id"], "reason": reason, "source_row": row["source_row"]})
        else:
            valid.append({**row, "model_base": min(row["annual_users"], row["demand_b"])})
    return valid, excluded
