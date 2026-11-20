# CareGap 웹

공개 데모 v44의 소스(기준 커밋 `0b0c2d40b6851bdc7544de7646cedc040415084f`)입니다. 주민·보호자는 검수된 복지제도 20개를 검색·비교하고 공식 신청 창구와 상담 준비 항목을 확인할 수 있습니다. 담당자는 2025년 기준 전국 229개 분석 지역의 수요와 이용 현황, 유사 지역, 군집, 예산 두 조건을 비교할 수 있습니다. [운영 데모](https://caregap-hybon-welfare20.hybonair.chatgpt.site)

## 시작하기

Node.js 24 LTS와 npm을 준비한 후 `web` 폴더에서 실행합니다.

```sh
npm ci
npm run build
```

새 로컬 데이터베이스를 처음 사용할 때 다음 세 명령을 순서대로 실행합니다. 이미 적용한 마이그레이션은 건너뜁니다.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_confused_havok.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_kind_forgotten_one.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_brainy_black_widow.sql
npm start
```

터미널에 표시된 로컬 주소를 엽니다. 첫 화면에서 **검수 안내만 보기**를 누르면 전국 공통 20개 제도를 탐색합니다. **돌봄 분석 열기**는 `/legacy/index.html`로 이동합니다. Python이 설치된 PC에서는 웹 데이터베이스 없이 `python -m http.server 8000 --bind 127.0.0.1 --directory public`로 분석 화면만 실행한 뒤 `http://127.0.0.1:8000/legacy/index.html`을 열 수도 있습니다.

## 분석 데이터와 공식 기관 안내

- **돌봄 수요와 이용 현황** · 초기 화면은 예시값을 표시합니다. ‘공식 원본으로 보기’에서 보건복지부 게시물의 공개용 실태조사 ZIP 또는 그 안의 4번 부가통계 XLSX를 선택하세요. 이 탭에서 원본 및 변환 자료의 SHA-256을 검사하고 13번 시트에서 실제 돌봄 지표를 계산합니다. [보건복지부 실태조사 첨부파일](https://www.mohw.go.kr/board.es?act=view&bid=0073&list_no=1492217&mid=a60401000000)
- **인구와 행정구역** · 분석 화면의 65세·80세 이상 인구, 고령인구 변동과 1인세대 특성은 행정안전부 공개 통계에 기반합니다. 행정코드에는 자료의 확인일이 있으며, 통계의 2025년 지역 구분과 신청 안내용 현행 지역 구분은 각각 유지합니다. [연령별 인구](https://jumin.mois.go.kr/ageStatMonth.do) · [주민등록 1인세대](https://www.data.go.kr/data/15097973/fileData.do) · [행정표준코드](https://www.code.go.kr/stdcodesrch/codeAllDownloadL.do)
- **기관 목록** · 운영 서버의 D1 레코드, 노인맞춤돌봄 수행기관 원본 사본, 복지로 지도 기관 주소·전화·좌표 묶음은 저장소에서 제외했습니다. 새 설치에서는 검수 안내, 공식 검색·기관 링크와 브라우저 분석을 사용할 수 있습니다. 실시간 수집이 필요한 기능은 본인의 자료와 서비스 인증 설정을 연결한 뒤 사용합니다.

## 기관 원천을 연결할 때

본인의 사용 권한과 이용 조건을 확인한 데이터만 준비하세요. 노인맞춤돌봄 수행기관 최신 목록을 로컬에 수집하려면 아래 명령을 실행합니다. 수집기는 중앙노인돌봄지원기관의 공식 화면을 읽어 건수와 형식을 검사합니다. 파일을 준비한 뒤 다시 빌드하고 시작하면 활성 기관 목록이 없는 로컬 D1에 첫 자료를 적재합니다. 이후 갱신에는 기존 `directory` 동기화 경로를 사용합니다. [공식 수행기관 목록](https://www.1661-2129.or.kr/organization/sub01.php)

```sh
npm exec -- esbuild scripts/collect-bootstrap.ts --bundle --platform=node --format=cjs --outfile=.sites-runtime/collect-directory.cjs
node .sites-runtime/collect-directory.cjs
npm run build
```

복지로 지도는 `lib/caregap/official-map.ts`의 실시간 수집기로 갱신합니다. 적법하게 확보한 기존 보완본을 복원할 때는 자체 생성한 manifest와 번호별 JSON 파일을 `data/official-facility-locations/`에 두고 다시 빌드합니다. 기본 설치에서 빈 보완본은 수집 성공으로 기록되지 않습니다. 공식 원천을 사용할 수 없으면 화면에 표시되는 공식 기관 조회 링크를 이용하세요.

서버의 공공데이터포털 인증키는 `DATA_GO_KR_KEY`, 카카오 지도 설정은 `KAKAO_JAVASCRIPT_KEY` 및 `KAKAO_REST_KEY`를 사용합니다. 서버용 키는 자체 호스팅 환경의 비밀 설정에 등록합니다. 소유자 동기화는 인증을 검증하는 Sites 실행 환경과 `SYNC_OWNER_EMAIL` 설정이 필요합니다. 다른 플랫폼에서 배포할 때에는 관리자 API의 인증을 해당 플랫폼의 인증 방식에 연결해야 합니다. 이 복사본의 호스팅 설정은 로컬 D1 바인딩만 제공하며 운영 프로젝트 ID, 인증키, 계정 정보 및 예약 실행 상태는 포함하지 않습니다.

## 검증

```sh
npm test
npm exec -- tsc --noEmit
```

기본 회귀 시험은 검색·비교·기관 안내와 분석 계산, D1 상태 전환을 점검합니다. 기관 원본을 함께 보관하지 않는 설치에서는 빈 자료를 준비 완료로 표시하지 않는지도 확인합니다. 기관 자료, 빌드 결과 및 로컬 D1 상태는 Git 추적에서 제외됩니다.
