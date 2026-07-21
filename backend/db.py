"""
Couche base de données : SQLite (un seul fichier, parfait pour un Raspberry Pi).

Multi-profils : chaque table de données porte un `user_id` — chaque membre de la
famille ne voit que ses propres comptes, opérations, actifs, budgets et catégories.
Les données créées avant l'arrivée des profils portent user_id=0 ; elles sont
automatiquement rattachées au PREMIER profil créé (voir claim_legacy_data).

Tables :
  - users / sessions      : profils (pseudo + mot de passe haché) et jetons de session
  - transactions          : opérations bancaires normalisées (clé = user_id + op_id)
  - manual_assets         : actifs saisis à la main (livrets, PEA, crypto, Pokémon…)
  - user_categories       : catégories d'opérations du profil (intégrées + perso),
                            avec description (utilisée pour guider Ollama)
  - category_cache        : mémoire des catégories apprises (libellé -> catégorie)
  - asset_types / budgets / settings
"""
from __future__ import annotations
import os
import secrets
import sqlite3
import unicodedata
import datetime as dt
from pathlib import Path
from contextlib import contextmanager

# DB_PATH configurable (Docker monte un volume sur /data pour persister la base).
DB_PATH = Path(os.environ.get("DB_PATH", Path(__file__).parent / "patrimoine.db"))

# Catégories au rôle spécial dans les calculs (analytics) : ni renommables ni supprimables.
PROTECTED_CATEGORIES = {"Non catégorisé", "Virements internes", "Épargne", "Revenus"}


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # WAL : lectures et écritures ne se bloquent plus mutuellement (utile quand
    # toute la famille consulte pendant un import). NORMAL suffit en WAL.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            pseudo     TEXT NOT NULL UNIQUE COLLATE NOCASE,
            pass_hash  TEXT NOT NULL,
            salt       TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token   TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transactions (
            user_id         INTEGER NOT NULL DEFAULT 0,
            op_id           TEXT NOT NULL,
            date            TEXT NOT NULL,
            libelle         TEXT NOT NULL,
            montant         REAL NOT NULL,
            categorie       TEXT NOT NULL DEFAULT 'Non catégorisé',
            sous_categorie  TEXT DEFAULT '',
            source          TEXT NOT NULL,
            compte          TEXT NOT NULL,
            categorized_by  TEXT DEFAULT 'none',
            PRIMARY KEY (user_id, op_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_tx_cat  ON transactions(categorie);
        CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date DESC);

        CREATE TABLE IF NOT EXISTS manual_assets (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL DEFAULT 0,
            type        TEXT NOT NULL,        -- livret_a, livret_jeune, pea, crypto, pokemon, autre
            nom         TEXT NOT NULL,
            valeur      REAL DEFAULT 0,       -- valeur EUR (saisie, ou dernière connue)
            quantite    REAL,                 -- crypto/titre : nb d'unités
            ticker      TEXT,                 -- crypto : id CoinGecko ; titre : symbole Yahoo
            source      TEXT DEFAULT 'manuel',-- manuel / binance / ledger
            commentaire TEXT DEFAULT '',
            masque      INTEGER DEFAULT 0,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_categories (
            user_id     INTEGER NOT NULL,
            nom         TEXT NOT NULL,
            description TEXT DEFAULT '',      -- guide Ollama : « courses, supermarché… »
            builtin     INTEGER DEFAULT 0,
            position    INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, nom)
        );

        CREATE TABLE IF NOT EXISTS category_cache (
            user_id     INTEGER NOT NULL DEFAULT 0,
            libelle_cle TEXT NOT NULL,        -- libellé normalisé/réduit
            categorie   TEXT NOT NULL,
            origin      TEXT DEFAULT 'ollama',-- ollama / manual (jamais écrasé par ollama)
            PRIMARY KEY (user_id, libelle_cle)
        );

        CREATE TABLE IF NOT EXISTS settings (
            cle   TEXT PRIMARY KEY,
            valeur TEXT
        );

        CREATE TABLE IF NOT EXISTS asset_types (   -- types d'actifs personnalisés
            user_id INTEGER NOT NULL DEFAULT 0,
            slug    TEXT NOT NULL,                 -- ex : immobilier
            label   TEXT NOT NULL,                 -- ex : Immobilier
            couleur TEXT NOT NULL DEFAULT '#8A93A6',
            PRIMARY KEY (user_id, slug)
        );

        CREATE TABLE IF NOT EXISTS budgets (       -- budget mensuel prévisionnel
            user_id   INTEGER NOT NULL DEFAULT 0,
            categorie TEXT NOT NULL,
            montant   REAL NOT NULL,
            PRIMARY KEY (user_id, categorie)
        );

        CREATE TABLE IF NOT EXISTS snapshots (     -- relevé quotidien du patrimoine
            user_id INTEGER NOT NULL,
            date    TEXT NOT NULL,                 -- YYYY-MM-DD (1 point par jour)
            total   REAL NOT NULL,
            PRIMARY KEY (user_id, date)
        );

        CREATE TABLE IF NOT EXISTS events (        -- évènements (vacances, fêtes…)
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            nom        TEXT NOT NULL,
            debut      TEXT NOT NULL,              -- YYYY-MM-DD inclus
            fin        TEXT NOT NULL,              -- YYYY-MM-DD inclus
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_overrides (
            user_id  INTEGER NOT NULL,
            event_id INTEGER NOT NULL,
            op_id    TEXT NOT NULL,
            inclus   INTEGER NOT NULL,             -- 1 = ajout manuel, 0 = exclu
            PRIMARY KEY (user_id, event_id, op_id)
        );

        CREATE TABLE IF NOT EXISTS invest_routines ( -- achats récurrents (DCA)
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            asset_id   INTEGER NOT NULL,           -- actif à ticker (PEA, crypto)
            montant    REAL NOT NULL,              -- euros investis à chaque échéance
            jour       INTEGER NOT NULL,           -- jour du mois (1-31, borné au mois)
            prochain   TEXT NOT NULL,              -- YYYY-MM-DD prochaine échéance
            created_at TEXT NOT NULL
        );
        """)
        # Routine : montant € fixe (virement programmé) plutôt qu'une quantité fixe.
        rcols = _cols(conn, "invest_routines")
        if "quantite" in rcols and "montant" not in rcols:
            conn.execute("ALTER TABLE invest_routines RENAME COLUMN quantite TO montant")
        _migrate_multiuser(conn)
        _migrate_op_ids_v2(conn)
        # Suivi des remboursements : dépense avancée pour quelqu'un (resto payé
        # pour le groupe, courses partagées…) à te faire rembourser.
        if "a_rembourser" not in _cols(conn, "transactions"):
            conn.execute("ALTER TABLE transactions ADD COLUMN"
                         " a_rembourser INTEGER NOT NULL DEFAULT 0")
        # Qui doit ce remboursement (nom libre, vide = non précisé).
        if "du_par" not in _cols(conn, "transactions"):
            conn.execute("ALTER TABLE transactions ADD COLUMN"
                         " du_par TEXT NOT NULL DEFAULT ''")
        # Groupes de remboursement : opérations partageant un `lien_groupe`
        # (N virements reçus remboursent N dépenses ; les stats comptent le net).
        # Remplace l'ancien lien 1→1 `lie_a`, converti puis supprimé.
        tcols = _cols(conn, "transactions")
        if "lien_groupe" not in tcols:
            conn.execute("ALTER TABLE transactions ADD COLUMN lien_groupe TEXT")
            if "lie_a" in tcols:
                for r in conn.execute("SELECT user_id, op_id, lie_a FROM transactions"
                                      " WHERE lie_a IS NOT NULL").fetchall():
                    conn.execute("UPDATE transactions SET lien_groupe=?"
                                 " WHERE user_id=? AND op_id IN (?,?)",
                                 (f"g-{r['lie_a']}", r["user_id"], r["op_id"], r["lie_a"]))
                conn.execute("ALTER TABLE transactions DROP COLUMN lie_a")
        # Suivi de croissance et diversification des actifs.
        acols = _cols(conn, "manual_assets")
        for col, ddl in (("prix_achat", "REAL"),          # total investi (€)
                         ("date_achat", "TEXT"),          # YYYY-MM-DD
                         ("pays", "TEXT DEFAULT ''"),     # diversification géographique
                         ("croissance_pct", "REAL")):     # croissance visée (%/an)
            if col not in acols:
                conn.execute(f"ALTER TABLE manual_assets ADD COLUMN {col} {ddl}")


# ------------------------------------------------------------ migrations ---- #
def _cols(conn, table) -> list[str]:
    return [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]


def _migrate_multiuser(conn):
    """Bases créées avant les profils : ajoute user_id (=0, « à réclamer ») partout,
    reconstruit les tables dont la clé primaire devient composite."""
    # manual_assets : colonnes ajoutées au fil des versions, puis user_id.
    cols = _cols(conn, "manual_assets")
    for col, ddl in (("source", "TEXT DEFAULT 'manuel'"), ("commentaire", "TEXT DEFAULT ''"),
                     ("masque", "INTEGER DEFAULT 0"), ("user_id", "INTEGER NOT NULL DEFAULT 0")):
        if col not in cols:
            conn.execute(f"ALTER TABLE manual_assets ADD COLUMN {col} {ddl}")

    if "user_id" not in _cols(conn, "transactions"):
        conn.execute("DROP INDEX IF EXISTS idx_tx_date")
        conn.execute("DROP INDEX IF EXISTS idx_tx_cat")
        conn.execute("ALTER TABLE transactions RENAME TO transactions_old")
        conn.execute("""CREATE TABLE transactions (
            user_id INTEGER NOT NULL DEFAULT 0, op_id TEXT NOT NULL,
            date TEXT NOT NULL, libelle TEXT NOT NULL, montant REAL NOT NULL,
            categorie TEXT NOT NULL DEFAULT 'Non catégorisé', sous_categorie TEXT DEFAULT '',
            source TEXT NOT NULL, compte TEXT NOT NULL, categorized_by TEXT DEFAULT 'none',
            PRIMARY KEY (user_id, op_id))""")
        conn.execute("""INSERT INTO transactions (user_id, op_id, date, libelle, montant,
                            categorie, sous_categorie, source, compte, categorized_by)
                        SELECT 0, op_id, date, libelle, montant, categorie, sous_categorie,
                            source, compte, categorized_by FROM transactions_old""")
        conn.execute("DROP TABLE transactions_old")
        conn.execute("CREATE INDEX idx_tx_date ON transactions(date)")
        conn.execute("CREATE INDEX idx_tx_cat  ON transactions(categorie)")

    if "user_id" not in _cols(conn, "category_cache"):
        has_origin = "origin" in _cols(conn, "category_cache")
        conn.execute("ALTER TABLE category_cache RENAME TO category_cache_old")
        conn.execute("""CREATE TABLE category_cache (
            user_id INTEGER NOT NULL DEFAULT 0, libelle_cle TEXT NOT NULL,
            categorie TEXT NOT NULL, origin TEXT DEFAULT 'ollama',
            PRIMARY KEY (user_id, libelle_cle))""")
        origin_src = "origin" if has_origin else "'ollama'"
        conn.execute(f"""INSERT INTO category_cache (user_id, libelle_cle, categorie, origin)
                         SELECT 0, libelle_cle, categorie, {origin_src} FROM category_cache_old""")
        conn.execute("DROP TABLE category_cache_old")

    if "user_id" not in _cols(conn, "budgets"):
        conn.execute("ALTER TABLE budgets RENAME TO budgets_old")
        conn.execute("""CREATE TABLE budgets (
            user_id INTEGER NOT NULL DEFAULT 0, categorie TEXT NOT NULL,
            montant REAL NOT NULL, PRIMARY KEY (user_id, categorie))""")
        conn.execute("INSERT INTO budgets SELECT 0, categorie, montant FROM budgets_old")
        conn.execute("DROP TABLE budgets_old")

    if "user_id" not in _cols(conn, "asset_types"):
        conn.execute("ALTER TABLE asset_types RENAME TO asset_types_old")
        conn.execute("""CREATE TABLE asset_types (
            user_id INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL, label TEXT NOT NULL,
            couleur TEXT NOT NULL DEFAULT '#8A93A6', PRIMARY KEY (user_id, slug))""")
        conn.execute("INSERT INTO asset_types SELECT 0, slug, label, couleur FROM asset_types_old")
        conn.execute("DROP TABLE asset_types_old")


def _migrate_op_ids_v2(conn):
    """Recalcule les op_id au format v2 (qui inclut compte + n° d'occurrence),
    pour que les ré-imports restent dédoublonnés après le changement de formule.
    Les lignes existantes sont uniques par (source, jour, libellé, montant),
    donc seq=0 pour toutes."""
    if conn.execute("SELECT 1 FROM settings WHERE cle='op_id_v2'").fetchone():
        return
    import parsers   # import local : évite la dépendance au chargement du module
    rows = conn.execute(
        "SELECT user_id, op_id, date, libelle, montant, source, compte FROM transactions"
    ).fetchall()
    for r in rows:
        date = dt.datetime.fromisoformat(r["date"])
        new_id = parsers.make_op_id(date, r["libelle"], r["montant"],
                                    r["source"], r["compte"], 0)
        if new_id != r["op_id"]:
            conn.execute("UPDATE transactions SET op_id=? WHERE user_id=? AND op_id=?",
                         (new_id, r["user_id"], r["op_id"]))
    conn.execute("INSERT OR REPLACE INTO settings (cle, valeur) VALUES ('op_id_v2','1')")


# ------------------------------------------------------- profils / sessions ---- #
def get_user_by_pseudo(pseudo: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE pseudo=?", (pseudo,)).fetchone()
        return dict(row) if row else None


def create_user(pseudo: str, pass_hash: str, salt: str) -> int:
    """Crée le profil, ses catégories par défaut ; le premier profil créé
    récupère toutes les données antérieures aux profils (user_id=0)."""
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO users (pseudo, pass_hash, salt, created_at) VALUES (?,?,?,?)",
            (pseudo, pass_hash, salt, dt.datetime.now().isoformat()))
        uid = cur.lastrowid
        _seed_categories(conn, uid)
        first = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 1
        if first:
            _claim_legacy_data(conn, uid)
        return uid


def _seed_categories(conn, uid: int):
    """Copie les catégories intégrées (+ descriptions pour Ollama) dans le profil.
    'Virements internes' et 'Non catégorisé' restent en fin de liste (position)."""
    from categorize import CATEGORIES, CAT_DESC   # import local : évite le cycle
    for i, nom in enumerate(CATEGORIES):
        pos = 9900 + i if nom in ("Virements internes", "Non catégorisé") else i * 10
        conn.execute("""INSERT OR IGNORE INTO user_categories
                        (user_id, nom, description, builtin, position) VALUES (?,?,?,1,?)""",
                     (uid, nom, CAT_DESC.get(nom, ""), pos))


def _claim_legacy_data(conn, uid: int):
    """Rattache au profil `uid` tout ce qui a été créé avant les profils."""
    for table in ("transactions", "manual_assets", "category_cache", "budgets", "asset_types"):
        conn.execute(f"UPDATE {table} SET user_id=? WHERE user_id=0", (uid,))
    # Anciennes catégories personnalisées (table pré-profils) -> catégories du profil.
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='custom_categories'").fetchone():
        rows = conn.execute("SELECT nom FROM custom_categories").fetchall()
        for i, r in enumerate(rows):
            conn.execute("""INSERT OR IGNORE INTO user_categories
                            (user_id, nom, builtin, position) VALUES (?,?,0,?)""",
                         (uid, r["nom"], 5000 + i))
        conn.execute("DROP TABLE custom_categories")
    # Clés Binance saisies avant les profils -> réglages du profil.
    for cle in ("binance_key", "binance_secret"):
        row = conn.execute("SELECT valeur FROM settings WHERE cle=?", (cle,)).fetchone()
        if row:
            conn.execute("INSERT OR REPLACE INTO settings (cle, valeur) VALUES (?,?)",
                         (f"{cle}:{uid}", row["valeur"]))
            conn.execute("DELETE FROM settings WHERE cle=?", (cle,))


def update_user_password(uid: int, pass_hash: str, salt: str):
    with get_db() as conn:
        conn.execute("UPDATE users SET pass_hash=?, salt=? WHERE id=?", (pass_hash, salt, uid))
        conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))   # déconnecte partout


def create_session(uid: int, days: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = (dt.datetime.now() + dt.timedelta(days=days)).isoformat()
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE expires < ?", (dt.datetime.now().isoformat(),))
        conn.execute("INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)",
                     (token, uid, expires))
    return token


def session_user(token: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute(
            """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token=? AND s.expires >= ?""",
            (token, dt.datetime.now().isoformat())).fetchone()
        return dict(row) if row else None


def delete_session(token: str):
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


# ----------------------------------------------------------- transactions ---- #
def insert_transactions(uid: int, ops: list[dict]) -> dict:
    """Insère des opérations en ignorant les doublons (même op_id). Renvoie un compte rendu."""
    inserted = 0
    with get_db() as conn:
        for op in ops:
            cur = conn.execute(
                """INSERT OR IGNORE INTO transactions
                   (user_id, op_id, date, libelle, montant, categorie, sous_categorie,
                    source, compte, categorized_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (uid, op["op_id"], op["date"].isoformat(), op["libelle"], op["montant"],
                 op["categorie"], op["sous_categorie"], op["source"],
                 op["compte"], op["categorized_by"]),
            )
            inserted += cur.rowcount
    return {"recus": len(ops), "ajoutees": inserted, "doublons_ignores": len(ops) - inserted}


def fetch_transactions(uid: int, limit: int | None = None) -> list[dict]:
    q = "SELECT * FROM transactions WHERE user_id=? ORDER BY date DESC, op_id"
    if limit:
        q += f" LIMIT {int(limit)}"
    with get_db() as conn:
        return [dict(r) for r in conn.execute(q, (uid,))]


def fetch_unconfirmed(uid: int) -> list[dict]:
    """Opérations dont la catégorie n'a pas été validée par l'utilisateur
    (posée par règle/cache/Ollama, ou encore vide) : cibles du réexamen."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM transactions WHERE user_id=? AND categorized_by != 'manual'"
            " ORDER BY date DESC", (uid,))]


def fetch_uncategorized(uid: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM transactions WHERE user_id=? AND categorie='Non catégorisé'"
            " ORDER BY date DESC", (uid,))]


def get_transaction(uid: int, op_id: str) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM transactions WHERE user_id=? AND op_id=?",
                           (uid, op_id)).fetchone()
        return dict(row) if row else None


def set_link_group(uid: int, op_ids: list[str], gid: str):
    """Réunit des opérations dans un groupe de remboursement. Si certaines
    étaient déjà liées, leurs groupes entiers sont fusionnés dans le nouveau."""
    marks = ",".join("?" * len(op_ids))
    with get_db() as conn:
        anciens = [r["lien_groupe"] for r in conn.execute(
            f"SELECT DISTINCT lien_groupe FROM transactions WHERE user_id=?"
            f" AND op_id IN ({marks}) AND lien_groupe IS NOT NULL",
            (uid, *op_ids))]
        if anciens:
            conn.execute(
                f"UPDATE transactions SET lien_groupe=? WHERE user_id=?"
                f" AND lien_groupe IN ({','.join('?' * len(anciens))})",
                (gid, uid, *anciens))
        conn.execute(f"UPDATE transactions SET lien_groupe=? WHERE user_id=?"
                     f" AND op_id IN ({marks})", (gid, uid, *op_ids))


def unlink_op(uid: int, op_id: str):
    """Retire une opération de son groupe ; dissout le groupe s'il ne reste
    plus au moins une dépense ET un virement reçu."""
    with get_db() as conn:
        row = conn.execute("SELECT lien_groupe FROM transactions"
                           " WHERE user_id=? AND op_id=?", (uid, op_id)).fetchone()
        gid = row["lien_groupe"] if row else None
        if not gid:
            return
        conn.execute("UPDATE transactions SET lien_groupe=NULL"
                     " WHERE user_id=? AND op_id=?", (uid, op_id))
        reste = conn.execute("SELECT montant FROM transactions WHERE user_id=?"
                             " AND lien_groupe=?", (uid, gid)).fetchall()
        if (len(reste) < 2 or not any(r["montant"] > 0 for r in reste)
                or not any(r["montant"] < 0 for r in reste)):
            conn.execute("UPDATE transactions SET lien_groupe=NULL"
                         " WHERE user_id=? AND lien_groupe=?", (uid, gid))


def set_due(uid: int, op_id: str, du: bool, par: str | None = None):
    """Marque/démarque une opération « à rembourser » (quelqu'un te doit ce montant).
    `par` = nom du débiteur (facultatif) ; démarquer efface le nom."""
    with get_db() as conn:
        if du:
            conn.execute("UPDATE transactions SET a_rembourser=1, du_par=?"
                         " WHERE user_id=? AND op_id=?",
                         ((par or "").strip(), uid, op_id))
        else:
            conn.execute("UPDATE transactions SET a_rembourser=0, du_par=''"
                         " WHERE user_id=? AND op_id=?", (uid, op_id))


def update_category(uid: int, op_id: str, categorie: str, how: str = "manual"):
    with get_db() as conn:
        conn.execute(
            "UPDATE transactions SET categorie=?, categorized_by=? WHERE user_id=? AND op_id=?",
            (categorie, how, uid, op_id),
        )


# ----- cache de catégories appris -----
def cache_get(uid: int, cle: str, origin: str | None = None) -> str | None:
    """Catégorie mémorisée pour cette clé. origin='manual' -> uniquement les
    corrections faites à la main (prioritaires sur les règles)."""
    q = "SELECT categorie FROM category_cache WHERE user_id=? AND libelle_cle=?"
    args = [uid, cle]
    if origin:
        q += " AND origin=?"
        args.append(origin)
    with get_db() as conn:
        row = conn.execute(q, args).fetchone()
        return row["categorie"] if row else None


def cache_set(uid: int, cle: str, categorie: str, origin: str = "ollama"):
    """Mémorise une association libellé->catégorie. Une entrée 'manual' (correction
    de l'utilisateur) n'est jamais écrasée par une entrée 'ollama'."""
    with get_db() as conn:
        cur = conn.execute("SELECT origin FROM category_cache WHERE user_id=? AND libelle_cle=?",
                           (uid, cle)).fetchone()
        if cur and cur["origin"] == "manual" and origin != "manual":
            return
        conn.execute(
            "INSERT OR REPLACE INTO category_cache (user_id, libelle_cle, categorie, origin)"
            " VALUES (?,?,?,?)",
            (uid, cle, categorie, origin),
        )


def manual_examples(uid: int, limit: int = 12) -> list[dict]:
    """Dernières corrections manuelles avec libellé ET montant réels : exemples
    few-shot pour Ollama. Le montant aide à trancher les marchands ambigus
    (ex : petite somme chez Carrefour = courses, grosse somme = essence)."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT libelle, montant, categorie FROM transactions
               WHERE user_id=? AND categorized_by='manual'
               ORDER BY rowid DESC LIMIT ?""", (uid, limit))]


def cache_delete_manual(uid: int, cle: str):
    """Retire une association apprise manuellement (quand une confirmation est annulée)."""
    with get_db() as conn:
        conn.execute("DELETE FROM category_cache WHERE user_id=? AND libelle_cle=?"
                     " AND origin='manual'", (uid, cle))


def cache_examples(uid: int, limit: int = 12) -> list[tuple[str, str]]:
    """Dernières corrections manuelles (libellé réduit -> catégorie) : servent
    d'exemples few-shot à Ollama pour qu'il apprenne les habitudes du profil."""
    with get_db() as conn:
        rows = conn.execute(
            """SELECT libelle_cle, categorie FROM category_cache
               WHERE user_id=? AND origin='manual' ORDER BY rowid DESC LIMIT ?""",
            (uid, limit)).fetchall()
        return [(r["libelle_cle"], r["categorie"]) for r in rows]


# ----- catégories du profil (intégrées + personnalisées, renommables) -----
def _alpha(nom: str) -> str:
    """Clé de tri alphabétique insensible aux accents et à la casse
    (« Épargne » se range avec les E, pas après le Z)."""
    return unicodedata.normalize("NFD", nom).encode("ascii", "ignore").decode().casefold()


def list_categories(uid: int) -> list[dict]:
    """Catégories du profil, par ordre alphabétique (selects, listes, Ollama)."""
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT nom, description, builtin, position FROM user_categories"
            " WHERE user_id=?", (uid,))]
    return sorted(rows, key=lambda c: _alpha(c["nom"]))


def category_names(uid: int) -> list[str]:
    return [c["nom"] for c in list_categories(uid)]


def add_category(uid: int, nom: str, description: str = ""):
    with get_db() as conn:
        n = conn.execute("SELECT COUNT(*) c FROM user_categories WHERE user_id=? AND builtin=0",
                         (uid,)).fetchone()["c"]
        conn.execute("""INSERT OR IGNORE INTO user_categories
                        (user_id, nom, description, builtin, position) VALUES (?,?,?,0,?)""",
                     (uid, nom, description, 5000 + n))


def category_usage(uid: int, nom: str) -> int:
    with get_db() as conn:
        return conn.execute(
            "SELECT (SELECT COUNT(*) FROM transactions WHERE user_id=? AND categorie=?)"
            " + (SELECT COUNT(*) FROM budgets WHERE user_id=? AND categorie=?) AS c",
            (uid, nom, uid, nom)).fetchone()["c"]


def rename_category(uid: int, old: str, new: str):
    """Renomme partout : liste du profil, opérations, budgets, cache appris."""
    with get_db() as conn:
        conn.execute("UPDATE user_categories SET nom=? WHERE user_id=? AND nom=?",
                     (new, uid, old))
        conn.execute("UPDATE transactions SET categorie=? WHERE user_id=? AND categorie=?",
                     (new, uid, old))
        conn.execute("UPDATE budgets SET categorie=? WHERE user_id=? AND categorie=?",
                     (new, uid, old))
        conn.execute("UPDATE category_cache SET categorie=? WHERE user_id=? AND categorie=?",
                     (new, uid, old))


def set_category_description(uid: int, nom: str, description: str):
    with get_db() as conn:
        conn.execute("UPDATE user_categories SET description=? WHERE user_id=? AND nom=?",
                     (description, uid, nom))


def delete_category(uid: int, nom: str) -> int:
    """Supprime une catégorie si plus rien ne l'utilise.
    Renvoie le nb d'usages restants (opérations + budgets)."""
    used = category_usage(uid, nom)
    if used == 0:
        with get_db() as conn:
            conn.execute("DELETE FROM user_categories WHERE user_id=? AND nom=?", (uid, nom))
            conn.execute("DELETE FROM category_cache WHERE user_id=? AND categorie=?", (uid, nom))
    return used


# ----- actifs manuels -----
def list_assets(uid: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM manual_assets WHERE user_id=? ORDER BY type, nom", (uid,))]


def upsert_asset(uid: int, data: dict) -> int:
    now = dt.datetime.now().isoformat()
    src = data.get("source", "manuel")
    comm = data.get("commentaire", "") or ""
    with get_db() as conn:
        suivi = (data.get("prix_achat"), data.get("date_achat"),
                 data.get("pays", "") or "", data.get("croissance_pct"))
        if data.get("id"):
            conn.execute(
                """UPDATE manual_assets
                   SET type=?, nom=?, valeur=?, quantite=?, ticker=?, source=?,
                       commentaire=?, prix_achat=?, date_achat=?, pays=?,
                       croissance_pct=?, updated_at=?
                   WHERE id=? AND user_id=?""",
                (data["type"], data["nom"], data.get("valeur", 0), data.get("quantite"),
                 data.get("ticker"), src, comm, *suivi, now, data["id"], uid),
            )
            return data["id"]
        cur = conn.execute(
            """INSERT INTO manual_assets
               (user_id, type, nom, valeur, quantite, ticker, source, commentaire,
                prix_achat, date_achat, pays, croissance_pct, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uid, data["type"], data["nom"], data.get("valeur", 0), data.get("quantite"),
             data.get("ticker"), src, comm, *suivi, now),
        )
        return cur.lastrowid


def toggle_asset_mask(uid: int, asset_id: int) -> bool:
    """Inverse le masquage du montant d'un actif. Renvoie le nouvel état."""
    with get_db() as conn:
        conn.execute("UPDATE manual_assets SET masque = 1 - masque WHERE id=? AND user_id=?",
                     (asset_id, uid))
        row = conn.execute("SELECT masque FROM manual_assets WHERE id=? AND user_id=?",
                           (asset_id, uid)).fetchone()
        return bool(row and row["masque"])


def delete_asset(uid: int, asset_id: int):
    with get_db() as conn:
        conn.execute("DELETE FROM manual_assets WHERE id=? AND user_id=?", (asset_id, uid))
        conn.execute("DELETE FROM invest_routines WHERE asset_id=? AND user_id=?",
                     (asset_id, uid))


def update_asset_value(uid: int, asset_id: int, valeur: float):
    with get_db() as conn:
        conn.execute(
            "UPDATE manual_assets SET valeur=?, updated_at=? WHERE id=? AND user_id=?",
            (valeur, dt.datetime.now().isoformat(), asset_id, uid),
        )


def delete_assets_by_source(uid: int, source: str):
    """Supprime tous les actifs d'une source (avant resynchronisation)."""
    with get_db() as conn:
        conn.execute("DELETE FROM manual_assets WHERE user_id=? AND source=?", (uid, source))


# ----- routines d'investissement (achats récurrents type DCA) -----
def routine_list(uid: int) -> list[dict]:
    """Routines du profil, avec l'actif visé (nom, type, ticker)."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            """SELECT r.*, a.nom AS asset_nom, a.type AS asset_type, a.ticker
               FROM invest_routines r JOIN manual_assets a ON a.id = r.asset_id
                    AND a.user_id = r.user_id
               WHERE r.user_id=? ORDER BY r.prochain, r.id""", (uid,))]


def routine_add(uid: int, asset_id: int, montant: float, jour: int, prochain: str) -> int:
    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO invest_routines (user_id, asset_id, montant, jour,
                                            prochain, created_at) VALUES (?,?,?,?,?,?)""",
            (uid, asset_id, montant, jour, prochain, dt.datetime.now().isoformat()))
        return cur.lastrowid


def routine_delete(uid: int, rid: int):
    with get_db() as conn:
        conn.execute("DELETE FROM invest_routines WHERE id=? AND user_id=?", (rid, uid))


def routine_advance(uid: int, rid: int, prochain: str):
    with get_db() as conn:
        conn.execute("UPDATE invest_routines SET prochain=? WHERE id=? AND user_id=?",
                     (prochain, rid, uid))


def asset_buy(uid: int, asset_id: int, add_qty: float, add_cost: float):
    """Applique un achat sur l'actif : la quantité et le prix d'achat cumulé
    augmentent (le suivi de plus-value reste juste au fil des exécutions)."""
    with get_db() as conn:
        conn.execute(
            """UPDATE manual_assets
               SET quantite   = COALESCE(quantite, 0) + ?,
                   prix_achat = COALESCE(prix_achat, 0) + ?,
                   date_achat = COALESCE(date_achat, ?),
                   updated_at = ?
               WHERE id=? AND user_id=?""",
            (add_qty, add_cost, dt.date.today().isoformat(),
             dt.datetime.now().isoformat(), asset_id, uid))


# ----- types d'actifs personnalisés -----
def list_asset_types(uid: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT slug, label, couleur FROM asset_types WHERE user_id=? ORDER BY label", (uid,))]


def add_asset_type(uid: int, slug: str, label: str, couleur: str):
    with get_db() as conn:
        conn.execute("INSERT OR REPLACE INTO asset_types (user_id, slug, label, couleur)"
                     " VALUES (?,?,?,?)", (uid, slug, label, couleur))


def rename_asset_type(uid: int, slug: str, label: str):
    with get_db() as conn:
        conn.execute("UPDATE asset_types SET label=? WHERE user_id=? AND slug=?",
                     (label, uid, slug))


def delete_asset_type(uid: int, slug: str) -> int:
    """Supprime un type personnalisé s'il n'est plus utilisé. Renvoie le nb d'actifs qui l'utilisent."""
    with get_db() as conn:
        used = conn.execute("SELECT COUNT(*) c FROM manual_assets WHERE user_id=? AND type=?",
                            (uid, slug)).fetchone()["c"]
        if used == 0:
            conn.execute("DELETE FROM asset_types WHERE user_id=? AND slug=?", (uid, slug))
        return used


# ----- historique du patrimoine (relevés quotidiens) -----
def snapshot_save(uid: int, total: float):
    """Mémorise le patrimoine du jour (écrase le relevé du même jour :
    la dernière consultation de la journée fait foi)."""
    with get_db() as conn:
        conn.execute("INSERT OR REPLACE INTO snapshots (user_id, date, total) VALUES (?,?,?)",
                     (uid, dt.date.today().isoformat(), round(total, 2)))


def snapshot_list(uid: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT date, total FROM snapshots WHERE user_id=? ORDER BY date", (uid,))]


# ----- budgets mensuels -----
def budget_list(uid: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT categorie, montant FROM budgets WHERE user_id=? ORDER BY categorie", (uid,))]


def budget_set(uid: int, categorie: str, montant: float):
    with get_db() as conn:
        if montant and montant > 0:
            conn.execute("INSERT OR REPLACE INTO budgets (user_id, categorie, montant)"
                         " VALUES (?,?,?)", (uid, categorie, montant))
        else:
            conn.execute("DELETE FROM budgets WHERE user_id=? AND categorie=?", (uid, categorie))


# ----- évènements (vacances, fêtes… : dépenses d'une période) -----
def event_list(uid: int) -> list[dict]:
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM events WHERE user_id=? ORDER BY debut DESC", (uid,))]


def event_get(uid: int, eid: int) -> dict | None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM events WHERE id=? AND user_id=?",
                           (eid, uid)).fetchone()
        return dict(row) if row else None


def event_create(uid: int, nom: str, debut: str, fin: str) -> int:
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO events (user_id, nom, debut, fin, created_at) VALUES (?,?,?,?,?)",
            (uid, nom, debut, fin, dt.datetime.now().isoformat()))
        return cur.lastrowid


def event_update(uid: int, eid: int, nom: str, debut: str, fin: str):
    with get_db() as conn:
        conn.execute("UPDATE events SET nom=?, debut=?, fin=? WHERE id=? AND user_id=?",
                     (nom, debut, fin, eid, uid))


def event_delete(uid: int, eid: int):
    with get_db() as conn:
        conn.execute("DELETE FROM events WHERE id=? AND user_id=?", (eid, uid))
        conn.execute("DELETE FROM event_overrides WHERE event_id=? AND user_id=?",
                     (eid, uid))


def event_overrides(uid: int, eid: int) -> dict[str, int]:
    """{op_id: 1 (ajout manuel) | 0 (exclu)} pour un évènement."""
    with get_db() as conn:
        return {r["op_id"]: r["inclus"] for r in conn.execute(
            "SELECT op_id, inclus FROM event_overrides WHERE user_id=? AND event_id=?",
            (uid, eid))}


def event_override_set(uid: int, eid: int, op_id: str, inclus: int | None):
    """inclus=1 force l'ajout, 0 exclut, None revient à l'automatique (période)."""
    with get_db() as conn:
        if inclus is None:
            conn.execute("DELETE FROM event_overrides WHERE user_id=? AND event_id=?"
                         " AND op_id=?", (uid, eid, op_id))
        else:
            conn.execute("INSERT OR REPLACE INTO event_overrides"
                         " (user_id, event_id, op_id, inclus) VALUES (?,?,?,?)",
                         (uid, eid, op_id, inclus))


# ----- croissance visée par classe d'actif (%/an, par profil) -----
def class_growth_list(uid: int) -> dict[str, float]:
    """{slug de classe: %/an} — hérité par les actifs de la classe qui n'ont
    pas de croissance_pct propre (l'actif prime sur sa classe)."""
    with get_db() as conn:
        rows = conn.execute("SELECT cle, valeur FROM settings WHERE cle LIKE ?",
                            (f"croissance_type:{uid}:%",)).fetchall()
        return {r["cle"].split(":", 2)[2]: float(r["valeur"])
                for r in rows if r["valeur"]}


def class_growth_set(uid: int, slug: str, pct: float | None):
    cle = f"croissance_type:{uid}:{slug}"
    with get_db() as conn:
        if pct is None:
            conn.execute("DELETE FROM settings WHERE cle=?", (cle,))
        else:
            conn.execute("INSERT OR REPLACE INTO settings (cle, valeur) VALUES (?,?)",
                         (cle, str(pct)))


# ----- réglages (clé/valeur) -----
def setting_get(cle: str) -> str | None:
    with get_db() as conn:
        row = conn.execute("SELECT valeur FROM settings WHERE cle=?", (cle,)).fetchone()
        return row["valeur"] if row else None


def setting_set(cle: str, valeur: str):
    with get_db() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (cle, valeur) VALUES (?,?)",
                     (cle, valeur))
