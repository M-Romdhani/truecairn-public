import { materializeGoogleCredentials } from './ai/credentials.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  // Bridge Railway's env-only secrets to Vertex's file-based ADC before anything
  // reads config or makes an AI call. No-op unless GOOGLE_SERVICE_ACCOUNT_JSON is set.
  materializeGoogleCredentials();
  const config = loadConfig();
  // AI config is the one place we log-and-continue rather than refuse boot (plan
  // §4 task 0.3): if the master switch is on but no Gemini credential resolved,
  // the AI features stay off and the product runs unaffected. A single greppable
  // boot line so the operator can see WHY the dashboard's AI cards are quiet.
  if (config.ai.enabled && !config.aiBriefing.enabled) {
    process.stderr.write(
      '[ai] AI_ENABLED but no Gemini credential resolved; AI features disabled (product unaffected)\n',
    );
  } else if (!config.ai.enabled) {
    process.stderr.write('[ai] AI_ENABLED=false; all AI surfaces return the disabled response\n');
  }
  const app = buildApp(config);

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'api.shutdown');
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error({ err }, 'api.listen_failed');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[api] fatal:', err);
  process.exit(1);
});
