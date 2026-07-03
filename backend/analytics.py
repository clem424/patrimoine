"""
Calculs du tableau de bord, isolés de l'API pour être testables sans serveur web.
Toutes les fonctions prennent des structures Python simples (listes de dicts).
"""
from __future__ import annotations
import re
import datetime as dt
from collections import defaultdict

ASSET_CLASSES = {
    "compte_courant": "Comptes courants",
    "livret_a": "Livret A",
    "livret_jeune": "Livret Jeune",
    "pea": "PEA",
    "crypto": "Cryptomonnaies",
    "pokemon": "Coffrets Pokémon",
    "autre": "Autres actifs",
}
LIQUIDE = ("compte_courant", "livret_a", "livret_jeune", "pea")
NON_DEPENSES = {"Épargne", "Revenus", "Virements reçus", "Virements émis",
                "Revenus d'épargne", "Autres revenus", "Dépenses d'épargne",
                "Virements internes", "Non catégorisé"}


def repartition_par_classe(assets, labels: dict | None = None):
    labels = {**ASSET_CLASSES, **(labels or {})}
    par_classe = defaultdict(float)
    for a in assets:
        par_classe[a["type"]] += a.get("valeur") or 0
    patrimoine = round(sum(par_classe.values()), 2)
    rep = [{"classe": labels.get(k, k), "type": k, "valeur": round(v, 2)}
           for k, v in par_classe.items() if v]
    return patrimoine, sorted(rep, key=lambda x: -x["valeur"])


def period_bounds(periode: str, decalage: int = 0):
    """Fenêtre calendaire demandée -> (debut, fin) inclusifs (dates ISO) ou (None, None).
    periode ∈ {semaine, mois, annee, toujours} ; decalage 0 = en cours, -1 = précédente…"""
    today = dt.date.today()
    if periode == "semaine":
        lundi = today - dt.timedelta(days=today.weekday()) + dt.timedelta(weeks=decalage)
        return lundi.isoformat(), (lundi + dt.timedelta(days=6)).isoformat()
    if periode == "mois":
        m = today.year * 12 + (today.month - 1) + decalage
        y, mo = divmod(m, 12)
        debut = dt.date(y, mo + 1, 1)
        fin = (dt.date(y + (mo == 11), (mo + 1) % 12 + 1, 1) - dt.timedelta(days=1))
        return debut.isoformat(), fin.isoformat()
    if periode == "annee":
        y = today.year + decalage
        return f"{y}-01-01", f"{y}-12-31"
    return None, None    # toujours


def liquid_balance_series(tx, assets):
    liquid_now = sum((a.get("valeur") or 0) for a in assets if a["type"] in LIQUIDE)
    if not tx:
        return [{"date": dt.date.today().isoformat(), "solde": round(liquid_now, 2)}]
    daily = defaultdict(float)
    for t in tx:
        daily[t["date"][:10]] += t["montant"]
    days = sorted(daily.keys())
    serie, running = [], liquid_now
    for d in reversed(days):
        serie.append({"date": d, "solde": round(running, 2)})
        running -= daily[d]
    serie.reverse()
    return serie


def monthly_cashflow(tx):
    """Entrées/sorties par mois, hors virements internes (un transfert compte ->
    livret n'est ni un revenu ni une dépense : il gonflerait les deux barres)."""
    agg = defaultdict(lambda: {"entrees": 0.0, "sorties": 0.0})
    for t in tx:
        if t["categorie"] == "Virements internes":
            continue
        mois = t["date"][:7]
        if t["montant"] >= 0:
            agg[mois]["entrees"] += t["montant"]
        else:
            agg[mois]["sorties"] += -t["montant"]
    return [{"mois": m, "entrees": round(v["entrees"], 2),
             "sorties": round(v["sorties"], 2),
             "net": round(v["entrees"] - v["sorties"], 2)}
            for m, v in sorted(agg.items())]


def spending_by_category(tx, debut: str | None = None, fin: str | None = None):
    """Dépenses par catégorie, optionnellement bornées à [debut, fin] (dates ISO)."""
    agg = defaultdict(float)
    for t in tx:
        jour = t["date"][:10]
        if debut and jour < debut:
            continue
        if fin and jour > fin:
            continue
        if t["montant"] < 0 and t["categorie"] not in NON_DEPENSES:
            agg[t["categorie"]] += -t["montant"]
    return [{"categorie": c, "montant": round(v, 2)}
            for c, v in sorted(agg.items(), key=lambda x: -x[1])]


def budget_status(tx, budgets: list[dict], mois: str):
    """Compare les dépenses du mois `mois` ('YYYY-MM') aux budgets mensuels définis.
    -> {mois, lignes:[{categorie, budget, depense, reste}], budget_total, depense_total}"""
    depenses = defaultdict(float)
    for t in tx:
        if t["date"][:7] == mois and t["montant"] < 0 and t["categorie"] not in NON_DEPENSES:
            depenses[t["categorie"]] += -t["montant"]
    lignes = []
    for b in budgets:
        dep = round(depenses.get(b["categorie"], 0.0), 2)
        lignes.append({"categorie": b["categorie"], "budget": b["montant"],
                       "depense": dep, "reste": round(b["montant"] - dep, 2)})
    lignes.sort(key=lambda x: -(x["depense"] / x["budget"] if x["budget"] else 0))
    budget_total = round(sum(b["montant"] for b in budgets), 2)
    depense_total = round(sum(l["depense"] for l in lignes), 2)
    hors_budget = round(sum(v for c, v in depenses.items()
                            if c not in {b["categorie"] for b in budgets}), 2)
    return {"mois": mois, "lignes": lignes, "budget_total": budget_total,
            "depense_total": depense_total, "hors_budget": hors_budget}


def kpis(tx, patrimoine: float):
    """Indicateurs d'épargne calculés sur les 3 derniers mois COMPLETS (le mois
    en cours, partiel, fausserait les moyennes). None si aucun mois complet."""
    mois_courant = dt.date.today().strftime("%Y-%m")
    complets = [f for f in monthly_cashflow(tx) if f["mois"] < mois_courant][-3:]
    if not complets:
        return None
    n = len(complets)
    revenus = sum(f["entrees"] for f in complets) / n
    depenses = sum(f["sorties"] for f in complets) / n
    epargne = revenus - depenses
    return {
        "nb_mois": n,
        "revenus_moyens": round(revenus, 2),
        "depenses_moyennes": round(depenses, 2),
        "epargne_mensuelle": round(epargne, 2),
        "taux_epargne": round(100 * epargne / revenus, 1) if revenus > 0 else None,
        "projection_1an": round(patrimoine + epargne * 12, 2),
    }


def detect_subscriptions(tx):
    groups = defaultdict(list)
    for t in tx:
        if t["montant"] >= 0:
            continue
        cle = re.sub(r"\d", "", t["libelle"].lower())
        cle = re.sub(r"\s+", " ", cle).strip()
        groups[cle].append(t)
    subs = []
    for items in groups.values():
        if len(items) < 3:
            continue
        montants = [-i["montant"] for i in items]
        moy = sum(montants) / len(montants)
        if moy < 1:
            continue
        if (max(montants) - min(montants)) <= max(2.0, moy * 0.15):
            subs.append({"libelle": items[0]["libelle"], "montant": round(moy, 2),
                         "occurrences": len(items), "categorie": items[0]["categorie"]})
    return sorted(subs, key=lambda x: -x["montant"])[:15]
