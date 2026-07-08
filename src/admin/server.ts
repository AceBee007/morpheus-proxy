import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import type { MorpheusConfig } from '../config/types.js';
import { DescriptorError, type DescriptorRegistry } from '../grpc/descriptors.js';
import type { AppLogger } from '../logging/app-log.js';
import type { MaskRegistry } from '../logging/mask.js';
import type { TrafficLogStore } from '../logging/traffic-log.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import type { StartedListener } from '../proxy/http-listener.js';
import type { ManipulatorRunner } from '../proxy/pipeline.js';
import type { ConsumeRegistry } from '../rules/consume.js';
import type { ScriptMatcherRunner } from '../rules/matcher.js';
import type { RuleStore } from '../rules/store.js';
import type { ValidateRuleOptions } from '../rules/validate.js';
import { ApiError, queryInt, readJsonBody, sendError, sendJson } from './http-util.js';
import {
  createRule,
  deleteRule,
  disableAllRules,
  exportRules,
  getRule,
  getRuleState,
  importRules,
  listRules,
  putRule,
  resetRuleState,
  validateRules,
} from './rules-api.js';
import { deleteLogs, exportLog, getLog, listLogs, sendLogBody, streamLogEvents } from './logs-api.js';
import { simulateRules } from './simulate.js';

export interface AdminContext {
  config: MorpheusConfig;
  ruleStore: RuleStore;
  consume: ConsumeRegistry;
  trafficLog: TrafficLogStore;
  mask: MaskRegistry;
  appLog: AppLogger;
  metrics: MetricsRegistry;
  listeners: () => StartedListener[];
  ready: () => boolean;
  startedAt: Date;
  validateOptions: ValidateRuleOptions;
  descriptors: DescriptorRegistry;
  scriptRunner?: ScriptMatcherRunner;
  manipulatorRunner?: ManipulatorRunner;
  scriptSandboxStatus?: () => unknown;
  /** Directory of built UI assets; served as an SPA when present. */
  uiDir?: string;
  extraRoutes?: Route[];
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: AdminContext;
  params: Record<string, string>;
  searchParams: URLSearchParams;
}

export interface Route {
  method: string;
  /** Path relative to <basePath>, e.g. /api/v1/rules/:id — ':' segments bind params. */
  path: string;
  handler: (rc: RouteContext) => Promise<void> | void;
}

interface CompiledRoute extends Route {
  segments: string[];
}

function compile(route: Route): CompiledRoute {
  return { ...route, segments: route.path.split('/').filter((s) => s !== '') };
}

function matchRoute(
  route: CompiledRoute,
  segments: string[],
): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const expected = route.segments[i] as string;
    const actual = segments[i] as string;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveUi(ctx: AdminContext, res: ServerResponse, urlPath: string): boolean {
  if (ctx.uiDir === undefined) return false;
  const relative = urlPath === '' || urlPath === '/' ? '/index.html' : urlPath;
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  let file = join(ctx.uiDir, safe);
  if (!file.startsWith(ctx.uiDir)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback for client-side routes (no extension)
    if (extname(safe) !== '') return false;
    file = join(ctx.uiDir, 'index.html');
    if (!existsSync(file)) return false;
  }
  res.writeHead(200, {
    'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
  return true;
}

function buildRoutes(): Route[] {
  return [
    // health (spec 4.2.2)
    {
      method: 'GET',
      path: '/healthz/live',
      handler: ({ res }) => sendJson(res, 200, { status: 'ok' }),
    },
    {
      method: 'GET',
      path: '/healthz/ready',
      handler: ({ res, ctx }) => {
        if (ctx.ready()) sendJson(res, 200, { status: 'ready' });
        else sendJson(res, 503, { status: 'not_ready' });
      },
    },
    // status (spec 4.2.3)
    {
      method: 'GET',
      path: '/api/v1/status',
      handler: ({ res, ctx }) => {
        const listeners = ctx.listeners();
        sendJson(res, 200, {
          uptimeMs: Date.now() - ctx.startedAt.getTime(),
          listeners: listeners.map((l) => ({
            name: l.name,
            address: l.address,
            port: l.port,
            activeConnections: l.activeConnections(),
          })),
          activeConnections: listeners.reduce((sum, l) => sum + l.activeConnections(), 0),
          ruleRevision: ctx.ruleStore.revision,
          ruleCount: ctx.ruleStore.list().length,
          logRetention: {
            trafficMaxEntries: ctx.config.logging.trafficMaxEntries,
            trafficMaxBytes: ctx.config.logging.trafficMaxBytes,
            trafficRetentionMs: ctx.config.logging.trafficRetentionMs,
            appRetentionMs: ctx.config.logging.appRetentionMs,
          },
          trafficLogCount: ctx.trafficLog.size(),
          scriptSandbox: ctx.scriptSandboxStatus?.() ?? { available: ctx.scriptRunner !== undefined },
        });
      },
    },
    // metrics (spec 4.12)
    {
      method: 'GET',
      path: '/api/v1/metrics',
      handler: ({ res, ctx }) => {
        const active = ctx.listeners().reduce((sum, l) => sum + l.activeConnections(), 0);
        sendJson(res, 200, { ...ctx.metrics.snapshot(), activeConnections: active });
      },
    },
    // Prometheus text format (spec 4.12, proposed) at <basePath>/metrics
    {
      method: 'GET',
      path: '/metrics',
      handler: ({ res, ctx }) => {
        const active = ctx.listeners().reduce((sum, l) => sum + l.activeConnections(), 0);
        const body = ctx.metrics.toPrometheus(active);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(body);
      },
    },
    // rules CRUD (spec 4.2.4)
    {
      method: 'GET',
      path: '/api/v1/rules',
      handler: ({ res, ctx }) => sendJson(res, 200, listRules(ctx)),
    },
    {
      method: 'POST',
      path: '/api/v1/rules',
      handler: async ({ req, res, ctx }) => {
        sendJson(res, 201, createRule(ctx, await readJsonBody(req)));
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rules:disable-all',
      handler: ({ res, ctx, searchParams }) => {
        sendJson(res, 200, disableAllRules(ctx, queryInt(searchParams, 'expectedRevision')));
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rules:validate',
      handler: async ({ req, res, ctx }) => {
        sendJson(res, 200, validateRules(ctx, await readJsonBody(req)));
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rules:simulate',
      handler: async ({ req, res, ctx }) => {
        sendJson(
          res,
          200,
          await simulateRules(
            {
              ruleStore: ctx.ruleStore,
              consume: ctx.consume,
              trafficLog: ctx.trafficLog,
              validateOptions: ctx.validateOptions,
              ...(ctx.scriptRunner ? { scriptRunner: ctx.scriptRunner } : {}),
              ...(ctx.manipulatorRunner ? { manipulatorRunner: ctx.manipulatorRunner } : {}),
            },
            await readJsonBody(req),
          ),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rules:export',
      handler: async ({ req, res, ctx }) => {
        sendJson(res, 200, exportRules(ctx, await readJsonBody(req)));
      },
    },
    {
      method: 'POST',
      path: '/api/v1/rules:import',
      handler: async ({ req, res, ctx }) => {
        sendJson(res, 200, importRules(ctx, await readJsonBody(req)));
      },
    },
    {
      method: 'GET',
      path: '/api/v1/rules/:id',
      handler: ({ res, ctx, params }) => sendJson(res, 200, getRule(ctx, params['id'] as string)),
    },
    {
      method: 'PUT',
      path: '/api/v1/rules/:id',
      handler: async ({ req, res, ctx, params, searchParams }) => {
        sendJson(
          res,
          200,
          putRule(
            ctx,
            params['id'] as string,
            await readJsonBody(req),
            queryInt(searchParams, 'expectedRevision'),
          ),
        );
      },
    },
    {
      method: 'DELETE',
      path: '/api/v1/rules/:id',
      handler: ({ res, ctx, params, searchParams }) => {
        sendJson(
          res,
          200,
          deleteRule(ctx, params['id'] as string, queryInt(searchParams, 'expectedRevision')),
        );
      },
    },
    // rule state (spec 4.2.5)
    {
      method: 'GET',
      path: '/api/v1/rules/:id/state',
      handler: ({ res, ctx, params }) =>
        sendJson(res, 200, getRuleState(ctx, params['id'] as string)),
    },
    {
      method: 'POST',
      path: '/api/v1/rules/:id/state:reset',
      handler: ({ res, ctx, params }) =>
        sendJson(res, 200, resetRuleState(ctx, params['id'] as string)),
    },
    // logs (spec 4.2.8)
    {
      method: 'GET',
      path: '/api/v1/logs',
      handler: ({ res, ctx, searchParams }) => sendJson(res, 200, listLogs(ctx, searchParams)),
    },
    {
      method: 'DELETE',
      path: '/api/v1/logs',
      handler: ({ res, ctx }) => sendJson(res, 200, deleteLogs(ctx)),
    },
    {
      method: 'GET',
      path: '/api/v1/logs/events',
      handler: ({ res, ctx }) => streamLogEvents(ctx, res),
    },
    {
      method: 'GET',
      path: '/api/v1/logs/:id',
      handler: ({ res, ctx, params }) => sendJson(res, 200, getLog(ctx, params['id'] as string)),
    },
    {
      method: 'GET',
      path: '/api/v1/logs/:id/request',
      handler: ({ res, ctx, params, searchParams }) =>
        sendLogBody(ctx, res, params['id'] as string, 'request', searchParams),
    },
    {
      method: 'GET',
      path: '/api/v1/logs/:id/response',
      handler: ({ res, ctx, params, searchParams }) =>
        sendLogBody(ctx, res, params['id'] as string, 'response', searchParams),
    },
    {
      method: 'GET',
      path: '/api/v1/logs/:id/export',
      handler: async ({ res, ctx, params }) =>
        sendJson(res, 200, await exportLog(ctx, params['id'] as string)),
    },
    // gRPC descriptors (spec 4.7.3)
    {
      method: 'GET',
      path: '/api/v1/grpc/descriptors',
      handler: ({ res, ctx }) => sendJson(res, 200, { items: ctx.descriptors.list() }),
    },
    {
      method: 'POST',
      path: '/api/v1/grpc/descriptors',
      handler: async ({ req, res, ctx }) => {
        const body = await readJsonBody(req);
        if (
          typeof body !== 'object' ||
          body === null ||
          typeof (body as Record<string, unknown>)['name'] !== 'string' ||
          typeof (body as Record<string, unknown>)['content'] !== 'string'
        ) {
          throw new ApiError(400, 'invalid_descriptor', 'body must contain name, format, content');
        }
        const record = body as { name: string; format?: unknown; content: string };
        const format = record.format ?? 'proto_source';
        if (format !== 'proto_source' && format !== 'descriptor_set') {
          throw new ApiError(
            400,
            'invalid_descriptor',
            'format must be "proto_source" or "descriptor_set"',
          );
        }
        try {
          const info = ctx.descriptors.add({ name: record.name, format, content: record.content });
          ctx.appLog.info('grpc descriptor registered', { id: info.id, name: info.name });
          sendJson(res, 201, info);
        } catch (err) {
          if (err instanceof DescriptorError) {
            throw new ApiError(400, 'descriptor_validation_failed', err.message);
          }
          throw err;
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/v1/grpc/descriptors/:id',
      handler: ({ res, ctx, params }) => {
        const id = params['id'] as string;
        if (!ctx.descriptors.remove(id)) {
          throw new ApiError(404, 'descriptor_not_found', `descriptor "${id}" does not exist`);
        }
        ctx.appLog.info('grpc descriptor removed', { id });
        sendJson(res, 200, { deleted: id });
      },
    },
    // masking (spec 4.2.9)
    {
      method: 'GET',
      path: '/api/v1/logging/mask',
      handler: ({ res, ctx }) => sendJson(res, 200, ctx.mask.get()),
    },
    {
      method: 'PUT',
      path: '/api/v1/logging/mask',
      handler: async ({ req, res, ctx }) => {
        const body = await readJsonBody(req);
        if (
          typeof body !== 'object' ||
          body === null ||
          !Array.isArray((body as Record<string, unknown>)['headers']) ||
          !Array.isArray((body as Record<string, unknown>)['jsonPaths'])
        ) {
          throw new ApiError(400, 'invalid_mask', 'body must contain headers[] and jsonPaths[]');
        }
        const record = body as { headers: unknown[]; jsonPaths: unknown[] };
        if (
          !record.headers.every((h) => typeof h === 'string') ||
          !record.jsonPaths.every((p) => typeof p === 'string')
        ) {
          throw new ApiError(400, 'invalid_mask', 'headers and jsonPaths must be string arrays');
        }
        ctx.mask.set({
          headers: record.headers,
          jsonPaths: record.jsonPaths,
        });
        ctx.appLog.info('mask settings updated');
        sendJson(res, 200, ctx.mask.get());
      },
    },
  ];
}

export interface AdminServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the admin server on its own port (spec 3.4). Serves the JSON API
 * under <basePath>/api/v1, health under <basePath>/healthz, and the built
 * React SPA under <basePath>/ when available.
 */
export function startAdminServer(ctx: AdminContext): Promise<AdminServer> {
  const basePath = ctx.config.admin.basePath;
  const routes = [...buildRoutes(), ...(ctx.extraRoutes ?? [])].map(compile);

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      ctx.appLog.error('admin API internal error', { error: String(err) });
      if (!res.headersSent) {
        sendError(res, new ApiError(500, 'internal_error', 'unexpected admin API error'));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://admin.local');
    let path = url.pathname;
    if (path === basePath) path = `${basePath}/`;
    if (!path.startsWith(`${basePath}/`)) {
      sendError(res, new ApiError(404, 'not_found', `admin endpoints live under ${basePath}/`));
      return;
    }
    const subPath = path.slice(basePath.length);
    const segments = subPath.split('/').filter((s) => s !== '');
    const method = req.method ?? 'GET';

    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchRoute(route, segments);
      if (params === null) continue;
      try {
        await route.handler({ req, res, ctx, params, searchParams: url.searchParams });
      } catch (err) {
        if (err instanceof ApiError) {
          sendError(res, err);
        } else {
          throw err;
        }
      }
      return;
    }

    if (method === 'GET' && serveUi(ctx, res, subPath)) return;
    sendError(res, new ApiError(404, 'not_found', `no route for ${method} ${subPath}`));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ctx.config.admin.port, ctx.config.admin.host, () => {
      const address = server.address() as AddressInfo;
      ctx.appLog.info('admin server started', {
        host: ctx.config.admin.host,
        port: address.port,
        basePath,
      });
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((res2) => {
            server.closeAllConnections();
            server.close(() => res2());
          }),
      });
    });
  });
}
