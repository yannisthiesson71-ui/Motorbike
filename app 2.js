/* VeloMoteur V4 — V8 réaliste
   Remplace l'ancien app.js par ce fichier.
   Le son reste synthétique (Web Audio), mais il utilise une architecture V8 :
   fréquence d'allumage 4 temps, rumble bas régime, harmoniques, échappement,
   inertie, charge moteur, montée/descente de régime et rupteur.
*/
let running=false, paused=false, watchId=null, lastPos=null;
let distance=0, movingSeconds=0, maxSpeed=0, prevSpeed=0, prevTimestamp=0;
let sessionStart=0, lastTick=0;
let currentRPM=900, targetRPM=900, currentGear=0, throttle=0, accelPct=0;
let engineType=8, redline=8000;

const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

/* ---------- V8 AUDIO ---------- */
let AC=null, master=null, engineGain=null, rumble=null, firing=null, mid=null, high=null;
let exhaustNoise=null, noiseGain=null, intake=null, limiter=null, audioReady=false;

function makeDistortion(amount=18){
  const sh=AC.createWaveShaper();
  const n=44100, curve=new Float32Array(n);
  for(let i=0;i<n;i++){
    const x=i*2/n-1;
    curve[i]=(1+amount)*x/(1+amount*Math.abs(x));
  }
  sh.curve=curve; sh.oversample="4x";
  return sh;
}

function makeNoiseBuffer(){
  const len=AC.sampleRate*2;
  const b=AC.createBuffer(1,len,AC.sampleRate);
  const d=b.getChannelData(0);
  let last=0;
  for(let i=0;i<len;i++){
    const white=Math.random()*2-1;
    last=last*0.985+white*0.015;
    d[i]=last*0.65+white*0.35;
  }
  return b;
}

function initAudio(){
  if(audioReady) { AC.resume(); return; }
  AC=new (window.AudioContext||window.webkitAudioContext)();

  master=AC.createGain(); master.gain.value=0.78;
  limiter=AC.createDynamicsCompressor();
  limiter.threshold.value=-8; limiter.knee.value=10;
  limiter.ratio.value=5; limiter.attack.value=0.003; limiter.release.value=0.12;
  master.connect(limiter).connect(AC.destination);

  engineGain=AC.createGain(); engineGain.gain.value=0.0001;
  const lowpass=AC.createBiquadFilter(); lowpass.type="lowpass"; lowpass.frequency.value=5200; lowpass.Q.value=0.65;
  engineGain.connect(lowpass).connect(master);

  // Cross-plane V8 rumble: subharmonic + firing-frequency body + upper harmonics.
  rumble=AC.createOscillator(); rumble.type="sine"; rumble.frequency.value=26.7;
  const rg=AC.createGain(); rg.gain.value=0.32; rumble.connect(rg).connect(engineGain); rumble.start();

  firing=AC.createOscillator(); firing.type="triangle"; firing.frequency.value=53.3;
  const fg=AC.createGain(); fg.gain.value=0.24; firing.connect(fg).connect(engineGain); firing.start();

  mid=AC.createOscillator(); mid.type="sawtooth"; mid.frequency.value=106.7;
  const mg=AC.createGain(); mg.gain.value=0.095; mid.connect(mg).connect(engineGain); mid.start();

  high=AC.createOscillator(); high.type="square"; high.frequency.value=213.3;
  const hg=AC.createGain(); hg.gain.value=0.025; high.connect(hg).connect(engineGain); high.start();

  // Intake resonance.
  intake=AC.createOscillator(); intake.type="sine"; intake.frequency.value=160;
  const ig=AC.createGain(); ig.gain.value=0.018; intake.connect(ig).connect(engineGain); intake.start();

  // Exhaust / mechanical noise.
  exhaustNoise=AC.createBufferSource();
  exhaustNoise.buffer=makeNoiseBuffer(); exhaustNoise.loop=true;
  const bp=AC.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=900; bp.Q.value=0.7;
  noiseGain=AC.createGain(); noiseGain.gain.value=0.012;
  exhaustNoise.connect(bp).connect(noiseGain).connect(engineGain);
  exhaustNoise.start();

  audioReady=true;
  AC.resume();
}

function setEngineAudio(rpm, load){
  if(!audioReady) return;
  const t=AC.currentTime;
  // 4 firing events per crank revolution for a 4-stroke V8.
  const fireHz=Math.max(12, rpm/15);
  const ramp=0.025;
  rumble.frequency.setTargetAtTime(fireHz/2,t,ramp);
  firing.frequency.setTargetAtTime(fireHz,t,ramp);
  mid.frequency.setTargetAtTime(fireHz*2,t,ramp);
  high.frequency.setTargetAtTime(fireHz*4,t,ramp);
  intake.frequency.setTargetAtTime(110+rpm*0.18,t,ramp);

  const loadN=clamp(load,0,1);
  engineGain.gain.setTargetAtTime(
    running && !paused ? 0.055 + loadN*0.13 : 0.0001, t, 0.045
  );

  // More throttle = richer/louder exhaust and intake.
  noiseGain.gain.setTargetAtTime(0.006 + loadN*0.035,t,0.06);
}

function blip(amount=1){
  if(!audioReady) return;
  const now=AC.currentTime;
  const o=AC.createOscillator(), g=AC.createGain();
  o.type="sawtooth";
  o.frequency.setValueAtTime(90,now);
  o.frequency.exponentialRampToValueAtTime(90+amount*500,now+0.12);
  g.gain.setValueAtTime(0.0001,now);
  g.gain.linearRampToValueAtTime(0.10,now+0.015);
  g.gain.exponentialRampToValueAtTime(0.0001,now+0.20);
  o.connect(g).connect(engineGain); o.start(now); o.stop(now+0.22);
}

/* ---------- GPS / DRIVE MODEL ---------- */
function hav(a,b){
  const R=6371000, p1=a.coords.latitude*Math.PI/180, p2=b.coords.latitude*Math.PI/180;
  const dp=p2-p1, dl=(b.coords.longitude-a.coords.longitude)*Math.PI/180;
  const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function position(pos){
  if(!running || paused) return;
  const speed=Math.max(0,(pos.coords.speed||0)*3.6);
  const now=pos.timestamp||Date.now();
  const dt=prevTimestamp ? clamp((now-prevTimestamp)/1000,0.05,2) : 0.1;

  if(lastPos){
    const d=hav(lastPos,pos);
    if(d<100){ distance+=d; if(speed>0.8) movingSeconds+=dt; }
  }
  lastPos=pos;
  prevTimestamp=now;
  maxSpeed=Math.max(maxSpeed,speed);

  const rawAccel=(speed-prevSpeed)/dt;
  const smoothAccel=clamp(rawAccel,-5,5);
  prevSpeed=speed;

  // Bicycle "throttle" estimate: positive acceleration + speed demand.
  throttle=clamp(0.18 + Math.max(0,smoothAccel)*0.16 + speed/95,0,1);
  accelPct=clamp((smoothAccel+3)/6,0,1);

  updateDrive(speed,smoothAccel,dt);
  updateUI(speed);
  updateMap(pos.coords.latitude,pos.coords.longitude);
}

function updateDrive(speed,acc,dt){
  // 6-speed automatic, biased to keep a V8 in a useful band.
  const ratios=[0,3.10,2.10,1.50,1.15,0.90,0.72];
  const ranges=[0,12,24,40,58,78,999];
  let g=currentGear;
  if(speed<2) g=1;
  else if(speed<ranges[Math.min(g+1,6)]-2) g=Math.max(1,g);
  if(speed>ranges[g]+3 && g<6) g++;
  if(speed<ranges[g-1]-3 && g>1) g--;
  if(g!==currentGear){ currentGear=g; blip(0.35); }

  const ratio=ratios[currentGear]||3.1;
  const wheelRpm=speed*1000/60/(Math.PI*0.34);
  let wanted=wheelRpm*ratio*2.8;
  wanted += throttle*700;
  wanted=clamp(wanted,850,redline-250);

  // V8 idle / overrun behavior.
  if(speed<2) wanted=900+throttle*1000;
  if(acc< -0.8 && throttle<0.25) wanted=Math.max(1050,wanted-250);

  const inertia=acc>=0 ? 0.13 : 0.075;
  currentRPM += (wanted-currentRPM)*(1-Math.exp(-inertia*dt*10));
  currentRPM=clamp(currentRPM,800,redline);

  const load=clamp(throttle*0.9 + Math.max(0,acc)*0.08,0,1);
  setEngineAudio(currentRPM,load);

  if(currentRPM>=redline-30) blip(0.15);
}

function updateUI(speed){
  $("speed").textContent=speed.toFixed(1);
  $("distance").textContent=(distance/1000).toFixed(2)+" km";
  const avg=movingSeconds>0?(distance/1000)/(movingSeconds/3600):0;
  $("avg").textContent=avg.toFixed(1)+" km/h";
  $("max").textContent=maxSpeed.toFixed(1)+" km/h";
  $("rpm").textContent=Math.round(currentRPM);
  $("rpmBar").style.width=(currentRPM/redline*100).toFixed(1)+"%";
  $("gear").textContent=currentGear?currentGear:"N";
  $("throttle").textContent=Math.round(throttle*100)+"%";
  $("accel").textContent=Math.round(accelPct*100)+"%";
  $("time").textContent=formatTime(Math.floor(movingSeconds));
}

function formatTime(s){
  const h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return (h?String(h).padStart(2,"0")+":":"")+String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0");
}

function updateMap(lat,lon){
  const map=$("map");
  if(!map || !isFinite(lat) || !isFinite(lon)) return;
  map.innerHTML=`<iframe title="Carte" style="width:100%;height:100%;border:0;border-radius:18px"
    src="https://www.openstreetmap.org/export/embed.html?bbox=${lon-0.006}%2C${lat-0.004}%2C${lon+0.006}%2C${lat+0.004}&layer=mapnik&marker=${lat}%2C${lon}"></iframe>`;
}

function startGPS(){
  if(!navigator.geolocation){ $("status").textContent="GPS non disponible"; return; }
  watchId=navigator.geolocation.watchPosition(position,err=>{
    $("status").textContent="GPS : "+(err.message||"erreur");
  },{enableHighAccuracy:true,maximumAge:500,timeout:10000});
}

/* ---------- CONTROLS ---------- */
$("start").addEventListener("click",()=>{
  initAudio();
  running=true; paused=false;
  $("status").textContent="GPS actif • V8 en route";
  $("start").textContent="▶ EN ROUTE";
  startGPS();
  if(!sessionStart) sessionStart=Date.now();
  lastTick=Date.now();
  requestAnimationFrame(tick);
});

$("pause").addEventListener("click",()=>{
  if(!running) return;
  paused=!paused;
  $("pause").textContent=paused?"▶ REPRENDRE":"Ⅱ PAUSE";
  $("status").textContent=paused?"En pause":"GPS actif • V8 en route";
  if(audioReady) setEngineAudio(currentRPM,0);
});

$("reset").addEventListener("click",()=>{
  running=false; paused=false;
  if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;}
  distance=0;movingSeconds=0;maxSpeed=0;prevSpeed=0;prevTimestamp=0;lastPos=null;
  currentRPM=900;currentGear=0;throttle=0;accelPct=0;sessionStart=0;
  $("status").textContent="GPS inactif";
  $("start").textContent="▶ DÉMARRER";
  $("pause").textContent="Ⅱ PAUSE";
  updateUI(0);
  if(audioReady) setEngineAudio(900,0);
});

function tick(){
  if(!running) return;
  const now=Date.now();
  if(!paused && now-lastTick>=1000){
    const n=Math.floor((now-lastTick)/1000);
    // Moving time is incremented from GPS in position(), not while stationary.
    lastTick+=n*1000;
    updateUI(prevSpeed);
  }
  requestAnimationFrame(tick);
}

/* ---------- SETTINGS ---------- */
$("settingsBtn").addEventListener("click",()=>{
  $("modal").classList.remove("hidden");
  $("engineType").value="8";
});
$("closeSettings").addEventListener("click",()=>{$("modal").classList.add("hidden");});
$("modal").addEventListener("click",e=>{if(e.target===$("modal"))$("modal").classList.add("hidden");});
$("engineType").addEventListener("change",e=>{
  engineType=Number(e.target.value);
  if(engineType!==8) engineType=8; // V4 is deliberately V8-focused.
  $("engineType").value="8";
});
$("redline").addEventListener("input",e=>{
  redline=Number(e.target.value);
  $("redlineVal").textContent=redline;
  if(currentRPM>redline) currentRPM=redline;
});

updateUI(0);
