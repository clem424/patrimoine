#!/usr/bin/env bash
# Lance Patrimoine : construit le frontend (si besoin) puis démarre le backend.
# Le backend sert l'API ET l'interface sur http://<ip-du-pi>:8000
set -e
cd "$(dirname "$0")"

echo "→ Backend : dépendances Python"
python3 -m pip install -r backend/requirements.txt

if [ ! -d frontend/dist ]; then
  echo "→ Frontend : build (première fois, peut être long sur un Pi)"
  cd frontend && npm install && npm run build && cd ..
fi

echo "→ Démarrage sur http://0.0.0.0:8000"
cd backend && uvicorn main:app --host 0.0.0.0 --port 8000
