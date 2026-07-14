import { cleanEnv, str, num } from 'envalid';
import dotenv from 'dotenv';

dotenv.config();

// Configuration supports both provider-specific and model-specific API keys:
// - Provider-specific: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
// - Model-specific: {MODEL_ID}_API_KEY (e.g., GPT_4_AZURE1_API_KEY for model id "gpt-4-azure1")
// Model-specific keys take precedence over provider-specific keys.

const env = cleanEnv(
  process.env,
  {
    PORT: num({ default: 3000 }),
    HOST: str({ default: '0.0.0.0' }),
    REQUEST_TIMEOUT: num({ default: 300000 }), // 5 minutes for streaming/generation requests
    WORKERS: num({ default: undefined, optional: true }),
    NUM_WORKERS: num({ default: undefined, optional: true }),
    SSL_KEY: str({ optional: true }),
    SSL_CERT: str({ optional: true }),
    SSL_CA: str({ optional: true }),
    CONTENTS_DIR: str({ default: 'contents', optional: true }),
    DATA_DIR: str({ default: 'data', optional: true }),
    APP_ROOT_DIR: str({ optional: true }),
    AUTH_MODE: str({ default: 'proxy', optional: true }),
    PROXY_AUTH_ENABLED: str({ optional: true }),
    PROXY_AUTH_USER_HEADER: str({ optional: true }),
    PROXY_AUTH_GROUPS_HEADER: str({ optional: true }),
    PROXY_AUTH_JWKS: str({ optional: true }),
    PROXY_AUTH_JWT_HEADER: str({ optional: true }),
    HTTP_PROXY: str({ optional: true }),
    HTTPS_PROXY: str({ optional: true }),
    NO_PROXY: str({ optional: true }),
    USE_HTTPS: str({ default: 'false', optional: true }),
    NODE_ENV: str({ default: 'development', optional: true }),
    DATABASE_URL: str({ optional: true })
  },
  {
    reporter: () => {}, // Disable envalid's default reporter that shows missing variables
    dotEnvPath: null // Disable envalid's own dotenv loading since we handle it ourselves
  }
);

// Provider- and model-specific API keys (e.g. COHERE_API_KEY, GPT_4_AZURE1_API_KEY for
// model id "gpt-4-azure1") are looked up dynamically by name in utils.js and can't be
// enumerated in the schema above, since the set of providers/models is defined in JSON
// config rather than known statically. Pass through only vars matching that one pattern
// instead of the entire process environment, so undeclared/unrelated env vars stay out
// of the exported config.
const dynamicApiKeys = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.endsWith('_API_KEY'))
);

const config = Object.freeze({
  ...dynamicApiKeys,
  PORT: env.PORT,
  HOST: env.HOST,
  REQUEST_TIMEOUT: env.REQUEST_TIMEOUT,
  WORKERS: env.WORKERS ?? env.NUM_WORKERS ?? 4,
  SSL_KEY: env.SSL_KEY,
  SSL_CERT: env.SSL_CERT,
  SSL_CA: env.SSL_CA,
  CONTENTS_DIR: env.CONTENTS_DIR,
  DATA_DIR: env.DATA_DIR,
  APP_ROOT_DIR: env.APP_ROOT_DIR,
  AUTH_MODE: env.AUTH_MODE,
  PROXY_AUTH_ENABLED: env.PROXY_AUTH_ENABLED,
  PROXY_AUTH_USER_HEADER: env.PROXY_AUTH_USER_HEADER,
  PROXY_AUTH_GROUPS_HEADER: env.PROXY_AUTH_GROUPS_HEADER,
  PROXY_AUTH_JWKS: env.PROXY_AUTH_JWKS,
  PROXY_AUTH_JWT_HEADER: env.PROXY_AUTH_JWT_HEADER,
  HTTP_PROXY: env.HTTP_PROXY,
  HTTPS_PROXY: env.HTTPS_PROXY,
  NO_PROXY: env.NO_PROXY,
  USE_HTTPS: env.USE_HTTPS,
  NODE_ENV: env.NODE_ENV,
  DATABASE_URL: env.DATABASE_URL
});

export default config;
