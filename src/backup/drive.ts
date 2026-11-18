// Google Drive（SPEC 6.2）：Google Identity Services token client + Drive REST v3，純前端。
// 權限只用 drive.file：App 只看得到自己建立的檔案。登入元件只在需要時才載入，離線時不影響 App。

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_NAME = 'DB-radar 備份';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** 建置時由 GitHub Actions 的 repo 變數帶入，不寫在程式碼裡 */
export const DEFAULT_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

export class DriveAuthError extends Error {}
export class DriveError extends Error {}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void;
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(o: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
}
declare global {
  interface Window {
    google?: Gis;
  }
}

let gisPromise: Promise<Gis> | null = null;

function loadGis(): Promise<Gis> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  gisPromise ??= new Promise<Gis>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google ? resolve(window.google) : reject(new DriveError('Google 登入元件載入失敗')));
    s.onerror = () => {
      gisPromise = null;
      reject(new DriveError('Google 登入元件載入失敗，請確認網路'));
    };
    document.head.append(s);
  });
  return gisPromise;
}

let token: string | null = null;
let tokenExp = 0;

export const hasToken = (): boolean => !!token && Date.now() < tokenExp - 60_000;

/**
 * 取得存取權杖。interactive = false 時不跳出任何畫面（prompt: 'none'），
 * 只有在 Google 帳號已登入、而且之前授權過時才會成功。
 */
export async function authorize(clientId: string, interactive: boolean): Promise<void> {
  if (!clientId) throw new DriveAuthError('還沒有設定 Google 用戶端 ID');
  const gis = await loadGis();
  await new Promise<void>((resolve, reject) => {
    const tc = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          reject(new DriveAuthError(r.error === 'access_denied' ? '沒有同意存取 Google Drive' : 'Google 登入失敗'));
          return;
        }
        token = r.access_token;
        tokenExp = Date.now() + (r.expires_in ?? 3600) * 1000;
        resolve();
      },
      error_callback: (e) =>
        reject(new DriveAuthError(e?.type === 'popup_closed' ? '登入視窗被關掉了' : '需要重新登入 Google')),
    });
    tc.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}

export function signOut(): void {
  const t = token;
  token = null;
  tokenExp = 0;
  if (t) void loadGis().then((g) => g.accounts.oauth2.revoke(t)).catch(() => undefined);
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!hasToken()) throw new DriveAuthError('需要重新登入 Google');
  const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (r.status === 401) {
    token = null;
    throw new DriveAuthError('Google 登入已過期');
  }
  if (!r.ok) throw new DriveError(`Google Drive 回應 ${r.status}`);
  return r;
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdTime: string;
}

const q = (s: string) => encodeURIComponent(s);

/** 找「DB-radar 備份」資料夾（drive.file 只看得到 App 自己建立的），沒有就建立 */
export async function ensureFolder(knownId: string | null): Promise<string> {
  if (knownId) {
    try {
      const r = await gfetch(`${API}/files/${knownId}?fields=id,trashed`);
      const f = (await r.json()) as { id: string; trashed?: boolean };
      if (!f.trashed) return f.id;
    } catch (e) {
      if (e instanceof DriveAuthError) throw e;
    }
  }
  const query = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await gfetch(`${API}/files?q=${q(query)}&fields=files(id)&spaces=drive`);
  const found = ((await r.json()) as { files: { id: string }[] }).files[0];
  if (found) return found.id;
  const c = await gfetch(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return ((await c.json()) as { id: string }).id;
}

export async function uploadFile(folderId: string, name: string, blob: Blob): Promise<DriveFile> {
  const boundary = `dbradar${Date.now()}`;
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/gzip' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,size,createdTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return normalize(await r.json());
}

function normalize(f: { id: string; name: string; size?: string | number; createdTime: string }): DriveFile {
  return { id: f.id, name: f.name, size: Number(f.size ?? 0), createdTime: f.createdTime };
}

export async function listBackups(folderId: string): Promise<DriveFile[]> {
  const query = `'${folderId}' in parents and trashed=false`;
  const out: DriveFile[] = [];
  let page = '';
  do {
    const r = await gfetch(
      `${API}/files?q=${q(query)}&orderBy=createdTime desc&pageSize=100&fields=nextPageToken,files(id,name,size,createdTime)${
        page ? `&pageToken=${page}` : ''
      }`,
    );
    const j = (await r.json()) as { files: Parameters<typeof normalize>[0][]; nextPageToken?: string };
    out.push(...j.files.map(normalize));
    page = j.nextPageToken ?? '';
  } while (page);
  return out;
}

export async function deleteFile(id: string): Promise<void> {
  await gfetch(`${API}/files/${id}`, { method: 'DELETE' });
}

export async function downloadFile(id: string): Promise<Blob> {
  return (await gfetch(`${API}/files/${id}?alt=media`)).blob();
}
