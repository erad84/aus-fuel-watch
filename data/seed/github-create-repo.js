'use strict';
// Creates the GitHub repo if missing, then exits 0. Never prints tokens.
const { execSync } = require('child_process');

function credential() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const cred = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) cred[line.slice(0, i)] = line.slice(i + 1);
  }
  return cred;
}

async function api(path, opts = {}) {
  const cred = credential();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(cred.password ? { Authorization: `token ${cred.password}` } : {}),
    ...opts.headers,
  };
  const res = await fetch(`https://api.github.com${path}`, { ...opts, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

async function main() {
  const cred = credential();
  if (!cred.password) {
    console.error('no github credential from git credential fill');
    process.exit(1);
  }
  console.log(`github user: ${cred.username || 'unknown'}`);

  const check = await api('/repos/erad84/aus-fuel-watch');
  if (check.status === 200) {
    console.log('repo exists');
    return;
  }
  if (check.status !== 404) {
    console.error(`check failed: HTTP ${check.status} ${check.body.message || ''}`);
    process.exit(1);
  }

  const create = await api('/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'aus-fuel-watch',
      description: 'Pebble watchapp for Australian fuel prices',
      private: false,
      has_issues: true,
    }),
  });
  if (create.status === 201) {
    console.log('repo created: https://github.com/erad84/aus-fuel-watch');
    return;
  }
  console.error(`create failed: HTTP ${create.status} ${create.body.message || JSON.stringify(create.body)}`);
  process.exit(1);
}

main();
