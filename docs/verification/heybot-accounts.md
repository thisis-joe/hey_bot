# Heybot 공식 계정 연결 조사

2026-11-27 공식 문서 기준. 공급자 계정 로그인, 토큰 교환, 모델 호출 및 사용량 확인은 대기 중이다.

| 경로 | 문서에서 확인한 동작 | Heybot에서 확인할 항목 |
|---|---|---|
| 기존 Codex CLI | Codex CLI는 ChatGPT 로그인과 API 키를 지원한다. CLI가 로컬 로그인 자격 증명을 보관·갱신하며 `codex logout`으로 해당 저장본을 비울 수 있다. 신뢰된 비대화형 Enterprise 자동화에는 권한을 받은 사용자가 만든 Codex 액세스 토큰도 사용할 수 있다. [Codex 인증](https://learn.chatgpt.com/docs/auth) | 기존 설치의 로그인 볼륨과 모델 선택, 만료 후 갱신, 로그아웃 뒤 호출 중지. Enterprise 액세스 토큰의 팀 승인과 사용량은 별도 계정으로 확인한다. |
| 오픈소스 앱용 Sign in with ChatGPT | 조건에 맞는 Plus·Pro 계정이 플랜 사용을 승인할 수 있다. 계정의 OAuth 토큰으로 표시 가능한 모델을 조회하고, 같은 모델로 Responses API 스트리밍 요청을 보낸다. 공개 서버 연결에는 요청별 `store: false`와 `stream: true`가 필요하다. [시작 가이드](https://developers.openai.com/siwc/quickstart) · [모델과 추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [미리보기 범위](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | Free 계정에서 모델 호출 권한이 주어지는지, Plus·Pro별 모델 목록 및 실제 사용량을 각각 기록한다. 기존 API 키 Responses 클라이언트에 스트리밍과 계정별 모델 계약을 확인한 뒤 연결한다. |
| 자체 호스팅 VM | 선택한 사용자·워크스페이스의 보호된 세션을 VM으로 이전할 수 있다. VM의 호스트 ID를 유지하고 이후 갱신은 VM에서 수행한다. 이전 세션은 호스트별 사용량 귀속과 호스트 단위 회수가 제공되지 않는다. [자체 호스팅 VM](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) | 계정 소유자의 요청, 팀원 명령, 무인 머지를 각각 시험한다. 팀원 호출과 무인 머지는 그 사용자 범위에 대한 공식 근거와 실제 계정 검증을 얻은 뒤 출시 범위로 확정한다. |
| Claude | Anthropic은 타사 제품·서비스에 API 키 인증을 안내한다. 본인이 자신의 자격 증명으로 수정되지 않은 Claude Code에 로그인하는 경로도 문서화한다. [Claude Code 인증 정책](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) | 팀 배포는 Claude Messages API 키로 확인한다. Claude 구독 로그인 경로에는 팀 서버 사용에 대한 공급자 확인이 필요하다. |

Heybot에서 계정 연결을 해제할 때는 이후 호출과 갱신을 중단하고 로컬 세션 데이터를 지워야 한다. 공식 OAuth 세션에서 공급자 토큰 폐기가 성공했는지 별도로 확인한다. 토큰 폐기를 확인하기 전에 로컬 해제가 끝나면 그 상태를 표시하고 사용자가 ChatGPT 설정에서 앱 연결을 끊을 수 있게 한다. 회전하는 갱신 토큰은 세션별로 한 번에 하나의 갱신만 수행하고 교체 값을 함께 저장한다. Plus의 플랜 사용 한도는 연결된 앱에 걸쳐 공유된다. [계정과 세션](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) · [토큰 수명](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
