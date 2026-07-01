#!/usr/bin/env node
/**
 * Prepara a pasta data/ do backend para desenvolvimento.
 *
 * Uso:
 *   npm run setup                        # busca gtfs-stops.json automaticamente
 *   npm run setup -- --gtfs ~/path.json  # usa arquivo específico
 *
 * O que faz:
 *   1. Cria data/ se não existir
 *   2. Executa db:push para criar o banco SQLite
 *   3. Copia gtfs-stops.json (do frontend vizinho ou de caminho fornecido)
 *
 * Nota: metro-lines.json e route-colors.json vivem em static/ (versionados no git)
 *       e são encontrados automaticamente pelo servidor — não precisam de setup.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const args = process.argv.slice(2);
const gtfsArg = args.indexOf('--gtfs');
const providedGtfs = gtfsArg !== -1 ? args[gtfsArg + 1] : null;

// Locais candidatos para gtfs-stops.json (em ordem de preferência)
const GTFS_CANDIDATES = [
  providedGtfs ? path.resolve(providedGtfs) : null,
  // Frontend vizinho (estrutura padrão de repo)
  path.join(ROOT, '..', 'SPMove', 'assets', 'gtfs-stops.json'),
  path.join(ROOT, '..', 'spmove', 'assets', 'gtfs-stops.json'),
  path.join(ROOT, '..', 'frontend', 'assets', 'gtfs-stops.json'),
].filter(Boolean);

function log(msg) {
  process.stdout.write(msg + '\n');
}

function setupDatabase() {
  log('\n[1/2] Criando banco de dados...');
  try {
    execSync('npm run db:push', { cwd: ROOT, stdio: 'inherit' });
    log('  Banco criado com sucesso.');
  } catch {
    log('  Aviso: db:push falhou. Rode manualmente: npm run db:push');
  }
}

function setupGtfsStops() {
  log('\n[2/2] Buscando gtfs-stops.json...');

  const dest = path.join(DATA_DIR, 'gtfs-stops.json');

  if (fs.existsSync(dest)) {
    const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
    log(`  Ja existe (${sizeMB} MB). Pulando. Use --gtfs para substituir.`);
    return;
  }

  for (const candidate of GTFS_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      const sizeMB = (fs.statSync(candidate).size / 1024 / 1024).toFixed(1);
      log(`  Encontrado: ${candidate} (${sizeMB} MB)`);
      log('  Copiando...');
      fs.copyFileSync(candidate, dest);
      log('  Copiado com sucesso.');
      return;
    }
  }

  log('  Nao encontrado automaticamente.');
  log('\n  Opcoes para obter gtfs-stops.json:');
  log('  a) Rode no frontend:  npm run setup-gtfs');
  log('     Depois:            npm run setup -- --gtfs ../SPMove/assets/gtfs-stops.json');
  log('  b) Copie manualmente para: data/gtfs-stops.json');
  log('\n  O servidor inicia sem ele (endpoints de paradas ficam desativados).');
}

// ── Main ─────────────────────────────────────────────────────────────────────

log('=== SPMove Backend — Setup ===');

fs.mkdirSync(DATA_DIR, { recursive: true });

setupDatabase();
setupGtfsStops();

log('\n=== Setup concluido! ===');
log('  Inicie o servidor com: npm run dev');
