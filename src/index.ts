/**
 * morpheus-proxy entrypoint. Boots the proxy listeners and the admin server
 * from the resolved configuration (docs/spec.md 4.13). The app always starts:
 * config problems fall back to built-in defaults with warnings.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAdminServer, type AdminServer } from './admin/server.js';
import { loadConfig } from './config/load.js';
import { AppLogger } from './logging/app-log.js';
import { MaskRegistry } from './logging/mask.js';
import { TrafficLogStore } from './logging/traffic-log.js';
import { MetricsRegistry } from './observability/metrics.js';
import { startHttpListener, type StartedListener } from './proxy/http-listener.js';
import { startRetentionLoop } from './retention.js';
import { ConsumeRegistry } from './rules/consume.js';
import { RuleStore } from './rules/store.js';
import { validateRule, type ValidateRuleOptions } from './rules/validate.js';

async function main(): Promise<void> {
  const startedAt = new Date();
  const { config, warnings, sourcePath } = loadConfig({
    argv: process.argv.slice(2),
    env: process.env,
  });

  const appLog = new AppLogger({ dir: config.logging.appLogDir });
  appLog.info('morpheus-proxy starting', {
    config: sourcePath ?? 'built-in defaults',
    listeners: config.listeners.map((l) => `${l.name}(${l.protocol}) :${l.port} -> ${l.upstream}`),
  });
  for (const warning of warnings) appLog.warn(warning);

  const mask = new MaskRegistry(config.logging.mask);
  const trafficLog = new TrafficLogStore({
    dir: config.logging.trafficLogDir,
    maxEntries: config.logging.trafficMaxEntries,
    maxBytes: config.logging.trafficMaxBytes,
    retentionMs: config.logging.trafficRetentionMs,
    mask,
    appLog,
  });
  const consume = new ConsumeRegistry();
  const ruleStore = new RuleStore({ onRuleChanged: (id) => consume.reset(id) });
  const metrics = new MetricsRegistry();
  const validateOptions: ValidateRuleOptions = {
    scriptMaxTimeoutMs: config.script.maxTimeoutMs,
  };

  // Rule presets from config: invalid entries are skipped with a warning (spec 4.13)
  config.rules.presets.forEach((preset, index) => {
    const result = validateRule(preset, validateOptions);
    if (!result.rule) {
      appLog.warn(`config: rules.presets[${index}] is invalid and was skipped`, result.errors);
      return;
    }
    try {
      ruleStore.create(result.rule);
    } catch (err) {
      appLog.warn(`config: rules.presets[${index}] was skipped`, { error: String(err) });
    }
  });

  let ready = false;
  const listeners: StartedListener[] = [];
  for (const listenerConfig of config.listeners) {
    if (listenerConfig.protocol === 'http') {
      listeners.push(
        await startHttpListener({
          listener: listenerConfig,
          limits: config.limits,
          ruleStore,
          consume,
          trafficLog,
          appLog,
          metrics,
        }),
      );
    } else {
      // gRPC listeners land in milestone 3
      appLog.warn(`listener "${listenerConfig.name}" skipped: grpc listeners are not available yet`);
    }
  }

  // Built UI assets are served by the admin server when present (spec 3.4)
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'dist');

  const adminServer: AdminServer = await startAdminServer({
    config,
    ruleStore,
    consume,
    trafficLog,
    mask,
    appLog,
    metrics,
    listeners: () => listeners,
    ready: () => ready,
    startedAt,
    validateOptions,
    ...(existsSync(uiDir) ? { uiDir } : {}),
  });

  const retention = startRetentionLoop({
    trafficLog,
    appLogDir: config.logging.appLogDir,
    appRetentionMs: config.logging.appRetentionMs,
    appLog,
  });

  ready = true;
  appLog.info('morpheus-proxy ready', {
    adminPort: adminServer.port,
    proxyPorts: listeners.map((l) => l.port),
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    appLog.info(`received ${signal}, shutting down`);
    retention.stop();
    void Promise.all([adminServer.close(), ...listeners.map((l) => l.close())])
      .then(() => trafficLog.flush())
      .then(() => appLog.flush())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
