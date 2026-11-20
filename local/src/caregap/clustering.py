from itertools import combinations
import numpy as np
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import silhouette_score, adjusted_rand_score
from threadpoolctl import threadpool_limits


def cluster_exclusion_reason(row, include_above=False):
    if row["annual_users"] is None:
        return "이용자 수 미상"
    if row["demand_b"] <= 0:
        return "수요 0"
    if not include_above and row["annual_users"] > row["demand_b"]:
        return "원자료 비율 100% 초과"
    return None


def analyze_clusters(records: list[dict], include_above: bool = False) -> dict:
    valid = [r for r in records if cluster_exclusion_reason(r, include_above) is None]
    if len(valid) < 4:
        return {"status": "INSUFFICIENT_DATA", "message": "지역 유형 분석에는 유효 지역 4개 이상이 필요합니다.", "rows": []}
    features = np.array([[np.log1p(r["demand_b"]), r["annual_users"] / r["demand_b"]] for r in valid])
    X = StandardScaler().fit_transform(features)
    unique = len(np.unique(X, axis=0))
    max_k = min(5, len(valid) - 1, unique)
    if max_k < 2:
        return {"status": "INSUFFICIENT_VARIATION", "message": "서로 다른 특성이 부족해 군집을 만들지 않습니다.", "rows": []}
    seeds, candidates, labels_by_k = [17, 42, 73], [], {}
    for k in range(2, max_k + 1):
        fitted, scores = [], []
        for seed in seeds:
            with threadpool_limits(limits=1):
                labels = KMeans(n_clusters=k, random_state=seed, n_init=20).fit_predict(X)
            if len(set(labels)) != k:
                break
            fitted.append(labels)
            scores.append(float(silhouette_score(X, labels)))
        if len(scores) != len(seeds):
            continue
        labels_by_k[k] = fitted
        candidates.append({"k": k, "mean_silhouette": float(np.mean(scores)), "scores_by_seed": dict(zip(seeds, scores))})
    if not candidates:
        return {"status": "NO_VALID_CANDIDATE", "message": "유효한 군집 후보가 없습니다.", "rows": []}
    chosen = min(candidates, key=lambda c: (-c["mean_silhouette"], c["k"]))
    fitted = labels_by_k[chosen["k"]]
    labels = fitted[0]
    order = sorted(set(labels), key=lambda label: (
        float(np.median(features[labels == label, 1])),
        float(np.median(features[labels == label, 0])),
        min(r["region_id"] for r, assigned in zip(valid, labels) if assigned == label),
    ))
    mapping = {label: f"유형 {i + 1}" for i, label in enumerate(order)}
    rows = [{"region_id": r["region_id"], "cluster": mapping[label], "demand_b": r["demand_b"],
             "raw_ratio": r["annual_users"] / r["demand_b"], "source_quadrant": r["source_quadrant"]}
            for r, label in zip(valid, labels)]
    profiles = []
    for label in order:
        mask = labels == label
        profiles.append({"cluster": mapping[label], "regions": int(mask.sum()),
                         "median_demand": float(np.median([r["demand_b"] for r, keep in zip(valid, mask) if keep])),
                         "median_raw_ratio": float(np.median(features[mask, 1]))})
    included_ids = {r["region_id"] for r in valid}
    return {"status": "OK", "chosen_k": chosen["k"], "candidates": candidates,
            "seed_ari": float(np.mean([adjusted_rand_score(a, b) for a, b in combinations(fitted, 2)])),
            "seeds": seeds, "n_init": 20, "include_above": include_above, "rows": rows, "profiles": profiles,
            "excluded": [r["region_id"] for r in records if r["region_id"] not in included_ids],
            "features": ["standardized log1p(demand_b)", "standardized annual_users/demand_b"]}
