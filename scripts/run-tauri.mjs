import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const env = { ...process.env };
const home = env.HOME || env.USERPROFILE || homedir();
const isWindows = process.platform === 'win32';
const cargoExe = isWindows ? 'cargo.exe' : 'cargo';
const tauriCmd = isWindows ? 'tauri.cmd' : 'tauri';

const candidateDirs = [join(home, '.cargo', 'bin'), env.CARGO_HOME ? join(env.CARGO_HOME, 'bin') : ''].filter(Boolean);
const currentPath = env.PATH || '';
for (const dir of candidateDirs) {
  if (!currentPath.split(delimiter).includes(dir)) {
    env.PATH = `${dir}${delimiter}${env.PATH || ''}`;
  }
}

if (!env.CARGO) {
  for (const dir of candidateDirs) {
    const candidate = join(dir, cargoExe);
    if (existsSync(candidate)) {
      env.CARGO = candidate;
      break;
    }
  }
}

const args = process.argv.slice(2);
const child = spawn(tauriCmd, args, {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
