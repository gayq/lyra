export function normalizeUrl(urlStr) {
    if (!urlStr || urlStr === 'about:blank') return urlStr;
    try {
        const url = new URL(urlStr);
        url.searchParams.delete('ia');
        return url.toString();
    } catch {
        return urlStr;
    }
}

export function decodeUrl(encodedUrl) {
    if (!encodedUrl) return '';
    
    try {
        const urlObject = new URL(encodedUrl, window.location.origin);
        if (urlObject.pathname.startsWith('/!!/')) {
            return urlObject.pathname.slice('/!!/'.length) + urlObject.search + urlObject.hash;
        }
    } catch(e) {}

    try {
        const selectedBackend = localStorage.getItem("backend") ?? "scramjet";
        if (selectedBackend === 'ultraviolet') {
            const prefix = window['__uv$config']?.prefix ?? '/b/u/hi/';
            const decodeFunction = window['__uv$config']?.decodeUrl ?? decodeURIComponent;
            const urlObject = new URL(encodedUrl, window.location.origin);
            if (urlObject.pathname.startsWith(prefix)) {
                const encodedPart = urlObject.pathname.slice(prefix.length);
                return decodeFunction(encodedPart) + urlObject.search + urlObject.hash;
            }
        } else if (selectedBackend === 'scramjet') {
            const prefix = '/b/s/';
            try {
                const urlObject = new URL(encodedUrl, window.location.origin);
                if (urlObject.pathname.startsWith(prefix)) {
                    let pathPart = urlObject.pathname.slice(prefix.length);
                    let reconstructedUrl = decodeURIComponent(pathPart + urlObject.search + urlObject.hash);
                    return reconstructedUrl;
                }
            } catch (e) {}
            if (window.sj && typeof window.sj.decode === 'function') {
                return window.sj.decode(encodedUrl);
            }
        }
    } catch (e) {}

    try {
        return decodeURIComponent(encodedUrl);
    } catch {
        return encodedUrl;
    }
}

export function getProxyUrl(url) {
    if (!url) return '';
    return '/!!/' + url;
}

export function canonicalize(u) {
    try {
        const url = new URL(u);
        url.pathname = url.pathname.replace(/\/+$/, '');
        url.hostname = url.hostname.toLowerCase();
        return url.toString();
    } catch {
        return u;
    }
}

export function toggleButtonAnimation(button, animationClass) {
    if (button) {
        button.classList.add(animationClass);
        setTimeout(() => button.classList.remove(animationClass), 200);
    }
}