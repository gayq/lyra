import { dom } from '../ui/dom.js';
import { DEFAULT_BOOKMARKS } from '../core/config.js';
import { canonicalize } from '../core/utils.js';

let bookmarksCache = null;
let isEditMode = false;

const getBookmarks = () => {
    if (bookmarksCache) return bookmarksCache;
    try {
        const raw = localStorage.getItem('xin-bookmarks');
        if (!raw) {
            bookmarksCache = DEFAULT_BOOKMARKS.slice();
            localStorage.setItem('xin-bookmarks', JSON.stringify(bookmarksCache));
        } else {
            bookmarksCache = JSON.parse(raw);
        }
    } catch {
        bookmarksCache = [];
    }
    return bookmarksCache;
};

const saveBookmarks = bookmarks => {
    bookmarksCache = bookmarks;
    localStorage.setItem('xin-bookmarks', JSON.stringify(bookmarks));
};

function updateAddButtonVisibility() {
    const bookmarks = getBookmarks();
    if (dom.addBookmarkLi) {
        if (isEditMode && bookmarks.length < 5) {
            dom.addBookmarkLi.style.display = 'list-item';
        } else {
            dom.addBookmarkLi.style.display = 'none';
        }
    }
}

const renderBookmarks = () => {
    const bookmarks = getBookmarks();
    dom.bookmarksList.querySelectorAll('.bookmark-item').forEach(item => item.remove());

    const fragment = document.createDocumentFragment();
    bookmarks.forEach((bookmark, index) => {
        const listItem = document.createElement('li');
        listItem.className = 'bookmark-item';
        listItem.dataset.index = index;
        listItem.draggable = true;
        
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'bookmark-link';
        link.onclick = e => { e.preventDefault(); window.WavesApp.handleSearch(bookmark.url); };
        
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'bookmark-icon';
        
        const icon = document.createElement('img');
        icon.className = 'bookmark-icon-img';
        icon.loading = 'lazy';
        try {
            icon.src = `https://www.google.com/s2/favicons?domain=${new URL(bookmark.url).hostname}&sz=64`;
        } catch {
            icon.src = '';
        }
        icon.onerror = () => {
            icon.remove();
            iconWrapper.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;color:#fff';
            iconWrapper.textContent = bookmark.name.charAt(0).toUpperCase();
        };
        
        iconWrapper.appendChild(icon);
        link.appendChild(iconWrapper);
        
        const name = document.createElement('span');
        name.className = 'bookmark-name';
        name.textContent = bookmark.name;
        link.appendChild(name);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'bookmark-delete-trigger';
        deleteBtn.innerHTML = '<i class="fa-regular fa-times"></i>';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            deleteBookmark(index);
        };

        const editBtn = document.createElement('button');
        editBtn.className = 'bookmark-edit-trigger';
        editBtn.innerHTML = '<i class="fa-regular fa-edit"></i>';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            setupAndShowBookmarkPrompt(index);
        };

        listItem.appendChild(link);
        listItem.appendChild(deleteBtn);
        listItem.appendChild(editBtn);
        fragment.appendChild(listItem);
    });
    
    if (dom.addBookmarkLi) {
        dom.bookmarksList.insertBefore(fragment, dom.addBookmarkLi);
    } else {
        dom.bookmarksList.appendChild(fragment);
    }
    
    setupDragAndDrop();
    updateAddButtonVisibility();
};

let draggedItem = null, draggedIndex = null;
const setupDragAndDrop = () => {
    const bookmarksContainer = document.getElementById('bookmarks-container');
    const bookmarkItems = dom.bookmarksList.querySelectorAll('.bookmark-item');
    
    bookmarkItems.forEach((item) => {
        item.addEventListener('dragstart', (e) => {
            if (bookmarksContainer.classList.contains('bookmarks-edit-mode')) {
                e.preventDefault();
                return;
            }
            draggedItem = item;
            draggedIndex = parseInt(item.dataset.index);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedIndex);
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging', 'drop-before', 'drop-after');
            draggedItem = null; draggedIndex = null;
        });
        
        item.addEventListener('dragover', (e) => {
            if (bookmarksContainer.classList.contains('bookmarks-edit-mode')) {
                e.preventDefault();
                return;
            }
            e.preventDefault(); 
            e.dataTransfer.dropEffect = 'move'; 
            item.classList.remove('drop-before'); 
            item.classList.add('drop-after'); 
        });
        
        item.addEventListener('dragleave', () => {
            item.classList.remove('drop-before', 'drop-after'); 
        });
        
        item.addEventListener('drop', (e) => {
            if (bookmarksContainer.classList.contains('bookmarks-edit-mode')) {
                e.preventDefault();
                return;
            }
            e.preventDefault();
            item.classList.remove('drop-before', 'drop-after');
            if (draggedItem && draggedIndex !== null) {
                const dropIndex = parseInt(item.dataset.index);
                const rect = item.getBoundingClientRect();
                let insertAt = (e.clientY >= rect.top + rect.height / 2) ? dropIndex + 1 : dropIndex;
                if (insertAt > draggedIndex) insertAt--;
                if (draggedIndex !== insertAt) {
                    const bookmarks = getBookmarks();
                    const [draggedBookmark] = bookmarks.splice(draggedIndex, 1);
                    bookmarks.splice(insertAt, 0, draggedBookmark);
                    saveBookmarks(bookmarks);
                    renderBookmarks();
                }
            }
            draggedItem = null; draggedIndex = null;
        });
    });
};

const deleteBookmark = index => {
    const bookmarks = getBookmarks();
    bookmarks.splice(index, 1);
    saveBookmarks(bookmarks);
    renderBookmarks();
};

const setupAndShowBookmarkPrompt = (index) => {
    const isEditing = typeof index === 'number';
    if (isEditing) {
        const bookmark = getBookmarks()[index];
        dom.bookmarkNameInput.value = bookmark.name;
        dom.bookmarkUrlInput.value = bookmark.url;
    }
    showBookmarkPrompt();
    dom.saveBookmarkBtn.onclick = () => {
        const name = dom.bookmarkNameInput.value.trim();
        let rawUrl = dom.bookmarkUrlInput.value.trim();
        if (!name || !rawUrl) { showToast('error', 'Name and URL cannot be empty!', 'warning'); return; }
        if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;
        try { new URL(rawUrl); } catch { showToast('error', 'Please enter a valid URL!', 'warning'); return; }
        const canonUrl = canonicalize(rawUrl);
        const bookmarks = getBookmarks();
        const otherBookmarks = isEditing ? bookmarks.filter((_, i) => i !== index) : bookmarks;
        const canonUrls = otherBookmarks.map(s => canonicalize(s.url));
        if (canonUrls.includes(canonUrl)) { showToast('error', 'That bookmark URL already exists!', 'warning'); return; }
        if (!isEditing && bookmarks.length >= 5) { showToast('error', 'You can only have 5 bookmarks!', 'warning'); return; }
        if (isEditing) bookmarks[index] = { name, url: canonUrl };
        else bookmarks.push({ name, url: canonUrl });
        saveBookmarks(bookmarks);
        renderBookmarks();
        hideBookmarkPrompt();
    };
};

const showBookmarkPrompt = () => {
    if (window.hideGamesMenu) window.hideGamesMenu(true);
    if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
        window.toggleSettingsMenu();
    }
    if (window.xinUpdater && typeof window.xinUpdater.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
        window.xinUpdater.hideSuccess(true);
    }
    if (window.SharePromoter && typeof window.SharePromoter.hideSharePrompt === 'function' && document.getElementById('sharePrompt')?.style.display === 'block') {
        window.SharePromoter.hideSharePrompt(true);
    }

    dom.bookmarkPromptOverlay?.classList.add('show');

    dom.bookmarkPrompt.style.display = 'block';
    
    dom.bookmarkPrompt.classList.remove('fade-out-prompt');
    dom.bookmarkPrompt.classList.add('fade-in-prompt');
};

const hideBookmarkPrompt = (calledByOther) => {
    dom.bookmarkNameInput.value = '';
    dom.bookmarkUrlInput.value = '';
    if (dom.saveBookmarkBtn) dom.saveBookmarkBtn.onclick = null;

    if (!calledByOther) {
        const settingsMenu = document.getElementById('settings-menu');
        const gamesMenu = document.getElementById('games-menu');
        const sharePrompt = document.getElementById('sharePrompt');
        const updateSuccess = document.getElementById('updateSuccess');
        const shortcutPrompt = document.getElementById('shortcut-prompt');
        const isOtherModalOpen = (settingsMenu && settingsMenu.classList.contains('open')) ||
                                 (gamesMenu && gamesMenu.classList.contains('open')) ||
                                 (sharePrompt && sharePrompt.style.display === 'block' && !sharePrompt.classList.contains('fade-out')) ||
                                 (updateSuccess && updateSuccess.style.display === 'block' && !updateSuccess.classList.contains('fade-out')) ||
                                 (shortcutPrompt && shortcutPrompt.style.display === 'block');

        if (dom.bookmarkPromptOverlay && !isOtherModalOpen) {
            dom.bookmarkPromptOverlay.classList.remove('show');
        }
    }

    dom.bookmarkPrompt.classList.add('fade-out-prompt');

    dom.bookmarkPrompt.addEventListener('animationend', (e) => {
        if (e.animationName === 'fadeOutPrompt') {
            dom.bookmarkPrompt.style.display = 'none';
            dom.bookmarkPrompt.classList.remove('fade-in-prompt', 'fade-out-prompt');
        }
    }, { once: true });
};

export function initializeBookmarks() {
    const bookmarksContainer = document.getElementById('bookmarks-container');
    const editToggleButton = document.getElementById('bookmarks-edit-toggle');

    window.hideBookmarkPrompt = hideBookmarkPrompt;
    renderBookmarks();
    
    dom.addBookmarkBtn?.addEventListener('click', () => setupAndShowBookmarkPrompt());
    dom.cancelBookmarkBtn?.addEventListener('click', () => hideBookmarkPrompt(false));
    dom.bookmarkPromptOverlay?.addEventListener('click', e => {
        if (e.target === dom.bookmarkPromptOverlay && dom.bookmarkPrompt.style.display === 'block') hideBookmarkPrompt(false);
    });

    if (editToggleButton && bookmarksContainer) {
        editToggleButton.addEventListener('click', () => {
            isEditMode = !isEditMode;
            bookmarksContainer.classList.toggle('bookmarks-edit-mode', isEditMode);
            editToggleButton.textContent = isEditMode ? 'Done' : 'Edit';
            updateAddButtonVisibility();
        });
    }
}