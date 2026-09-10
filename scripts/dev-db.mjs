#!/usr/bin/env node
/**
 * Two throwaway PostgreSQL clusters with the example schemas, for machines
 * without Docker. Same endpoints as docker-compose.yml:
 *
 *   source  postgresql://pgdiff:pgdiff@localhost:5441/app
 *   target  postgresql://pgdiff:pgdiff@localhost:5442/app
 *
 *   node scripts/dev-db.mjs            start (re-seeds only on first run)
 *   node scripts/dev-db.mjs --reset    wipe the data directories first
 *
 * Clusters already listening on their port are left alone, so running this
 * twice is harmless. The ones it does start are children of this process, so
 * leave it running.
 */
import EmbeddedPostgres from 'embedded-postgres';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reset = process.argv.includes('--reset');

const CLUSTERS = [
  { name: 'source', port: 5441, sql: 'examples/source.sql' },
  { name: 'target', port: 5442, sql: 'examples/target.sql' },
];

const HOST = '127.0.0.1';
const USER = 'pgdiff';
const PASSWORD = 'pgdiff';
const DATABASE = 'app';

const url = (port) => `postgresql://${USER}:${PASSWORD}@localhost:${port}/${DATABASE}`;

/** Is anything accepting connections on the port? */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** initdb insists on an empty target, and a half-written cluster has no PG_VERSION. */
async function prepare(dir) {
  if (reset || !existsSync(path.join(dir, 'PG_VERSION'))) {
    await rm(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function seed(pg, sqlFile) {
  const sql = await readFile(path.join(root, sqlFile), 'utf8');
  await pg.createDatabase(DATABASE);
  const client = pg.getPgClient(DATABASE, HOST);
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Confirm the thing on the port is our database and not some other service. */
async function respondsAsPgdiff(pg) {
  const client = pg.getPgClient(DATABASE, HOST);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const started = [];

async function main() {
  for (const cluster of CLUSTERS) {
    const databaseDir = path.join(root, '.dev-db', cluster.name);

    // Recent postgres stderr, so a failed start reports why instead of nothing.
    const log = [];
    const pg = new EmbeddedPostgres({
      databaseDir,
      port: cluster.port,
      user: USER,
      password: PASSWORD,
      authMethod: 'scram-sha-256',
      persistent: true,
      onLog: (message) => {
        log.push(message);
        if (log.length > 20) log.shift();
      },
      onError: (error) => console.error(`[${cluster.name}]`, error),
    });

    if (await isPortOpen(cluster.port)) {
      if (reset) {
        throw new Error(
          `Port ${cluster.port} is in use, so --reset cannot rebuild the ${cluster.name} cluster. ` +
            'Stop the running dev-db first.',
        );
      }
      if (!(await respondsAsPgdiff(pg))) {
        throw new Error(
          `Port ${cluster.port} is in use by something that is not the ${cluster.name} database. ` +
            'Stop it and try again.',
        );
      }
      console.log(`${cluster.name.padEnd(6)} ${url(cluster.port)}  (already running)`);
      continue;
    }

    const fresh = await prepare(databaseDir);
    if (fresh) await pg.initialise();
    try {
      await pg.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : log.join('').trim();
      throw new Error(
        `The ${cluster.name} cluster failed to start on port ${cluster.port}.` +
          (detail ? `\n${detail}` : ''),
      );
    }
    started.push(pg);
    if (fresh) await seed(pg, cluster.sql);

    console.log(`${cluster.name.padEnd(6)} ${url(cluster.port)}${fresh ? '  (initialised)' : ''}`);
  }

  if (started.length === 0) {
    console.log('\nBoth databases were already running; nothing to do.');
    return;
  }
  console.log('\nReady. Ctrl-C to stop.');
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled(started.map((pg) => pg.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await Promise.allSettled(started.map((pg) => pg.stop()));
  process.exit(1);
});
