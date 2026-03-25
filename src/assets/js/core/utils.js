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

const _MK = 'q7Zx!9pL';

function _xorTransform(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
        out += String.fromCharCode(str.charCodeAt(i) ^ _MK.charCodeAt(i % _MK.length));
    }
    return out;
}

function _getKeyBytes() {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(_MK);
    const a = new Uint8Array(_MK.length);
    for (let i = 0; i < _MK.length; i++) a[i] = _MK.charCodeAt(i) & 0xff;
    return a;
}

function _xorBytes(bytes) {
    const key = _getKeyBytes();
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
    return out;
}

function _bytesToBinaryString(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return s;
}

function _binaryStringToBytes(binStr) {
    const out = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i) & 0xff;
    return out;
}

function _base64UrlEncodeBytes(bytes) {
    const b64 = btoa(_bytesToBinaryString(bytes));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function _base64UrlDecodeToBytes(b64url) {
    let p = b64url.replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return _binaryStringToBytes(atob(p));
}

export function decodeUrl(encodedUrl) {
    if (!encodedUrl) return '';
    
    try {
        const urlObject = new URL(encodedUrl, window.location.origin);
        if (urlObject.pathname.startsWith('/!!/')) {
            let encodedPart = urlObject.pathname.slice('/!!/'.length);
            if (encodedPart.endsWith('/')) encodedPart = encodedPart.slice(0, -1);

            try {
                const xoredBytes = _base64UrlDecodeToBytes(encodedPart);
                const rawBytes = _xorBytes(xoredBytes);
                const percentEncoded = (typeof TextDecoder !== 'undefined')
                    ? new TextDecoder().decode(rawBytes)
                    : _bytesToBinaryString(rawBytes);
                const result = decodeURIComponent(percentEncoded);
                if (result.startsWith('http://') || result.startsWith('https://')) {
                    return result + urlObject.search + urlObject.hash;
                }
            } catch(e) {}

            if (encodedPart.startsWith('http://') || encodedPart.startsWith('https://')) {
                return encodedPart + urlObject.search + urlObject.hash;
            }
            try {
                return decodeURIComponent(encodedPart) + urlObject.search + urlObject.hash;
            } catch {
                return encodedPart + urlObject.search + urlObject.hash;
            }
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

export function encodeMochiUrl(url) {
    if (!url) return '';
    try {
        const percentEncoded = encodeURIComponent(String(url));
        if (typeof TextEncoder !== 'undefined') {
            const bytes = new TextEncoder().encode(percentEncoded);
            return _base64UrlEncodeBytes(_xorBytes(bytes));
        }

        const xored = _xorTransform(percentEncoded);
        return btoa(xored).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch(e) {
        try {
            return encodeURIComponent(String(url));
        } catch {
            return '';
        }
    }
}

export function getProxyUrl(url) {
    if (!url) return '';
    const encoded = encodeMochiUrl(url);
    return '/!!/' + encoded + '/';
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