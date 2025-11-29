import { dom } from '../ui/dom.js';
import { DEFAULT_BOOKMARKS } from '../core/config.js';
import { canonicalize, getProxyUrl } from '../core/utils.js';

let bookmarksCache = null;
let isEditMode = false;
let bookmarksListEl = null;
let addBookmarkLiEl = null;
let addBookmarkBtnEl = null;
let bookmarkPromptEl = null;
let bookmarkNameInputEl = null;
let bookmarkUrlInputEl = null;
let saveBookmarkBtnEl = null;
let cancelBookmarkBtnEl = null;

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
    if (addBookmarkLiEl) {
        if (isEditMode && bookmarks.length < 5) {
            addBookmarkLiEl.style.display = 'list-item';
        } else {
            addBookmarkLiEl.style.display = 'none';
        }
    }
}

const renderBookmarks = () => {
    if (!bookmarksListEl) return;
    const bookmarks = getBookmarks();
    bookmarksListEl.querySelectorAll('.bookmark-item').forEach(item => item.remove());

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
        iconWrapper.className = 'bookmark-icon skeleton';
        
        const icon = document.createElement('img');
        icon.className = 'bookmark-icon-img';
        icon.loading = 'lazy';
        
        icon.onload = () => {
            iconWrapper.classList.remove('skeleton');
        };

        try {
            const originalFavicon = `https://www.google.com/s2/favicons?domain=${new URL(bookmark.url).hostname}&sz=64`;
            icon.src = getProxyUrl(originalFavicon);
        } catch {
            icon.src = '';
        }
        
        icon.onerror = () => {
            iconWrapper.classList.remove('skeleton');
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
        editBtn.innerHTML = '<i class="fa-regular fa-pencil"></i>';
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
    
    if (addBookmarkLiEl) {
        bookmarksListEl.insertBefore(fragment, addBookmarkLiEl);
    } else {
        bookmarksListEl.appendChild(fragment);
    }
    
    setupDragAndDrop();
    updateAddButtonVisibility();
};

let draggedItem = null, draggedIndex = null;
const setupDragAndDrop = () => {
    const bookmarksContainer = document.getElementById('bookmarks-container');
    if (!bookmarksContainer || !bookmarksListEl) return;
    
    const bookmarkItems = bookmarksListEl.querySelectorAll('.bookmark-item');
    
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
        if(bookmarkNameInputEl) bookmarkNameInputEl.value = bookmark.name;
        if(bookmarkUrlInputEl) bookmarkUrlInputEl.value = bookmark.url;
    }
    showBookmarkPrompt();
    if(saveBookmarkBtnEl) saveBookmarkBtnEl.onclick = () => {
        const name = bookmarkNameInputEl ? bookmarkNameInputEl.value.trim() : '';
        let rawUrl = bookmarkUrlInputEl ? bookmarkUrlInputEl.value.trim() : '';
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

    if(bookmarkPromptEl) {
        bookmarkPromptEl.style.display = 'block';
        bookmarkPromptEl.classList.remove('fade-out-prompt');
        bookmarkPromptEl.classList.add('fade-in-prompt');
    }
};

const hideBookmarkPrompt = (calledByOther) => {
    if(bookmarkNameInputEl) bookmarkNameInputEl.value = '';
    if(bookmarkUrlInputEl) bookmarkUrlInputEl.value = '';
    if (saveBookmarkBtnEl) saveBookmarkBtnEl.onclick = null;

    if (!calledByOther && dom.bookmarkPromptOverlay) {
        dom.bookmarkPromptOverlay.classList.remove('show');
    }

    if(bookmarkPromptEl) {
        bookmarkPromptEl.classList.add('fade-out-prompt');
        bookmarkPromptEl.addEventListener('animationend', (e) => {
            if (e.animationName === 'fadeOut') {
                bookmarkPromptEl.style.display = 'none';
                bookmarkPromptEl.classList.remove('fade-in-prompt', 'fade-out-prompt');
            }
        }, { once: true });
    }
};

export function initializeBookmarks() {
    let bookmarksContainer = document.getElementById('bookmarks-container');
    if (!bookmarksContainer) {
        bookmarksContainer = document.createElement('div');
        bookmarksContainer.id = 'bookmarks-container';
        bookmarksContainer.innerHTML = `
            <div class="bookmarks-header">
                <h3 id="bookmarks-title">Bookmarks</h3>
                <button id="bookmarks-edit-toggle">Edit</button>
            </div>
            <div class="bookmarks-wrapper">
                <ul id="bookmarks-list">
                    <li class="bookmark-item-add">
                        <button id="add-bookmark-btn"><i class="fa-regular fa-plus"></i></button>
                    </li>
                </ul>
            </div>
        `;
        
        const iframeContainer = document.getElementById('iframe-container');
        const contentWrapper = document.querySelector('.wrapper');
        if (contentWrapper && iframeContainer) {
            contentWrapper.insertBefore(bookmarksContainer, iframeContainer);
        } else if (contentWrapper) {
             contentWrapper.appendChild(bookmarksContainer);
        }
    }

    bookmarksListEl = document.getElementById('bookmarks-list');
    addBookmarkLiEl = bookmarksContainer.querySelector('.bookmark-item-add');
    addBookmarkBtnEl = document.getElementById('add-bookmark-btn');
    
    bookmarkPromptEl = document.getElementById('bookmark-prompt');
    if (!bookmarkPromptEl) {
        bookmarkPromptEl = document.createElement('div');
        bookmarkPromptEl.id = 'bookmark-prompt';
        bookmarkPromptEl.className = 'popup';
        bookmarkPromptEl.style.display = 'none';
        document.body.appendChild(bookmarkPromptEl);

        bookmarkPromptEl.innerHTML = `
            <div class="input-container">
                <label>Bookmark Name:</label>
                <input type="text" id="bookmarkName" placeholder="My Cool Website" autocomplete="off">
                <label style="margin-top:15px;">Bookmark URL:</label>
                <input type="text" id="bookmarkUrl" placeholder="https://example.com/" autocomplete="off">
                <div style="display:flex;justify-content:center;gap:10px;margin-top:20px;">
                    <button id="saveBookmarkBtn">Save</button>
                    <button id="cancelBookmarkBtn" style="background-color:#0f0f0f;color:white;" onmouseover="this.style.backgroundColor='#1f1f1f';" onmouseout="this.style.backgroundColor='#0f0f0f';">Cancel</button>
                </div>
            </div>
        `;
    }

    bookmarkNameInputEl = document.getElementById('bookmarkName');
    bookmarkUrlInputEl = document.getElementById('bookmarkUrl');
    saveBookmarkBtnEl = document.getElementById('saveBookmarkBtn');
    cancelBookmarkBtnEl = document.getElementById('cancelBookmarkBtn');

    const editToggleButton = document.getElementById('bookmarks-edit-toggle');

    window.hideBookmarkPrompt = hideBookmarkPrompt;
    renderBookmarks();
    
    if (addBookmarkBtnEl) addBookmarkBtnEl.addEventListener('click', () => setupAndShowBookmarkPrompt());
    
    if(cancelBookmarkBtnEl) cancelBookmarkBtnEl.addEventListener('click', () => hideBookmarkPrompt(false));
    
    dom.bookmarkPromptOverlay?.addEventListener('click', e => {
        if (e.target === dom.bookmarkPromptOverlay && bookmarkPromptEl.style.display === 'block') hideBookmarkPrompt(false);
    });

    if (editToggleButton && bookmarksContainer) {
        editToggleButton.addEventListener('click', () => {
            isEditMode = !isEditMode;
            bookmarksContainer.classList.toggle('bookmarks-edit-mode', isEditMode);
            editToggleButton.textContent = isEditMode ? 'Done' : 'Edit';
            updateAddButtonVisibility();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const prompt = document.getElementById('bookmark-prompt');
            if (prompt && prompt.style.display === 'block' && !prompt.classList.contains('fade-out-prompt')) {
                hideBookmarkPrompt(false);
            }
        }
    });
}