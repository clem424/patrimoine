"""
Connexion Binance en LECTURE SEULE.

Sécurité : crée sur Binance une clé API avec la seule permission « Read Info »
(aucun retrait, aucun trade). Les clés se règlent par variables d'environnement
(BINANCE_API_KEY / BINANCE_API_SECRET) — elles restent donc sur ton Pi, jamais
stockées en base.

On lit les soldes du compte spot, puis on les valorise en EUR directement via
les tickers Binance (paire {ASSET}EUR si elle existe, sinon {ASSET}USDT convertie
avec le taux EURUSDT). Aucune dépendance externe.
"""
from __future__ import annotations
import os
import time
import hmac
import hashlib
import requests

BASE = "https://api.binance.com"
ENV_KEY = os.environ.get("BINANCE_API_KEY", "")
ENV_SECRET = os.environ.get("BINANCE_API_SECRET", "")
# Poussières ignorées (valeur négligeable)
MIN_QTY = 1e-8


def _signed_get(path: str, key: str, secret: str, params: dict | None = None):
    params = dict(params or {})
    params["timestamp"] = int(time.time() * 1000)
    params["recvWindow"] = 10000
    query = "&".join(f"{k}={v}" for k, v in params.items())
    sig = hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    url = f"{BASE}{path}?{query}&signature={sig}"
    r = requests.get(url, headers={"X-MBX-APIKEY": key}, timeout=15)
    r.raise_for_status()
    return r.json()


def get_balances(key: str, secret: str) -> list[dict]:
    """Soldes spot non nuls : [{asset, quantite}]."""
    data = _signed_get("/api/v3/account", key, secret)
    out = []
    for b in data.get("balances", []):
        qty = float(b["free"]) + float(b["locked"])
        if qty > MIN_QTY:
            out.append({"asset": b["asset"], "quantite": qty})
    return out


def get_prices_eur(assets: list[str]) -> dict[str, float]:
    """Prix EUR par unité pour une liste de symboles Binance (BTC, ETH, …)."""
    try:
        tickers = requests.get(f"{BASE}/api/v3/ticker/price", timeout=15).json()
    except Exception:
        return {}
    price = {t["symbol"]: float(t["price"]) for t in tickers}
    eur_usdt = price.get("EURUSDT")           # USDT pour 1 EUR
    out = {}
    for a in assets:
        if a == "EUR":
            out[a] = 1.0
        elif f"{a}EUR" in price:
            out[a] = price[f"{a}EUR"]
        elif f"{a}USDT" in price and eur_usdt:
            out[a] = price[f"{a}USDT"] / eur_usdt
        elif a in ("USDT", "USDC", "BUSD", "FDUSD") and eur_usdt:
            out[a] = 1.0 / eur_usdt
    return out


def sync(key: str, secret: str) -> list[dict]:
    """Renvoie les avoirs Binance valorisés : [{asset, quantite, valeur}]."""
    bal = get_balances(key, secret)
    prices = get_prices_eur([b["asset"] for b in bal])
    out = []
    for b in bal:
        p = prices.get(b["asset"])
        if p is None:
            continue
        out.append({"asset": b["asset"], "quantite": round(b["quantite"], 8),
                    "valeur": round(b["quantite"] * p, 2)})
    return [x for x in out if x["valeur"] >= 0.5]   # ignore les poussières
