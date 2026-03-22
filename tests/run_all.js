// Lance tous les tests LocalBot dans l'ordre et affiche un résumé global
// Usage : node tests/run_all.js

const { spawn } = require('child_process');
const path      = require('path');

const ROOT = path.resolve(__dirname, '..');

const TEST_FILES = [
  'tests/test_sprint1.js',
  'tests/test_sprint2.js',
  'tests/test_sprint3.js',
  'tests/test_sprint4.js',
  'tests/test_sprint5.js',
  'tests/test_sprint6.js',
];

async function runTest(file) {
  return new Promise((resolve) => {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Lancement : ${file}`);
    console.log('═'.repeat(50));

    const child = spawn('node', [file], {
      // stdin en pipe : on envoie '\n' pour les tests interactifs (test_sprint1)
      // qui utilisent readline ; les autres tests ne lisent pas stdin.
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd:   ROOT,
    });

    // Envoie une ligne vide puis ferme stdin pour débloquer readline
    try {
      child.stdin.write('\n');
      child.stdin.end();
    } catch { /* ignore si stdin déjà fermé */ }

    child.on('exit', (code) => {
      resolve({ file, passed: code === 0, exitCode: code });
    });

    child.on('error', (err) => {
      console.error(`[run_all] Erreur spawn pour ${file} : ${err.message}`);
      resolve({ file, passed: false, exitCode: -1 });
    });
  });
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     LocalBot — Suite complète de tests       ║');
  console.log('╚══════════════════════════════════════════════╝');

  const results = [];

  for (const file of TEST_FILES) {
    const result = await runTest(file);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const total  = results.length;

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Résultats');
  console.log('╠══════════════════════════════════════════════╣');
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`║  ${icon} ${r.file.padEnd(40)} ║`);
  }
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  LocalBot — Tous les tests : ${passed}/${total} passés`.padEnd(48) + '║');
  console.log('╚══════════════════════════════════════════════╝\n');

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('[run_all] Erreur inattendue :', err);
  process.exit(1);
});
