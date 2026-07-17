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


def apply_links(tx):
    """Groupes de remboursement (`lien_groupe`) : N virements reçus remboursent
    N dépenses, sur des mois éventuellement différents. Les virements du groupe
    s'effacent des flux et leur total réduit les dépenses du groupe AU PRORATA
    de leurs montants (payer 50 puis recevoir 25 lié -> la dépense compte 25).
    Si les virements dépassent les dépenses, l'excédent reste en revenu sur le
    plus gros virement. Un groupe incomplet (un seul sens) est laissé intact."""
    groupes = defaultdict(list)
    for t in tx:
        if t.get("lien_groupe"):
            groupes[t["lien_groupe"]].append(t)
    if not groupes:
        return tx
    repl = {}                    # op_id -> version ajustée, ou None (absorbé)
    for items in groupes.values():
        virements = sorted((t for t in items if t["montant"] > 0),
                           key=lambda t: -t["montant"])
        depenses = [t for t in items if t["montant"] < 0]
        if not virements or not depenses:
            continue
        recu = sum(t["montant"] for t in virements)
        du = sum(-t["montant"] for t in depenses)
        utilise = min(recu, du)
        for t in depenses:
            part = utilise * (-t["montant"]) / du
            repl[t["op_id"]] = {**t, "montant": round(t["montant"] + part, 2),
                                "rembourse": round(part, 2)}
        reste = round(recu - utilise, 2)
        for i, t in enumerate(virements):
            repl[t["op_id"]] = ({**t, "montant": reste, "rembourse": round(
                t["montant"] - reste, 2)} if i == 0 and reste > 0 else None)
    out = []
    for t in tx:
        if t["op_id"] in repl:
            if repl[t["op_id"]] is not None:
                out.append(repl[t["op_id"]])
        else:
            out.append(t)
    return out


def event_report(tx, event, overrides):
    """Bilan d'un évènement : par défaut, toutes les opérations NETTES (passer
    tx par apply_links) de la période [debut, fin] — dépenses ET argent reçu
    (un cadeau reçu pendant les vacances vient en déduction du coût) — hors
    catégories NON_DEPENSES (salaire, épargne, virements internes : un salaire
    versé pendant les vacances ne les « rembourse » pas). Overrides : 0 =
    exclue (« rien à voir »), 1 = ajoutée manuellement (même hors période,
    même en catégorie Revenus). Les exclues restent listées (statut 'exclu')
    pour pouvoir les réintégrer. total = dépensé − reçu."""
    ops, agg = [], defaultdict(float)
    depense = recu = 0.0
    for t in tx:
        jour = t["date"][:10]
        auto = (event["debut"] <= jour <= event["fin"]
                and t["categorie"] not in NON_DEPENSES)
        ov = overrides.get(t["op_id"])
        if ov == 1:
            statut = "inclus"
        elif ov == 0 and auto:
            statut = "exclu"
        elif ov is None and auto:
            statut = "auto"
        else:
            continue
        ops.append({**t, "statut": statut})
        if statut != "exclu":
            if t["montant"] < 0:
                depense += -t["montant"]
            else:
                recu += t["montant"]
            agg[t["categorie"]] += -t["montant"]
    ops.sort(key=lambda t: t["date"], reverse=True)
    return {"ops": ops, "total": round(depense - recu, 2),
            "depense": round(depense, 2), "recu": round(recu, 2),
            "nb": sum(1 for o in ops if o["statut"] != "exclu"),
            "par_categorie": [{"categorie": c, "montant": round(v, 2)}
                              for c, v in sorted(agg.items(), key=lambda x: -x[1])]}


def merchant_key(libelle: str) -> str:
    """Regroupe les libellés d'un même marchand (dates/numéros de ticket ignorés)."""
    s = re.sub(r"\d+", "", libelle.lower())
    return re.sub(r"\s+", " ", s).strip()


def spending_by_merchant(tx, categorie: str, debut: str | None = None,
                         fin: str | None = None, top: int = 30):
    """Dépenses d'UNE catégorie ventilées par marchand sur [debut, fin]."""
    agg = defaultdict(lambda: {"montant": 0.0, "nb": 0, "libelle": ""})
    for t in tx:
        jour = t["date"][:10]
        if t["categorie"] != categorie or t["montant"] >= 0:
            continue
        if (debut and jour < debut) or (fin and jour > fin):
            continue
        m = agg[merchant_key(t["libelle"])]
        m["montant"] += -t["montant"]
        m["nb"] += 1
        m["libelle"] = m["libelle"] or t["libelle"]
    rows = [{"marchand": v["libelle"], "montant": round(v["montant"], 2), "nb": v["nb"]}
            for v in agg.values()]
    return sorted(rows, key=lambda x: -x["montant"])[:top]


def perf_annualisee(prix_achat: float, valeur: float, date_achat: str | None):
    """Croissance annualisée réelle (%/an) depuis l'achat ; None si la détention
    est trop courte (< 30 jours) pour que l'annualisation ait un sens."""
    if not (prix_achat and prix_achat > 0 and valeur and date_achat):
        return None
    try:
        jours = (dt.date.today() - dt.date.fromisoformat(date_achat[:10])).days
    except ValueError:
        return None
    if jours < 30 or valeur <= 0:
        return None
    return round(100 * ((valeur / prix_achat) ** (365 / jours) - 1), 1)


def projection_patrimoine(assets, epargne_mensuelle: float, annees: int = 10,
                          extra: float = 0.0):
    """Patrimoine projeté mois par mois, INTÉRÊTS COMPOSÉS : chaque actif
    compose à sa croissance visée (croissance_pct, 0 %/an si non renseignée)
    et l'épargne mensuelle est réputée investie comme le portefeuille (elle
    compose au taux moyen visé). La série `epargne_seule` (linéaire, sans
    aucune croissance) sert de référence pour visualiser ce que rapporte la
    composition. Avec `extra` > 0, `programme_plus` simule « et si
    j'investissais X €/mois de plus ? » au même taux moyen."""
    vals = [((a.get("valeur") or 0),
             (1 + (a.get("croissance_pct") or 0) / 100) ** (1 / 12))
            for a in assets if (a.get("valeur") or 0) > 0]
    total0 = sum(v for v, _ in vals)
    taux_moyen = (sum(v * ((f ** 12) - 1) for v, f in vals) / total0 * 100
                  if total0 else 0.0)
    f_moyen = (1 + taux_moyen / 100) ** (1 / 12)
    today = dt.date.today()
    serie, cash, invest_extra = [], 0.0, 0.0
    for m in range(annees * 12 + 1):
        y, mo = divmod(today.year * 12 + (today.month - 1) + m, 12)
        total = sum(v for v, _ in vals) + cash
        point = {"mois": f"{y}-{mo + 1:02d}",
                 "programme": round(total, 2),
                 "epargne_seule": round(total0 + epargne_mensuelle * m, 2)}
        if extra > 0:
            point["programme_plus"] = round(total + invest_extra, 2)
        serie.append(point)
        vals = [(v * f, f) for v, f in vals]
        cash = cash * f_moyen + epargne_mensuelle
        invest_extra = invest_extra * f_moyen + extra
    return {"serie": serie, "taux_moyen": round(taux_moyen, 2),
            "epargne_mensuelle": round(epargne_mensuelle, 2),
            "extra": round(extra, 2)}


def repartition_par_pays(assets):
    """Valeur des actifs par pays (champ libre `pays` ; vide -> Non renseigné).
    Les comptes courants sont exclus : ce sont des liquidités de passage,
    pas une exposition géographique."""
    agg = defaultdict(float)
    for a in assets:
        if a.get("type") == "compte_courant":
            continue
        agg[(a.get("pays") or "").strip() or "Non renseigné"] += a.get("valeur") or 0
    total = sum(agg.values())
    rows = [{"pays": p, "valeur": round(v, 2),
             "pct": round(100 * v / total, 1) if total else 0}
            for p, v in agg.items() if v > 0]
    return sorted(rows, key=lambda x: -x["valeur"])


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
