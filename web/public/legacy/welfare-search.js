export function findServices(catalog, query = "", need = "", group = "", channel = "") {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return catalog.filter(item => {
    const text = [item.name, item.target, item.support, ...item.keywords].join(" ").toLocaleLowerCase();
    return (!need || need === "전체" || item.needs.includes(need)) &&
      (!group || group === "전체" || item.groups.includes(group) || item.groups.includes("가구공통")) &&
      (!channel || channel === "전체" || item.channels.includes(channel)) &&
      terms.every(term => text.includes(term));
  });
}

export function comparisonNotices(ids) {
  if (ids.includes("parent-pay") && ids.includes("childcare")) return ["부모급여와 보육료는 이용 방식에 따른 지급·정산 및 변경 신청 기준을 함께 확인하세요. 비교 선택은 동시 수급 가능 여부를 뜻하지 않습니다."];
  return ids.length > 1 ? ["함께 비교한 서비스의 중복 이용 가능 여부와 변경 신청 조건은 각 공식 창구에서 확인하세요."] : [];
}

export function directoryRoute(item, province = "") {
  if (item.directory === "daily-care") return ["노인맞춤돌봄 공식 수행기관 목록", "https://www.1661-2129.or.kr/organization/sub01.php?og_type=" + encodeURIComponent(province || "전체"), "공식 목록의 시군구 열에서 기관명·주소·대표 연락처를 확인하세요."];
  const routes = {
    "long-term-care": ["국민건강보험공단 장기요양 안내", "https://www.longtermcare.or.kr/", "공식 사이트에서 장기요양기관 찾기와 인정 신청 방법을 확인하세요."],
    dementia: ["공식 치매안심센터 안내", "https://ansim.nid.or.kr/", "공식 사이트에서 가까운 치매안심센터를 선택하세요."],
    disability: ["국민연금공단 장애인활동지원 제공기관 목록", "https://www.ableservice.or.kr/info/sprtinst/getOHGE0001M0.do", "공식 목록에서 시도·시군구를 선택해 활동지원 제공기관과 연락처를 확인하세요."],
    childcare: ["공식 아이사랑 보육 안내", "https://www.childcare.go.kr/", "공식 사이트에서 어린이집 찾기와 입소 안내를 확인하세요."],
    housing: ["공식 주거급여 안내", item.source_url, "주거급여 안내에서 조사·신청 창구를 확인하세요."],
    employment: ["공식 고용24 취업지원 안내", item.source_url, "공식 안내에서 고용센터 상담과 구직등록·신청 경로를 확인하세요."],
    education: ["공식 교육비 원클릭", "https://oneclick.neis.go.kr/nxui/index.html", "공식 사이트에서 교육급여·교육비 신청 경로를 확인하세요."]
  };
  return routes[item.directory] || [item.action_label, item.action_url, "선택 지역의 읍면동 행정복지센터 등 공식 접수 창구에 문의하세요. 기관별 접수·정원은 직접 확인합니다."];
}
