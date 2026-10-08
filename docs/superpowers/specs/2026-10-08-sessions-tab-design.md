# Onglet « Sessions » : ce qui bosse, sur le PC et le VPS

Date : 2026-10-08 · base `4a75652` · statut : validé en conversation, à relire

## But

Voir **en direct ce qui bosse**, partout : les sessions Claude Code qui travaillent ou attendent
une réponse, sur le PC (`Rocinante`) et sur le VPS (alias SSH `factory`), avec leurs sous-agents
en cours. La barre de gauche du desktop ne le montre pas : ni les sous-agents, ni les sessions
CLI et workers, ni les deux machines ensemble.

**Critère de réussite** : depuis n'importe quelle session (PC ou VPS) qui charge `focus-pane`,
l'onglet « Sessions » liste en moins de ~5 s toute session `busy` ou `waiting` des deux machines,
et sous chacune ses sous-agents en cours.

**Hors périmètre** : basculer le desktop sur une session (aucune API pour piloter l'app), coût et
contexte par session, filtres et tris personnalisables, plus de deux machines.

## 1. Ce qu'on voit

- Un onglet du dock **« Sessions »** (pane d'id `sessions`), à côté de « Focus », comme
  « Maquettes ». Il s'ouvre par `/mission sessions` et par un bouton `s` dans la légende de Focus.
- **Un bloc par machine**, la machine courante d'abord. Titre : `<libellé> · N bossent · M attendent`
  (les morceaux à zéro sont omis), suivi de ` · synchro en retard (42 s)` quand l'instantané de
  cette machine a plus de 15 s. Un bloc sans session montre une ligne `rien ne tourne`. Aucun
  instantané d'une autre machine : une ligne `autre machine jamais synchronisée (install.sh --sync <alias>)`.
  Instantané de sa propre machine impossible : une ligne `instantané indisponible (python3 ?)`.
- Dans un bloc : les sessions **en attente** d'abord (`⏸`, couleur d'alerte `tone.bad`), puis
  celles qui **bossent** (`●`), chaque groupe trié de la plus récente à la plus ancienne
  (`statusUpdatedAt` décroissant). Les sessions au repos sont masquées.
- **Une ligne par session** : icône, nom, projet (dernier segment du `cwd`), origine
  (`desktop` | `cli` | `worker`), durée dans l'état actuel (`clock(now - statusUpdatedAt)`). La
  session courante porte `(ici)` après son nom.
- **Sous chaque session**, en retrait de deux cellules, une ligne par **sous-agent en cours** :
  titre, palier, modèle, durée, au format de la ligne repliée d'AGENTS. Rien sous une session sans
  battement (worker sans le mod).
- Une ligne = une rangée ; l'onglet défile quand il déborde (pas d'ajustement en hauteur).

## 2. Les données

### 2.1 Le registre du moteur (existant, lu tel quel)

`~/.claude/sessions/<pid>.json`, un fichier par process claude, écrit par le moteur. Champs lus :
`pid`, `sessionId`, `name`, `cwd`, `status` (`busy` | `waiting` | `idle`), `statusUpdatedAt`
(ms), `entrypoint`, `kind`. Le dossier garde des fichiers de process morts : un process est vivant
si `/proc/<pid>` existe.

Origine affichée : `entrypoint === 'claude-desktop'` → `desktop` ; `entrypoint === 'cli'` → `cli` ;
tout le reste (`sdk-cli`, …) → `worker`.

### 2.2 Le battement publié par `focus-pane` (nouveau)

Chaque session qui charge le mod écrit `$HOME/.cache/focus-pane/live/<sessionId>.json`
(`HOME` par `$.env.get("HOME")`, `sessionId` par `$.session.id()`) :

```json
{
  "v": 1,
  "sessionId": "…",
  "updatedAt": 1791450000000,
  "main": { "model": "claude-opus-5-5", "effort": "high", "isRunning": true },
  "agents": [{ "id": "…", "title": "…", "model": "…", "effort": "medium", "startedAt": 1791449990000 }]
}
```

- `agents` ne contient que les sous-agents `running` de l'atome `agents`.
- Réécrit à chaque changement réel de `main` ou de la liste des agents en cours, et toutes les
  15 s par un `$.clock.every` lancé à `session.start` (preuve de vie). Une écriture qui échoue est
  ignorée : le battement ne gêne jamais la session.
- Pas d'effacement en fin de session (`$.fs` ne sait pas effacer) : le script d'instantané purge
  les battements de plus de 10 min, et un process mort n'est de toute façon plus listé.

### 2.3 Ce qui « bosse »

Une session vivante est listée si `status` vaut `busy` ou `waiting`, **ou** si son battement frais
contient au moins un sous-agent (agents en arrière-plan d'une session au repos). Un battement est
frais s'il a moins de 60 s ; un battement périmé est ignoré, et supprimé par le script d'instantané
s'il a plus de 10 min.

## 3. L'instantané et la synchro

### 3.1 `scripts/live_snapshot.py` (nouveau, Python 3 standard, sans dépendance)

`python3 live_snapshot.py [--label LIBELLÉ]` écrit sur stdout l'instantané JSON de sa machine :

```json
{ "v": 1, "host": "<hostname>", "label": "VPS", "takenAt": 1791450000000,
  "sessions": [{ "sessionId": "…", "pid": 1, "name": "…", "cwd": "…", "origin": "desktop",
                 "status": "busy", "statusUpdatedAt": 0, "main": {…} | null, "agents": […] }] }
```

- `sessions` = les seules sessions listées au sens du §2.3, enrichies de leur battement frais
  (`main`, `agents`) ou de `null` / `[]` sans battement.
- Libellé : `--label`, sinon le contenu de `~/.cache/focus-pane/label`, sinon le hostname.
- Un fichier illisible ou mal formé est sauté, jamais fatal. Code de sortie 0 dès que le JSON est
  produit.

### 3.2 `scripts/live-sync.sh` et le service `focus-pane-sync` (PC seulement)

- `scripts/live-sync.sh <alias-ssh>` boucle toutes les 3 s :
  1. instantané local → `~/.cache/focus-pane/hosts/<hostname-local>.json` ;
  2. `ssh <alias> 'python3 ~/.claude/mods/focus-pane/scripts/live_snapshot.py --label VPS'` →
     `~/.cache/focus-pane/hosts/<alias>.json` ;
  3. dépôt de l'instantané local sur le VPS dans `~/.cache/focus-pane/hosts/<hostname-local>.json`.

  Chaque fichier est écrit en `.tmp` puis `mv` (lecture jamais à moitié écrite). Une seule
  connexion SSH (`ControlMaster=auto`, `ControlPersist=60`, `BatchMode=yes`,
  `ConnectTimeout=5`) ; un échec d'une étape n'arrête pas la boucle.
- Libellés : le service écrit `PC` dans `~/.cache/focus-pane/label` localement et `VPS` sur le VPS
  (via la même connexion), une fois au démarrage.
- `install.sh --sync <alias>` installe et démarre `~/.config/systemd/user/focus-pane-sync.service`
  (`Restart=always`, `RestartSec=5`). Sans `--sync`, `install.sh` ne change pas de comportement.
- La synchro ne lit et n'écrit que dans `~/.cache/focus-pane` des deux machines, et n'exécute sur
  le VPS que `live_snapshot.py` et ces écritures.

### 3.3 Ce que lit l'onglet

Tant que l'onglet est ouvert, toutes les 3 s (`$.clock.every`, annulé à la fermeture) :

- **Sa machine** : `$.process.run(['python3', '<plugin root>/scripts/live_snapshot.py'])`, une
  seule logique pour les deux machines.
- **Les autres** : chaque `~/.cache/focus-pane/hosts/*.json` dont `host` diffère du sien.
- Les instantanés bruts vont dans un atome `$.state` `sessionsView` (déclaré au contrat
  `types/index.d.ts`) ; les âges et les durées se calculent au dessin. L'écriture toutes les 3 s
  n'a lieu que tant que l'onglet est ouvert (les durées affichées avancent de toute façon).
- Âge d'un instantané distant : `now - takenAt`. Plus de 15 s : « synchro en retard ».

## 4. Pannes

| Situation | Effet |
|---|---|
| VPS injoignable | le PC garde le dernier `hosts/factory.json` ; le bloc VPS dit « synchro en retard » |
| Service arrêté / jamais installé | le bloc distant dit « jamais synchronisé » ou « en retard » |
| `python3` absent | `install.sh` le signale ; l'onglet affiche « instantané indisponible » pour sa machine |
| Battement impossible à écrire | ignoré, la session continue ; elle apparaît sans sous-agents |
| Fichier JSON corrompu | sauté par le script et par l'onglet |

## 5. Tests

- **Mod** (`hooks/focus-pane.test.ts`, kit `claude-code/testing`) :
  - le battement est écrit au lancement et à la fin d'un sous-agent, au début et à la fin d'un
    tour, avec le contenu du §2.2 ; pas de réécriture sans changement ;
  - le rendu de l'onglet à partir d'instantanés factices (`$.process.run` et `$.fs` mockés) :
    ordre attente puis travail, sous-agents en retrait, `(ici)`, origine, « synchro en retard »,
    « rien ne tourne » ; sur `terminal` et `desktop` ;
  - `/mission sessions` ouvre l'onglet ; `s` dans Focus aussi.
- **Script** (`scripts/test_live_snapshot.py`, `python3 -m unittest`) : registre factice dans un
  dossier temporaire (HOME surchargé, racine `/proc` injectable), process mort ignoré, `idle` sans
  agents exclu, `idle` avec agents inclus, battement périmé ignoré puis supprimé après 10 min,
  fichier corrompu sauté, libellé.
- **Synchro** : vérifiée une fois en vrai entre le PC et `factory` (les deux fichiers `hosts/`
  apparaissent et se rafraîchissent ; VPS coupé → retard affiché).

## 6. Hypothèses à vérifier en premier, et déploiement

- ✅ Vérifié le 2026-10-08 : `$.session.id()` renvoie « le nom du fichier de transcript », qui est
  le `sessionId` du registre (session `08287e83…` : registre `1005469.json`, transcript
  `08287e83….jsonl`), et non le `hostSessionId` du desktop (`local_…`).
- Le VPS exécute **sa** copie du script : après chaque merge, `git pull` dans
  `~/.claude/mods/focus-pane` sur `factory` (comme pour les commits précédents).

## 7. Gates

```sh
claude plugin validate .
bunx --package typescript tsc -p .
claude plugin test .                       # baseline 101 pass, 0 fail
python3 -m unittest discover -s scripts -p 'test_*.py'
```
