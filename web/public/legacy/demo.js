import { geography } from "./regions.js";
import { readOfficialRows } from "./source.js";
import { population } from "./population.js";
import { populationContext, summarize } from "./model.js";
import { compareNeighbors, demographics, followUp } from "./regional-model.js";
import { analyzeClusters } from "./clustering.js";
import { alternativeRanks, compareCostedAllocations, scaledCosts, unavailableAllocation } from "./cost-model.js";

const formatter = new Intl.NumberFormat("ko-KR");
const count = value => formatter.format(value);
const people = value => value === null ? "미상" : `${count(value)}명`;
const per1000Text = value => value === null ? "—" : `${value.toFixed(2)}명`;
const ratioText = value => `${(value * 100).toFixed(2)}%`;
const money = value => `${count(value)}원`;
const byId = id => document.getElementById(id);
const province = byId("province");
const district = byId("region");
const multiScope = byId("use-multiple");
const scopePicks = byId("scope-picks");
const peer = byId("peer");
const budget = byId("budget");
const fileInput = byId("source-file");
const regionQuery = byId("region-query");
const regionFlag = byId("region-flag");
const regionSort = byId("region-sort");
const neighborMode = byId("neighbor-mode");
const reviewSize = byId("review-size");
const provinceNames = Object.keys(geography);
const examples = Object.entries(geography).flatMap(([province, districts], group) =>
  districts.map((district, index) => {
    const demand = 90 + (group * 71 + index * 29) % 610;
    const users = (group + index * 3) % 59 === 12 ? null :
      Math.floor(demand * (25 + (group * 13 + index * 11) % 56) / 100);
    return { id: `${province} ${district}`, province, district, demand, users };
  })
);
let allRows = examples;
let records = new Map(examples.map(row => [row.id, row]));
let focusId = "";
let official = false;
let sourceRequest = 0;
const regionalCosts = {};
const allocation = (rows, amount, costs=regionalCosts) => compareCostedAllocations(rows, amount, costs);
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function clearClusters(){
  byId('cluster-results').hidden=true;
  byId('cluster-excluded').hidden=true;
  byId('cluster-status').textContent='지역 범위·자료·포함 기준이 변경되었거나 아직 계산하지 않았습니다. 지역 유형 분석을 다시 실행하세요.';
}
byId('cluster-above').addEventListener('change',clearClusters);
byId('cluster-run').addEventListener('click',()=>{
  const rows=scopeRows(),result=analyzeClusters(rows,byId('cluster-above').checked);
  byId('cluster-results').hidden=result.status!=='OK';
  byId('cluster-excluded').hidden=false;
  byId('cluster-excluded').textContent=result.excluded.map(r=>r.id+' · '+r.reason).join(' / ')||'제외 지역 없음';
  if(result.status!=='OK'){
    byId('cluster-status').textContent=result.message+' 선택 '+rows.length+'곳 · 유효 '+result.validCount+'곳 · 제외 '+result.excluded.length+'곳';
    return;
  }
  byId('cluster-status').textContent=`${official?'공식 원본':'가상 예시'} · 포함 ${result.rows.length}곳 / 선택 ${rows.length}곳 · 제외 ${result.excluded.length}곳 · ${result.chosen_k}개 유형 · 시드 간 ARI ${result.seed_ari.toFixed(4)} (정확도 아님)`;
  byId('cluster-candidates').innerHTML=result.candidates.map(c=>`<tr><td>${c.k}</td><td>${c.mean_silhouette.toFixed(6)}</td><td>${c.k===result.chosen_k?'선택':''}</td></tr>`).join('');
  byId('cluster-profiles').innerHTML=result.profiles.map(p=>`<tr><th>${p.cluster}</th><td>${p.regions}곳</td><td>${people(p.median_demand)}</td><td>${ratioText(p.median_raw_ratio)}</td></tr>`).join('');
  byId('cluster-members').innerHTML=result.rows.map(r=>`<tr><th>${escape(r.id)}</th><td>${r.cluster}</td><td>${escape(r.source_quadrant)}</td><td>${people(r.demand)}</td><td>${ratioText(r.raw_ratio)}</td></tr>`).join('');
  const cross=new Map();result.rows.forEach(r=>{const key=JSON.stringify([r.cluster,r.source_quadrant]);cross.set(key,(cross.get(key)||0)+1);});
  byId('cluster-cross').innerHTML=[...cross].map(([key,n])=>{const [c,q]=JSON.parse(key);return `<tr><th>${c}</th><td>${escape(q)}</td><td>${n}곳</td></tr>`;}).join('');
});
function renderCosts(rows){
  byId('cost-rows').innerHTML=rows.filter(r=>r.users!==null&&r.demand>0).map(r=>`<tr><th>${escape(r.id)}</th><td>${people(r.demand)}</td><td><input type="number" min="1" max="10000000000" step="1" value="${escape(regionalCosts[r.id]??30000000)}" data-cost="${escape(r.id)}" aria-label="${escape(r.id)} 연간 단가(원)"></td></tr>`).join('')||'<tr><td colspan="3">단가를 입력할 계산 대상 지역이 없습니다.</td></tr>';
}
function invalidateCosts(){
  byId('allocation-table').hidden=true;byId('breakdown').hidden=true;
  byId('calc-summary').textContent='단가 입력이 변경되어 이전 결과를 숨겼습니다. 세 가지 배분 대안을 다시 계산하세요.';clearBudgetComparison();
}
byId('cost-rows').addEventListener('input',event=>{
  const field=event.target.closest('[data-cost]');if(!field)return;
  regionalCosts[field.dataset.cost]=field.value.trim()===''?NaN:Number(field.value);invalidateCosts();
});
byId('cost-reset').addEventListener('click',()=>{Object.keys(regionalCosts).forEach(k=>delete regionalCosts[k]);renderCosts(scopeRows());invalidateCosts();});
byId('allocation-run').addEventListener('click',()=>renderAllocation(scopeRows()));

function renderReview() {
  const size = Number(reviewSize.value);
  const rates = [6, 8, 12, 11, 14].slice(0, size);
  const middle = [...rates].sort((a, b) => a - b)[Math.floor(size / 2)];
  const direction = 9 > middle ? "높습니다" : "낮습니다";
  byId("review-result").textContent = `가상 A군 9.00명은 유사 ${size}곳 중앙값 ${per1000Text(middle)}보다 ${direction}.`;
  byId("review-inputs").textContent = `가상 비교 지역의 1,000명당 수요군 B · ${rates.map(per1000Text).join(" · ")}`;
}

reviewSize.addEventListener("change", renderReview);
renderReview();
for (const link of document.querySelectorAll("[data-open-source]")) {
  link.addEventListener("click", () => { byId("source").open = true; });
}

function addOptions(select, items) {
  for (const [value, label] of items) select.add(new Option(label, value));
}

function updateDistrictOptions() {
  district.replaceChildren(new Option("전체 시군구", ""));
  addOptions(district, allRows.filter(row => !province.value || row.province === province.value)
    .map(row => [row.id, province.value ? row.district : row.id]));
}

function scopeRows() {
  if (multiScope.checked) {
    const chosen = new Set([...scopePicks.querySelectorAll("input:checked")].map(input => input.value));
    return allRows.filter(row => chosen.has(row.province) || chosen.has(row.id));
  }
  return allRows.filter(row => (!province.value || row.province === province.value) &&
    (!district.value || row.id === district.value));
}

function ratio(summary) {
  return summary.ratioDemand ? summary.ratioUsers / summary.ratioDemand : null;
}

function warning(row) {
  const flags = [];
  if (row.users === null) flags.push("이용자 수 미상");
  if (!row.demand) flags.push("수요 0");
  if (row.demand > 0 && row.users !== null && row.users > row.demand) flags.push("100% 초과");
  return flags.join(" · ") || "—";
}

function displayRows(rows) {
  const query = regionQuery.value.replace(/\s/g, "");
  const flag = official ? regionFlag.value : "";
  const result = rows.filter(row => {
    const name = row.id.replace(/\s/g, "");
    return (name.includes(query) || name.replace(/특별자치[시도]|특별시|광역시/g, "").includes(query)) &&
      (flag !== "missing" || row.users === null) &&
      (flag !== "above" || (row.demand > 0 && row.users !== null && row.users > row.demand));
  });
  const field = regionSort.value;
  if (field) result.sort((a, b) => demographics(b.id)[field] - demographics(a.id)[field] ||
    (a.id < b.id ? -1 : Number(a.id > b.id)));
  return result;
}

const signed = (value, digits) => `${value > 0 ? "+" : ""}${digits === undefined ? count(value) : value.toFixed(digits)}`;
const signedRate = value => `${value > 0 ? "+" : ""}${ratioText(value)}`;

function renderNeighbors(focus) {
  const mode = neighborMode.value;
  const age = compareNeighbors(focus, "age", records, official);
  const comparison = mode === "household" ? compareNeighbors(focus, mode, records, official) : age;
  const provinceOnly = mode === "province";
  byId("neighbor-table").hidden = provinceOnly || !comparison;
  byId("neighbor-sensitivity").textContent = "";
  if (provinceOnly) {
    const context = populationContext(allRows.filter(row => row.province === focus.province), population.regions, official);
    byId("neighbor-summary").textContent = `${focus.province} 전체 · 65세 이상 ${people(context.population)} · 1,000명당 수요군 B ${official ? per1000Text(context.demandPer1000) : "원본 열기"}`;
  } else if (comparison) {
    byId("neighbor-rows").innerHTML = [focus.id, ...comparison.peers].map(key => {
      const data = demographics(key);
      const row = records.get(key);
      return `<tr><th scope="row">${key}</th><td>${people(data.older)}</td><td>${ratioText(data.ageShare)}</td><td>${ratioText(data.singleShare)}</td><td>${official ? people(row.demand) : "—"}</td><td>${official ? per1000Text(row.demand * 1000 / data.older) : "—"}</td></tr>`;
    }).join("");
    byId("neighbor-summary").textContent = official ?
      `고령인구 1,000명당 수요군 B ${per1000Text(comparison.rate)} · 유사 5곳 중앙값 ${per1000Text(comparison.median)} · 선택 지역 − 중앙값: 수요군 B ${signed(focus.demand - comparison.demand)}명, 1,000명당 ${comparison.rate >= comparison.median ? "+" : ""}${(comparison.rate - comparison.median).toFixed(2)}명` :
      "공식 인구 통계로 찾은 유사 5곳입니다. 수요군 B와 중앙값은 공식 돌봄 원본을 열면 표시됩니다.";
    if (official && mode === "age") {
      byId("neighbor-sensitivity").textContent = "비교 대상 수에 따른 중앙값 · " +
        comparison.medians.map((value, i) => `${3 + 2 * i}곳 ${per1000Text(value)}`).join(" · ");
    }
  } else {
    byId("neighbor-summary").textContent = "유사 지역 자료를 확인할 수 없습니다.";
  }
  byId("follow-up").replaceChildren(...followUp(focus, age?.sensitive, official).map(note => {
    const item = document.createElement("li");
    item.textContent = note;
    return item;
  }));
}

function formula(summary) {
  return summary.ratioDemand ? `${people(summary.ratioUsers)} ÷ ${people(summary.ratioDemand)}` : "계산 불가";
}

function renderDetail() {
  const focus = allRows.find(row => row.id === focusId);
  byId("detail").hidden = !focus;
  if (!focus) return;
  const prior = peer.value;
  const provinceLabel = `${focus.province} 전체`;
  peer.replaceChildren(new Option(provinceLabel, ""));
  addOptions(peer, allRows.filter(row => row.id !== focusId).map(row => [row.id, row.id]));
  peer.value = allRows.some(row => row.id === prior && row.id !== focusId) ? prior : "";
  const comparison = allRows.find(row => row.id === peer.value);
  const peerRows = comparison ? [comparison] : allRows.filter(row => row.province === focus.province);
  const summary = summarize([focus]);
  const other = summarize(peerRows);
  const focusPopulation = populationContext([focus], population.regions, official);
  const peerPopulation = populationContext(peerRows, population.regions, official);
  const metric = item => ratio(item) === null ? "미상" : ratioText(ratio(item));
  const peerLabel = comparison?.id ?? provinceLabel;
  const peerWarning = comparison ? warning(comparison) : `이용 미상 ${other.missing}곳 · 100% 초과 ${other.above}곳`;
  const context = demographics(focus.id);
  const values = [
    ["수요군 B", people(summary.demand), people(other.demand)],
    ["확인된 연간 이용자", people(summary.users), people(other.users)],
    ["이용 대 수요 비율", metric(summary), metric(other)],
    ["65세 이상 인구", people(focusPopulation.population), people(peerPopulation.population)],
    ["65세 이상 인구 1,000명당 수요군 B", per1000Text(focusPopulation.demandPer1000), per1000Text(peerPopulation.demandPer1000)],
    ["자료 표시", warning(focus), peerWarning],
    ["80세 이상 인구 / 비중", `${people(context.age80)} / ${ratioText(context.ageShare)}`, "—"],
    ["65세 이상 1인세대 / 비중", `${count(context.single65)}세대 / ${ratioText(context.singleShare)}`, "—"],
    ["고령인구 증감 / 증감률", `${signed(context.change)}명 / ${signedRate(context.growth)}`, "—"],
  ];
  byId("detail-head").innerHTML = `<tr><th scope="col">지표</th><th scope="col">${focus.id}</th><th scope="col">${peerLabel}</th></tr>`;
  byId("detail-rows").innerHTML = values.map(([name, a, b]) =>
    `<tr><th scope="row">${name}</th><td>${a}</td><td>${b}</td></tr>`).join("");
  const delta = ratio(summary) !== null && ratio(other) !== null ?
    ` · 비율 차이 ${((ratio(summary) - ratio(other)) * 100).toFixed(2)}%p` : "";
  const source = official ?
    ` · 원본 13번 시트 C${focus.sourceRow} 수요군 B ${people(focus.demand)} · E${focus.sourceRow} 연간 이용자 ${focus.users===null ? (focus.sourceUsers==="-" ? "대시(-) · 미상" : "빈 셀 · 미상") : people(focus.users)}` : "";
  byId("detail-basis").textContent = `선택 지역 ${formula(summary)} · 비교 대상 ${formula(other)}${delta}${source}`;
  const provider = byId("provider-link");
  provider.href = `https://www.1661-2129.or.kr/organization/sub01.php?og_type=${encodeURIComponent(focus.province)}`;
  provider.textContent = `${focus.province} 공식 수행기관 목록 열기`;
  renderNeighbors(focus);
}

function renderOverview(rows) {
  const summary = summarize(rows);
  const context = populationContext(rows, population.regions, official);
  byId("area-count").textContent = `${count(rows.length)}곳`;
  byId("demand").textContent = rows.length ? people(summary.demand) : "—";
  byId("observed").textContent = rows.length ? people(summary.users) : "—";
  byId("unknown").textContent = `${count(summary.missing)}곳`;
  byId("older-population").textContent = people(context.population);
  byId("demand-per-1000").textContent = official ? per1000Text(context.demandPer1000) : "원본 열기";
  const shown = displayRows(rows);
  const provinces = provinceNames.map(name => {
    const selected = rows.filter(row => row.province === name);
    return {name, size: selected.length, summary: summarize(selected)};
  }).filter(group => group.size);
  const axis = Math.max(1, ...provinces.map(group => Math.max(group.summary.demand, group.summary.users ?? 0)));
  const ratioAxis = Math.max(1, ...provinces.map(group => ratio(group.summary) ?? 0));
  const ratioBar = summary => ratio(summary) === null ? "미상" :
    `<progress max="${ratioAxis}" value="${ratio(summary)}" aria-hidden="true"></progress> ${ratioText(ratio(summary))} · ${formula(summary)}`;
  const bar = value => value === null ? "미상" : `<progress max="${axis}" value="${value}" aria-hidden="true"></progress> ${people(value)}`;
  byId("province-summary").innerHTML = provinces.map(({name,size,summary}) =>
    `<tr><th scope="row">${escape(name)}</th><td>${size}곳</td><td>${bar(summary.demand)}</td><td>${bar(summary.users)}</td><td>${ratioBar(summary)}</td><td>${summary.missing}곳</td></tr>`
  ).join("") || '<tr><td colspan="6">먼저 분석할 지역을 선택하세요.</td></tr>';
  byId("result-count").textContent = `현황표 ${count(shown.length)}곳 · 배분에는 시도·시군구 선택 범위를 사용합니다.`;
  byId("region-rows").innerHTML = shown.map(row => {
    const currentRatio = row.demand > 0 && row.users !== null ? ratioText(row.users / row.demand) : "—";
    const localPopulation = populationContext([row], population.regions, official);
    const data = demographics(row.id);
    return `<tr class="${row.users === null ? "row-unknown" : ""}"><th scope="row">
      <button class="row-link" type="button" data-area="${row.id}">${row.id}</button></th>
      <td>${people(row.demand)}</td><td>${people(row.users)}</td><td>${currentRatio}</td><td>${warning(row)}</td>
      <td>${people(localPopulation.population)}</td><td>${per1000Text(localPopulation.demandPer1000)}</td>
      <td>${people(data.age80)} / ${ratioText(data.ageShare)}</td>
      <td>${count(data.single65)}세대 / ${ratioText(data.singleShare)}</td>
      <td>${signed(data.change)}명 / ${signedRate(data.growth)}</td></tr>`;
  }).join("") || '<tr><td colspan="10">조건에 맞는 지역이 없습니다.</td></tr>';
  byId("basis").textContent = summary.ratioDemand ?
    `이용 대 수요 비율 ${ratioText(ratio(summary))} · ${formula(summary)}. 이용값이 확인되고 수요가 양수인 ${count(summary.comparable)}곳을 집계했습니다.` :
    "이용값이 확인되고 수요가 양수인 지역이 없어 비율을 계산할 수 없습니다.";
  renderDetail();
}

function renderAllocation(rows) {
  const amount = Number(budget.value) * 1_000_000;
  byId("budget-label").textContent = money(amount);
  budget.setAttribute("aria-valuetext", money(amount));
  const { areas, limit, results } = allocation(rows, amount);
  byId("allocation-table").hidden = false;
  byId("breakdown").hidden = !areas.length;
  byId("calc-summary").textContent = areas.length ?
    `계산 대상 ${count(areas.length)}곳 · 제외 ${rows.length - areas.length}곳 · 예산으로 살 수 있는 자원 최대 ${limit}단위` :
    results[0].reason;
  byId("allocation-rows").innerHTML = results.map(result =>
    `<tr><th scope="row">${result.name}</th><td>${result.status === "CALCULATED" ? "입력 가정 계산 완료" : result.status === "NO_DATA" ? "계산 대상 없음" : "입력 확인 필요"}<br><small>${result.reason}</small></td>
      <td>${result.lowest === null ? "미산출" : `<span class="ratio"><progress max="1" value="${result.lowest}" aria-hidden="true"></progress>${ratioText(result.lowest)}</span>`}</td>
      <td>${result.extra === null ? "미산출" : people(result.extra)}</td><td>${result.spent === null ? "미산출" : money(result.spent)}</td></tr>`).join("");
  const adjusted = areas.map((area, i) => ({ id: area.id, units: results.map(result => result.units[i]) }))
    .filter(row => row.units.some(units => units > 0));
  byId("allocation-detail").innerHTML = adjusted.map(row =>
    `<tr><th scope="row">${row.id}</th>${row.units.map(units => `<td>${units}단위</td>`).join("")}</tr>`).join("") ||
    '<tr><td colspan="4">추가 배분 지역 없음</td></tr>';
}

function renderScope() {
  const rows = scopeRows();
  if (!rows.some(row => row.id === focusId)) focusId = "";
  renderOverview(rows);
  renderCosts(rows);
  const exceptions = rows.filter(row => row.users === null || row.demand === 0 || row.users > row.demand);
  byId("allocation-quality").innerHTML = exceptions.map(row => {
    const reason = row.users === null ? "이용자 수 미상 · 계산 제외" : row.demand === 0 ? "수요 0 · 계산 제외" :
      `이용자 ${people(row.users)}이 수요 ${people(row.demand)}을 초과해 모형 기준량을 ${people(row.demand)}으로 제한`;
    return `<li>${escape(row.id)} · ${reason}</li>`;
  }).join("") || (rows.length ? "<li>제외되거나 기준량이 제한된 지역이 없습니다.</li>" : "<li>분석할 지역을 먼저 선택하세요.</li>");
  clearClusters();
  clearAllocation();
  clearBudgetComparison();
}

function setData(rows, verified) {
  const selectedDistrict = district.value;
  allRows = rows;
  records = new Map(rows.map(row => [row.id, row]));
  official = verified;
  byId("data-mode").textContent = official ? "공식 원본 · 2025년" : "예시 수치";
  byId("data-mode").classList.toggle("verified", official);
  byId("data-description").textContent = official ?
    "보건복지부 실태조사 부가통계 13번 시트의 C열 수요군 B와 E열 연간 이용자 수를 확인합니다." :
    "전국 229개 분석 지역을 예시 수치로 체험합니다. 실제 수치는 보건복지부 공식 파일을 열어 확인할 수 있습니다.";
  byId("population-mode").hidden = official;
  byId("reset-source").hidden = !official;
  for (const option of Array.from(regionFlag.options).slice(1)) option.disabled = !official;
  if (!official) regionFlag.value = "";
  updateDistrictOptions();
  district.value = selectedDistrict;
  renderScope();
}

addOptions(province, provinceNames.map(name => [name, name]));
scopePicks.innerHTML = provinceNames.map(name => {
  const option = (value,label) => `<label><input type="checkbox" value="${escape(value)}"> ${escape(label)}</label> `;
  return `<details><summary>${escape(name)}</summary><div class="scope-options">${option(name,name+" 전체")}${geography[name].map(d => option(name+" "+d,d)).join("")}</div></details>`;
}).join("");
function switchScope() {
  province.disabled = district.disabled = multiScope.checked;
  byId("multiple-scope").hidden = !multiScope.checked;
}
multiScope.addEventListener("change", () => { switchScope(); renderScope(); });
scopePicks.addEventListener("change", renderScope);
updateDistrictOptions();
province.addEventListener("change", () => {
  updateDistrictOptions();
  peer.value = "";
  renderScope();
});
district.addEventListener("change", () => {
  focusId = district.value;
  peer.value = "";
  renderScope();
});
peer.addEventListener("change", renderDetail);
neighborMode.addEventListener("change", renderDetail);
for (const field of [regionQuery, regionFlag, regionSort]) {
  field.addEventListener(field === regionQuery ? "input" : "change", () => renderOverview(scopeRows()));
}
budget.addEventListener("input", () => { clearAllocation(); clearBudgetComparison(); });
byId("region-rows").addEventListener("click", event => {
  const target = event.target.closest("[data-area]");
  if (!target) return;
  focusId = target.dataset.area;
  peer.value = "";
  renderDetail();
  byId("detail-title").focus();
});
byId("example-actions").addEventListener("click", event => {
  const target = event.target.closest("[data-example]");
  if (!target) return;
  const selected = records.get(target.dataset.example);
  multiScope.checked = false;
  switchScope();
  province.value = selected.province;
  updateDistrictOptions();
  district.value = selected.id;
  focusId = selected.id;
  regionQuery.value = "";
  regionFlag.value = "";
  peer.value = "";
  neighborMode.value = "age";
  renderScope();
  byId("detail-title").focus();
});
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const request = ++sourceRequest;
  byId("source-status").textContent = "파일과 전국 지역을 확인하고 있습니다…";
  try {
    const { rows, workbookHash, parsedHash } = await readOfficialRows(file);
    if (request !== sourceRequest) return;
    setData(rows, true);
    byId("workbook-hash").textContent = workbookHash;
    byId("parsed-hash").textContent = parsedHash;
    byId("source-fingerprints").hidden = false;
    byId("source-status").textContent = `공식 원본 일치 · 17개 시도 ${rows.length}곳 확인`;
  } catch (error) {
    if (request !== sourceRequest) return;
    byId("source-status").textContent = official ?
      `${error.message} 직전에 확인한 공식 원본을 계속 표시합니다.` : error.message;
  } finally {
    if (request === sourceRequest) fileInput.value = "";
  }
});
byId("reset-source").addEventListener("click", () => {
  sourceRequest++;
  setData(examples, false);
  byId("source-fingerprints").hidden = true;
  byId("source-fingerprints").open = false;
  byId("workbook-hash").textContent = "";
  byId("parsed-hash").textContent = "";
  byId("source-status").textContent = "예시 수치로 전환했습니다.";
});
function clearBudgetComparison() {
  byId("budget-comparison").hidden = true;
  byId("comparison-status").textContent = "선택 지역과 예산을 확인한 뒤 두 조건을 계산하세요.";
}

function clearAllocation() {
  const amount = money(Number(budget.value) * 1_000_000);
  byId("budget-label").textContent = amount;
  budget.setAttribute("aria-valuetext", amount);
  byId("allocation-table").hidden = true;
  byId("breakdown").hidden = true;
  byId("calc-summary").textContent = "현재 지역과 예산으로 세 가지 배분 대안을 계산하세요.";
}

for (const field of [byId("budget-base"), byId("budget-alternative"),byId('cost-percent')]) {
  field.addEventListener("change", clearBudgetComparison);
  field.addEventListener('input',clearBudgetComparison);
}
byId('compare-mode').addEventListener('change',()=>{
  const price=byId('compare-mode').value==='cost';byId('cost-percent').disabled=!price;byId('budget-alternative').disabled=price;clearBudgetComparison();
});
byId("compare-budgets").addEventListener("click", () => {
  const rows = scopeRows();
  const base = Number(byId("budget-base").value);
  const price=byId('compare-mode').value==='cost';
  const change = price?base:Number(byId("budget-alternative").value);
  if (!price&&base === change) {
    clearBudgetComparison();
    byId("comparison-status").textContent = "서로 다른 예산 두 개를 선택하세요.";
    return;
  }
  const first = allocation(rows, base);
  let second;
  try {
    const costs = price ? scaledCosts(rows, regionalCosts, Number(byId('cost-percent').value)) : regionalCosts;
    second = allocation(rows, change, costs);
  } catch (error) {
    second = unavailableAllocation("INPUT_ERROR", error.message);
  }
  byId("comparison-status").textContent = `${official ? "공식 원본" : "예시 수치"} · 선택 ${rows.length}곳 · ${money(base)} → ${money(change)}${price?` · 지역별 입력 단가 × ${byId('cost-percent').value}% (원 단위 반올림)`:''}`;
  const ranksBefore = alternativeRanks(first.results), ranksAfter = alternativeRanks(second.results);
  byId("budget-comparison-rows").innerHTML = first.results.map((left, i) => {
    const right = second.results[i];
    const done = left.status === "CALCULATED" && right.status === "CALCULATED";
    const describe = result => result.status === "CALCULATED" ? "계산 완료" :
      (result.status === "NO_DATA" ? "자료 없음" : "계산 오류") + " · " + escape(result.reason);
    const status = done ? "두 조건 계산 완료" : "기준 " + describe(left) + "<br>변경 " + describe(right);
    const metric = (key,format,delta) => {
      const a=left[key], b=right[key];
      return (a===null?"미산출":format(a))+" → "+(b===null?"미산출":format(b))+"<br>차이 "+(done?delta(b-a):"미산출");
    };
    return `<tr><th scope="row">${left.name}</th><td>${status}</td><td>${metric("lowest",ratioText,n=>signed(n*100,2)+"%p")}</td><td>${metric("extra",people,n=>signed(n)+"명")}</td><td>${metric("spent",money,n=>signed(n)+"원")}</td><td>${ranksBefore[i]} → ${ranksAfter[i]}</td></tr>`;
  }).join("");
  const allCalculated = [...first.results,...second.results].every(result => result.status === "CALCULATED");
  byId("budget-comparison-regions").innerHTML = !allCalculated ? '<tr><td colspan="4">계산되지 않은 조건이 있어 지역별 배분 변화를 비교할 수 없습니다.</td></tr>' : first.areas.map((area, index) => {
    const cells = first.results.map((result, i) => [result.units[index], second.results[i].units[index]]);
    if (!cells.some(([left, right]) => left !== right)) return "";
    return `<tr><th scope="row">${area.id}</th>${cells.map(([left, right]) => `<td>${left} → ${right}단위</td>`).join("")}</tr>`;
  }).join("") || '<tr><td colspan="4">배분이 달라진 지역이 없습니다.</td></tr>';
  byId("budget-comparison").hidden = false;
});
renderScope();
