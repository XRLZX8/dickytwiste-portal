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