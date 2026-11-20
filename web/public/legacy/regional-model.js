import { population } from "./population.js";
import { regionalContext } from "./regional-context.js";

export const MISSING = "연간 이용자 미상입니다. E열 원본 셀과 값이 비어 있는 이유를 확인하세요.";
export const ABOVE = "이용 대 수요 비율이 100%를 넘습니다. C·E열 집계의 대상과 기준 기간을 확인하세요.";
export const SENSITIVE = "비교 대상을 3·5·7곳으로 바꾸면 중앙값 대비 방향이 달라집니다. 비교 기준과 지역 목록을 확인하세요.";
export const NORMAL = "수요군 B의 인원과 1,000명당 수치를 함께 보고 원본 셀과 기준일을 확인하세요.";

export function demographics(key) {
  const item = regionalContext.regions[key];
  const older = population.regions[key];
  if (!item || !older) return null;
  const change = older - item.prior65;
  return { ...item, older, change, ageShare: item.age80 / older,
    singleShare: item.single65 / older, growth: change / item.prior65 };
}

export function compareNeighbors(focus, mode, records, official) {
  const keys = demographics(focus.id)?.[mode];
  if (!keys || keys.some(key => !records.has(key))) return null;
  const peers = keys.slice(0, 5);
  if (!official) return { peers };
  const rate = focus.demand * 1000 / demographics(focus.id).older;
  const rates = keys.map(key => records.get(key).demand * 1000 / demographics(key).older);
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const medians = [3, 5, 7].map(size => median(rates.slice(0, size)));
  const signs = medians.map(value => Math.abs(rate - value) < .005 ? 0 : Math.sign(rate - value));
  return { peers, rate, median: medians[1], medians,
    demand: median(peers.map(key => records.get(key).demand)), sensitive: new Set(signs).size > 1 };
}

export function followUp(focus, sensitive, official) {
  if (!official) return ["공식 원본을 열면 선택 지역에서 확인할 자료와 이유가 표시됩니다."];
  const guidance = [];
  if (focus.users === null) guidance.push(MISSING);
  else if (focus.demand > 0 && focus.users > focus.demand) guidance.push(ABOVE);
  if (sensitive) guidance.push(SENSITIVE);
  return guidance.length ? guidance : [NORMAL];
}
