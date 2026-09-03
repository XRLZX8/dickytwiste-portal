const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.getElementById('tabs');

    // 渲染标签
    function renderTabs(list) {
        tabs.innerHTML = '';
        list.forEach(tab => {
            const el = document.createElement('div');
            el.className = 'tab' + (tab.active ? ' active' : '');
            el.dataset.id = tab.id;
            el.innerHTML = `<span class="tab-icon">${tab.icon || '🌐'}</span>
                            <span class="tab-title">${escapeHtml(tab.title)}</span>
                            <span class="tab-close" title="关闭">&times;</span>`;
            el.addEventListener('click', (e) => {
                if (e.target.closest('.tab-close')) {
                    ipcRenderer.send('tab-close', tab.id);
                } else {
                    ipcRenderer.send('tab-activate', tab.id);
                }
            });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                ipcRenderer.send('tab-contextmenu', { id: tab.id, x: e.clientX, y: e.clientY });
            });
            tabs.appendChild(el);
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // 标签变化同步（主进程推送）
    ipcRenderer.on('tabs-synced', (e, list) => renderTabs(list));

    // ＋ 按钮 → 弹出原生"新增标签"菜单
    document.getElementById('btn-home').addEventListener('click', () => {
        ipcRenderer.send('menu-quick-links');
    });

    // 🔄 刷新按钮 → 刷新当前标签
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
        ipcRenderer.send('tab-refresh-current');
    });

    // ☰ 按钮 → 弹出原生"设置"菜单
    document.getElementById('btn-settings').addEventListener('click', () => {
        ipcRenderer.send('menu-settings');
    });

    // ===== 更新提示 =====
    const banner = document.getElementById('update-banner');
    ipcRenderer.on('update-event', (e, data) => {
        const text = document.getElementById('update-text');
        const btn = document.getElementById('btn-update-install');
        banner.style.display = 'flex';
        switch (data.event) {
            case 'checking':
                text.textContent = '🔄 正在检查更新…';
                btn.style.display = 'none';
                break;
            case 'not-available':
                text.textContent = '✅ 已是最新版本';
                btn.style.display = 'none';
                setTimeout(() => { banner.style.display = 'none'; }, 3000);
                break;
            case 'available':
                text.textContent = `发现新版本 v${data.version}，正在下载…`;
                break;
            case 'progress':
                text.textContent = `正在下载更新… ${data.percent}%`;
                break;
            case 'downloaded':
                text.textContent = `新版 v${data.version} 已下载，重启后安装`;
                btn.style.display = 'inline-block';
                btn.onclick = () => ipcRenderer.send('app-restart-install');
                break;
            case 'error':
                text.textContent = `更新失败`;
                banner.style.display = 'none';
                break;
        }
    });

    document.getElementById('btn-update-install')?.addEventListener('click', () => {
        ipcRenderer.send('app-restart-install');
    });

    // 初始请求一次当前标签
    ipcRenderer.send('tab-request-sync');
});