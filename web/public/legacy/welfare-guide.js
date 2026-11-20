import { welfareCatalog } from "./welfare-catalog.js";
import { geography } from "./regions.js";
import { findServices, comparisonNotices, directoryRoute } from "./welfare-search.js";

const byId = id => document.getElementById(id);
const catalog = welfareCatalog.services;
const chosen = new Set();
const ready = new Map();
let preparedRegion = null;
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const link = (text, url) => {
  const element = make("a", text, "text-link");
  element.href = url;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  return element;
};
const fields = [["대상 안내", "target"], ["지원 내용", "support"], ["신청 시작", "start"],
  ["상담 전 확인", "check"], ["진행 절차", "process"], ["제공 범위", "coverage"],
  ["공식 출처", "source_name"], ["공식 안내 확인일", "checked_on"]];

function renderComparison() {
  const selections = [...chosen].map(id => catalog.find(item => item.id === id));
  byId("welfare-comparison").hidden = selections.length === 0;
  byId("welfare-selected").textContent = `비교 선택 ${selections.length}개 / 최대 3개 · 검색 조건을 바꿔도 선택은 유지됩니다.`;
  byId("welfare-compare-notice").textContent = comparisonNotices([...chosen]).join(" ");
  byId("welfare-chosen").replaceChildren(...selections.map(item => {
    const remove = make("button", `${item.name} 선택 해제`, "secondary");
    remove.type = "button";
    remove.addEventListener("click", () => { chosen.delete(item.id); renderServices(); renderComparison(); });
    return remove;
  }));
  const head = make("tr");
  head.append(make("th", "항목"), ...selections.map(item => make("th", item.name)));
  for (const cell of head.children) cell.scope = "col";
  byId("welfare-comparison-head").replaceChildren(head);
  const rows = fields.map(([label, field]) => {
    const row = make("tr");
    const title = make("th", label);
    title.scope = "row";
    row.append(title, ...selections.map(item => {
      const cell = make("td", field === "source_name" ? "" : item[field]);
      if (field === "source_name") cell.append(link(item.source_name, item.source_url));
      if (field === "start") cell.append(make("br"), link(item.action_label, item.action_url));
      return cell;
    }));
    return row;
  });
  byId("welfare-comparison-body").replaceChildren(...rows);
}

function renderServices() {
  const matches = findServices(catalog, byId("welfare-query").value, byId("welfare-need").value,
    byId("welfare-group").value, byId("welfare-channel").value);
  byId("welfare-status").textContent = `안내 서비스 ${matches.length}개 / 등록 ${catalog.length}개 · 공식 안내 확인일 ${welfareCatalog.checked_on}`;
  const cards = matches.map(item => {
    const card = make("article", "", "service-card");
    card.append(make("h3", item.name), make("p", `${item.needs.join(" · ")} / ${item.groups.join(" · ")}`, "small"), make("p", item.support));
    const label = make("label", "", "service-check");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = chosen.has(item.id);
    check.setAttribute("aria-label", `${item.name} 비교`);
    check.addEventListener("change", () => {
      if (check.checked && chosen.size === 3) {
        check.checked = false;
        byId("welfare-selected").textContent = "최대 3개까지 비교할 수 있습니다. 선택한 서비스를 먼저 해제하세요.";
        return;
      }
      if (check.checked) chosen.add(item.id);
      else chosen.delete(item.id);
      renderComparison();
    });
    label.append(check, document.createTextNode("비교에 추가"));
    card.append(label);
    const detail = document.createElement("details");
    detail.append(make("summary", "대상·신청 방법 보기"));
    const list = make("dl", "", "service-definitions");
    for (const [text, field] of fields.filter(([, field]) => field !== "source_name")) {
      const pair = make("div");
      pair.append(make("dt", text), make("dd", item[field]));
      list.append(pair);
    }
    detail.append(list, link(item.action_label, item.action_url), make("p", "출처와 기준 확인", "small"),
      link(item.source_name, item.source_url), make("p", "공식 신청·상담 방식: " + item.channels.join(" / "), "small"));
    card.append(detail);
    return card;
  });
  byId("welfare-cards").replaceChildren(...cards);
  if (!matches.length) byId("welfare-cards").append(make("p", "검색어를 줄이거나 필요한 도움을 ‘전체’로 바꿔 보세요."));
}

function updateDistricts() {
  const select = byId("welfare-district");
  select.replaceChildren(new Option("전체 시군구", ""));
  for (const district of geography[byId("welfare-province").value] ?? []) {
    select.add(new Option(district, district));
  }
  renderProvider();
}

function renderProvider() {
  const province = byId("welfare-province").value;
  const district = byId("welfare-district").value;
  const region = JSON.stringify([province, district]);
  if (region !== preparedRegion) {
    // Clear regional confirmations for every service, including services not currently shown.
    for (const item of catalog) {
      const confirmed = ready.get(item.id);
      for (const index of item.regional_checklist_indices) confirmed?.delete(index);
    }
    preparedRegion = region;
  }
  byId("welfare-location").textContent = province ?
    `${province} ${district || "전체"} · 공식 목록의 시군구 열에서 기관명·주소·대표 연락처를 확인하세요.` :
    "시도를 고르면 해당 시도의 노인맞춤돌봄 공식 수행기관 목록으로 연결합니다.";
  const provider = byId("welfare-provider");
  provider.href = "https://www.1661-2129.or.kr/organization/sub01.php?og_type=" + encodeURIComponent(province || "전체");
  provider.textContent = province ? `${province} 노인맞춤돌봄 공식 수행기관 목록` : "전국 노인맞춤돌봄 공식 수행기관 목록";
  renderPlan();
}

function renderPlan() {
  const item = catalog.find(row => row.id === byId("welfare-plan").value);
  if (!item) return;
  const province = byId("welfare-province").value;
  const district = byId("welfare-district").value;
  const [title, url, instruction] = directoryRoute(item, province);
  byId("welfare-plan-region").textContent = `${province ? province + " " + (district || "전체") : "상담할 지역을 위에서 선택하세요"} · ${item.name}`;
  byId("welfare-plan-instruction").textContent = instruction;
  byId("welfare-plan-link").href = url;
  byId("welfare-plan-link").textContent = title;
  const confirmed = ready.get(item.id) || new Set();
  ready.set(item.id, confirmed);
  const count = () => { byId("welfare-prepared").textContent = `확인 표시 ${confirmed.size}/${item.checklist.length} · 현재 화면의 준비 표시이며 실제 신청·접수 상태는 아닙니다.`; };
  byId("welfare-checklist").replaceChildren(...item.checklist.map((text, index) => {
    const label = make("label", "", "service-check");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = confirmed.has(index);
    check.addEventListener("change", () => { if (check.checked) confirmed.add(index); else confirmed.delete(index); count(); });
    label.append(check, document.createTextNode(text));
    return label;
  }));
  byId("welfare-questions").textContent = `상담할 질문 · ${item.check} 필요한 신청서·대리신청 서류와 현재 접수 가능 여부도 물어보세요.`;
  count();
}

byId("welfare-scope").textContent = welfareCatalog.scope_note;
byId("welfare-selection-note").textContent = welfareCatalog.selection_note;
for (const [id, values] of [["welfare-need", welfareCatalog.needs], ["welfare-group", welfareCatalog.groups], ["welfare-channel", welfareCatalog.channels]]) {
  for (const value of values) byId(id).add(new Option(value, value));
}
for (const item of catalog) byId("welfare-plan").add(new Option(item.name, item.id));
byId("welfare-plan").addEventListener("change", renderPlan);
for (const province of Object.keys(geography)) byId("welfare-province").add(new Option(province, province));
byId("welfare-province").addEventListener("change", updateDistricts);
byId("welfare-district").addEventListener("change", renderProvider);
byId("welfare-query").addEventListener("input", renderServices);
byId("welfare-need").addEventListener("change", renderServices);
byId("welfare-group").addEventListener("change", renderServices);
byId("welfare-channel").addEventListener("change", renderServices);
byId("welfare-reset").addEventListener("click", () => {
  for (const id of ["welfare-query", "welfare-need", "welfare-group", "welfare-channel"]) byId(id).value = "";
  renderServices();
});
byId("welfare-clear").addEventListener("click", () => {
  chosen.clear();
  renderServices();
  renderComparison();
});
renderServices();
renderComparison();
renderProvider();
