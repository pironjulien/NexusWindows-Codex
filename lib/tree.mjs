import { createHash } from 'node:crypto';

const roles = {
  button: ['button', 'bouton'], edit: ['edit', 'modifier', 'zone de texte', 'édition'],
  text: ['text', 'texte'], window: ['window', 'fenêtre'],
  pane: ['pane', 'volet', 'région'], group: ['group', 'groupe'],
  document: ['document'], link: ['link', 'lien'], tab: ['tab item', 'onglet'],
  list: ['list', 'liste'], listitem: ['list item', 'élément de liste'],
  menuitem: ['menu item', 'élément de menu'], menu: ['menu', 'barre de menus'],
  combobox: ['combo box', 'zone de liste déroulante', 'zone de liste modifiable'],
  checkbox: ['check box', 'case à cocher'], radio: ['radio button', 'case d’option', "case d'option"],
  tree: ['tree', 'arborescence'], treeitem: ['tree item', "élément d’arborescence", "élément d'arborescence"],
  image: ['image', 'élément graphique'], heading: ['heading', 'titre'],
  scrollbar: ['scroll bar', 'barre de défilement'], slider: ['slider', 'curseur'],
};
const aliases = Object.entries(roles).flatMap(([role, names]) => names.map(name => [name, role]))
  .sort((a, b) => b[0].length - a[0].length);
const stateFlags = new Set(['disabled', 'selected', 'unselected', 'selectable', 'checked', 'unchecked',
  'expanded', 'collapsed', 'focused', 'read only', 'read-only', 'readonly',
  'settable', 'string', 'float', 'integer', 'boolean']);
export const digest = value => createHash('sha256').update(value).digest('hex');

export function parseTree(tree = '') {
  const elements = [], stack = [];
  for (const line of tree.split(/\r?\n/)) {
    const match = /^(\s*)(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, indent, index, body] = match;
    const depth = indent.replaceAll('\t', '    ').length;
    const metadata = [...body.matchAll(/(?:^|\s)(Value|Description|Help|ID|Secondary Actions):\s*/g)];
    const main = body.slice(0, metadata[0]?.index ?? body.length).trim();
    const fields = {};
    for (let i = 0; i < metadata.length; i++) {
      fields[metadata[i][1]] = body.slice(metadata[i].index + metadata[i][0].length,
        metadata[i + 1]?.index ?? body.length).trim();
    }
    const alias = aliases.find(([name]) => main.toLowerCase() === name || main.toLowerCase().startsWith(name + ' '));
    const role = alias?.[1] ?? 'unknown';
    let name = alias ? main.slice(alias[0].length).trim() : main;
    const flags = [];
    // Sky emits a leading state group, often with several comma-separated flags.
    // Parentheses inside the actual control name must remain literal.
    while (alias) {
      const group = /^\(([^)]+)\)(?:\s+|$)/.exec(name);
      if (!group) break;
      const tokens = group[1].split(',').map(flag => flag.trim().toLowerCase());
      if (!tokens.every(flag => stateFlags.has(flag))) break;
      flags.push(...tokens);
      name = name.slice(group[0].length).trim();
    }
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const element = {
      index: Number(index), depth, role, name, automationId: fields.ID ?? '',
      value: fields.Value ?? null, description: fields.Description ?? null,
      disabled: flags.includes('disabled'),
      selected: flags.includes('selected') ? true : flags.includes('unselected') ? false : null,
      checked: flags.includes('checked') ? true : flags.includes('unchecked') ? false : null, flags,
      actions: fields['Secondary Actions']?.split(/,\s*/) ?? [],
      ancestors: stack.map(e => e.index), line: line.trim(),
    };
    if (elements.some(e => e.index === element.index)) throw new Error('Duplicate accessibility index; observation cannot be targeted');
    elements.push(element); stack.push(element);
  }
  return elements;
}

export function validateSelector(selector, nested = false) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error('A semantic selector is required');
  const allowed = ['role', 'name', 'automationId', 'ancestor'];
  if (Object.keys(selector).some(k => !allowed.includes(k))) throw new Error('Unknown selector field');
  if (!['role', 'name', 'automationId'].some(k => typeof selector[k] === 'string' && selector[k].length)) {
    throw new Error('Empty selector');
  }
  for (const k of ['role', 'name', 'automationId']) {
    if (selector[k] !== undefined && (typeof selector[k] !== 'string' || !selector[k].length)) throw new Error('Invalid selector field');
  }
  if (selector.ancestor !== undefined) {
    if (nested) throw new Error('Nested ancestor selectors are unsupported');
    validateSelector(selector.ancestor, true);
  }
}

export function findElements(elements, selector) {
  validateSelector(selector);
  const matches = (e, s) => ['role', 'name', 'automationId'].every(k => s[k] === undefined || e[k] === s[k]);
  return elements.filter(e => matches(e, selector) && (!selector.ancestor || e.ancestors.some(index => {
    const parent = elements.find(p => p.index === index);
    return parent && matches(parent, selector.ancestor);
  })));
}

export function uniqueElement(elements, selector) {
  const found = findElements(elements, selector);
  if (found.length !== 1) throw new Error(`Selector must match exactly one current element; found ${found.length}`);
  if (found[0].disabled) throw new Error('Target is disabled');
  if (found[0].password) throw new Error('Password controls require the dedicated supported workflow');
  return found[0];
}

export function structureHash(elements) {
  // Values, document text and window titles are intentionally excluded.
  const named = new Set(['button', 'tab', 'menuitem', 'checkbox', 'radio', 'combobox']);
  return digest(JSON.stringify(elements.map(e => [e.depth, e.role, e.automationId, named.has(e.role) ? e.name : ''])));
}

// Empreinte de l'état observable (valeurs et états compris) : sert seulement à prouver qu'une action d'arrière-plan
// n'a eu AUCUN effet relu avant un repli physique. Jamais persistée.
export function stateDigest(elements) {
  return digest(JSON.stringify(elements.map(e => [e.depth, e.role, e.automationId, e.name, e.value ?? null, e.valueTruncated ?? false,
    e.checked ?? null, e.selected ?? null, e.disabled ?? false, e.focused ?? null, e.actions ?? []])));
}

export function validateExpectation(expect) {
  if (!expect || typeof expect !== 'object') throw new Error('An explicit postcondition is required');
  validateSelector(expect.selector);
  if (Object.keys(expect).some(k => !['selector', 'exists', 'field', 'equals', 'includes'].includes(k))) throw new Error('Unknown postcondition field');
  if (expect.exists !== undefined && typeof expect.exists !== 'boolean') throw new Error('exists must be boolean');
  if (expect.field !== undefined && !['name', 'value', 'selected', 'checked', 'disabled', 'description', 'focused'].includes(expect.field)) throw new Error('Unsupported postcondition field');
  if (expect.equals !== undefined && !['string', 'boolean'].includes(typeof expect.equals)) throw new Error('Invalid equality');
  if (expect.includes !== undefined && (typeof expect.includes !== 'string' || !expect.includes.length)) throw new Error('Invalid text condition');
  if (expect.equals !== undefined && expect.includes !== undefined) throw new Error('Choose equals or includes');
  if (expect.exists === false && (expect.equals !== undefined || expect.includes !== undefined)) throw new Error('Absence cannot have a value condition');
  if (expect.exists === undefined && expect.equals === undefined && expect.includes === undefined) throw new Error('Empty postcondition');
}

export function checkExpectation(elements, expect) {
  validateExpectation(expect);
  // No accessible controls means no semantic evidence, not proof of absence.
  if (!elements.length) return false;
  const found = findElements(elements, expect.selector);
  if (expect.exists === false) return found.length === 0;
  if (found.length !== 1) return false;
  const value = found[0][expect.field ?? 'name'];
  if (expect.field === 'value' && expect.equals !== undefined && found[0].valueTruncated) return false;
  if (expect.equals !== undefined) return value === expect.equals;
  if (expect.includes !== undefined) return typeof value === 'string' && value.includes(expect.includes);
  return true;
}
