import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'config.json');
const examplePath = join(projectRoot, 'config.example.json');

if (existsSync(configPath)) {
  console.log('config.json exists');
  process.exit(0);
}

const config = JSON.parse(readFileSync(examplePath, 'utf8'));
const token = randomBytes(24).toString('hex');
config.authToken = token;

writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

console.log(`authToken: ${token}`);
console.log(`config written to: ${configPath}`);
