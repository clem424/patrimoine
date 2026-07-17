"""
Cours des cryptos via l'API publique CoinGecko (gratuite, sans clé).

On stocke pour chaque crypto : une quantité + un identifiant CoinGecko (ex 'bitcoin',
'ethereum', 'solana'). La valeur EUR est recalculée à la demande à partir du cours.
La dernière valeur connue est persistée pour rester affichable hors-ligne.
"""
from __future__ import annotations
import time

import requests

COINGECKO = "https://api.coingecko.com/api/v3/simple/price"

# Cache des cours : évite d'appeler CoinGecko à chaque affichage du dashboard
# (l'API gratuite est lente et limitée en débit). {id: (prix_eur, var_24h_pct, ts)}.
PRICE_TTL = 600
_cache: dict[str, tuple[float, float | None, float]] = {}


def get_quotes_eur(ids: list[str]) -> dict[str, dict]:
    """Renvoie {coingecko_id: {prix: eur, var_pct: variation 24 h en %}}. Sert les
    cours en cache (< 10 min) ; si l'API est injoignable, les derniers connus."""
    ids = [i for i in {i.strip().lower() for i in ids if i}]
    if not ids:
        return {}
    now = time.time()
    out = {i: {"prix": _cache[i][0], "var_pct": _cache[i][1]} for i in ids
           if i in _cache and now - _cache[i][2] < PRICE_TTL}
    stale = [i for i in ids if i not in out]
    if stale:
        try:
            r = requests.get(COINGECKO, params={"ids": ",".join(stale), "vs_currencies": "eur",
                                                "include_24hr_change": "true"},
                             timeout=15)
            r.raise_for_status()
            for k, v in r.json().items():
                var = v.get("eur_24h_change")
                out[k] = {"prix": v.get("eur", 0.0),
                          "var_pct": round(var, 2) if var is not None else None}
                _cache[k] = (out[k]["prix"], out[k]["var_pct"], now)
        except Exception:
            # API en panne : on ressert les derniers cours connus.
            out.update({i: {"prix": _cache[i][0], "var_pct": _cache[i][1]}
                        for i in stale if i in _cache})
    return out


def get_prices_eur(ids: list[str]) -> dict[str, float]:
    """Renvoie {coingecko_id: prix_en_eur} (voir get_quotes_eur)."""
    return {i: q["prix"] for i, q in get_quotes_eur(ids).items()}


def search_coin(query: str) -> list[dict]:
    """Aide à trouver l'identifiant CoinGecko d'une crypto à partir d'un nom/symbole."""
    try:
        r = requests.get("https://api.coingecko.com/api/v3/search",
                         params={"query": query}, timeout=15)
        r.raise_for_status()
        coins = r.json().get("coins", [])[:8]
        return [{"id": c["id"], "symbol": c["symbol"], "name": c["name"]} for c in coins]
    except Exception:
        return []
