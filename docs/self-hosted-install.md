# Heybot 자체 호스팅 설치

팀 Linux 서버에 Docker Engine과 Compose 플러그인, Node.js 22 이상을 준비한다. 서버 아키텍처와 일치하는 릴리스 묶음을 같은 디렉터리에 푼다. 설치 디렉터리에서 다음 명령을 실행한다.

```sh
node scripts/install.mjs
```

설치기는 해당 릴리스의 Controller·Runner 이미지를 로드하고 데이터베이스와 n8n 워크플로를 초기화한다. 모델 키와 Git 서비스 계정 없이 시작할 수 있다. 같은 위치에서 재실행하면 기존 `.env`, 저장소 구성, 볼륨, n8n 자격 증명과 워크플로가 유지된다. 초기 설정 화면과 n8n은 루프백 포트에 바인딩된다. 이미 Heybot을 설치한 서버에서는 기존 Compose 프로젝트 이름을 사용한다. 기본 이름은 `codereviewbot`이다.

## 관리자 접속

설치 서버에서 `http://127.0.0.1:18092/admin`을 연다. 사용자 이름은 `admin`이며 비밀번호는 설치기의 `.env`에 있는 `ADMIN_PASSWORD`다. 원격 접속에는 SSH 포트 전달을 쓴다.

```sh
ssh -L 18092:127.0.0.1:18092 hey-admin@hey-server
```

관리 화면에서 공급자와 모델을 선택한 뒤 `샘플 검사 후 적용`을 누른다. OpenAI와 Claude Messages는 키의 모델 목록을, Ollama는 팀 서버에 설치된 모델 목록을 조회한다. GMS와 목록 API가 없는 게이트웨이는 모델 ID를 직접 입력한다. 팀 내부 Ollama에는 키가 필요 없으며 `.env`의 `OLLAMA_URL`로 주소를 지정한다. 적용된 API 키는 암호화해 `model-settings` 볼륨에 저장한다. 상태를 백업할 때는 볼륨과 `.env`의 `MODEL_SETTINGS_KEY`를 함께 보관한다.

설정 파일만 사용하는 설치에서는 `.env.example`의 공급자 선택지를 참고해 `.env`를 편집하고 같은 릴리스 이미지로 공개 샘플 검사를 실행한다. 관리 화면에서 저장한 설정은 해당 파일보다 우선 적용된다. 관리 화면에서 연결을 해제하면 이 설치의 모델 요청을 중단한다.

```sh
docker compose run --rm --no-deps runner node dist/runner-server.js --check-model &&
  docker compose up -d --no-build --force-recreate runner
```

## 웹훅 공개

필요한 저장소만 `config/repositories.yaml`에서 지정한다. 기존 HTTPS 프록시 또는 선택적 Cloudflare Tunnel은 `POST /webhooks/github`와 `POST /webhooks/gitlab`만 전달한다. 관리 화면과 n8n은 SSH 터널로 접근한다.

Cloudflare Tunnel을 쓰는 경우 `ops/cloudflared.example.yml`을 `.local/cloudflared.yml`로 복사해 터널 ID와 호스트를 설정하고 터널 자격 증명을 `.local/secrets/tunnel.json`에 둔다. `docker compose --profile tunnel up -d --no-build`로 실행한다.

## 시험 PR/MR

GitHub App 또는 GitLab 봇의 자격 증명과 웹훅 비밀을 설정한다. 시험할 저장소를 `enabled: false`로 두고 그 저장소의 `trialNumber`에 열린 소규모 PR 번호를 입력한다. GitLab에서는 MR의 IID를 사용한다. Controller를 다시 생성하면 이 PR/MR에 한해 답변·해설·도움말 웹훅이 열린다.

```sh
umask 077
docker compose exec -T controller node dist/repository-trial-cli.js \
  --platform github --repository example/repo --number 17 --reviewer example-admin > trial.json
```

미리보기에는 질문과 관리자용 정답·해설이 담긴다. 실제 시험 댓글 게시를 원하면 동일한 인자에 `--publish`를 추가하고 `< trial.json`으로 미리보기를 넘긴다. GitLab 시험에는 `--platform gitlab`을 지정한다. 미리보기 이후 PR/MR의 커밋이 바뀌면 다시 검사한다. 게시 응답이 유실된 경우 같은 파일로 재시도할 수 있다.

PR/MR에서 `/hey answer Q1 B`로 답변하고 질문 스레드에서 `/hey showanswer`로 해설을 확인한다. 시험을 마치면 저장소의 `enabled: true`를 설정하고 Controller를 다시 생성해 머지 후 자동 출제를 켠다.

## 릴리스 묶음 만들기

소스 체크아웃에서 `npm ci` 후 `node scripts/package-release.mjs 0.1.0 .local/release-0.1.0`을 실행한다. 대상 Linux와 같은 아키텍처에서 묶음을 만들고, 각 릴리스에는 고유 버전을 쓴다. 설치기는 매칭되는 두 이미지 ID와 아카이브 체크섬을 확인한다.
