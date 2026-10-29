import { NetworkNodeNotFound } from './hierarchy.js';
import { IndexNotSynced } from './index-store.js';
import {
  PortalAuthError,
  PortalCircuitOpen,
  PortalError,
  PortalNotFound,
  PortalParseError,
  PortalUnavailable,
} from './portal/errors.js';

const TIMEOUT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError']);

/** Reshape Fastify's schema validation error into a message naming the failing field. */
function describeValidation(error) {
  const [first] = error.validation;
  const field = first.instancePath.replace(/^\//, '') || first.params?.missingProperty || 'value';
  const place =
    { querystring: 'query parameter', params: 'path parameter' }[error.validationContext] ??
    error.validationContext;
  return `Invalid ${place} '${field}': ${first.message}.`;
}

/**
 * Map any error to { status, code, message }. Messages are fixed text of ours: no stack
 * traces, no portal paths, no upstream bodies ever reach the client (they are only logged).
 */
function classify(error, request) {
  if (error.validation) {
    return { status: 400, code: 'invalid_request', message: describeValidation(error) };
  }
  if (error instanceof NetworkNodeNotFound) {
    return {
      status: 404,
      code: 'network_node_not_found',
      message: `No network node with code '${request.params?.nodeCode ?? ''}'.`,
    };
  }
  if (error instanceof IndexNotSynced) {
    return { status: 503, code: 'index_not_synced', message: error.message };
  }
  // WHY: only meter lookups can yield PortalNotFound (unknown meter id).
  if (error instanceof PortalNotFound) {
    return {
      status: 404,
      code: 'meter_not_found',
      message: `No meter with id '${request.params?.meterId ?? ''}'.`,
    };
  }
  // Our own portal credentials failed; the caller did nothing wrong, hence 503 not 401.
  if (error instanceof PortalAuthError) {
    return {
      status: 503,
      code: 'portal_auth_failed',
      message: 'This service could not authenticate with the upstream portal.',
    };
  }
  if (error instanceof PortalCircuitOpen) {
    return {
      status: 503,
      code: 'portal_circuit_open',
      message: 'The upstream portal is failing; requests are paused briefly. Retry shortly.',
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error instanceof PortalUnavailable) {
    return TIMEOUT_ERROR_NAMES.has(error.cause?.name)
      ? { status: 504, code: 'portal_timeout', message: 'The upstream portal timed out.' }
      : {
          status: 502,
          code: 'portal_unavailable',
          message: 'The upstream portal is unavailable.',
        };
  }
  if (error instanceof PortalParseError) {
    return {
      status: 502,
      code: 'portal_bad_response',
      message: 'The upstream portal returned a response this service could not read.',
    };
  }
  if (error instanceof PortalError) {
    return { status: 502, code: 'portal_error', message: 'The upstream portal request failed.' };
  }
  if (error.statusCode >= 400 && error.statusCode < 500) {
    return { status: error.statusCode, code: 'bad_request', message: error.message };
  }
  return { status: 500, code: 'internal_error', message: 'Internal server error.' };
}

function body(request, { code, message }) {
  return { error: { code, message, request_id: String(request.id) } };
}

/**
 * Install the single error shape for every failure, including unknown routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerErrorHandlers(app) {
  app.setErrorHandler((error, request, reply) => {
    const result = classify(error, request);
    request.log[result.status >= 500 ? 'error' : 'warn'](
      { err: error, code: result.code, status: result.status },
      'request failed',
    );
    if (result.retryAfterSeconds) reply.header('retry-after', result.retryAfterSeconds);
    return reply.status(result.status).send(body(request, result));
  });

  app.setNotFoundHandler((request, reply) => {
    const result = {
      code: 'route_not_found',
      message: `No route for ${request.method} ${request.url.split('?')[0]}.`,
    };
    request.log.warn({ code: result.code }, 'route not found');
    return reply.status(404).send(body(request, result));
  });
}
