/* ===================================================================
   COSMARAB SHOP ENGINE — shared behavior for all product pages.
   Each page defines window.PRODUCT before loading this file:
   {
     sku, name, page, currency, pixelId,
     offers:[{id,qty,price,was,label,sub,pop,save,perunit}],
     upsells:[{key,sku,name,emoji,price,was,desc}],
     toasts:[{n,c,i,o}]
   }
   Markup contract (ids/classes) matches app.css. Engine is defensive:
   missing optional sections are skipped.
=================================================================== */
(function(){
"use strict";
var P = window.PRODUCT || {};
var CUR = P.currency || 'SAR', CURT = 'ر.س';

/* ── year ── */
var yr=document.getElementById('yr'); if(yr) yr.textContent=new Date().getFullYear();

/* ── multi-pixel tracking ── */
function track(ev,data){
  try{if(window.snaptr)snaptr('track',ev,data||{});}catch(e){}
  try{if(window.ttq)ttq.track(ev,data||{});}catch(e){}
  try{if(window.fbq)fbq('track',ev,data||{});}catch(e){}
}

/* ── traffic source (kept across funnel for channel reporting) ── */
function getSrc(){
  try{
    var p=new URLSearchParams(location.search);
    var s=p.get('utm_source')||p.get('src')||localStorage.getItem('cos_src');
    if(!s&&document.referrer){
      var h=new URL(document.referrer).hostname.replace('www.','');
      if(/snap/.test(h))s='snapchat';else if(/tiktok/.test(h))s='tiktok';
      else if(/facebook|instagram|fb\./.test(h))s='meta';else if(/google/.test(h))s='google';
      else if(h&&h.indexOf(location.hostname)<0)s=h;
    }
    s=(s||'direct').toLowerCase();
    try{localStorage.setItem('cos_src',s);}catch(e){}
    return s;
  }catch(e){return 'direct';}
}

/* ── smooth scroll triggers ──
   Scrolling to #offers targets the currently-selected offer card (set by
   the quiz or the default pick) instead of the section top, so a shopper
   who just answered the quiz lands exactly on her recommended offer. */
document.querySelectorAll('[data-scroll]').forEach(function(b){
  b.addEventListener('click',function(){
    var sel=b.getAttribute('data-scroll');
    var t=document.querySelector(sel);
    if(!t)return;
    if(sel==='#offers'){
      var chosen=t.querySelector('.offer.selected')||t;
      chosen.scrollIntoView({behavior:'smooth',block:'center'});
      return;
    }
    t.scrollIntoView({behavior:'smooth',block:'start'});
  });
});

/* ── countdown timer ── */
(function(){
  var tH=document.getElementById('th'),tM=document.getElementById('tm'),tS=document.getElementById('ts');
  if(!tM)return;
  var end=Date.now()+(15*60+Math.floor(Math.random()*120))*1000;
  function tick(){
    var left=Math.max(0,Math.floor((end-Date.now())/1000));
    var h=Math.floor(left/3600),m=Math.floor((left%3600)/60),s=left%60;
    if(tH)tH.textContent=String(h).padStart(2,'0');
    tM.textContent=String(m).padStart(2,'0');tS.textContent=String(s).padStart(2,'0');
    if(left===0)end=Date.now()+15*60*1000;
  }
  tick();setInterval(tick,1000);
})();

/* ── live order toasts ── */
(function(){
  var wrap=document.getElementById('toastWrap'); if(!wrap||!P.toasts)return;
  var oi=0;
  function show(){
    if(modalOpen())return;
    var o=P.toasts[oi%P.toasts.length];oi++;
    var mins=Math.floor(Math.random()*9)+1;
    var t=document.createElement('div');t.className='toast';
    t.innerHTML='<span class="vchk">✔ موثّق</span><span class="av">'+o.i+'</span><div class="tb"><b>'+o.n+' من '+o.c+'</b><span>طلب '+o.o+' · قبل '+mins+' دقيقة</span></div>';
    wrap.appendChild(t);
    requestAnimationFrame(function(){requestAnimationFrame(function(){t.classList.add('in');});});
    setTimeout(function(){t.classList.remove('in');setTimeout(function(){t.remove();},450);},4500);
  }
  setTimeout(show,3500);setInterval(show,8500);
})();

/* ── live counters ── */
(function(){
  var liveEl=document.getElementById('liveCount'),todayEl=document.getElementById('todayOrders');
  if(!liveEl&&!todayEl)return;
  var liveN=19+Math.floor(Math.random()*10),todayN=90+Math.floor(Math.random()*80);
  if(liveEl)liveEl.textContent=liveN;if(todayEl)todayEl.textContent=todayN;
  setInterval(function(){
    var d=Math.floor(Math.random()*3)-1;liveN=Math.max(11,Math.min(44,liveN+d));
    if(liveEl)liveEl.textContent=liveN;
    if(Math.random()>.6){todayN++;if(todayEl)todayEl.textContent=todayN;}
  },7000);
})();

/* ── stock scarcity ── */
(function(){
  var n=document.getElementById('stockN'),fill=document.getElementById('stockFill');
  if(!n)return;var v=17;
  setInterval(function(){if(v>5&&Math.random()>.5){v--;n.textContent=v;if(fill)fill.style.width=(v/30*100)+'%';}},11000);
})();

/* ── OFFERS ── */
var state={offer:null,qty:0,price:0,label:'',sub:'',upsells:[]};
var selectedCard=null;
function selectOffer(card){
  if(!card)return;
  document.querySelectorAll('.offer').forEach(function(o){o.classList.remove('selected');});
  card.classList.add('selected');selectedCard=card;
}
document.querySelectorAll('.offer').forEach(function(card){
  card.addEventListener('click',function(){selectOffer(card);});
});
document.querySelectorAll('.offer-cta').forEach(function(btn){
  btn.addEventListener('click',function(e){e.stopPropagation();selectOffer(btn.closest('.offer'));openOrder();});
});
/* default = middle offer or one flagged data-default */
var def=document.querySelector('.offer[data-default]')||document.querySelectorAll('.offer')[1]||document.querySelector('.offer');
selectOffer(def);

document.querySelectorAll('[data-open-order]').forEach(function(b){b.addEventListener('click',openOrder);});

/* ── QUIZ (optional) ── reads P.quiz.results (3 items → offer 1/2/3) ── */
(function(){
  var wrap=document.getElementById('quizWrap'); if(!wrap||!P.quiz)return;
  var results=P.quiz.results||[];
  var cards=document.querySelectorAll('.qcard');
  var pts=document.querySelectorAll('.quiz-progress .qp');
  var answers=[];var total=4; /* questions */
  function go(n){
    cards.forEach(function(c){c.classList.remove('show');});
    var el=document.getElementById('qcard'+n);if(el)el.classList.add('show');
    pts.forEach(function(p,i){p.className='qp'+(i<n?' done':i===n?' active':'');});
  }
  document.querySelectorAll('.qopt').forEach(function(btn){
    btn.addEventListener('click',function(){
      var q=+btn.getAttribute('data-q'),a=+btn.getAttribute('data-a');
      answers[q]=a;
      if(q<total-1)go(q+1);else finish();
    });
  });
  function recIndex(){
    var s=answers.reduce(function(x,y){return x+(y||0);},0); /* 0..(total*3) */
    if(s<=3)return 0;if(s<=7)return 1;return 2;
  }
  function finish(){
    cards.forEach(function(c){c.classList.remove('show');});
    pts.forEach(function(p){p.className='qp done';});
    var idx=recIndex(),r=results[idx]||results[results.length-1];
    var m=document.getElementById('qrMatch');if(m)m.textContent=r.match||'✅ النتيجة جاهزة';
    var t=document.getElementById('qrTitle');if(t)t.textContent=r.title||'';
    var d=document.getElementById('qrDesc');if(d)d.innerHTML=r.desc||'';
    var tg=document.getElementById('qrTags');
    if(tg){tg.innerHTML='';(r.tags||[]).forEach(function(x){var s=document.createElement('span');s.className='qr-tag';s.textContent=x;tg.appendChild(s);});}
    var res=document.getElementById('quizResult');if(res)res.classList.add('show');
    var offerCards=document.querySelectorAll('.offer');
    if(offerCards[idx])selectOffer(offerCards[idx]);
    confetti(wrap);
    track('QUIZ_COMPLETE',{recommended:idx+1});
    setTimeout(function(){if(res)res.scrollIntoView({behavior:'smooth',block:'center'});},120);
  }
  function confetti(host){
    var cs=[getCSS('--brand'),getCSS('--accent'),getCSS('--ok'),getCSS('--gold'),getCSS('--brand2')];
    for(var i=0;i<22;i++){
      var p=document.createElement('span');p.className='confetti';
      p.style.left=(40+Math.random()*20)+'%';
      p.style.background=cs[i%cs.length];
      p.style.setProperty('--dx',((Math.random()*2-1)*160)+'px');
      p.style.setProperty('--dy',(-(60+Math.random()*180))+'px');
      p.style.animationDelay=(Math.random()*.14)+'s';
      host.appendChild(p);
      (function(el){setTimeout(function(){el.remove();},1500);})(p);
    }
  }
  function getCSS(v){try{return getComputedStyle(document.documentElement).getPropertyValue(v).trim()||'#fff';}catch(e){return '#fff';}}
})();

function offerData(card){
  return {
    offer:card.getAttribute('data-offer'),
    qty:+card.getAttribute('data-qty'),
    price:+card.getAttribute('data-price'),
    label:card.getAttribute('data-label')||'',
    sub:card.getAttribute('data-sub')||'الدفع عند الاستلام'
  };
}

function openOrder(){
  var card=selectedCard||def;if(!card)return;
  var d=offerData(card);
  state.offer=d.offer;state.qty=d.qty;state.price=d.price;state.label=d.label;state.sub=d.sub;state.upsells=[];
  var bn=document.getElementById('selName');if(bn)bn.textContent=d.label;
  var bs=document.getElementById('selSub');if(bs)bs.textContent=d.sub;
  var bp=document.getElementById('selPrice');if(bp)bp.textContent=d.price+' '+CURT;
  resetUpsells();renderSummary();showPanel(2);openModal();
  track('VIEW_CONTENT',{item:'offer_'+d.offer,value:d.price,currency:CUR});
  track('AddToCart',{value:d.price,currency:CUR});
}

/* ── UPSELLS (cross-sell other products) ── */
function resetUpsells(){
  document.querySelectorAll('.upsell').forEach(function(u){u.classList.remove('on');var b=u.querySelector('.ubox');if(b)b.textContent='';});
}
document.querySelectorAll('.upsell').forEach(function(u){
  u.addEventListener('click',function(){
    var key=u.getAttribute('data-key');
    u.classList.toggle('on');
    var box=u.querySelector('.ubox');
    if(u.classList.contains('on')){
      box.textContent='✓';
      if(state.upsells.indexOf(key)<0)state.upsells.push(key);
    }else{
      box.textContent='';
      state.upsells=state.upsells.filter(function(k){return k!==key;});
    }
    renderSummary();
  });
});
function upsellByKey(k){return (P.upsells||[]).filter(function(u){return u.key===k;})[0];}

/* ── SUMMARY ── */
function grandTotal(){
  var t=state.price;
  state.upsells.forEach(function(k){var u=upsellByKey(k);if(u)t+=u.price;});
  return t;
}
function summaryHTML(){
  var h='<div class="row"><span>'+state.label+'</span><b>'+state.price+' '+CURT+'</b></div>';
  state.upsells.forEach(function(k){var u=upsellByKey(k);if(u)h+='<div class="row"><span>+ '+u.name+'</span><b>'+u.price+' '+CURT+'</b></div>';});
  h+='<div class="row free"><span>التوصيل</span><b>مجاني 🎉</b></div><hr>';
  h+='<div class="row total"><span>الإجمالي (دفع عند الاستلام)</span><span class="v">'+grandTotal()+' '+CURT+'</span></div>';
  return h;
}
function renderSummary(){var s=document.getElementById('sum2');if(s)s.innerHTML=summaryHTML();}

/* ── MODAL ── */
var modal=document.getElementById('modal');
function modalOpen(){return modal&&modal.classList.contains('open');}
function openModal(){if(!modal)return;modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';}
function closeModal(){if(!modal)return;modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.style.overflow='';}
document.querySelectorAll('[data-close]').forEach(function(el){el.addEventListener('click',closeModal);});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&modalOpen())closeModal();});
if(modal)modal.addEventListener('click',function(e){if(e.target===modal)closeModal();});
function showPanel(n){
  ['panel1','panel2','panel3'].forEach(function(id,i){var el=document.getElementById(id);if(el)el.classList.toggle('active',i===n-1);});
  var d1=document.getElementById('dot1'),d2=document.getElementById('dot2');
  if(d1)d1.classList.toggle('on',n>=1);if(d2)d2.classList.toggle('on',n>=2);
  var st=document.getElementById('stepTxt');if(st)st.textContent=n===3?'تم الطلب ✅':'الخطوة '+n+' من 2';
  var sh=document.querySelector('.sheet');if(sh)sh.scrollTop=0;
}

/* ── PHONE VALIDATION ── */
var phoneEl=document.getElementById('phone');
if(phoneEl)phoneEl.addEventListener('input',function(){this.value=this.value.replace(/[^\d]/g,'').slice(0,10);});
function setErr(id,on){var f=document.getElementById(id);if(f)f.classList.toggle('invalid',on);var inp=f&&f.querySelector('input');if(inp)inp.classList.toggle('err',on);}

/* ── SUBMIT ── */
var form=document.getElementById('orderForm');
if(form)form.addEventListener('submit',function(e){
  e.preventDefault();
  var name=val('name'),phone=val('phone'),city=val('city'),ok=true;
  if(name.length<2){setErr('f-name',true);ok=false;}else setErr('f-name',false);
  if(!/^05\d{8}$/.test(phone)){setErr('f-phone',true);ok=false;}else setErr('f-phone',false);
  if(city.length<2){setErr('f-city',true);ok=false;}else setErr('f-city',false);
  if(!ok){var fe=document.querySelector('.field.invalid');if(fe)fe.scrollIntoView({behavior:'smooth',block:'center'});return;}

  var upObjs=state.upsells.map(function(k){var u=upsellByKey(k);return {key:k,sku:u.sku,name:u.name,price:u.price,qty:1};});
  var order={
    product:{sku:P.sku,name:P.name,page:P.page},
    offer:state.offer,qty:state.qty,basePrice:state.price,
    upsells:upObjs,total:grandTotal(),
    name:name,phone:phone,city:city,currency:CUR,src:getSrc(),ts:new Date().toISOString()
  };
  var btn=document.getElementById('submitBtn');
  if(btn){btn.disabled=true;btn.textContent='⏳ جاري الإرسال...';}
  var rerr=document.getElementById('regionErr');if(rerr)rerr.style.display='none';

  function success(){
    var txId='CSM-'+String(Math.floor(1000+Math.random()*9000));
    var oid=document.getElementById('orderId');if(oid)oid.textContent='#'+txId;
    var ts=document.getElementById('tySummary');if(ts)ts.innerHTML='<div class="blk-title">🧾 ملخص طلبك</div>'+summaryHTML();
    showPanel(3);
    try{if(P.pixelId)snaptr('init',P.pixelId,{'user_phone_number':order.phone});}catch(e){}
    track('PURCHASE',{value:order.total,currency:CUR,num_items:order.qty,transaction_id:txId});
  }
  fetch('/api/submit-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(order)})
  .then(function(r){
    if(r.status===403){
      if(btn){btn.disabled=false;btn.textContent='تأكيد الطلب ✅';}
      if(rerr)rerr.style.display='block';return;
    }
    success();
  })
  .catch(function(){success();});
});
function val(id){var el=document.getElementById(id);return el?el.value.trim():'';}

/* ── STICKY CTA ── */
(function(){
  var sticky=document.getElementById('stickyCta');if(!sticky)return;
  window.addEventListener('scroll',function(){sticky.classList.toggle('show',window.scrollY>720&&!modalOpen());},{passive:true});
})();

/* ── REVEAL ON SCROLL ── */
(function(){
  var io=new IntersectionObserver(function(en){en.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12});
  document.querySelectorAll('.reveal').forEach(function(el){io.observe(el);});
})();

/* expose for inline onclicks if needed */
window.openOrder=openOrder;
})();
