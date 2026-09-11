const $=id=>document.getElementById(id);
let running=false,watchId=null,lastPos=null,distance=0,movingSeconds=0,startStamp=0,lastTick=0,maxSpeed=0,prevSpeed=0,rpm=900,gear=1,audioCtx=null,osc=null,gain=null;
let engineType=4,redline=8000;

function fmtTime(s){s=Math.floor(s);return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")}
function hav(a,b){const R=6371000,lat1=a.coords.latitude*Math.PI/180,lat2=b.coords.latitude*Math.PI/180,dlat=(b.coords.latitude-a.coords.latitude)*Math.PI/180,dlon=(b.coords.longitude-a.coords.longitude)*Math.PI/180;const x=Math.sin(dlat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon/2)**2;return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
function updateUI(speed=0,accel=0){
  $("speed").textContent=speed.toFixed(1);$("distance").textContent=(distance/1000).toFixed(2)+" km";
  $("max").textContent=maxSpeed.toFixed(1)+" km/h";$("time").textContent=fmtTime(movingSeconds);
  const avg=movingSeconds?distance/1000/(movingSeconds/3600):0;$("avg").textContent=avg.toFixed(1)+" km/h";
  $("rpm").textContent=Math.round(rpm);$("gear").textContent=gear===0?"N":gear;
  $("rpmBar").style.width=Math.min(100,rpm/redline*100)+"%";$("accel").textContent=Math.round(accel)+"%";
  $("throttle").textContent=Math.round(Math.max(0,Math.min(100,accel+speed*2)))+"%";
}
function engineStep(speed,accel){
  const maxGear=6, ratios=[0,1.0,.72,.54,.43,.35,.29];
  if(speed<2) gear=1; else {let target=Math.max(1,Math.min(maxGear,Math.floor(speed/7)+1)); if(target>gear && rpm>5600)gear++; if(target<gear && rpm<1800)gear--}
  const base=900 + speed*145*ratios[gear];
  const accelKick=Math.max(-1,Math.min(1,accel/8))*900;
  rpm += (base+accelKick-rpm)*0.09;
  rpm=Math.max(850,Math.min(redline,rpm));
  if(audioCtx&&osc&&gain){osc.frequency.setTargetAtTime(35+(rpm/redline)*125,audioCtx.currentTime,.04);gain.gain.setTargetAtTime(.012+(Math.max(0,accel)/100)*.025,audioCtx.currentTime,.06)}
}
function startAudio(){
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  osc=audioCtx.createOscillator();gain=audioCtx.createGain();osc.type=engineType===8?"sawtooth":engineType===6?"triangle":"square";osc.frequency.value=70;gain.gain.value=.001;osc.connect(gain).connect(audioCtx.destination);osc.start();
}
function stopAudio(){if(gain)gain.gain.setTargetAtTime(0,audioCtx.currentTime,.08)}
function showMap(lat,lon){$("map").innerHTML=`<iframe loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${lon-.008}%2C${lat-.005}%2C${lon+.008}%2C${lat+.005}&layer=mapnik&marker=${lat}%2C${lon}"></iframe>`}
function position(pos){
  if(!running)return;
  const speed=Math.max(0,(pos.coords.speed||0)*3.6);
  if(lastPos){const d=hav(lastPos,pos); if(d<100){distance+=d; if(speed>.8)movingSeconds+=(pos.timestamp-lastPos.timestamp)/1000}}
  lastPos=pos;maxSpeed=Math.max(maxSpeed,speed);
  const dt=Math.max(.2,(pos.timestamp-(lastPos?.timestamp||pos.timestamp))/1000);const accel=(speed-prevSpeed)/dt*3.6;prevSpeed=speed;
  engineStep(speed,accel);updateUI(speed,accel);showMap(pos.coords.latitude,pos.coords.longitude);$("status").textContent="GPS actif • précision ±"+Math.round(pos.coords.accuracy)+" m";
}
function start(){
 if(running)return;
 if(!navigator.geolocation){$("status").textContent="GPS non disponible dans ce navigateur.";return}
 running=true;startStamp=Date.now();lastTick=Date.now();$("status").textContent="Activation du GPS…";
 if(!audioCtx)try{startAudio()}catch(e){}
 else audioCtx.resume();
 watchId=navigator.geolocation.watchPosition(position,e=>{$("status").textContent="Erreur GPS : "+e.message},{enableHighAccuracy:true,maximumAge:1000,timeout:10000});
}
function pause(){running=false;if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}stopAudio();$("status").textContent="En pause"}
function reset(){pause();lastPos=null;distance=0;movingSeconds=0;maxSpeed=0;prevSpeed=0;rpm=900;gear=1;updateUI();$("map").textContent="Appuie sur DÉMARRER pour activer le GPS.";$("status").textContent="GPS inactif"}
setInterval(()=>{if(running){const now=Date.now();movingSeconds+=(now-lastTick)/1000;lastTick=now;updateUI()}},1000);
$("start").onclick=start;$("pause").onclick=pause;$("reset").onclick=reset;
$("settingsBtn").onclick=()=>$("modal").classList.remove("hidden");$("closeSettings").onclick=()=>$("modal").classList.add("hidden");
$("engineType").onchange=e=>{engineType=+e.target.value;if(osc)osc.type=engineType===8?"sawtooth":engineType===6?"triangle":"square"};
$("redline").oninput=e=>{redline=+e.target.value;$("redlineVal").textContent=redline};
updateUI();
