# ============================================================================
#  Étape 1 — build du frontend React (Node n'est nécessaire QUE pendant le build)
# ============================================================================
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build          # produit /app/frontend/dist

# ============================================================================
#  Étape 2 — image finale : backend Python + frontend compilé
# ============================================================================
FROM python:3.12-slim AS runtime
WORKDIR /app/backend

# Dépendances Python (pandas/numpy ont des wheels prêts pour arm64 -> rapide)
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Code backend + build du frontend récupéré de l'étape 1
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist

ENV DB_PATH=/data/patrimoine.db \
    OLLAMA_HOST=http://localhost:11434 \
    OLLAMA_MODEL=qwen2.5:3b

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
