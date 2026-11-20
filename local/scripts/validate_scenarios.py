from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from itertools import product
import csv
import importlib.metadata
import json
from datetime import datetime, timezone
from caregap.data import ROOT, load_dataset, prepare_regions
from caregap.optimization import Area, optimize, baseline


def main():
    data = load_dataset()
    records, _ = prepare_regions(data["regions"])
    summaries, full = [], []
    for budget, productivity, cost in product([50000000, 100000000, 200000000], [2, 4, 6], [24000000, 30000000, 36000000]):
        areas = [Area(r["region_id"], r["demand_b"], r["model_base"], productivity, cost) for r in records]
        results = [optimize(areas, budget), baseline(areas, budget, "proportional"), baseline(areas, budget, "gap")]
        for result in results:
            if not result["rows"] or result["metrics"]["constraint_violations"] or result["metrics"]["cost"] > budget:
                raise RuntimeError(f"Invalid scenario: {budget}, {productivity}, {cost}, {result['status']}")
            summaries.append({"budget": budget, "productivity": productivity, "unit_cost": cost, "method": result["method"], "status": result["status"],
                              **result["metrics"], "solve_seconds": sum(s["seconds"] for s in result["stages"])})
        full.append({"budget": budget, "productivity": productivity, "unit_cost": cost, "results": results})
    out = ROOT / "artifacts/validation"
    out.mkdir(parents=True, exist_ok=True)
    versions = {p: importlib.metadata.version(p) for p in ["streamlit", "pandas", "scikit-learn", "ortools", "pytest", "numpy", "openpyxl"]}
    (out / "scenarios.json").write_text(json.dumps({"executed_at": datetime.now(timezone.utc).isoformat(), "dataset_sha256": data["metadata"]["dataset_sha256"], "versions": versions, "scenarios": full}, ensure_ascii=False, indent=2), encoding="utf-8")
    with (out / "scenarios.csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(summaries[0]))
        writer.writeheader()
        writer.writerows(summaries)
    optimized = [s for s in summaries if s["method"] == "형평성 우선 최적화"]
    print(json.dumps({"scenarios": len(full), "allocations": len(summaries), "optimal": sum(s["status"] == "OPTIMAL" for s in optimized),
                      "worst_solve_seconds": max(s["solve_seconds"] for s in optimized), "violations": sum(s["constraint_violations"] for s in summaries), "versions": versions}, ensure_ascii=False))


if __name__ == "__main__":
    main()
