import { geography } from "./regions.js";

const workbookSize = 316898;
const workbookHash = "400ce50bb882d950ca4947c2e33bd6ffdb4dcaee1b4503601186d908be3a3335";
// Reference from the corresponding fields of the verified local dataset, in sheet order.
const officialRowsHash = "f77fdd1fe1a7b3543e454eac7ed58478d4e8308449e2eeb2ab26afbe62d23d9f";
const maxFileBytes = 2 * 1024 * 1024;
const maxXmlBytes = 4 * 1024 * 1024;
const decode = new TextDecoder();

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const searchLimit = Math.max(0, end - 65535);
  while (end >= searchLimit && (view.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + view.getUint16(end + 20, true) !== bytes.length)) end--;
  if (end < searchLimit) throw new Error("올바른 ZIP 또는 XLSX 파일이 아닙니다.");
  const count = view.getUint16(end + 10, true);
  const centralStart = view.getUint32(end + 16, true);
  let position = centralStart;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new Error("압축 목록이 손상됐습니다.");
    const nameLength = view.getUint16(position + 28, true);
    const nameStart = position + 46;
    entries.push({
      name: decode.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      flags: view.getUint16(position + 8, true),
      method: view.getUint16(position + 10, true),
      compressedSize: view.getUint32(position + 20, true),
      size: view.getUint32(position + 24, true),
      offset: view.getUint32(position + 42, true),
    });
    position = nameStart + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    if (position > end) throw new Error("압축 목록이 손상됐습니다.");
  }
  return { bytes, view, entries, centralStart };
}

async function readEntry(archive, entry, limit) {
  if (!entry || entry.size > limit || (entry.flags & 1) || ![0, 8].includes(entry.method)) {
    throw new Error("지원하는 압축 자료를 찾지 못했습니다.");
  }
  const { bytes, view, centralStart } = archive;
  const offset = entry.offset;
  if (offset + 30 > centralStart || view.getUint32(offset, true) !== 0x04034b50) throw new Error("압축 자료가 손상됐습니다.");
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  if (start + entry.compressedSize > centralStart) throw new Error("압축 자료가 손상됐습니다.");
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (data.length !== entry.size) throw new Error("압축 자료의 크기가 다릅니다.");
    return data;
  }
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const output = new Uint8Array(entry.size);
  let written = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (written + value.length > output.length) throw new Error("압축 자료의 크기가 다릅니다.");
      output.set(value, written);
      written += value.length;
    }
  } finally {
    await reader.cancel();
  }
  if (written !== output.length) throw new Error("압축 자료의 크기가 다릅니다.");
  return output;
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    value => value.toString(16).padStart(2, "0")).join("");
}

async function workbookBytes(file) {
  if (!/\.(zip|xlsx)$/i.test(file.name) || file.size > maxFileBytes) {
    throw new Error("보건복지부의 2MB 이하 공식 ZIP 또는 부가통계 XLSX를 선택하세요.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) {
    if (bytes.length === workbookSize && await digest(bytes) === workbookHash) return bytes;
  } else {
    const archive = zipEntries(bytes);
    for (const entry of archive.entries.filter(item => item.size === workbookSize && /\.xlsx$/i.test(item.name))) {
      const workbook = await readEntry(archive, entry, workbookSize);
      if (await digest(workbook) === workbookHash) return workbook;
    }
  }
  throw new Error("검증된 공식 원본과 일치하지 않습니다. 보건복지부 게시물의 ‘실태조사 결과(공개용) 최종본’ ZIP을 선택하세요.");
}

const elements = (node, name) => Array.from(node.getElementsByTagNameNS("*", name));

async function readXml(archive, name) {
  const data = await readEntry(archive, archive.entries.find(entry => entry.name === name), maxXmlBytes);
  const xml = new DOMParser().parseFromString(decode.decode(data), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("원본 표를 읽을 수 없습니다.");
  return xml;
}

export async function verifyOfficialRows(rows) {
  const values = rows.map(row => [row.id, row.sourceRow, row.demand, row.users, row.sourceQuadrant]);
  const parsedHash = await digest(new TextEncoder().encode(JSON.stringify(values)));
  if (parsedHash !== officialRowsHash) {
    throw new Error("원본에서 읽은 분석값이 검증한 229개 지역 자료와 일치하지 않습니다.");
  }
  return parsedHash;
}

export async function readOfficialRows(file) {
  if (!globalThis.crypto?.subtle || !globalThis.DecompressionStream) throw new Error("최신 Chrome 또는 Edge에서 원본을 열어 주세요.");
  const archive = zipEntries(await workbookBytes(file));
  const [shared, sheet] = await Promise.all([
    readXml(archive, "xl/sharedStrings.xml"),
    readXml(archive, "xl/worksheets/sheet13.xml"),
  ]);
  const strings = elements(shared, "si").map(item => elements(item, "t").map(t => t.textContent).join(""));
  const areaNames = new Set(Object.entries(geography).flatMap(([province, districts]) =>
    districts.map(district => `${province} ${district}`)));
  let province = "";
  const rows = [];
  for (const row of elements(sheet, "row")) {
    const number = Number(row.getAttribute("r"));
    if (number < 6) continue;
    const cells = new Map(elements(row, "c").map(cell => [cell.getAttribute("r"), cell]));
    const value = column => {
      const cell = cells.get(column + number);
      const v = cell && elements(cell, "v")[0];
      if (!v) return null;
      return cell.getAttribute("t") === "s" ? strings[Number(v.textContent)] : Number(v.textContent);
    };
    const district = value("A");
    if (Object.hasOwn(geography, district)) {
      province = district;
    } else if (areaNames.has(`${province} ${district}`)) {
      const observed = value("E");
      rows.push({ id: `${province} ${district}`, province, district, demand: value("C"),
        users: observed === "-" ? null : observed, sourceUsers: observed, sourceRow: number, sourceQuadrant: value("K") });
    }
  }
  if (rows.length !== areaNames.size || new Set(rows.map(row => row.id)).size !== areaNames.size ||
      rows.some(({ demand, users }) => !Number.isSafeInteger(demand) || demand < 0 ||
        (users !== null && (!Number.isSafeInteger(users) || users < 0)))) {
    throw new Error("전국 229곳의 지역 키 또는 수치를 검증하지 못했습니다.");
  }
  return { rows, workbookHash, parsedHash: await verifyOfficialRows(rows) };
}
