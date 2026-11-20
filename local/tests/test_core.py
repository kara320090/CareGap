import csv
from dataclasses import replace
from io import StringIO
from itertools import product
import json
import random
from unittest.mock import patch, PropertyMock
import pytest
from caregap.data import load_dataset, prepare_regions
from caregap.optimization import Area, optimize, baseline, make_areas, SCALE
from caregap.clustering import analyze_clusters
from caregap.reporting import bundle, inputs, fingerprint, csv_bytes, html_bytes
from caregap import storage


def test_official_extraction():
    data = load_dataset()
    r = data["regions"]
    assert len(r) == len({x["region_id"] for x in r}) == 229
    assert sum(x["demand_b"] for x in r) == 112243
    assert sum(x["annual_users"] or 0 for x in r) == 43223
    assert len([x for x in r if x["province"] == "세종특별자치시"]) == 1
    valid, excluded = prepare_regions(r)
    assert len(valid) == 228
    assert excluded[0]["region_id"] == "인천광역시 옹진군"
    assert len([x for x in r if x["annual_users"] is not None and x["annual_users"] > x["demand_b"]]) == 5
    assert all(x["model_base"] <= x["demand_b"] for x in valid)
    assert data["metadata"]["demand_reference_period"] is None


def test_dataset_tampering(tmp_path):
    data = load_dataset()
    data["regions"][0]["annual_users"] += 1
    f = tmp_path / "changed.json"
    f.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="지문"):
        load_dataset(f)


def test_zero_demand_and_missing_are_excluded():
    base = dict(region_id="예시", demand_b=0, annual_users=2, source_row=9)
    valid, excluded = prepare_regions([base, {**base, "region_id": "미상", "demand_b": 10, "annual_users": None}])
    assert not valid and len(excluded) == 2


@pytest.mark.parametrize("budget,areas,expected", [
    (0, [Area("A", 8, 1, cost=10)], "OPTIMAL"),
    (1, [Area("A", 8, 1, cost=10)], "OPTIMAL"),
    (100, [Area("A", 8, 8, cost=10)], "OPTIMAL"),
    (9, [Area("A", 8, 1, cost=10, lower=1)], "INFEASIBLE"),
    (100, [Area("A", 8, 1, cost=0)], "INPUT_ERROR"),
    (100, [Area("A", 0, 0)], "INPUT_ERROR"),
    (100, [Area("A", 8, 9)], "INPUT_ERROR"),
    (100, [Area("A", 8, 0, lower=3, upper=2)], "INPUT_ERROR"),
    (100, [Area("A", 8, 0), Area("A", 9, 1)], "INPUT_ERROR"),
    (-1, [Area("A", 8, 0)], "INPUT_ERROR"),
    (100, [], "NO_DATA"),
])
def test_boundary_states(budget, areas, expected):
    r = optimize(areas, budget)
    assert r["status"] == expected
    if expected == "OPTIMAL":
        assert r["metrics"]["cost"] == 0
        assert r["metrics"]["constraint_violations"] == 0
    else:
        assert r["rows"] == [] and r["metrics"] == {}


def objective(areas, counts):
    extra = [min(a.demand - a.base, a.productivity * n) for a, n in zip(areas, counts)]
    return (min(SCALE * (a.base + y) // a.demand for a, y in zip(areas, extra)),
            sum(extra), -sum(a.cost * n for a, n in zip(areas, counts)))


@pytest.mark.parametrize("seed", range(30))
def test_solver_matches_independent_exhaustive_search(seed):
    rng = random.Random(seed)
    areas = []
    for i in range(rng.randint(2, 4)):
        demand = rng.randint(3, 25)
        areas.append(Area(str(i), demand, rng.randint(0, demand), rng.randint(1, 6), rng.randint(1, 9), rng.randint(0, 1), rng.randint(2, 4)))
    budget = sum(a.cost * a.lower for a in areas) + rng.randint(0, 30)
    candidates = [x for x in product(*(range(a.lower, a.upper + 1) for a in areas)) if sum(a.cost * n for a, n in zip(areas, x)) <= budget]
    expected = max(objective(areas, x) for x in candidates)
    result = optimize(areas, budget)
    assert result["status"] == "OPTIMAL"
    counts = [r["units"] for r in result["rows"]]
    assert objective(areas, counts) == expected
    for method in ("proportional", "gap"):
        b = baseline(areas, budget, method)
        assert b["status"] == "BASELINE"
        assert b["metrics"]["constraint_violations"] == 0
        assert objective(areas, [r["units"] for r in b["rows"]]) <= expected


def test_timeout_does_not_fabricate_infeasibility():
    # Inject a genuine solver status at its API boundary, independent of CPU speed.
    from ortools.sat.python import cp_model
    with patch.object(cp_model.CpSolver, "solve", return_value=cp_model.UNKNOWN), \
         patch.object(cp_model.CpSolver, "best_objective_bound", new_callable=PropertyMock, return_value=0):
        result = optimize([Area("A", 10, 0)], 0)
    assert result["status"] == "UNKNOWN" and not result["rows"]


def test_partial_solution_is_preserved_without_claiming_optimality():
    from ortools.sat.python import cp_model
    original = cp_model.CpSolver.solve
    calls = []
    def solve_first_only(self, model):
        calls.append(1)
        return original(self, model) if len(calls) == 1 else cp_model.UNKNOWN
    with patch.object(cp_model.CpSolver, "solve", solve_first_only), \
         patch.object(cp_model.CpSolver, "best_objective_bound", new_callable=PropertyMock, return_value=0):
        r = optimize([Area("A", 10, 0, 2, 1)], 2)
    assert r["status"] == "FEASIBLE"
    assert r["rows"] and r["metrics"]["cost"] <= 2
    assert [s["status"] for s in r["stages"]] == ["OPTIMAL", "UNKNOWN"]
    assert "2단계" in r["messages"][0]


def test_fractional_direct_model_input_is_rejected():
    assert optimize([Area("A", 10, 0, cost=2.0)], 2)["status"] == "INPUT_ERROR"


def test_heterogeneous_constraints_and_forced_full_region():
    areas = [Area("A", 3, 3, 2, 7, 1, 2), Area("B", 100, 0, 3, 5, 0, 4)]
    for method in ("proportional", "gap"):
        r = baseline(areas, 29, method)
        assert r["rows"][0]["units"] == 1
        assert r["rows"][0]["additional_model_users"] == 0
        assert r["metrics"]["cost"] <= 29


def test_cluster_stability_and_exclusions():
    records = load_dataset()["regions"]
    a = analyze_clusters(records)
    b = analyze_clusters(records)
    all_values = analyze_clusters(records, True)
    assert a == b
    assert a["status"] == "OK" and len(a["rows"]) == 223
    assert len(all_values["rows"]) == 228
    assert 2 <= a["chosen_k"] <= 5 and -1 <= a["seed_ari"] <= 1
    assert all(-1 <= c["mean_silhouette"] <= 1 for c in a["candidates"])


def test_cluster_rejects_insufficient_variation():
    records = [{"region_id": str(i), "annual_users": 4, "demand_b": 8, "source_quadrant": 1} for i in range(4)]
    assert analyze_clusters(records)["status"] == "INSUFFICIENT_VARIATION"
    assert analyze_clusters(records[:3])["status"] == "INSUFFICIENT_DATA"


def test_cluster_skips_candidates_missing_a_seed():
    records = [{"region_id": str(i), "annual_users": 4 + i % 2, "demand_b": 8, "source_quadrant": 1} for i in range(4)]
    with patch("caregap.clustering.KMeans.fit_predict", side_effect=[[0, 0, 0, 0], [0, 1, 0, 1], [0, 1, 0, 1]]):
        result = analyze_clusters(records)
    assert result["status"] == "NO_VALID_CANDIDATE"


def test_csv_preserves_the_reason_when_all_three_methods_are_infeasible():
    areas = [Area("서울특별시 중구", 30, 10, lower=1)]
    results = [optimize(areas, 0), baseline(areas, 0, "proportional"), baseline(areas, 0, "gap")]
    report = bundle(load_dataset()["metadata"], areas, 0, results, [])
    rows = list(csv.DictReader(StringIO(csv_bytes(report).decode("utf-8-sig"))))
    assert [row["row_type"] for row in rows] == ["metadata", "status", "status", "status"]
    assert [row["method"] for row in rows[1:]] == [result["method"] for result in results]
    assert all(row["status"] == "INFEASIBLE" and "예산" in row["status_message"] for row in rows[1:])


def test_report_exports_and_sqlite_roundtrip(tmp_path):
    data = load_dataset()
    areas = [Area("=HYPERLINK(1) <script>alert(1)</script>", 10, 0, cost=1)]
    r = bundle(data["metadata"], areas, 2, [optimize(areas, 2)], [])
    assert fingerprint(inputs(data["metadata"], areas, 2)) != fingerprint(inputs(data["metadata"], areas, 3))
    assert fingerprint(inputs(data["metadata"], areas, 2)) != fingerprint(inputs(data["metadata"], [replace(areas[0], productivity=5)], 2))
    exported = csv_bytes(r).decode("utf-8-sig")
    assert "'=HYPERLINK" in exported and r["input_sha256"] in exported
    html = html_bytes(r).decode()
    assert "<script>" not in html and "&lt;script&gt;" in html
    db = tmp_path / "scenarios.sqlite3"
    ident = storage.save(r, "테스트 ' 입력", db)
    assert storage.load(ident, db) == r
    assert storage.list_runs(db)[0]["input_hash"] == r["input_sha256"]
    with pytest.raises(ValueError):
        storage.save(r, " ", db)


def test_edited_region_errors_include_region_name():
    raw = [{"region_id": "시험지역", "demand_b": 20, "model_base": 3}]
    row = {"지역": "시험지역", "연간 추가 모형 이용자": 4, "연간 단위 비용 원": 0, "최소 자원 단위": 0, "최대 자원 단위": 5}
    with pytest.raises(ValueError, match="시험지역 비용"):
        make_areas(raw, [row])
    row["연간 단위 비용 원"] = 10
    row["최소 자원 단위"] = 6
    with pytest.raises(ValueError, match="시험지역"):
        make_areas(raw, [row])


def test_csv_keeps_exclusion_and_source_provenance():
    data = load_dataset()
    valid, excluded = prepare_regions(data["regions"])
    areas = [Area(r["region_id"], r["demand_b"], r["model_base"]) for r in valid]
    report = bundle(data["metadata"], areas, 0, [optimize(areas, 0)], excluded, provenance=valid)
    import csv, io
    rows = list(csv.DictReader(io.StringIO(csv_bytes(report).decode("utf-8-sig"))))
    assert rows[0]["row_type"] == "metadata" and "가정" in rows[0]["interpretation"]
    assert len([r for r in rows if r["row_type"] == "allocation"]) == 228
    assert rows[-1]["row_type"] == "excluded" and "옹진군" in rows[-1]["region_id"]
    assert all(r["source_row"] for r in rows[1:])
    assert "ortools" in report["package_versions"]


def test_selection_fingerprint_includes_regions_excluded_from_calculation():
    data = load_dataset()
    areas = [Area("확인 지역", 10, 1)]
    missing = [{"region_id": "이용자 미상 지역", "reason": "이용 수 미상", "source_row": 10}]
    before = fingerprint(inputs(data["metadata"], areas, 100, []))
    after = fingerprint(inputs(data["metadata"], areas, 100, missing))
    assert before != after
    report = bundle(data["metadata"], areas, 100, [], missing)
    assert report["input_sha256"] == after
    assert "이용자 미상 지역" in report["parameters"]["selected_region_ids"]
