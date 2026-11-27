# 자체 호스팅 백업과 복구

백업에는 실행 중인 릴리스 묶음, `.env`, `config/repositories.yaml`, `.local/secrets`, 선택한 프록시 설정, PostgreSQL의 `reviewbot`·`n8n` 데이터베이스를 포함한다. API 키 연결을 관리 화면에서 저장했다면 `model-settings` 볼륨과 `.env`의 `MODEL_SETTINGS_KEY`가 한 쌍이다. CLI 로그인을 보존할 때는 해당 `codex-auth`·`claude-auth` 볼륨도 암호화해 보호한다. n8n은 `n8n-state` 볼륨과 `N8N_ENCRYPTION_KEY`를 함께 복구한다.

Git 캐시는 다시 받을 수 있다. 소스 스냅샷은 완료한 작업의 임시 원문이며 기본 보관은 6시간이다. 대기·실행·게시 중인 작업은 정리에서 보호된다. 웹훅을 멈추고 작업을 마친 다음 일관된 백업을 잡으면 메시지와 질문 이력은 PostgreSQL에서 복구할 수 있다. 백업에 소스 스냅샷도 필요할 때는 원문 데이터로 분류해 같은 보관 정책을 적용한다.

## 백업

기존 프로젝트 이름으로 실행 중인 설치 디렉터리에서 진행한다. 웹훅 유입을 멈추고 작업을 마친 다음 Controller·Runner·n8n을 정지한다. 백업 디렉터리는 운영자만 접근하고 저장 매체를 암호화한다.

```sh
umask 077
mkdir /secure/hey-backup
docker compose stop n8n controller runner
cp -p .env config/repositories.yaml /secure/hey-backup/
docker compose exec -T postgres pg_dump -U postgres -Fc reviewbot > /secure/hey-backup/reviewbot.dump
docker compose exec -T postgres pg_dump -U postgres -Fc n8n > /secure/hey-backup/n8n.dump
docker compose run --rm -T --no-deps --entrypoint tar controller -C /model-state -cf - . > /secure/hey-backup/model-settings.tar
docker compose run --rm -T --no-deps --entrypoint tar n8n -C /home/node/.n8n -cf - . > /secure/hey-backup/n8n-state.tar
```

CLI 로그인을 사용하는 설치는 Runner의 `/codex`와 `/claude` 볼륨을 같은 방식으로 아카이브한다. `.local/secrets`와 사용 중인 프록시 설정 파일은 백업 디렉터리에 복사한다. 백업 파일과 릴리스 이미지 아카이브의 체크섬을 별도로 보관하고 기존 릴리스의 파일을 남긴다. 백업을 마치면 기존 프로젝트의 서비스와 웹훅을 복구한다.

## 복구와 버전 되돌리기

같은 릴리스의 Compose와 일치하는 이미지 두 개를 빈 프로젝트에 로드한다. 백업의 파일을 설치 디렉터리의 원래 위치에 놓고 PostgreSQL만 먼저 시작한다. 초기화로 만든 빈 데이터베이스에 관리자 계정으로 덤프를 넣는다. 다음 예시는 볼륨과 데이터베이스가 비어 있는 격리 복구 프로젝트에서 실행한다.

```sh
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U postgres --exit-on-error -d reviewbot < /secure/hey-backup/reviewbot.dump
docker compose exec -T postgres pg_restore -U postgres --exit-on-error -d n8n < /secure/hey-backup/n8n.dump
docker compose run --rm -T --no-deps --entrypoint tar controller -C /model-state -xpf - < /secure/hey-backup/model-settings.tar
docker compose run --rm -T --no-deps --entrypoint tar n8n -C /home/node/.n8n -xpf - < /secure/hey-backup/n8n-state.tar
node scripts/install.mjs
```

관리 화면에서 복구된 모델 상태를 확인한다. `docker compose exec -T runner node dist/runner-server.js --check-active-model`로 현재 활성 연결을 승인된 공개 샘플로 점검한다. 이전 질문 댓글에서 해설을 확인하고 같은 웹훅을 재전송해 중복 댓글이 생기지 않는지 본다. 결과를 확인한 뒤 프록시의 웹훅 대상을 연결한다.

버전을 올릴 때는 웹훅을 멈추고 작업을 마친 뒤 백업한다. 같은 Compose 프로젝트에서 새 릴리스 파일로 교체하고 `node scripts/install.mjs --upgrade`를 실행한다. 이 명령은 두 앱 이미지와 관리 n8n 워크플로를 바꾼다. 관리 워크플로 두 개는 릴리스 버전으로 교체되어 활성화되므로 운영자가 편집한 워크플로는 미리 내보내 보관한다. 되돌리려면 이전 릴리스 묶음과 업데이트 전 백업으로 격리 프로젝트를 복구하고 검증한 뒤 전환한다.

개발 체크아웃에서 `npm run build && node scripts/verify-n8n.mjs --restore`를 실행하면 격리 PostgreSQL과 n8n에서 백업·복구, 기존 보고서 재마이그레이션, 복구된 웹훅 인증을 점검한다.
