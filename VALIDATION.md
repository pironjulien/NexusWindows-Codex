# Validation Computer Use Windows

## Banc réel corrigé 1.4.0 — 16 octobre 2026

**108 tests JavaScript (103 réussis, 5 réels sautés hors `-Full`), 28 Pester, 21 Python ; `test.ps1` et `test.ps1 -Full` code 0** (14 tests réels jeton/arrêt d'urgence, validation réelle 14 sous-tests réussis, le repli qui prend le premier plan « sauté » : Julien actif).

Défauts du banc du 16/10 reproduits avant correction (formulaires du banc compilés en .NET Framework, session et helper réels, faux Sky sans entrée physique) : liste WPF ouverte suivie comme une fenêtre (arbre de la surgissante seul, puis « found 0 » sur la liste déroulante) ; option WPF non prouvable liste refermée ; arbre lu en 145–306 ms ; 483–501 ms par champ WinForms, 356–505 ms par champ WPF. Mesuré pendant la correction : le sous-arbre UIA d'une liste WinForms ouverte répond « Malformed Cacheresponse » après ~7 s puis ne répond plus (lu désormais par messages) ; une liste Win32 servie par le proxy natif a des éléments sans FrameworkId (désormais hérité du parent, sinon UIA Select silencieux).

Validation réelle (`tests/live`), fenêtres créées par le test, sans activation, au fond de l'empilement, premier plan échantillonné toutes les 20 ms (0 échantillon sur une fenêtre de test, 250 à 310 par passage), aucune entrée physique, curseur immobile quand Julien n'a rien touché :

| Scénario | Résultat dans l'application | Durée |
| --- | --- | --- |
| Banc WinForms hébergé par `powershell.exe` : 3 champs, case, Expand (`expanded` relu), clic « Bravo » dans la liste ouverte, Valider | `Formule=Bravo;Envois=1`, liste refermée, aucune surgissante | 1,0–1,3 s le lot de 7 étapes ; champ 110–170 ms |
| Banc WPF hébergé par `powershell.exe` : idem, précédé d'un `select` direct (Alpha) | `Formule=Bravo;Envois=1`, liste refermée, fenêtre principale gardée | 1,8–2,4 s le lot de 8 étapes ; champ 175–245 ms |
| Postcondition « le bouton existe » puis condition précise déjà vraie | refusée avant entrée ; `already-satisfied` ; toujours `Envois=1` | — |
| Listes déroulantes .NET 8 WinForms et Win32 : ouverture, choix dans la liste ouverte | événement compté une fois, liste relue fermée | ouverture ~290 ms, choix 80–130 ms |
| Fausse console (classe `ConsoleWindowClass`) dans le processus `powershell.exe` du formulaire | refusée (inventaire, lecture, action) ; le formulaire du même processus est permis | — |
| Fixture 1.3.0 (Win32, WinForms, WPF .NET 8) | toutes les postconditions et compteurs applicatifs | 75–190 ms par action (105–441 ms en 1.3.0) |

Observation native : 50–70 ms (arbre COM en un aller-retour, 45–60 ms) contre 145–306 ms. Les durées varient avec la charge du poste (Julien travaillait). Les entrées physiques Sky ne sont pas testables hors du REPL Codex.
## Arrière-plan d'abord 1.3.0 — 15 octobre 2026

**100 tests JavaScript (95 réussis, 5 réels sautés hors `-Full`), 28 Pester, 21 Python ; `test.ps1` code 0.** `test.ps1 -Full` : 14 tests réels jeton/arrêt d'urgence et la validation réelle `tests/live/background.live.mjs`, code 0.

Validation réelle sur la fixture du test (WinForms, Win32 natif, WPF .NET 8), fenêtres affichées sans activation au fond de l'empilement, la Win32 recouverte par la WinForms. Chaque action : postcondition vérifiée, événement compté par l'application, premier plan inchangé, curseur immobile.

| Action | Technique | Durée (entrée + relectures) |
| --- | --- | --- |
| Win32 bouton, case, saisie, ajout au curseur, liste déroulante, liste, menu | `BN_CLICKED`, `BM_SETCHECK+BN_CLICKED`, `EM_REPLACESEL`, `CB_SETCURSEL`, `LB_SETCURSEL`, `WM_COMMAND` | 105–159 ms |
| WinForms saisie, liste déroulante, liste | messages | 292–338 ms |
| WinForms case, bouton, dialogue ouvert puis fermé (suivi automatique) | UIA COM Toggle / Invoke | 205–441 ms |
| WPF bouton, case, valeur | UIA COM Invoke / Toggle / Value | 193–241 ms |
| Lot de 3 étapes, arrêt à l'étape 2 (3e jamais envoyée) | messages | 658 ms |
| Capture de la fenêtre Win32 recouverte | PrintWindow, non vide | 19 ms |

Avant correction, la même validation a échoué : Toggle/Invoke COM depuis le helper qui avait lu l'arbre par `System.Windows.Automation` activaient la fenêtre WinForms ou WPF. Reproduit hors helper (C# : vol dès que le client géré a servi ; comtypes ou C# COM pur : aucun vol), corrigé par le processus enfant `--com-worker`. Le repli qui prend le premier plan (UIA sous jeton) a été « sauté » : Julien était actif (moins de 120 s d'inactivité) ; il n'est pas compté réussi. Les entrées physiques Sky ne sont pas testables hors du REPL Codex ; leur orchestration (pause, jeton, tranches, interruption) est couverte par les tests hors ligne. Durées dominées par les relectures complètes de l'arbre UIA géré.
## Recontrôle 1.1.1 — 12 octobre 2026

Revue des quatre modules JavaScript, du helper C#, du protocole, des recettes, de l'installateur, du skill et des tests. **59 tests JavaScript et 39 tests Pester réussis**, compilation .NET et contrôle de l'installation réussis. Treize nouvelles régressions échouaient avant correction ; deux autres tests vérifient le nettoyage après échec de publication et l'exclusion des écritures de recettes concurrentes. Les cinq nouveaux tests Pester couvrent les artefacts natifs et le verrou d'installation.

Défauts corrigés : paramètres étrangers à une action acceptés (dont contournement du focus et remplacement de fenêtre par les coordonnées), fausse absence déduite d'une capture sans arbre, rafraîchissement image pris pour une preuve sémantique, alias de touche Windows non refusés, préfixe tronqué pris pour une valeur exacte, réponses natives doublées/parasites acceptées trop tôt, métadonnées de recettes invalides acceptées. L'installateur exige désormais tous les fichiers nécessaires au runtime .NET et sérialise ses exécutions.

Essai réel depuis un Node REPL neuf, avec le skill installé et la fixture WPF compilée dans LocalAppData :

| Opération | Résultat applicatif | Durée entrée et relecture |
| --- | --- | --- |
| Texte long avec Unicode | 32 781 unités UTF-16 ; UIA indique sa troncature à 32 768 et refuse l'égalité du préfixe | 232 ms |
| Sauvegarde du texte long | Fichier intégral, comparé exactement | 140 ms |
| Texte Unicode de trois lignes | Valeur relue exactement | 210 ms |
| Cocher Option | État coché et événement applicatif | 114 ms |
| Deuxième sauvegarde | Fichier Unicode multiligne comparé exactement | 266 ms |

Compteurs finaux : deux changements de texte, une transition de case, deux sauvegardes. Les mesures sont celles de ce scénario, sans classement entre moteurs. Les preuves, reproductions avant correction et sorties de tests sont conservées dans `%LOCALAPPDATA%/NexusCodex/ComputerUse/reports/recheck-20261012/`.

Le premier plan a changé pendant cet essai. Les entrées physiques et les captures masquées ne sont pas requalifiées par cette validation sémantique. L'absence d'un contrôle signifie seulement son absence de l'arbre fourni ; elle ne certifie pas le contenu inaccessible. Un délai dépassé reste un résultat inconnu : arrêter le helper ne prouve pas qu'une action déjà reçue par l'application a été annulée. Aucun niveau SOTA universel n'est revendiqué.

## Finalisation 1.1.0 — 12 octobre 2026

**44 tests JavaScript réussis.** Les neuf tests du transport utilisent un vrai sous-processus de test, sans entrée de bureau : réutilisation, Unicode fragmenté, erreur du fournisseur, timeout, concurrence, mauvaise identité de réponse, JSON invalide, arrêt du processus, inactivité et limites d'entrée. Les tests de session couvrent aussi les contrôles remplacés, le contexte de saisie, le changement de fournisseur et les champs protégés. Compilation .NET réussie avec le point d'entrée MTA et protocole persistant.

La fixture WPF du dépôt (`tests/live/`) a été compilée et lancée dans LocalAppData, puis pilotée via le skill installé dans un Node REPL neuf. Trois opérations vérifiées :

| Opération | Preuve indépendante | Durée observée, entrée et relecture |
| --- | --- | --- |
| Texte de trois lignes, accents, Ω et 😀 | Événement TextChanged et relecture exacte | 310 ms |
| Cocher Option | Événement Checked et état UIA vrai | 125 ms |
| Enregistrer | Événement Click, statut et fichier UTF-8 exact | 711 ms |

Les compteurs applicatifs confirment exactement un changement de texte, une transition de case et une sauvegarde. Ces mesures n'établissent pas un classement de performance. Les preuves sont dans `%LOCALAPPDATA%/NexusCodex/ComputerUse/reports/final-20261012/` ; la fixture et le worker sont fermés après vérification.

Contrôle final : les 44 tests Computer Use et les 34 tests Pester NexusCodex passent ; l'installation est alignée sur les sources. Sept dossiers locaux obsolètes ont été retirés (4 485 355 octets), dont les intermédiaires et cinq anciennes versions natives. La version active, les recettes, sauvegardes et preuves sont conservées.

Le laboratoire est passé au premier plan pendant le scénario. La capture finale était partiellement recouverte par un dialogue d'une autre application. Les actions natives ne garantissent donc pas l'absence d'interférence ; le moteur intégré reste responsable des pixels et des entrées physiques. Les anciens essais de focus/saisie non atteints ne sont pas requalifiés en réussites par ces tests WPF. Aucun niveau SOTA universel n'est revendiqué.

L'observation `backend:'native'` permet maintenant d'obtenir les contrôles et états manquants dans un arbre Sky non vide, sans associer automatiquement des indices de fournisseurs différents. Le helper MTA ne garde aucun contrôle UIA entre requêtes et est arrêté au délai dépassé ou après inactivité.

## Historique — 11 octobre 2026

Vérifications réalisées dans la session de bureau Windows de Julien, via le plugin intégré et l'installation propre à NexusCodex.

## Complément : audit comparatif demandé par Julien

Les sources et essais de NexusAGY et NexusClaude ont été examinés sans modifier leurs implémentations. Le rapport détaillé, les reproductions par injection de pannes et les sorties brutes restent sous `%LOCALAPPDATA%/NexusCodex/ComputerUse/reports/audit-20261011/`.

Sur une vraie application de laboratoire Win32, la revue a trouvé puis corrigé les rôles français Sky `Modifier` / `zone de liste modifiable`, les états groupés et le besoin de capture avec géométrie avant un clic Sky indexé. Une case réellement cochée était exposée sans état par Sky : les états absents restent maintenant inconnus, au lieu de devenir des booléens faux. L'extension native relit bien cette case comme cochée. Les onglets natifs utilisent le rôle canonique `tab`.

La suite JavaScript compte désormais **30 tests réussis** ; quatre régressions supplémentaires ont échoué avant leurs corrections. L'extension .NET a été recompilée et réinstallée localement. Le clic bouton et la case à cocher ont été confirmés par les événements propres au laboratoire ; une valeur Unicode a été relue exactement par Sky et UIA natif. Les durées observées étaient respectivement 423, 333 et 253 ms, sans prétendre à un benchmark comparable aux autres moteurs.

Deux autres essais n'ont pas atteint leur postcondition : focus sur champ et ajout de texte par frappe. Ils sont conservés comme `unmet`, sans succès ni rejeu revendiqué. Plusieurs captures montraient une autre application recouvrant la cible ; une capture après activation montrait correctement le laboratoire. L'audit ne démontre donc ni une robustesse universelle des entrées physiques, ni des captures fiables en arrière-plan, ni un niveau SOTA.

## Régressions automatisées

- 26 tests JavaScript : sélecteurs localisés, ambiguïtés, contexte ancestral, identités, observations périmées/copiées/concurrentes, erreurs d'entrée ou de capture, résultats inconnus, postconditions, focus, coordonnées, apprentissage, corruption de mémoire, empreinte du binaire, extension native et absence de repli aveugle.
- 34 tests Pester NexusCodex existants réussis, dont la configuration et la protection de la sentinelle `.venv`.
- Compilation .NET Release réussie, sans dépendance tierce ajoutée, dans LocalAppData.
- Skill validé avec le validateur officiel Skill Creator.

Ces tests utilisent un fournisseur factice pour provoquer les erreurs de façon déterministe. Ils vérifient le comportement du code ; les résultats applicatifs ci-dessous proviennent des applications réelles.

## Applications réelles

**Antigravity / Electron, lecture seulement.** Sky a fourni l'arbre d'accessibilité réel : menus, boutons, navigation et champ de message. Aucun envoi de message ni modification dans cette application. Aucune lecture de son code Electron nécessaire.

**Bloc-notes / Store.** Le texte Sky était vide. L'extension native a exposé l'éditeur et les contrôles. Saisie de trois lignes avec accents, Ω et 😀 via Sky puis relecture exacte du document par UI Automation. Validation recommencée depuis le skill installé dans un REPL neuf.

**Dialogue Enregistrer sous.** La première tentative par `SetValue` changeait la valeur du champ lue par UIA mais le dialogue a enregistré sous son ancien nom. Le contrôle du fichier sur disque a révélé l'écart. Après correction de la sélection du focus (plusieurs éléments déclarés focalisés), le parcours focus/Ctrl+A/saisie/Enregistrer a produit le fichier exact à l'emplacement voulu, avec relecture UTF-8 et comparaison des trois lignes. La particularité de ce dialogue est documentée dans la fiche application.

Preuve locale : `%LOCALAPPDATA%/NexusCodex/ComputerUse/reports/live-20261011/notepad-unicode.txt`. Normalisation CR/CRLF/LF avant comparaison ; accents et caractères Unicode comparés exactement. Le premier fichier de test créé sur le Bureau est rapatrié dans le même dossier de preuve.

**Calculatrice / UWP.** Sky renvoyait un arbre vide. Le premier contrôle d'identité natif a détecté ApplicationFrameHost ; l'extension a été corrigée pour vérifier l'identité du processus de contenu hébergé. Le calcul `7 + 5 = 12` a été exécuté par InvokePattern et chaque résultat attendu relu.

**Mémoire.** Une action Effacer a été apprise après vérification. Un changement de contexte de calcul a produit `changed`, donc aucun rejeu. Après nouvelle inspection et apprentissage, la routine a été reconnue `ready` et rejouée sur `9`, donnant `0` avec statut `verified`. Le résultat survit dans la mémoire JSON locale ; il n'est pas basé sur des coordonnées.

Mesures observées (entrée et relecture, pas benchmarks généraux) : premier clic 6760 ms avec les lectures Sky vides ; après sélection native, clics Calculatrice mesurés à 635, 647, 658 et 645 ms. Saisie multiligne initiale 6620 ms avec la première stratégie de lecture. Les temps varient avec l'application et l'état de la session.

## Portée et limites

- Les captures restent celles du fournisseur intégré. Une capture Calculatrice était partiellement recouverte par une fenêtre WPF provenant d'une autre activité sur le bureau ; aucune supériorité des captures ni absence d'interférence n'est revendiquée.
- Les restrictions et permissions du plugin restent applicables. L'extension n'automatise pas la propre interface de Codex, les terminaux, l'authentification ou les applications de sécurité.
- Les autres applications n'ont pas toutes été testées. Les vues graphiques sans contrôles accessibles demandent toujours une vérification visuelle et des actions Sky.
- La mémoire invalide prudemment toute variation de structure : un changement bénin peut demander un nouvel apprentissage. Elle reste locale à chaque poste et ne constitue pas un entraînement du modèle.
- Un statut `verified` vérifie seulement la postcondition fournie. Pour une sauvegarde ou export, la validation doit inclure le fichier réel, comme dans cet essai.
