import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliConfig {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly alertEmail?: string;
}

export function configPath() {
  return join(homedir(), '.config', 'uptime-monitor', 'config.json');
}

export function readCliConfig(path = configPath()): CliConfig {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read CLI configuration at ${path}: ${errorDetail(cause)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`CLI configuration at ${path} must be a JSON object.`);
  }

  const config: { baseUrl?: string; token?: string; alertEmail?: string } = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'baseUrl' && key !== 'token' && key !== 'alertEmail') continue;
    if (typeof item !== 'string') {
      throw new Error(`CLI configuration field ${key} at ${path} must be a string.`);
    }
    if (key === 'baseUrl') config.baseUrl = normalizeBaseUrl(item);
    if (key === 'token') config.token = normalizeToken(item);
    if (key === 'alertEmail') config.alertEmail = normalizeEmail(item);
  }
  return config;
}

export function writeCliConfig(config: CliConfig, path = configPath()) {
  const normalized = normalizeConfig(config);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.config.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function normalizeBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter an HTTP(S) Worker origin, such as https://uptime-monitor.example.workers.dev.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The Worker URL must use HTTP or HTTPS.');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('The Worker URL must be an origin without a path, query, fragment, or credentials.');
  }
  return url.origin;
}

export function normalizeToken(value: string) {
  const token = value.trim();
  if (!token) throw new Error('Enter a non-empty API token.');
  if (/\s/.test(token)) throw new Error('The API token cannot contain whitespace.');
  return token;
}

export function normalizeEmail(value: string) {
  const email = value.trim();
  if (!email) throw new Error('Alert destination cannot be empty.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}

function normalizeConfig(config: CliConfig): CliConfig {
  return {
    ...(config.baseUrl === undefined ? {} : { baseUrl: normalizeBaseUrl(config.baseUrl) }),
    ...(config.token === undefined ? {} : { token: normalizeToken(config.token) }),
    ...(config.alertEmail === undefined ? {} : { alertEmail: normalizeEmail(config.alertEmail) }),
  };
}

function errorDetail(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}
