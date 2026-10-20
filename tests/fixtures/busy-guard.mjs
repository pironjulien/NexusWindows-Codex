// Imite le garde `--stop-guard` et note chaque commande reçue sur son entrée standard (busy/idle) dans un fichier.
import { appendFileSync } from 'node:fs';
const [record] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ event: 'hotkey', state: 'disabled' }) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => appendFileSync(record, chunk));
process.stdin.on('end', () => process.exit(0));
