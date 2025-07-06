import { cleanEnv, str, num } from 'envalid';
import dotenv from 'dotenv';

dotenv.config();

const env = cleanEnv(process.env, {
  PORT: num({ default: 3000 }),
  HOST: str({ default: '0.0.0.0' }),
  REQUEST_TIMEOUT: num({ default: 60000 }),
  WORKERS: num({ default: undefined, optional: true }),
  NUM_WORKERS: num({ default: undefined, optional: true }),
  SSL_KEY: str({ optional: true }),
  SSL_CERT: str({ optional: true }),
  SSL_CA: str({ optional: true }),
  CONTENTS_DIR: str({ default: 'contents', optional: true }),
  DATA_DIR: str({ default: 'data', optional: true }),
  MCP_SERVER_URL: str({ optional: true }),
  APP_ROOT_DIR: str({ optional: true }),
  BRAVE_SEARCH_API_KEY: str({ optional: true }),
  BRAVE_SEARCH_ENDPOINT: str({ default: 'https://api.search.brave.com/res/v1/web/search', optional: true }),
  OPENAI_API_KEY: str({ optional: true }),
  OPENAI_IMAGE_API_KEY: str({ optional: true }),
  ANTHROPIC_API_KEY: str({ optional: true }),
  GOOGLE_API_KEY: str({ optional: true }),
  GOOGLE_IMAGEN_API_KEY: str({ optional: true }),
  LOCAL_API_KEY: str({ optional: true }),
  DEFAULT_API_KEY: str({ optional: true })
}, {
  reporter: () => {}, // Disable envalid's default reporter that shows missing variables
  dotEnvPath: null    // Disable envalid's own dotenv loading since we handle it ourselves
});

const config = Object.freeze({
  ...process.env,
  PORT: env.PORT,
  HOST: env.HOST,
  REQUEST_TIMEOUT: env.REQUEST_TIMEOUT,
  WORKERS: env.WORKERS ?? env.NUM_WORKERS ?? 1,
  SSL_KEY: env.SSL_KEY,
  SSL_CERT: env.SSL_CERT,
  SSL_CA: env.SSL_CA,
  CONTENTS_DIR: env.CONTENTS_DIR,
  DATA_DIR: env.DATA_DIR,
  MCP_SERVER_URL: env.MCP_SERVER_URL,
  APP_ROOT_DIR: env.APP_ROOT_DIR,
  BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY,
  BRAVE_SEARCH_ENDPOINT: env.BRAVE_SEARCH_ENDPOINT,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  OPENAI_IMAGE_API_KEY: env.OPENAI_IMAGE_API_KEY,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  GOOGLE_API_KEY: env.GOOGLE_API_KEY,
  GOOGLE_IMAGEN_API_KEY: env.GOOGLE_IMAGEN_API_KEY,
  LOCAL_API_KEY: env.LOCAL_API_KEY,
  DEFAULT_API_KEY: env.DEFAULT_API_KEY
});

export default config;
