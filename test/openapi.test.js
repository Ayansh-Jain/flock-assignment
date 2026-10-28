import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { generateOpenApiJson } from '../src/openapi.js';

test('committed openapi.json matches the route schemas', async () => {
  const committed = await readFile(new URL('../openapi.json', import.meta.url), 'utf8');
  assert.equal(
    committed,
    await generateOpenApiJson(),
    'openapi.json is out of date: run `npm run openapi` and commit the result.',
  );
});

test('generated document is OpenAPI 3.x and documents every route', async () => {
  const document = JSON.parse(await generateOpenApiJson());
  assert.match(document.openapi, /^3\./);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/health',
    '/v1/meters',
    '/v1/meters/near',
    '/v1/meters/{meterId}',
    '/v1/meters/{meterId}/consumption',
    '/v1/meters/{meterId}/consumption/daily',
    '/v1/network',
    '/v1/network/issues',
    '/v1/network/{nodeCode}',
    '/v1/network/{nodeCode}/meters',
    '/v1/sync/status',
    '/v1/transformers',
  ]);
});
