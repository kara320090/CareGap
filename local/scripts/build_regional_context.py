"""Rebuild the shared demographic context and nearest-neighbor lists."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from math import log1p
from pathlib import Path
from statistics import pstdev

from audit_population import download_population, match_regions, read_population
from caregap.data import ROOT, load_dataset
from caregap.population import load_population


def nearest_neighbors(profiles):
    scales = [pstdev(values) for values in zip(*profiles.values())]
    if any(scale == 0 for scale in scales):
        raise ValueError("인구 비교 기준의 분산이 0입니다.")
    return {
        key: sorted(
            (other for other in profiles if other != key),
            key=lambda other: (
                sum(((a - b) / scale) ** 2 for a, b, scale in zip(profile, profiles[other], scales)),
                other,
            ),
        )[:7]
        for key, profile in profiles.items()
    }


def main():
    with ThreadPoolExecutor(max_workers=3) as pool:
        current, previous, households = pool.map(
            lambda args: download_population(*args), [(2025, False), (2024, False), (2025, True)]
        )
    rows = load_dataset()["regions"]
    population = load_population()
    counts = population["regions"]
    if sha256(current).hexdigest() != population["source_sha256"]:
        raise ValueError("2025년 인구 원본의 지문이 기존 판본과 다릅니다.")
    age65 = match_regions(rows, read_population(current))
    age80 = match_regions(rows, read_population(current, minimum_age=80))
    prior65 = match_regions(rows, read_population(previous, month="2024년12월"))
    single65 = match_regions(rows, read_population(households, households=True))
    contexts = {}
    for key, (code, current65) in age65.items():
        if current65 != counts[key] or any(source[key][0] != code for source in (age80, prior65, single65)):
            raise ValueError(f"지역 코드 또는 고령인구 불일치: {key}")
        if max(age80[key][1], single65[key][1]) > current65:
            raise ValueError(f"하위 집계가 고령인구보다 큽니다: {key}")
        contexts[key] = {"age80": age80[key][1], "prior65": prior65[key][1], "single65": single65[key][1]}
    profiles = {key: (log1p(counts[key]), values["age80"] / counts[key])
                for key, values in contexts.items()}
    with_households = {key: (*values, contexts[key]["single65"] / counts[key])
                       for key, values in profiles.items()}
    age_neighbors = nearest_neighbors(profiles)
    household_neighbors = nearest_neighbors(with_households)
    for key, values in contexts.items():
        values["age"] = age_neighbors[key]
        values["household"] = household_neighbors[key]
    result = {
        "reference_date": "2025-12-31", "prior_date": "2024-12-31",
        "sha256": {"population2025": sha256(current).hexdigest(),
                   "population2024": sha256(previous).hexdigest(),
                   "households2025": sha256(households).hexdigest()},
        "regions": contexts,
    }
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    (ROOT / "data/regional_context.json").write_text(payload + "\n", encoding="utf-8")
    print("229개 지역 및 17개 시도 합계 확인")
    print({field: sum(row[field] for row in contexts.values()) for field in ("age80", "prior65", "single65")})


if __name__ == "__main__":
    main()
