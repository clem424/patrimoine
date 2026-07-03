"""
API FastAPI — Patrimoine.

Lance : uvicorn main:app --host 0.0.0.0 --port 8000
Sert l'API sous /api/* et le frontend React compilé (frontend/dist) à la racine.

Toutes les routes de données exigent une session (profil connecté) : chaque
membre de la famille ne voit que ses propres données. Seules les routes
/api/auth/* (connexion, création de profil) sont publiques.
"""
from __future__ import annotations
import csv
import io
import re
import secrets
import datetime as dt
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Header
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

import db
import auth
import parsers
import crypto
import stocks
import binance
import analytics
from analytics import ASSET_CLASSES
from categorize import categorize, recategorize, all_categories, _cle

app = FastAPI(title="Patrimoine")
# Pas de CORS : le frontend est servi par ce même serveur (et le dev Vite proxifie
# /api en même origine). Gzip : gros gain sur le bundle JS et les listes JSON.
app.add_middleware(GZipMiddleware, minimum_size=1000)
db.init_db()


@app.middleware("http")
async def cache_headers(request, call_next):
    """Assets Vite fingerprintés -> cache navigateur 1 an ; le reste (index.html,
    API) -> jamais mis en cache, pour que chaque déploiement soit pris en compte."""
    response = await call_next(request)
    if request.url.path.startswith(("/assets/", "/fonts/")):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    return response

User = Depends(auth.current_user)


# ------------------------------------------------------------------- AUTH ---- #
class Credentials(BaseModel):
    pseudo: str
    password: str


class PasswordChange(BaseModel):
    ancien: str
    nouveau: str


@app.post("/api/auth/register")
def auth_register(body: Credentials):
    return auth.register(body.pseudo, body.password)


@app.post("/api/auth/login")
def auth_login(body: Credentials):
    return auth.login(body.pseudo, body.password)


@app.post("/api/auth/logout")
def auth_logout(authorization: str | None = Header(None)):
    auth.logout(authorization)
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(user: dict = User):
    return {"pseudo": user["pseudo"]}


@app.post("/api/auth/password")
def auth_password(body: PasswordChange, user: dict = User):
    auth.change_password(user, body.ancien, body.nouveau)
    return {"ok": True}


# ----------------------------------------------------------------- IMPORT ---- #
@app.post("/api/import")
async def import_file(file: UploadFile = File(...), user: dict = User):
    uid = user["id"]
    content = await file.read()
    try:
        ops = parsers.detect_and_parse(file.filename, content)
        balances = parsers.extract_balances(file.filename, content)
    except Exception as e:
        raise HTTPException(400, f"Échec de lecture : {e}")

    report = db.insert_transactions(uid, ops)

    # Met à jour automatiquement le solde des comptes/livrets/PEA détectés.
    existing = {(a["type"], a["nom"]): a for a in db.list_assets(uid)}
    for b in balances:
        key = (b["type"], b["compte"])
        if key in existing:
            db.update_asset_value(uid, existing[key]["id"], b["solde"])
        else:
            db.upsert_asset(uid, {"type": b["type"], "nom": b["compte"],
                                  "valeur": b["solde"]})
    report["soldes_maj"] = balances
    return report


# --------------------------------------------------------- TRANSACTIONS ---- #
@app.get("/api/transactions")
def get_transactions(limit: int = 2000, user: dict = User):
    return db.fetch_transactions(user["id"], limit=limit)


class CatUpdate(BaseModel):
    categorie: str


@app.patch("/api/transactions/{op_id}/category")
def set_category(op_id: str, body: CatUpdate, user: dict = User):
    uid = user["id"]
    if body.categorie not in all_categories(uid):
        raise HTTPException(400, "Catégorie inconnue")
    db.update_category(uid, op_id, body.categorie, "manual")
    # Apprentissage : la correction est mémorisée (cache 'manual', prioritaire)
    # et resservie à Ollama comme exemple few-shot.
    tx = db.get_transaction(uid, op_id)
    if tx and body.categorie != "Non catégorisé":
        db.cache_set(uid, _cle(tx["libelle"]), body.categorie, origin="manual")
    return {"ok": True}


class DueBody(BaseModel):
    du: bool


@app.post("/api/transactions/{op_id}/rembourser")
def mark_due(op_id: str, body: DueBody, user: dict = User):
    """Marque une dépense « à rembourser » (suivi de ce que les autres te doivent)."""
    if not db.get_transaction(user["id"], op_id):
        raise HTTPException(404, "Opération inconnue")
    db.set_due(user["id"], op_id, body.du)
    return {"ok": True}


class LierBody(BaseModel):
    op_ids: list[str]           # au moins une dépense ET un virement reçu


@app.post("/api/transactions/lier")
def lier_transactions(body: LierBody, user: dict = User):
    """Réunit des opérations dans un groupe de remboursement (N virements reçus
    remboursent N dépenses, mois différents acceptés) : les statistiques ne
    comptent plus que le net, réparti sur les dépenses au prorata. Lier une
    opération déjà liée fusionne les groupes."""
    uid = user["id"]
    ids = list(dict.fromkeys(body.op_ids))
    if len(ids) < 2:
        raise HTTPException(400, "Sélectionne au moins deux opérations")
    txs = [db.get_transaction(uid, i) for i in ids]
    if any(t is None for t in txs):
        raise HTTPException(404, "Opération inconnue dans la sélection")
    if not any(t["montant"] > 0 for t in txs) or not any(t["montant"] < 0 for t in txs):
        raise HTTPException(400, "Il faut au moins une dépense ET un virement reçu")
    gid = "g-" + secrets.token_hex(6)
    db.set_link_group(uid, ids, gid)
    return {"groupe": gid, "n": len(ids)}


@app.post("/api/transactions/{op_id}/delier")
def delier_transaction(op_id: str, user: dict = User):
    """Retire l'opération de son groupe de remboursement (le groupe est dissous
    s'il ne reste plus les deux sens)."""
    if not db.get_transaction(user["id"], op_id):
        raise HTTPException(404, "Opération inconnue")
    db.unlink_op(user["id"], op_id)
    return {"ok": True}


class ConfirmBody(BaseModel):
    confirme: bool


@app.post("/api/transactions/{op_id}/confirm")
def confirm_category(op_id: str, body: ConfirmBody, user: dict = User):
    """Marque la catégorie de l'opération comme vérifiée par l'utilisateur
    (categorized_by='manual') ou repasse-la « à vérifier » ('auto').
    Confirmer alimente l'apprentissage (cache manuel + few-shot Ollama)."""
    uid = user["id"]
    tx = db.get_transaction(uid, op_id)
    if not tx:
        raise HTTPException(404, "Opération inconnue")
    if tx["categorie"] == "Non catégorisé":
        raise HTTPException(400, "Catégorise d'abord l'opération")
    db.update_category(uid, op_id, tx["categorie"], "manual" if body.confirme else "auto")
    if body.confirme:
        db.cache_set(uid, _cle(tx["libelle"]), tx["categorie"], origin="manual")
    else:
        db.cache_delete_manual(uid, _cle(tx["libelle"]))
    return {"ok": True}


@app.post("/api/categorize")
def run_categorization(use_ollama: bool = True, user: dict = User):
    """Catégorise toutes les opérations 'Non catégorisé' (règles -> cache -> Ollama)."""
    uid = user["id"]
    todo = db.fetch_uncategorized(uid)
    stats = defaultdict(int)
    for tx in todo:
        cat, how = categorize(uid, tx["libelle"], montant=tx["montant"],
                              use_ollama=use_ollama)
        if cat != "Non catégorisé":
            db.update_category(uid, tx["op_id"], cat, how)
        stats[how] += 1
    return {"traitees": len(todo), "detail": dict(stats)}


@app.post("/api/recategorize")
def run_recategorization(user: dict = User):
    """Réexamine toutes les opérations non confirmées (✓) avec l'apprentissage
    à jour — à lancer après une session de corrections manuelles."""
    return recategorize(user["id"])


# ------------------------------------------------------------ CATÉGORIES ---- #
class CategoryBody(BaseModel):
    nom: str
    description: str = ""


class CategoryPatch(BaseModel):
    nom: str | None = None          # nouveau nom (renommage)
    description: str | None = None  # nouvelle description (guide Ollama)


@app.get("/api/categories")
def get_categories(user: dict = User):
    return all_categories(user["id"])


@app.get("/api/categories/full")
def get_categories_full(user: dict = User):
    """Détail pour la page Réglages : usage + protection de chaque catégorie."""
    uid = user["id"]
    return [{**c, "protected": c["nom"] in db.PROTECTED_CATEGORIES,
             "usage": db.category_usage(uid, c["nom"])}
            for c in db.list_categories(uid)]


@app.post("/api/categories")
def add_category(body: CategoryBody, user: dict = User):
    uid = user["id"]
    nom = body.nom.strip()
    if not nom:
        raise HTTPException(400, "Nom vide")
    if nom in all_categories(uid):
        raise HTTPException(400, "Cette catégorie existe déjà")
    db.add_category(uid, nom, body.description.strip())
    return {"nom": nom}


@app.patch("/api/categories/{nom}")
def patch_category(nom: str, body: CategoryPatch, user: dict = User):
    uid = user["id"]
    if nom not in all_categories(uid):
        raise HTTPException(404, "Catégorie inconnue")
    if body.nom is not None and body.nom.strip() != nom:
        new = body.nom.strip()
        if nom in db.PROTECTED_CATEGORIES:
            raise HTTPException(400, "Cette catégorie a un rôle spécial dans les calculs"
                                     " — elle n'est pas renommable")
        if not new:
            raise HTTPException(400, "Nom vide")
        if new in all_categories(uid):
            raise HTTPException(400, "Ce nom est déjà utilisé")
        db.rename_category(uid, nom, new)
        nom = new
    if body.description is not None:
        db.set_category_description(uid, nom, body.description.strip())
    return {"nom": nom}


@app.delete("/api/categories/{nom}")
def delete_category(nom: str, user: dict = User):
    uid = user["id"]
    if nom in db.PROTECTED_CATEGORIES:
        raise HTTPException(400, "Cette catégorie a un rôle spécial — non supprimable")
    if nom not in all_categories(uid):
        raise HTTPException(404, "Catégorie inconnue")
    used = db.delete_category(uid, nom)
    if used:
        raise HTTPException(400, f"{used} opération(s)/budget(s) utilisent encore cette catégorie")
    return {"ok": True}


# ---------------------------------------------------------------- ACTIFS ---- #
class Asset(BaseModel):
    id: int | None = None
    type: str
    nom: str
    valeur: float = 0
    quantite: float | None = None
    ticker: str | None = None
    source: str = "manuel"
    commentaire: str = ""
    prix_achat: float | None = None      # total investi -> suivi de plus-value
    date_achat: str | None = None        # YYYY-MM-DD -> croissance annualisée
    pays: str = ""                       # diversification géographique
    croissance_pct: float | None = None  # croissance visée (%/an) -> projection


def _known_types(uid: int) -> set[str]:
    return set(ASSET_CLASSES) | {t["slug"] for t in db.list_asset_types(uid)}


def _type_labels(uid: int) -> dict:
    return {t["slug"]: t["label"] for t in db.list_asset_types(uid)}


@app.get("/api/assets")
def get_assets(user: dict = User):
    return _assets_with_live_prices(user["id"])


@app.post("/api/assets")
def save_asset(asset: Asset, user: dict = User):
    uid = user["id"]
    if asset.type not in _known_types(uid):
        raise HTTPException(400, "Type d'actif inconnu")
    aid = db.upsert_asset(uid, asset.model_dump())
    return {"id": aid}


@app.delete("/api/assets/{asset_id}")
def remove_asset(asset_id: int, user: dict = User):
    db.delete_asset(user["id"], asset_id)
    return {"ok": True}


@app.patch("/api/assets/{asset_id}/masque")
def toggle_mask(asset_id: int, user: dict = User):
    return {"masque": db.toggle_asset_mask(user["id"], asset_id)}


# ------------------------------------------------------- TYPES D'ACTIFS ---- #
# Types intégrés + types personnalisés (créés depuis l'interface).
_TYPE_PALETTE = ["#9B6BD0", "#C25E8A", "#4E9BB0", "#7E8F4C", "#B0764E", "#5876A8"]


class AssetType(BaseModel):
    label: str


@app.get("/api/asset-types")
def asset_types(user: dict = User):
    builtin = [{"slug": k, "label": v, "couleur": None, "builtin": True}
               for k, v in ASSET_CLASSES.items()]
    custom = [{**t, "builtin": False} for t in db.list_asset_types(user["id"])]
    return builtin + custom


@app.post("/api/asset-types")
def asset_type_add(body: AssetType, user: dict = User):
    uid = user["id"]
    label = body.label.strip()
    if not label:
        raise HTTPException(400, "Nom de type vide")
    slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "type"
    if slug in ASSET_CLASSES:
        raise HTTPException(400, "Ce type existe déjà")
    couleur = _TYPE_PALETTE[len(db.list_asset_types(uid)) % len(_TYPE_PALETTE)]
    db.add_asset_type(uid, slug, label, couleur)
    return {"slug": slug, "label": label, "couleur": couleur}


@app.patch("/api/asset-types/{slug}")
def asset_type_rename(slug: str, body: AssetType, user: dict = User):
    uid = user["id"]
    label = body.label.strip()
    if not label:
        raise HTTPException(400, "Nom de type vide")
    if slug in ASSET_CLASSES:
        raise HTTPException(400, "Les types intégrés ne sont pas renommables")
    if slug not in {t["slug"] for t in db.list_asset_types(uid)}:
        raise HTTPException(404, "Type inconnu")
    db.rename_asset_type(uid, slug, label)
    return {"slug": slug, "label": label}


@app.delete("/api/asset-types/{slug}")
def asset_type_delete(slug: str, user: dict = User):
    used = db.delete_asset_type(user["id"], slug)
    if used:
        raise HTTPException(400, f"{used} actif(s) utilisent encore ce type")
    return {"ok": True}


class ClassGrowth(BaseModel):
    slug: str
    pct: float | None = None    # None ou 0 -> efface (retour à « pas de croissance »)


@app.get("/api/croissance-classes")
def class_growth_get(user: dict = User):
    """Croissance visée par classe d'actif : {slug: %/an}. Héritée par les
    actifs de la classe sans croissance propre (l'actif prime)."""
    return db.class_growth_list(user["id"])


@app.put("/api/croissance-classes")
def class_growth_put(body: ClassGrowth, user: dict = User):
    uid = user["id"]
    if body.slug not in _known_types(uid):
        raise HTTPException(400, "Classe d'actif inconnue")
    db.class_growth_set(uid, body.slug, body.pct if body.pct else None)
    return {"ok": True}


@app.get("/api/crypto/search")
def crypto_search(q: str, user: dict = User):
    return crypto.search_coin(q)


@app.get("/api/stocks/search")
def stocks_search(q: str, user: dict = User):
    return stocks.search_symbol(q)


@app.post("/api/prices/refresh")
def prices_refresh(user: dict = User):
    """Recalcule la valeur EUR des cryptos (CoinGecko) ET des titres PEA (Yahoo)."""
    uid = user["id"]
    assets = db.list_assets(uid)
    crypto_ids = [a["ticker"] for a in assets if a["type"] == "crypto" and a["ticker"]]
    stock_syms = [a["ticker"] for a in assets if a["type"] == "pea" and a["ticker"]]
    cprices = crypto.get_prices_eur(crypto_ids) if crypto_ids else {}
    sprices = stocks.get_prices_eur(stock_syms) if stock_syms else {}
    maj = []
    for a in assets:
        price = None
        if a["type"] == "crypto":
            price = cprices.get(a["ticker"])
        elif a["type"] == "pea":
            price = sprices.get(a["ticker"])
        if price is not None and a["quantite"]:
            val = round(price * a["quantite"], 2)
            db.update_asset_value(uid, a["id"], val)
            maj.append({"nom": a["nom"], "valeur": val})
    return {"maj": maj}


def _binance_creds(uid: int):
    """(clé, secret) depuis les réglages du profil, sinon l'environnement."""
    key = db.setting_get(f"binance_key:{uid}") or binance.ENV_KEY
    secret = db.setting_get(f"binance_secret:{uid}") or binance.ENV_SECRET
    return key, secret


class BinanceKeys(BaseModel):
    api_key: str
    api_secret: str


@app.get("/api/settings/binance")
def binance_settings_get(user: dict = User):
    key, secret = _binance_creds(user["id"])
    return {"configured": bool(key and secret)}


@app.post("/api/settings/binance")
def binance_settings_set(body: BinanceKeys, user: dict = User):
    uid = user["id"]
    db.setting_set(f"binance_key:{uid}", body.api_key.strip())
    db.setting_set(f"binance_secret:{uid}", body.api_secret.strip())
    return {"configured": bool(body.api_key and body.api_secret)}


@app.get("/api/binance/status")
def binance_status(user: dict = User):
    key, secret = _binance_creds(user["id"])
    return {"configured": bool(key and secret)}


@app.post("/api/binance/sync")
def binance_sync(user: dict = User):
    """Importe les avoirs Binance (lecture seule) comme actifs crypto (source=binance)."""
    uid = user["id"]
    key, secret = _binance_creds(uid)
    if not (key and secret):
        raise HTTPException(400, "Clés Binance absentes. Renseigne-les dans « Patrimoine »"
                                 " (lecture seule).")
    try:
        avoirs = binance.sync(key, secret)
    except Exception as e:
        raise HTTPException(502, f"Binance injoignable ou clé invalide : {e}")
    db.delete_assets_by_source(uid, "binance")     # resynchronisation propre
    for a in avoirs:
        db.upsert_asset(uid, {"type": "crypto", "nom": f"{a['asset']} · Binance",
                              "valeur": a["valeur"], "quantite": a["quantite"],
                              "ticker": None, "source": "binance"})
    return {"importes": len(avoirs), "avoirs": avoirs}


def _assets_with_live_prices(uid: int):
    """Liste des actifs, valeurs crypto (CoinGecko) et titres PEA (Yahoo) rafraîchies."""
    assets = db.list_assets(uid)
    crypto_ids = [a["ticker"] for a in assets if a["type"] == "crypto" and a["ticker"]]
    stock_syms = [a["ticker"] for a in assets if a["type"] == "pea" and a["ticker"]]
    cprices = crypto.get_prices_eur(crypto_ids) if crypto_ids else {}
    sprices = stocks.get_prices_eur(stock_syms) if stock_syms else {}
    croissance_classes = db.class_growth_list(uid)
    out = []
    for a in assets:
        a = dict(a)
        a["croissance_classe"] = croissance_classes.get(a["type"])
        if a["type"] == "crypto" and a.get("ticker") in cprices and a.get("quantite"):
            a["cours"] = cprices[a["ticker"]]
            a["valeur"] = round(a["cours"] * a["quantite"], 2)
        elif a["type"] == "pea" and a.get("ticker") in sprices and a.get("quantite"):
            a["cours"] = sprices[a["ticker"]]
            a["valeur"] = round(a["cours"] * a["quantite"], 2)
        # Suivi de croissance : plus-value et %/an réel depuis le prix d'achat.
        if a.get("prix_achat"):
            val = a.get("valeur") or 0
            a["plus_value"] = round(val - a["prix_achat"], 2)
            a["perf_pct"] = round(100 * (val / a["prix_achat"] - 1), 1)
            a["perf_annuelle"] = analytics.perf_annualisee(
                a["prix_achat"], val, a.get("date_achat"))
        out.append(a)
    return out


# ----------------------------------------------------- DÉPENSES / BUDGET ---- #
@app.get("/api/depenses")
def depenses(periode: str = "toujours", decalage: int = 0, user: dict = User):
    """Dépenses par catégorie sur la fenêtre demandée (semaine/mois/annee/toujours),
    decalage 0 = période en cours, -1 = précédente…"""
    if periode not in ("semaine", "mois", "annee", "toujours"):
        raise HTTPException(400, "Période inconnue")
    debut, fin = analytics.period_bounds(periode, decalage)
    tx = analytics.apply_links(db.fetch_transactions(user["id"]))
    cats = analytics.spending_by_category(tx, debut, fin)
    return {"periode": periode, "decalage": decalage, "debut": debut, "fin": fin,
            "categories": cats,
            "total": round(sum(c["montant"] for c in cats), 2)}


@app.get("/api/depenses/marchands")
def depenses_marchands(categorie: str, periode: str = "toujours", decalage: int = 0,
                       user: dict = User):
    """Dépenses d'une catégorie ventilées par marchand (même fenêtre que /api/depenses)."""
    if periode not in ("semaine", "mois", "annee", "toujours"):
        raise HTTPException(400, "Période inconnue")
    debut, fin = analytics.period_bounds(periode, decalage)
    tx = analytics.apply_links(db.fetch_transactions(user["id"]))
    rows = analytics.spending_by_merchant(tx, categorie, debut, fin)
    return {"categorie": categorie, "debut": debut, "fin": fin, "marchands": rows,
            "total": round(sum(r["montant"] for r in rows), 2)}


class BudgetLine(BaseModel):
    categorie: str
    montant: float   # 0 -> supprime la ligne


@app.get("/api/budget")
def budget_get(mois: str | None = None, user: dict = User):
    """Budgets mensuels + dépenses réelles du mois demandé (défaut : mois courant)."""
    uid = user["id"]
    mois = mois or dt.date.today().strftime("%Y-%m")
    tx = analytics.apply_links(db.fetch_transactions(uid))
    return analytics.budget_status(tx, db.budget_list(uid), mois)


@app.put("/api/budget")
def budget_put(body: BudgetLine, user: dict = User):
    uid = user["id"]
    if body.categorie not in all_categories(uid):
        raise HTTPException(400, "Catégorie inconnue")
    db.budget_set(uid, body.categorie, body.montant)
    return {"ok": True}


# ------------------------------------------------------------- DASHBOARD ---- #
@app.get("/api/dashboard")
def dashboard(user: dict = User):
    uid = user["id"]
    assets = _assets_with_live_prices(uid)
    tx = db.fetch_transactions(uid)
    # Statistiques sur les montants NETS : un remboursement lié réduit sa dépense
    # au lieu de compter comme un revenu. La courbe de solde reste sur les flux
    # bruts (l'argent est réellement passé sur le compte).
    tx_net = analytics.apply_links(tx)

    patrimoine, repartition = analytics.repartition_par_classe(assets, _type_labels(uid))
    # Relevé quotidien : l'historique du patrimoine total se construit au fil
    # des consultations (1 point par jour, la dernière visite de la journée fait foi).
    if patrimoine:
        db.snapshot_save(uid, patrimoine)
    objectif = db.setting_get(f"objectif:{uid}")
    return {
        "patrimoine": patrimoine,
        "repartition": repartition,
        "courbe_patrimoine": analytics.liquid_balance_series(tx, assets),
        "historique": db.snapshot_list(uid),
        "kpis": analytics.kpis(tx_net, patrimoine),
        "objectif": float(objectif) if objectif else None,
        "flux_mensuel": analytics.monthly_cashflow(tx_net),
        "depenses_categorie": analytics.spending_by_category(tx_net),
        "abonnements": analytics.detect_subscriptions(tx),
        "budget": analytics.budget_status(tx_net, db.budget_list(uid),
                                          dt.date.today().strftime("%Y-%m")),
        "nb_transactions": len(tx),
        "non_categorise": sum(1 for t in tx if t["categorie"] == "Non catégorisé"),
    }


@app.get("/api/projection")
def projection(annees: int = 10, extra: float = 0, courants: bool = False,
               user: dict = User):
    """Patrimoine projeté : croissance visée de chaque actif + épargne mensuelle
    moyenne (KPIs). `extra` €/mois investis en plus -> série comparative
    « si j'investissais plus ». Les comptes courants (liquidités de passage,
    solde fluctuant, 0 % de croissance) sont exclus sauf `courants=true` :
    ils diluent le taux moyen sans rien projeter. `annees` borné à [1, 30]."""
    uid = user["id"]
    annees = max(1, min(30, annees))
    extra = max(0.0, min(100000.0, extra))
    assets = _assets_with_live_prices(uid)
    tx_net = analytics.apply_links(db.fetch_transactions(uid))
    patrimoine, _ = analytics.repartition_par_classe(assets, _type_labels(uid))
    k = analytics.kpis(tx_net, patrimoine)
    epargne = k["epargne_mensuelle"] if k else 0.0
    if not courants:
        assets = [a for a in assets if a["type"] != "compte_courant"]
    # Taux effectif : croissance propre de l'actif, sinon celle de sa classe.
    assets = [{**a, "croissance_pct": a["croissance_pct"]
               if a.get("croissance_pct") is not None else a.get("croissance_classe")}
              for a in assets]
    out = analytics.projection_patrimoine(assets, epargne, annees, extra)
    out["courants_inclus"] = courants
    objectif = db.setting_get(f"objectif:{uid}")
    out["objectif"] = float(objectif) if objectif else None
    return out


@app.get("/api/patrimoine/pays")
def patrimoine_pays(user: dict = User):
    """Diversification géographique : valeur des actifs par pays."""
    return analytics.repartition_par_pays(_assets_with_live_prices(user["id"]))


# ----------------------------------------------- OBJECTIF & EXPORT CSV ---- #
class Objectif(BaseModel):
    montant: float          # 0 -> supprime l'objectif


@app.get("/api/settings/objectif")
def objectif_get(user: dict = User):
    val = db.setting_get(f"objectif:{user['id']}")
    return {"montant": float(val) if val else None}


@app.post("/api/settings/objectif")
def objectif_set(body: Objectif, user: dict = User):
    db.setting_set(f"objectif:{user['id']}", str(body.montant) if body.montant > 0 else "")
    return {"montant": body.montant if body.montant > 0 else None}


@app.get("/api/export/transactions.csv")
def export_transactions(user: dict = User):
    """Toutes les opérations du profil en CSV « Excel FR » (séparateur ;,
    virgule décimale, BOM UTF-8)."""
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["date", "libelle", "montant", "categorie", "compte", "source"])
    for t in db.fetch_transactions(user["id"]):
        w.writerow([t["date"][:10], t["libelle"], str(t["montant"]).replace(".", ","),
                    t["categorie"], t["compte"], t["source"]])
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="operations.csv"'})


# --------------------------------------------------- SERVIR LE FRONTEND ---- #
DIST = Path(__file__).parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        target = (DIST / full_path).resolve()
        # resolve() + is_relative_to : bloque toute évasion hors de dist/ (../..).
        if full_path and target.is_file() and target.is_relative_to(DIST.resolve()):
            return FileResponse(target)
        return FileResponse(DIST / "index.html")
