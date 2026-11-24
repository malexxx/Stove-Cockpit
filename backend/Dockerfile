# syntax=docker/dockerfile:1
FROM node:26-trixie-slim AS frontend-builder

WORKDIR /src
COPY shared/ ./shared/
COPY frontend/package.json frontend/package-lock.json ./frontend/
WORKDIR /src/frontend
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:26-trixie-slim AS node-builder

WORKDIR /build
COPY backend/matter_bridge/package.json backend/matter_bridge/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM python:3.12-slim-trixie

LABEL org.opencontainers.image.title="Stove Cockpit Server" \
    org.opencontainers.image.description="Supervision 24/7, historique SQLite et passerelle Matter locale pour poêles Micronova (HTTP pur)" \
    org.opencontainers.image.version="0.0.2" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.source="https://github.com/malexxx/Stove-Cockpit" \
    org.opencontainers.image.vendor="Stove Cockpit"

ARG APP_VERSION=0.0.2
ARG DOCKER_VERSION=v0.0.2
ARG GIT_COMMIT=""

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Europe/Paris \
    APP_VERSION=${APP_VERSION} \
    DOCKER_VERSION=${DOCKER_VERSION} \
    NOBIS_IMAGE_COMMIT=${GIT_COMMIT}

RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    tzdata \
    tini \
    gosu \
    ca-certificates \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-builder /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY backend/requirements.txt .
RUN python -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r requirements.txt

COPY shared/ /app/shared/
COPY backend/ /app/
COPY --from=frontend-builder /src/frontend/dist /app/frontend_dist
COPY --from=node-builder /build/node_modules /app/matter_bridge/node_modules
RUN groupadd --system --gid 10001 nobis \
    && useradd --system --uid 10001 --gid nobis --home-dir /app --no-create-home nobis \
    && mkdir -p /app/data \
    && chown -R root:root /app \
    && chown -R nobis:nobis /app/data \
    && sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && cp /app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/data"]

EXPOSE 8080 5540/udp 5540/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1,::1", "--timeout-graceful-shutdown", "5"]
