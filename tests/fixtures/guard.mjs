// Imite le garde `--stop-guard` : présence annoncée puis vie jusqu'à la fermeture de l'entrée standard.
// Arguments : <marqueur|-> <mode>. Marqueur présent : il est retiré et le garde « plante » (code 3) juste après avoir
// annoncé la présence (crash simulé, une seule fois). Mode « silent » : vivant, mais présence jamais annoncée.
import { existsSync, unlinkSync } from 'node:fs';
const [marker, mode] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ event: 'hotkey', state: 'disabled' });
if (mode !== 'silent') emit({ event: 'presence', source: 'raw-input' });
if (marker && marker !== '-' && existsSync(marker)) {
  unlinkSync(marker);
  setTimeout(() => process.exit(3), 50);
}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
