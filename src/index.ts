/**
 * morpheus-proxy entrypoint. Boots the proxy listeners and the admin server
 * from the resolved configuration (docs/spec.md 4.13). The app always starts:
 * config problems fall back to built-in defaults with warnings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAdminServer, type AdminServer } from './admin/server.js';
import { loadConfig } from './config/load.js';
import { DescriptorRegistry } from './grpc/descriptors.js';
import { startGrpcListener } from './grpc/grpc-listener.js';
import { ReflectionImporter } from './grpc/reflection-import.js';
import { grpcBodyValidatorFor } from './grpc/rule-validation.js';
import { AppLogger } from './logging/app-log.js';
import { MaskRegistry } from './logging/mask.js';
import { TrafficLogStore } from './logging/traffic-log.js';
import { MetricsRegistry } from './observability/metrics.js';
import { startConnectListener } from './proxy/connect-listener.js';
import { startHttpListener, type StartedListener } from './proxy/http-listener.js';
import { parseUpstream } from './proxy/upstream.js';
import { startRetentionLoop } from './retention.js';
import { ConsumeRegistry } from './rules/consume.js';
import { RuleStore } from './rules/store.js';
import { validateRule, type ValidateRuleOptions } from './rules/validate.js';
import { ScriptSandbox } from './script/sandbox.js';

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
  const descriptors = new DescriptorRegistry();
  const reflection = new ReflectionImporter({
    registry: descriptors,
    appLog,
    metrics,
    settings: config.reflection,
  });
  const validateOptions: ValidateRuleOptions = {
    scriptMaxTimeoutMs: config.script.maxTimeoutMs,
    grpcBodyValidator: grpcBodyValidatorFor(descriptors),
  };

  // Reverse gRPC listeners have a fixed upstream: make it importable from the
  // admin UI / API before any traffic has been seen (spec 4.7.6)
  for (const listenerConfig of config.listeners) {
    if (listenerConfig.protocol !== 'grpc' || listenerConfig.mode === 'connect') continue;
    try {
      const target = parseUpstream(listenerConfig.upstream);
      reflection.noteConfiguredUpstream(`${target.host}:${target.port}`);
    } catch {
      // invalid upstreams are already reported by config validation
    }
  }

  // Descriptor sources referenced by listeners: unreadable files are skipped
  // with a warning and reflection imports retry in the background; startup
  // continues either way (spec 4.13, 4.7.6)
  for (const listenerConfig of config.listeners) {
    for (const source of listenerConfig.descriptors) {
      if (typeof source !== 'string') {
        appLog.info('descriptor import via reflection scheduled from config', {
          target: source.reflect,
          ...(source.symbols ? { symbols: source.symbols } : {}),
        });
        reflection.scheduleStartupImport(source.reflect, source.symbols);
        continue;
      }
      const file = source;
      try {
        if (file.endsWith('.proto')) {
          descriptors.add({
            name: file,
            format: 'proto_source',
            content: readFileSync(file, 'utf8'),
            source: { type: 'file', path: file },
          });
        } else {
          descriptors.add({
            name: file,
            format: 'descriptor_set',
            content: readFileSync(file).toString('base64'),
            source: { type: 'file', path: file },
          });
        }
        appLog.info('descriptor loaded from config', { file });
      } catch (err) {
        appLog.warn(`config: descriptor file "${file}" was skipped`, { error: String(err) });
      }
    }
  }

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

  // Rule scripts run in an isolated subprocess (spec 4.4.3)
  const sandbox = new ScriptSandbox({
    defaultTimeoutMs: config.script.defaultTimeoutMs,
    maxTimeoutMs: config.script.maxTimeoutMs,
    appLog,
  });
  const scriptRunner = sandbox.matcherRunner();
  const manipulatorRunner = sandbox.manipulatorRunner();

  let ready = false;
  const listeners: StartedListener[] = [];
  for (const listenerConfig of config.listeners) {
    const runtime = {
      listener: listenerConfig,
      limits: config.limits,
      ruleStore,
      consume,
      trafficLog,
      appLog,
      metrics,
      scriptRunner,
      manipulatorRunner,
    };
    if (listenerConfig.mode === 'connect') {
      listeners.push(await startConnectListener({ ...runtime, descriptors, reflection }));
    } else if (listenerConfig.protocol === 'http') {
      listeners.push(await startHttpListener(runtime));
    } else {
      listeners.push(await startGrpcListener({ ...runtime, descriptors, reflection }));
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
    descriptors,
    reflection,
    listeners: () => listeners,
    ready: () => ready,
    startedAt,
    validateOptions,
    scriptRunner,
    manipulatorRunner,
    scriptSandboxStatus: () => sandbox.status(),
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
    reflection.close();
    void Promise.all([adminServer.close(), sandbox.close(), ...listeners.map((l) => l.close())])
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
