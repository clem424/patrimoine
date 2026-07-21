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


# --------------------------------------------------------------- ANALYSE ---- #
def _month_add(mois: str, delta: int) -> str:
    """Décale un mois 'YYYY-MM' de `delta` mois."""
    idx = int(mois[:4]) * 12 + (int(mois[5:7]) - 1) + delta
    return f"{idx // 12}-{idx % 12 + 1:02d}"


def last_complete_month() -> str:
    """Dernier mois calendaire terminé (le mois en cours est partiel)."""
    return _month_add(dt.date.today().strftime("%Y-%m"), -1)


def monthly_by_category(tx):
    """{mois 'YYYY-MM': {catégorie: dépense}} — dépenses hors NON_DEPENSES."""
    agg = defaultdict(lambda: defaultdict(float))
    for t in tx:
        if t["montant"] < 0 and t["categorie"] not in NON_DEPENSES:
            agg[t["date"][:7]][t["categorie"]] += -t["montant"]
    return agg


def savings_rate_series(tx, months: int = 12):
    """Taux d'épargne mois par mois sur les `months` derniers mois COMPLETS.
    taux = net / entrées (le mois en cours, partiel, est écarté)."""
    mois_courant = dt.date.today().strftime("%Y-%m")
    complets = [f for f in monthly_cashflow(tx) if f["mois"] < mois_courant][-months:]
    return [{**f, "taux_epargne": round(100 * f["net"] / f["entrees"], 1)
             if f["entrees"] > 0 else None} for f in complets]


def category_trends(tx, lookback: int = 3):
    """Pour chaque catégorie de dépense : dépense du dernier mois complet vs
    moyenne des `lookback` mois précédents. -> (lignes triées, mois de référence)."""
    ref = last_complete_month()
    by = monthly_by_category(tx)
    prior = [_month_add(ref, -i) for i in range(1, lookback + 1)]
    cats = set(by.get(ref, {}))
    for m in prior:
        cats |= set(by.get(m, {}))
    rows = []
    for c in cats:
        cur = round(by.get(ref, {}).get(c, 0.0), 2)
        moy = round(sum(by.get(m, {}).get(c, 0.0) for m in prior) / len(prior), 2)
        rows.append({"categorie": c, "mois": cur, "moyenne": moy,
                     "delta": round(cur - moy, 2),
                     "delta_pct": round(100 * (cur - moy) / moy, 1) if moy > 0 else None})
    return sorted(rows, key=lambda r: -r["mois"]), ref


def spending_anomalies(tx, lookback: int = 3):
    """Catégories dont la dépense du dernier mois complet dépasse nettement sa
    moyenne récente : montant du mois significatif (≥ 60 €), hausse ≥ 40 €, et
    soit c'est une dépense nouvelle (moyenne nulle), soit un spike > +35 %.
    -> (lignes, mois de référence)."""
    rows, ref = category_trends(tx, lookback)
    out = [r for r in rows
           if r["mois"] >= 60 and r["delta"] >= 40
           and (r["moyenne"] == 0 or r["mois"] > r["moyenne"] * 1.35)]
    return sorted(out, key=lambda r: -r["delta"]), ref


def biggest_expenses(tx, days: int = 90, top: int = 8):
    """Plus grosses dépenses individuelles des `days` derniers jours (hors NON_DEPENSES)."""
    seuil = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    dep = [t for t in tx if t["montant"] < 0 and t["date"][:10] >= seuil
           and t["categorie"] not in NON_DEPENSES]
    dep.sort(key=lambda t: t["montant"])
    return [{"date": t["date"][:10], "libelle": t["libelle"],
             "montant": round(-t["montant"], 2), "categorie": t["categorie"]}
            for t in dep[:top]]


# --------------------------------------- CONSEILS D'INVESTISSEMENT ---- #
# Règles répandues de gestion de patrimoine (façon Finary), appliquées aux
# chiffres réels du profil. Ce sont des repères généraux, PAS un conseil
# financier personnalisé.
LIVRET_A_MAX = 22950        # plafond réglementaire Livret A (€)
LIVRET_JEUNE_MAX = 1600     # plafond Livret Jeune (€)
LDDS_MAX = 12000            # plafond LDDS (€)
SAFE_TYPES = ("compte_courant", "livret_a", "livret_jeune")
CRYPTO_MAX_PART = 0.10      # part max raisonnable d'actifs très volatils
LIGNE_MAX_PART = 0.45       # au-delà : concentration sur une seule ligne
PAYS_MAX_PART = 70          # % max sur un seul pays avant alerte diversification


def investment_advice(ctx: dict) -> list[dict]:
    """Conseils personnalisés déduits de règles connues. Chaque conseil :
    {niveau: 'alerte'|'conseil'|'ok', titre, texte}. Fonction pure."""
    adv = []
    par_type = ctx.get("par_type", {})
    patrimoine = ctx.get("patrimoine") or 0
    k = ctx.get("kpis")
    dep_moy = k["depenses_moyennes"] if k else None

    safe_types = {t for t in par_type
                  if t in SAFE_TYPES or "livret" in t or "ldds" in t}
    safe = sum(par_type[t] for t in safe_types)
    cc = par_type.get("compte_courant", 0)

    # 1) Épargne de précaution : 3 à 6 mois de dépenses sur supports sûrs
    if dep_moy and dep_moy > 0:
        mois = safe / dep_moy
        if mois < 3:
            adv.append(("alerte", "Épargne de précaution insuffisante",
                f"{_eur(safe)} d'épargne sûre, soit {mois:.1f} mois de dépenses. "
                f"Règle courante : 3 à 6 mois ({_eur(3*dep_moy)}–{_eur(6*dep_moy)}) "
                f"disponibles sur un livret avant d'investir davantage."))
        elif mois > 6:
            adv.append(("conseil", "Trop de liquidités dormantes",
                f"{mois:.1f} mois de dépenses en épargne sûre. Au-delà de ~6 mois "
                f"(excédent ~{_eur(safe - 6*dep_moy)}), cet argent perd de la valeur "
                f"avec l'inflation : envisager de l'investir (PEA, assurance-vie)."))
        else:
            adv.append(("ok", "Épargne de précaution saine",
                f"{mois:.1f} mois de dépenses couverts — dans la fourchette 3–6 mois."))

    # 2) Liquidités dormantes sur le compte courant
    if dep_moy and cc > 1.5 * dep_moy:
        adv.append(("conseil", "Liquidités sur le compte courant",
            f"{_eur(cc)} dorment sur le compte courant (~{cc/dep_moy:.1f} mois de "
            f"dépenses), sans rémunération. Placer l'excédent sur un Livret A "
            f"(rémunéré et disponible à tout moment)."))

    # 3) Saturation des livrets réglementaires (support sûr, avant tout le reste)
    la = par_type.get("livret_a", 0)
    if la >= LIVRET_A_MAX * 0.98:
        adv.append(("ok", "Livret A au plafond",
            f"Livret A saturé ({_eur(LIVRET_A_MAX)}). Support sûr suivant : "
            f"LDDS (plafond {_eur(LDDS_MAX)})."))
    elif la > 0 and dep_moy and cc > 3 * dep_moy:
        place = min(cc - 3 * dep_moy, LIVRET_A_MAX - la)
        if place > 200:
            adv.append(("conseil", "Livret A non saturé",
                f"Livret A à {_eur(la)} / {_eur(LIVRET_A_MAX)}. De la liquidité "
                f"disponible pourrait y être placée (~{_eur(place)}) : rémunéré, "
                f"sûr et sans risque, à privilégier avant les supports volatils."))
    lj = par_type.get("livret_jeune", 0)
    if 0 < lj < LIVRET_JEUNE_MAX * 0.98:
        adv.append(("conseil", "Livret Jeune non saturé",
            f"Livret Jeune à {_eur(lj)} / {_eur(LIVRET_JEUNE_MAX)} : c'est le livret "
            f"le mieux rémunéré, à saturer en priorité si éligible (12–25 ans)."))

    # 4) Exposition aux actifs très volatils (crypto)
    crypto_val = par_type.get("crypto", 0)
    if patrimoine and crypto_val / patrimoine > CRYPTO_MAX_PART:
        adv.append(("conseil", "Exposition crypto élevée",
            f"La crypto pèse {100*crypto_val/patrimoine:.0f} % du patrimoine. "
            f"Repère prudent : limiter les actifs très volatils à ~5–10 % "
            f"pour contenir le risque."))

    # 5) Concentration sur une seule ligne risquée
    for a in ctx.get("lignes_actifs", []):
        if (patrimoine and a["type"] not in SAFE_TYPES
                and a["valeur"] / patrimoine > LIGNE_MAX_PART):
            adv.append(("conseil", "Concentration sur un actif",
                f"« {a['nom']} » représente {100*a['valeur']/patrimoine:.0f} % du "
                f"patrimoine. Une ligne risquée aussi dominante expose fortement à "
                f"sa seule évolution : diversifier réduit ce risque."))
            break

    # 6) Concentration géographique
    for p in ctx.get("pays", []):
        if p["pays"] != "Non renseigné" and p["pct"] > PAYS_MAX_PART:
            adv.append(("conseil", "Concentration géographique",
                f"{p['pct']:.0f} % du patrimoine investi est exposé à « {p['pays']} ». "
                f"Diversifier géographiquement (ex : un ETF Monde) réduit le risque pays."))
            break

    # 7) Taux d'épargne
    if k and k.get("taux_epargne") is not None:
        tr = k["taux_epargne"]
        if tr < 10:
            adv.append(("conseil", "Taux d'épargne faible",
                f"Taux d'épargne de {tr:.0f} %. Repère courant : épargner au moins "
                f"10 à 20 % de ses revenus pour se constituer un patrimoine."))
        elif tr >= 20:
            adv.append(("ok", "Bon taux d'épargne",
                f"Taux d'épargne de {tr:.0f} %, au-dessus du repère de 20 %."))

    # 8) Investissement programmé (DCA)
    if not ctx.get("a_routine") and patrimoine:
        adv.append(("conseil", "Automatiser l'investissement",
            "Aucune routine d'investissement active. Investir un montant fixe "
            "chaque mois (DCA) lisse les points d'entrée et automatise l'effort "
            "d'épargne — configurable dans Patrimoine."))

    # 9) Horizon pour atteindre l'objectif
    obj = ctx.get("objectif")
    if obj and k and k.get("epargne_mensuelle", 0) > 0 and patrimoine < obj:
        ans = (obj - patrimoine) / (k["epargne_mensuelle"] * 12)
        adv.append(("ok", "Trajectoire vers l'objectif",
            f"Au rythme actuel ({_eur(k['epargne_mensuelle'])}/mois, hors rendement), "
            f"l'objectif de {_eur(obj)} serait atteint dans ~{ans:.1f} ans "
            f"(le rendement des placements peut raccourcir ce délai)."))

    ordre = {"alerte": 0, "conseil": 1, "ok": 2}
    adv.sort(key=lambda x: ordre[x[0]])
    return [{"niveau": n, "titre": t, "texte": txt} for n, t, txt in adv]


# ---- Rapport Markdown prêt à coller dans Claude (données 100 % locales) ---- #
def _eur(v) -> str:
    if v is None:
        return "—"
    return f"{v:,.0f} €".replace(",", " ")           # espace fine insécable


def _pct(v) -> str:
    if v is None:
        return "—"
    return f"{'+' if v >= 0 else '−'}{abs(v):.1f} %"


def markdown_report(ctx: dict) -> str:
    """Construit le rapport d'analyse à partir du dict assemblé par l'API.
    Fonction pure (testable) : ne touche ni la base ni le réseau."""
    L = [f"# Analyse patrimoniale — {ctx['genere_le']}", ""]

    # Conseils d'investissement (règles connues appliquées aux chiffres)
    if ctx.get("conseils"):
        L.append("## Conseils d'investissement")
        marque = {"alerte": "⚠", "conseil": "→", "ok": "✓"}
        for c in ctx["conseils"]:
            L.append(f"- {marque.get(c['niveau'], '-')} **{c['titre']}** — {c['texte']}")
        L.append("")
        L.append("_Repères généraux fondés sur des règles répandues, pas un conseil "
                 "financier personnalisé._")
        L.append("")

    # Vue d'ensemble
    L.append("## Vue d'ensemble")
    L.append(f"- Patrimoine total : **{_eur(ctx['patrimoine'])}**")
    if ctx.get("objectif"):
        part = 100 * ctx["patrimoine"] / ctx["objectif"] if ctx["objectif"] else 0
        L.append(f"- Objectif : {_eur(ctx['objectif'])} ({part:.0f} % atteint)")
    if ctx.get("revenu_estime"):
        L.append(f"- Revenu mensuel estimé : {_eur(ctx['revenu_estime'])}")
    k = ctx.get("kpis")
    if k:
        L.append(f"- Épargne mensuelle moyenne ({k['nb_mois']} mois) : "
                 f"{_eur(k['epargne_mensuelle'])} — taux d'épargne "
                 f"{k['taux_epargne'] if k['taux_epargne'] is not None else '—'} %")
        L.append(f"- Revenus moyens : {_eur(k['revenus_moyens'])} · "
                 f"dépenses moyennes : {_eur(k['depenses_moyennes'])}")
        L.append(f"- Projection du patrimoine à 1 an (rythme actuel) : "
                 f"{_eur(k['projection_1an'])}")
    L.append("")

    # Répartition
    if ctx.get("repartition"):
        tot = ctx["patrimoine"] or 1
        L += ["## Répartition du patrimoine", "", "| Classe | Valeur | Part |",
              "|---|---:|---:|"]
        for r in ctx["repartition"]:
            L.append(f"| {r['classe']} | {_eur(r['valeur'])} | {100 * r['valeur'] / tot:.0f} % |")
        L.append("")
    if ctx.get("pays"):
        L += ["### Par pays", "", "| Pays | Valeur | Part |", "|---|---:|---:|"]
        for r in ctx["pays"]:
            L.append(f"| {r['pays']} | {_eur(r['valeur'])} | {r['pct']:.0f} % |")
        L.append("")

    # Actifs suivis
    if ctx.get("actifs"):
        L += ["## Actifs avec suivi de plus-value", "",
              "| Actif | Classe | Investi | Valeur | Plus-value | %/an réel |",
              "|---|---|---:|---:|---:|---:|"]
        for a in ctx["actifs"]:
            L.append(f"| {a['nom']} | {a['classe']} | {_eur(a['prix_achat'])} | "
                     f"{_eur(a['valeur'])} | {_eur(a['plus_value'])} ({_pct(a['perf_pct'])}) | "
                     f"{_pct(a.get('perf_annuelle'))} |")
        L.append("")

    # Flux mensuels + taux d'épargne
    if ctx.get("epargne_series"):
        L += ["## Flux mensuels et taux d'épargne", "",
              "| Mois | Entrées | Sorties | Net | Taux d'épargne |",
              "|---|---:|---:|---:|---:|"]
        for f in ctx["epargne_series"]:
            L.append(f"| {f['mois']} | {_eur(f['entrees'])} | {_eur(f['sorties'])} | "
                     f"{_eur(f['net'])} | "
                     f"{f['taux_epargne'] if f['taux_epargne'] is not None else '—'} % |")
        L.append("")

    # Dépenses par catégorie 12 mois
    if ctx.get("depenses_12m"):
        L += ["## Dépenses par catégorie (12 derniers mois)", "",
              "| Catégorie | Total |", "|---|---:|"]
        for d in ctx["depenses_12m"]:
            L.append(f"| {d['categorie']} | {_eur(d['montant'])} |")
        L.append("")

    # Tendances
    if ctx.get("tendances"):
        L += [f"## Tendances — {ctx['mois_reference']} vs moyenne des 3 mois précédents",
              "", "| Catégorie | Mois réf. | Moyenne | Écart |", "|---|---:|---:|---:|"]
        for r in ctx["tendances"]:
            fleche = "▲" if r["delta"] > 0 else "▼" if r["delta"] < 0 else "="
            L.append(f"| {r['categorie']} | {_eur(r['mois'])} | {_eur(r['moyenne'])} | "
                     f"{fleche} {_eur(r['delta'])} ({_pct(r['delta_pct'])}) |")
        L.append("")

    # Anomalies
    L.append("## Anomalies détectées")
    if ctx.get("anomalies"):
        for r in ctx["anomalies"]:
            L.append(f"- **{r['categorie']}** : {_eur(r['mois'])} ce mois contre "
                     f"{_eur(r['moyenne'])} en moyenne ({_pct(r['delta_pct'])})")
    else:
        L.append("- Aucune dépense anormale détectée sur le dernier mois complet.")
    L.append("")

    # Abonnements
    if ctx.get("abonnements"):
        L += ["## Dépenses récurrentes (abonnements probables)", "",
              "| Libellé | Montant | Occurrences | Catégorie |", "|---|---:|---:|---|"]
        for s in ctx["abonnements"]:
            L.append(f"| {s['libelle']} | {_eur(s['montant'])} | {s['occurrences']} | "
                     f"{s['categorie']} |")
        total_abo = sum(s["montant"] for s in ctx["abonnements"])
        L.append("")
        L.append(f"Total récurrent estimé : **{_eur(total_abo)}/mois**.")
        L.append("")

    # Grosses dépenses
    if ctx.get("grosses_depenses"):
        L += ["## Plus grosses dépenses (90 derniers jours)", "",
              "| Date | Libellé | Montant | Catégorie |", "|---|---|---:|---|"]
        for g in ctx["grosses_depenses"]:
            L.append(f"| {g['date']} | {g['libelle']} | {_eur(g['montant'])} | "
                     f"{g['categorie']} |")
        L.append("")

    # Budget du mois
    b = ctx.get("budget")
    if b and b.get("lignes"):
        L += [f"## Budget du mois ({b['mois']})", "",
              "| Catégorie | Budget | Dépensé | Reste |", "|---|---:|---:|---:|"]
        for l in b["lignes"]:
            L.append(f"| {l['categorie']} | {_eur(l['budget'])} | {_eur(l['depense'])} | "
                     f"{_eur(l['reste'])} |")
        L.append("")

    L += ["---", "",
          "Pistes d'analyse possibles :",
          "- Où réduire mes dépenses sans trop d'effort, au vu des tendances et des abonnements ?",
          "- Mon taux d'épargne est-il cohérent avec mon objectif ? En combien de temps l'atteindre ?",
          "- Mon patrimoine est-il bien diversifié (classes d'actifs, pays) ?",
          "- Quelles dépenses récurrentes méritent d'être questionnées ou renégociées ?"]
    return "\n".join(L)


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
