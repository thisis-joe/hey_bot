import { parseArgs } from 'node:util';
import pg from 'pg';
import { credentials } from './auth.js';
import { HttpModel } from './codex.js';
import { readRepositories } from './config.js';
import { Platform } from './platform.js';
import { previewRepositoryTrial, publishRepositoryTrial } from './repository-trial.js';
import { Workspaces } from './workspace.js';
import { Store } from './store.js';

try {
  const { values } = parseArgs({ options: {
    platform: { type: 'string' }, repository: { type: 'string' }, instance: { type: 'string' },
    number: { type: 'string' }, reviewer: { type: 'string' }, publish: { type: 'boolean', default: false },
  } });
  const { platform, repository, instance, reviewer, publish } = values;
  const number = Number(values.number);
  if ((platform !== 'github' && platform !== 'gitlab') || !repository || !reviewer || !/^\d+$/.test(values.number ?? '') || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error('Provide --platform, --repository, --number and --reviewer');
  }
  const repos = await readRepositories(process.env.REPOSITORIES_FILE ?? 'config/repositories.yaml', { includeDisabled: true });
  const matches = repos.filter(config => config.platform === platform && config.repository === repository && (!instance || config.instance === instance));
  const [repo] = matches;
  if (matches.length !== 1 || !repo || repo.enabled) throw new Error('Select a uniquely configured, disabled trial repository');
  if (!process.env[repo.webhookSecretEnv]) throw new Error('The trial repository webhook secret is missing');
  const client = new Platform(repo, credentials(repo));
  if (publish) {
    if (repo.trialNumber !== number || !process.env.DATABASE_URL) throw new Error('Publish requires trialNumber matching the selected PR/MR and the Controller database');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 300000) throw new Error('Trial preview exceeds the input limit');
      chunks.push(chunk);
    }
    const draft = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
    try {
      const store = new Store(pool);
      const lock = await pool.connect();
      const identity = JSON.stringify([repo.platform, repo.instance, repo.repository, number]);
      try {
        const acquired = await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS ok', [identity]);
        if (!acquired.rows[0]?.ok) throw new Error('A trial publication is already running for this PR/MR');
        const target = client.target(number);
        const previous = (await store.getTarget(target))?.report;
        console.log(JSON.stringify(await publishRepositoryTrial({ platform: client, reviewer, number, draft, previous,
          record: (report, marker, replace) => store.recordTrialReport(report, marker, replace),
          markPublished: marker => store.markTrialPublished(target, marker),
        })));
      } finally {
        lock.release(true);
      }
    } finally {
      await pool.end();
    }
  } else {
    const token = process.env.RUNNER_TOKEN;
    if (!token || token.length < 32) throw new Error('RUNNER_TOKEN must contain at least 32 characters');
    const model = new HttpModel(process.env.RUNNER_URL ?? 'http://runner:8091', token);
    const workspaces = new Workspaces(process.env.DATA_ROOT ?? '/data');
    console.log(JSON.stringify(await previewRepositoryTrial({ platform: client, workspaces, reviewer, number, model })));
  }
} catch (error) {
  const message = error instanceof Error && [
    'Provide --platform, --repository, --number and --reviewer', 'Select a uniquely configured, disabled trial repository',
    'The trial repository webhook secret is missing', 'Trial preview exceeds the input limit',
    'RUNNER_TOKEN must contain at least 32 characters', 'Repository maintainer permission required',
    'Trial preview does not match this repository and revision', 'Trial revision changed during preview',
    'Publish requires trialNumber matching the selected PR/MR and the Controller database', 'This PR/MR already has a stored question report',
    'Choose a trial PR/MR with a changed line for the question thread', 'A trial publication is already running for this PR/MR',
  ].includes(error.message) ? error.message : 'Trial failed. Check repository access, runner configuration and the saved preview.';
  console.error(message);
  process.exitCode = 1;
}
