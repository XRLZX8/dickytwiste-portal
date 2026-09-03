const { app, BrowserWindow, WebContentsView, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let tray = null;
let tabViews = new Map(); // id -> { view, title, icon, url }
let activeTabId = null;
let nextTabId = 1;
let isQuitting = false;

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
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
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
    entry.view.remove(entry.view.webContents);
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
        { label: '👤 登录/注销', click: () => { const id = createTab('https://dickytwiste.top/login', '登录', '🔑'); activateTab(id); } },
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
        body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',monospace;padding:18px;background:#141414;color:#e0e0e0;margin:0}
        label{display:block;font-size:12px;color:#888;margin-bottom:8px;letter-spacing:1px}
        input{width:100%;padding:9px 10px;background:#1e1e1e;color:#e0e0e0;border:1px solid #333;border-radius:7px;font-size:13px;outline:none}
        input:focus{border-color:#6f8fff}
        button{width:100%;margin-top:12px;padding:9px;background:#6f8fff;color:#fff;border:none;border-radius:7px;cursor:pointer;font-size:14px}
        button:hover{background:#5a7aef}
      </style></head>
      <body>
        <label>输入网址</label>
        <input id="u" placeholder="https://example.com 或 example.com" autofocus>
        <button id="ok">打开</button>
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
    autoUpdater.on('update-not-available', () => {});
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