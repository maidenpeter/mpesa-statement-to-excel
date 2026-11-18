/* The site navigation: theme switch, Back and the side bar. Written by tools/kenya_nav.py in maidenpeter.github.io from tools/nav.py; edit it there, not here. */
(function(){var d=document.documentElement,side=document.querySelector('.mp-side');if(!side)return;
var each=function(sel,f){[].forEach.call(document.querySelectorAll(sel),f)},hide=function(p){try{p.hidePopover()}catch(x){}};
// a short desktop window starts with the groups that do not hold this page folded, so the side bar fits
// the series strip opens scrolled to the current page, and fades at each end that has more
var sl=document.querySelector('.mp-sub-list');if(sl){var sc=sl.querySelector('a[aria-current]');var edge=function(){sl.classList.toggle('mp-more',sl.scrollLeft+sl.clientWidth<sl.scrollWidth-2);sl.classList.toggle('mp-less',sl.scrollLeft>2)};var mid=function(){if(sc)sl.scrollLeft+=sc.getBoundingClientRect().left-sl.getBoundingClientRect().left-(sl.clientWidth-sc.offsetWidth)/2;edge()};mid();addEventListener('load',mid);if(document.fonts)document.fonts.ready.then(mid);sl.addEventListener('scroll',edge,{passive:true});addEventListener('resize',edge)}
if(matchMedia('(min-width:861px) and (max-height:780px)').matches)each('.mp-side .mp-grp[open]',function(g){if(!g.querySelector('[aria-current]'))g.open=false});
var b=document.querySelector('.mp-theme');if(b){var l=b.querySelector('.mp-l');
var cur=function(){return d.getAttribute('data-theme')||'dark'};
var lab=function(){var c=cur();l.textContent=c==='dark'?'Paper theme':'Ink theme';b.setAttribute('aria-label','Switch to '+(c==='dark'?'paper':'ink')+' theme')};
b.hidden=false;b.addEventListener('click',function(){var x=cur()==='dark'?'light':'dark';d.setAttribute('data-theme',x);try{localStorage.setItem('mp-theme',x)}catch(e){}lab()});lab()}
var touched=false;['wheel','touchstart','keydown','mousedown'].forEach(function(t){addEventListener(t,function(){touched=true},{once:true,passive:true})});
var ready=function(){var h=location.hash,t=null;try{t=h&&document.getElementById(decodeURIComponent(h.slice(1)))}catch(e){}if(t&&!touched)t.scrollIntoView();d.classList.add('mp-ready')};
if(document.readyState==='complete')d.classList.add('mp-ready');else addEventListener('load',ready);
var bk=side.querySelector('.mp-back');if(bk){var same=false;try{same=new URL(document.referrer).origin===location.origin}catch(e){}
var st=function(){var s=history.state;return s&&typeof s==='object'?s:null},put=function(n){var s=st()||{};s.mpd=n;try{history.replaceState(s,'')}catch(e){}};
var s0=st(),depth=s0&&typeof s0.mpd==='number'?s0.mpd:(same?1:0);put(depth);
var show=function(){if(bk.hasAttribute('data-home'))bk.hidden=depth<1},sync=function(){var s=st();if(s&&typeof s.mpd==='number')depth=s.mpd;show()};
bk.addEventListener('click',function(e){if(depth>0&&history.length>1){e.preventDefault();history.back()}});
addEventListener('popstate',sync);addEventListener('pageshow',sync);
addEventListener('hashchange',function(){var s=st();if(s&&typeof s.mpd==='number')depth=s.mpd;else{depth+=1;put(depth)}show()});show()}
var guard=false;
document.addEventListener('pointerdown',function(e){var o=document.querySelector('[popover]:popover-open');guard=!!o&&!o.contains(e.target)&&!(e.target.closest&&e.target.closest('[popovertarget]'))},true);
document.addEventListener('pointercancel',function(){guard=false},true);
document.addEventListener('click',function(e){if(guard&&e.detail){guard=false;e.preventDefault();e.stopPropagation();return}guard=false;
var a=e.target.closest&&e.target.closest('[popover] a[href]'),p=a&&a.closest('[popover]');if(p&&p.matches(':popover-open'))hide(p)},true);
each('.pop',function(p){p.addEventListener('focusout',function(e){if(e.relatedTarget&&!p.contains(e.relatedTarget)&&p.matches(':popover-open'))hide(p)})});
var mq=matchMedia('(min-width:861px)'),shut=function(){if(mq.matches)each('.mp-items',function(p){if(p.matches(':popover-open'))hide(p)})};
if(mq.addEventListener)mq.addEventListener('change',shut);else if(mq.addListener)mq.addListener(shut);
if(!HTMLElement.prototype.hasOwnProperty('popover')){each('.mp-ch-btn',function(x){x.addEventListener('click',function(){var a=x.nextElementSibling&&x.nextElementSibling.querySelector('.mp-ch-link');if(a)location.href=a.href})});
each('button[popovertarget]:not(.mp-ch-btn)',function(x){x.addEventListener('click',function(){var t=document.getElementById(x.getAttribute('popovertarget'));if(t)t.toggleAttribute('data-open')})})}
var nav=side.querySelector('.mp-nav'),home=location.pathname==='/'||location.pathname==='/index.html',
secs=home?[].slice.call(document.querySelectorAll('main section[id]')):[],
links=[].slice.call(nav.querySelectorAll('[data-spy]'));if(!secs.length)return;
var wh=document.querySelector('.mp-where[data-where]'),wmap={},shown=null;try{wmap=JSON.parse(wh.getAttribute('data-where'))}catch(e){}
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
var draw=function(key){var cr=wmap.hasOwnProperty(key)?wmap[key]:wmap[''];if(!wh||!cr||shown===key)return;shown=key;
wh.innerHTML=cr.map(function(c,i){var t=c.length===3?c:[null,c[0],c[1]],inner=(t[0]?'<b class="mp-wn">'+t[0]+'</b> ':'')+esc(t[1]);
return(i===cr.length-1||!t[2])?'<span class="mp-wc" aria-current="location">'+inner+'</span>':'<a class="mp-wc" href="'+esc(t[2])+'">'+inner+'</a>'}).join('<span class="mp-ws" aria-hidden="true">/</span>')};
function spy(){var y=window.innerHeight*0.3,c='',any=false;
for(var i=0;i<secs.length;i++)if(secs[i].getBoundingClientRect().top<=y)c=secs[i].id;
if(window.innerHeight+window.scrollY>=d.scrollHeight-2)c=secs[secs.length-1].id;
links.forEach(function(a){var on=!!c&&a.getAttribute('data-spy').split(' ').indexOf(c)>-1;a.classList.toggle('mp-here',on);if(on)any=true});
nav.classList.toggle('mp-spying',any);draw(c)}
var q=0;window.addEventListener('scroll',function(){if(!q)q=requestAnimationFrame(function(){q=0;spy()})},{passive:true});
window.addEventListener('resize',spy);spy()})();
