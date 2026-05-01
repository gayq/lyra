const _MK = "q7Zx!9pL";

function _xor(str) {
    let out = "";
    for (let i = 0; i < str.length; i++) {
        out += String.fromCharCode(str.charCodeAt(i) ^ _MK.charCodeAt(i % _MK.length));
    }
    return out;
}

self.__uv$config = {
	prefix: '/b/u/r/',
	encodeUrl: function(url) {
        if (!url) return url;
        try {
            const pct = encodeURIComponent(url);
            const xored = _xor(pct);
            return btoa(xored).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        } catch(e) { return url; }
    },
	decodeUrl: function(url) {
        if (!url) return url;
        try {
            let b64 = url.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) b64 += "=";
            const xored = atob(b64);
            return decodeURIComponent(_xor(xored));
        } catch(e) { return url; }
    },
	handler: '/b/u/hanhan.js',
	client: '/b/u/clicli.js',
	bundle: '/b/u/bunbun.js',
	config: '/b/u/concon.js',
	sw: '/b/u/serser.js'
};