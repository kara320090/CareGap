# CareGap 로컬 시제품

주민과 보호자는 주요 복지제도 20개를 검색해 세 가지까지 비교하고, 공식 신청 창구·수행기관·상담 준비 항목을 확인할 수 있습니다. 담당자는 보건복지부 원본을 연결한 다음 전국 229개 지역의 노인맞춤돌봄 현황, 지도, 유사 지역·군집 분석과 예산 대안을 검토할 수 있습니다.

## 실행

1. Python 3.12를 설치하고 이 `local` 폴더에서 `설치.cmd`를 한 번 실행합니다. 설치 프로그램이 가상환경에 의존성을 설치합니다.
2. `실행.cmd`를 열고 브라우저에서 [로컬 시제품](http://127.0.0.1:8501)에 접속합니다. 복지 검색·비교와 상담 준비는 즉시 사용할 수 있습니다. 공식 사이트를 열려면 인터넷 연결이 필요합니다.
3. 통계 화면도 사용하려면 아래 순서로 공식 자료를 연결합니다.

macOS와 Linux에서는 이 폴더에서 다음 명령으로 실행할 수 있습니다. 고정 버전 파일은 Windows Python 3.12 검증 환경의 기록입니다.

```sh
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'
python -m streamlit run app.py --server.address 127.0.0.1
```

## 전국 돌봄 원본 연결

1. 보건복지부의 ‘실태조사 결과(공개용) 최종본’ ZIP을 받아 압축을 풉니다. [통합돌봄 실태조사 공고 및 첨부파일](https://www.mohw.go.kr/board.es?act=view&bid=0073&list_no=1492217&mid=a60401000000)
2. 첨부 4번 부가통계 XLSX를 이 폴더의 `data/source.xlsx`로 저장합니다. 이 파일과 변환된 `data/regions.json`은 사용자 PC에서 준비합니다.
3. Windows PowerShell에서 아래 명령을 실행하고 화면을 새로고침합니다. macOS와 Linux에서는 가상환경의 `python scripts/import_source.py`를 사용합니다.

```powershell
.\.venv\Scripts\python.exe scripts/import_source.py
```

변환기는 원본의 SHA-256, 13번 시트의 지역 키와 수치, 전국 합계를 검사합니다. 이 판본은 2025년 자료입니다. 다른 연도나 갱신된 파일은 지문과 지역 기준을 다시 검증해야 합니다. 정정본을 가진 경우 초기 판본을 준비한 뒤 앱의 **자료와 검증 → 자료 판본 검증·갱신**을 이용하세요.

## 포함한 자료

| 파일 | 기준과 출처 |
|---|---|
| `data/welfare_catalog.json` | 팀이 작성한 20개 복지 안내, 제도별 공식 안내 링크와 확인일 |
| `data/population_65plus_202512.json` | 2025년 12월 말 지역별 65세 이상 주민등록인구. [행정안전부 지역별 연령별 주민등록 인구현황](https://www.data.go.kr/data/3033304/fileData.do) |
| `data/regional_context.json` | 2025년 말 80세 이상 인구, 65세 이상 주민등록 1인세대, 전년 말 65세 이상 인구, 인구 특성으로 계산한 유사 지역 목록. [행정안전부 주민등록 1인세대 자료](https://www.data.go.kr/data/15097973/fileData.do) |
| `data/boundaries_2025q2.geojson` | 국가데이터처 SGIS 2025년 2분기 시군구 경계를 분석 지역으로 결합·단순화한 지도. [국가데이터처 SGIS 행정구역 통계 및 경계](https://www.data.go.kr/data/15129688/fileData.do) |

노인맞춤돌봄 수요군 B와 연간 이용자의 대상·시점은 화면의 원본 셀과 지표 정의에서 확인할 수 있습니다. 배분 결과는 사용자가 정한 비용·생산성에 따른 모형값입니다. 개인의 지원 자격과 실제 접수 가능 여부는 해당 제도의 공식 창구에서 확인합니다.

## 검증

이 폴더의 가상환경에서 명령을 실행합니다. Windows에서는 아래의 `python`을 `.\.venv\Scripts\python.exe`로 바꿀 수 있습니다.

```sh
# 공식 돌봄 엑셀이 없어도 실행할 수 있는 복지 안내 시험
python -m pytest -q tests/test_welfare_guide.py

# 원본을 연결한 후 전체 시험과 지역별 대조
python -m pytest -q
python scripts/audit_national.py
```

지역·인구 자료 재생성 스크립트는 `scripts/`에 있습니다. SGIS 원본 ZIP으로 지도를 다시 만들 때에는 먼저 `python -m pip install -e '.[geo]'`를 실행합니다. 공식 돌봄 원본, 로컬 시나리오·정정 기록, 내보낸 결과는 개인 작업 폴더에 보관하세요.
