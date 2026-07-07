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
    BRAVE_SEARCH_API_KEY: str({ optional: true }),
    BRAVE_SEARCH_ENDPOINT: str({
      default: 'https://api.search.brave.com/res/v1/web/search',
      optional: true
    }),
    OPENAI_API_KEY: str({ optional: true }),
    ANTHROPIC_API_KEY: str({ optional: true }),
    MISTRAL_API_KEY: str({ optional: true }),
    GOOGLE_API_KEY: str({ optional: true }),
    LOCAL_API_KEY: str({ optional: true }),
    DEFAULT_API_KEY: str({ optional: true }),
    AUTH_MODE: str({ default: 'proxy', optional: true }),
    PROXY_AUTH_ENABLED: str({ optional: true }),
    PROXY_AUTH_USER_HEADER: str({ optional: true }),
    PROXY_AUTH_GROUPS_HEADER: str({ optional: true }),
    PROXY_AUTH_JWKS: str({ optional: true }),
    PROXY_AUTH_JWT_HEADER: str({ optional: true }),
    HTTP_PROXY: str({ optional: true }),
    HTTPS_PROXY: str({ optional: true }),
    NO_PROXY: str({ optional: true }),
    JWT_SECRET: str({ optional: true }),
    USE_HTTPS: str({ default: 'false', optional: true }),
    NODE_ENV: str({ default: 'development', optional: true }),
    IASSISTANT_TIMEOUT: num({ default: 60000 }),
    IFINDER_API_URL: str({ optional: true }),
    IFINDER_DOWNLOAD_DIR: str({ default: '/tmp/ifinder-downloads', optional: true }),
    IFINDER_PRIVATE_KEY: str({ optional: true }),
    IFINDER_TIMEOUT: num({ default: 30000 }),
    MAGIC_PROMPT_MODEL: str({ optional: true }),
    MAGIC_PROMPT_PROMPT: str({ optional: true }),
    SEARCH_CACHE_TTL_MS: num({ optional: true })
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
  BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY,
  BRAVE_SEARCH_ENDPOINT: env.BRAVE_SEARCH_ENDPOINT,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  MISTRAL_API_KEY: env.MISTRAL_API_KEY,
  GOOGLE_API_KEY: env.GOOGLE_API_KEY,
  LOCAL_API_KEY: env.LOCAL_API_KEY,
  DEFAULT_API_KEY: env.DEFAULT_API_KEY,
  AUTH_MODE: env.AUTH_MODE,
  PROXY_AUTH_ENABLED: env.PROXY_AUTH_ENABLED,
  PROXY_AUTH_USER_HEADER: env.PROXY_AUTH_USER_HEADER,
  PROXY_AUTH_GROUPS_HEADER: env.PROXY_AUTH_GROUPS_HEADER,
  PROXY_AUTH_JWKS: env.PROXY_AUTH_JWKS,
  PROXY_AUTH_JWT_HEADER: env.PROXY_AUTH_JWT_HEADER,
  HTTP_PROXY: env.HTTP_PROXY,
  HTTPS_PROXY: env.HTTPS_PROXY,
  NO_PROXY: env.NO_PROXY,
  JWT_SECRET: env.JWT_SECRET,
  USE_HTTPS: env.USE_HTTPS,
  NODE_ENV: env.NODE_ENV,
  IASSISTANT_TIMEOUT: env.IASSISTANT_TIMEOUT,
  IFINDER_API_URL: env.IFINDER_API_URL,
  IFINDER_DOWNLOAD_DIR: env.IFINDER_DOWNLOAD_DIR,
  IFINDER_PRIVATE_KEY: env.IFINDER_PRIVATE_KEY,
  IFINDER_TIMEOUT: env.IFINDER_TIMEOUT,
  MAGIC_PROMPT_MODEL: env.MAGIC_PROMPT_MODEL,
  MAGIC_PROMPT_PROMPT: env.MAGIC_PROMPT_PROMPT,
  SEARCH_CACHE_TTL_MS: env.SEARCH_CACHE_TTL_MS
});

export default config;
