// Imite le protocole de `--foreground-token purpose [hwnd]` du helper : jeton pris, fenêtre de Julien notée, puis à la
// fermeture de l'entrée standard, état du premier plan rendu. Aucune fenêtre réelle n'est touchée.
const args = process.argv.slice(2);
const at = args.indexOf('--foreground-token');
const target = args[at + 2];
process.stdout.write(JSON.stringify({ ok: true, foreground: 4242 }) + '\n');
// `--exit-after ms` : le helper disparaît pendant l'action (verrou libéré). « keep » reçu : choix de Julien gardé.
const exitAfter = args.indexOf('--exit-after');
if (exitAfter >= 0) setTimeout(() => process.exit(0), Number(args[exitAfter + 1]));
let said = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { said += chunk; });
process.stdin.on('end', () => {
  const giveBack = said.includes('keep') ? 'kept-by-julien' : target ? `restored:${target}` : 'none';
  process.stdout.write(JSON.stringify({ released: true, giveBack }) + '\n'); // accusé de libération normale
  process.exit(0);
});
