# One image for a review app. FastAPI serves the built UI and /api.
# Demo calendar only. The process reseeds a throwaway database on startup.
# PREVIEW_PASSWORD is supplied at runtime and is not baked into the image.

FROM node:22-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG TAFO_REV=unknown
ENV TAFO_REV=$TAFO_REV
ENV VITE_TAFO_SLICE2=1
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN useradd --create-home --uid 10001 tafo
COPY backend /app/backend
COPY scripts /app/scripts
RUN pip install --no-cache-dir /app/backend \
    && rm -rf /root/.cache
COPY --from=web /src/frontend/dist /app/frontend/dist
ENV TAFO_PREVIEW=1 \
    TAFO_HOST=0.0.0.0 \
    TAFO_PORT=8080 \
    TAFO_ALLOW_LAN=1 \
    TAFO_CALENDAR_MODE=demo \
    TAFO_SEED_DEMO=0 \
    TAFO_DATA_DIR=/tmp/tafo \
    TAFO_DB_PATH=/tmp/tafo/tafo.sqlite \
    TAFO_DISPLAY_TIMEZONE=America/Indianapolis \
    TAFO_SERVE_STATIC_DIR=/app/frontend/dist \
    TAFO_FIXTURE_SCRIPT=/app/scripts/load_demo_fixture.py \
    TAFO_GOOGLE_CREDENTIALS_FILE= \
    TAFO_GOOGLE_CALENDAR_ID= \
    TAFO_WORK_INVITE_EMAIL= \
    TAFO_HUMAN_EDITS_AUTO_APPROVE=1 \
    TAFO_SLICE2=1 \
    PYTHONUNBUFFERED=1
USER tafo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"
CMD ["python", "-m", "tafo"]
