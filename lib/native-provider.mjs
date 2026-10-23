// Fournisseur de fenêtres SANS Sky, pour le serveur MCP autonome : l'inventaire vient du helper (op « windows »,
// processId 0 : fenêtres d'application du bureau), et chaque fenêtre est « nativeOnly » : lue, capturée et pilotée par
// le helper seul, son processus imposé à chaque requête. La session garde ses règles (arrière-plan d'abord, vraie
// entrée du helper en repli, refus avant toute entrée quand aucune technique ne s'applique).
export class NoSkyError extends Error {
  constructor(what) {
    super(`${what} needs Sky, absent from the standalone MCP server: nothing was sent`);
    this.refused = true; this.beforeInput = true;
  }
}

export function nativeProvider(native) {
  if (!native?.listWindows) throw new Error('The native helper is required');
  const list = async () => (await native.listWindows(0)).windows.map(w => ({
    id: w.id, app: w.app, title: w.title ?? '', pid: w.pid, nativeOnly: true,
  }));
  const refuse = what => async () => { throw new NoSkyError(what); };
  return {
    target: 'windows',
    standalone: true,
    list_windows: list,
    async get_window({ id, app }) {
      const found = (await list()).find(w => w.id === id && (app === undefined || w.app === app));
      if (!found) throw new Error('Window no longer listed');
      return found;
    },
    async activate_window({ window }) { await native.call(window, 'activate'); },
    get_window_state: refuse('Sky window state'),
    click: refuse('Sky click'),
    type_text: refuse('Sky typing'),
    set_value: refuse('Sky set_value'),
    press_key: refuse('Sky key'),
    scroll: refuse('Sky scroll'),
    drag: refuse('Sky drag'),
    perform_secondary_action: refuse('Sky secondary action'),
  };
}
