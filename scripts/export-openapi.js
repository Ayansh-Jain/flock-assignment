// Writes ./openapi.json from the route schemas. Run: npm run openapi
import { writeFile } from 'node:fs/promises';
import { generateOpenApiJson } from '../src/openapi.js';

await writeFile(new URL('../openapi.json', import.meta.url), await generateOpenApiJson(), 'utf8');
console.log('wrote openapi.json');
