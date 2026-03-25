document.addEventListener('DOMContentLoaded', function () {
    const overlay = document.getElementById('overlay');

    let toastContainer = document.querySelector('.toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }

    const activeToasts = new Map();
    let hoverTimeout;

    toastContainer.addEventListener('mouseenter', () => {
        clearTimeout(hoverTimeout);
        activeToasts.forEach(controller => controller.pause());
        updateToastPositions(true);
    });

    toastContainer.addEventListener('mouseleave', () => {
        hoverTimeout = setTimeout(() => {
            activeToasts.forEach(controller => controller.start());
            updateToastPositions(false);
        }, 100);
    });

    const updateToastPositions = (isHovered = false) => {
        const toasts = Array.from(toastContainer.querySelectorAll('.toast:not(.is-hiding)'));
        const visibleStackedCount = 3;

        let cumulativeHeight = 0;

        toasts.forEach((toast, index) => {
            toast.style.zIndex = toasts.length - index;

            if (isHovered) {
                const hoverGap = 13;
                toast.style.transform = `translateY(-${cumulativeHeight}px) scale(1)`;
                toast.style.opacity = '1';
                cumulativeHeight += toast.offsetHeight + hoverGap;
            } else {
                if (index < visibleStackedCount) {
                    const scale = 1 - (index * 0.05);
                    const translateY = index * -12;
                    toast.style.transform = `translateY(${translateY}px) scale(${scale})`;
                    toast.style.opacity = '1';
                } else {
                    const lastVisibleIndex = visibleStackedCount - 1;
                    const scale = 1 - (lastVisibleIndex * 0.05);
                    const translateY = lastVisibleIndex * -12;
                    toast.style.transform = `translateY(${translateY}px) scale(${scale})`;
                    toast.style.opacity = '0';
                }
            }
        });
    };

    window.showToast = function (type, message, iconName, arg4, arg5) {
        let duration = 3000;
        let actions = [];

        if (Array.isArray(arg4)) {
            actions = arg4;
        } else if (typeof arg4 === 'number') {
            duration = arg4;
            if (Array.isArray(arg5)) actions = arg5;
        }

        const maxToasts = 3;
        const currentToasts = toastContainer.querySelectorAll('.toast:not(.is-hiding)');

        if (currentToasts.length >= maxToasts) {
            const oldestToast = currentToasts[currentToasts.length - 1];
            hideToast(oldestToast);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(100%)';

        const icons = {
            'success': 'fa-solid fa-check-circle',
            'error': 'fa-solid fa-times-circle',
            'info': 'fa-solid fa-info-circle'
        };
        const iconClass = iconName ? `fa-solid fa-${iconName}` : (icons[type] || 'fa-solid fa-info-circle');

        const content = document.createElement('div');
        content.className = 'toast-content';
        content.innerHTML = `<i class="${iconClass}"></i><span>${message}</span>`;
        toast.appendChild(content);

        if (actions && actions.length > 0) {
            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'toast-actions';

            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = 'toast-btn';
                if (action.class) btn.classList.add(action.class);
                btn.textContent = action.text;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (action.callback) action.callback();
                    if (action.dismiss !== false) hideToast(toast);
                };
                actionsContainer.appendChild(btn);
            });

            toast.appendChild(actionsContainer);
        }

        const controller = {
            id: null,
            remaining: duration,
            startTime: null,
            pause: function () {
                if (this.id) {
                    clearTimeout(this.id);
                    this.id = null;
                    this.remaining -= (Date.now() - this.startTime);
                }
            },
            start: function () {
                if (this.remaining === 0) return;
                if (this.id || this.remaining <= 0) return;
                this.startTime = Date.now();
                this.id = setTimeout(() => hideToast(toast), this.remaining);
            },
            clear: function () {
                clearTimeout(this.id);
            },
            hide: function () {
                hideToast(toast);
            },
            update: function (newType, newMessage, newIcon) {
                if (newType) {
                    toast.className = `toast ${newType}`;
                }
                if (newMessage || newIcon) {
                    const i = toast.querySelector('i');
                    const span = toast.querySelector('span');
                    if (newIcon && i) i.className = `fa-solid fa-${newIcon}`;
                    if (newMessage && span) span.textContent = newMessage;
                }
            }
        };

        activeToasts.set(toast, controller);

        toastContainer.prepend(toast);

        void toast.offsetWidth;

        setTimeout(() => {
            updateToastPositions(toastContainer.matches(':hover'));
        }, 10);

        controller.start();
        return controller;
    };

    function hideToast(toast) {
        if (!toast || !toast.parentNode || toast.classList.contains('is-hiding')) {
            return;
        }

        if (activeToasts.has(toast)) {
            activeToasts.get(toast).clear();
            activeToasts.delete(toast);
        }

        toast.style.zIndex = '-1';
        toast.classList.add('is-hiding');

        toast.addEventListener('transitionend', () => {
            toast.remove();
        }, { once: true });

        updateToastPositions(toastContainer.matches(':hover'));
    }
});