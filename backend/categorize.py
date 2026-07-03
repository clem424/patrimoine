"""
Moteur de catégorisation, en 3 étages (du moins cher au plus cher) :

  1. RÈGLES        : mots-clés marchands fréquents -> catégorie immédiate, gratuit.
  2. CACHE         : libellé déjà vu -> catégorie mémorisée (apprise avant).
  3. OLLAMA        : on demande au modèle local de choisir UNE catégorie dans la liste.

Le résultat d'Ollama est mémorisé dans le cache pour ne jamais redemander deux fois.
Chaque profil a SA liste de catégories (renommables, avec descriptions) en base.

Pour fiabiliser Ollama :
  - sortie structurée (`format` = schéma JSON avec enum) : le modèle ne PEUT répondre
    qu'une catégorie exacte de la liste, fini les réponses approximatives ;
  - few-shot dynamique : les dernières corrections manuelles du profil sont injectées
    comme exemples, le modèle apprend les habitudes de chacun ;
  - les descriptions des catégories (modifiables dans Réglages) cadrent ses choix.
"""
from __future__ import annotations
import os
import re
import json
import requests

import db

# Configurables par variable d'environnement (voir docker-compose.yml).
OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/") + "/api/generate"
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")   # `ollama list` pour voir les tiens

# Liste par défaut : copiée dans chaque nouveau profil (table user_categories),
# qui peut ensuite la renommer/compléter dans Réglages.
CATEGORIES = [
    "Vie quotidienne",          # courses, supermarchés, achats du quotidien
    "Restaurants & Bars",       # restos, fast-foods, bars, cafés
    "Loisirs et sorties",       # cinéma, jeux, concerts, sorties
    "Shopping & Vêtements",     # habits, chaussures, beauté, bijoux
    "Sport & Bien-être",        # sport, coiffeur, soins
    "Voyages & Transports",     # train, avion, essence, péages, transports
    "Logement",                 # loyer, électricité, eau, internet, assurance habitation
    "Abonnements",              # Netflix, Spotify, téléphonie, SaaS récurrents
    "Santé",                    # médecin, pharmacie, mutuelle
    "Education & Famille",      # école, enfants, famille
    "Cadeaux & Dons",           # cadeaux, cagnottes, associations
    "Retraits d'espèces",       # retraits au distributeur
    "Impôts & Taxes",           # impôts, timbres fiscaux, amendes
    "Frais bancaires",          # cotisations de carte, agios
    "Services financiers & professionnels",
    "Épargne",                  # virements vers livrets/PEA
    "Revenus",                  # salaire, remboursements, virements reçus
    "Virements internes",       # transferts entre tes propres comptes
    "Non catégorisé",
]

# Descriptions par défaut (copiées dans le profil, modifiables dans Réglages).
CAT_DESC = {
    "Vie quotidienne": "courses, supermarché, boulangerie, bricolage, achats du quotidien",
    "Restaurants & Bars": "restaurant, fast-food, bar, café, friterie",
    "Loisirs et sorties": "cinéma, jeux vidéo, concerts, bowling, sorties",
    "Shopping & Vêtements": "vêtements, chaussures, beauté, bijoux, mode",
    "Sport & Bien-être": "équipement sportif, salle de sport, coiffeur, soins",
    "Voyages & Transports": "train, avion, essence, péage, parking, transports en commun, hôtel",
    "Logement": "loyer, électricité, eau, internet, assurance habitation",
    "Abonnements": "streaming, téléphonie, abonnements récurrents",
    "Santé": "médecin, pharmacie, mutuelle, laboratoire",
    "Education & Famille": "école, études, enfants, famille",
    "Cadeaux & Dons": "cadeaux, cagnottes, associations caritatives",
    "Retraits d'espèces": "retrait d'argent liquide au distributeur",
    "Impôts & Taxes": "impôts, timbres fiscaux, amendes",
    "Frais bancaires": "cotisation de carte, agios, frais de banque",
    "Services financiers & professionnels": "notaire, avocat, assurances, services pro",
    "Épargne": "virement vers un livret ou un placement",
    "Revenus": "salaire, remboursement reçu, virement reçu d'un tiers",
}


def all_categories(uid: int) -> list[str]:
    """Catégories du profil (intégrées éventuellement renommées + personnalisées)."""
    return db.category_names(uid) or list(CATEGORIES)


# Règles mots-clés -> catégorie (rapide, déterministe, gratuit).
# L'ORDRE COMPTE : la première règle qui matche gagne — du plus spécifique
# au plus générique. Ajoute tes marchands fréquents pour éviter le modèle.
RULES = {
    "Retraits d'espèces": ["retrait", "dab ", "distributeur"],
    "Impôts & Taxes": ["timbre fiscal", "drfip", "dgfip", "tresor public", "impot",
                       "amende", "antai", "taxe"],
    "Frais bancaires": ["cotisation carte", "cotisation compte", "frais bancaire",
                        "agios", "commission d'intervention", "tenue de compte"],
    "Abonnements": ["netflix", "spotify", "deezer", "disney", "canal", "prime video",
                    "youtube premium", "icloud", "google one", "abonnement",
                    "basic fit", "basic-fit", "audible", "patreon", "openai", "anthropic"],
    "Santé": ["pharmacie", "pharm", "docteur", "dr ", "medecin", "labo", "mutuelle",
              "dentaire", "opticien", "kine", "hopital", "veterinaire"],
    # Stations essence de supermarché AVANT la règle « courses » du même magasin :
    # « CARREFOUR STATION » doit partir en transports, pas en vie quotidienne.
    "Voyages & Transports": ["carrefour station", "leclerc station", "auchan carburant",
                             "intermarche station", "station service", "station-service",
                             "sncf", "ilevia", "ratp", "uber", "blablacar", "total energ",
                             "esso", "bp ", "shell", "peage", "vinci", "essence", "metro",
                             "sanef", "aprr", "asf ", "parking", "flixbus", "ouigo",
                             "effia", "velib", "airbnb", "booking", "hotel", "ryanair",
                             "easyjet", "transavia"],
    "Cadeaux & Dons": ["leetchi", "lepotcommun", "le pot commun", "cadeau", "fleuriste",
                       "interflora", "unicef", "restos du coeur", "croix rouge", "don "],
    "Restaurants & Bars": ["mac ewan", "mcdo", "mcdonald", "burger", "kebab", "tacos",
                           "pizza", "sushi", "resto", "restaurant", "brasserie", "bistro",
                           "frite", "friterie", "francky", "cubana", "little havana",
                           "odejeuner", "le retro", "aleyna", "kfc", "subway", "o'tacos",
                           "creperie", "starbucks", "columbus"],
    "Sport & Bien-être": ["decathlon", "intersport", "go sport", "fitness", "piscine",
                          "coiffeur", "coiffure", "planity", "barber", "spa ", "institut",
                          "onglerie", "salle de sport"],
    "Shopping & Vêtements": ["zalando", "vinted", "shein", "temu", "aliexpress", "kiabi",
                             "primark", "zara", "h&m", "celio", "jules", "nike", "adidas",
                             "courir", "foot locker", "sephora", "nocibe", "yves rocher",
                             "histoire d'or", "bijou", "maroquinerie"],
    "Logement": ["edf", "engie", "veolia", "suez", "free", "orange", "sfr", "bouygues",
                 "loyer", "syndic", "assurance habitation", "foncia"],
    "Vie quotidienne": ["carrefour", "auchan", "leclerc", "lidl", "aldi", "intermarche",
                        "casino", "monoprix", "franprix", "super u", "jsl distri",
                        "boulange", "amazon", "leroy merlin", "action", "gifi",
                        "joue club", "smyths", "furet du nord", "lens & stick",
                        "la parisienne", "tabac", "presse", "boucherie", "vins gourman",
                        "picard", "grand frais", "normal ", "hema"],
    "Loisirs et sorties": ["cinema", "ugc", "pathe", "kinepolis", "steam", "playstation",
                           "nintendo", "sumup", "fnac", "micromania", "bowling",
                           "escape", "laser", "concert", "ticketmaster", "fever"],
    "Revenus": ["vir inst", "virements recus", "salaire", "remb", "remboursement",
                "caf ", "pole emploi", "france travail", "urssaf remb"],
    "Épargne": ["livret", "pea", "epargne", "assurance vie"],
}


def _cle(libelle: str) -> str:
    """Réduit un libellé à une clé stable (le marchand), en retirant le bruit :
    'paiement par carte', n° de carte, dates, montants, ponctuation."""
    s = libelle.lower()
    s = re.sub(r"paiement par carte|prelevement|prlv|vir(ement)?|sepa", " ", s)
    s = re.sub(r"\bcb\*?\d+\b", " ", s)
    s = re.sub(r"\bx\d{3,}\b", " ", s)
    s = re.sub(r"\d{1,2}/\d{1,2}(/\d{2,4})?", " ", s)
    s = re.sub(r"\d+", " ", s)
    s = re.sub(r"\b(carte|par|le|du|de|des|la|les|m|mme|mle)\b", " ", s)
    s = re.sub(r"[^a-zàâçéèêëîïôûùüœ ]", " ", s)   # ponctuation / séparateurs
    return re.sub(r"\s+", " ", s).strip()


def _fmt_montant(m: float) -> str:
    return f"{'dépense' if m < 0 else 'argent reçu'} de {abs(m):.2f} €"


def by_rules(libelle: str) -> str | None:
    low = libelle.lower()
    for cat, kws in RULES.items():
        if any(kw in low for kw in kws):
            return cat
    return None


def _match_category(ans: str, cats: list[str]) -> str | None:
    """Retrouve la catégorie dans la réponse du modèle : égalité stricte d'abord,
    sinon la catégorie la plus longue contenue dans la réponse (évite qu'un nom
    court en 'vole' un long qui le contient)."""
    a = ans.strip().strip('."« »\'').lower()
    for c in cats:
        if a == c.lower():
            return c
    best = None
    for c in cats:
        if c.lower() in a and (best is None or len(c) > len(best)):
            best = c
    return best


# Exemples génériques toujours fournis (couvrent les cas les plus courants).
_EXEMPLES = [
    ("PAIEMENT PAR CARTE X2851 CARREFOUR MARKET", "Vie quotidienne"),
    ("PAIEMENT PAR CARTE SANEF PEAGE", "Voyages & Transports"),
    ("PRLV NETFLIX.COM", "Abonnements"),
    ("PAIEMENT PAR CARTE MAC EWAN'S PUB", "Restaurants & Bars"),
    ("RETRAIT AU DISTRIBUTEUR", "Retraits d'espèces"),
    ("PAIEMENT PAR CARTE ZARA LILLE", "Shopping & Vêtements"),
    ("PAIEMENT PAR CARTE TIMBRE FISCAL - DRFIP", "Impôts & Taxes"),
]


def by_ollama(uid: int, libelle: str, montant: float | None = None,
              model: str = OLLAMA_MODEL, timeout: int = 90) -> str | None:
    """Demande au modèle local de classer le libellé. Renvoie None si Ollama injoignable.

    La réponse est contrainte par un schéma JSON (enum des catégories) : le modèle
    ne peut littéralement pas répondre autre chose qu'une catégorie valide."""
    infos = db.list_categories(uid)
    cats = [c["nom"] for c in infos if c["nom"] not in ("Non catégorisé", "Virements internes")]
    if not cats:
        return None
    desc = {c["nom"]: c["description"] for c in infos}
    liste = "\n".join(f"- {c}" + (f" : {desc[c]}" if desc.get(c) else "") for c in cats)

    # Few-shot : exemples génériques (si la catégorie existe encore sous ce nom
    # dans le profil) + dernières corrections manuelles du profil, AVEC leur
    # montant réel — le modèle apprend ainsi les habitudes liées aux sommes.
    exemples = [(f'"{lib}"', cat) for lib, cat in _EXEMPLES if cat in cats]
    exemples += [(f'"{t["libelle"]}" ({_fmt_montant(t["montant"])})', t["categorie"])
                 for t in db.manual_examples(uid) if t["categorie"] in cats]
    ex_txt = "\n".join(f"{lib} -> {cat}" for lib, cat in exemples)

    sens = f" ({_fmt_montant(montant)})" if montant is not None else ""
    prompt = (
        "Tu classes une opération bancaire française dans UNE seule catégorie.\n"
        f"Catégories possibles :\n{liste}\n\n"
        "Le montant est un indice important : certaines descriptions de catégories"
        " mentionnent des montants typiques (ex : petites sommes en supermarché ="
        " courses ; grosses sommes = plein d'essence ou gros achat).\n\n"
        f"Exemples :\n{ex_txt}\n\n"
        f"Opération : \"{libelle}\" (marchand : \"{_cle(libelle) or libelle}\"){sens}\n\n"
        "Réponds en JSON : {\"categorie\": \"<nom exact d'une catégorie de la liste>\"}"
    )
    schema = {"type": "object",
              "properties": {"categorie": {"type": "string", "enum": cats}},
              "required": ["categorie"]}
    try:
        r = requests.post(OLLAMA_URL, json={
            "model": model, "prompt": prompt, "stream": False, "format": schema,
            "options": {"temperature": 0, "num_predict": 96},
        }, timeout=timeout)
        r.raise_for_status()
        ans = r.json().get("response", "").strip()
    except Exception:
        return None
    try:
        cat = json.loads(ans).get("categorie")
        if cat in cats:
            return cat
    except Exception:
        pass
    return _match_category(ans, cats)   # filet de sécurité (vieux Ollama sans `format`)


def categorize(uid: int, libelle: str, montant: float | None = None,
               use_ollama: bool = True) -> tuple[str, str]:
    """Renvoie (categorie, methode). methode ∈ {rule, cache, ollama, none}."""
    valides = set(all_categories(uid))
    cle = _cle(libelle)

    # Les corrections manuelles de l'utilisateur priment sur tout, règles comprises.
    manual = db.cache_get(uid, cle, origin="manual")
    if manual and manual in valides:
        return manual, "cache"

    cat = by_rules(libelle)
    if cat and cat in valides:          # ignore une règle dont la catégorie a été renommée
        return cat, "rule"

    cached = cache_get_valid(uid, cle, valides)
    if cached:
        return cached, "cache"

    if use_ollama:
        cat = by_ollama(uid, libelle, montant)
        if cat:
            db.cache_set(uid, cle, cat)
            return cat, "ollama"

    return "Non catégorisé", "none"


def cache_get_valid(uid: int, cle: str, valides: set[str]) -> str | None:
    cached = db.cache_get(uid, cle)
    return cached if cached in valides else None


# Plafond de questions Ollama par passage de réexamen : ~20 s par marchand sur
# le Pi — au-delà, on s'arrête et l'utilisateur relance pour continuer.
MAX_QUESTIONS_OLLAMA = 40


def recategorize(uid: int) -> dict:
    """Réexamine les opérations NON confirmées à la lumière de l'apprentissage
    à jour : corrections manuelles > règles > Ollama ré-interrogé (avec les
    nouveaux exemples few-shot). Les opérations confirmées ne sont pas touchées.
    Une seule question Ollama par marchand unique (clé réduite du libellé)."""
    valides = set(all_categories(uid))
    targets = db.fetch_unconfirmed(uid)
    resolu: dict[str, tuple[str | None, str]] = {}
    stats = {"examinees": len(targets), "modifiees": 0, "inchangees": 0, "reste": 0}
    mods = []       # détail avant -> après, renvoyé au frontend pour contrôle
    ollama_ok, questions = True, 0

    for tx in targets:
        cle = _cle(tx["libelle"])
        if cle in resolu:
            cat, how = resolu[cle]
        else:
            manual = db.cache_get(uid, cle, origin="manual")
            if manual and manual in valides:
                cat, how = manual, "cache"
            else:
                cat = by_rules(tx["libelle"])
                if cat and cat in valides:
                    how = "rule"
                elif ollama_ok and questions < MAX_QUESTIONS_OLLAMA:
                    questions += 1
                    cat = by_ollama(uid, tx["libelle"], tx["montant"])
                    if cat:
                        db.cache_set(uid, cle, cat)   # rafraîchit la mémoire apprise
                        how = "ollama"
                    else:
                        ollama_ok = False             # Ollama en panne : on n'insiste pas
                        how = "reste"
                else:
                    cat, how = None, "reste"
            resolu[cle] = (cat, how)

        if cat is None:
            stats["reste"] += 1
        elif cat != tx["categorie"]:
            db.update_category(uid, tx["op_id"], cat, how)
            mods.append({"op_id": tx["op_id"], "date": tx["date"],
                         "libelle": tx["libelle"], "montant": tx["montant"],
                         "avant": tx["categorie"], "apres": cat, "how": how})
            stats["modifiees"] += 1
        else:
            stats["inchangees"] += 1
    stats["modifications"] = mods
    return stats
