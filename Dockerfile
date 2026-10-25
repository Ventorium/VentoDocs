# VentoDocs 单二进制镜像：前端构建产物在编译期经 include_dir 内嵌到二进制。
# 在线编辑器静态资源（约 460MB）不打包进镜像，运行时以卷挂载 + VENTO_EDITOR_DIST 注入。
# 构建：docker build -t vento:latest .

# ---------- 1. 前端 ----------
FROM node:22-bookworm-slim AS web
WORKDIR /web
RUN npm i -g pnpm@12
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---------- 2. 后端（内嵌前端产物） ----------
FROM rust:1.99.1-bookworm AS builder
WORKDIR /build
# rust-toolchain.toml 仅用于本地开发（固定 stable + clippy），镜像内按 1.99.1 直接构建
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY --from=web /web/dist ./web/dist
RUN cargo build --release -p vk-app

# ---------- 3. 运行 ----------
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/vento /app/vento
ENV VENTO_DATA_DIR=/data \
    VENTO_BIND_ADDR=0.0.0.0:8080
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/app/vento"]
