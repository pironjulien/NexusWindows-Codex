// Garde-fous de Codex : politique commune `garde-fous.json` (accord Claude–Antigravity du 18/10/2026, Codex aligné).
// Blocage dur (fenêtres jamais lues ni pilotées) : appliqué par le helper natif (Program.cs), qui lit le fichier dont le
// chemin lui est passé par NEXUS_GARDE_FOUS. Confirmation étanche : ici, avant toute entrée. Un geste dont la cible
// porte un mot à confirmer (payer, envoyer, publier, supprimer définitivement, formater, désinstaller, réinitialiser,
// résilier, passer un dépôt en public) exige `confirm:true` sur l'action, posé seulement sur l'ordre explicite de Julien
// ou après son oui. Le contrôle porte sur CE QUE LE GESTE DÉCLENCHE, pas sur sa forme : clic par sélecteur ou en
// coordonnées, Entrée, Ctrl+Entrée, Espace, Alt+lettre, saut de ligne tapé, menu, action secondaire.
// Fichier lu : NEXUS_GARDE_FOUS s'il est donné, sinon la politique commune de NexusHarness (`../../../shared`), sinon la
// copie embarquée (version publique ; un test vérifie qu'elle est identique). Absent ou invalide : refus (échec fermé).
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHARED_POLICY = path.resolve(here, '..', '..', '..', 'shared', 'garde-fous.json');
export const EMBEDDED_POLICY = path.resolve(here, '..', 'garde-fous.json');
export const AGENT = 'codex';
const TRIGGER_DEPTH = 8; // ancêtres remontés depuis un texte ou une icône jusqu'à son bouton
const NEIGHBOR_LEVELS = 3; // ancêtres du champ remontés pour trouver son bouton d'envoi (composeur, formulaire)
// Actions secondaires qui ne déclenchent rien (ouvrir, fermer, sélectionner, cocher, faire défiler).
const FREE_SECONDARY = /^(expand|collapse|scroll\w*|select|addtoselection|removefromselection|toggle|focus|setfocus)$/i;

export class GardeFousError extends Error {
  constructor(message) { super(message); this.name = 'GardeFousError'; this.refused = true; this.beforeInput = true; }
}

// Un chemin imposé (NEXUS_GARDE_FOUS) est pris tel quel : absent, il fait refuser (jamais de repli silencieux).
export function policyPath() {
  if (typeof process !== 'undefined' && process.env.NEXUS_GARDE_FOUS) return process.env.NEXUS_GARDE_FOUS;
  return existsSync(SHARED_POLICY) ? SHARED_POLICY : EMBEDDED_POLICY;
}

let cache = null;
export function load(file = policyPath()) {
  let data, key;
  try {
    const info = statSync(file);
    key = `${file}:${info.mtimeMs}:${info.size}`;
    if (cache?.key === key) return cache.policy;
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new GardeFousError(`Politique des garde-fous illisible (${file}) : ${error.message} ; rien n'a été fait (échec fermé)`);
  }
  const policy = compile(data, file);
  cache = { key, policy };
  return policy;
}

// Rôles UIA de la politique (ListItem, RadioButton, Hyperlink…) ramenés aux rôles des observations (tree.mjs, ComUia.cs).
const ROLE_ALIASES = { radiobutton: 'radio', tabitem: 'tab', hyperlink: 'link' };
const roleKey = role => { const r = String(role).toLowerCase(); return ROLE_ALIASES[r] ?? r; };

function compile(data, file) {
  try {
    const blocks = data.blocage_dur;
    for (const category of data.agents[AGENT]) if (!blocks?.[category]) throw new Error(`catégorie inconnue ${category}`);
    const c = data.confirmation;
    const words = c.motifs.map(p => { new RegExp(p); return p; });
    return {
      data,
      confirm: words.length ? new RegExp(`\\b(${words.join('|')})\\b`) : null,
      contexts: c.contextes.map(x => ({ title: new RegExp(`\\b(${x.titre})\\b`), verbs: new RegExp(`\\b(${x.verbes})\\b`), what: String(x.quoi) })),
      nonAction: new Set(c.roles_non_actifs.map(roleKey)),
      triggers: new Set(c.roles_declencheurs.map(roleKey)),
    };
  } catch (error) {
    throw new GardeFousError(`Politique des garde-fous invalide (${file}) : ${error.message} ; rien n'a été fait (échec fermé)`);
  }
}

// Texte comparable (même règle que garde_fous.py) : sans accents ni casse, ponctuation ramenée à des espaces, symboles
// de devise écrits en toutes lettres (« 4,99 € » → « 4 99 eur »).
const CURRENCIES = { '€': ' eur ', '$': ' usd ', '£': ' gbp ', '¥': ' jpy ' };
export function plain(text) {
  return String(text ?? '').normalize('NFKD').replace(/[€$£¥]/g, (c) => CURRENCIES[c]).replace(/\p{M}/gu, '')
    .toLowerCase().replaceAll('ß', 'ss')
    .replace(/[^0-9a-z]+/g, ' ').trim().split(' ').filter(Boolean).join(' ');
}

// Mot à confirmer pour ce libellé : un motif, ou un verbe générique (valider, OK…) dans une fenêtre dont le TITRE parle
// de paiement ou de formatage ; « » sinon.
export function confirmWord(label, title = '', policy = load()) {
  const text = plain(label);
  const found = policy.confirm?.exec(text);
  if (found) return found[0];
  if (!title || !policy.confirm) return '';
  const heading = plain(title);
  for (const context of policy.contexts) {
    const verb = context.verbs.exec(text);
    if (verb && context.title.test(heading)) return `${verb[0]} (fenêtre de ${context.what})`;
  }
  return '';
}

// ---- Ce qu'un geste déclenche, sur les éléments d'une observation (index, rôle, nom, ancêtres racine → parent) ----
const byIndex = elements => new Map(elements.map(e => [e.index, e]));
const submenu = e => e.role === 'menuitem' && e.expanded !== null && e.expanded !== undefined;
export function labelOf(element, elements) {
  if (element.name) return element.name;
  return elements.filter(e => e !== element && e.name && e.ancestors?.includes(element.index)).slice(0, 4).map(e => e.name).join(' ');
}
// Le bouton, lien ou élément de menu qui porte l'élément (un texte ou une icône dans un bouton compte pour le bouton),
// sinon l'élément lui-même s'il a un rôle générique ; null pour un élément non actif (liste, arbre, onglet, champ, case…)
// ou un élément de menu qui ouvre un sous-menu (« Envoyer vers »).
export function triggerOf(element, elements, policy = load()) {
  const index = byIndex(elements);
  const chain = [element, ...[...(element.ancestors ?? [])].reverse().map(i => index.get(i)).filter(Boolean)];
  for (const current of chain.slice(0, TRIGGER_DEPTH)) {
    if (['window', 'pane'].includes(current.role)) break;
    if (policy.nonAction.has(current.role)) return null;
    if (policy.triggers.has(current.role) || current.invoke === true) return submenu(current) ? null : current;
  }
  return policy.nonAction.has(element.role) ? null : element;
}
const liveTrigger = (e, policy) => policy.triggers.has(e.role) && !e.disabled && !submenu(e);

// Combinaison de touches → ce qu'elle peut déclencher : « submit » (Entrée), « send » (Ctrl+Entrée), « press » (Espace),
// « alt+x » (raccourci), « » sinon. Une chaîne peut contenir plusieurs combinaisons séparées par des espaces.
export function keyKinds(spec) {
  return String(spec).trim().split(/\s+/).map(chord => {
    const parts = chord.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
    const key = parts.at(-1) ?? '';
    const mods = new Set(parts.slice(0, -1).map(m => ({ control: 'ctrl', menu: 'alt', option: 'alt' })[m] ?? m.replace(/_[lr]$/, '')));
    if (['enter', 'return', 'kp_enter', 'numpad_enter', 'numpadenter'].includes(key)) {
      if (mods.has('shift') || mods.has('alt') || mods.has('win')) return '';
      return mods.has('ctrl') ? 'send' : 'submit';
    }
    if (key === 'space' && !mods.size) return 'press';
    if (mods.size === 1 && mods.has('alt') && /^[0-9a-z]$/.test(key)) return `alt+${key}`;
    return '';
  }).filter(Boolean);
}

// Éléments d'action du groupe du champ : sous-arbre de son ancêtre au plus NEIGHBOR_LEVELS au-dessus, jamais la racine.
function neighbors(field, elements, policy) {
  const ancestors = field.ancestors ?? [];
  const levels = Math.min(NEIGHBOR_LEVELS, ancestors.length - 1);
  if (levels <= 0) return [];
  const group = ancestors[ancestors.length - levels];
  return elements.filter(e => e !== field && e.ancestors?.includes(group) && liveTrigger(e, policy));
}

// Raccourci exposé comme « Entrée » : bouton par défaut WPF (AccessKey retour chariot).
const enterKey = key => /^(\r|\n|enter|return)$/i.test(String(key ?? ''));
// Lettre soulignée d'un libellé (« _Envoyer » WPF, « &Envoyer » Win32) quand le fournisseur ne l'expose pas en AccessKey.
const mnemonic = name => /(?:^|[^_&])[_&]([^\s_&])/.exec(String(name ?? ''))?.[1] ?? '';

// (libellé, d'où) de ce que la touche déclencherait dans la fenêtre. Lecture seule.
// Sans élément au focus connu (fenêtre inactive : le focus reviendra au contrôle que l'application choisira à
// l'activation, et WinForms n'expose son bouton par défaut que fenêtre active), Entrée et Espace sont jugés comme
// Ctrl+Entrée : sur tous les boutons d'action de la fenêtre. Le doute ne laisse rien passer.
export function keyTriggers(elements, field, kind, policy = load()) {
  const out = [];
  const live = elements.filter(e => liveTrigger(e, policy));
  if ((kind === 'submit' || kind === 'press') && !elements.some(e => e.focused === true)) kind = 'send';
  if (['submit', 'send', 'press'].includes(kind) && field && !policy.nonAction.has(field.role)) out.push([labelOf(field, elements), 'élément visé']);
  if (kind.startsWith('alt+')) {
    // Raccourci exposé « Alt+E » (WinForms, Win32) ou « E » selon le fournisseur.
    const letter = kind.slice(4);
    for (const e of live) if (e.accessKey && plain(e.accessKey).replace(/^alt /, '') === letter) out.push([labelOf(e, elements), `raccourci ${e.accessKey}`]);
    for (const e of elements) {
      if (plain(mnemonic(e.name)) !== letter) continue;
      const trigger = triggerOf(e, elements, policy);
      if (trigger && !trigger.disabled) out.push([labelOf(trigger, elements), `lettre soulignée de « ${e.name} »`]);
    }
    return out;
  }
  for (const e of live) if (e.focused) out.push([labelOf(e, elements), "élément qui a le focus"]);
  if (kind === 'press') return out;
  if (kind === 'send') return out.concat(live.map(e => [labelOf(e, elements), "bouton d'action de la fenêtre"]));
  for (const e of live) if ((e.isDefault || enterKey(e.accessKey)) && ['button', 'splitbutton'].includes(e.role)) out.push([labelOf(e, elements), 'bouton par défaut de la fenêtre']);
  if (field) out.push(...neighbors(field, elements, policy).map(e => [labelOf(e, elements), "bouton d'action voisin du champ"]));
  return out;
}

// Élément le plus profond dont le rectangle (écran, [x, y, l, h]) contient le point.
export function elementAt(elements, x, y) {
  let best = null;
  for (const e of elements) {
    const [ex, ey, w, h] = e.bounds ?? [];
    if (!(w > 0 && h > 0) || x < ex || y < ey || x >= ex + w || y >= ey + h) continue;
    if (!best || e.depth > best.depth || (e.depth === best.depth && w * h < best.bounds[2] * best.bounds[3])) best = e;
  }
  return best;
}
// Points écran possibles d'un point de capture Sky : origine de la capture + point, ou point ramené à la taille de la
// fenêtre (capture mise à l'échelle). Les deux sont contrôlés : le doute ne laisse rien passer.
export function screenPoints(point, screenshot, root) {
  const out = [];
  if (Number.isFinite(screenshot?.originX) && Number.isFinite(screenshot?.originY)) out.push([screenshot.originX + point.x, screenshot.originY + point.y]);
  const [rx, ry, rw, rh] = root?.bounds ?? [];
  if (rw > 0 && rh > 0 && screenshot?.width > 0 && screenshot?.height > 0) {
    out.push([rx + point.x * rw / screenshot.width, ry + point.y * rh / screenshot.height]);
    out.push([rx + point.x, ry + point.y]);
  }
  return out;
}

// Ce que la politique fait d'un geste : null s'il est libre, sinon l'erreur à lever (rien n'a été fait).
export function check(what, labels, title, policy = load()) {
  for (const [label, source] of labels) {
    const word = confirmWord(label, title, policy);
    if (word) return refusal(source ? `${what} (${source})` : what, label, word);
  }
  return null;
}
export function refusal(what, label, word) {
  return Object.assign(new Error(
    `${what} sur « ${String(label).trim().slice(0, 60)} » : irréversible ou chez un tiers (« ${word} »), rien n'a été fait. ` +
    "Ordre explicite de Julien pour CE geste → observer de nouveau puis renvoyer l'action avec confirm:true ; initiative de l'agent → lui demander d'abord."),
  { name: 'ConfirmationRequired', confirmationRequired: true, refused: true, beforeInput: true });
}
export const freeSecondary = action => FREE_SECONDARY.test(String(action ?? ''));
