import { supabase } from './supabase-adapter.js';

const user = (() => {
    try { return JSON.parse(localStorage.getItem('loggedInUser') || 'null'); }
    catch (_) { return null; }
})();

if (user && user.role === 'student' && !document.documentElement.dataset.plvNotificationsMounted) {
    document.documentElement.dataset.plvNotificationsMounted = '1';

    const studentNo = String(user.studentNo || user.student_no || user.username || '').trim();
    const readKey = `plv_student_notification_reads_v2:${studentNo}`;
    const gradeSeenKey = `plv_student_grade_seen_v2:${studentNo}`;
    const MAX_READ_IDS = 500;
    const POLL_INTERVAL_MS = 60000;
    let items = [];
    let isOpen = false;
    let isLoading = false;
    let lastLoadedAt = 0;
    let pollTimer = null;

    const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));

    function readJson(key, fallback) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return parsed ?? fallback;
        } catch (_) {
            return fallback;
        }
    }

    function writeJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
    }

    function readIds() {
        const ids = readJson(readKey, []);
        return new Set(Array.isArray(ids) ? ids.map(String) : []);
    }

    function persistReadIds(set) {
        writeJson(readKey, Array.from(set).slice(-MAX_READ_IDS));
    }

    function asDate(value, fallback = Date.now()) {
        const date = value ? new Date(value) : new Date(fallback);
        return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
    }

    function formatRelative(value) {
        const date = asDate(value);
        const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
    }

    function formatGrade(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return String(value ?? '');
        return number <= 5 ? number.toFixed(2) : number.toFixed(2);
    }

    async function authHeaders() {
        try {
            const { data } = await supabase.auth.getSession();
            if (data?.session?.access_token) return { authorization: `Bearer ${data.session.access_token}` };
        } catch (_) {}
        return {
            'x-student-no': studentNo,
            'x-student-session': user.activeSessionToken || user.sessionToken || ''
        };
    }

    async function fetchAnnouncements() {
        try {
            const { data, error } = await supabase
                .from('announcements')
                .select('*')
                .order('createdAt', { ascending: false })
                .limit(25);
            if (error) throw error;
            return (data || []).map(row => ({
                id: `announcement:${row.id || `${row.createdAt || ''}:${row.title || ''}`}`,
                type: 'announcement',
                icon: row.isUrgent ? 'ph-fill ph-warning-circle' : 'ph-fill ph-megaphone',
                title: row.title || 'New announcement',
                message: row.message || 'A new announcement has been posted.',
                date: asDate(row.createdAt).toISOString(),
                href: 'student-dashboard.html#announcements',
                urgent: !!row.isUrgent
            }));
        } catch (error) {
            console.warn('Notifications: announcements unavailable.', error);
            return [];
        }
    }

    async function fetchGrades() {
        if (!studentNo) return [];
        try {
            const { data, error } = await supabase.from('enrollments').select('*').eq('studentNo', studentNo);
            if (error) throw error;
            const firstSeen = readJson(gradeSeenKey, {});
            const nextSeen = firstSeen && typeof firstSeen === 'object' ? { ...firstSeen } : {};
            const notifications = [];

            for (const row of data || []) {
                const subject = row.subjectCode || row.subject_code || 'Subject';
                const recordId = row.id || row.enrollmentId || `${studentNo}:${subject}`;
                const gradeEntries = [
                    ['midterm', 'Midterm grade', row.midtermRawGrade ?? row.midtermGrade],
                    ['final', 'Final term grade', row.finalTermRawGrade ?? row.finalTermGrade]
                ];

                for (const [term, label, value] of gradeEntries) {
                    if (value === null || value === undefined || value === '') continue;
                    const id = `grade:${recordId}:${term}:${String(value)}`;
                    if (!nextSeen[id]) nextSeen[id] = new Date().toISOString();
                    notifications.push({
                        id,
                        type: 'grade',
                        icon: 'ph-fill ph-exam',
                        title: `${label} posted`,
                        message: `${subject}: ${formatGrade(value)}`,
                        date: asDate(row.updatedAt || row.updated_at || nextSeen[id]).toISOString(),
                        href: 'student-grades.html'
                    });
                }
            }

            const activeIds = new Set(notifications.map(item => item.id));
            Object.keys(nextSeen).forEach(id => {
                if (id.startsWith('grade:') && !activeIds.has(id)) delete nextSeen[id];
            });
            writeJson(gradeSeenKey, nextSeen);
            return notifications;
        } catch (error) {
            console.warn('Notifications: grades unavailable.', error);
            return [];
        }
    }

    function injectStyles() {
        if (document.getElementById('plvNotificationStyles')) return;
        const style = document.createElement('style');
        style.id = 'plvNotificationStyles';
        style.textContent = `
            .plv-notification-trigger{position:relative;flex:0 0 auto;padding:0;appearance:none;-webkit-appearance:none;}
            .plv-notification-trigger[data-unread="true"]{color:var(--accent-primary)!important;}
            .plv-notification-badge{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;padding:0 5px;border-radius:999px;display:none;align-items:center;justify-content:center;background:#e11d48;color:#fff;border:2px solid var(--bg-body);font-size:9px;font-weight:900;line-height:1;box-shadow:0 5px 12px rgba(225,29,72,.28);}
            .plv-notification-badge.show{display:flex;}
            .plv-notification-overlay{position:fixed;inset:0;z-index:898;background:transparent;display:none;}
            .plv-notification-overlay.show{display:block;}
            .plv-notification-panel{position:fixed;z-index:899;top:92px;right:24px;width:min(410px,calc(100vw - 28px));max-height:min(680px,calc(100vh - 112px));display:none;flex-direction:column;overflow:hidden;border-radius:24px;background:var(--glass-bg);border:1px solid var(--glass-border);box-shadow:var(--glass-highlight),0 28px 70px rgba(15,23,42,.22);backdrop-filter:blur(34px);-webkit-backdrop-filter:blur(34px);}
            .plv-notification-panel.show{display:flex;animation:plvNotificationIn .2s cubic-bezier(.2,.8,.2,1);}
            @keyframes plvNotificationIn{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}
            .plv-notification-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 20px 15px;border-bottom:1px solid var(--glass-border);}
            .plv-notification-head h2{font-size:18px;font-weight:900;letter-spacing:-.45px;margin:0;color:var(--text-main);}
            .plv-notification-head p{font-size:11px;font-weight:700;color:var(--text-muted);margin:4px 0 0;}
            .plv-notification-tools{display:flex;gap:7px;align-items:center;}
            .plv-notification-tool{width:35px;height:35px;border:1px solid var(--input-border, var(--glass-border));border-radius:11px;background:var(--input-bg,var(--glass-bg));color:var(--text-muted);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:.18s;}
            .plv-notification-tool:hover{color:var(--accent-primary);background:var(--accent-light);transform:translateY(-1px);}
            .plv-notification-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 20px;background:rgba(100,116,139,.055);border-bottom:1px solid var(--glass-border);font-size:11px;font-weight:800;color:var(--text-muted);}
            .plv-notification-mark{border:0;background:transparent;color:var(--accent-primary);font:inherit;cursor:pointer;padding:4px 0;}
            .plv-notification-list{overflow:auto;overscroll-behavior:contain;padding:8px;scrollbar-width:thin;scrollbar-color:var(--input-border) transparent;}
            .plv-notification-list::-webkit-scrollbar{width:6px}.plv-notification-list::-webkit-scrollbar-track{background:transparent}.plv-notification-list::-webkit-scrollbar-thumb{background:var(--input-border);border-radius:999px}
            .plv-notification-item{width:100%;border:0;background:transparent;color:inherit;text-align:left;display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:11px;padding:12px;border-radius:16px;cursor:pointer;transition:.18s;position:relative;}
            .plv-notification-item:hover{background:var(--accent-light);}
            .plv-notification-item.unread{background:rgba(0,61,165,.055);}
            .dark-theme .plv-notification-item.unread{background:rgba(59,130,246,.11);}
            .plv-notification-icon{width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;background:var(--accent-light);color:var(--accent-primary);font-size:19px;}
            .plv-notification-item[data-type="announcement"] .plv-notification-icon{background:rgba(245,158,11,.12);color:#d97706;}
            .plv-notification-item[data-type="announcement"][data-urgent="true"] .plv-notification-icon{background:rgba(225,29,72,.12);color:#e11d48;}
            .plv-notification-item[data-type="grade"] .plv-notification-icon{background:rgba(16,185,129,.11);color:#059669;}
            .plv-notification-copy{min-width:0;}
            .plv-notification-title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:900;color:var(--text-main);line-height:1.35;margin-bottom:3px;}
            .plv-notification-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-primary);flex:0 0 auto;}
            .plv-notification-message{font-size:11.5px;font-weight:650;color:var(--text-muted);line-height:1.48;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
            .plv-notification-time{font-size:9.5px;font-weight:800;color:var(--text-muted);white-space:nowrap;padding-top:3px;}
            .plv-notification-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:42px 24px;color:var(--text-muted);}
            .plv-notification-empty i{font-size:34px;color:var(--accent-primary);margin-bottom:10px;}
            .plv-notification-empty strong{font-size:14px;color:var(--text-main);margin-bottom:5px;}
            .plv-notification-empty span{font-size:11px;font-weight:650;line-height:1.5;}
            .plv-notification-loading{padding:30px;text-align:center;color:var(--text-muted);font-size:12px;font-weight:800;}
            @media(max-width:768px){.plv-notification-panel{top:76px;right:10px;left:10px;width:auto;max-height:calc(100vh - 96px);border-radius:20px}.plv-notification-head{padding:17px 16px 13px}.plv-notification-summary{padding:10px 16px}.plv-notification-list{padding:6px}.plv-notification-item{grid-template-columns:38px minmax(0,1fr);}.plv-notification-icon{width:38px;height:38px}.plv-notification-time{grid-column:2;justify-self:start;padding-top:0;margin-top:-4px}.header-actions{position:relative;}}
        `;
        document.head.appendChild(style);
    }

    function mountUi() {
        injectStyles();
        const header = document.querySelector('.header');
        if (!header) return null;
        let actions = header.querySelector('.header-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'header-actions';
            const themeButton = header.querySelector(':scope > .theme-toggle');
            if (themeButton) actions.appendChild(themeButton);
            header.appendChild(actions);
        }

        let trigger = document.querySelector('.plv-notification-trigger');
        if (!trigger) {
            const existingBell = Array.from(document.querySelectorAll('.header-actions .icon-btn')).find(element => element.querySelector('.ph-bell, .ph-fill.ph-bell'));
            if (existingBell) {
                trigger = existingBell;
                trigger.classList.add('plv-notification-trigger');
                trigger.setAttribute('role', 'button');
                trigger.setAttribute('tabindex', '0');
                const themeButton = actions.querySelector('.theme-toggle');
                if (themeButton && trigger !== themeButton.previousElementSibling) actions.insertBefore(trigger, themeButton);
            } else {
                trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'icon-btn plv-notification-trigger';
                trigger.innerHTML = '<i class="ph ph-bell"></i>';
                const themeButton = actions.querySelector('.theme-toggle');
                actions.insertBefore(trigger, themeButton || null);
            }
        }
        trigger.setAttribute('aria-label', 'Open notifications');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = '<i class="ph ph-bell"></i><span class="plv-notification-badge" aria-hidden="true"></span>';

        const overlay = document.createElement('div');
        overlay.className = 'plv-notification-overlay';
        overlay.setAttribute('aria-hidden', 'true');

        const panel = document.createElement('section');
        panel.className = 'plv-notification-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'false');
        panel.setAttribute('aria-label', 'Notifications');
        panel.innerHTML = `
            <div class="plv-notification-head">
                <div><h2>Notifications</h2><p>Grades and announcements</p></div>
                <div class="plv-notification-tools">
                    <button type="button" class="plv-notification-tool" data-notification-refresh aria-label="Refresh notifications" title="Refresh"><i class="ph-bold ph-arrow-clockwise"></i></button>
                    <button type="button" class="plv-notification-tool" data-notification-close aria-label="Close notifications" title="Close"><i class="ph-bold ph-x"></i></button>
                </div>
            </div>
            <div class="plv-notification-summary"><span data-notification-count>Checking for updates...</span><button type="button" class="plv-notification-mark" data-notification-mark-all>Mark all as read</button></div>
            <div class="plv-notification-list" data-notification-list><div class="plv-notification-loading">Loading notifications...</div></div>
        `;
        document.body.append(overlay, panel);

        const toggle = () => setOpen(!isOpen);
        trigger.addEventListener('click', toggle);
        trigger.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
        });
        overlay.addEventListener('click', () => setOpen(false));
        panel.querySelector('[data-notification-close]').addEventListener('click', () => setOpen(false));
        panel.querySelector('[data-notification-refresh]').addEventListener('click', () => load(true));
        panel.querySelector('[data-notification-mark-all]').addEventListener('click', markAllRead);
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen) setOpen(false); });

        return { trigger, overlay, panel };
    }

    const ui = mountUi();

    function setOpen(open) {
        if (!ui) return;
        isOpen = !!open;
        ui.panel.classList.toggle('show', isOpen);
        ui.overlay.classList.toggle('show', isOpen);
        ui.trigger.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            load();
            window.setTimeout(() => ui.panel.querySelector('[data-notification-close]')?.focus(), 20);
        }
    }

    function markRead(id) {
        const read = readIds();
        read.add(String(id));
        persistReadIds(read);
        render();
    }

    function markAllRead() {
        const read = readIds();
        items.forEach(item => read.add(String(item.id)));
        persistReadIds(read);
        render();
    }

    function render() {
        if (!ui) return;
        const read = readIds();
        const unread = items.filter(item => !read.has(String(item.id))).length;
        const badge = ui.trigger.querySelector('.plv-notification-badge');
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.classList.toggle('show', unread > 0);
        ui.trigger.dataset.unread = unread > 0 ? 'true' : 'false';
        ui.trigger.setAttribute('aria-label', unread ? `Open notifications, ${unread} unread` : 'Open notifications');

        const count = ui.panel.querySelector('[data-notification-count]');
        count.textContent = unread ? `${unread} unread • ${items.length} total` : `${items.length} notification${items.length === 1 ? '' : 's'}`;
        ui.panel.querySelector('[data-notification-mark-all]').hidden = unread === 0;
        const list = ui.panel.querySelector('[data-notification-list]');

        if (!items.length) {
            list.innerHTML = '<div class="plv-notification-empty"><i class="ph-fill ph-bell-ringing"></i><strong>You are all caught up</strong><span>Posted grades and announcements will appear here.</span></div>';
            return;
        }

        list.innerHTML = items.map(item => {
            const isUnread = !read.has(String(item.id));
            return `<button type="button" class="plv-notification-item ${isUnread ? 'unread' : ''}" data-notification-id="${esc(item.id)}" data-type="${esc(item.type)}" data-urgent="${item.urgent ? 'true' : 'false'}">
                <span class="plv-notification-icon"><i class="${esc(item.icon)}"></i></span>
                <span class="plv-notification-copy">
                    <span class="plv-notification-title">${isUnread ? '<span class="plv-notification-dot"></span>' : ''}${esc(item.title)}</span>
                    <span class="plv-notification-message">${esc(item.message)}</span>
                </span>
                <span class="plv-notification-time">${esc(formatRelative(item.date))}</span>
            </button>`;
        }).join('');

        list.querySelectorAll('[data-notification-id]').forEach(button => {
            button.addEventListener('click', () => {
                const item = items.find(entry => String(entry.id) === String(button.dataset.notificationId));
                if (!item) return;
                markRead(item.id);
                if (item.href) window.location.href = item.href;
            });
        });
    }

    async function load(force = false) {
        if (!ui || isLoading) return;
        if (!force && Date.now() - lastLoadedAt < 20000) return;
        isLoading = true;
        const list = ui.panel.querySelector('[data-notification-list]');
        if (!items.length && isOpen) list.innerHTML = '<div class="plv-notification-loading">Checking for new updates...</div>';
        try {
            const results = await Promise.allSettled([fetchAnnouncements(), fetchGrades()]);
            const merged = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
            const deduped = new Map();
            merged.forEach(item => deduped.set(String(item.id), item));
            items = Array.from(deduped.values()).sort((a, b) => asDate(b.date).getTime() - asDate(a.date).getTime()).slice(0, 60);
            lastLoadedAt = Date.now();
            render();
        } finally {
            isLoading = false;
        }
    }

    if (ui) {
        load(true);
        pollTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') load(true);
        }, POLL_INTERVAL_MS);
        window.addEventListener('focus', () => load());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') load();
        });
        window.addEventListener('storage', event => {
            if (event.key === readKey) render();
        });
        window.addEventListener('beforeunload', () => clearInterval(pollTimer), { once: true });
    }
}
