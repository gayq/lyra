import { dom } from '../ui/dom.js';

let notificationsCache = [];
let notificationsMenuEl = null;

function timeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    if (isNaN(date.getTime())) {
        return "unknown time";
    }
    
    const seconds = Math.floor((now - date) / 1000);

    let interval = seconds / 31536000;

    if (interval > 1) {
        return Math.floor(interval) + " year(s) ago";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
        return Math.floor(interval) + " month(s) ago";
    }
    interval = seconds / 86400;
    if (interval > 1) {
        return Math.floor(interval) + " day(s) ago";
    }
    interval = seconds / 3600;
    if (interval > 1) {
        return Math.floor(interval) + " hour(s) ago";
    }
    interval = seconds / 60;
    if (interval > 1) {
        return Math.floor(interval) + " minute(s) ago";
    }
    return "just now";
}

function saveNotifications() {
    try {
        localStorage.setItem('notifications', JSON.stringify(notificationsCache));
    } catch (e) {
        console.error('Failed to save notifications to localStorage:', e);
    }
}

function loadNotifications() {
    try {
        const raw = localStorage.getItem('notifications');
        if (raw) {
            notificationsCache = JSON.parse(raw);
            notificationsCache = notificationsCache.map(n => ({
                ...n,
                type: n.type || 'Announcement', 
                changes: n.changes || [n.message],
                endMessage: n.endMessage || undefined
            }));
        }
    } catch (e) {
        console.error('Failed to load notifications from localStorage:', e);
        notificationsCache = [];
    }
}

async function fetchNotificationsFromBackend() {
    try {
        const response = await fetch('/api/notifications', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const backendNotifications = await response.json();

        const mergedNotifications = backendNotifications.map(backendNotif => {
            const existingNotif = notificationsCache.find(n => n.id === backendNotif.id);
            const isNewStatus = existingNotif ? existingNotif.isNew : (backendNotif.isNew ?? true);
            
            return { 
                ...backendNotif, 
                isNew: isNewStatus,
                type: backendNotif.type || 'Announcement', 
                changes: backendNotif.changes || [backendNotif.message],
                endMessage: backendNotif.endMessage || undefined
            };
        }).sort((a, b) => new Date(b.date) - new Date(a.date));

        notificationsCache = mergedNotifications;
        saveNotifications();
        renderNotifications();
        updateNotificationIcon();
    } catch (e) {
        console.error('Failed to fetch notifications:', e);
        const statusEl = document.getElementById('notifications-status');
        if (statusEl) {
            statusEl.textContent = 'Error fetching notifications.';
            statusEl.style.display = 'block';
        }
    }
}

function createNotificationItem(notification) {
    const item = document.createElement('li');
    item.className = `notification-item ${notification.isNew ? 'unread' : ''}`;
    item.dataset.id = notification.id;

    const header = document.createElement('div');
    header.className = 'notification-item-header';

    const content = document.createElement('div');
    content.className = 'notification-content';
    
    const title = document.createElement('h3');
    title.className = 'notification-title';
    title.textContent = notification.title;
    content.appendChild(title);

    const type = document.createElement('span');
    const typeTypeClass = notification.type.toLowerCase().replace(/\s/g, '-');
    type.className = `notification-type type-${typeTypeClass}`;
    type.textContent = notification.type;

    const chevron = document.createElement('i');
    chevron.className = 'fa-regular fa-chevron-down notification-chevron';
    
    header.appendChild(content);
    header.appendChild(type);
    header.appendChild(chevron);
    item.appendChild(header);

    const message = document.createElement('p');
    message.className = 'notification-item-message-summary';
    message.textContent = notification.message;
    item.appendChild(message);

    const date = document.createElement('span');
    date.className = 'notification-date';
    
    const formattedDate = new Date(notification.date).toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    const timeSince = timeAgo(notification.date);
    date.textContent = `${formattedDate} - ${timeSince}`; 
    
    item.appendChild(date); 
    
    const details = document.createElement('div');
    details.className = 'notification-details';
    
    if (notification.changes && notification.changes.length > 0) {
        const changesList = document.createElement('ul');
        changesList.className = 'notification-changes-list';
        
        notification.changes.forEach(change => {
            const li = document.createElement('li');
            li.textContent = change;
            changesList.appendChild(li);
        });
        details.appendChild(changesList);
    }

    if (notification.endMessage) {
        const endMsg = document.createElement('p');
        endMsg.className = 'notification-item-message-summary';
        endMsg.textContent = notification.endMessage;
        
        endMsg.style.marginTop = '15px';
        endMsg.style.marginBottom = '5px';
        
        details.appendChild(endMsg);
    }

    item.appendChild(details);

    return item;
}

function handleNotificationClick(e) {
    const item = e.currentTarget;
    const notifId = parseInt(item.dataset.id, 10);
    const notif = notificationsCache.find(n => n.id === notifId);
    
    if (!notif) return;

    const isExpanded = item.classList.toggle('expanded');
    const chevron = item.querySelector('.notification-chevron');
    const details = item.querySelector('.notification-details');
    
    if (details) {
        if (isExpanded) {
            chevron.classList.add('expanded');
            details.style.maxHeight = 'none';
            details.style.overflow = 'visible';
            const height = details.scrollHeight;
            details.style.maxHeight = '0';
            details.style.overflow = 'hidden';

            requestAnimationFrame(() => {
                 details.style.maxHeight = `${height + 20}px`;
            });

        } else {
            chevron.classList.remove('expanded');
            details.style.maxHeight = `${details.scrollHeight + 20}px`;
            
            requestAnimationFrame(() => {
                details.style.maxHeight = '0';
            });
        }
    }

    if (notif.isNew) {
        notif.isNew = false;
        item.classList.remove('unread');
        saveNotifications();
        updateNotificationIcon();
    }
}

function renderNotifications() {
    const list = document.querySelector('.notifications-list');
    const status = document.getElementById('notifications-status');
    if (!list) return;

    list.innerHTML = '';

    if (notificationsCache.length === 0) {
        if (status) {
            status.textContent = 'No notifications yet.';
            status.style.display = 'block';
            list.appendChild(status);
        }
        return;
    }

    if (status) status.style.display = 'none';
    
    const fragment = document.createDocumentFragment();
    notificationsCache.forEach(notif => {
        const item = createNotificationItem(notif);
        item.addEventListener('click', handleNotificationClick);
        fragment.appendChild(item);
    });
    list.appendChild(fragment);
}

function updateNotificationIcon() {
    if (!dom.notificationsIcon) return;
    
    const unreadCount = notificationsCache.filter(n => n.isNew).length;
    const hasUnread = unreadCount > 0;
    
    dom.notificationsIcon.classList.toggle('has-new-notifications', hasUnread);
    
    if (hasUnread) {
        const displayCount = unreadCount > 99 ? '99+' : unreadCount;
        dom.notificationsIcon.setAttribute('data-count', displayCount);
    } else {
        dom.notificationsIcon.removeAttribute('data-count');
    }
}

function onHideAnimationEnd(e) {
    if (e.animationName === 'fadeOut') {
        const contentEl = notificationsMenuEl.querySelector('.notifications-menu-content');
        notificationsMenuEl.classList.remove('open'); 
        contentEl.classList.remove('close');
        notificationsMenuEl.style.display = 'none';
        notificationsMenuEl.style.pointerEvents = '';
    }
}

export function showNotificationsMenu() {
    if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
        window.toggleSettingsMenu();
    }
    if (window.xinUpdater && typeof window.xinUpdater.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
        window.xinUpdater.hideSuccess(true);
    }
    if (window.SharePromoter && typeof window.SharePromoter.hideSharePrompt === 'function' && document.getElementById('sharePrompt')?.style.display === 'block') {
        window.SharePromoter.hideSharePrompt(true);
    }
    if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
        window.hideBookmarkPrompt(true);
    }

    if (dom.bookmarkPromptOverlay) {
        dom.bookmarkPromptOverlay.classList.add('show');
    }
    
    const contentEl = notificationsMenuEl.querySelector('.notifications-menu-content');
    
    contentEl.removeEventListener('animationend', onHideAnimationEnd);

    notificationsMenuEl.style.display = 'flex';
    notificationsMenuEl.style.pointerEvents = 'auto';
    notificationsMenuEl.classList.add('open');
    
    contentEl.classList.remove('close');
    void contentEl.offsetWidth;
    contentEl.classList.add('open');

    setTimeout(() => fetchNotificationsFromBackend(), 10);
}

export function hideNotificationsMenu(calledByOther) {
    if (!notificationsMenuEl.classList.contains('open')) return;

    if (dom.bookmarkPromptOverlay && !calledByOther) {
        dom.bookmarkPromptOverlay.classList.remove('show');
    }

    notificationsMenuEl.style.pointerEvents = 'none';

    const contentEl = notificationsMenuEl.querySelector('.notifications-menu-content');
    contentEl.classList.remove('open');
    contentEl.classList.add('close');
    
    contentEl.addEventListener('animationend', onHideAnimationEnd, { once: true });
}

export function toggleNotificationsMenu() {
    const contentEl = notificationsMenuEl.querySelector('.notifications-menu-content');
    if (notificationsMenuEl.classList.contains('open') && !contentEl.classList.contains('close')) {
        hideNotificationsMenu(false);
    } else {
        showNotificationsMenu();
    }
}

function markAllAsRead(silent = false) {
    let changed = false;
    notificationsCache.forEach(notif => {
        if (notif.isNew) {
            notif.isNew = false;
            changed = true;
        }
    });
    
    if (changed) {
        saveNotifications();
        renderNotifications();
        updateNotificationIcon();
        if (!silent && typeof window.showToast === 'function') {
             window.showToast('success', 'Marked all Notifications as read!', 'check-circle');
        }
    } else if (!silent && typeof window.showToast === 'function') {
         window.showToast('info', 'No unread Notifications!', 'info-circle');
    }
}

export function initializeNotifications() {
    notificationsMenuEl = document.getElementById('notifications-menu');
    if (!notificationsMenuEl) {
        notificationsMenuEl = document.createElement('div');
        notificationsMenuEl.id = 'notifications-menu';
        notificationsMenuEl.className = 'notifications-menu';
        document.body.appendChild(notificationsMenuEl);

        notificationsMenuEl.innerHTML = `
            <div class="notifications-menu-content">
                <div class="notifications-menu-header">
                    <h2>Notifications</h2>
                    <button id="mark-all-read-btn">Mark all as read</button>
                </div>
                <div class="notifications-list-container">
                    <ul class="notifications-list">
                        <p id="notifications-status" style="color: #b1b1b1; text-align: center; margin-top: 20px;">Fetching notifications...</p>
                    </ul>
                </div>
                <button id="close-notifications-menu">
                    <i class="fa-regular fa-times"></i>
                </button>
            </div>
        `;
    }

    const markAllBtn = document.getElementById('mark-all-read-btn');
    const closeBtn = document.getElementById('close-notifications-menu');

    if (!dom.notificationsBtn) return;
    
    loadNotifications();
    updateNotificationIcon();
    fetchNotificationsFromBackend();

    dom.notificationsBtn.addEventListener('click', e => {
        e.preventDefault();
        toggleNotificationsMenu();
    });

    if (closeBtn) closeBtn.addEventListener('click', () => hideNotificationsMenu(false));
    
    notificationsMenuEl.addEventListener('click', e => {
        if (e.target === notificationsMenuEl && notificationsMenuEl.classList.contains('open')) hideNotificationsMenu(false);
    });

    if (markAllBtn) markAllBtn.addEventListener('click', () => markAllAsRead(false));

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && notificationsMenuEl.classList.contains('open')) {
            hideNotificationsMenu(false);
        }
    });
    
    window.hideNotificationsMenu = hideNotificationsMenu;
    window.showNotificationsMenu = showNotificationsMenu;
    window.toggleNotificationsMenu = toggleNotificationsMenu;
}