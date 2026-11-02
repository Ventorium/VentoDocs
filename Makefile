.PHONY: deps up down test build dev fe dev-api webdav-smoke

deps:
	docker compose up -d pg redis

up:
	docker compose up -d

down:
	docker compose down

test:
	cargo test --workspace
	pnpm -C web --if-present build

build:
	pnpm -C web install
	pnpm -C web build
	cargo build --workspace --release

dev: dev-api

dev-api:
	cargo run -p vk-app

fe:
	pnpm -C web install
	pnpm -C web dev

# WebDAV 冒烟（M2.44，需先启动服务并给出两个账号密码）
webdav-smoke:
	VENTO_ADMIN_PASS="$${VENTO_ADMIN_PASS:?}" VENTO_USER_PASS="$${VENTO_USER_PASS:?}" node scripts/webdav-smoke.mjs
