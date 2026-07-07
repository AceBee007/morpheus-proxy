import { spawn, type ChildProcess } from 'node:child_process';
import type { AppLogger } from '../logging/app-log.js';
import type { ManipulatorInput, ManipulatorRunner } from '../proxy/pipeline.js';
import type { MatchInput, ScriptMatcherRunner } from '../rules/matcher.js';
import type { ScriptManipulatorAction, ScriptMatcher } from '../rules/types.js';

/**
 * Worker source, executed via `node -e` in a child process with an IPC
 * channel. Scripts run inside a bare `vm` context: no require, no process,
 * no Buffer, no dynamic import, eval disabled (spec 4.4.3). The parent kills
 * the process on timeout/freeze and starts a fresh one.
 */
const WORKER_SOURCE = `
'use strict';
const vm = require('node:vm');
process.on('message', (job) => {
  const respond = (payload) => { try { process.send(payload); } catch {} };
  (async () => {
    const context = vm.createContext({}, {
      codeGeneration: { strings: false, wasm: false },
    });
    let fn;
    try {
      const wrapper = new vm.Script(
        '(async function (ctx) {\\n' + job.source + '\\n})',
        { filename: 'morpheus-rule-script.js' },
      );
      fn = wrapper.runInContext(context);
    } catch (err) {
      respond({ id: job.id, ok: false, error: 'script compile error: ' + (err && err.message || err) });
      return;
    }
    try {
      const result = await fn(job.input);
      respond({ id: job.id, ok: true, result });
    } catch (err) {
      respond({ id: job.id, ok: false, error: 'script runtime error: ' + (err && err.message || err) });
    }
  })().catch((err) => {
    respond({ id: job.id, ok: false, error: String(err) });
  });
});
process.send({ ready: true });
`;

interface PendingJob {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ScriptSandboxOptions {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  appLog: AppLogger;
}

export interface SandboxStatus {
  available: boolean;
  running: boolean;
  restarts: number;
  pendingJobs: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

export class ScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`script timed out after ${timeoutMs}ms`);
    this.name = 'ScriptTimeoutError';
  }
}

/**
 * Runs rule scripts in a dedicated Node.js subprocess (spec 4.4.3). One
 * worker executes jobs sequentially per event loop; a timeout or freeze
 * kills the subprocess and boots a replacement, failing in-flight jobs.
 */
export class ScriptSandbox {
  private worker: ChildProcess | null = null;
  private readonly jobs = new Map<number, PendingJob>();
  private nextId = 1;
  private restarts = -1; // first spawn is not a restart
  private closed = false;
  private readonly opts: ScriptSandboxOptions;

  constructor(opts: ScriptSandboxOptions) {
    this.opts = opts;
    this.spawnWorker();
  }

  private spawnWorker(): void {
    if (this.closed) return;
    this.restarts += 1;
    const worker = spawn(process.execPath, ['-e', WORKER_SOURCE], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.worker = worker;
    worker.on('message', (message: unknown) => {
      const payload = message as { id?: number; ok?: boolean; result?: unknown; error?: string };
      if (payload.id === undefined) return; // ready signal
      const pending = this.jobs.get(payload.id);
      if (!pending) return;
      this.jobs.delete(payload.id);
      clearTimeout(pending.timer);
      if (payload.ok === true) {
        pending.resolve(payload.result);
      } else {
        pending.reject(new Error(payload.error ?? 'script failed'));
      }
    });
    worker.on('exit', (code, signal) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.failAllPending(new Error(`script sandbox exited (code=${code}, signal=${signal})`));
      if (!this.closed) {
        this.opts.appLog.warn('script sandbox subprocess exited; restarting', { code, signal });
        this.spawnWorker();
      }
    });
    worker.on('error', (err) => {
      this.opts.appLog.error('script sandbox subprocess error', { error: String(err) });
    });
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.jobs) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.jobs.clear();
  }

  private clampTimeout(timeoutMs: number | undefined): number {
    const requested = timeoutMs ?? this.opts.defaultTimeoutMs;
    return Math.min(requested, this.opts.maxTimeoutMs);
  }

  /** Runs one script; rejects on compile/runtime error or timeout. */
  run(source: string, input: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('script sandbox is closed'));
    const worker = this.worker;
    if (!worker || worker.connected !== true) {
      return Promise.reject(new Error('script sandbox is not running'));
    }
    const effectiveTimeout = this.clampTimeout(timeoutMs);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id);
        // Freeze or runaway script: kill the subprocess and start a new one (spec 4.4.3)
        this.opts.appLog.warn('script timed out; restarting sandbox subprocess', {
          timeoutMs: effectiveTimeout,
        });
        try {
          worker.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        reject(new ScriptTimeoutError(effectiveTimeout));
      }, effectiveTimeout);
      this.jobs.set(id, { resolve, reject, timer });
      worker.send({ id, source, input, timeoutMs: effectiveTimeout }, (err) => {
        if (err) {
          const pending = this.jobs.get(id);
          if (pending) {
            this.jobs.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new Error(`script sandbox IPC failed: ${err.message}`));
          }
        }
      });
    });
  }

  /** Matcher runner for rule evaluation (spec 4.4.3). */
  matcherRunner(): ScriptMatcherRunner {
    return async (matcher: ScriptMatcher, input: MatchInput): Promise<boolean> => {
      const result = await this.run(matcher.source, input, matcher.timeoutMs);
      return Boolean(result);
    };
  }

  /** Manipulator runner returning a response patch (spec 4.5.6). */
  manipulatorRunner(): ManipulatorRunner {
    return async (
      action: ScriptManipulatorAction,
      input: ManipulatorInput,
    ): Promise<Record<string, unknown>> => {
      const result = await this.run(action.source, input, action.timeoutMs);
      if (result === undefined || result === null) return {};
      if (typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('script manipulator must return a response patch object');
      }
      return result as Record<string, unknown>;
    };
  }

  status(): SandboxStatus {
    return {
      available: true,
      running: this.worker !== null && this.worker.connected === true,
      restarts: Math.max(0, this.restarts),
      pendingJobs: this.jobs.size,
      defaultTimeoutMs: this.opts.defaultTimeoutMs,
      maxTimeoutMs: this.opts.maxTimeoutMs,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAllPending(new Error('script sandbox is closing'));
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
        worker.kill('SIGKILL');
      });
    }
  }
}
