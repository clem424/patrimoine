# Patrimoine — tableau de bord financier auto-hébergé

Agrège tes comptes (BoursoBank, Crédit Agricole), livrets, PEA, cryptos et coffrets
Pokémon dans une seule interface : patrimoine net, budget, catégorisation des dépenses,
détection d'abonnements et courbes d'évolution. Conçu pour tourner sur un Raspberry Pi,
avec **Ollama** en local pour classer les opérations mal/non catégorisées et **CoinGecko**
pour les cours crypto. Tes données ne quittent jamais ta machine.

**Multi-profils** : chaque membre de la famille se connecte avec son pseudo et son
mot de passe et ne voit que SES comptes, opérations, actifs, budgets et catégories.

## Profils

- La page de connexion propose **Créer un profil** : pseudo + mot de passe (haché
  scrypt côté serveur, sessions de 90 jours).
- ⚠️ **Le premier profil créé récupère automatiquement toutes les données importées
  avant l'arrivée des profils** (opérations, actifs, budgets, clés Binance…).
  Crée donc TON profil en premier, avant d'inviter la famille.
- Les données sont strictement séparées par profil, y compris les clés Binance et
  l'apprentissage de la catégorisation.
- Mot de passe modifiable dans **Réglages** (déconnecte toutes les sessions du profil).

## Pile technique

| Couche       | Choix                                   |
|--------------|-----------------------------------------|
| Backend      | Python · FastAPI · SQLite (un fichier)  |
| Frontend     | React · Vite · Recharts                 |
| Catégorisation | Règles → cache → Ollama (local)       |
| Cours crypto | API CoinGecko (gratuite, sans clé)      |

## Arborescence

```
patrimoine/
├── backend/
│   ├── main.py          API FastAPI (sert aussi le frontend compilé)
│   ├── auth.py          profils : mots de passe scrypt + sessions par jeton
│   ├── parsers.py       BoursoBank (CSV) + Crédit Agricole (XLSX) → schéma commun
│   ├── db.py            SQLite : profils, transactions, actifs, catégories (par profil)
│   ├── categorize.py    moteur règles + cache + Ollama (sortie structurée, few-shot)
│   ├── crypto.py        cours & recherche CoinGecko
│   ├── stocks.py        cours actions/ETF via Yahoo Finance (PEA)
│   ├── binance.py       synchronisation des avoirs spot Binance (lecture seule)
│   ├── analytics.py     calculs du dashboard (patrimoine, flux, courbes…)
│   └── requirements.txt
├── frontend/            React + Vite (Connexion, Dashboard, Patrimoine, Opérations,
│                        Import, Réglages)
├── Dockerfile           build multi-étapes (Node compile le front, Python l'exécute)
├── docker-compose.yml   lancement sur le Pi (host network + volume pour la base)
├── start.sh             alternative sans Docker
└── README.md
```

## Installation sur le Raspberry Pi (Docker — recommandé)

Seul prérequis : **Docker** + **Docker Compose** sur le Pi, et **Ollama** déjà installé
sur le Pi (hors conteneur). Pas besoin de Python ni de Node : tout est construit dans
l'image.

```bash
# Modèle Ollama, une seule fois (léger, adapté au Pi)
ollama pull qwen2.5:3b        # ou un modèle déjà présent : `ollama list`

# Build + lancement
docker compose up -d --build
```

L'app est alors servie sur **http://&lt;ip-du-pi&gt;:8000**.

- La base SQLite est persistée dans `./data` (survit aux redémarrages et aux rebuilds).
- Le conteneur tourne en `network_mode: host` : il joint Ollama sur `localhost:11434`
  sans réglage, et l'app écoute directement sur le port 8000 du Pi.
- Mettre à jour après modification : `docker compose up -d --build`.
- Voir les logs : `docker compose logs -f`.

Adapte le modèle dans `docker-compose.yml` (`OLLAMA_MODEL`) à ce que renvoie `ollama list`.

### Si ton Ollama tourne lui aussi dans un conteneur

Vérifie d'abord s'il publie son port sur le Pi :

```bash
docker port <conteneur-ollama>     # nom visible via `docker ps`
```

- **Port publié** (`11434/tcp -> 0.0.0.0:11434`) : la config par défaut (`network_mode: host`
  + `localhost:11434`) marche telle quelle.
- **Rien d'affiché** : Ollama n'est joignable que dans Docker. Soit tu publies son port
  (`ports: ["11434:11434"]` dans son compose), soit tu fais dialoguer les deux conteneurs
  par leur nom sur un réseau partagé — la variante est fournie en bloc commenté dans
  `docker-compose.yml`. Attention : la résolution par nom de conteneur ne fonctionne que
  sur un réseau Docker défini par l'utilisateur, pas sur le bridge par défaut.

> Note : utilise une image **Raspberry Pi OS 64-bit**. En 64-bit, `pip` télécharge des
> binaires pandas/numpy prêts à l'emploi (build rapide). En 32-bit, la compilation est
> longue et fragile.

## Installation manuelle (sans Docker)

Prérequis : Python 3.10+, Node 18+, Ollama.

```bash
chmod +x start.sh
./start.sh
```

`start.sh` installe les dépendances Python, compile le frontend la première fois,
puis démarre le serveur sur le port 8000.

### Lancement manuel (dev)

```bash
# backend
cd backend && pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# frontend (autre terminal) — rechargement à chaud, proxy /api vers :8000
cd frontend && npm install && npm run dev
```

## Utilisation

0. **Se connecter** : crée ton profil à la première visite (le premier profil créé
   hérite des données déjà en base). Chaque membre de la famille a le sien.
1. **Importer** : dépose tes exports BoursoBank (`.csv`) ou Crédit Agricole (`.xlsx`).
   Le format est détecté automatiquement, les doublons ignorés (ré-import sans risque),
   et le solde de chaque compte courant est mis à jour tout seul.
2. **Patrimoine** : ajoute Livret A, Livret Jeune, PEA (valeur saisie), tes cryptos
   (recherche CoinGecko + quantité → valeur € calculée) et tes coffrets Pokémon.
   La **pyramide patrimoniale** en haut de page répartit tes actifs sur 4 étages
   (sécurité → croissance → diversification → optimisation) avec montants et %.
3. **Budget** : fixe un plafond mensuel par catégorie et suis-le mois par mois
   (barres de progression, dépassements en rouge, navigation ‹ › entre les mois).
4. **Opérations** : filtre, recatégorise à la main, ou clique **Catégoriser
   automatiquement** pour lancer le moteur (règles instantanées, Ollama pour le reste).
5. **Tableau de bord** : patrimoine net, répartition, courbe de solde, flux mensuels,
   dépenses par catégorie (semaine / mois / année / toujours, navigable), abonnements
   détectés, suivi du budget du mois.

Autres possibilités :
- **Masquer les montants** : l'œil en bas de la barre latérale masque tous les montants
  de l'app (persistant) ; l'œil en face d'un actif masque ce montant individuellement.
- **Types d'actifs personnalisés** : bouton « + Type » dans le formulaire d'ajout
  (ex : Immobilier, Montres…) — couleur attribuée automatiquement, supprimable tant
  qu'aucun actif ne l'utilise.
- **Commentaire par actif** : champ libre (ex : « à réévaluer en fin d'année »),
  affiché sous le nom dans la liste.

## Réglages

- **Modèle Ollama** : `OLLAMA_MODEL` dans `docker-compose.yml` (défaut `qwen2.5:3b`,
  bon compromis qualité/RAM sur un Pi 8 Go). Le modèle doit être présent :
  `docker exec ollama ollama pull qwen2.5:3b`. Pour de meilleurs résultats si tu as
  la RAM : `qwen2.5:7b` ; plus rapide mais moins bon : `llama3.2:1b`.
- **Règles de catégorisation** : dictionnaire `RULES` dans `backend/categorize.py` —
  ajoute tes marchands fréquents pour éviter d'appeler le modèle. L'ordre compte
  (première règle qui matche).
- **Page Réglages** (barre latérale) : ajoute/renomme/supprime les catégories
  d'opérations (le renommage met à jour opérations, budgets et apprentissage),
  les types d'actifs et les noms d'actifs ; changement de mot de passe du profil.
- **Fiabilité d'Ollama** : la réponse du modèle est contrainte par un schéma JSON
  (enum des catégories) — il ne peut littéralement pas répondre hors liste ; tes
  corrections manuelles récentes lui sont resservies comme exemples (few-shot) ;
  et la **description** de chaque catégorie (éditable dans Réglages) guide ses
  choix : mets-y des mots-clés et noms de marchands. Corriger une opération à la
  main apprend le libellé au cache : les prochaines opérations du même marchand
  suivront sans appel au modèle.

## Cours en direct & connexions

- **Cryptos (manuel)** : cherche la crypto (CoinGecko), saisis la quantité → valeur € recalculée au bouton « Rafraîchir les cours ».
- **PEA (titres cotés)** : type « PEA », cherche l'action/ETF (Yahoo Finance, ex `AI.PA`, `CW8.PA`), saisis la quantité → valorisation automatique (prix hors EUR convertis). Tu peux aussi saisir une valeur fixe (liquidités du PEA).
- **Binance (lecture seule)** : crée une clé API Binance avec la **seule** permission « Read Info » (aucun retrait, aucun trade). Saisis-la **directement dans l'onglet Patrimoine** (ou via `docker-compose.yml`), puis clique « Synchroniser Binance ». Tes avoirs spot sont importés et valorisés en EUR (source = binance, resynchronisés à chaque clic).
- **Ledger / cold wallet** : saisis tes cryptos à la main (type Cryptomonnaie → recherche CoinGecko + quantité) ; les cours sont récupérés en direct comme le reste.

Les exports Crédit Agricole qui contiennent **plusieurs comptes dans un seul fichier**
(compte de dépôt + Livret A + Livret Jeune…) sont désormais gérés : chaque compte est
créé/actualisé automatiquement à l'import.

## Notes honnêtes / limites

- Les cours PEA passent par Yahoo Finance (API non officielle mais stable en pratique) ;
  si un symbole ne remonte pas, vérifie le suffixe de place (`.PA` Paris, `.AS` Amsterdam…).

- La **courbe de patrimoine** est reconstruite à partir du solde actuel et des flux
  importés : elle couvre la période de tes exports, pas avant.
- La **détection d'abonnements** est heuristique (même libellé, montant stable, ≥3 fois) :
  elle peut confondre un achat très régulier avec un abonnement. Vérifie la liste.
- La **valeur des coffrets Pokémon** est saisie à la main (actif illiquide, pas de cote
  automatique fiable) — réévalue-la quand tu veux.
- Les **formats bancaires** peuvent évoluer : si un export ne se lit plus, les parseurs
  sont isolés dans `parsers.py` et faciles à ajuster.

## Validé

Les parseurs et tous les calculs du dashboard ont été testés sur de vrais exports
BoursoBank et Crédit Agricole : 210 opérations importées, dédoublonnage à 100 % au
ré-import, catégorisation par règles seules sur la majorité des opérations.

## Licence

Code sous licence [MIT](LICENSE).

Les polices embarquées dans `frontend/public/fonts/` — [Inter](https://github.com/rsms/inter),
[Fraunces](https://github.com/undercasetype/Fraunces) et
[Spline Sans Mono](https://github.com/SorkinType/SplineSansMono) — sont distribuées sous
[SIL Open Font License 1.1](https://openfontlicense.org/).

Ce projet n'est affilié à aucune des banques ou services mentionnés (BoursoBank,
Crédit Agricole, Binance, CoinGecko, Yahoo Finance). Utilise-le avec tes propres
exports et à tes risques : ce n'est pas un outil de conseil financier.
