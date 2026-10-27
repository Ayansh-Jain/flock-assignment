import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * Generate the OpenAPI document from the route schemas. No portal call is made: the service
 * is a stub and the config holds placeholders.
 *
 * @returns {Promise<string>} Pretty-printed JSON with a trailing newline.
 */
export async function generateOpenApiJson() {
  const config = loadConfig({
    PORTAL_BASE_URL: 'https://portal.invalid',
    PORTAL_USERNAME: 'unused',
    PORTAL_PASSWORD: 'unused',
  });
  const app = await buildApp({ config, service: {}, logger: false });
  try {
    await app.ready();
    return `${JSON.stringify(app.swagger(), null, 2)}\n`;
  } finally {
    await app.close();
  }
}
