.PHONY: deps up down test build dev fe dev-api

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
