"""
Authentification par profils (pseudo + mot de passe) pour un usage familial.

- Mots de passe hachés avec scrypt (stdlib, pas de dépendance) + sel aléatoire.
- Sessions par jeton opaque stocké en base (durée 90 jours), envoyé par le
  frontend dans l'en-tête `Authorization: Bearer <token>`.
- `current_user` est la dépendance FastAPI à mettre sur toutes les routes privées.
"""
from __future__ import annotations
import hashlib
import hmac
import secrets

from fastapi import Header, HTTPException

import db

SESSION_DAYS = 90
PSEUDO_MIN, PASSWORD_MIN = 2, 4


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """-> (hash hex, sel hex). Paramètres scrypt modestes : adaptés au Pi (~50 ms)."""
    salt = salt or secrets.token_hex(16)
    h = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                       n=2**14, r=8, p=1).hex()
    return h, salt


def verify_password(password: str, pass_hash: str, salt: str) -> bool:
    h, _ = hash_password(password, salt)
    return hmac.compare_digest(h, pass_hash)


def register(pseudo: str, password: str) -> dict:
    """Crée le profil (le premier créé récupère les données existantes de la base)
    et ouvre une session. -> {token, pseudo}"""
    pseudo = pseudo.strip()
    if len(pseudo) < PSEUDO_MIN:
        raise HTTPException(400, f"Pseudo trop court (min {PSEUDO_MIN} caractères)")
    if len(password) < PASSWORD_MIN:
        raise HTTPException(400, f"Mot de passe trop court (min {PASSWORD_MIN} caractères)")
    if db.get_user_by_pseudo(pseudo):
        raise HTTPException(400, "Ce pseudo est déjà pris")
    pass_hash, salt = hash_password(password)
    uid = db.create_user(pseudo, pass_hash, salt)
    return {"token": db.create_session(uid, SESSION_DAYS), "pseudo": pseudo}


def login(pseudo: str, password: str) -> dict:
    user = db.get_user_by_pseudo(pseudo.strip())
    if not user or not verify_password(password, user["pass_hash"], user["salt"]):
        raise HTTPException(401, "Pseudo ou mot de passe incorrect")
    return {"token": db.create_session(user["id"], SESSION_DAYS), "pseudo": user["pseudo"]}


def change_password(user: dict, ancien: str, nouveau: str):
    if not verify_password(ancien, user["pass_hash"], user["salt"]):
        raise HTTPException(400, "Ancien mot de passe incorrect")
    if len(nouveau) < PASSWORD_MIN:
        raise HTTPException(400, f"Mot de passe trop court (min {PASSWORD_MIN} caractères)")
    pass_hash, salt = hash_password(nouveau)
    db.update_user_password(user["id"], pass_hash, salt)


def _token_from_header(authorization: str | None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:].strip() or None
    return None


def current_user(authorization: str | None = Header(None)) -> dict:
    """Dépendance FastAPI : renvoie l'utilisateur de la session, sinon 401."""
    token = _token_from_header(authorization)
    user = db.session_user(token) if token else None
    if not user:
        raise HTTPException(401, "Non connecté")
    return user


def logout(authorization: str | None = Header(None)):
    token = _token_from_header(authorization)
    if token:
        db.delete_session(token)
