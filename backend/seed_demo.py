"""Peuple un profil de démonstration `demo` / `1234` avec des données synthétiques
complètes (aucune donnée réelle). Ré-exécutable : purge d'abord un `demo` existant.

À lancer dans le conteneur : docker exec patrimoine python seed_demo.py
"""
from __future__ import annotations
import datetime as dt
import random

import db
import auth
import parsers

random.seed(42)                       # données reproductibles d'un run à l'autre
TODAY = dt.date.today()
SOURCE, COMPTE = "demo", "Compte courant démo"


# --------------------------------------------------------------- purge démo ---- #
def purge_demo():
    u = db.get_user_by_pseudo("demo")
    if not u:
        return
    uid = u["id"]
    with db.get_db() as conn:
        for t in ("transactions", "manual_assets", "category_cache", "budgets",
                  "asset_types", "snapshots", "events", "event_overrides",
                  "user_categories", "invest_routines", "sessions"):
            conn.execute(f"DELETE FROM {t} WHERE user_id=?", (uid,))
        conn.execute("DELETE FROM settings WHERE cle LIKE ?", (f"%:{uid}",))
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
    print(f"Ancien profil demo (uid={uid}) purgé.")


# --------------------------------------------------------------- opérations ---- #
def gen_transactions(uid: int):
    """~1 an d'opérations réalistes et déjà catégorisées (categorized_by='manual')."""
    ops = []

    def add(date: dt.date, libelle: str, montant: float, categorie: str):
        ops.append({"date": dt.datetime(date.year, date.month, date.day),
                    "libelle": libelle, "montant": round(montant, 2),
                    "categorie": categorie})

    epiceries = ["CARREFOUR MARKET", "LIDL", "MONOPRIX", "AUCHAN", "FRANPRIX", "BIOCOOP"]
    restos = ["LE BISTROT DU COIN", "SUSHI SHOP", "MCDONALD'S", "BURGER KING",
              "PIZZERIA NAPOLI", "CAFE DE LA GARE", "BOULANGERIE PAUL"]
    shopping = ["ZARA", "UNIQLO", "DECATHLON", "FNAC", "SEPHORA", "H&M"]
    loisirs = ["UGC CINE CITE", "STEAM GAMES", "SPOTIFY CONCERT", "BOWLING STAR"]

    # 13 mois glissants, du plus ancien au mois courant
    start = (TODAY.replace(day=1) - dt.timedelta(days=365)).replace(day=1)
    m = start
    while m <= TODAY.replace(day=1):
        y, mo = m.year, m.month
        def d(day):                                # jour borné au mois
            import calendar
            return dt.date(y, mo, min(day, calendar.monthrange(y, mo)[1]))

        # Revenus fixes
        add(d(28), "VIREMENT SALAIRE ACME SAS", 2400, "Revenus")
        # Logement
        add(d(3), "LOYER APPARTEMENT", -850, "Logement")
        add(d(6), "EDF ELECTRICITE", -34.90, "Logement")
        add(d(6), "BOX INTERNET ORANGE", -29.99, "Logement")
        # Abonnements
        add(d(2), "FORFAIT MOBILE SOSH", -19.99, "Abonnements")
        add(d(15), "NETFLIX", -13.49, "Abonnements")
        add(d(15), "SPOTIFY", -10.99, "Abonnements")
        # Épargne programmée
        add(d(5), "VIREMENT PEA BOURSORAMA", -300, "Épargne")
        # Transports
        add(d(1), "NAVIGO MENSUEL", -84.10, "Voyages & Transports")
        if random.random() < 0.5:
            add(d(random.randint(8, 24)), "TOTAL ENERGIES ESSENCE",
                -round(random.uniform(45, 75), 2), "Voyages & Transports")
        if random.random() < 0.3:
            add(d(random.randint(8, 24)), "SNCF CONNECT",
                -round(random.uniform(38, 95), 2), "Voyages & Transports")
        # Courses (4 à 6 / mois)
        for _ in range(random.randint(4, 6)):
            add(d(random.randint(2, 27)), random.choice(epiceries),
                -round(random.uniform(22, 88), 2), "Vie quotidienne")
        # Restaurants (2 à 4 / mois)
        for _ in range(random.randint(2, 4)):
            add(d(random.randint(2, 27)), random.choice(restos),
                -round(random.uniform(11, 46), 2), "Restaurants & Bars")
        # Loisirs (0 à 2)
        for _ in range(random.randint(0, 2)):
            add(d(random.randint(2, 27)), random.choice(loisirs),
                -round(random.uniform(9, 35), 2), "Loisirs et sorties")
        # Shopping (0 à 1)
        if random.random() < 0.6:
            add(d(random.randint(2, 27)), random.choice(shopping),
                -round(random.uniform(25, 95), 2), "Shopping & Vêtements")
        # Santé (0 à 1)
        if random.random() < 0.4:
            add(d(random.randint(2, 27)),
                random.choice(["PHARMACIE CENTRALE", "DR MARTIN CONSULT"]),
                -round(random.uniform(12, 40), 2), "Santé")
        # Retrait (0 à 1)
        if random.random() < 0.3:
            add(d(random.randint(2, 27)), "RETRAIT DAB", -round(random.choice([20, 40, 50, 60])),
                "Retraits d'espèces")
        # Petit revenu ponctuel (remboursement d'un ami)
        if random.random() < 0.35:
            add(d(random.randint(2, 27)), "VIREMENT RECU J. DUPONT",
                round(random.uniform(12, 45), 2), "Revenus")

        m = dt.date(y + (mo == 12), (mo % 12) + 1, 1)

    # Insertion avec op_id stable et catégorie confirmée manuellement
    seq = parsers._seq_counter()
    with db.get_db() as conn:
        for o in ops:
            s = seq(o["date"], o["libelle"], o["montant"], COMPTE)
            op_id = parsers.make_op_id(o["date"], o["libelle"], o["montant"],
                                       SOURCE, COMPTE, s)
            conn.execute(
                """INSERT OR IGNORE INTO transactions
                   (user_id, op_id, date, libelle, montant, categorie, sous_categorie,
                    source, compte, categorized_by)
                   VALUES (?,?,?,?,?,?,?,?,?,'manual')""",
                (uid, op_id, o["date"].isoformat(), o["libelle"], o["montant"],
                 o["categorie"], "", SOURCE, COMPTE))
    print(f"{len(ops)} opérations insérées.")


# ------------------------------------------------------------------ actifs ---- #
def gen_assets(uid: int) -> int:
    """Crée les actifs. Renvoie l'id de l'ETF PEA (pour la routine)."""
    db.add_asset_type(uid, "assurance_vie", "Assurance-vie", "#4E9BB0")

    def a(**k):
        k.setdefault("source", "manuel")
        return db.upsert_asset(uid, k)

    a(type="compte_courant", nom="Compte courant", valeur=2410, pays="France")
    a(type="livret_a", nom="Livret A", valeur=9500, pays="France")
    a(type="livret_jeune", nom="Livret Jeune", valeur=1600, pays="France")
    # PEA — ETF et action avec suivi de plus-value (tickers Yahoo réels)
    etf = a(type="pea", nom="Amundi MSCI World", valeur=6800, quantite=10,
            ticker="CW8.PA", prix_achat=6200,
            date_achat=(TODAY - dt.timedelta(days=300)).isoformat(),
            pays="Monde", croissance_pct=7)
    a(type="pea", nom="Air Liquide", valeur=2240, quantite=12, ticker="AI.PA",
      prix_achat=2000, date_achat=(TODAY - dt.timedelta(days=220)).isoformat(),
      pays="France", croissance_pct=6)
    # Crypto (tickers CoinGecko)
    a(type="crypto", nom="Bitcoin", valeur=1850, quantite=0.03, ticker="bitcoin",
      prix_achat=1400, date_achat=(TODAY - dt.timedelta(days=180)).isoformat(),
      pays="Monde", croissance_pct=15)
    a(type="crypto", nom="Ethereum", valeur=800, quantite=0.5, ticker="ethereum",
      prix_achat=720, date_achat=(TODAY - dt.timedelta(days=150)).isoformat(),
      pays="Monde", croissance_pct=15)
    # Assurance-vie (type personnalisé)
    a(type="assurance_vie", nom="Assurance-vie Linxea", valeur=4200,
      prix_achat=4000, date_achat=(TODAY - dt.timedelta(days=400)).isoformat(),
      pays="France", croissance_pct=3)

    db.class_growth_set(uid, "pea", 7)
    db.class_growth_set(uid, "crypto", 12)
    print("Actifs créés (ETF PEA id =", etf, ").")
    return etf


# ------------------------------------------------ budgets / réglages / reste ---- #
def gen_rest(uid: int, etf_id: int):
    for cat, montant in [("Vie quotidienne", 400), ("Restaurants & Bars", 150),
                         ("Loisirs et sorties", 80), ("Logement", 950),
                         ("Abonnements", 55), ("Voyages & Transports", 180),
                         ("Shopping & Vêtements", 90)]:
        db.budget_set(uid, cat, montant)

    db.setting_set(f"objectif:{uid}", "100000")
    db.setting_set(f"revenu:{uid}", "2400")

    # Évènement : vacances d'été de l'an dernier
    aout = dt.date(TODAY.year - (TODAY.month < 8), 8, 1)
    db.event_create(uid, "Vacances d'été", aout.isoformat(),
                    (aout + dt.timedelta(days=15)).isoformat())

    # Routine d'investissement : 200 € le 5 du mois sur l'ETF PEA
    import calendar

    def next5():
        d = TODAY
        y, mo = (d.year, d.month) if d.day < 5 else \
                (d.year + (d.month == 12), (d.month % 12) + 1)
        return dt.date(y, mo, min(5, calendar.monthrange(y, mo)[1]))
    db.routine_add(uid, etf_id, 200, 5, next5().isoformat())

    # Courbe de patrimoine : ~1 point / semaine, croissance + bruit
    with db.get_db() as conn:
        base, day = 17500, (TODAY - dt.timedelta(days=364))
        while day <= TODAY:
            frac = (day - (TODAY - dt.timedelta(days=364))).days / 364
            total = base + frac * 11800 + random.uniform(-350, 350)
            conn.execute("INSERT OR REPLACE INTO snapshots (user_id, date, total)"
                         " VALUES (?,?,?)", (uid, day.isoformat(), round(total, 2)))
            day += dt.timedelta(days=7)
    print("Budgets, objectif, revenu, évènement, routine et courbe créés.")


def main():
    purge_demo()
    pass_hash, salt = auth.hash_password("1234")
    uid = db.create_user("demo", pass_hash, salt)
    print(f"Profil demo créé (uid={uid}).")
    gen_transactions(uid)
    etf_id = gen_assets(uid)
    gen_rest(uid, etf_id)
    print("Terminé.")


if __name__ == "__main__":
    main()
