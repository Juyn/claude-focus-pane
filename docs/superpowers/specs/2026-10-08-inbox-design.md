# Inbox : déposer un fichier sur le PC, le retrouver dans la session

Date : 2026-10-08 · base `ac0688e` · statut : validé en conversation, à relire

## But

Envoyer n'importe quel fichier (pas seulement des images) depuis le PC (`Rocinante`) vers le VPS
(alias SSH `factory`), où tournent la plupart des sessions, et le faire entrer dans la conversation
en un geste. Le composer du desktop en Remote Control n'accepte que des images ; un mod ne peut
pas recevoir de fichier glissé (aucun élément d'UI ne prend de fichier).

**Critère de réussite** : un fichier glissé dans `~/inbox` du PC apparaît en moins de ~10 s dans
le bandeau des sessions du VPS, et un appui sur `i` met son chemin dans le prompt de la session
courante.

**Hors périmètre** : envoi du VPS vers le PC (le favori Nautilus sert à aller chercher), barre de
progression, suppression depuis l'onglet, dossiers (seuls les fichiers comptent), plus de deux
machines.

## 1. Ce qu'on fait et ce qu'on voit

- **PC** : un dossier `~/inbox`, épinglé dans Nautilus sous le nom « Vers VPS ». On y glisse un
  fichier depuis n'importe quelle application.
- **Nautilus** : un favori `sftp://factory/home/ubuntu/inbox` (« Inbox VPS ») pour parcourir,
  récupérer ou ranger directement sur le VPS.
- **Bandeau** au-dessus du prompt, dans chaque session (PC et VPS) qui charge `focus-pane`, pour
  chaque fichier arrivé depuis moins de 10 min et pris par personne :
  `📥 rapport.pdf (2,3 Mo) — [i] insérer · [x] ignorer`.
  - `i` insère `@<chemin absolu> ` au curseur du prompt (`$.prompt.fill`, mode `insert`) et
    marque le fichier « pris » par cette session : le bandeau disparaît de toutes les sessions.
  - `x` le retire du bandeau de cette session seulement (il reste dans l'onglet).
  - Plusieurs fichiers en attente : le plus récent dans le bandeau, suivi de `+N`.
  - Le bandeau s'ajoute à ce que les autres mods dessinent au-dessus du prompt (il enveloppe le
    dessin de `next(e)`), il ne le remplace pas.
- **Onglet « Drops »** du dock (pane d'id `drops`), comme « Sessions » : ouvert par `/inbox`, par
  `/mission drops`, et par la touche `d` dans Focus. Les 20 fichiers les plus récents de
  `~/inbox`, du plus récent au plus ancien ; une rangée : nom, taille, âge, puis
  `pris par <nom de session>` ou rien ; boutons `insérer` et `copier le chemin`.
  - **Les 5 plus récents sont mis en évidence** (nom en gras, couleur d'accent `tone.mark`) ; les
    suivants en style discret.
  - `copier le chemin` : `$.ui.copy({ text: chemin, surface })` ; si le presse-papiers n'est pas
    joignable (`isCopied: false`, attendu sur une surface distante), un toast affiche le chemin
    complet pour le copier à la main.
  - `~/inbox` vide ou absent : une ligne `aucun fichier reçu — glisse-en un dans ~/inbox du PC`.

## 2. Les données

- Chaque session lit `$HOME/inbox` (`$.fs.list`) toutes les 3 s, dès `session.start`, pour le
  bandeau ; l'onglet ouvert relit au même rythme. Fichiers cachés (`.…`) et dossiers ignorés ;
  `FsEntry` donne `name`, `size`, `mtimeMs`.
- **Arrivé** : un fichier dont `size` et `mtimeMs` n'ont pas changé entre deux lectures
  consécutives de cette session (jamais un fichier en cours de copie). Son heure d'arrivée est
  son `mtimeMs` : sur le VPS, l'heure du transfert (cf. §3) ; sur le PC, la date que la copie a
  laissée (le bandeau d'une session du PC peut donc ignorer un vieux fichier : l'onglet le liste).
- **Pris** : `$HOME/.cache/focus-pane/inbox-taken.json`, objet `{ "<nom de fichier>": {
  "sessionId", "name", "at" } }` — `name` est le nom de la session dans le registre du moteur
  (`~/.claude/sessions/*.json`, entrée de même `sessionId`), à défaut le dernier dossier de son cwd. Écrit par la session qui insère (lecture, ajout, écriture
  entière) ; lu par toutes à chaque tour. Un fichier corrompu vaut `{}`.
- **Ignoré** : en mémoire de la session (un `x` ne survit pas à un rechargement du mod — sans
  gravité).

## 3. La synchro PC → VPS

- Une étape de plus dans la boucle de `scripts/live-sync.sh` (service `focus-pane-sync`, déjà
  installé), à chaque tour, si `~/inbox` existe sur le PC :
  `rsync -rl --ignore-existing --partial-dir=.rsync-partial --exclude='.*' --timeout=30 -e "ssh <options de la synchro>" ~/inbox/ <alias>:inbox/`.
  Même connexion persistante (ControlPath), mêmes options (pas de transfert d'agent).
- **Pas de `-a` ni `-t`** : la date d'un fichier sur le VPS est son **heure d'arrivée** (un PDF
  vieux d'un an glissé maintenant est « arrivé maintenant »). `--ignore-existing` : un fichier déjà
  présent sur le VPS n'est jamais renvoyé (pour renvoyer une version modifiée, la renommer).
- **Jamais de suppression** côté VPS (`--delete` interdit) : effacer sur le PC n'efface pas là-bas.
- `rsync` écrit dans un fichier temporaire caché puis renomme : aucun fichier tronqué visible
  (et les noms `.…` sont ignorés par le mod).
- Un échec (réseau, VPS injoignable) n'arrête pas la boucle ; le fichier part au tour suivant.
- `install.sh --sync <alias>` crée `~/inbox` sur le PC s'il manque, et ajoute les deux favoris
  Nautilus dans `~/.config/gtk-3.0/bookmarks` s'ils n'y sont pas (`file://$HOME/inbox Vers VPS`,
  `sftp://<alias>/home/ubuntu/inbox Inbox VPS` — le chemin distant lu par
  `ssh <alias> 'echo $HOME'`). Idempotent.

## 4. Pannes et limites

| Situation | Effet |
|---|---|
| VPS injoignable | le fichier reste sur le PC et part au retour du réseau |
| `$.prompt.fill` refusé (`isFilled: false`) | toast « insertion impossible ici » + le chemin, à copier |
| Presse-papiers distant indisponible | toast avec le chemin complet |
| `inbox-taken.json` illisible | traité comme vide ; réécrit à la prochaine prise |
| Un autre mod tient le bandeau au-dessus du prompt (ex. Fables sur desktop) | le bandeau peut être masqué ; l'onglet Drops reste disponible |

## 5. Tests

- **Mod** : logique pure dans `hooks/inbox.ts` (sélection des fichiers arrivés, stables, non pris,
  ordre, mise en évidence des 5 premiers, format de taille et d'âge, lecture tolérante de
  `inbox-taken.json`) + tests du bandeau (apparition après deux lectures stables, `i` insère et
  marque pris, `x` cache, disparition après 10 min, `+N`) et de l'onglet (ordre, 5 en évidence,
  `pris par`, copier → `ui.copy` puis toast si refusé, `/inbox`, `d`), sur `terminal` et
  `desktop`.
- **Synchro** : vérification statique (`bash -n`, `sh -n`), puis recette réelle après accord :
  un fichier glissé dans `~/inbox` du PC arrive sur le VPS et dans le bandeau d'une session SSH.

## 6. Vérifié le 2026-10-08 (sonde jetable, session desktop locale)

- `$.prompt.fill({ text, mode: 'insert' })` depuis l'appui d'un bouton d'un pane : `{ isFilled: true }`,
  le texte est bien arrivé dans le prompt affiché (surface `desktop`).
- `$.ui.copy({ text, surface: press.surface })` : `{ isCopied: true }` sur `desktop`, malgré la note
  de la doc (« a remote surface has no path yet »). Les replis par toast du §4 restent, pour les
  surfaces où ce ne serait pas le cas.
- Réserve : testé dans une session desktop locale ; une session SSH passe par la même surface
  `desktop`, la recette finale le confirme sur `factory`.

## 7. Gates

```sh
claude plugin validate .
bunx --package typescript tsc -p .
claude plugin test .                       # baseline 131 pass, 0 fail
python3 -m unittest discover -s scripts -p 'test_*.py'   # baseline 12 OK
bash -n scripts/live-sync.sh && sh -n install.sh
```
