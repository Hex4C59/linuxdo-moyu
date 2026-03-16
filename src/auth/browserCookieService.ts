import * as crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MACOS_KEYCHAIN_PATH = '/usr/bin/security';
const SQLITE_PATH_CANDIDATES = [
  '/usr/bin/sqlite3',
  '/opt/homebrew/bin/sqlite3',
  '/usr/local/bin/sqlite3',
];
const SUPPORTED_DOMAIN = 'linux.do';

interface BrowserDefinition {
  id: string;
  label: string;
  safeStorageService: string;
  userDataPath: string;
}

interface CookieRow {
  name: string;
  value: string;
  encryptedValueHex: string;
  hostKey: string;
  cookiePath: string;
}

export interface BrowserCookieProfile {
  id: string;
  browserLabel: string;
  profileLabel: string;
  cookieDbPath: string;
  safeStorageService: string;
}

export interface ImportedCookieBundle {
  cookieHeader: string;
  cookieCount: number;
  sourceLabel: string;
  hasClearanceCookie: boolean;
  hasSessionCookie: boolean;
}

const BROWSER_DEFINITIONS: BrowserDefinition[] = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    safeStorageService: 'Chrome Safe Storage',
    userDataPath: '~/Library/Application Support/Google/Chrome',
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    safeStorageService: 'Microsoft Edge Safe Storage',
    userDataPath: '~/Library/Application Support/Microsoft Edge',
  },
  {
    id: 'brave',
    label: 'Brave',
    safeStorageService: 'Brave Safe Storage',
    userDataPath: '~/Library/Application Support/BraveSoftware/Brave-Browser',
  },
  {
    id: 'arc',
    label: 'Arc',
    safeStorageService: 'Arc',
    userDataPath: '~/Library/Application Support/Arc/User Data',
  },
  {
    id: 'chromium',
    label: 'Chromium',
    safeStorageService: 'Chromium Safe Storage',
    userDataPath: '~/Library/Application Support/Chromium',
  },
];

export class BrowserCookieService {
  public async listAvailableProfiles(): Promise<BrowserCookieProfile[]> {
    const profiles: BrowserCookieProfile[] = [];

    for (const browser of BROWSER_DEFINITIONS) {
      const profileRoot = this.expandHome(browser.userDataPath);
      const directoryEntries = await this.readDirectory(profileRoot);

      for (const entry of directoryEntries) {
        if (!entry.isDirectory() || !this.isProfileDirectory(entry.name)) {
          continue;
        }

        const profileDirectory = path.join(profileRoot, entry.name);
        const cookieDbPath = await this.resolveCookieDbPath(profileDirectory);
        if (!cookieDbPath) {
          continue;
        }

        profiles.push({
          id: `${browser.id}:${entry.name}`,
          browserLabel: browser.label,
          profileLabel: this.formatProfileLabel(entry.name),
          cookieDbPath,
          safeStorageService: browser.safeStorageService,
        });
      }
    }

    return profiles.sort((left, right) => {
      const browserComparison = left.browserLabel.localeCompare(right.browserLabel, 'zh-CN');
      if (browserComparison !== 0) {
        return browserComparison;
      }
      return left.profileLabel.localeCompare(right.profileLabel, 'zh-CN');
    });
  }

  public async importLinuxDoCookie(profile: BrowserCookieProfile): Promise<ImportedCookieBundle> {
    const cookieRows = await this.readCookieRows(profile.cookieDbPath);
    if (cookieRows.length === 0) {
      throw new Error(`在 ${profile.browserLabel}（${profile.profileLabel}）里没有找到 ${SUPPORTED_DOMAIN} 的 Cookie。`);
    }

    const safeStoragePassword = await this.readSafeStoragePassword(profile.safeStorageService);
    const decryptionKey = this.deriveChromeKey(safeStoragePassword);
    const cookieMap = new Map<string, string>();

    for (const row of cookieRows) {
      if (!this.isLinuxDoCookieDomain(row.hostKey)) {
        continue;
      }

      const cookieValue = row.value || this.decryptCookieValue(row.encryptedValueHex, row.hostKey, decryptionKey);
      if (!cookieValue || cookieMap.has(row.name)) {
        continue;
      }
      cookieMap.set(row.name, cookieValue);
    }

    if (cookieMap.size === 0) {
      throw new Error(`在 ${profile.browserLabel}（${profile.profileLabel}）里找到了 Cookie 记录，但没有成功解密出可用值。`);
    }

    const cookieHeader = Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    return {
      cookieHeader,
      cookieCount: cookieMap.size,
      sourceLabel: `${profile.browserLabel} / ${profile.profileLabel}`,
      hasClearanceCookie: cookieMap.has('cf_clearance'),
      hasSessionCookie: cookieMap.has('_t') || cookieMap.has('_forum_session'),
    };
  }

  private async readCookieRows(cookieDbPath: string): Promise<CookieRow[]> {
    const sqlitePath = await this.resolveSqlite3Path();
    const tempDbPath = path.join(os.tmpdir(), `linuxdo-moyu-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);

    await fs.copyFile(cookieDbPath, tempDbPath);

    try {
      const sql = [
        'SELECT json_group_array(json_object(',
        "'name', name,",
        "'value', value,",
        "'encryptedValueHex', hex(encrypted_value),",
        "'hostKey', host_key,",
        "'cookiePath', path",
        '))',
        'FROM cookies',
        'WHERE host_key = \'linux.do\' OR host_key = \'.linux.do\' OR host_key LIKE \'%.linux.do\'',
        'ORDER BY CASE WHEN host_key = \'linux.do\' THEN 0 WHEN host_key = \'.linux.do\' THEN 1 ELSE 2 END, length(path) DESC, name ASC;',
      ].join(' ');

      const { stdout } = await execFile(sqlitePath, ['-readonly', tempDbPath, sql], {
        encoding: 'utf8',
      });

      const parsed = JSON.parse(stdout.trim() || '[]') as CookieRow[] | null;
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new Error(`读取浏览器 Cookie 数据库失败：${this.getErrorMessage(error)}`);
    } finally {
      await fs.unlink(tempDbPath).catch(() => undefined);
    }
  }

  private async readSafeStoragePassword(serviceName: string): Promise<string> {
    const attempts = [
      () => this.readSafeStoragePasswordDirect(serviceName),
      () => this.readSafeStoragePasswordViaShell(serviceName),
    ];
    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        const password = await attempt();
        if (password) {
          return password;
        }
      } catch (error) {
        errors.push(this.formatKeychainError(error));
      }
    }

    throw new Error(
      `无法从 macOS Keychain 读取“${serviceName}”密钥。请确认浏览器已正常启动过，并在“钥匙串访问”里允许 Visual Studio Code 或 /usr/bin/security 访问该条目。最近错误：${errors.at(-1) || '未知错误'}`,
    );
  }

  private async readSafeStoragePasswordDirect(serviceName: string): Promise<string> {
    const { stdout } = await execFile(MACOS_KEYCHAIN_PATH, ['find-generic-password', '-w', '-s', serviceName], {
      encoding: 'utf8',
    });
    return stdout.trim();
  }

  private async readSafeStoragePasswordViaShell(serviceName: string): Promise<string> {
    const { stdout } = await execFile('/bin/zsh', ['-lc', `/usr/bin/security find-generic-password -w -s ${this.quoteShellArg(serviceName)}`], {
      encoding: 'utf8',
    });
    return stdout.trim();
  }

  private deriveChromeKey(safeStoragePassword: string): Buffer {
    return crypto.pbkdf2Sync(safeStoragePassword, 'saltysalt', 1003, 16, 'sha1');
  }

  private decryptCookieValue(encryptedValueHex: string, hostKey: string, decryptionKey: Buffer): string {
    if (!encryptedValueHex) {
      return '';
    }

    const encryptedValue = Buffer.from(encryptedValueHex, 'hex');
    if (encryptedValue.length === 0) {
      return '';
    }

    const versionPrefix = encryptedValue.subarray(0, 3).toString('utf8');
    if (versionPrefix !== 'v10' && versionPrefix !== 'v11') {
      return encryptedValue.toString('utf8');
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', decryptionKey, Buffer.alloc(16, 0x20));
    const decrypted = Buffer.concat([
      decipher.update(encryptedValue.subarray(3)),
      decipher.final(),
    ]);

    const hostDigest = crypto.createHash('sha256').update(hostKey).digest();
    const plaintext = decrypted.subarray(0, hostDigest.length).equals(hostDigest)
      ? decrypted.subarray(hostDigest.length)
      : decrypted;

    return plaintext.toString('utf8');
  }

  private async resolveCookieDbPath(profileDirectory: string): Promise<string | undefined> {
    const candidates = [
      path.join(profileDirectory, 'Network', 'Cookies'),
      path.join(profileDirectory, 'Cookies'),
    ];

    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private async resolveSqlite3Path(): Promise<string> {
    for (const candidate of SQLITE_PATH_CANDIDATES) {
      if (await this.isExecutable(candidate)) {
        return candidate;
      }
    }

    try {
      const { stdout } = await execFile('/usr/bin/env', ['which', 'sqlite3'], {
        encoding: 'utf8',
      });
      const resolved = stdout.trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // ignore and throw below
    }

    throw new Error('没有找到 sqlite3 命令，无法读取浏览器 Cookie 数据库。请先安装 sqlite3，或改用手动粘贴 Cookie。');
  }

  private async isExecutable(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async readDirectory(directoryPath: string): Promise<Dirent[]> {
    try {
      return await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private isProfileDirectory(name: string): boolean {
    return name === 'Default'
      || name === 'Guest Profile'
      || /^Profile\s+\d+$/.test(name)
      || /^Person\s+\d+$/.test(name);
  }

  private formatProfileLabel(profileName: string): string {
    if (profileName === 'Default') {
      return '默认配置';
    }
    if (profileName === 'Guest Profile') {
      return '访客配置';
    }
    return profileName;
  }

  private isLinuxDoCookieDomain(hostKey: string): boolean {
    return hostKey === 'linux.do' || hostKey === '.linux.do';
  }

  private expandHome(filePath: string): string {
    if (!filePath.startsWith('~/')) {
      return filePath;
    }
    return path.join(os.homedir(), filePath.slice(2));
  }

  private formatKeychainError(error: unknown): string {
    const message = this.getErrorMessage(error);
    if (message.includes('could not be found')) {
      return '钥匙串中不存在对应的 Safe Storage 条目';
    }
    if (message.includes('User interaction is not allowed')) {
      return '钥匙串拒绝了当前进程访问，可能需要你在系统弹窗中点“始终允许”';
    }
    if (message.includes('The specified item could not be found in the keychain')) {
      return '钥匙串中没有找到对应条目';
    }
    return message;
  }

  private quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || '未知错误');
  }
}
