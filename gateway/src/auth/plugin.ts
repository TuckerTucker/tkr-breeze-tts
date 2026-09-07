/**
 * The shared-password gate.
 *
 * Every `/api/*` route sits behind a session. Exactly two things do not: the
 * login exchange, and the inert static shell.
 *
 * Serving the shell to an unauthenticated visitor is deliberate and is what
 * makes the gate reachable at all — the password field is a React component, so
 * refusing `index.html` and the bundle would mean the gate never loads and a
 * visitor handed the link meets a bare 401 body instead of a login. It is not a
 * hole: by standing invariant no bundled asset carries the proxy credential or
 * the upstream URL, and an unauthenticated console can complete no call because
 * every route behind it is refused. It is also what lets the browser keep a
 * typed draft in memory across an expiry; a 401 on `index.html` would force a
 * full page load and lose the work the gate exists not to lose.
 *
 * @module
 */

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

import type { PasswordVerifier } from './hash.js';
import type { RateLimiter } from './rate-limit.js';
import type { SessionStore } from './session.js';

/** Name of the session cookie. */
export const SESSION_COOKIE = 'breeze_session';

/** The one route pair the gate exempts. */
export const SESSION_ROUTE = '/api/session';

/** Everything the gate needs, injected so it can be built for a test. */
export interface AuthPluginDeps {
  /** The Argon2id hash to verify against. */
  readonly passwordHash: string;
  readonly verifier: PasswordVerifier;
  readonly sessions: SessionStore;
  readonly limiter: RateLimiter;
  /**
   * Whether the listener is reachable from off the machine. Drives the cookie's
   * `Secure` attribute: a Secure cookie is never sent over plain http, so
   * setting it unconditionally would make a gate enabled on a loopback listener
   * impossible to log into.
   */
  readonly exposed: boolean;
}

/** Read one cookie out of a request's `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Build the `Set-Cookie` value carrying a session.
 *
 * HttpOnly so script cannot read it, SameSite=Lax so a link into the demo does
 * not present as unauthenticated on first navigation, and Secure whenever the
 * listener is exposed.
 *
 * @param id - The session id, or null to clear the cookie.
 * @param exposed - Whether to mark the cookie Secure.
 * @returns The header value.
 */
export function sessionCookie(id: string | null, exposed: boolean): string {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (exposed) attributes.push('Secure');
  if (id === null) attributes.push('Max-Age=0');
  return [`${SESSION_COOKIE}=${id ?? ''}`, ...attributes].join('; ');
}

/**
 * Decide whether a request must carry a session.
 *
 * @param method - The request method.
 * @param url - The request URL, query string included.
 * @returns True when the gate must be satisfied before the route runs.
 */
export function requiresSession(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return false;
  if (path === SESSION_ROUTE && (method === 'POST' || method === 'DELETE')) return false;
  return true;
}

/**
 * Resolve the address a login attempt is counted against.
 *
 * This is the whole of the limiter's correctness, so it is a pure function with
 * an explicit hop policy rather than a delegated framework setting.
 *
 * Behind a proxy, ignoring `X-Forwarded-For` makes every visitor share the
 * proxy's address — one wrong-password loop would then lock out the entire
 * demo, a denial of service produced by the control meant to prevent one.
 * Taking the *left-most* entry is the opposite failure: a client sends its own
 * `X-Forwarded-For` and the proxy appends to it, so the left-most value is
 * attacker-chosen and the limiter is defeated by a header.
 *
 * The right-most entry is the one the adjacent proxy observed and wrote itself.
 * It is the only value in the chain nobody upstream of that proxy can choose,
 * which is why exactly one hop is trusted and only when the listener is exposed.
 *
 * @param socketAddress - The peer address of the connection itself.
 * @param forwardedFor - The `X-Forwarded-For` header, when present.
 * @param exposed - Whether the listener sits behind a proxy at all.
 * @returns A stable key, never empty.
 */
export function resolveClientKey(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  exposed: boolean,
): string {
  if (exposed) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const hops = (raw ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops[hops.length - 1];
    if (nearest !== undefined) return nearest;
  }
  return socketAddress || 'unknown';
}

/**
 * Resolve the limiter key for one request.
 *
 * @param request - The incoming request.
 * @param exposed - Whether the listener sits behind a proxy.
 * @returns A stable key, never empty.
 */
export function limiterKey(request: FastifyRequest, exposed: boolean): string {
  return resolveClientKey(request.socket.remoteAddress, request.headers['x-forwarded-for'], exposed);
}

function refuse(reply: FastifyReply, code: number, message: string, remedy?: string): void {
  // The existing typed envelope, so the browser's error path stays one shape
  // rather than growing a special case for the gate.
  reply.code(code).send({
    error: { type: 'auth', message, ...(remedy ? { remedy } : {}) },
  });
}

/**
 * Register the gate and the login exchange.
 *
 * Must be called before the API routes and the static handler: a hook
 * registered after the route it guards guards nothing.
 *
 * @param app - The server to register on.
 * @param deps - The gate's collaborators.
 */
export function registerAuth<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger,
    FastifyTypeProviderDefault
  >,
  deps: AuthPluginDeps,
): void {
  const { passwordHash, verifier, sessions, limiter, exposed } = deps;

  app.addHook('onRequest', async (request, reply) => {
    if (!requiresSession(request.method, request.url)) return;
    const id = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (sessions.verify(id)) return;
    // A missing cookie, a forged one and an expired one are all one answer.
    // The difference is only useful to someone probing.
    refuse(reply, 401, 'this demo is password protected');
  });

  app.post<{ Body: { password?: unknown } }>(SESSION_ROUTE, async (request, reply) => {
    const key = limiterKey(request, exposed);
    // Checked before verifying, so the limiter is not itself a way to spend
    // Argon2 time.
    if (!limiter.check(key)) {
      refuse(
        reply,
        429,
        'too many attempts',
        'Wait a few minutes and try again. Repeated attempts from one source are limited.',
      );
      return;
    }

    const candidate = request.body?.password;
    const accepted =
      typeof candidate === 'string' && (await verifier.verify(passwordHash, candidate));
    if (!accepted) {
      limiter.record(key);
      // Says only that it failed: nothing about the password's length or shape.
      refuse(reply, 401, 'that password was not accepted');
      return;
    }

    limiter.clear(key);
    reply.header('set-cookie', sessionCookie(sessions.create(), exposed));
    reply.code(204).send();
  });

  app.delete(SESSION_ROUTE, async (request, reply) => {
    sessions.destroy(readCookie(request.headers.cookie, SESSION_COOKIE));
    reply.header('set-cookie', sessionCookie(null, exposed));
    reply.code(204).send();
  });
}
