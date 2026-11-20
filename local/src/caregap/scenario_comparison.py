"""Summaries for two sets of results from the same allocation model."""


def alternative_ranks(results):
    if any(result["status"] not in {"OPTIMAL", "BASELINE"} or not result["metrics"] for result in results):
        return {}

    def objective(result):
        metrics = result["metrics"]
        return (-metrics["minimum_ratio_units"], -metrics["additional_model_users"], metrics["cost"])

    objectives = [objective(result) for result in results]
    ranks = {}
    for result, score in zip(results, objectives):
        rank = 1 + sum(other < score for other in objectives)
        ranks[result["method"]] = f"공동 {rank}위" if objectives.count(score) > 1 else f"{rank}위"
    return ranks


def metric_cell(before, after, key, format_value, format_change):
    old = format_value(before[key]) if before else "—"
    new = format_value(after[key]) if after else "—"
    change = format_change(after[key] - before[key]) if before and after else "—"
    return f"{old} → {new} ({change})"


def compare_results(reference, changed, status_labels):
    old_ranks = alternative_ranks(reference)
    new_ranks = alternative_ranks(changed)
    summaries, changes = [], []
    changed_by_method = {result["method"]: result for result in changed}
    for old in reference:
        method = old["method"]
        new = changed_by_method[method]
        before, after = old["metrics"], new["metrics"]
        summaries.append({
            "대안": method,
            "기준 상태": status_labels[old["status"]],
            "변경 상태": status_labels[new["status"]],
            "최저 비율 (기준 → 변경 · 차이)": metric_cell(
                before, after, "minimum_ratio", lambda v: f"{v:.2%}", lambda v: f"{v * 100:+.2f}%p"
            ),
            "추가 인원 (기준 → 변경 · 차이)": metric_cell(
                before, after, "additional_model_users", lambda v: f"{v:,}명", lambda v: f"{v:+,}명"
            ),
            "사용 예산 (기준 → 변경 · 차이)": metric_cell(
                before, after, "cost", lambda v: f"{v:,}원", lambda v: f"{v:+,}원"
            ),
            "순위 (기준 → 변경)": f"{old_ranks.get(method, '미확정')} → {new_ranks.get(method, '미확정')}",
        })
        rows_after = {row["region_id"]: row for row in new["rows"]}
        for row in old["rows"]:
            updated = rows_after.get(row["region_id"])
            if updated is None or updated["units"] == row["units"]:
                continue
            changes.append({
                "대안": method, "지역": row["region_id"],
                "기준 배분 단위": row["units"], "변경 배분 단위": updated["units"],
                "배분 단위 차이": updated["units"] - row["units"],
                "추가 모형 이용자 차이": updated["additional_model_users"] - row["additional_model_users"],
            })
    changes.sort(key=lambda row: (-abs(row["배분 단위 차이"]), row["대안"], row["지역"]))
    return summaries, changes
