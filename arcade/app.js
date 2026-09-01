import { collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, serverTimestamp, setDoc, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db, isAdminUser } from "../shared/firebase.js";
import { requireClassSession } from "../shared/session.js";
import { mountGlobalShell } from "../shared/shell.js";
import { BADGES, DEFAULT_ARCADE_PROFILE, DEFAULT_SCORES, SHOP_ITEMS, badgeProgress, dayKey, seededIndex, shopItem } from "../shared/arcade-data.js";

const $ = id => document.getElementById(id);
const WORDS = ["APFEL","BLUME","BRIEF","DANKE","FARBE","GLANZ","KARTE","KLASSE","LAMPE","PAUSE","REISE","SCHUH","SONNE","STERN","TASSE","TRAUM","WOLKE"].filter(word => word.length === 5);
const QUIZZES = [
  { q: "Wie viele Kantone hat die Schweiz?", a: ["24","26","28"], right: 1 },
  { q: "Welcher Planet ist der Sonne am nächsten?", a: ["Venus","Merkur","Mars"], right: 1 },
  { q: "Was ist 12 × 8?", a: ["86","96","106"], right: 1 },
  { q: "Welche Sprache wird in Brasilien hauptsächlich gesprochen?", a: ["Spanisch","Portugiesisch","Französisch"], right: 1 },
  { q: "Welches Element hat das Symbol O?", a: ["Gold","Sauerstoff","Osmium"], right: 1 }
];
const MISSIONS = [
  { game: "snake", label: "Erreiche heute 8 Punkte in Snake.", field: "snakeBest", target: 8 },
  { game: "2048", label: "Erreiche heute 512 Punkte in 2048.", field: "game2048Best", target: 512 },
  { game: "memory", label: "Beende heute eine Memory Runde.", field: "memoryPlays", targetDelta: 1 },
  { game: "reaction", label: "Schaffe heute eine Reaktionsmessung.", field: "reactionPlays", targetDelta: 1 }
];

let user, profile, admin = false, wallet = {}, arcadeProfile = { ...DEFAULT_ARCADE_PROFILE }, scores = { ...DEFAULT_SCORES };
let daily = { completedKinds: [] }, allProfiles = [], activeShopType = "frame", toastTimer;
let mission, missionStart = 0;
let gameCleanup = null;

function esc(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function showModal(id, open = true) { if(id==="game-modal"&&!open){gameCleanup?.();gameCleanup=null} $(id).hidden = !open; document.body.style.overflow = open ? "hidden" : ""; }
function toast(message) { clearTimeout(toastTimer); $("arcade-toast").textContent = message; $("arcade-toast").hidden = false; toastTimer = setTimeout(() => $("arcade-toast").hidden = true, 3200); }
function initials(name) { return String(name || "?").trim().split(/\s+/).map(x => x[0]).slice(0,2).join("").toUpperCase(); }
function owned(id) { return admin || arcadeProfile.ownedItems?.includes(id); }
function completed(kind) { return daily.completedKinds?.includes(kind); }

async function ensureArcadeData() {
  const walletRef = doc(db,"coinWallets",user.uid), profileRef = doc(db,"arcadeProfiles",user.uid), scoreRef = doc(db,"gameScores",user.uid), dailyRef = doc(db,"dailyProgress",user.uid);
  const [w,p,s,d] = await Promise.all([getDoc(walletRef),getDoc(profileRef),getDoc(scoreRef),getDoc(dailyRef)]);
  if(w.exists()) wallet=w.data();
  if(p.exists()) arcadeProfile={...DEFAULT_ARCADE_PROFILE,...p.data()};
  if(s.exists()) scores={...DEFAULT_SCORES,...s.data()};
  if(d.exists() && d.data().dayKey===dayKey()) daily=d.data();
  const batch = [];
  if (!w.exists()) batch.push(setDoc(walletRef,{uid:user.uid,balance:0,earned:0,spent:0,awardCount:0,updatedAt:serverTimestamp()}));
  if (!p.exists()) batch.push(setDoc(profileRef,{uid:user.uid,nickname:profile.nickname,...DEFAULT_ARCADE_PROFILE,updatedAt:serverTimestamp()}));
  if (!s.exists()) batch.push(setDoc(scoreRef,{uid:user.uid,nickname:profile.nickname,...DEFAULT_SCORES,lastWordleDay:"",updatedAt:serverTimestamp()}));
  if (!d.exists() || d.data().dayKey !== dayKey()) batch.push(setDoc(dailyRef,{uid:user.uid,dayKey:dayKey(),completedKinds:[],lastKind:null,lastReward:0,updatedAt:serverTimestamp()}));
  await Promise.all(batch);
}

function startListeners() {
  onSnapshot(doc(db,"coinWallets",user.uid), snap => { wallet=snap.data()||{}; renderSummary(); renderShop(); });
  onSnapshot(doc(db,"arcadeProfiles",user.uid), snap => { arcadeProfile={...DEFAULT_ARCADE_PROFILE,...snap.data()}; renderShop(); });
  onSnapshot(doc(db,"gameScores",user.uid), snap => { scores={...DEFAULT_SCORES,...snap.data()}; renderSummary(); checkMission(); });
  onSnapshot(doc(db,"dailyProgress",user.uid), snap => { daily=snap.data()?.dayKey===dayKey()?snap.data():{completedKinds:[]}; renderDaily(); });
  onSnapshot(collection(db,"gameScores"), snap => { allProfiles=snap.docs.map(d=>d.data()); renderScoreboard(); });
}

function renderSummary() {
  $("coin-balance").textContent=wallet.balance||0; $("coin-earned").textContent=`${wallet.earned||0} Münzen gesammelt`;
  $("snake-best").textContent=`Bestwert ${scores.snakeBest||0}`; $("2048-best").textContent=`Bestwert ${scores.game2048Best||0}`;
  $("memory-best").textContent=scores.memoryBestMs?`Bestwert ${(scores.memoryBestMs/1000).toFixed(1)} s`:"Noch kein Wert";
  $("reaction-best").textContent=scores.reactionBestMs?`Bestwert ${scores.reactionBestMs} ms`:"Noch kein Wert";
}

function renderDaily() {
  const labels={wordle:"Erledigt ✓",quiz:"Erledigt ✓",mission:"Erledigt ✓"};
  for(const kind of Object.keys(labels)){const el=$(`${kind}-state`);if(completed(kind)){el.textContent=labels[kind];el.style.color="#61e4de";}}
}

async function claimDaily(kind, amount) {
  if (completed(kind)) return false;
  const dailyRef=doc(db,"dailyProgress",user.uid),walletRef=doc(db,"coinWallets",user.uid),scoreRef=doc(db,"gameScores",user.uid),txRef=doc(db,"coinTransactions",`${user.uid}_${dayKey()}_${kind}`);
  await runTransaction(db,async tx=>{
    const [d,w,s,t]=await Promise.all([tx.get(dailyRef),tx.get(walletRef),tx.get(scoreRef),tx.get(txRef)]);
    if(t.exists()) return;
    const data=d.data()?.dayKey===dayKey()?d.data():{uid:user.uid,dayKey:dayKey(),completedKinds:[],lastKind:null,lastReward:0};
    if(data.completedKinds.includes(kind)) return;
    tx.set(dailyRef,{uid:user.uid,dayKey:dayKey(),completedKinds:[...data.completedKinds,kind],lastKind:kind,lastReward:amount,updatedAt:serverTimestamp()});
    const wd=w.data()||{uid:user.uid,balance:0,earned:0,spent:0,awardCount:0};
    tx.set(walletRef,{...wd,balance:(wd.balance||0)+amount,earned:(wd.earned||0)+amount,updatedAt:serverTimestamp()});
    const sd=s.data()||{uid:user.uid,nickname:profile.nickname,...DEFAULT_SCORES};
    tx.set(scoreRef,{...sd,dailyWins:(sd.dailyWins||0)+1,updatedAt:serverTimestamp()});
    tx.set(txRef,{uid:user.uid,nickname:profile.nickname,amount,type:"daily",reason:kind==="wordle"?"Wordle des Tages":kind==="quiz"?"Tagesquiz":"Tagesmission",sourceType:kind,sourceId:dayKey(),createdAt:serverTimestamp(),createdByUid:user.uid});
  });
  toast(`Geschafft, du erhältst ${amount} Münzen!`); return true;
}

function renderShop() {
  if(!$("shop-grid"))return;
  const labels={frame:"Profilrahmen",theme:"App Designs",board:"Maturareise Zettel",skin:"Spiel Skins"};
  $("shop-tabs").innerHTML=Object.entries(labels).map(([id,label])=>`<button data-shop-type="${id}" class="${activeShopType===id?"active":""}">${label}</button>`).join("");
  $("shop-grid").innerHTML=SHOP_ITEMS.filter(x=>x.type===activeShopType).map(item=>{const has=owned(item.id),equipped=[arcadeProfile.equippedFrame,arcadeProfile.equippedTheme,arcadeProfile.boardDesign,arcadeProfile.snakeSkin,arcadeProfile.tileSkin,arcadeProfile.memorySkin].includes(item.id);return `<article class="shop-item"><span>${item.preview}</span><h3>${esc(item.name)}</h3><p>🪙 ${item.price}</p><button data-buy="${item.id}" ${equipped?"disabled":""}>${equipped?"Ausgewählt":has?"Auswählen":admin?"Auswählen":`Kaufen`}</button></article>`}).join("");
}

function equipField(item){if(item.type==="frame")return"equippedFrame";if(item.type==="theme")return"equippedTheme";if(item.type==="board")return"boardDesign";if(item.game==="snake")return"snakeSkin";if(item.game==="2048")return"tileSkin";return"memorySkin";}
async function buyOrEquip(id){const item=shopItem(id);if(!item)return;const field=equipField(item),has=owned(id);if(has){await updateDoc(doc(db,"arcadeProfiles",user.uid),{[field]:id,updatedAt:serverTimestamp()});toast(`${item.name} ist jetzt ausgewählt.`);return;}if((wallet.balance||0)<item.price){toast("Dafür hast du noch nicht genug Münzen.");return;}const walletRef=doc(db,"coinWallets",user.uid),profileRef=doc(db,"arcadeProfiles",user.uid),txRef=doc(collection(db,"coinTransactions"));await runTransaction(db,async tx=>{const[w,p]=await Promise.all([tx.get(walletRef),tx.get(profileRef)]);const wd=w.data(),pd=p.data();if(wd.balance<item.price)throw new Error("coins");if(pd.ownedItems.includes(id))return;tx.update(walletRef,{balance:wd.balance-item.price,spent:(wd.spent||0)+item.price,updatedAt:serverTimestamp()});tx.update(profileRef,{ownedItems:[...pd.ownedItems,id],[field]:id,lastPurchaseId:txRef.id,lastPurchaseItem:id,lastPurchasePrice:item.price,updatedAt:serverTimestamp()});tx.set(txRef,{uid:user.uid,nickname:profile.nickname,amount:-item.price,type:"purchase",reason:item.name,sourceType:"shop",sourceId:id,createdAt:serverTimestamp(),createdByUid:user.uid});});toast(`${item.name} gekauft und ausgewählt.`);}

async function openRewards(){showModal("rewards-modal");const snap=await getDocs(query(collection(db,"coinTransactions"),where("uid","==",user.uid)));const list=snap.docs.map(d=>d.data()).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));$("reward-list").innerHTML=list.length?list.map(x=>`<div class="reward-item"><div><strong>${esc(x.reason)}</strong><small>${x.type==="purchase"?"Shop":x.type==="award"?"Von Elias bewertet":"Tägliche Aufgabe"}</small></div><b>${x.amount>0?"+":""}${x.amount} 🪙</b></div>`).join(""):"<p>Noch keine Belohnungen.</p>";}

function scoreValue(item,field){const v=item[field]||0;if(field==="memoryBestMs"||field==="reactionBestMs")return v?`${field==="memoryBestMs"?(v/1000).toFixed(1):v} ${field==="memoryBestMs"?"s":"ms"}`:"Noch kein Wert";return v;}
function renderScoreboard(){const field=$("score-game")?.value||"snakeBest",ascending=field.endsWith("Ms");const sorted=allProfiles.filter(x=>Number(x[field])>0).sort((a,b)=>ascending?a[field]-b[field]:b[field]-a[field]).slice(0,20);$("scoreboard").innerHTML=sorted.length?sorted.map((x,i)=>`<div class="score-row"><strong>${i+1}</strong><button data-g23f-user="${esc(x.uid)}"><span class="score-avatar">${initials(x.nickname)}</span>${esc(x.nickname)}</button><span class="score-value">${scoreValue(x,field)}</span></div>`).join(""):"<div class=\"score-row\"><span></span><span>Noch kein Ergebnis</span><span></span></div>";}

function setGameContent(title,html){gameCleanup?.();gameCleanup=null;$("game-content").innerHTML=`<p class="eyebrow">G23f Arcade</p><h2 class="game-title">${title}</h2>${html}`;showModal("game-modal");}
async function saveScore(changes){await setDoc(doc(db,"gameScores",user.uid),{uid:user.uid,nickname:profile.nickname,...changes,updatedAt:serverTimestamp()},{merge:true});}

function openSnake(){setGameContent("Snake",`<p class="game-status" id="live-status">Drücke Start. Am Computer steuerst du mit den Pfeiltasten, auf dem Handy mit Wischen.</p><canvas class="snake-canvas" id="snake-canvas" width="400" height="400"></canvas><div class="game-controls"><button id="start-snake">Start</button></div>`);const canvas=$("snake-canvas"),ctx=canvas.getContext("2d"),n=20,size=20;let snake,food,dir,next,timer,score;function foodNew(){food={x:Math.floor(Math.random()*n),y:Math.floor(Math.random()*n)}}function draw(){ctx.fillStyle="#0d0b17";ctx.fillRect(0,0,400,400);ctx.fillStyle=arcadeProfile.snakeSkin==="skin-snake-neon"?"#61e4de":arcadeProfile.snakeSkin==="skin-snake-coral"?"#ff7f89":"#9b7cff";snake.forEach(p=>ctx.fillRect(p.x*size+2,p.y*size+2,size-4,size-4));ctx.fillStyle="#ffd66b";ctx.beginPath();ctx.arc(food.x*size+10,food.y*size+10,7,0,Math.PI*2);ctx.fill()}async function end(){clearInterval(timer);$("live-status").textContent=`Fertig, ${score} Punkte.`;await saveScore({snakeBest:Math.max(scores.snakeBest||0,score),snakePlays:(scores.snakePlays||0)+1})}function tick(){dir=next;const h={x:snake[0].x+dir.x,y:snake[0].y+dir.y};if(h.x<0||h.y<0||h.x>=n||h.y>=n||snake.some(p=>p.x===h.x&&p.y===h.y)){end();return}snake.unshift(h);if(h.x===food.x&&h.y===food.y){score++;foodNew();$("live-status").textContent=`${score} Punkte`;}else snake.pop();draw()}function start(){snake=[{x:10,y:10},{x:9,y:10}];dir=next={x:1,y:0};score=0;foodNew();clearInterval(timer);timer=setInterval(tick,150);draw()}function turn(x,y){if(dir.x!==-x||dir.y!==-y)next={x,y}}const keyHandler=e=>{if(e.key==="ArrowUp")turn(0,-1);if(e.key==="ArrowDown")turn(0,1);if(e.key==="ArrowLeft")turn(-1,0);if(e.key==="ArrowRight")turn(1,0)};document.addEventListener("keydown",keyHandler);gameCleanup=()=>{clearInterval(timer);document.removeEventListener("keydown",keyHandler)};let sx,sy;canvas.addEventListener("pointerdown",e=>{sx=e.clientX;sy=e.clientY});canvas.addEventListener("pointerup",e=>{const dx=e.clientX-sx,dy=e.clientY-sy;if(Math.abs(dx)>Math.abs(dy))turn(Math.sign(dx),0);else turn(0,Math.sign(dy))});$("start-snake").onclick=start;}

function open2048(){setGameContent("2048",`<p class="game-status" id="live-status">Mit Pfeiltasten oder Wischen spielen.</p><div class="tile-board" id="tile-board"></div><div class="game-controls"><button id="start-2048">Neu starten</button></div>`);let board,score=0,maxTile=0;const el=$("tile-board");function add(){const empty=[];board.forEach((v,i)=>{if(!v)empty.push(i)});if(empty.length)board[empty[Math.floor(Math.random()*empty.length)]]=Math.random()<.9?2:4}function draw(){el.innerHTML=board.map(v=>`<div class="tile">${v||""}</div>`).join("");$("live-status").textContent=`${score} Punkte`;}function line(arr){const a=arr.filter(Boolean);for(let i=0;i<a.length-1;i++)if(a[i]===a[i+1]){a[i]*=2;score+=a[i];maxTile=Math.max(maxTile,a[i]);a.splice(i+1,1)}while(a.length<4)a.push(0);return a}async function move(side){const before=board.join();for(let r=0;r<4;r++){let idx=side<2?[0,1,2,3].map(c=>r*4+c):[0,1,2,3].map(c=>c*4+r);let vals=idx.map(i=>board[i]);if(side===1||side===3)vals.reverse();vals=line(vals);if(side===1||side===3)vals.reverse();idx.forEach((i,j)=>board[i]=vals[j])}if(board.join()!==before){add();draw();await saveScore({game2048Best:Math.max(scores.game2048Best||0,score),game2048Tile:Math.max(scores.game2048Tile||0,maxTile),game2048Plays:(scores.game2048Plays||0)});}}function start(){board=Array(16).fill(0);score=0;maxTile=0;add();add();draw();}const keyHandler=e=>{const m={ArrowLeft:0,ArrowRight:1,ArrowUp:2,ArrowDown:3};if(m[e.key]!==undefined)move(m[e.key])};document.addEventListener("keydown",keyHandler);gameCleanup=()=>document.removeEventListener("keydown",keyHandler);let sx,sy;el.addEventListener("pointerdown",e=>{sx=e.clientX;sy=e.clientY});el.addEventListener("pointerup",e=>{const dx=e.clientX-sx,dy=e.clientY-sy;move(Math.abs(dx)>Math.abs(dy)?(dx<0?0:1):(dy<0?2:3))});$("start-2048").onclick=start;start();}

function openMemory(){const icons=arcadeProfile.memorySkin==="skin-memory-travel"?["✈️","🏝️","🗺️","🧳","🚆","🏔️","🏖️","📷"]:["🌙","⭐","⚡","💎","🎮","🛸","🪐","☀️"];setGameContent("Memory",`<p class="game-status" id="live-status">Finde alle acht Paare.</p><div class="memory-board" id="memory-board"></div>`);const cards=[...icons,...icons].sort(()=>Math.random()-.5);let first=null,locked=false,found=0,start=Date.now();const board=$("memory-board");board.innerHTML=cards.map((x,i)=>`<button class="memory-card" data-i="${i}">${x}</button>`).join("");board.onclick=async e=>{const b=e.target.closest("button");if(!b||locked||b.classList.contains("done"))return;b.classList.add("open");if(!first){first=b;return}if(first.dataset.i===b.dataset.i)return;if(cards[first.dataset.i]===cards[b.dataset.i]){first.classList.add("done");b.classList.add("done");first=null;found+=2;if(found===cards.length){const ms=Date.now()-start;$("live-status").textContent=`Geschafft in ${(ms/1000).toFixed(1)} Sekunden.`;await saveScore({memoryBestMs:!scores.memoryBestMs?ms:Math.min(scores.memoryBestMs,ms),memoryPlays:(scores.memoryPlays||0)+1})}}else{locked=true;setTimeout(()=>{first.classList.remove("open");b.classList.remove("open");first=null;locked=false},700)}};}

function openReaction(){setGameContent("Reaktion",`<p class="game-status" id="live-status">Drücke Start und warte auf Grün.</p><button class="reaction-pad" id="reaction-pad">Start</button>`);const pad=$("reaction-pad");let timer,start,state="idle";gameCleanup=()=>clearTimeout(timer);pad.onclick=async()=>{if(state==="idle"){state="wait";pad.textContent="Warten …";timer=setTimeout(()=>{state="ready";start=performance.now();pad.classList.add("ready");pad.textContent="JETZT!"},1200+Math.random()*3000)}else if(state==="wait"){clearTimeout(timer);state="idle";pad.textContent="Zu früh, nochmals"}else{const ms=Math.round(performance.now()-start);state="idle";pad.classList.remove("ready");pad.textContent="Nochmals";$("live-status").textContent=`${ms} Millisekunden`;await saveScore({reactionBestMs:!scores.reactionBestMs?ms:Math.min(scores.reactionBestMs,ms),reactionPlays:(scores.reactionPlays||0)+1})}};}

function openWordle(){const target=WORDS[seededIndex(dayKey(),WORDS.length)];setGameContent("Wort des Tages",`<p class="game-status" id="live-status">Ein deutsches Wort mit fünf Buchstaben.</p><div class="wordle-grid" id="wordle-grid"></div><form class="wordle-form" id="wordle-form"><input maxlength="5" minlength="5" required autocomplete="off"><button>Prüfen</button></form>`);let tries=[];function draw(){$("wordle-grid").innerHTML=Array.from({length:6},(_,r)=>`<div class="wordle-row">${Array.from({length:5},(_,i)=>{const c=tries[r]?.[i]||"",cl=c===target[i]?"hit":target.includes(c)?"near":"";return`<span class="wordle-cell ${cl}">${c}</span>`}).join("")}</div>`).join("")}draw();$("wordle-form").onsubmit=async e=>{e.preventDefault();const input=e.target.querySelector("input"),word=input.value.trim().toUpperCase();if(word.length!==5)return;tries.push(word);input.value="";draw();if(word===target){$("live-status").textContent="Richtig!";e.target.hidden=true;await saveScore({wordleWins:(scores.wordleWins||0)+1,wordleStreak:(scores.wordleStreak||0)+1,wordleBestStreak:Math.max(scores.wordleBestStreak||0,(scores.wordleStreak||0)+1),lastWordleDay:dayKey()});await claimDaily("wordle",3)}else if(tries.length===6){$("live-status").textContent=`Gesucht war ${target}. Morgen gibt es ein neues Wort.`;e.target.hidden=true;await saveScore({wordleStreak:0,lastWordleDay:dayKey()})}};}

function openQuiz(){const q=QUIZZES[seededIndex(dayKey()+"quiz",QUIZZES.length)];setGameContent("Tagesquiz",`<p>${esc(q.q)}</p><div class="quiz-options" id="quiz-options">${q.a.map((a,i)=>`<button data-answer="${i}">${esc(a)}</button>`).join("")}</div><p class="game-status" id="live-status"></p>`);$("quiz-options").onclick=async e=>{const b=e.target.closest("button");if(!b||completed("quiz"))return;const right=Number(b.dataset.answer)===q.right;b.classList.add(right?"correct":"wrong");$("live-status").textContent=right?"Richtig!":"Leider falsch. Morgen kommt eine neue Frage.";$("quiz-options").querySelectorAll("button").forEach(x=>x.disabled=true);if(right)await claimDaily("quiz",2)};}

function checkMission(){if(!mission)return;const done=mission.targetDelta?(scores[mission.field]||0)>=missionStart+mission.targetDelta:(scores[mission.field]||0)>=mission.target;if(done&&!completed("mission"))claimDaily("mission",4).catch(()=>{});}
function openGame(name){if(name==="snake")openSnake();if(name==="2048"){open2048();$("tile-board")?.classList.add(arcadeProfile.tileSkin||"default")}if(name==="memory"){openMemory();$("memory-board")?.classList.add(arcadeProfile.memorySkin||"default")}if(name==="reaction")openReaction();if(name==="wordle")openWordle();if(name==="quiz")openQuiz();if(name==="mission")openGame(mission.game);}

async function init(){const session=await requireClassSession("../");if(!session)return;({user,profile}=session);admin=isAdminUser(user);await ensureArcadeData();mission=MISSIONS[seededIndex(dayKey()+"mission",MISSIONS.length)];missionStart=scores[mission.field]||0;$("mission-copy").textContent=mission.label;$("daily-date").textContent=new Date().toLocaleDateString("de-CH",{weekday:"long",day:"numeric",month:"long"});$("arcade-main").hidden=false;$("account-tools").hidden=false;const shell=mountGlobalShell({user,profile,rootPath:"../",pageLabel:"Arcade"});$("arcade-profile-button").onclick=shell.openProfile;startListeners();renderShop();document.addEventListener("click",e=>{const game=e.target.closest("[data-game]")?.dataset.game;if(game)openGame(game);const open=e.target.closest("[data-open]")?.dataset.open;if(open==="shop")showModal("shop-modal");if(open==="rewards")openRewards();const close=e.target.closest("[data-close]")?.dataset.close;if(close)showModal(close,false);const type=e.target.closest("[data-shop-type]")?.dataset.shopType;if(type){activeShopType=type;renderShop()}const buy=e.target.closest("[data-buy]")?.dataset.buy;if(buy)buyOrEquip(buy)});$("score-game").onchange=renderScoreboard;}
init().catch(error=>{console.error(error);document.body.insertAdjacentHTML("beforeend",`<p style="padding:2rem;color:white">Arcade konnte nicht geladen werden. Bitte aktualisiere die Seite.</p>`)});
