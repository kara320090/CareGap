"""Reproduce the nationwide coverage and allocation audit for the base release."""
from hashlib import sha256
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from caregap.boundaries import load_boundaries, join_regions
from caregap.clustering import analyze_clusters
from caregap.data import ROOT, load_dataset, prepare_regions, summarize_welfare
from caregap.optimization import Area, calculate_alternatives
from caregap.region_detail import DIRECTORY_PROVINCES
from caregap.workbook import read_workbook


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def main():
    data = load_dataset()
    workbook = ROOT / "data/source.xlsx"
    rows, metadata = data["regions"], data["metadata"]
    require(sha256(workbook.read_bytes()).hexdigest() == metadata["source_sha256"], "Workbook digest differs")
    source, audit = read_workbook(workbook)
    require(source == rows, "Published workbook and prototype rows differ")
    require(not audit["province_total_mismatches"], audit["province_total_mismatches"])
    provinces = sorted({row["province"] for row in rows})
    require(len(rows) == 229 and set(provinces) == DIRECTORY_PROVINCES, "Nationwide coverage differs")

    boundaries, _ = load_boundaries()
    scopes = {"전국": rows}
    scopes.update({p: [row for row in rows if row["province"] == p] for p in provinces})
    budgets = (0, 100_000_000, 200_000_000)
    checked = 0
    for name, scope in scopes.items():
        summary = summarize_welfare(scope)
        for metric in ("demand_b", "annual_users", "raw_ratio"):
            joined, unmatched = join_regions(scope, boundaries, metric)
            require(len(joined) == len(scope) and not unmatched, (name, metric, unmatched))
            require([f["properties"]["value"] for f in joined] == [r[metric] for r in scope], (name, metric))
        valid, excluded = prepare_regions(scope)
        areas = [Area(r["region_id"], r["demand_b"], r["model_base"]) for r in valid]
        require(len(areas) + len(excluded) == len(scope), (name, "allocation coverage"))
        for budget in budgets:
            for result in calculate_alternatives(areas, budget):
                metrics = result["metrics"]
                require(result["status"] in {"OPTIMAL", "BASELINE"} and len(result["rows"]) == len(areas),
                        (name, budget, result["method"], result["status"]))
                costs = gains = 0
                for area, row in zip(areas, result["rows"]):
                    require(area.region_id == row["region_id"] and area.lower <= row["units"] <= area.upper, (name, row))
                    cost = row["units"] * area.cost
                    gain = min(area.demand - area.base, row["units"] * area.productivity)
                    require((cost, gain) == (row["cost"], row["additional_model_users"]), (name, row))
                    costs += cost
                    gains += gain
                require(costs == metrics["cost"] <= budget and gains == metrics["additional_model_users"], (name, metrics))
                if budget == 0:
                    require(costs == gains == 0, (name, metrics))
                checked += 1
        print(f"{name}: {len(scope)}곳 · 수요 {summary['demand']:,}명 · 확인 이용 {summary['users']:,}명 · 미상 {summary['unknown_count']}곳")
    counts = [len(analyze_clusters(rows, include)["rows"]) for include in (False, True)]
    require(counts == [223, 228], counts)
    print(f"전국 및 17개 시도 · 배분 결과 {checked}개 검증 · 유형 {counts[0]}→{counts[1]}곳")


if __name__ == "__main__":
    main()
