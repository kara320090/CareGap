"""Integer scenario comparison. No claim of real available service capacity."""
from dataclasses import dataclass, replace
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
from heapq import heapify, heappop, heappush
from math import isfinite, ceil
from numbers import Real, Integral
from time import perf_counter

from ortools.sat.python import cp_model

SCALE = 10000
LOWER_BUDGET_MESSAGE = "지역별 하한에 필요한 최소 비용이 예산을 넘습니다."


@dataclass(frozen=True)
class Area:
    region_id: str
    demand: int
    base: int
    productivity: int = 4
    cost: int = 30000000
    lower: int = 0
    upper: int = 15


def integer(value, name, minimum=0, maximum=10**12):
    if isinstance(value, bool) or not isinstance(value, Real) or not isfinite(value) or value != int(value):
        raise ValueError(f"{name}은 정수여야 합니다.")
    value = int(value)
    if not minimum <= value <= maximum:
        raise ValueError(f"{name}은 {minimum:,}~{maximum:,} 범위여야 합니다.")
    return value


def validate(areas, budget):
    budget = integer(budget, "예산")
    names = set()
    for area in areas:
        if not isinstance(area.region_id, str) or not area.region_id.strip():
            raise ValueError("지역 키가 필요합니다.")
        if any(isinstance(v, bool) or not isinstance(v, Integral) for v in [area.demand, area.base, area.productivity, area.cost, area.lower, area.upper]):
            raise ValueError("모형의 지역별 수치는 정수 형식이어야 합니다.")
        if area.region_id in names:
            raise ValueError("중복 지역이 있습니다.")
        names.add(area.region_id)
        integer(area.demand, "수요", 1, 10**8)
        integer(area.base, "모형 기준량", 0, area.demand)
        integer(area.productivity, "생산성", 1, 10000)
        integer(area.cost, "단위 비용", 1, 10**10)
        integer(area.lower, "하한", 0, 10000)
        integer(area.upper, "상한", 0, 10000)
        if area.lower > area.upper:
            raise ValueError(f"{area.region_id}: 하한이 상한보다 큽니다.")
    return budget


def allocation(areas, counts, budget, method, status="OPTIMAL", stages=None):
    if len(counts) != len(areas) or any(isinstance(n, bool) or not isinstance(n, Integral) for n in counts):
        return empty(method, "MODEL_INVALID", "계산 결과의 지역 수 또는 자원 단위가 올바르지 않습니다.", stages)
    rows = []
    for a, count in zip(areas, counts):
        count = int(count)
        y = min(a.demand - a.base, a.productivity * count)
        rows.append({"region_id": a.region_id, "demand": a.demand, "model_base": a.base,
                     "units": count, "additional_model_users": y, "cost": a.cost * count,
                     "before_ratio": a.base / a.demand, "after_ratio": (a.base + y) / a.demand,
                     "productivity": a.productivity, "unit_cost": a.cost, "lower": a.lower, "upper": a.upper})
    spent = sum(r["cost"] for r in rows)
    violations = []
    if spent > budget:
        violations.append("예산 초과")
    for a, count in zip(areas, counts):
        if not a.lower <= count <= a.upper:
            violations.append(f"{a.region_id} 자원 범위 위반")
    if violations:
        return empty(method, "MODEL_INVALID", " · ".join(violations), stages)
    return {"method": method, "status": status, "stages": stages or [], "rows": rows,
            "metrics": {"minimum_ratio": min((r["after_ratio"] for r in rows), default=None),
                        "minimum_ratio_units": min((SCALE * (r["model_base"] + r["additional_model_users"]) // r["demand"] for r in rows), default=None),
                        "additional_model_users": sum(r["additional_model_users"] for r in rows),
                        "cost": spent, "unspent_budget": budget - spent, "resource_units": sum(counts),
                        "constraint_violations": len(violations)}, "messages": []}


def empty(method, status, message, stages=None):
    return {"method": method, "status": status, "stages": stages or [], "rows": [], "metrics": {}, "messages": [message]}


def optimize(areas: list[Area], budget: int, time_limit: float = 5, seed: int = 2026) -> dict:
    method = "형평성 우선 최적화"
    try:
        budget = validate(areas, budget)
        if not isfinite(time_limit) or not 0.01 <= time_limit <= 30:
            raise ValueError("단계별 시간 제한은 0.01~30초입니다.")
    except (ValueError, TypeError) as exc:
        return empty(method, "INPUT_ERROR", str(exc))
    if not areas:
        return empty(method, "NO_DATA", "계산할 수 있는 지역이 없습니다.")
    if sum(a.lower * a.cost for a in areas) > budget:
        return empty(method, "INFEASIBLE", LOWER_BUDGET_MESSAGE)
    model = cp_model.CpModel()
    x = [model.new_int_var(a.lower, a.upper, f"x{i}") for i, a in enumerate(areas)]
    y = [model.new_int_var(0, a.demand - a.base, f"y{i}") for i, a in enumerate(areas)]
    q = model.new_int_var(0, SCALE, "minimum_ratio_units")
    for i, a in enumerate(areas):
        model.add_min_equality(y[i], [a.productivity * x[i], a.demand - a.base])
        model.add(SCALE * (a.base + y[i]) >= q * a.demand)
    cost = sum(a.cost * x[i] for i, a in enumerate(areas))
    total = sum(y)
    model.add(cost <= budget)
    issue = model.validate()
    if issue:
        return empty(method, "MODEL_INVALID", issue)
    stages, incumbent = [], None
    for phase, objective in enumerate([q, total, cost], 1):
        if phase < 3:
            model.maximize(objective)
        else:
            model.minimize(objective)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(time_limit)
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = seed
        started = perf_counter()
        status = solver.solve(model)
        name = solver.status_name(status)
        has_solution = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        record = {"phase": phase, "status": name, "seconds": perf_counter() - started,
                  "objective": int(solver.value(objective)) if has_solution else None,
                  "bound": solver.best_objective_bound if name not in ("MODEL_INVALID", "INFEASIBLE") else None,
                  "time_limit": time_limit, "seed": seed, "workers": 1}
        stages.append(record)
        if has_solution:
            incumbent = [int(solver.value(v)) for v in x]
        if status != cp_model.OPTIMAL:
            if incumbent is not None and name not in ("INFEASIBLE", "MODEL_INVALID"):
                result = allocation(areas, incumbent, budget, method, "FEASIBLE", stages)
                if result["status"] == "FEASIBLE":
                    result["messages"] = [f"{phase}단계 최적성이 증명되지 않았습니다. 실행 가능한 현 해입니다."]
                return result
            return empty(method, name, "시간 내 해를 확인하지 못했습니다." if name == "UNKNOWN" else "유효한 배분 해가 없습니다.", stages)
        if phase < 3:
            model.add(objective == int(solver.value(objective)))
    result = allocation(areas, incumbent, budget, method, "OPTIMAL", stages)
    result["precision"] = {"scale": SCALE, "percentage_point_resolution": 0.01, "seed": seed, "workers": 1}
    return result


def baseline(areas: list[Area], budget: int, method: str) -> dict:
    label = {"proportional": "수요 비례", "gap": "부족분 우선"}[method]
    try:
        budget = validate(areas, budget)
    except ValueError as exc:
        return empty(label, "INPUT_ERROR", str(exc))
    if not areas:
        return empty(label, "NO_DATA", "계산 대상이 없습니다.")
    x = [a.lower for a in areas]
    remaining = budget - sum(a.cost * a.lower for a in areas)
    if remaining < 0:
        return empty(label, "INFEASIBLE", LOWER_BUDGET_MESSAGE)
    caps = [max(a.lower, min(a.upper, ceil((a.demand - a.base) / a.productivity))) for a in areas]
    if method == "gap":
        order = sorted(range(len(areas)), key=lambda i: (-(areas[i].demand - areas[i].base), areas[i].region_id))
        for i in order:
            count = min(caps[i] - x[i], remaining // areas[i].cost)
            x[i] += count
            remaining -= count * areas[i].cost
    else:
        total_demand = sum(a.demand for a in areas)
        denominators = [total_demand * a.cost for a in areas]
        targets = [divmod(remaining * a.demand, denominator) for a, denominator in zip(areas, denominators)]
        for i, a in enumerate(areas):
            count = min(caps[i] - x[i], targets[i][0], remaining // a.cost)
            x[i] += count
            remaining -= count * a.cost
        # Each extra unit lowers a region's priority by one. Its fractional
        # tie-break stays fixed, so the queue can use exact integer priorities.
        order = sorted(range(len(areas)), key=lambda i: (-Fraction(targets[i][1], denominators[i]), areas[i].region_id))
        queue = [(x[i] - areas[i].lower - targets[i][0], rank, i)
                 for rank, i in enumerate(order) if x[i] < caps[i] and areas[i].cost <= remaining]
        heapify(queue)
        while queue:
            priority, rank, i = heappop(queue)
            if areas[i].cost > remaining:
                continue
            x[i] += 1
            remaining -= areas[i].cost
            if x[i] < caps[i] and areas[i].cost <= remaining:
                heappush(queue, (priority + 1, rank, i))
    return allocation(areas, x, budget, label, "BASELINE")


def calculate_alternatives(areas, budget):
    return [optimize(areas, budget), baseline(areas, budget, "proportional"), baseline(areas, budget, "gap")]


def scale_unit_costs(areas, percent):
    if isinstance(percent, bool) or not isinstance(percent, Real) or not isfinite(percent) or not 1 <= percent <= 1000:
        raise ValueError("단가 배율은 1~1,000% 범위여야 합니다.")
    multiplier = Decimal(str(percent)) / 100
    updated = []
    for area in areas:
        original = integer(area.cost, f"{area.region_id} 기준 단가", 1, 10**10)
        cost = int((original * multiplier).to_integral_value(rounding=ROUND_HALF_UP))
        integer(cost, f"{area.region_id} 변경 단가", 1, 10**10)
        updated.append(replace(area, cost=cost))
    return updated


def make_areas(records, edited_rows):
    indexed = {r["region_id"]: r for r in records}
    result = []
    for row in edited_rows:
        raw = indexed[row["지역"]]
        result.append(Area(raw["region_id"], raw["demand_b"], raw["model_base"],
                           integer(row["연간 추가 모형 이용자"], raw["region_id"] + " 생산성", 1, 10000),
                           integer(row["연간 단위 비용 원"], raw["region_id"] + " 비용", 1, 10**10),
                           integer(row["최소 자원 단위"], raw["region_id"] + " 하한", 0, 10000),
                           integer(row["최대 자원 단위"], raw["region_id"] + " 상한", 0, 10000)))
    validate(result, 0)
    return result
