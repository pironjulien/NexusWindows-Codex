// Imite le protocole de `--foreground-token purpose [hwnd]` du helper : jeton pris, fenêtre de Julien notée, puis à la
// fermeture de l'entrée standard, état du premier plan rendu. Aucune fenêtre réelle n'est touchée.
const args = process.argv.slice(2);
const at = args.indexOf('--foreground-token');
const target = args[at + 2];
process.stdout.write(JSON.stringify({ ok: true, foreground: 4242 }) + '\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ giveBack: target ? `restored:${target}` : 'none' }) + '\n');
  process.exit(0);
});
