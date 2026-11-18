// 設定頁「Google Drive 備份」（SPEC 6.2、6.3、5.4）
import { useState } from 'preact/hooks';
import { DEFAULT_CLIENT_ID, FOLDER_NAME, type DriveFile } from '../backup/drive';
import { fmtBytes } from '../backup/policy';
import { connect, disconnect, listRemote, restore, type RestoreMode } from '../backup/sync';
import { saveSettings } from '../db/db';
import { BackupFormatError } from '../domain/merge';
import { fmtDateKey, fmtTime } from '../domain/time';
import { Dialog } from './Dialog';
import { backupByUser, clientId, getState, loadAll, notify, useAppState } from './store';

const errText = (e: unknown) => (e instanceof BackupFormatError || e instanceof Error ? e.message : String(e));
const when = (ts: number) => `${fmtDateKey(ts)} ${fmtTime(ts)}`;

export function DriveCard() {
  const app = useAppState();
  const meta = app.backup;
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ title: string; body: string } | null>(null);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [picked, setPicked] = useState<DriveFile | null>(null);
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cid, setCid] = useState(app.settings.googleClientId);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setMsg({ title: '沒有成功', body: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const doConnect = () =>
    run('connect', async () => {
      await connect(clientId());
      setMsg({ title: '已連結 Google Drive', body: `備份會放在你的 Drive「${FOLDER_NAME}」資料夾。每次按「下線」後自動備份一次。` });
    });

  const doBackup = () =>
    run('backup', async () => {
      await backupByUser();
      const n = getState().notice;
      if (n) setMsg({ title: n.bad ? '備份失敗' : '備份完成', body: n.text });
    });

  const openRestore = () =>
    run('list', async () => {
      setFiles(await listRemote(clientId()));
    });

  const doRestore = () =>
    run('restore', async () => {
      if (!picked) return;
      const r = await restore(clientId(), picked, mode);
      await loadAll();
      setPicked(null);
      setFiles(null);
      setConfirmOverwrite(false);
      setMsg({
        title: '還原完成',
        body:
          mode === 'overwrite'
            ? `已用 ${picked.name} 覆蓋手機上的資料（共 ${r.total} 筆）。`
            : r.added + r.updated === 0
              ? '備份裡的資料手機上都已經有了，沒有任何變動。'
              : `新增 ${r.added} 筆、更新 ${r.updated} 筆。`,
      });
      notify('已從 Google Drive 還原');
    });

  const saveClientId = async () => {
    const s = { ...getState().settings, googleClientId: cid.trim() };
    await saveSettings(s);
    await loadAll();
    setShowAdvanced(false);
  };

  const noClient = !clientId();

  return (
    <section class="card">
      <h2>Google Drive 備份</h2>
      {noClient ? (
        <p class="warn">還沒有設定 Google 用戶端 ID，請到下方「進階」填入。</p>
      ) : meta?.linked ? (
        <>
          <p class="ok">已連結，備份放在 Drive「{FOLDER_NAME}」，只保留最新 30 份。</p>
          <p>上次備份：{meta.lastBackupAt ? when(meta.lastBackupAt) : '還沒有'}</p>
          {meta.pending && <p class="warn">有資料還沒備份{meta.lastError ? `（${meta.lastError}）` : ''}</p>}
        </>
      ) : (
        <p class="muted">連結後，每次按「下線」會自動備份到你自己的 Google Drive。App 只看得到它自己建立的檔案。</p>
      )}

      <div class="btn-col">
        {!meta?.linked ? (
          <button type="button" class="btn primary" disabled={!!busy || noClient} onClick={() => void doConnect()}>
            {busy === 'connect' ? '連結中…' : '連結 Google Drive'}
          </button>
        ) : (
          <>
            <button type="button" class="btn primary" disabled={!!busy} onClick={() => void doBackup()}>
              {busy === 'backup' ? '備份中…' : '立即備份'}
            </button>
            <button type="button" class="btn secondary" disabled={!!busy} onClick={() => void openRestore()}>
              {busy === 'list' ? '讀取中…' : '從 Drive 還原'}
            </button>
            <button type="button" class="btn secondary" disabled={!!busy} onClick={() => void disconnect()}>
              中斷連結
            </button>
          </>
        )}
        <button type="button" class="btn secondary" onClick={() => setShowAdvanced(true)}>
          進階
        </button>
      </div>

      {files && !picked && (
        <Dialog title="選擇要還原的備份" onClose={() => setFiles(null)}>
          {files.length === 0 && <p class="muted">Drive 上還沒有備份。</p>}
          <ul class="list backup-list">
            {files.map((f) => (
              <li key={f.id}>
                <button type="button" class="event-row" onClick={() => setPicked(f)}>
                  <span>{when(Date.parse(f.createdTime))}</span>
                  <span class="muted">{fmtBytes(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}

      {picked && (
        <Dialog
          title="還原方式"
          onClose={() => {
            setPicked(null);
            setConfirmOverwrite(false);
          }}
        >
          <p>
            {when(Date.parse(picked.createdTime))} 的備份（{fmtBytes(picked.size)}）
          </p>
          <div class="radio-row">
            <button type="button" class={mode === 'merge' ? 'chip active' : 'chip'} onClick={() => setMode('merge')}>
              合併
            </button>
            <button
              type="button"
              class={mode === 'overwrite' ? 'chip active' : 'chip'}
              onClick={() => {
                setMode('overwrite');
                setConfirmOverwrite(false);
              }}
            >
              覆蓋
            </button>
          </div>
          <p class="muted">
            {mode === 'merge'
              ? '合併：手機上沒有的資料加進來，同一筆取比較新的版本，不會刪掉任何資料。'
              : '覆蓋：先清掉手機上的資料，再換成這份備份的內容。備份之後新增的記錄會不見。'}
          </p>
          {mode === 'overwrite' && confirmOverwrite && <p class="error">確定要覆蓋嗎？手機上現在的資料會被取代。</p>}
          <button
            type="button"
            class={mode === 'overwrite' ? 'btn danger' : 'btn primary'}
            disabled={!!busy}
            onClick={() => {
              if (mode === 'overwrite' && !confirmOverwrite) setConfirmOverwrite(true);
              else void doRestore();
            }}
          >
            {busy === 'restore' ? '還原中…' : mode === 'overwrite' ? (confirmOverwrite ? '確定覆蓋' : '覆蓋還原') : '合併還原'}
          </button>
        </Dialog>
      )}

      {showAdvanced && (
        <Dialog title="進階：Google 用戶端 ID" onClose={() => setShowAdvanced(false)}>
          <p class="muted">
            {DEFAULT_CLIENT_ID ? '留空就用 App 內建的用戶端 ID。' : '請填入 Google Cloud 建立的 OAuth 用戶端 ID。'}
            設定方式見 GitHub 上的 README。
          </p>
          <label class="field">
            <span>用戶端 ID</span>
            <input
              value={cid}
              onInput={(e) => setCid(e.currentTarget.value)}
              placeholder={DEFAULT_CLIENT_ID ? '（使用內建）' : '…apps.googleusercontent.com'}
              autoCapitalize="off"
              autoCorrect="off"
              spellcheck={false}
            />
          </label>
          <button type="button" class="btn primary" onClick={() => void saveClientId()}>
            儲存
          </button>
        </Dialog>
      )}

      {msg && (
        <Dialog title={msg.title} onClose={() => setMsg(null)}>
          <p class="pre">{msg.body}</p>
          <button type="button" class="btn primary" onClick={() => setMsg(null)}>
            好
          </button>
        </Dialog>
      )}
    </section>
  );
}
