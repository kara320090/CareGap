"""Check the local and browser comparison results against the official workbook."""

import json
import subprocess

from audit_population import load_dataset
from caregap.data import ROOT, prepare_regions
from caregap.optimization import Area, calculate_alternatives
from caregap.population import load_population
from caregap.regional_context import compare_neighbors, demographic_values, follow_up, load_regional_context
from caregap.workbook import read_workbook


BROWSER_CHECK = """
import { readFileSync } from "node:fs";
import { compareNeighbors, demographics, followUp } from "./regional-model.js";
import { compareAllocations } from "./model.js";
const rows = JSON.parse(readFileSync(0, "utf8"));
const records = new Map(rows.map(row => [row.id, row]));
const regional = rows.map(row => {
  const age = compareNeighbors(row, "age", records, true);
  const examples = compareNeighbors(row, "age", records, false);
  if (examples.median !== undefined || !examples.peers.length) throw Error("Sample mode");
  return [row.id, demographics(row.id), age, compareNeighbors(row, "household", records, true), followUp(row, age.sensitive, true)];
});
const provinces = [...new Set(rows.map(row => row.province))];
const allocation = Object.fromEntries(["전국", ...provinces].map(province => {
  const scope = province === "전국" ? rows : rows.filter(row => row.province === province);
  return [province, [0, 100000000, 200000000].map(budget =>
    compareAllocations(scope, budget).results.map(result => [result.lowest, result.extra, result.spent]))];
}));
process.stdout.write(JSON.stringify({ regional, allocation }));
"""


def main():
    rows, audit = read_workbook(ROOT / "data/source.xlsx")
    assert rows == load_dataset()["regions"]
    assert len(rows) == 229 and not audit["province_total_mismatches"]
    counts = load_population()["regions"]
    context = load_regional_context(counts)
    records = {row["region_id"]: row for row in rows}
    browser_input = [{"id": row["region_id"], "province": row["province"],
                      "demand": row["demand_b"], "users": row["annual_users"]} for row in rows]
    result = subprocess.run(
        ["node", "--input-type=module", "-e", BROWSER_CHECK],
        cwd=ROOT.parent / "web/public/legacy",
        input=json.dumps(browser_input).encode(), stdout=subprocess.PIPE, check=True,
    )
    browser = json.loads(result.stdout)
    assert len(browser["regional"]) == 229
    changed_peers = sensitivity_flags = 0
    for key, demo, age, household, guidance in browser["regional"]:
        local = demographic_values(key, counts, context)
        for field in ("older", "age80", "prior65", "single65", "age", "household", "change", "growth"):
            assert local[field] == demo[field], (key, field)
        assert local["age_share"] == demo["ageShare"] and local["single_share"] == demo["singleShare"]
        for mode, web in (("age", age), ("household", household)):
            expected = compare_neighbors(key, mode, records, counts, context)
            assert all(expected[field] == web[field]
                       for field in ("peers", "demand", "rate", "median", "sensitive")), key
            assert list(expected["medians"].values()) == web["medians"], key
        assert follow_up(records[key], age["sensitive"]) == guidance, key
        changed_peers += set(age["peers"]) != set(household["peers"])
        sensitivity_flags += age["sensitive"]

    cases = 0
    assert len(browser["allocation"]) == 18
    for province, scenario in browser["allocation"].items():
        scope = rows if province == "전국" else [row for row in rows if row["province"] == province]
        valid, _ = prepare_regions(scope)
        areas = [Area(row["region_id"], row["demand_b"], row["model_base"]) for row in valid]
        for budget, comparisons in zip((0, 100_000_000, 200_000_000), scenario, strict=True):
            for local, web in zip(calculate_alternatives(areas, budget), comparisons, strict=True):
                metrics = local["metrics"]
                assert round(metrics["minimum_ratio"] * 100, 2) == round(web[0] * 100, 2), (province, budget)
                assert [metrics["additional_model_users"], metrics["cost"]] == web[1:], (province, budget)
                cases += 1
    print(f"Official workbook: 229 rows. Regional Python/JS comparisons: 458. Allocation checks: {cases}.")
    print(f"Population criteria changed the peer set in {changed_peers}/229 regions.")
    print(f"Changing the number of peers flagged {sensitivity_flags}/229 regions.")


if __name__ == "__main__":
    main()
