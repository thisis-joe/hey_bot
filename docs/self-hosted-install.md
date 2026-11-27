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

초기 화면에서 Runner의 모델 연결 상태를 확인한다. 모델을 지정할 때는 `.env.example`의 선택지를 참고해 `.env`를 편집하고 같은 릴리스 이미지로 공개 샘플 검사를 실행한다.

```sh
docker compose run --rm --no-deps runner node dist/runner-server.js --check-model &&
  docker compose up -d --no-build --force-recreate runner
```

## 웹훅 공개

필요한 저장소만 `config/repositories.yaml`에서 지정한다. 기존 HTTPS 프록시 또는 선택적 Cloudflare Tunnel은 `POST /webhooks/github`와 `POST /webhooks/gitlab`만 전달한다. 관리 화면과 n8n은 SSH 터널로 접근한다.

Cloudflare Tunnel을 쓰는 경우 `ops/cloudflared.example.yml`을 `.local/cloudflared.yml`로 복사해 터널 ID와 호스트를 설정하고 터널 자격 증명을 `.local/secrets/tunnel.json`에 둔다. `docker compose --profile tunnel up -d --no-build`로 실행한다.

## 릴리스 묶음 만들기

소스 체크아웃에서 `npm ci` 후 `node scripts/package-release.mjs 0.1.0 .local/release-0.1.0`을 실행한다. 대상 Linux와 같은 아키텍처에서 묶음을 만들고, 각 릴리스에는 고유 버전을 쓴다. 설치기는 매칭되는 두 이미지 ID와 아카이브 체크섬을 확인한다.
