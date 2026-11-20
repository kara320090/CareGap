const scale = 10_000;
export const unitCost = 30_000_000;
export const gainPerUnit = 4;
const regionalCap = 15;

export function summarize(rows) {
  const known = rows.filter(row => row.users !== null);
  const comparable = known.filter(row => row.demand > 0);
  const sum = (items, key) => items.reduce((total, row) => total + row[key], 0);
  return {
    demand: sum(rows, "demand"), users: known.length ? sum(known, "users") : null,
    missing: rows.length - known.length, above: comparable.filter(row => row.users > row.demand).length,
    ratioUsers: sum(comparable, "users"), ratioDemand: sum(comparable, "demand"),
    comparable: comparable.length,
  };
}

export function populationContext(rows, counts, official) {
  const populations = rows.map(row => counts[row.id]);
  if (!rows.length || populations.some(count => !Number.isSafeInteger(count) || count <= 0)) {
    return { population: null, demandPer1000: null };
  }
  const population = populations.reduce((sum, count) => sum + count, 0);
  const demand = rows.reduce((sum, row) => sum + row.demand, 0);
  return { population, demandPer1000: official ? demand * 1000 / population : null };
}

function capacity(area) {
  return Math.min(regionalCap, Math.ceil((area.demand - area.base) / gainPerUnit));
}

function gains(area, units) {
  return Math.min(area.demand - area.base, units * gainPerUnit);
}

function fair(areas, limit) {
  // First find the highest attainable minimum ratio in 0.01 percentage point units.
  function minimumUnits(target) {
    return areas.map(area => Math.max(0, Math.ceil(
      (Math.ceil(target * area.demand / scale) - area.base) / gainPerUnit
    )));
  }
  let low = 0, high = scale;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const needed = minimumUnits(middle);
    const feasible = needed.every((units, i) => units <= capacity(areas[i])) &&
      needed.reduce((total, units) => total + units, 0) <= limit;
    if (feasible) low = middle;
    else high = middle - 1;
  }
  const minimum = minimumUnits(low);
  // With the minimum fixed, maximize gain at each exact spend, then choose the least spend on ties.
  let scores = Array(limit + 1).fill(-Infinity);
  scores[0] = 0;
  const trace = [];
  areas.forEach((area, i) => {
    const next = Array(limit + 1).fill(-Infinity);
    const choice = Array(limit + 1).fill(0);
    const cap = Math.min(capacity(area), limit);
    for (let spent = 0; spent <= limit; spent++) {
      if (scores[spent] === -Infinity) continue;
      for (let units = minimum[i]; units <= cap && spent + units <= limit; units++) {
        const gain = scores[spent] + gains(area, units);
        if (gain > next[spent + units]) {
          next[spent + units] = gain;
          choice[spent + units] = units;
        }
      }
    }
    scores = next;
    trace.push(choice);
  });
  let spent = scores.indexOf(Math.max(...scores));
  return trace.reduceRight((units, choice, i) => {
    units[i] = choice[spent];
    spent -= units[i];
    return units;
  }, []);
}

function proportional(areas, limit) {
  const demand = areas.reduce((sum, area) => sum + area.demand, 0);
  const targets = areas.map(area => area.demand * limit);
  const units = areas.map((area, i) => Math.min(capacity(area), Math.floor(targets[i] / demand)));
  let remaining = limit - units.reduce((total, n) => total + n, 0);
  while (remaining > 0) {
    let choice = -1;
    let best = -Infinity;
    areas.forEach((area, i) => {
      const deficit = targets[i] - units[i] * demand;
      if (units[i] < capacity(area) && deficit > best) {
        choice = i;
        best = deficit;
      }
    });
    if (choice < 0) break;
    units[choice]++;
    remaining--;
  }
  return units;
}

function gapFirst(areas, limit) {
  const units = areas.map(() => 0);
  const sorted = areas.map((_, i) => i).sort((a, b) =>
    (areas[b].demand - areas[b].base) - (areas[a].demand - areas[a].base) || a - b);
  for (const i of sorted) {
    units[i] = Math.min(limit, capacity(areas[i]));
    limit -= units[i];
  }
  return units;
}

export function compareAllocations(rows, budget) {
  const names = ["형평성 우선", "수요 비례", "부족분 우선"];
  const unavailable = (status, reason) => ({ areas: [], limit: 0,
    results: names.map(name => ({ name, status, reason, units: [], lowest: null, extra: null, spent: null })) });
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 200_000_000)
    return unavailable("INPUT_ERROR", "예산은 0원부터 2억원 사이의 정수여야 합니다.");
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.demand) || row.demand < 0 ||
      (row.users !== null && (!Number.isSafeInteger(row.users) || row.users < 0))))
    return unavailable("INPUT_ERROR", "수요·이용자 수의 원본 형식을 확인하세요.");
  const areas = rows.filter(row => row.users !== null && row.demand > 0)
    .map(row => ({ ...row, base: Math.min(row.users, row.demand) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const limit = Math.floor(budget / unitCost);
  const methods = [
    ["형평성 우선", fair], ["수요 비례", proportional], ["부족분 우선", gapFirst],
  ];
  if (!areas.length) return unavailable("NO_DATA", "이용값이 확인되고 수요가 양수인 지역이 없습니다.");
  return {
    areas, limit, results: methods.map(([name, method]) => {
      const units = method(areas, limit);
      const additions = areas.map((area, i) => gains(area, units[i]));
      return {
        name, units, status: "CALCULATED", reason: "공개판의 고정 단가·생산성 가정으로 계산했습니다.",
        lowest: Math.min(...areas.map((area, i) => (area.base + additions[i]) / area.demand)),
        extra: additions.reduce((sum, n) => sum + n, 0),
        spent: units.reduce((sum, n) => sum + n, 0) * unitCost,
      };
    }),
  };
}
