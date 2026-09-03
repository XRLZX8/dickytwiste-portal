const { ipcRenderer } = require('electron');

// ===== 默认新标签配置 =====
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

document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.getElementById('tabs');
    const banner = document.getElementById('update-banner');

    // 渲染标签
    function renderTabs(list) {
        tabs.innerHTML = '';
        list.forEach(tab => {
            const el = document.createElement('div');
            el.className = 'tab' + (tab.active ? ' active' : '');
            el.dataset.id = tab.id;
            el.innerHTML = `<span class="tab-icon">${tab.icon || '🌐'}</span>
                            <span class="tab-title">${tab.title}</span>
                            <span class="tab-close" title="关闭">&times;</span>`;
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('tab-close')) {
                    ipcRenderer.send('tab-close', tab.id);
                } else {
                    ipcRenderer.send('tab-activate', tab.id);
                }
            });
            tabs.appendChild(el);
        });
    }

    // 标签变化同步
    ipcRenderer.on('tabs-synced', (e, list) => renderTabs(list));

    // 新增标签（点击＋→ 快捷菜单）
    document.getElementById('btn-home').addEventListener('click', () => showQuickLinks());

    document.getElementById('btn-settings').addEventListener('click', () => {
        ipcRenderer.send('open-external', 'https://dickytwiste.top');
    });

    // 快捷添加菜单
    function showQuickLinks() {
        const box = document.createElement('div');
        box.className = 'quickmenu';
        box.innerHTML = QUICK_LINKS.map(l =>
            `<div class="quick-item" data-url="${l.url}" data-title="${l.title}" data-icon="${l.icon}">
               <span class="qi-icon">${l.icon}</span><span>${l.title}</span>
             </div>`).join('') + '<div class="quick-item custom"><span class="qi-icon">🌍</span><span>自定义链接…</span></div>';
        box.style.top = (TAB_BAR_HEIGHT_OFFSET()) + 'px';
        document.body.appendChild(box);
        box.querySelectorAll('.quick-item').forEach(item => {
            item.addEventListener('click', () => {
                if (item.classList.contains('custom')) {
                    const url = prompt('输入网址:');
                    if (url) ipcRenderer.send('tab-create', { url });
                } else {
                    ipcRenderer.send('tab-create', {
                        url: item.dataset.url,
                        title: item.dataset.title,
                        icon: item.dataset.icon
                    });
                }
                box.remove();
            });
        });
        setTimeout(() => document.addEventListener('click', () => box.remove(), { once: true }), 10);
    }

    function TAB_BAR_HEIGHT_OFFSET() { return 44; }

    // ===== 更新提示 =====
    ipcRenderer.on('update-event', (e, data) => {
        const text = document.getElementById('update-text');
        const btn = document.getElementById('btn-update-install');
        banner.style.display = 'flex';
        switch (data.event) {
            case 'checking': break;
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
                text.textContent = `更新失败: ${data.message}`;
                banner.style.display = 'none';
                break;
        }
    });
});
