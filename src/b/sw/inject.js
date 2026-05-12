const INJECT_SHARED_PREAMBLE = `
<script>
(function(){
var _P='${MOCHI_PREFIX}',_U='${UV_PREFIX}',_S=${isScramjet},_V=${isUltraviolet};
var _K='q7Zx!9pL',_xd=function(s){var o='';for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^_K.charCodeAt(i%_K.length));return o;};
var dU=function(h){
  if(!h)return h;
  try{
    var u=new URL(h,location.origin);
    if(u.pathname.startsWith(_P)){
      var p=u.pathname.slice(_P.length);
      if(p.endsWith('/'))p=p.slice(0,-1);
      try{
        var r=p.replace(/-/g,'+').replace(/_/g,'/');
        while(r.length%4)r+='=';
        var d=_xd(atob(r));
        d=decodeURIComponent(d);
        if(d.indexOf('http://')===0||d.indexOf('https://')===0)return d+u.search+u.hash
      }catch(e){}
      if(p.indexOf('http://')===0||p.indexOf('https://')===0)return p+u.search+u.hash;
      return p+u.search+u.hash
    }
    if(_S&&u.pathname.indexOf('/b/s/')===0){
      var raw=u.pathname.slice(5)+u.search+u.hash;
      try{return decodeURIComponent(raw)}catch(e){return raw}
    }
    if(_V){
      try{
        var pf=(self.__uv$config&&self.__uv$config.prefix)||_U;
        if(u.pathname.indexOf(pf)===0&&self.__uv$config&&typeof self.__uv$config.decodeUrl==='function')
          return self.__uv$config.decodeUrl(u.pathname.slice(pf.length))+u.search+u.hash
      }catch(e){}
    }
    return u.href
  }catch(e){return h}
};
`;

const SPA_PATCH = `
(function(){
  function ok(e){
    try{var m=e&&e.message!=null?String(e.message):'';return m.indexOf('ResizeObserver')!==-1}catch(x){return false}
  }
  function ok2(e){
    try{var r=e&&e.reason,m=r&&(typeof r.message==='string'?r.message:(r&&r.toString&&r.toString())||'')||'';return String(m).indexOf('ResizeObserver')!==-1}catch(x){return false}
  }
  self.addEventListener('error',function(e){if(ok(e)){e.preventDefault();e.stopImmediatePropagation()}},true);
  self.addEventListener('unhandledrejection',function(e){if(ok2(e))e.preventDefault()});
  var h=(location.hostname||'').toLowerCase();
  if(h.indexOf('discord.com')!==-1||h.indexOf('discordapp.com')!==-1){
    try{self.__SENTRY__={hub:{getClient:function(){return{getOptions:function(){return{}}}}}}}catch(x){}
    try{localStorage.setItem('hideMessageRequests','true')}catch(e){}
  }
})()
`;

const TURN_SCRIPT = `
(function(relayOnly){
  var O=window.RTCPeerConnection;
  if(!O)return;
  var s={urls:'turn:${self.location.hostname}:3478',username:'enniuu',credential:'enni'};
  function W(cfg,cs){
    var c=cfg?Object.assign({},cfg):{};
    c.iceTransportPolicy='relay';
    if(relayOnly){
      if(c.iceServers)c.iceServers=c.iceServers.filter(function(s){
        if(!s||!s.urls)return false;
        var u=Array.isArray(s.urls)?s.urls:[s.urls];
        return u.every(function(u){return u.indexOf('turn:')===0||u.indexOf('turns:')===0})
      });
      if(!c.iceServers||c.iceServers.length===0)c.iceServers=[s]
    }else{
      if(!c.iceServers)c.iceServers=[];
      c.iceServers=c.iceServers.filter(function(s){
        if(!s||!s.urls)return false;
        var u=Array.isArray(s.urls)?s.urls:[s.urls];
        return u.some(function(u){return u.indexOf('turn:')===0||u.indexOf('turns:')===0})
      });
      c.iceServers.push(s)
    }
    return cs!==undefined?new O(c,cs):new O(c)
  }
  W.prototype=O.prototype;
  try{Object.defineProperty(W,'name',{value:'RTCPeerConnection'})}catch(e){}
  window.RTCPeerConnection=W
})(\${true})
`;

const SOUNDCLOUD_PATCH = `
(function(){
  function onSC(){
    try{
      var h=(location.hostname||'').toLowerCase();
      if(h.indexOf('soundcloud.com')!==-1)return true;
      var href=location.href||'';
      if(!href)return false;
      try{var d=dU(href)||'';if(d&&d.indexOf('soundcloud.com')!==-1)return true}catch(e){}
      try{var u=new URL(href);if((u.pathname||'').indexOf('soundcloud.com')!==-1)return true}catch(e){}
    }catch(e){}
    return false
  }
  if(!onSC())return;
  var cs='button.modal__closeButton, .modal.auth-modal button[title="Close"]';
  var ao='#app .sign-in-up-form, #app .connect-form-title-ui-evo, main.vertically-centered-ui-evo';
  var fs='.modalWhiteout, .g-z-index-modal-background, .g-z-index-overlay, .g-backdrop-filter-grayscale';
  var ai='iframe[src*="secure.soundcloud.com/web-auth"], iframe[scramjet-attr-src*="secure.soundcloud.com/web-auth"], iframe[src*="embedded_in_iframe=true"], iframe[scramjet-attr-src*="embedded_in_iframe=true"]';
  var pb='div.banner.m-promotion, .banner.m-promotion.primary, .banner.l-inner-fullwidth.primary';
  function hide(el){
    try{
      el.style.setProperty('display','none','important');
      el.style.setProperty('visibility','hidden','important');
      el.style.setProperty('opacity','0','important');
      if(el.parentNode)el.parentNode.removeChild(el)
    }catch(e){}
  }
  function hideModal(fromBtn){
    try{var m=fromBtn?fromBtn.closest('.modal.auth-modal, .modal'):null;if(m)hide(m)}catch(e){}
  }
  function reset(){
    try{
      var ns=[document.documentElement,document.body];
      for(var i=0;i<ns.length;i++){
        if(!ns[i]||!ns[i].style)continue;
        ns[i].style.removeProperty('overflow');
        ns[i].style.removeProperty('overflow-y');
        ns[i].style.removeProperty('padding-right');
        ns[i].style.removeProperty('position')
      }
    }catch(e){}
  }
  function closeNow(){
    try{
      var btns=document.querySelectorAll(cs);
      for(var i=0;i<btns.length;i++){
        var b=btns[i];
        if(!b||b._wc)continue;
        b._wc=true;
        try{b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}))}catch(e){}
        try{b.click()}catch(e){}
        setTimeout(function(){hideModal(b)},40)
      }
      var om=document.querySelector('.modal.auth-modal.showBackground, .modal.auth-modal');
      if(om)hideModal(om.querySelector('button.modal__closeButton'));
      var hit=document.querySelector(ao);
      if(hit){
        var rt=hit.closest('main.vertically-centered-ui-evo')||hit.closest('.vertically-centered-ui-evo')||hit.closest('#app > div')||hit;
        if(rt)hide(rt)
      }
      var frames=document.querySelectorAll(ai);
      for(var j=0;j<frames.length;j++){if(frames[j])hide(frames[j])}
      var shells=document.querySelectorAll(fs);
      for(var k=0;k<shells.length;k++){
        var sh=shells[k];
        if(!sh)continue;
        var hasAuth=sh.querySelector('.sign-in-up-form, .connect-form-title-ui-evo, button.modal__closeButton');
        if(!hasAuth)hide(sh)
      }
      try{
        var app=document.getElementById('app');
        if(app){
          var f=app.firstElementChild;
          if(f&&app.childElementCount===1&&f.childElementCount===0)hide(f);
          var t=(app.textContent||'').trim();
          if(app.childElementCount===0&&!t)hide(app)
        }
      }catch(e){}
      var banners=document.querySelectorAll(pb);
      for(var l=0;l<banners.length;l++){if(banners[l])hide(banners[l])}
      document.querySelectorAll('a.targetedGoUpsellBanner__link').forEach(function(a){
        var b=a&&a.closest&&a.closest('.banner');
        if(b&&b.parentNode)b.parentNode.removeChild(b)
      });
      reset()
    }catch(e){}
  }
  closeNow();
  var obs=new MutationObserver(function(){closeNow()});
  obs.observe(document.documentElement||document,{childList:true,subtree:true});
  setInterval(closeNow,150)
})()
`;

const HOVER_PREFETCH_SCRIPT = `
(function(){
  if(!('serviceWorker'in navigator))return;
  var max=40,sent=Object.create(null),cnt=0,tm=null,swRef=null;
  function kH(h){try{return String(h||'').split('#')[0]}catch(e){return''}}
  function onP(){try{var p=location.pathname||'';return p.indexOf('/b/s/')===0||p.indexOf('/b/u/')===0}catch(e){return false}}
  function prU(abs){
    try{
      var u=new URL(abs,location.href);
      if(u.origin===location.origin){
        var p=u.pathname||'';
        if(p.indexOf('/b/s/r/')===0)return kH(u.href);
        if(p.indexOf('/b/u/')===0&&p.length>10)return kH(u.href);
        return null
      }
      if(!onP())return null;
      if(u.protocol!=='http:'&&u.protocol!=='https:')return null;
      var raw=kH(u.href);
      if(_S)return kH(location.origin+'/b/s/r/'+raw);
      if(_V&&window.__uv$config&&typeof window.__uv$config.encodeUrl==='function'){
        var pref=window.__uv$config.prefix||'/b/u/r/';
        return kH(location.origin+pref+window.__uv$config.encodeUrl(raw))
      }
      return null
    }catch(e){return null}
  }
  function aFE(ev){
    var t=ev.target;
    if(t&&t.closest){var a=t.closest('a[href]');if(a)return a}
    var path=ev.composedPath&&ev.composedPath();
    if(path)for(var i=0;i<path.length;i++){var n=path[i];if(!n||n.nodeType!==1)continue;if(n.tagName==='A'&&n.getAttribute('href'))return n}
    return null
  }
  function pS(w,url){
    if(!w||typeof w.postMessage!=='function')return false;
    try{w.postMessage({type:'waves-prefetch',url:url});return true}catch(e){return false}
  }
  async function pf(url){
    if(!url||sent[url])return;
    if(cnt>=max)return;
    var c=null;
    try{c=navigator.serviceWorker.controller}catch(e){}
    if(!c)c=swRef;
    if(!c){
      try{
        var reg=await navigator.serviceWorker.ready;
        c=reg.active||reg.waiting||reg.installing||navigator.serviceWorker.controller;
        if(c)swRef=c
      }catch(e){}
    }else swRef=c;
    if(c&&pS(c,url)){sent[url]=1;cnt++;return}
    try{var tp=window.top;if(tp&&tp!==window){tp.postMessage({type:'waves-prefetch-bridge',url:url},location.origin);sent[url]=1;cnt++;return}}catch(e){}
  }
  function qP(ev){
    var el=aFE(ev);
    if(!el)return null;
    var raw=el.getAttribute('href');
    if(!raw||raw.indexOf('javascript:')===0||raw==='#')return null;
    var abs;try{abs=new URL(raw,location.href).href}catch(e){return null}
    return prU(abs)
  }
  document.addEventListener('pointerover',function(ev){
    var p=qP(ev);if(!p)return;
    clearTimeout(tm);tm=setTimeout(function(){pf(p)},25)
  },true);
  document.addEventListener('pointerdown',function(ev){
    var p=qP(ev);if(!p)return;
    pf(p)
  },true)
})()
`;

const META_SCRIPT = `
(function(){
  var isTop;try{isTop=window.top===window}catch(e){isTop=false}
  var mE=function(s){
    if(!s)return'';
    var k='wb!';
    try{var e=encodeURIComponent(s),r='';for(var i=0;i<e.length;i++)r+=String.fromCharCode(e.charCodeAt(i)^k.charCodeAt(i%k.length));return btoa(r)}catch(e){return s}
  };
  var tabId;try{if(window.name&&!isNaN(parseInt(window.name,10)))tabId=window.name;else tabId=window.frameElement&&window.frameElement.dataset?window.frameElement.dataset.tabId||null:null}catch(e){tabId=null}
  var swRef=null,lU=null,lT=null,lF=null;
  function pT(){
    try{
      var src=[function(){return(document.title||'').trim()},function(){var og=document.querySelector('meta[property="og:title"], meta[name="og:title"]');return og&&og.content?og.content.trim():''},function(){var tw=document.querySelector('meta[property="twitter:title"], meta[name="twitter:title"]');return tw&&tw.content?tw.content.trim():''},function(){var mt=document.querySelector('meta[name="title"], meta[property="title"]');return mt&&mt.content?mt.content.trim():''},function(){var h=document.querySelector('h1,h2,h3');return h&&h.textContent?h.textContent.trim():''}];
      for(var i=0;i<src.length;i++){var v=src[i]();if(v)return v}
      return''
    }catch(e){return''}
  }
  function pI(){
    try{
      var ls=document.querySelectorAll('link[rel~="icon"], link[rel*="icon"]');
      for(var i=0;i<ls.length;i++){var h=ls[i].getAttribute('href');if(!h)continue;try{return new URL(h,location.href).href}catch(e){}}
      try{return new URL('/favicon.ico',location.href).href}catch(e){}
      return null
    }catch(e){return null}
  }
  async function sM(){
    if(!isTop&&!tabId)return;
    if(!('serviceWorker'in navigator))return;
    try{
      var c=navigator.serviceWorker.controller;
      if(!c)c=swRef;
      if(!c){
        var reg=await navigator.serviceWorker.ready;
        c=reg.active||reg.waiting||reg.installing||navigator.serviceWorker.controller;
        if(c)swRef=c
      }else swRef=c;
      if(!c)return;
      var url=location.href,title=pT(),rf=pI(),df=rf?dU(rf):null;
      if(lU===url&&lT===title&&lF===rf)return;
      lU=url;lT=title;lF=rf;
      c.postMessage({type:'page-meta',url:mE(url),decodedUrl:mE(dU(url)),title:mE(title),favicon:mE(df||rf||null),rawFavicon:mE(rf||null),tabId:tabId,isTopFrame:isTop,encoded:true})
    }catch(e){}
  }
  var rM=function(){sM()};
  var dS=false;
  var rAF=typeof requestAnimationFrame==='function'?requestAnimationFrame:function(cb){setTimeout(cb,16)};
  var mD=function(){if(dS)return;dS=true;rAF(function(){dS=false;rM()})};
  var mic=typeof queueMicrotask==='function'?function(fn){queueMicrotask(fn)}:function(fn){Promise.resolve().then(fn)};
  var mN=function(){mic(function(){rM()});rAF(function(){rM();rAF(function(){rM()})})};
  function hH(){
    try{
      var push=history.pushState;history.pushState=function(){var r=push.apply(this,arguments);mN();return r};
      var replace=history.replaceState;history.replaceState=function(){var r=replace.apply(this,arguments);mN();return r}
    }catch(e){}
  }
  function bT(el){
    try{if(!el||el._wo)return;el._wo=true;var o=new MutationObserver(function(){mD()});o.observe(el,{childList:true,subtree:true,characterData:true})}catch(e){}
  }
  function hHt(muts){
    try{
      for(var i=0;i<muts.length;i++){
        var m=muts[i],t=m.target;
        if(!t)continue;
        if(m.type==='characterData'){var p=t.parentElement;if(p&&p.nodeName&&p.nodeName.toUpperCase()==='TITLE')return true;continue}
        if(m.type==='attributes'){var n=t.nodeName&&t.nodeName.toUpperCase();if(n==='META'||n==='LINK'||n==='TITLE')return true;continue}
        if(m.type==='childList'){
          var tn=t.nodeName&&t.nodeName.toUpperCase();
          if(tn==='TITLE'||tn==='META'||tn==='LINK')return true;
          if(tn==='HEAD'){
            var na=m.addedNodes;for(var j=0;j<na.length;j++){var nn=na[j]&&na[j].nodeName&&na[j].nodeName.toUpperCase();if(nn==='TITLE'||nn==='META'||nn==='LINK')return true}
            var nr=m.removedNodes;for(var k=0;k<nr.length;k++){var rn=nr[k]&&nr[k].nodeName&&nr[k].nodeName.toUpperCase();if(rn==='TITLE'||rn==='META'||rn==='LINK')return true}
          }
        }
      }
    }catch(e){}
    return false
  }
  function wH(){
    try{
      bT(document.querySelector('title'));
      var h=document.head||document.documentElement;
      if(!h||h._who)return;
      h._who=true;
      var o=new MutationObserver(function(muts){if(!hHt(muts))return;mD();bT(document.querySelector('title'))});
      o.observe(h,{childList:true,subtree:true,attributes:true,attributeFilter:['content','property','name','href','rel']})
    }catch(e){}
  }
  function start(){
    if(!_S&&!_V)hH();
    try{if('serviceWorker'in navigator)navigator.serviceWorker.addEventListener('controllerchange',function(){swRef=navigator.serviceWorker.controller})}catch(e){}
    wH();mN()
  }
  self.addEventListener('popstate',mN);
  self.addEventListener('hashchange',mN);
  self.addEventListener('load',mN);
  start();
  var bc=0,bi=setInterval(function(){mN();bc++;if(bc>16)clearInterval(bi)},72);
  setInterval(function(){if(document.visibilityState!=='visible')return;mD()},450);
  function hOk(c){if(!c)return false;try{var p=new URL(c,location.href);return p.protocol==='http:'||p.protocol==='https:'}catch(e){return false}}
  function oT(raw,cause){
    if(!raw)return false;
    var abs;
    try{abs=new URL(raw,location.href).href}catch(e){abs=raw}
    if(abs.indexOf(self.location.origin)===0&&abs.indexOf(_P)===-1&&abs.indexOf('/b/s/')===-1&&abs.indexOf('/b/u/')===-1){
      try{var bR=dU(location.href)||location.href;abs=new URL(raw,bR).href}catch(e){}
    }
    var dec=dU(abs)||abs;
    if(!hOk(dec))return false;
    var pl={type:'open-new-tab',url:abs,decodedUrl:dec,openerUrl:dU(location.href)||location.href,tabId:tabId,isTopFrame:isTop,cause:cause||null};
    var posted=false,didSend=false;
    var sp=function(c){if(c&&typeof c.postMessage==='function')try{c.postMessage(pl);posted=true}catch(e){}};
    try{var tp=window.top;if(tp&&tp!==window&&typeof tp.postMessage==='function'){tp.postMessage(pl,'*');posted=true}}catch(e){}
    if(!posted){
      try{
        if(navigator.serviceWorker){
          if(navigator.serviceWorker.controller){sp(navigator.serviceWorker.controller)}
          else if(navigator.serviceWorker.ready){navigator.serviceWorker.ready.then(function(reg){sp(reg.active||navigator.serviceWorker.controller)}).catch(function(){});didSend=true}
        }
      }catch(e){}
    }
    return posted||didSend
  }
  function hO(){
    try{
      var orig=window.open;
      window.open=function(url,target){
        var res=url&&url.href?url.href:url;
        var t=(target||'').toLowerCase();
        var si=!target||t===''||t==='_blank'||t==='blank'||t==='_new'||!(t==='_self'||t==='_top'||t==='_parent');
        if(si&&typeof res==='string'){var p=oT(res,'window.open');if(p)return null;return null}
        return orig.apply(this,arguments)
      };
      window.open._wi=true;
      try{var wp=Window.prototype;if(wp&&typeof Object.getOwnPropertyDescriptor==='function'){var d=Object.getOwnPropertyDescriptor(wp,'open');if(d&&d.configurable)Object.defineProperty(wp,'open',{value:window.open,writable:true,configurable:true})}}catch(e){}
    }catch(e){}
  }
  function pF(e,pred){
    try{
      var path=e.composedPath?e.composedPath():[];
      for(var i=0;i<path.length;i++){if(pred(path[i]))return path[i]}
      var cur=e.target;
      while(cur){if(pred(cur))return cur;cur=cur.parentElement}
    }catch(e){}
    return null
  }
  function hC(){
    var h=function(e){
      try{
        var a=pF(e,function(n){return n&&n.href&&(n.tagName==='A'||n.tagName==='AREA')});
        if(!a)return;
        var href=a.href||a.getAttribute('href');
        if(!href)return;
        var be=document.querySelector('base'),bt=be?(be.getAttribute('target')||'').toLowerCase():'',ibn=bt&&!(bt===''||bt==='_self'||bt==='_top'||bt==='_parent');
        var ta=a.getAttribute('target'),tgt=(ta||'').toLowerCase(),het=a.hasAttribute('target'),int=het&&!(tgt===''||tgt==='_self'||tgt==='_top'||tgt==='_parent');
        var mr=e.ctrlKey||e.metaKey||e.button===1,si=int||ibn||mr;
        if(!si)return;
        var cause=int?'anchor-target-blank':(ibn?'anchor-base-target':'anchor-modifier');
        var p=oT(href,cause);
        if(p){e.preventDefault();e.stopImmediatePropagation()}
      }catch(e){}
    };
    document.addEventListener('click',h,true);
    document.addEventListener('auxclick',h,true)
  }
  function gtF(f,s,be){
    var t='';if(s){var ft=(s.getAttribute('formtarget')||'').toLowerCase();if(ft)t=ft}
    if(!t){t=(f.getAttribute('target')||'').toLowerCase()}
    if(!t&&be){var bt=be.getAttribute('target');if(bt){bt=bt.toLowerCase();if(bt&&bt!=='_self'&&bt!=='_top'&&bt!=='_parent')t=bt}}
    return t
  }
  function gaF(f,s){
    if(s){var fa=s.getAttribute('formaction');if(fa)return fa}
    return f.getAttribute('action')||location.href
  }
  function hF(){
    var h=function(e){
      try{
        var f=pF(e,function(n){return n&&n.tagName==='FORM'});
        if(!f)return;
        var s=e.submitter||null;
        var be=document.querySelector('base');
        var t=gtF(f,s,be);
        if(!t||t==='_self'||t==='_top'||t==='_parent')return;
        var a=gaF(f,s),p=oT(a,'form-target-blank');
        if(p){e.preventDefault();e.stopImmediatePropagation()}
      }catch(e){}
    };
    document.addEventListener('submit',h,true)
  }
  function hFS(){
    try{
      var origSubmit=HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit=function(){
        try{
          var f=this;
          var be=document.querySelector('base');
          var t=gtF(f,null,be);
          if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'){
            var a=gaF(f,null);
            if(oT(a,'form-submit-blank'))return
          }
        }catch(e){}
        return origSubmit.call(this)
      }
    }catch(e){}
  }
  function hAC(){
    try{
      var pc=function(proto){
        var orig=proto.click;
        proto.click=function(){
          try{
            var href=this.href||this.getAttribute('href');
            if(!href)return orig.call(this);
            var t=(this.getAttribute('target')||'').toLowerCase();
            if(!t){
              var be=document.querySelector('base');
              if(be){var bt=(be.getAttribute('target')||'').toLowerCase();if(bt&&bt!=='_self'&&bt!=='_top'&&bt!=='_parent')t=bt}
            }
            if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'){if(oT(href,'anchor-click-blank'))return}
          }catch(e){}
          return orig.call(this)
        }
      };
      pc(HTMLAnchorElement.prototype);
      pc(HTMLAreaElement.prototype)
    }catch(e){}
  }
  function hRS(){
    try{
      var proto=HTMLFormElement.prototype;
      if(!proto.requestSubmit)return;
      var orig=proto.requestSubmit;
      proto.requestSubmit=function(submitter){
        try{
          var t=(this.getAttribute('target')||'').toLowerCase();
          var a=this.getAttribute('action');
          if(submitter){
            var ft=(submitter.getAttribute('formtarget')||'').toLowerCase();
            if(ft)t=ft;
            var fa=submitter.getAttribute('formaction');
            if(fa)a=fa
          }
          if(!a)a=location.href;
          if(!t){
            var be=document.querySelector('base');
            if(be){var bt=(be.getAttribute('target')||'').toLowerCase();if(bt&&bt!=='_self'&&bt!=='_top'&&bt!=='_parent')t=bt}
          }
          if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'){if(oT(a,'form-requestsubmit-blank'))return}
        }catch(e){}
        if(submitter!==undefined)return orig.call(this,submitter);
        return orig.call(this)
      }
    }catch(e){}
  }
  function hIF(){
    try{
      var pw=function(w){try{if(w&&!w.open._wi){w.open=window.open;w.open._wi=true}}catch(e){}};
      var pp=function(proto,prop){
        try{
          var d=Object.getOwnPropertyDescriptor(proto,prop);
          if(d&&d.configurable&&d.get){
            var o=d.get;
            Object.defineProperty(proto,prop,{
              get:function(){var w=o.call(this);try{pw(w)}catch(e){}return w},
              configurable:true,enumerable:true
            })
          }
        }catch(e){}
      };
      pp(HTMLIFrameElement.prototype,'contentWindow');
      pp(HTMLFrameElement.prototype,'contentWindow');
      pp(HTMLObjectElement.prototype,'contentWindow')
    }catch(e){}
  }
  hO();hC();hF();hFS();hAC();hRS();hIF()
})()
`;

const INJECT_FOOTER = `
</script>
`;

const INJECT_PATCHES_STANDARD =
  INJECT_SHARED_PREAMBLE +
  SPA_PATCH + ";" +
  TURN_SCRIPT.replace("${true}", "true") + ";" +
  SOUNDCLOUD_PATCH + ";" +
  HOVER_PREFETCH_SCRIPT + ";" +
  META_SCRIPT +
  INJECT_FOOTER;

const INJECT_PATCHES_RELAY =
  INJECT_SHARED_PREAMBLE +
  SPA_PATCH + ";" +
  TURN_SCRIPT.replace("${true}", "false") + ";" +
  SOUNDCLOUD_PATCH + ";" +
  HOVER_PREFETCH_SCRIPT + ";" +
  META_SCRIPT +
  INJECT_FOOTER;

function buildHtmlInjectPatches(upstreamUrlStr) {
  const host = upstreamHostname(upstreamUrlStr || "");
  if (!host) return INJECT_PATCHES_STANDARD;
  const cached = _injectPatchCache.get(host);
  if (cached) return cached;
  const result = isDiscordRelayOnlyHost(host)
    ? INJECT_PATCHES_RELAY
    : INJECT_PATCHES_STANDARD;
  if (_injectPatchCache.size > 64) {
    const oldest = _injectPatchCache.keys().next().value;
    _injectPatchCache.delete(oldest);
  }
  _injectPatchCache.set(host, result);
  return result;
}

const HEAD_START_RE = /<head\b[^>]*>/i;

async function patchHtml(response, upstreamUrlStr) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") || !response.body) return response;
  try {
    const lenHdr = response.headers.get("content-length");
    if (lenHdr && parseInt(lenHdr, 10) > MAX_HTML_INJECT_BYTES) return response;
    const clonedResponse = response.clone();
    const originalBody = await clonedResponse.text();
    if (originalBody.length > MAX_HTML_INJECT_BYTES) return response;
    const scripts = buildHtmlInjectPatches(upstreamUrlStr);
    let newBodyStr;
    const headMatch = HEAD_START_RE.exec(originalBody);
    if (headMatch) {
      const headEndIdx = headMatch.index + headMatch[0].length;
      newBodyStr =
        originalBody.substring(0, headEndIdx) +
        scripts +
        originalBody.substring(headEndIdx);
    } else {
      newBodyStr = scripts + originalBody;
    }
    return new Response(newBodyStr, {
      status: response.status,
      statusText: response.statusText,
      headers: fixHtmlHeaders(response.headers),
    });
  } catch (e) {
    return response;
  }
}