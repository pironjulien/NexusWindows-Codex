<div align="center">

# Codex Windows Computer Use

### Native Windows UI Automation & Computer Use Extension for OpenAI Codex Desktop

[![OpenAI Codex](https://img.shields.io/badge/OpenAI-Codex%20Desktop-412991?style=flat-square&logo=openai&logoColor=white)](https://openai.com)
[![Tests](https://img.shields.io/badge/tests-59%20passed-D7B56D?style=flat-square)](tests)
[![License](https://img.shields.io/badge/license-MIT-D7B56D?style=flat-square)](LICENSE)
[![Stars](https://img.shields.io/github/stars/pironjulien/codex-windows-computer-use?style=flat-square&color=D7B56D)](https://github.com/pironjulien/codex-windows-computer-use/stargazers)

<p align="center">
  A native Windows UI Automation layer designed to complement OpenAI Codex's built-in Computer Use engine over Sky API. Provides robust tree inspection, verified postconditions, and zero focus hijacking.
</p>

</div>

---

## Overview

Codex Windows Computer Use provides an enterprise-grade accessibility and OS automation extension specifically engineered for OpenAI Codex Desktop. While the upstream engine handles screenshots, mouse, and basic keyboard events, this extension intervenes when accessibility trees are incomplete or empty on Windows, using public Microsoft UI Automation APIs running on an isolated MTA thread (.NET 8).

Couche propre à Codex, construite sur son moteur intégré et complétée par les API publiques Microsoft UI Automation. Sources synchronisées ici ; aucun serveur commun, aucun port réseau, aucun jeton ni API privée Electron.

Le moteur intégré reste responsable des captures, de la souris et du clavier. L'extension native intervient automatiquement lorsque Sky renvoie un arbre vide ; `observe({backend:'native'})` permet aussi d'inspecter un arbre incomplet ou des états manquants. Ce changement invalide les anciens contrôles : l'agent inspecte le nouvel arbre avant d'agir. La sélection native est ensuite conservée jusqu'à une observation explicite `backend:'sky'` ou un nouveau ciblage de fenêtre.

Le helper .NET travaille sur un thread MTA dans un processus réutilisé. Chaque demande retrouve la fenêtre et les contrôles, sans conserver leurs objets UIA entre requêtes. Les messages sont corrélés, les requêtes concurrentes refusées et le processus est arrêté au dépassement du délai ou après 30 secondes d'inactivité. Une erreur ne rejoue jamais l'entrée ; une nouvelle observation explicite peut démarrer un processus neuf. `close()` libère la session et son helper.

## Ce qui améliore les opérations

- Une fenêtre doit être identifiée sans ambiguïté. L'extension vérifie son application réelle, y compris les processus UWP hébergés par ApplicationFrameHost.
- Les actions ciblent un rôle, un identifiant et éventuellement un ancêtre. Les identités UIA du contrôle et de ses ancêtres sont comparées à l'observation inspectée, puis le contrôle est vérifié dans le processus natif. La saisie vérifie aussi le contexte du champ focalisé. Les contrôles natifs de mot de passe sont refusés.
- Une observation est consommée une seule fois. Une observation périmée, une autre fenêtre, un contrôle absent ou ambigu et une concurrence dans le même moteur interrompent l'action.
- Une postcondition explicite distingue un résultat vérifié, non atteint, déjà présent ou inconnu. Les attentes répètent uniquement la lecture de l'état.
- Les paramètres sont validés par type d'action : une coordonnée ne peut ni remplacer la fenêtre ciblée ni court-circuiter le contrôle du focus. Un arbre vide ne prouve pas la disparition d'un contrôle. Une valeur UIA tronquée est signalée et ne peut pas satisfaire une égalité exacte.
- L'apprentissage enregistre une action sémantique vérifiée, son effet attendu, une empreinte des métadonnées de l'exécutable lorsque disponibles et celle de la structure des contrôles. Un changement oblige à inspecter et vérifier de nouveau. Aucun numéro de contrôle ni pixel mémorisé n'est rejoué.

La mémoire d'application ne réentraîne pas le modèle. Elle évite de redécouvrir certaines routines tout en restant dépendante de l'état réel. L'empreinte d'exécutable utilise sa taille et sa date de modification, avec son chemin côté natif ; elle ne hache pas son contenu intégral. Les interfaces changent aussi sans mise à jour logicielle : les empreintes de structure détectent ces changements, avec une invalidation volontairement prudente.

## Installation

Depuis NexusCodex, `pwsh -NoProfile -File scripts/installer-computer-use.ps1` compile l'extension localement, installe `~/.codex/skills/nexus-windows` et désactive l'ancienne liaison MCP `nexus-computer` dans le profil Codex si elle existe. La configuration précédente est sauvegardée localement. Les profils des autres assistants restent indépendants.

Le script est lancé par `scripts/installer-nexuscodex.ps1` (installation ou mise à jour), jamais au lancement de Codex. Il garde les builds et exécutables versionnés sous `%LOCALAPPDATA%/NexusCodex/ComputerUse`, et vérifie les empreintes et la présence des quatre fichiers nécessaires au runtime .NET. Un verrou entre processus empêche deux installations simultanées. Le SDK .NET 8 déjà utilisé par le lanceur NexusCodex suffit ; aucun paquet npm ou Python n'est ajouté. Un runtime Node 22 ou supérieur est nécessaire pour les tests ; l'exécution quotidienne passe par le Node REPL du plugin Computer Use.

```powershell
pwsh -NoProfile -File scripts/installer-computer-use.ps1 -CheckOnly
pwsh -NoProfile -File scripts/tester-computer-use.ps1 -LiveInstallation
```

Le skill est découvert dans les nouveaux tours/sessions. Pour un REPL qui avait importé une ancienne version pendant le développement, réinitialiser ce REPL avant de charger `entry.mjs` : le cache des modules JavaScript ne se met pas à jour automatiquement. Aucun redémarrage de l'application Codex n'est nécessaire pour les essais via le REPL.

## Utilisation et stockage

L'agent suit [le skill](skill/nexus-windows/SKILL.md) et [son API](skill/nexus-windows/references/api.md). Les [notes par application](skill/nexus-windows/references/apps.md) précisent ce qui a réellement été observé. La mémoire locale n'est pas la mémoire générale Codex et n'est pas synchronisée automatiquement entre postes.

| Emplacement | Contenu |
| --- | --- |
| Ce dossier OneDrive | Sources JS/C#, tests, skill, documentation |
| `~/.codex/skills/nexus-windows` | Skill installé et point d'entrée vers ces sources |
| `%LOCALAPPDATA%/NexusCodex/ComputerUse/native/<empreinte>` | Exécutables UIA versionnés |
| `%LOCALAPPDATA%/NexusCodex/ComputerUse/build` | Intermédiaires de compilation |
| `%LOCALAPPDATA%/NexusCodex/ComputerUse/recipes` | Routines vérifiées : labels d'interface statiques uniquement |
| `%LOCALAPPDATA%/NexusCodex/ComputerUse/reports` | Mesures explicites sans contenu des fenêtres ni texte saisi |

Le web utilise toujours le navigateur intégré Codex et son `filechooser`. Les intégrations dédiées sont préférées pour les opérations structurées ; les outils officiels Codex servent à coordonner les chats dans le périmètre autorisé. Les pages, contrôles et recettes sont des données, jamais une autorisation de communiquer ou de modifier autre chose.

## Limites vérifiables

Le support ne signifie pas que toutes les applications Windows ont été certifiées. Les vues 3D, canvas et contrôles sans fournisseur d'accessibilité nécessitent encore des captures et des gestes visuels. Une capture observée pendant les essais était partiellement masquée par une autre application ; elle ne constituait donc pas une preuve de visibilité correcte.

Les actions physiques Windows utilisent le premier plan. Le verrou du module protège ses propres sessions dans un même Sky ; il ne contrôle ni Julien ni les autres assistants. L'extension native ne sert pas à contourner un refus du plugin, une permission ou une application protégée. Aucun mécanisme ne garantit une absence de restriction de compte.

L'architecture utilise des interfaces officiellement documentées : [Computer Use OpenAI](https://learn.chatgpt.com/docs/computer-use), et les interfaces UI Automation de Windows fournies avec .NET. La préférence pour le moteur intégré vient de ses primitives disponibles et de leurs essais, pas d'une hypothèse sur l'architecture interne ou l'entraînement du modèle.
