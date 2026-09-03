const { app, BrowserWindow, WebContentsView, ipcMain, shell, Tray, Menu, nativeImage, session, net } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let tray = null;
let tabViews = new Map(); // id -> { view, title, icon, url }
let activeTabId = null;
let nextTabId = 1;
let isQuitting = false;
let isAppLoggedIn = false;
let loginWin = null;

const TAB_BAR_HEIGHT = 44;

// ============================================================
// 门户功能配置（本地标签入口 → 远程网页）
// ============================================================
const DEFAULT_TABS = [
    { title: '主页', icon: '🏠', url: 'https://dickytwiste.top' },
    { title: '发布中心', icon: '📦', url: 'https://dickytwiste.top/releases' },
    { title: '博客', icon: '📝', url: 'https://dickytwiste.top/blog' },
    { title: '知识图谱', icon: '🕸️', url: 'https://dickytwiste.top/tools/kg' }
];

// ============================================================
// 窗口与标签
// ============================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1340, height: 880,
        minWidth: 900, minHeight: 600,
        backgroundColor: '#0a0a0a',
        show: false,
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    mainWindow.once('ready-to-show', () => { mainWindow.show(); });
    mainWindow.on('close', async (e) => {
        if (isQuitting) return;
        e.preventDefault();
        const { dialog } = require('electron');
        const choice = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['收起到托盘', '退出应用', '取消'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
            title: 'Dickytwiste Portal',
            message: '关闭应用？',
            detail: '选择点击关闭按钮后的行为。'
        });
        if (choice.response === 0) {
            mainWindow.hide();
        } else if (choice.response === 1) {
            isQuitting = true;
            app.quit();
        }
        // response 2 (取消) → 保持窗口打开
    });
    mainWindow.on('closed', () => { mainWindow = null; });

    // 默认标签
    DEFAULT_TABS.forEach((t, i) => {
        const id = createTab(t.url, t.title, t.icon);
        if (i === 0) activateTab(id);
    });
}

function createTab(url, title, icon) {
    const id = nextTabId++;
    const view = new WebContentsView({
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false
        }
    });
    mainWindow.contentView.addChildView(view);
    view.webContents.loadURL(url);
    view.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
    view.webContents.on('page-title-updated', (e, t) => {
        if (tabViews.get(id)) tabViews.get(id).title = t;
        syncTabs();
    });
    tabViews.set(id, { view, title: title || url, icon: icon || '🌐', url });
    layoutTabs();
    syncTabs();
    return id;
}

function activateTab(id) {
    if (!tabViews.has(id)) return;
    activeTabId = id;
    tabViews.forEach((entry, key) => {
        entry.view.setVisible(key === id);
    });
    syncTabs();
}

function closeTab(id) {
    if (!tabViews.has(id) || tabViews.size <= 1) return; // 保留至少1个
    const entry = tabViews.get(id);
    mainWindow.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    tabViews.delete(id);
    if (activeTabId === id) {
        const first = tabViews.keys().next().value;
        activeTabId = first;
        tabViews.forEach((v, k) => v.view.setVisible(k === first));
    }
    layoutTabs();
    syncTabs();
}

function layoutTabs() {
    if (!mainWindow) return;
    const [w, h] = mainWindow.getContentSize();
    tabViews.forEach((entry) => {
        entry.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: w, height: h - TAB_BAR_HEIGHT });
    });
}

// ============================================================
// IPC —— 渲染进程（标签栏）↔ 主进程
// ============================================================
ipcMain.on('tab-create', (e, { url, title, icon }) => {
    const id = createTab(url, title, icon);
    activateTab(id);
});
ipcMain.on('tab-activate', (e, id) => activateTab(Number(id)));
ipcMain.on('tab-close', (e, id) => closeTab(Number(id)));
ipcMain.on('open-external', (e, url) => shell.openExternal(url));
ipcMain.handle('get-tabs', () => {
    return [...tabViews.values()].map(v => ({ title: v.title, icon: v.icon, url: v.url }));
});
ipcMain.handle('get-active-tab', () => activeTabId);
ipcMain.on('app-quit', () => { isQuitting = true; app.quit(); });
ipcMain.on('tab-request-sync', () => syncTabs());

// 标签拖拽重排
ipcMain.on('tab-reorder', (e, orderIds) => {
    const newMap = new Map();
    (orderIds || []).forEach(id => {
        if (tabViews.has(id)) newMap.set(id, tabViews.get(id));
    });
    // 补漏（若 orderIds 不全）
    tabViews.forEach((v, k) => { if (!newMap.has(k)) newMap.set(k, v); });
    tabViews = newMap;
    syncTabs();
});

// 刷新当前标签
ipcMain.on('tab-refresh-current', () => {
    const entry = tabViews.get(activeTabId);
    if (entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.reload();
});

// 标签右键菜单
ipcMain.on('tab-contextmenu', (e, { id, x, y }) => {
    if (!mainWindow) return;
    const vid = Number(id);
    const entry = tabViews.get(vid);
    if (!entry) return;
    const template = [
        {
            label: '🔄 刷新',
            click: () => { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.reload(); }
        },
        { type: 'separator' },
        {
            label: '📋 复制链接',
            click: () => require('electron').clipboard.writeText(entry.url)
        },
        {
            label: '🔗 在新窗口打开',
            click: () => require('electron').shell.openExternal(entry.url)
        },
        { type: 'separator' },
        {
            label: '✕ 关闭标签',
            enabled: tabViews.size > 1,
            click: () => closeTab(vid)
        }
    ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
});

// ===== 原生菜单（显示在最顶层，不被 WebContentsView 遮挡） =====
const QUICK_LINKS = [
    { title: '主页', icon: '🏠', url: 'https://dickytwiste.top' },
    { title: '发布中心', icon: '📦', url: 'https://dickytwiste.top/releases' },
    { title: '博客', icon: '📝', url: 'https://dickytwiste.top/blog' },
    { title: '知识图谱', icon: '🕸️', url: 'https://dickytwiste.top/tools/kg' },
    { title: 'AI Chat', icon: '💬', url: 'https://dickytwiste.top/chat' },
    { title: '密码盒', icon: '🔐', url: 'https://dickytwiste.top/steg' },
    { title: 'MD 预览', icon: '🖊️', url: 'https://dickytwiste.top/tools/md-preview' },
    { title: 'DeepSeek Web', icon: '🐋', url: 'https://dsh.dickytwiste.top' }
];

// ＋ 按钮：弹出"新增标签"快捷菜单
ipcMain.on('menu-quick-links', () => {
    if (!mainWindow) return;
    const items = QUICK_LINKS.map(l => ({
        label: `${l.icon}  ${l.title}`,
        click: () => {
            const id = createTab(l.url, l.title, l.icon);
            activateTab(id);
        }
    }));
    items.push(
        { type: 'separator' },
        {
            label: '🌍  自定义链接…',
            click: () => createURLInputWindow()
        }
    );
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
});

// ☰ 按钮：设置菜单
ipcMain.on('menu-settings', () => {
    if (!mainWindow) return;
    const template = [
        { label: '🔍 检查更新', click: () => {
            try { autoUpdater.checkForUpdates(); } catch (e) {}
        } },
        { label: '🏠 打开官方网站', click: () => shell.openExternal('https://dickytwiste.top') },
        { label: '👤 应用登录', click: () => openLoginWindow() },
        { label: '🚪 注销', enabled: isAppLoggedIn, id: 'logout-menu', click: () => doLogout() },
        { type: 'separator' },
        { label: 'ℹ️ 关于', click: () => showAbout() },
        { type: 'separator' },
        { label: '✕ 退出', click: () => { isQuitting = true; app.quit(); } }
    ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
});

// 自定义链接输入窗口（独立 BrowserWindow，避免被 WebContentsView 遮挡）
let urlInputWin = null;
function createURLInputWindow() {
    if (urlInputWin && !urlInputWin.isDestroyed()) { urlInputWin.focus(); return; }
    urlInputWin = new BrowserWindow({
        width: 420, height: 150,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        modal: true, parent: mainWindow,
        title: '打开链接',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>
        * { box-sizing: border-box; }
        body {
          font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
          padding:20px; background:linear-gradient(180deg,#15151e,#1a1a26);
          color:#e8e8f0; margin:0; min-height:100vh;
          display:flex; flex-direction:column; justify-content:center;
        }
        .title {
          display:flex; align-items:center; gap:8px; font-size:14px;
          color:#fff; font-weight:600; margin-bottom:16px; letter-spacing:1px;
        }
        .title .dots {
          display:flex; gap:6px;
        }
        .title .dots i { width:9px;height:9px;border-radius:50%;display:inline-block; }
        .title .dots i:nth-child(1){background:#ff5f57}
        .title .dots i:nth-child(2){background:#febc2e}
        .title .dots i:nth-child(3){background:#28c840}
        .title span.cap { margin-left:8px; opacity:.6; font-weight:400; font-size:12px; }
        label {
          display:block; font-size:11px; color:#8a8aa0; margin-bottom:8px; letter-spacing:2px;
        }
        input {
          width:100%; padding:11px 14px; background:#0f0f16; color:#e8e8f0;
          border:1px solid #2a2a40; border-radius:10px; font-size:14px; outline:none;
          transition:border-color .2s, box-shadow .2s;
        }
        input:focus { border-color:#6f8fff; box-shadow:0 0 0 3px rgba(111,143,255,.15); }
        input::placeholder { color:#555575; }
        button {
          width:100%; margin-top:16px; padding:11px;
          background:linear-gradient(90deg,#6f8fff,#5a7aef);
          color:#fff; border:none; border-radius:10px; cursor:pointer;
          font-size:14px; font-weight:600; letter-spacing:2px;
          transition:opacity .2s, transform .1s; box-shadow:0 4px 16px rgba(111,143,255,.3);
        }
        button:hover { opacity:.9; }
        button:active { transform:translateY(1px); }
        .hint { font-size:11px; color:#555575; text-align:center; margin-top:10px; }
      </style></head>
      <body>
        <div class="title">
          <span class="dots"><i></i><i></i><i></i></span>
          <span>打开链接</span>
          <span class="cap">NEW TAB</span>
        </div>
        <label>输入网址 — URL</label>
        <input id="u" placeholder="https://example.com 或 example.com" autofocus>
        <button id="ok">🪄 打开</button>
        <div class="hint">Enter 打开</div>
        <script>
          const { ipcRenderer } = require('electron');
          function submit(){
            let v=document.getElementById('u').value.trim();
            if(!v)return;
            if(!/^https?:\\/\\//i.test(v)) v='https://'+v.replace(/^\\/+\\/+?/,'');
            ipcRenderer.send('prompt-url-ok', v);
            window.close();
          }
          document.getElementById('ok').onclick=submit;
          document.getElementById('u').onkeydown=e=>{if(e.key==='Enter')submit();};
          setTimeout(()=>document.getElementById('u').focus(),120);
        </script>
      </body></html>`;
    urlInputWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    urlInputWin.on('closed', () => { urlInputWin = null; });
}

function showAbout() {
    const { dialog } = require('electron');
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '关于 Dickytwiste Portal',
        message: 'Dickytwiste Portal',
        detail: `版本 ${app.getVersion()}\n多标签桌面门户 · Helios © 2026\n收纳 dickytwiste.top 全部 web 功能`
    });
}

// ============================================================
// 应用级登录（Electron 本地登录，不依赖网页完整登录页）
// ============================================================
const LOGIN_API = 'https://dickytwiste.top/api/login';

ipcMain.handle('app-login', async (e, { username, password }) => {
    try {
        const resp = await net.fetch(LOGIN_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await resp.json();
        if (resp.ok && data.status === 'ok') {
            isAppLoggedIn = true;
            refreshAllTabs();
            return { ok: true };
        }
        return { ok: false, error: data.error || '登录失败（账号或密码错误）' };
    } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
    }
});

function refreshAllTabs() {
    tabViews.forEach(t => {
        if (t.view.webContents && !t.view.webContents.isDestroyed()) t.view.webContents.reload();
    });
}

async function doLogout() {
    try {
        await session.defaultSession.clearStorageData({ storages: ['cookies'] });
    } catch (e) {}
    isAppLoggedIn = false;
    refreshAllTabs();
    const { dialog } = require('electron');
    dialog.showMessageBox(mainWindow, {
        type: 'info', title: '已注销', message: '已清除登录状态，所有页面已刷新。'
    });
}

function openLoginWindow() {
    if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }
    loginWin = new BrowserWindow({
        width: 400, height: 360,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        parent: mainWindow, modal: true,
        title: 'Dickytwiste 登录',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>
        * { box-sizing:border-box; }
        body{
          font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
          background:linear-gradient(180deg,#15151e,#1a1a26); color:#e8e8f0; margin:0;
          padding:20px; min-height:100vh; display:flex; flex-direction:column;
        }
        .title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;letter-spacing:1px;margin-bottom:4px}
        .logo{font-size:20px}
        .sub{font-size:12px;color:#8a8aa0;margin-bottom:20px}
        label{display:block;font-size:11px;color:#8a8aa0;margin:12px 0 6px;letter-spacing:1px}
        input{width:100%;padding:10px 12px;background:#0f0f16;color:#e8e8f0;border:1px solid #2a2a40;border-radius:9px;font-size:14px;outline:none;transition:border-color .2s,box-shadow .2s}
        input:focus{border-color:#6f8fff;box-shadow:0 0 0 3px rgba(111,143,255,.15)}
        input::placeholder{color:#555575}
        #err{color:#ff6b6b;font-size:12px;margin-top:14px;min-height:16px;text-align:center}
        .btns{display:flex;gap:10px;margin-top:16px}
        button{flex:1;padding:11px;border:none;border-radius:9px;cursor:pointer;font-size:14px;font-weight:600;letter-spacing:1px;transition:opacity .2s}
        #login{background:linear-gradient(90deg,#6f8fff,#5a7aef);color:#fff;box-shadow:0 4px 16px rgba(111,143,255,.3)}
        #cancel{background:#2a2a36;color:#aaa}
        button:hover{opacity:.9}
        .loading{opacity:.6;pointer-events:none}
      </style></head>
      <body>
        <div class="title"><span class="logo">☀️</span> Dickytwiste Portal</div>
        <div class="sub">登录后所有标签页免重复认证</div>
        <label>用户名 — USERNAME</label>
        <input id="u" placeholder="admin" autofocus>
        <label>密码 — PASSWORD</label>
        <input id="p" type="password" placeholder="••••••">
        <div id="err"></div>
        <div class="btns">
          <button id="cancel">取消</button>
          <button id="login">🔑 登录</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const err = document.getElementById('err');
          async function doLogin(){
            const u=document.getElementById('u').value.trim();
            const p=document.getElementById('p').value;
            if(!u||!p){err.textContent='请输入用户名和密码';return;}
            const btn=document.getElementById('login'); btn.classList.add('loading');
            err.textContent='';
            const r = await ipcRenderer.invoke('app-login',{username:u,password:p});
            btn.classList.remove('loading');
            if(r.ok){
              err.style.color='#7ecf6a'; err.textContent='✅ 登录成功';
              setTimeout(()=>window.close(),600);
            } else {
              err.style.color='#ff6b6b'; err.textContent=r.error||'登录失败';
            }
          }
          document.getElementById('login').onclick=doLogin;
          document.getElementById('cancel').onclick=()=>window.close();
          document.getElementById('p').onkeydown=e=>{if(e.key==='Enter')doLogin();};
          document.getElementById('u').onkeydown=e=>{if(e.key==='Enter')document.getElementById('p').focus()};
          setTimeout(()=>document.getElementById('u').focus(),120);
        </script>
      </body></html>`;
    loginWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    loginWin.on('closed', () => { loginWin = null; });
}

function syncTabs() {
    if (mainWindow) {
        const data = [...tabViews.entries()].map(([id, v]) => ({
            id, title: v.title, icon: v.icon, url: v.url, active: id === activeTabId
        }));
        mainWindow.webContents.send('tabs-synced', data);
    }
}

// ============================================================
// 应用内更新（electron-updater）
// ============================================================
function setupAutoUpdater() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return; // 便携版跳过

    const send = (event, data) => {
        if (mainWindow) mainWindow.webContents.send('update-event', { event, ...data });
    };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => send('checking'));
    autoUpdater.on('update-available', (info) => send('available', { version: info.version }));
    autoUpdater.on('update-not-available', () => send('not-available'));
    autoUpdater.on('download-progress', (p) => send('progress', { percent: p.percent.toFixed(1) }));
    autoUpdater.on('update-downloaded', (info) => {
        send('downloaded', { version: info.version });
        // 通知 + 提示重启
        if (Notification) {
            new Notification({ title: '更新已下载', body: '新版已就绪，退出时自动安装' }).show();
        }
    });
    autoUpdater.on('error', (err) => send('error', { message: String(err && err.message || err) }));

    // 检查更新
    setTimeout(() => {
        try { autoUpdater.checkForUpdatesAndNotify(); } catch (e) { /* 忽略非打包环境 */ }
    }, 5000);

    ipcMain.on('app-restart-install', () => {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
    });
}

// ============================================================
// 托盘
// ============================================================
function createTray() {
    tray = new Tray(nativeImage.createEmpty());
    const menu = Menu.buildFromTemplate([
        { label: '显示门户', click: () => show() },
        { type: 'separator' },
        { label: '退出', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('Dickytwiste Portal');
    tray.setContextMenu(menu);
    tray.on('click', () => show());
}

function show() {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
}

// ============================================================
// 生命周期
// ============================================================
app.whenReady().then(() => {
    createWindow();
    createTray();
    setupAutoUpdater();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    mainWindow.on('resize', layoutTabs);
    mainWindow.on('maximize', layoutTabs);
    mainWindow.on('unmaximize', layoutTabs);
});

app.on('window-all-closed', (e) => {
    // 关闭窗口 = 最小化到托盘，不退出
    e.preventDefault();
    if (process.platform !== 'darwin' && !isQuitting) {
        // stay alive in tray
    }
});