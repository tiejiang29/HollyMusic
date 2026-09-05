# syntax=docker/dockerfile:1.6
# 启用 BuildKit 高级特性：cache mount（依赖缓存跨构建复用）
# 构建时需 DOCKER_BUILDKIT=1（Docker 20.10+ / buildx 默认已启用）

# ============================================================================
# 阶段 1: 安装依赖（公共阶段 —— 前后端 builder 共享，依赖只装一次）
# ============================================================================
# 原设计 frontend-builder 与 backend-builder 各装一次根依赖（最慢步骤重复 2 次）
# 现抽离为公共 deps 阶段，两个 builder 都 FROM deps，BuildKit 还会并行执行它们
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# 安装 pnpm（走淘宝源加速）
# 注：曾尝试 corepack + COREPACK_NPM_REGISTRY，但淘宝镜像对 corepack 的
# fetchTarballURL 兼容性差（HTTP 404），改回 npm install -g 更稳
RUN npm config set registry https://registry.npmmirror.com && npm install -g pnpm

# 先复制 package 文件（利用 docker layer cache：源码变动不会使依赖安装缓存失效）
# .npmrc 必须在 install 之前到位：node-linker=hoisted 影响 needle/cheerio 等传递依赖的解析
COPY package.json pnpm-lock.yaml .npmrc ./
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/

# 带 pnpm store cache mount 安装依赖：
# - 首次构建：照常下载
# - 后续构建（即使 layer cache 失效）：pnpm store 命中缓存，秒级完成
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && \
    cd frontend && pnpm install --frozen-lockfile

# ============================================================================
# 阶段 2: 构建前端（Vite SPA）
# ============================================================================
FROM deps AS frontend-builder

WORKDIR /app

# 复制源码
COPY . .

# 生成 Prisma Client（前端 tsconfig 通过 ../lib 引用了 lib/generated/prisma，
# 缺失会导致 TS2307 + 连锁 TS7006 隐式 any 错误）
RUN pnpm prisma generate

# 构建前端（dist 已含 publicDir 指向的根 public/ 资源：manifest.json / icon.svg / sw.js / icons/ 等 PWA 资源）
RUN cd frontend && pnpm build

# ============================================================================
# 阶段 3: 构建后端（Next.js standalone）
# ============================================================================
FROM deps AS backend-builder

WORKDIR /app

# next build（SSG）会实例化 Prisma：slim 基础镜像既无 openssl 命令也无 libssl 共享库，
# Prisma 检测系统 OpenSSL 失败后回退 openssl-1.1.x 引擎（schema 未生成该 target），
# 构建日志刷 PrismaClientInitializationError。装 openssl（连带 libssl3）后检测命中
# debian-openssl-3.0.x，与运行时镜像（nginx 依赖 libssl3）的环境一致。
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# 复制源码
COPY . .

# 生成 Prisma Client（含 Linux 引擎二进制，依赖 schema.prisma 的 binaryTargets）
RUN pnpm prisma generate

# ★★★ 关键：必须用 webpack 构建，不能用默认的 Turbopack ★★★
# Next.js 16.0+ 默认用 Turbopack，但 16.1.x~16.2.x 有回归（issues #88844、#91654）：
# serverExternalPackages 的包（needle/tunnel）不会被正确复制进 .next/standalone/node_modules，
# 导致运行时报 Cannot find module 'needle'。--webpack 退回 webpack 打包，行为与 15.x 一致。
RUN pnpm build --webpack

# standalone 瘦身（构建后确定性剪除，outputFileTracingExcludes 压不过显式 include）：
# - data/：本地构建时 fs 追踪启发式会把音频缓存（数百 MB）带进 standalone
#   （CI checkout 无此目录；运行时数据一律走 volume 挂载）
# - node_modules/prisma/*.node：prisma 包内的查询引擎副本，只有 generate/studio 用，
#   运行时客户端走 lib/generated/prisma 的引擎
# - @prisma/engines 内 *query* / *migration-engine* 副本：migrate deploy 只需 schema-engine
RUN rm -rf .next/standalone/data \
 && rm -f .next/standalone/node_modules/prisma/*.node \
          .next/standalone/node_modules/@prisma/engines/*query* \
          .next/standalone/node_modules/@prisma/engines/*migration-engine*

# ============================================================================
# 阶段 4: 运行时（nginx + Node.js standalone）
# ============================================================================
# bookworm（Debian 12, glibc 2.36）：rollup 4.x 的 native 二进制要求 glibc ≥ 2.32，
# bullseye 只有 2.31 会导致 vite build 时 dlopen 失败
# 运行时用 debian-slim + 只拷 node 二进制（省掉 npm/corepack/yarn 等 ~60MB；
# 与 node:20-bookworm-slim 同属 bookworm，共享库完全兼容）
FROM debian:bookworm-slim
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# apt 源：默认官方 deb.debian.org（Fastly 全球 CDN，GitHub Actions 海外 runner 访问快；
# 清华 TUNA 对海外 IP 返回 403，CI 构建不可用，不能再无条件下换）。
# 国内本地构建加速：docker build --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
# bookworm-slim 用新格式 debian.sources（非老的 sources.list）
# nginx 顺带提供 libssl3（Prisma 查询引擎 .so 依赖）
ARG APT_MIRROR=""
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends nginx \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
# standalone server.js 读 HOSTNAME（不是 HOST），漏设会只监听 localhost 导致 nginx 反代连接被拒
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# ---------- standalone 核心三件套 ----------
# server.js + 最小化 node_modules。lib/generated/prisma（客户端+查询引擎）、
# prisma CLI + schema-engine（migrate deploy 用）、needle/tunnel 均已由
# outputFileTracingIncludes 追踪进 standalone，不再重复 COPY（原"双保险"白多一层 ~35MB）
COPY --from=backend-builder /app/.next/standalone ./
# 静态资源（独立于 standalone，需手动放到 .next/static）
COPY --from=backend-builder /app/.next/static ./.next/static

# ---------- Prisma schema + migrations（migrate deploy 的 --schema 入参） ----------
COPY --from=backend-builder /app/prisma ./prisma

# ---------- 业务配置与音源 ----------
COPY --from=backend-builder /app/config ./config
# 兜底：users.json 含初始密码，绝不允许随镜像分发（若构建期生成，密码会出现在公开构建日志）
RUN rm -f /app/config/users.json
# custom-sources 是运行时用户数据目录（被 .gitignore 忽略，源码与 CI 中均不存在），
# 实际数据通过 docker-compose volume（./custom-sources:/app/custom-sources）挂载宿主机目录提供。
# 此处仅创建空目录作为挂载点：避免 COPY 不存在的路径导致 CI 构建失败，
# 同时保证未挂载 volume 时程序上传/写入音源脚本不因目录缺失报错。
RUN mkdir -p /app/custom-sources

# ---------- 前端静态产物给 nginx ----------
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# ---------- nginx 配置 + 启动脚本 ----------
COPY nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY scripts/start-spa.sh /app/start-spa.sh
RUN chmod +x /app/start-spa.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/app/start-spa.sh"]
