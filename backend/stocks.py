"""
Cours des actions / ETF via Yahoo Finance (sans clé), pour le PEA.

Principe identique aux cryptos : on stocke pour chaque titre un symbole Yahoo
(ex 'AI.PA' = Air Liquide, 'CW8.PA' = Amundi MSCI World) + une quantité ; la
valeur EUR est recalculée à la demande. Les prix hors EUR sont convertis en EUR.

API non officielle mais stable en pratique. Endpoint 'chart' (plus ouvert que 'quote') :
  https://query1.finance.yahoo.com/v8/finance/chart/<symbole>
"""
from __future__ import annotations
import time
from concurrent.futures import ThreadPoolExecutor

import requests

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{}"
SEARCH = "https://query1.finance.yahoo.com/v1/finance/search"
# Yahoo renvoie 403 sans User-Agent de navigateur.
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}


def _quote(symbol: str) -> tuple[float, str, float | None] | None:
    """(prix, devise, clôture précédente) du dernier cours, ou None si indisponible."""
    try:
        r = requests.get(CHART.format(symbol), params={"range": "1d", "interval": "1d"},
                         headers=HEADERS, timeout=15)
        r.raise_for_status()
        meta = r.json()["chart"]["result"][0]["meta"]
        prev = meta.get("previousClose") or meta.get("chartPreviousClose")
        return (float(meta["regularMarketPrice"]), meta.get("currency", "EUR"),
                float(prev) if prev else None)
    except Exception:
        return None


# Caches : cours des titres (10 min) et taux de change (6 h). Yahoo est lent
# (~0,5 s par titre) : sans cache, chaque affichage du dashboard le paie.
PRICE_TTL, FX_TTL = 600, 6 * 3600
_price_cache: dict[str, tuple[float, float | None, float]] = {}  # {sym: (prix_eur, var_pct, ts)}
_fx_cache: dict[str, tuple[float, float]] = {}      # {devise: (taux, ts)}


def _to_eur_rate(cur: str) -> float:
    """Taux pour convertir 1 unité de 'cur' en EUR (1.0 si déjà EUR)."""
    cur = (cur or "EUR").upper()
    if cur == "EUR":
        return 1.0
    hit = _fx_cache.get(cur)
    if hit and time.time() - hit[1] < FX_TTL:
        return hit[0]
    q = _quote(f"{cur}EUR=X")           # ex : USDEUR=X -> EUR pour 1 USD
    rate = q[0] if q else (hit[0] if hit else 1.0)
    _fx_cache[cur] = (rate, time.time())
    return rate


def _quote_eur(symbol: str) -> tuple[float, float | None] | None:
    """(prix_eur, variation du jour en %) ou None si indisponible."""
    q = _quote(symbol)
    if not q:
        return None
    price, cur, prev = q
    var = round(100 * (price / prev - 1), 2) if prev else None
    return round(price * _to_eur_rate(cur), 4), var


def get_quotes_eur(symbols: list[str]) -> dict[str, dict]:
    """Renvoie {symbole: {prix: eur, var_pct: % du jour}}. Sert le cache (< 10 min),
    interroge Yahoo en parallèle pour le reste ; en cas de panne, ressert le
    dernier cours connu."""
    symbols = {x.strip() for x in symbols if x}
    now = time.time()
    out = {s: {"prix": _price_cache[s][0], "var_pct": _price_cache[s][1]} for s in symbols
           if s in _price_cache and now - _price_cache[s][2] < PRICE_TTL}
    stale = [s for s in symbols if s not in out]
    if stale:
        with ThreadPoolExecutor(max_workers=min(6, len(stale))) as pool:
            for s, q in zip(stale, pool.map(_quote_eur, stale)):
                if q is not None:
                    out[s] = {"prix": q[0], "var_pct": q[1]}
                    _price_cache[s] = (q[0], q[1], now)
                elif s in _price_cache:
                    out[s] = {"prix": _price_cache[s][0], "var_pct": _price_cache[s][1]}
    return out


def get_prices_eur(symbols: list[str]) -> dict[str, float]:
    """Renvoie {symbole: prix_en_eur} (voir get_quotes_eur)."""
    return {s: q["prix"] for s, q in get_quotes_eur(symbols).items()}


def search_symbol(query: str) -> list[dict]:
    """Aide à trouver le symbole Yahoo d'un titre (action ou ETF)."""
    try:
        r = requests.get(SEARCH, params={"q": query, "quotesCount": 8, "newsCount": 0},
                         headers=HEADERS, timeout=15)
        r.raise_for_status()
        res = []
        for q in r.json().get("quotes", []):
            if q.get("symbol"):
                res.append({"symbol": q["symbol"],
                            "name": q.get("shortname") or q.get("longname") or q["symbol"],
                            "exchange": q.get("exchange", ""),
                            "type": q.get("quoteType", "")})
        return res
    except Exception:
        return []
