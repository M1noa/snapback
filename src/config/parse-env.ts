// parses, validates, and freezes the environment. a missing key has to name
// itself at boot, not surface as undefined three layers deep.
//
// nothing here reads Bun.env or writes to the process: parsing is a pure
// function of a key lookup, so tests drive it with a plain map. env.ts is the
// binding that reads the real environment and exits on a problem.

export type IpStorage = "hash" | "encrypted" | "plaintext";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface EnvWarning {
  readonly key: string;
  readonly text: string;
}

export interface Env {
  readonly discord: {
    readonly token: string;
    readonly ownerId: string;
    /** the application id: the oauth client_id and the invite url both come from it. */
    readonly clientId: string;
    readonly devGuildId: string | undefined;
  };
  readonly db: {
    readonly url: string | undefined;
    readonly file: string;
    readonly isPostgres: boolean;
  };
  readonly web: {
    readonly publicBaseUrl: string;
    readonly port: number;
    readonly behindCloudflareTunnel: boolean;
    readonly trustedProxyDepth: number;
  };
  readonly privacy: {
    readonly ipStorage: IpStorage;
    readonly ipHashPepper: string;
    readonly encryptionKey: string;
    readonly tokenStorage: boolean;
  };
  readonly intel: {
    readonly enabled: boolean;
    readonly countryMmdb: string;
    readonly asCsv: string;
  };
  readonly limits: {
    // the only limit that is a property of the machine, not of the guild.
    // everything else lives in the guild's settings_json (config/defaults.ts).
    readonly maxConcurrentJobs: number;
  };
  readonly oauth: {
    /** the client secret from the developer portal. required: the verify
     *  callback is a core feature, not an option. */
    readonly clientSecret: string;
  };
  readonly storage: {
    readonly backupDir: string;
    readonly exportDir: string;
    readonly maxAssetBytes: number;
  };
  readonly app: {
    readonly logLevel: LogLevel;
    readonly automationEnabled: boolean;
  };
}

export type EnvSource = (key: string) => string | undefined;

// an empty string in a .env is a key the operator left blank, not a value.
export function readProcessEnv(key: string): string | undefined {
  const value = Bun.env[key]?.trim();
  return value === "" ? undefined : value;
}

export type EnvResult =
  | { readonly ok: true; readonly env: Env; readonly warnings: readonly EnvWarning[] }
  | { readonly ok: false; readonly problems: readonly string[] };

export function parseEnv(read: EnvSource): EnvResult {
  const problems: string[] = [];
  const warnings: EnvWarning[] = [];

  // `how` is the one thing the operator needs to fix it, so it prints with the miss.
  function required(key: string, how: string): string {
    const value = read(key);
    if (value === undefined) problems.push(`${key} is not set. ${how}`);
    return value ?? "";
  }

  function optional(key: string, fallback: string): string {
    return read(key) ?? fallback;
  }

  function int(key: string, fallback: number, min: number, max: number): number {
    const value = read(key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      warnings.push({ key, text: `expected an integer, keeping ${fallback}` });
      return fallback;
    }
    // the hard ceilings are clamped here, not trusted from the file. a limit
    // enforced only by documentation is not a limit.
    const clamped = Math.min(Math.max(parsed, min), max);
    if (clamped !== parsed) {
      warnings.push({ key, text: `${parsed} is outside ${min}-${max}, clamped to ${clamped}` });
    }
    return clamped;
  }

  function bool(key: string, fallback: boolean): boolean {
    const value = read(key);
    if (value === undefined) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    warnings.push({ key, text: `expected true or false, keeping ${fallback}` });
    return fallback;
  }

  function pick<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = read(key);
    if (value === undefined) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    warnings.push({ key, text: `expected one of ${allowed.join(" | ")}, keeping ${fallback}` });
    return fallback;
  }

  const token = required("DISCORD_TOKEN", "bot token from the Discord developer portal, Bot tab.");
  const ownerId = required(
    "DISCORD_OWNER_ID",
    "your own user id, the account that always has owner powers.",
  );
  const clientId = required(
    "DISCORD_CLIENT_ID",
    "the application id from the developer portal, General Information tab. the oauth client_id and the invite url both come from it.",
  );
  const publicBaseUrl = required(
    "PUBLIC_BASE_URL",
    "the https origin the verify button points at, no trailing slash.",
  );

  const ipStorage = pick<IpStorage>("IP_STORAGE", ["hash", "encrypted", "plaintext"], "plaintext");
  const ipHashPepper = optional("IP_HASH_PEPPER", "");
  const encryptionKey = optional("ENCRYPTION_KEY", "");
  const oauthSecret = required(
    "OAUTH_CLIENT_SECRET",
    "the client secret from the developer portal, OAuth2 tab. the verification callback is a core feature and does not work without it.",
  );

  if (ipStorage === "hash" && ipHashPepper === "") {
    problems.push(
      "IP_HASH_PEPPER is not set. Required when IP_STORAGE=hash, any long random string.",
    );
  }

  if (ipStorage === "encrypted" && encryptionKey === "") {
    problems.push(
      "ENCRYPTION_KEY is not set. Required when IP_STORAGE=encrypted, 32 random bytes base64.",
    );
  }

  if (encryptionKey !== "") {
    const bytes = Buffer.from(encryptionKey, "base64");
    if (bytes.length !== 32) {
      problems.push(
        `ENCRYPTION_KEY must decode to 32 bytes, got ${bytes.length}. Run: openssl rand -base64 32`,
      );
    }
  }

  // token storage needs the key, and pull is the only feature that needs tokens.
  // without the key the feature is off, not half-on.
  const tokenStorage = encryptionKey !== "";

  if (ipStorage === "plaintext") {
    warnings.push({
      key: "IP_STORAGE",
      text: "captured IP addresses are personal data; you are responsible for them. See docs/scopes.md",
    });
  }

  if (!tokenStorage) {
    warnings.push({
      key: "ENCRYPTION_KEY",
      text: "not set, so token storage and /pull are unavailable",
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  const databaseUrl = read("DATABASE_URL");

  return {
    ok: true,
    warnings,
    env: Object.freeze({
      discord: Object.freeze({
        token,
        ownerId,
        clientId,
        devGuildId: read("DISCORD_DEV_GUILD_ID"),
      }),

      db: Object.freeze({
        // undefined means the DuckDB file, the default install.
        url: databaseUrl,
        file: optional("DB_FILE", "./data/snapback.duckdb"),
        isPostgres: databaseUrl !== undefined,
      }),

      web: Object.freeze({
        publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
        port: int("PORT", 8080, 1, 65_535),
        behindCloudflareTunnel: bool("BEHIND_CLOUDFLARE_TUNNEL", false),
        trustedProxyDepth: int("TRUSTED_PROXY_DEPTH", 0, 0, 5),
      }),

      privacy: Object.freeze({ ipStorage, ipHashPepper, encryptionKey, tokenStorage }),

      intel: Object.freeze({
        enabled: bool("INTEL_ENABLED", true),
        countryMmdb: optional("DBIP_COUNTRY_MMDB", "./data/dbip-country-lite.mmdb"),
        asCsv: optional("AS_METADATA_CSV", "./data/as.csv"),
      }),

      limits: Object.freeze({
        // the only limit that is a property of the machine, not of the guild.
        // everything else lives in the guild's settings_json and is edited by
        // /setup (config/defaults.ts).
        maxConcurrentJobs: int("MAX_CONCURRENT_JOBS", 2, 1, 16),
      }),

      oauth: Object.freeze({
        clientSecret: oauthSecret,
      }),

      storage: Object.freeze({
        // backups/<id>/assets/ lands under here. the db file's sibling by default.
        backupDir: optional("BACKUP_DIR", "./data/backups"),
        // a written export lands here and is swept by expiry (D4PLAN 17.4).
        exportDir: optional("EXPORT_DIR", "./data/exports"),
        // D4PLAN 11.1: a file over this is recorded with its url and no bytes
        // rather than downloaded. 0 means record every asset and download none.
        maxAssetBytes: int("MAX_ASSET_BYTES", 8 * 1024 * 1024, 0, 100 * 1024 * 1024),
      }),

      app: Object.freeze({
        logLevel: pick<LogLevel>("LOG_LEVEL", ["debug", "info", "warn", "error"], "info"),
        automationEnabled: bool("AUTOMATION_ENABLED", true),
      }),
    }),
  };
}
