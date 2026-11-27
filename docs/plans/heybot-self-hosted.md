# Heybot 자체 호스팅 리팩토링 계획

행동 계약은 [자체 호스팅과 모델 연결 명세](../specs/heybot-self-hosted.md)를 따른다. 이 문서의 작업 표가 로컬 실행 상태의 기준이다. 기준은 origin/main의 9432ebb이며 사용자 체크아웃의 미커밋 .gitignore 변경을 가져오지 않는다.

## 시작과 합류점

- 계획 검증 채팅이 기존 정상 경로, 데이터 전송·과금, 한도 자동 전환, 설치와 출시 순서를 독립 검토한다. 작업표에 영향을 주는 지적은 이 계획과 명세에 먼저 반영한다.
- 검증이 끝나면 별도 구현 채팅이 전용 작업 공간의 feat/heybot-self-hosted 브랜치에서 **MODEL-01**을 시작한다. 초기 결과는 기존 GMS/CLI 구성과 호환되면서 키·모델로 정상 질문을 만드는 하나의 경로다. 실제 키가 없어도 공개 샘플과 fixture로 시작한다.
- 사용자 지침에 따라 기능 브랜치와 작업 단위 커밋을 사용한다. 관련 작업은 같은 기능 브랜치에 올리고 각 완료 작업을 따로 커밋한다. 명령은 해당 작업 공간에서 실행하며 기존 사용자 체크아웃의 변경과 운영 자격 증명·서버에는 손대지 않는다.

## 구현 단위

| 작업 | 선행 작업 | 결과와 완료 확인 |
|---|---|---|
| MODEL-01 공통 모델 설정과 OpenAI/GMS 흐름 | 없음 | Runner의 모델 선택을 연결 설정 한곳에서 검증한다. 기존 Model 단계 경로에서 Responses API의 키·모델 선택, 공개 샘플 검사, 적용과 기존 GMS·Codex·Claude 호환을 HTTP fixture로 확인한다. 공개 관리 화면 없이 CLI 또는 구성 파일에서 첫 경로를 시험한다. |
| MODEL-02 Claude API 키 | MODEL-01 | Claude 모델 목록·Messages 공급자를 같은 연결 설정에 추가한다. 해당 키의 모델 목록과 실제 모델 ID, 구조화 출력, 읽기 도구, 잘못된 키와 한도 응답을 확인한다. 기존 Claude Code 방식의 선택과 자격 증명을 회귀 테스트한다. |
| MODEL-03 무료 로컬 모델 | MODEL-01 | 사내 Ollama 또는 선택적 Compose 프로필에서 계정 없이 질문→답변→해설을 동작시킨다. 모델 파일 준비 후 외부 통신을 차단하고 시험한다. Qwen3 4B를 후보로 동일한 공개 PR 묶음에서 응답시간·최대 RAM·질문 정확도를 기록하고 통과한 조합을 고정한다. |
| MODEL-04 단일 무료 클라우드 API 체험 | MODEL-01 | Groq를 우선 검증한다. 도구와 구조화 출력을 함께 쓰기 어렵다면 서버가 선별한 제한된 코드 발췌를 사용해 같은 질문 계약을 검증한다. 동시에 승인된 독립 무료 후보(우선 OpenRouter의 명시적 무료 모델)를 확인한다. 중계 사용 시 실제 공급자와 무료 조건을 호출 직전에 확인할 수 있는 경로만 승인한다. 공급자 자동 전환을 제한한 실연동을 통과해야 체험에 공개한다. |
| MODEL-05 무료 예비 연결 | MODEL-04 | Runner가 반환한 한도 정보로 Controller·DB가 기존 작업의 예약 재개 상태를 저장하고 n8n이 예약에 따라 재개하게 한다. 연속으로 세 번을 넘는 짧은 429에도 생성 실패 횟수 초과가 되지 않아야 한다. 두 번째 무료 연결 성공, 전부 소진, 24시간 만료 이후 자동 재등록 차단, 재시작, 권한·키 철회 및 요금 변경 뒤 승인되지 않은 요청 0건, 이전 소유자 쓰기 거부, 게시 응답 유실 후 중복 없음을 fixture로 검증한다. 승인된 두 실제 무료 엔드포인트는 공개 샘플로 별도 확인한다. |
| SERVER-01 설치 패키지 | 없음 | 버전 고정 Compose와 이미지 묶음, 반복 실행 가능한 n8n 초기화, 볼륨 보존, 선택형 프록시/터널 안내를 제공한다. 깨끗한 Linux와 기존 설정 복사본에서 반복 설치를 검증한다. 신규 설치는 모델 자격 증명 없이 Runner·Controller를 기동하고 초기 관리 화면까지 열리는 것을 확인한다. |
| SERVER-02 관리자 화면과 연결 수명 | MODEL-01, SERVER-01 | 관리자 전용 화면에서 API 키·로컬·활성화 가능한 무료 경로를 선택하고 시스템이 지원하는 모델 목록을 표시한다. 샘플 검사, 원자적 적용, 실패 시 기존 설정 유지, 키 교체·삭제·로그 마스킹, 인증 없는 접근·CSRF·n8n 내부 토큰의 관리자 접근 차단을 확인한다. 공통 화면과 구성 경로를 제공한다. |
| SERVER-03 저장소 연결과 시험 출제 | SERVER-02 | 큰 샘플보다 승인된 작은 시험 PR/MR부터 코드 읽기·댓글 쓰기·웹훅·답변/해설을 확인한다. 미리보기와 실제 댓글 쓰기를 별개 동작으로 확인하고, 활성화한 저장소에서만 자동 출제한다. GitHub와 GitLab을 대상으로 한다. |
| SERVER-04 운영·업그레이드·복구 | SERVER-01, MODEL-01 | 기존 DB/설정 복사본의 호환 마이그레이션, 채점 이력·댓글 마커 보존, 재시작·백업 복구·버전 롤백을 확인한다. 모델 상태·쿨다운·전환 사유의 민감정보 없는 표시는 MODEL-05 이후 연결한다. |
| SERVER-05 Claude·로컬 관리자 연결 | SERVER-02, MODEL-02, MODEL-03 | Claude와 로컬 모델을 공통 화면에 연결한다. 관리 화면에서 각각 모델을 선택하고 샘플 검사와 적용을 완료하며, 기존 CLI 설정 도입도 확인한다. |
| RELEASE-01 설치 파일럿 | SERVER-03, SERVER-04, SERVER-05 | 새 팀이 자체 Linux에서 로컬→Claude→OpenAI/GMS를 순서대로 선택해 시험하고 이전 댓글에서 답변한다. 무료 API 체험을 함께 배포할 경우 MODEL-04, 예비 연결까지 노출할 경우 MODEL-05의 실연동 통과도 기록한다. |
| ACCOUNT-01 공식 계정 흐름 검증 | 없음 | 기존 Codex CLI와 Sign in with ChatGPT의 자체 호스팅 경로를 구분한다. 계정 소유자·팀원 명령·무인 머지, Free/구독 접근, 토큰 갱신·해제, 계정별 모델과 과금 기준을 검증한다. Heybot 로컬 해제와 제공자의 권한 회수·호스트별 사용량 귀속을 구분해 보고한다. 이 작업은 설치 파일럿과 독립으로 진행한다. |
| ACCOUNT-02 공식 계정 연결 | ACCOUNT-01, SERVER-02 | 지원 범위에서 로그인·모델 선택·재연결·해제를 제공한다. 팀 자동 실행이 공식 지원되면 운영 자동 출제에 활성화한다. Claude 구독은 해당 팀 사용에 공급자 지원 근거가 생기면 별도 작업으로 다룬다. |
| RELEASE-02 공개판과 사내 지원 범위 | RELEASE-01, MODEL-04, MODEL-05 | 한국어·영어, 저장소별 자동·수동·중지, 주요 머지 방식과 실제 GitHub·GitLab을 검증한다. 무료 클라우드 체험과 예비 연결을 관리 화면에 연결한다. 단일 체험은 MODEL-04 실연동, 예비 연결은 MODEL-05 독립 공급자 두 곳 실연동 이후에 노출한다. 무료 한도 전환과 비공개 코드 경계를 증거에 포함한다. 사내 Git 주소·CA·내부 모델 게이트웨이는 검증한 구성부터 지원 목록에 올린다. |

## 작업 상태

| 작업 | 구현과 로컬 검증 | 남은 검증 |
|---|---|---|
| MODEL-01 | 구현 완료. 공개 샘플 CLI 및 Controller → Runner HTTP fixture 통과. 기존 Luna 독립 풀이·재출제, Sol 단일 생성, Codex·Claude CLI 환경 변수 확인. 단위 210개, 격리 PostgreSQL 71개, n8n 실행 `455a729f`, Compose 구성 검사 통과. | 공식 코드 검토와 실제 OpenAI·GMS·CLI 계정 연결 확인 대기. |
| MODEL-02 | 구현 완료. Claude API 모델 목록 페이지 순회, 선택 모델 조회와 샘플 검사, 읽기 도구와 구조화 응답, 잘못된 키와 429의 재시각을 HTTP fixture로 확인. 기존 Claude Code 회귀 포함 단위 211개 및 Compose 구성 검사 통과. | 공식 코드 검토와 실제 Claude API 키·모델 확인 대기. |
| MODEL-03 | 팀 내부 Ollama 연결 구현. 로컬 모델 목록, 공개 샘플, Runner의 질문·답변·저장된 해설, 원격 태그 변경 시 모델 요청 차단을 HTTP fixture로 확인. 단위 212개 및 Compose 구성 검사 통과. 공개 샘플은 파일을 읽은 뒤 바로 구조화 출력 단계로 진행한다. | Linux arm64 CPU와 4 GiB 메모리 제한에서 Qwen3 4B 공개 샘플이 2코어와 4코어 모두 60초 제한을 초과했다. 4코어 재시도는 네트워크 외부 통신을 차단했고 최대 메모리 약 4.0 GiB를 기록했다. 공식 코드 검토와 공개 평가 PR의 생성 시간·정답 정확도 검증 대기. |
| ACCOUNT-01 | 문서 조사 완료. 기존 Codex CLI와 공식 OAuth의 모델 조회·갱신·해제 및 VM 귀속 경계를 [계정 조사](../verification/heybot-accounts.md)에 기록. | Free·Plus·Pro 및 Enterprise 계정, 팀원 명령, 무인 머지의 실제 검증 대기. |
| SERVER-01 | 구현 완료. Linux arm64 Docker 격리 환경에서 두 이미지 릴리스 아카이브 로드, 새 설치 및 관리자 초기 화면, 재설치 시 `.env`·DB 데이터·n8n 자격 증명과 수정한 워크플로 보존 확인. 단위 214개, 격리 PostgreSQL 71개, n8n 실행 `97e88960` 통과. | 공식 코드 검토 및 별도 팀 Linux 서버 설치 대기. |
| SERVER-02 | OpenAI/GMS 관리 화면 구현. 관리자 세션·CSRF·내부 토큰 차단, 모델 목록, 샘플 검사 후 저장, 실패 시 기존 연결 유지, 키 교체·암호화·해제와 해제 직후 추가 호출 차단을 Controller → Runner HTTP fixture로 확인. 단위 215개, 격리 PostgreSQL 71개, Compose 구성 검사 통과. | 공식 코드 검토와 실제 API 키 검증 대기. Claude·Ollama는 SERVER-05, 검증된 무료 연결은 RELEASE-02에서 관리 화면에 붙인다. |
| MODEL-04 | OpenRouter용 고정 공개 샘플 검사 구현. 명시적 무료 모델, 0원 가격, 지정 추론 공급자, 구조화 출력, 한도 응답을 HTTP fixture로 확인. 가격 변경과 추론 공급자 불일치 시 추론 요청이 차단된다. 단위 216개 통과. | Groq의 조직 과금 등급 사전 확인 수단과 승인된 실제 무료 키·엔드포인트 검증 대기. 저장소 대상 체험과 자동 전환은 아직 연결되지 않았다. |
| SERVER-05 | 관리자 화면에서 Claude Messages와 팀 내부 Ollama 모델 조회·공개 샘플 검사·원자적 적용과 Runner 호출을 HTTP fixture로 확인. 기존 CLI와 기존 Responses 설정 호환, 단위 217개 및 Compose 구성 검사 통과. | 공식 코드 검토, 실제 Claude API와 팀 Ollama 모델 검증 대기. |
| SERVER-03 | 비활성 저장소의 시험 PR/MR 미리보기와 명시적 게시, 서명된 답변·해설 웹훅과 저장된 질문 기반 채점을 GitHub·GitLab fixture로 확인. 응답 유실 재시도 시 요약·스레드 중복 및 비활성 저장소의 자동 출제 차단. 단위 219개, 격리 PostgreSQL 73개, n8n 실행 `cd837469` 통과. | 공식 코드 검토와 실제 GitHub App·GitLab 봇 시험, 팀 저장소 활성화 대기. |

## 검증 경계

1. 변경 단위에서 실제 Runner HTTP 또는 Controller의 정상 경로에 fixture를 붙인다. 저장 상태, 함수 호출, 오류 응답 또는 댓글처럼 사용자가 관찰하는 결과를 단언한다.
2. 변경에 영향을 받는 단위 테스트와 전체 `npm test`를 실행한다. DB 저장, 웹훅, 워크플로가 바뀌는 단위는 격리 PostgreSQL로 `node scripts/integration.mjs` 또는 준비된 테스트 DB에서 `npm run test:integration`도 실행한다. n8n 흐름에 영향이 있으면 `node scripts/verify-n8n.mjs`를 실행한다. Docker 또는 Linux가 없으면 관련 검증을 미실행으로 기록한다.
3. 무료 공급자 전환 fixture는 첫 모델 호출이 일부 결과를 돌려준 뒤 429를 보내는 경우를 포함한다. 모든 후보 소진과 재시작, 권한 철회, 비공개 저장소, 예비 모델 요금 변경, 게시 결과 유실을 재현한다. 전환 중 완성 결과를 한 번만 저장·게시하고 승인되지 않은 엔드포인트 요청 수는 0으로 확인한다.
4. 실연동은 공개 고정 샘플부터 시작한다. 로컬 후보의 성공 기준은 선택한 최소 Linux 사양에서 평가 표본의 게시된 질문에 정답·근거 오류가 없고 지정한 생성 예산을 지키는 것이다. 표본·측정값·미통과 사례는 기록한다. 무료 API는 현재 요금제·실제 공급자·승인된 코드 전송을 확인한 뒤 테스트한다. 운영 데이터는 복사한 테스트 환경에서 업그레이드와 복원 검증에 사용한다.

## 계약과 검증 근거

- 기존 모델 선택 경로는 Runner 환경 변수, 생성·검증·게시와 재선점은 Controller·n8n·PostgreSQL에 있다. 작업 및 출처의 소유권은 기존 경로를 따른다. [Runner](../../src/runner-server.ts#L11) · [n8n 운영](../n8n-orchestration.md)
- 체험 후보의 근거는 공개 문서이며 능력과 무료 전환의 실연동은 아직 검증 전이다. [Groq 한도](https://console.groq.com/docs/rate-limits) · [Groq 정책](https://console.groq.com/docs/legal/ai-policy) · [Groq 구조화 출력](https://console.groq.com/docs/structured-outputs) · [OpenRouter 무료 모델](https://openrouter.ai/collections/free-models/) · [Gemini 무료 정책](https://aistudio.google.com/docs/terms#unpaid-services)
- [Claude API 모델 목록](https://platform.claude.com/docs/en/api/models/list) · [Anthropic 인증 정책](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) · [ChatGPT 자체 호스팅 계정 연결](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) · [Ollama 구조화 출력](https://docs.ollama.com/capabilities/structured-outputs)
