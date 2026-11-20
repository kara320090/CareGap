"""Rebuild the versioned dataset without changing the official workbook."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from caregap.workbook import SHEET, read_workbook
from caregap.data import dataset_digest


def extract(source: Path) -> dict:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != "400ce50bb882d950ca4947c2e33bd6ffdb4dcaee1b4503601186d908be3a3335":
        raise ValueError("기본 자료의 SHA-256이 검증한 2025년 부가통계 원본과 다릅니다.")
    records, summary = read_workbook(source)
    expected = (229, 228, 112243, 43223, 1, 5, 0)
    found = (summary["regions"], summary["known_users_regions"], summary["demand_b_sum"],
             summary["known_annual_users_sum"], len(summary["missing_users"]), len(summary["above_demand"]), summary["duplicate_keys"])
    if found != expected:
        raise ValueError(f"원자료 검증 기준과 다릅니다. 기대 {expected}, 확인 {found}")
    metadata = {
        "dataset_version": "mohw-elderly-focused-2025-v1", "title": "노인맞춤돌봄서비스 수요군 B와 연간 중점관리군 이용",
        "source_url": "https://www.mohw.go.kr/board.es?act=view&bid=0073&list_no=1492217&mid=a60401000000",
        "source_filename": source.name, "source_sha256": digest,
        "source_report_sha256": "9b626e9b0548ba27b097e94b6d2abd4cf2d20b6346f4d4bd5ce53d69fa7b53f5",
        "sheet": SHEET, "report_pages": [137, 138], "annual_users_period": "2025-01-01 / 2025-12-31",
        "demand_reference_period": None, "demand_reference_note": "수요군 B의 정확한 산출 기준시점은 원문과 추가 대조 필요",
        "definition": "연간 이용자는 해당 연도 1회 이상 이용한 중점관리군. 생활지원사 수는 이용자 수를 4로 나눈 환산값.",
        "interpretation": "현재 빈자리·실제 가용 인력·개인별 수급 자격을 나타내지 않는 공개 집계 비교 자료",
    }
    metadata["dataset_sha256"] = dataset_digest(metadata, records)
    return {"metadata": metadata, "audit": summary, "regions": records}


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data/source.xlsx"
    data = extract(source)
    (ROOT / "data/regions.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in data["audit"].items() if k != "excluded_aggregates"}, ensure_ascii=False))
