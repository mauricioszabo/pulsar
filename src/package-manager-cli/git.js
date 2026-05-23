// Git helpers ported from ppm/src/git.js. The npm dependency for reading
// the configured `git` binary is replaced with `npmrc.get('git')`.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('./fs');
const npmrc = require('./npmrc');

function addPortableGitToEnv(env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return;
  const githubPath = path.join(localAppData, 'GitHub');
  let children;
  try { children = fs.readdirSync(githubPath); } catch (_) { return; }
  for (const child of children) {
    if (child.indexOf('PortableGit_') === 0) {
      const cmdPath = path.join(githubPath, child, 'cmd');
      const binPath = path.join(githubPath, child, 'bin');
      if (env.Path) env.Path += path.delimiter;
      env.Path += `${cmdPath}${path.delimiter}${binPath}`;
      break;
    }
  }
}

function addGitBashToEnv(env) {
  let gitPath;
  if (env.ProgramFiles) gitPath = path.join(env.ProgramFiles, 'Git');
  if (!fs.isDirectorySync(gitPath) && env['ProgramFiles(x86)']) {
    gitPath = path.join(env['ProgramFiles(x86)'], 'Git');
  }
  if (!fs.isDirectorySync(gitPath)) return;
  const cmdPath = path.join(gitPath, 'cmd');
  const binPath = path.join(gitPath, 'bin');
  if (env.Path) env.Path += path.delimiter;
  env.Path += `${cmdPath}${path.delimiter}${binPath}`;
}

exports.addGitToEnv = env => {
  if (process.platform !== 'win32') return;
  addPortableGitToEnv(env);
  addGitBashToEnv(env);
};

exports.getGitVersion = () => new Promise(resolve => {
  const git = npmrc.get('git') || 'git';
  exports.addGitToEnv(process.env);
  const spawned = spawn(git, ['--version']);
  const chunks = [];
  spawned.stderr.on('data', c => chunks.push(c));
  spawned.stdout.on('data', c => chunks.push(c));
  spawned.on('error', () => resolve(undefined));
  spawned.on('close', code => {
    if (code !== 0) return resolve(undefined);
    const parts = Buffer.concat(chunks).toString().split(' ');
    resolve(parts[2]?.trim());
  });
});
